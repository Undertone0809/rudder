import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants, promises as fs, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentRuntimeSkillEntry,
  AgentRuntimeSkillSnapshot,
} from "./types.js";
import { RunProcessResult, RunningProcess, SpawnTarget, ChildProcessWithEvents, runningProcesses, isChildProcessAlive, MAX_CAPTURE_BYTES, MAX_EXCERPT_BYTES, SENSITIVE_ENV_KEY, RUDDER_SKILL_ROOT_RELATIVE_CANDIDATES, DEFAULT_LOCAL_CLI_CREDENTIAL_HOME_ENTRIES, LocalCliCredentialShimCommand, DEFAULT_LOCAL_CLI_OPERATOR_HOME_SHIM_COMMANDS, RudderSkillEntry, InstalledSkillTarget, PersistentSkillSnapshotOptions, normalizePathSlashes, isMaintainerOnlySkillTarget, skillLocationLabel, buildManagedSkillOrigin, compactSkillText, parseSkillFrontmatterMetadata, readSkillMetadataFromDirectory, readSkillMetadataFromPath, resolveInstalledEntryTarget, parseObject, asString, asNumber, asBoolean, asStringArray, parseJson, appendWithCap, resolvePathValue, renderTemplate, ISSUE_DOCUMENT_PROMPT_BODY_CHAR_LIMIT, IssueDocumentPromptInput, truncateIssueDocumentBody, formatDocumentHeading, readIssueDocumentPromptIssueId, buildIssueDocumentsPrompt } from "./server-utils.process.js";
import { DEFAULT_AGENT_PROMPT_TEMPLATE, ISSUE_ASSIGN_PROMPT_TEMPLATE, COMMENT_MENTION_PROMPT_TEMPLATE, ISSUE_COMMENTED_PROMPT_TEMPLATE, ISSUE_CHANGES_REQUESTED_PROMPT_TEMPLATE, ISSUE_RECOVERY_PROMPT_TEMPLATE, RECOVERY_PROMPT_TEMPLATE, ISSUE_PASSIVE_FOLLOWUP_PROMPT_TEMPLATE, selectPromptTemplate, joinPromptSections, RUDDER_AGENT_OPERATING_CONTRACT } from "./server-utils.prompts.js";

export interface LoadedAgentInstructionsPrefix {
  prefix: string;
  commandNotes: string[];
  instructionsFilePath: string;
  instructionsDir: string;
  soulFilePath: string | null;
  toolsFilePath: string | null;
  memoryFilePath: string | null;
  heartbeatFilePath: string | null;
  readFailed: boolean;
  metrics: {
    instructionsChars: number;
    operatingContractChars: number;
    instructionEntryChars: number;
    soulChars: number;
    toolsChars: number;
    memoryChars: number;
    heartbeatChars: number;
  };
}

export function toPromptPath(pathValue: string): string {
  return pathValue.split(path.sep).join("/");
}

export function isInsidePath(parentPath: string, childPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function displayInstructionPath(filePath: string, instructionsFilePath: string): string {
  const resolvedFilePath = path.resolve(filePath);
  const resolvedInstructionsPath = path.resolve(instructionsFilePath);
  const instructionsDir = path.dirname(resolvedInstructionsPath);
  if (path.basename(instructionsDir) === "instructions") {
    const agentHome = path.dirname(instructionsDir);
    if (isInsidePath(agentHome, resolvedFilePath)) {
      const relativePath = path.relative(agentHome, resolvedFilePath);
      return relativePath ? `$AGENT_HOME/${toPromptPath(relativePath)}` : "$AGENT_HOME";
    }
  }
  return filePath;
}

export function displayInstructionDir(filePath: string, instructionsFilePath: string): string {
  const displayPath = displayInstructionPath(filePath, instructionsFilePath);
  const lastSlash = displayPath.lastIndexOf("/");
  return lastSlash >= 0 ? `${displayPath.slice(0, lastSlash)}/` : "";
}

export async function loadAgentInstructionsPrefix(input: {
  instructionsFilePath: string;
  includeHeartbeatInstructions?: boolean;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  warningStream?: "stdout" | "stderr";
}): Promise<LoadedAgentInstructionsPrefix> {
  const instructionsFilePath = input.instructionsFilePath.trim();
  const includeHeartbeatInstructions = input.includeHeartbeatInstructions === true;
  const entryIsHeartbeatInstructions = path.basename(instructionsFilePath).toLowerCase() === "heartbeat.md";
  const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  const displayInstructionsFilePath = instructionsFilePath
    ? displayInstructionPath(instructionsFilePath, instructionsFilePath)
    : "";
  const displayInstructionsDir = instructionsFilePath
    ? displayInstructionDir(instructionsFilePath, instructionsFilePath)
    : "";
  const warningStream = input.warningStream ?? "stdout";
  const operatingContractSection =
    `${RUDDER_AGENT_OPERATING_CONTRACT}\n\n` +
    "The above Rudder agent operating contract was injected by Rudder at runtime.";
  const empty = {
    prefix: operatingContractSection,
    commandNotes: ["Loaded Rudder agent operating contract from runtime code"],
    instructionsFilePath,
    instructionsDir,
    soulFilePath: null,
    toolsFilePath: null,
    memoryFilePath: null,
    heartbeatFilePath: null,
    readFailed: false,
    metrics: {
      instructionsChars: operatingContractSection.length,
      operatingContractChars: operatingContractSection.length,
      instructionEntryChars: 0,
      soulChars: 0,
      toolsChars: 0,
      memoryChars: 0,
      heartbeatChars: 0,
    },
  } satisfies LoadedAgentInstructionsPrefix;

  if (!instructionsFilePath) return empty;

  const loadedPaths = new Set<string>();
  const commandNotes = [...empty.commandNotes];
  let entrySection = "";
  let entryReadFailed = false;
  if (entryIsHeartbeatInstructions && !includeHeartbeatInstructions) {
    await input.onLog(
      "stdout",
      `[rudder] Skipped agent heartbeat instructions file outside heartbeat scene: ${displayInstructionsFilePath}\n`,
    );
    commandNotes.push(`Skipped configured heartbeat instructions outside heartbeat scene: ${displayInstructionsFilePath}`);
  } else {
    try {
      const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
      loadedPaths.add(path.resolve(instructionsFilePath));
      entrySection =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${displayInstructionsFilePath}. ` +
        `Resolve any relative file references from ${displayInstructionsDir}.`;
      await input.onLog(
        "stdout",
        `[rudder] Loaded agent instructions file: ${displayInstructionsFilePath}\n`,
      );
    } catch (err) {
      entryReadFailed = true;
      const reason = err instanceof Error ? err.message : String(err);
      await input.onLog(
        warningStream,
        `[rudder] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
      commandNotes.push(
        `Configured instructionsFilePath ${displayInstructionsFilePath}, but file could not be read; continuing without injected instructions.`,
      );
    }
  }
  if (entryIsHeartbeatInstructions && entrySection) {
    commandNotes.push(`Loaded agent heartbeat instructions from ${displayInstructionsFilePath}`);
  } else if (entrySection) {
    commandNotes.splice(1, 0, `Loaded agent instructions from ${displayInstructionsFilePath}`);
  }

  async function loadSiblingInstructionFile(siblingInput: {
    fileName: string;
    label: string;
    logLabel: string;
  }): Promise<{ path: string | null; section: string }> {
    const filePath = path.join(path.dirname(instructionsFilePath), siblingInput.fileName);
    const resolvedPath = path.resolve(filePath);
    const displayFilePath = displayInstructionPath(filePath, instructionsFilePath);
    const displayFileDir = displayInstructionDir(filePath, instructionsFilePath);
    if (loadedPaths.has(resolvedPath)) return { path: filePath, section: "" };
    try {
      const contents = await fs.readFile(filePath, "utf8");
      loadedPaths.add(resolvedPath);
      await input.onLog(
        "stdout",
        `[rudder] Loaded ${siblingInput.logLabel}: ${displayFilePath}\n`,
      );
      return {
        path: filePath,
        section:
          `${contents}\n\n` +
          `The above ${siblingInput.label} were loaded from ${displayFilePath}. ` +
          `Resolve any relative file references from ${displayFileDir}.`,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        const reason = err instanceof Error ? err.message : String(err);
        await input.onLog(
          warningStream,
          `[rudder] Warning: could not read ${siblingInput.logLabel} "${filePath}": ${reason}\n`,
        );
      }
      return { path: null, section: "" };
    }
  }

  const soul = await loadSiblingInstructionFile({
    fileName: "SOUL.md",
    label: "agent role and persona instructions",
    logLabel: "agent soul instructions file",
  });
  if (soul.section && soul.path) {
    commandNotes.push(`Loaded agent soul instructions from ${displayInstructionPath(soul.path, instructionsFilePath)}`);
  }

  const tools = await loadSiblingInstructionFile({
    fileName: "TOOLS.md",
    label: "agent tool notes",
    logLabel: "agent tool notes file",
  });
  if (tools.section && tools.path) {
    commandNotes.push(`Loaded agent tool notes from ${displayInstructionPath(tools.path, instructionsFilePath)}`);
  }

  const memory = await loadSiblingInstructionFile({
    fileName: "MEMORY.md",
    label: "agent memory instructions",
    logLabel: "agent memory instructions file",
  });
  if (memory.section && memory.path) {
    commandNotes.push(`Loaded agent memory instructions from ${displayInstructionPath(memory.path, instructionsFilePath)}`);
  }

  const heartbeat = includeHeartbeatInstructions
    ? await loadSiblingInstructionFile({
        fileName: "HEARTBEAT.md",
        label: "agent heartbeat instructions",
        logLabel: "agent heartbeat instructions file",
      })
    : { path: null, section: "" };
  if (heartbeat.section && heartbeat.path) {
    commandNotes.push(`Loaded agent heartbeat instructions from ${displayInstructionPath(heartbeat.path, instructionsFilePath)}`);
  }

  const memoryFilePath = memory.section ? memory.path : null;
  const memorySection = memory.section;
  const entryHeartbeatSection = entryIsHeartbeatInstructions && includeHeartbeatInstructions ? entrySection : "";
  const heartbeatFilePath = entryHeartbeatSection ? instructionsFilePath : heartbeat.section ? heartbeat.path : null;
  const heartbeatChars = entryHeartbeatSection.length + heartbeat.section.length;

  const prefix = joinPromptSections([operatingContractSection, entrySection, soul.section, tools.section, memorySection, heartbeat.section]);
  return {
    prefix,
    commandNotes,
    instructionsFilePath,
    instructionsDir,
    soulFilePath: soul.section ? soul.path : null,
    toolsFilePath: tools.section ? tools.path : null,
    memoryFilePath,
    heartbeatFilePath,
    readFailed: entryReadFailed,
    metrics: {
      instructionsChars: prefix.length,
      operatingContractChars: operatingContractSection.length,
      instructionEntryChars: entrySection.length,
      soulChars: soul.section.length,
      toolsChars: tools.section.length,
      memoryChars: memorySection.length,
      heartbeatChars,
    },
  };
}

export function redactEnvForLogs(env: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    redacted[key] = SENSITIVE_ENV_KEY.test(key) ? "***REDACTED***" : value;
  }
  return redacted;
}

export function buildRudderEnv(agent: { id: string; orgId: string }): Record<string, string> {
  const resolveHostForUrl = (rawHost: string): string => {
    const host = rawHost.trim();
    if (!host || host === "0.0.0.0" || host === "::") return "localhost";
    if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) return `[${host}]`;
    return host;
  };
  const vars: Record<string, string> = {
    RUDDER_AGENT_ID: agent.id,
    RUDDER_ORG_ID: agent.orgId,
  };
  const runtimeHost = resolveHostForUrl(
    process.env.RUDDER_LISTEN_HOST ?? process.env.HOST ?? "localhost",
  );
  const runtimePort = process.env.RUDDER_LISTEN_PORT ?? process.env.PORT ?? "3100";
  const apiUrl = process.env.RUDDER_API_URL ?? `http://${runtimeHost}:${runtimePort}`;
  vars.RUDDER_API_URL = apiUrl;
  return vars;
}

export function defaultPathForPlatform() {
  if (process.platform === "win32") {
    return "C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem";
  }
  return "/usr/local/bin:/opt/homebrew/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin";
}

export function windowsPathExts(env: NodeJS.ProcessEnv): string[] {
  return (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
}

export async function pathExists(candidate: string) {
  try {
    await fs.access(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function fileExists(candidate: string) {
  try {
    await fs.access(candidate, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCommandPath(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const hasPathSeparator = command.includes("/") || command.includes("\\");
  if (hasPathSeparator) {
    const absolute = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    return (await pathExists(absolute)) ? absolute : null;
  }

  const pathValue = env.PATH ?? env.Path ?? "";
  const delimiter = process.platform === "win32" ? ";" : ":";
  const dirs = pathValue.split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? windowsPathExts(env) : [""];
  const hasExtension = process.platform === "win32" && path.extname(command).length > 0;

  for (const dir of dirs) {
    const candidates =
      process.platform === "win32"
        ? hasExtension
          ? [path.join(dir, command)]
          : exts.map((ext) => path.join(dir, `${command}${ext}`))
        : [path.join(dir, command)];
    for (const candidate of candidates) {
      if (await pathExists(candidate)) return candidate;
    }
  }

  return null;
}

export function quoteForCmd(arg: string) {
  if (!arg.length) return '""';
  const escaped = arg.replace(/"/g, '""');
  return /[\s"&<>|^()]/.test(escaped) ? `"${escaped}"` : escaped;
}

export async function resolveSpawnTarget(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<SpawnTarget> {
  const resolved = await resolveCommandPath(command, cwd, env);
  const executable = resolved ?? command;

  if (process.platform !== "win32") {
    return { command: executable, args };
  }

  if (/\.(cmd|bat)$/i.test(executable)) {
    const shell = env.ComSpec || process.env.ComSpec || "cmd.exe";
    const commandLine = [quoteForCmd(executable), ...args.map(quoteForCmd)].join(" ");
    return {
      command: shell,
      args: ["/d", "/s", "/c", commandLine],
    };
  }

  return { command: executable, args };
}
