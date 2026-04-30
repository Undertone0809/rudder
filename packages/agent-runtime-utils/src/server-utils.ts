import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants, promises as fs, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentRuntimeSkillEntry,
  AgentRuntimeSkillSnapshot,
} from "./types.js";

export interface RunProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  pid: number | null;
  startedAt: string | null;
}

interface RunningProcess {
  child: ChildProcess;
  graceSec: number;
}

interface SpawnTarget {
  command: string;
  args: string[];
}

type ChildProcessWithEvents = ChildProcess & {
  on(event: "error", listener: (err: Error) => void): ChildProcess;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): ChildProcess;
};

export const runningProcesses = new Map<string, RunningProcess>();

function isChildProcessAlive(child: ChildProcessWithEvents): boolean {
  const pid = child.pid;
  if (typeof pid !== "number" || pid <= 0) return false;
  if (child.exitCode !== null || child.signalCode !== null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : null;
    return code === "EPERM";
  }
}
export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
export const MAX_EXCERPT_BYTES = 32 * 1024;
const SENSITIVE_ENV_KEY = /(key|token|secret|password|passwd|authorization|cookie)/i;
const RUDDER_SKILL_ROOT_RELATIVE_CANDIDATES = [
  "../../server/resources/bundled-skills",
  "../../skills",
  "../../../../../server/resources/bundled-skills",
];

export interface RudderSkillEntry {
  key: string;
  runtimeName: string;
  source: string;
  name: string | null;
  description: string | null;
}

export interface InstalledSkillTarget {
  targetPath: string | null;
  kind: "symlink" | "directory" | "file";
}

interface PersistentSkillSnapshotOptions {
  agentRuntimeType: string;
  availableEntries: RudderSkillEntry[];
  desiredSkills: string[];
  installed: Map<string, InstalledSkillTarget>;
  skillsHome: string;
  locationLabel?: string | null;
  installedDetail?: string | null;
  missingDetail: string;
  externalConflictDetail: string;
  externalDetail: string;
  warnings?: string[];
}

function normalizePathSlashes(value: string): string {
  return value.replaceAll("\\", "/");
}

function isMaintainerOnlySkillTarget(candidate: string): boolean {
  const normalized = normalizePathSlashes(candidate);
  return (
    normalized.includes("/server/resources/bundled-skills/")
    || normalized.includes("/.agents/skills/")
  );
}

function skillLocationLabel(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildManagedSkillOrigin(): Pick<
  AgentRuntimeSkillEntry,
  "origin" | "originLabel" | "readOnly"
> {
  return {
    origin: "organization_managed",
    readOnly: false,
  };
}

function compactSkillText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const compacted = value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return compacted.length > 0 ? compacted : null;
}

function parseSkillFrontmatterMetadata(markdown: string): {
  name: string | null;
  description: string | null;
} {
  const match = markdown.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) {
    return { name: null, description: null };
  }

  const yaml = match[1];
  const nameMatch = yaml.match(/^name:\s*["']?(.*?)["']?\s*$/m);
  const descriptionMatch = yaml.match(
    /^description:\s*(?:>\s*\n((?:\s{2,}[^\n]*\n?)+)|[|]\s*\n((?:\s{2,}[^\n]*\n?)+)|["']?(.*?)["']?\s*$)/m,
  );

  return {
    name: compactSkillText(nameMatch?.[1] ?? null),
    description: compactSkillText(descriptionMatch?.[1] ?? descriptionMatch?.[2] ?? descriptionMatch?.[3] ?? null),
  };
}

async function readSkillMetadataFromDirectory(skillDir: string): Promise<{
  name: string | null;
  description: string | null;
}> {
  const skillFile = path.join(skillDir, "SKILL.md");
  try {
    const markdown = await fs.readFile(skillFile, "utf8");
    return parseSkillFrontmatterMetadata(markdown);
  } catch {
    return { name: null, description: null };
  }
}

export async function readSkillMetadataFromPath(candidatePath: string | null | undefined): Promise<{
  name: string | null;
  description: string | null;
}> {
  if (typeof candidatePath !== "string" || candidatePath.trim().length === 0) {
    return { name: null, description: null };
  }
  const resolvedPath = path.resolve(candidatePath);
  const skillDir = path.basename(resolvedPath).toLowerCase() === "skill.md"
    ? path.dirname(resolvedPath)
    : resolvedPath;
  return readSkillMetadataFromDirectory(skillDir);
}

function resolveInstalledEntryTarget(
  skillsHome: string,
  entryName: string,
  dirent: Dirent,
  linkedPath: string | null,
): InstalledSkillTarget {
  const fullPath = path.join(skillsHome, entryName);
  if (dirent.isSymbolicLink()) {
    return {
      targetPath: linkedPath ? path.resolve(path.dirname(fullPath), linkedPath) : null,
      kind: "symlink",
    };
  }
  if (dirent.isDirectory()) {
    return { targetPath: fullPath, kind: "directory" };
  }
  return { targetPath: fullPath, kind: "file" };
}

export function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function parseJson(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function appendWithCap(prev: string, chunk: string, cap = MAX_CAPTURE_BYTES) {
  const combined = prev + chunk;
  return combined.length > cap ? combined.slice(combined.length - cap) : combined;
}

export function resolvePathValue(obj: Record<string, unknown>, dottedPath: string) {
  const parts = dottedPath.split(".");
  let cursor: unknown = obj;

  for (const part of parts) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      return "";
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }

  if (cursor === null || cursor === undefined) return "";
  if (typeof cursor === "string") return cursor;
  if (typeof cursor === "number" || typeof cursor === "boolean") return String(cursor);

  try {
    return JSON.stringify(cursor);
  } catch {
    return "";
  }
}

export function renderTemplate(template: string, data: Record<string, unknown>) {
  return template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_, path) => resolvePathValue(data, path));
}

// Default prompt templates for different wake sources
export const DEFAULT_AGENT_PROMPT_TEMPLATE =
  `You are agent {{agent.id}} ({{agent.name}}). Continue your Rudder work.

{{context.rudderWorkspace.orgResourcesPrompt}}`;

export const ISSUE_ASSIGN_PROMPT_TEMPLATE = `You are agent {{agent.id}} ({{agent.name}}). You have been assigned to work on an issue.

{{context.rudderWorkspace.orgResourcesPrompt}}

## Task Context

**Issue:** {{issue.title}}
**ID:** {{issue.id}}
**Status:** {{issue.status}}
**Priority:** {{issue.priority}}

**Description:**
{{issue.description}}

Your task is to review this issue and begin working on it. Use the available tools to explore the codebase, understand the requirements, and implement a solution.`;

export const COMMENT_MENTION_PROMPT_TEMPLATE = `You are agent {{agent.id}} ({{agent.name}}). You were mentioned in a comment and your attention is needed.

{{context.rudderWorkspace.orgResourcesPrompt}}

## Context

**Issue:** {{issue.title}}
**ID:** {{issue.id}}

**Issue Description:**
{{issue.description}}

**Comment:**
{{comment.body}}

Please review the comment above and respond or take action as appropriate.`;

export const ISSUE_COMMENTED_PROMPT_TEMPLATE = `You are agent {{agent.id}} ({{agent.name}}). There is a new comment on an issue you own.

{{context.rudderWorkspace.orgResourcesPrompt}}

## Context

**Issue:** {{issue.title}}
**ID:** {{issue.id}}
**Status:** {{issue.status}}

**Issue Description:**
{{issue.description}}

**Latest Comment:**
{{comment.body}}

Review the new comment and continue the issue from the current state. Respond or take action as needed.`;

export const ISSUE_RECOVERY_PROMPT_TEMPLATE = `You are agent {{agent.id}} ({{agent.name}}). This is a recovery run, not a fresh task.

{{context.rudderWorkspace.orgResourcesPrompt}}

## Recovery Context

**Original Run ID:** {{context.recovery.originalRunId}}
**Failure Kind:** {{context.recovery.failureKind}}
**Failure Summary:** {{context.recovery.failureSummary}}
**Recovery Trigger:** {{context.recovery.recoveryTrigger}}
**Recovery Mode:** {{context.recovery.recoveryMode}}

## Current Issue Context

**Issue:** {{issue.title}}
**ID:** {{issue.id}}
**Status:** {{issue.status}}
**Priority:** {{issue.priority}}

**Description:**
{{issue.description}}

Before doing anything else, inspect what the previous run already completed and any side effects it may have caused. Continue the remaining work from the current state. Avoid blindly re-running the whole task.`;

export const RECOVERY_PROMPT_TEMPLATE = `You are agent {{agent.id}} ({{agent.name}}). This is a recovery run, not a fresh task.

{{context.rudderWorkspace.orgResourcesPrompt}}

## Recovery Context

**Original Run ID:** {{context.recovery.originalRunId}}
**Failure Kind:** {{context.recovery.failureKind}}
**Failure Summary:** {{context.recovery.failureSummary}}
**Recovery Trigger:** {{context.recovery.recoveryTrigger}}
**Recovery Mode:** {{context.recovery.recoveryMode}}

Before doing anything else, inspect what the previous run already completed and any side effects it may have caused. Continue the remaining work from the current state. Avoid blindly re-running the whole task.`;

export const ISSUE_PASSIVE_FOLLOWUP_PROMPT_TEMPLATE = `You are agent {{agent.id}} ({{agent.name}}). This is a passive issue follow-up, not a fresh assignment and not a failure recovery.

{{context.rudderWorkspace.orgResourcesPrompt}}

## Why You Were Woken

The previous run ended without sufficient issue close-out.

**Origin Run ID:** {{context.passiveFollowup.originRunId}}
**Previous Run ID:** {{context.passiveFollowup.previousRunId}}
**Attempt:** {{context.passiveFollowup.attempt}} / {{context.passiveFollowup.maxAttempts}}
**Reason:** {{context.passiveFollowup.reason}}

## Current Issue Context

**Issue:** {{issue.title}}
**ID:** {{issue.id}}
**Status:** {{issue.status}}
**Priority:** {{issue.priority}}

**Description:**
{{issue.description}}

Before changing the issue, inspect the current issue state and any side effects from the previous run. Then do exactly one close-out action: add a progress comment, mark the issue done, block it with a reason, or hand it off explicitly with explanation.`;

/**
 * Selects the base heartbeat prompt template used by runtimes before final prompt assembly.
 *
 * Prompt shape by wake trigger:
 * - assignment:
 *   "You are agent ... You have been assigned ..."
 *   Includes issue title/id/status/priority/description so the agent can start immediately.
 * - comment.mention:
 *   "You were mentioned in a comment ..."
 *   Includes issue summary plus mention comment body so the agent can respond without extra fetches.
 * - issue_commented:
 *   "There is a new comment on an issue you own ..."
 *   Includes issue summary plus the newest comment body so the assignee can continue immediately.
 * - recovery:
 *   "This is a recovery run, not a fresh task ..."
 *   Includes original run id, failure metadata, and a continue-preferred instruction to
 *   inspect prior progress/side effects before resuming.
 * - passive issue follow-up:
 *   "This is a passive issue follow-up, not a fresh assignment ..."
 *   Includes close-out lineage and tells the agent to comment, finish, block, or hand off.
 * - fallback:
 *   Generic "Continue your Rudder work."
 *
 * Concrete rendered example (comment mention):
 * "You are agent agent-456 (Backend Worker). You were mentioned in a comment and your attention is needed.
 *  Issue: Stabilize queue worker
 *  Comment: @agent please check timeout handling in retry path."
 *
 * Reasoning:
 * - Keep backward compatibility: custom configured templates always win.
 * - Keep first-turn latency low: include the minimum task context directly in prompt text.
 * - Keep behavior deterministic across runtimes: template selection is centralized here.
 *
 * See also:
 * - doc/plans/2026-04-07-agent-prompt-context-injection.md
 * - doc/DEVELOPING.md
 */
export function selectPromptTemplate(
  configuredTemplate: string | undefined,
  context: Record<string, unknown>,
): string {
  // If user configured a custom template, use it
  if (configuredTemplate?.trim()) {
    return configuredTemplate;
  }

  // Select based on wake source/reason
  const wakeSource = String(context.wakeSource ?? "");
  const wakeReason = String(context.wakeReason ?? "");
  const recovery = context.recovery;
  const hasRecoveryContext =
    typeof recovery === "object" &&
    recovery !== null &&
    !Array.isArray(recovery) &&
    typeof (recovery as Record<string, unknown>).originalRunId === "string";

  if (hasRecoveryContext || wakeReason === "process_lost_retry" || wakeReason === "retry_failed_run") {
    return typeof context.issue === "object" && context.issue !== null && !Array.isArray(context.issue)
      ? ISSUE_RECOVERY_PROMPT_TEMPLATE
      : RECOVERY_PROMPT_TEMPLATE;
  }
  if (wakeReason === "issue_passive_followup") {
    return ISSUE_PASSIVE_FOLLOWUP_PROMPT_TEMPLATE;
  }
  if (wakeSource === "assignment" || wakeReason === "issue_assigned") {
    return ISSUE_ASSIGN_PROMPT_TEMPLATE;
  }
  if (wakeSource === "comment.mention" || wakeReason === "issue_comment_mentioned") {
    return COMMENT_MENTION_PROMPT_TEMPLATE;
  }
  if (wakeReason === "issue_commented") {
    return ISSUE_COMMENTED_PROMPT_TEMPLATE;
  }

  return DEFAULT_AGENT_PROMPT_TEMPLATE;
}

export function joinPromptSections(
  sections: Array<string | null | undefined>,
  separator = "\n\n",
) {
  return sections
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .join(separator);
}

export interface LoadedAgentInstructionsPrefix {
  prefix: string;
  commandNotes: string[];
  instructionsFilePath: string;
  instructionsDir: string;
  memoryFilePath: string | null;
  readFailed: boolean;
  metrics: {
    instructionsChars: number;
    instructionEntryChars: number;
    memoryChars: number;
  };
}

export async function loadAgentInstructionsPrefix(input: {
  instructionsFilePath: string;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  warningStream?: "stdout" | "stderr";
}): Promise<LoadedAgentInstructionsPrefix> {
  const instructionsFilePath = input.instructionsFilePath.trim();
  const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  const warningStream = input.warningStream ?? "stdout";
  const empty = {
    prefix: "",
    commandNotes: [],
    instructionsFilePath,
    instructionsDir,
    memoryFilePath: null,
    readFailed: false,
    metrics: {
      instructionsChars: 0,
      instructionEntryChars: 0,
      memoryChars: 0,
    },
  } satisfies LoadedAgentInstructionsPrefix;

  if (!instructionsFilePath) return empty;

  let entrySection = "";
  try {
    const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
    entrySection =
      `${instructionsContents}\n\n` +
      `The above agent instructions were loaded from ${instructionsFilePath}. ` +
      `Resolve any relative file references from ${instructionsDir}.`;
    await input.onLog(
      "stdout",
      `[rudder] Loaded agent instructions file: ${instructionsFilePath}\n`,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await input.onLog(
      warningStream,
      `[rudder] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
    );
    return {
      ...empty,
      readFailed: true,
      commandNotes: [
        `Configured instructionsFilePath ${instructionsFilePath}, but file could not be read; continuing without injected instructions.`,
      ],
    };
  }

  const memoryFilePath = path.join(path.dirname(instructionsFilePath), "MEMORY.md");
  let memorySection = "";
  try {
    const memoryContents = await fs.readFile(memoryFilePath, "utf8");
    memorySection =
      `${memoryContents}\n\n` +
      `The above agent memory instructions were loaded from ${memoryFilePath}. ` +
      `Resolve any relative file references from ${instructionsDir}.`;
    await input.onLog(
      "stdout",
      `[rudder] Loaded agent memory instructions file: ${memoryFilePath}\n`,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      const reason = err instanceof Error ? err.message : String(err);
      await input.onLog(
        warningStream,
        `[rudder] Warning: could not read agent memory instructions file "${memoryFilePath}": ${reason}\n`,
      );
    }
  }

  const prefix = joinPromptSections([entrySection, memorySection]);
  const commandNotes = [
    `Loaded agent instructions from ${instructionsFilePath}`,
    ...(memorySection ? [`Loaded agent memory instructions from ${memoryFilePath}`] : []),
  ];
  return {
    prefix,
    commandNotes,
    instructionsFilePath,
    instructionsDir,
    memoryFilePath: memorySection ? memoryFilePath : null,
    readFailed: false,
    metrics: {
      instructionsChars: prefix.length,
      instructionEntryChars: entrySection.length,
      memoryChars: memorySection.length,
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

function windowsPathExts(env: NodeJS.ProcessEnv): string[] {
  return (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
}

async function pathExists(candidate: string) {
  try {
    await fs.access(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveCommandPath(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
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

function quoteForCmd(arg: string) {
  if (!arg.length) return '""';
  const escaped = arg.replace(/"/g, '""');
  return /[\s"&<>|^()]/.test(escaped) ? `"${escaped}"` : escaped;
}

async function resolveSpawnTarget(
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

export function ensurePathInEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (typeof env.PATH === "string" && env.PATH.length > 0) return env;
  if (typeof env.Path === "string" && env.Path.length > 0) return env;
  return { ...env, PATH: defaultPathForPlatform() };
}

function prependPathEntry(env: NodeJS.ProcessEnv, entry: string): NodeJS.ProcessEnv {
  const normalized = ensurePathInEnv(env);
  const pathKey = typeof normalized.PATH === "string" ? "PATH" : "Path";
  const current = normalized[pathKey] ?? "";
  const delimiter = process.platform === "win32" ? ";" : ":";
  const segments = current.split(delimiter).filter(Boolean);
  if (segments.includes(entry)) return normalized;
  return {
    ...normalized,
    [pathKey]: current.length > 0 ? `${entry}${delimiter}${current}` : entry,
  };
}

async function findAncestorWithFile(
  startDir: string,
  relativePath: string,
  maxDepth = 12,
): Promise<string | null> {
  let current = path.resolve(startDir);
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const candidate = path.join(current, relativePath);
    if (await pathExists(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

async function resolveRudderCliShimTarget(moduleDir: string): Promise<SpawnTarget | null> {
  const packagedCli = await findAncestorWithFile(moduleDir, "desktop-cli.js");
  if (packagedCli) {
    return {
      command: process.execPath,
      args: [packagedCli],
    };
  }

  const repoRoot = await findAncestorWithFile(moduleDir, path.join("cli", "src", "index.ts"));
  if (!repoRoot) return null;
  const rootDir = path.dirname(path.dirname(path.dirname(repoRoot)));
  const tsxEntry = path.join(rootDir, "cli", "node_modules", "tsx", "dist", "cli.mjs");
  const cliSource = path.join(rootDir, "cli", "src", "index.ts");
  if (await pathExists(tsxEntry)) {
    return {
      command: process.execPath,
      args: [tsxEntry, cliSource],
    };
  }

  const builtCliEntry = path.join(rootDir, "cli", "dist", "index.js");
  if (await pathExists(builtCliEntry)) {
    return {
      command: process.execPath,
      args: [builtCliEntry],
    };
  }

  return null;
}

async function materializeRudderCliShim(target: SpawnTarget): Promise<string> {
  const hash = createHash("sha1")
    .update(JSON.stringify({ command: target.command, args: target.args, platform: process.platform }))
    .digest("hex")
    .slice(0, 12);
  const shimDir = path.join(os.tmpdir(), "rudder-cli-shims", hash);
  await fs.mkdir(shimDir, { recursive: true });

  if (process.platform === "win32") {
    const shimPath = path.join(shimDir, "rudder.cmd");
    const commandLine = [quoteForCmd(target.command), ...target.args.map(quoteForCmd), "%*"].join(" ");
    await fs.writeFile(shimPath, `@echo off\r\n${commandLine}\r\n`, "utf8");
    return shimPath;
  }

  const shimPath = path.join(shimDir, "rudder");
  const commandLine = [target.command, ...target.args].map(shellQuote).join(" ");
  await fs.writeFile(shimPath, `#!/bin/sh\nexec ${commandLine} "$@"\n`, "utf8");
  await fs.chmod(shimPath, 0o755);
  return shimPath;
}

export async function ensureRudderCliInPath(
  moduleDir: string,
  env: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const normalized = ensurePathInEnv(env);
  const cwd = process.cwd();
  if (await resolveCommandPath("rudder", cwd, normalized)) {
    return normalized;
  }

  const target = await resolveRudderCliShimTarget(moduleDir);
  if (!target) {
    return normalized;
  }

  const shimPath = await materializeRudderCliShim(target);
  return prependPathEntry(normalized, path.dirname(shimPath));
}

export async function ensureAbsoluteDirectory(
  cwd: string,
  opts: { createIfMissing?: boolean } = {},
) {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`Working directory must be an absolute path: "${cwd}"`);
  }

  const assertDirectory = async () => {
    const stats = await fs.stat(cwd);
    if (!stats.isDirectory()) {
      throw new Error(`Working directory is not a directory: "${cwd}"`);
    }
  };

  try {
    await assertDirectory();
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!opts.createIfMissing || code !== "ENOENT") {
      if (code === "ENOENT") {
        throw new Error(`Working directory does not exist: "${cwd}"`);
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  try {
    await fs.mkdir(cwd, { recursive: true });
    await assertDirectory();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not create working directory "${cwd}": ${reason}`);
  }
}

export async function resolveRudderSkillsDir(
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<string | null> {
  const candidates = [
    ...RUDDER_SKILL_ROOT_RELATIVE_CANDIDATES.map((relativePath) => path.resolve(moduleDir, relativePath)),
    ...additionalCandidates.map((candidate) => path.resolve(candidate)),
  ];
  const seenRoots = new Set<string>();

  for (const root of candidates) {
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);
    const isDirectory = await fs.stat(root).then((stats) => stats.isDirectory()).catch(() => false);
    if (isDirectory) return root;
  }

  return null;
}

export async function listRudderSkillEntries(
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<RudderSkillEntry[]> {
  const root = await resolveRudderSkillsDir(moduleDir, additionalCandidates);
  if (!root) return [];

  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const skillDirectories = entries
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
    const skillEntries = await Promise.all(
      skillDirectories.map(async (entry) => {
        const source = path.join(root, entry.name);
        const metadata = await readSkillMetadataFromDirectory(source);
        return {
          key: `rudder/${entry.name}`,
          runtimeName: entry.name,
          source,
          name: metadata.name ?? entry.name,
          description: metadata.description,
        };
      }),
    );
    return skillEntries;
  } catch {
    return [];
  }
}

export async function readInstalledSkillTargets(skillsHome: string): Promise<Map<string, InstalledSkillTarget>> {
  const entries = await fs.readdir(skillsHome, { withFileTypes: true }).catch(() => []);
  const out = new Map<string, InstalledSkillTarget>();
  for (const entry of entries) {
    const fullPath = path.join(skillsHome, entry.name);
    const linkedPath = entry.isSymbolicLink() ? await fs.readlink(fullPath).catch(() => null) : null;
    out.set(entry.name, resolveInstalledEntryTarget(skillsHome, entry.name, entry, linkedPath));
  }
  return out;
}

export function buildPersistentSkillSnapshot(
  options: PersistentSkillSnapshotOptions,
): AgentRuntimeSkillSnapshot {
  const {
    agentRuntimeType,
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel,
    installedDetail,
    missingDetail,
    externalConflictDetail,
    externalDetail,
  } = options;
  const availableByKey = new Map(availableEntries.map((entry) => [entry.key, entry]));
  const desiredSet = new Set(desiredSkills);
  const entries: AgentRuntimeSkillEntry[] = [];
  const warnings = [...(options.warnings ?? [])];

  for (const available of availableEntries) {
    const installedEntry = installed.get(available.runtimeName) ?? null;
    const desired = desiredSet.has(available.key);
    let state: AgentRuntimeSkillEntry["state"] = "available";
    let managed = false;
    let detail: string | null = null;

    if (installedEntry?.targetPath === available.source) {
      managed = true;
      state = desired ? "installed" : "stale";
      detail = installedDetail ?? null;
    } else if (installedEntry) {
      state = "external";
      detail = desired ? externalConflictDetail : externalDetail;
    } else if (desired) {
      state = "missing";
      detail = missingDetail;
    }

    entries.push({
      key: available.key,
      runtimeName: available.runtimeName,
      description: available.description ?? null,
      desired,
      managed,
      state,
      sourcePath: available.source,
      targetPath: path.join(skillsHome, available.runtimeName),
      detail,
      ...buildManagedSkillOrigin(),
    });
  }

  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill)) continue;
    warnings.push(`Desired skill "${desiredSkill}" is not available from the Rudder skills directory.`);
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      sourcePath: null,
      targetPath: null,
      detail: "Rudder cannot find this skill in the local runtime skills directory.",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
    });
  }

  for (const [name, installedEntry] of installed.entries()) {
    if (availableEntries.some((entry) => entry.runtimeName === name)) continue;
    entries.push({
      key: name,
      runtimeName: name,
      description: null,
      desired: false,
      managed: false,
      state: "external",
      origin: "user_installed",
      originLabel: "User-installed",
      locationLabel: skillLocationLabel(locationLabel),
      readOnly: true,
      sourcePath: null,
      targetPath: installedEntry.targetPath ?? path.join(skillsHome, name),
      detail: externalDetail,
    });
  }

  entries.sort((left, right) => left.key.localeCompare(right.key));

  return {
    agentRuntimeType,
    supported: true,
    mode: "persistent",
    desiredSkills,
    entries,
    warnings,
  };
}

function normalizeConfiguredPaperclipRuntimeSkills(value: unknown): RudderSkillEntry[] {
  if (!Array.isArray(value)) return [];
  const out: RudderSkillEntry[] = [];
  for (const rawEntry of value) {
    const entry = parseObject(rawEntry);
    const key = asString(entry.key, asString(entry.name, "")).trim();
    const runtimeName = asString(entry.runtimeName, asString(entry.name, "")).trim();
    const source = asString(entry.source, "").trim();
    if (!key || !runtimeName || !source) continue;
    out.push({
      key,
      runtimeName,
      source,
      name: compactSkillText(asString(entry.displayName, asString(entry.name, ""))) ?? runtimeName,
      description: compactSkillText(
        typeof entry.description === "string"
          ? entry.description
          : typeof entry.summary === "string"
            ? entry.summary
            : null,
      ),
    });
  }
  return out;
}

export async function readRudderRuntimeSkillEntries(
  config: Record<string, unknown>,
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<RudderSkillEntry[]> {
  const configuredEntries = normalizeConfiguredPaperclipRuntimeSkills(
    config.rudderRuntimeSkills ?? config.paperclipRuntimeSkills,
  );
  if (configuredEntries.length > 0) return configuredEntries;
  return listRudderSkillEntries(moduleDir, additionalCandidates);
}

export async function readRudderSkillMarkdown(
  moduleDir: string,
  skillKey: string,
): Promise<string | null> {
  const normalized = skillKey.trim().toLowerCase().replace(/^rudder\/rudder\//, "rudder/");
  if (!normalized) return null;

  const entries = await listRudderSkillEntries(moduleDir);
  const match = entries.find((entry) => entry.key === normalized);
  if (!match) return null;

  try {
    return await fs.readFile(path.join(match.source, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
}

export function readRudderSkillSyncPreference(config: Record<string, unknown>): {
  explicit: boolean;
  desiredSkills: string[];
} {
  const raw = config.rudderSkillSync ?? config.paperclipSkillSync;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { explicit: false, desiredSkills: [] };
  }
  const syncConfig = raw as Record<string, unknown>;
  const desiredValues = syncConfig.desiredSkills;
  const desired = Array.isArray(desiredValues)
    ? desiredValues
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  return {
    explicit: Object.prototype.hasOwnProperty.call(raw, "desiredSkills"),
    desiredSkills: Array.from(new Set(desired)),
  };
}

function canonicalizeDesiredRudderSkillReference(
  reference: string,
  availableEntries: Array<{ key: string; runtimeName?: string | null }>,
): string {
  const normalizedReference = reference.trim().toLowerCase().replace(/^rudder\/rudder\//, "rudder/");
  if (!normalizedReference) return "";

  const exactKey = availableEntries.find((entry) => entry.key.trim().toLowerCase() === normalizedReference);
  if (exactKey) return exactKey.key;

  const byRuntimeName = availableEntries.filter((entry) =>
    typeof entry.runtimeName === "string" && entry.runtimeName.trim().toLowerCase() === normalizedReference,
  );
  if (byRuntimeName.length === 1) return byRuntimeName[0]!.key;

  const slugMatches = availableEntries.filter((entry) =>
    entry.key.trim().toLowerCase().split("/").pop() === normalizedReference,
  );
  if (slugMatches.length === 1) return slugMatches[0]!.key;

  return normalizedReference;
}

export function resolveRudderDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; runtimeName?: string | null }>,
): string[] {
  const preference = readRudderSkillSyncPreference(config);
  const desiredSkills = preference.desiredSkills
    .map((reference) => canonicalizeDesiredRudderSkillReference(reference, availableEntries))
    .filter(Boolean);
  return Array.from(new Set(desiredSkills));
}

export function writeRudderSkillSyncPreference(
  config: Record<string, unknown>,
  desiredSkills: string[],
): Record<string, unknown> {
  const next = { ...config };
  const raw = next.rudderSkillSync;
  const current =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  current.desiredSkills = Array.from(
    new Set(
      desiredSkills
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
  next.rudderSkillSync = current;
  return next;
}

export async function ensureRudderSkillSymlink(
  source: string,
  target: string,
  linkSkill: (source: string, target: string) => Promise<void> = (linkSource, linkTarget) =>
    fs.symlink(linkSource, linkTarget),
): Promise<"created" | "repaired" | "skipped"> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await linkSkill(source, target);
    return "created";
  }

  if (!existing.isSymbolicLink()) {
    return "skipped";
  }

  const linkedPath = await fs.readlink(target).catch(() => null);
  if (!linkedPath) return "skipped";

  const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
  if (resolvedLinkedPath === source) {
    return "skipped";
  }

  const linkedPathExists = await fs.stat(resolvedLinkedPath).then(() => true).catch(() => false);
  if (linkedPathExists) {
    return "skipped";
  }

  await fs.unlink(target);
  await linkSkill(source, target);
  return "repaired";
}

export async function removeMaintainerOnlySkillSymlinks(
  skillsHome: string,
  allowedSkillNames: Iterable<string>,
): Promise<string[]> {
  const allowed = new Set(Array.from(allowedSkillNames));
  try {
    const entries = await fs.readdir(skillsHome, { withFileTypes: true });
    const removed: string[] = [];
    for (const entry of entries) {
      if (allowed.has(entry.name)) continue;

      const target = path.join(skillsHome, entry.name);
      const existing = await fs.lstat(target).catch(() => null);
      if (!existing?.isSymbolicLink()) continue;

      const linkedPath = await fs.readlink(target).catch(() => null);
      if (!linkedPath) continue;

      const resolvedLinkedPath = path.isAbsolute(linkedPath)
        ? linkedPath
        : path.resolve(path.dirname(target), linkedPath);
      if (
        !isMaintainerOnlySkillTarget(linkedPath) &&
        !isMaintainerOnlySkillTarget(resolvedLinkedPath)
      ) {
        continue;
      }

      await fs.unlink(target);
      removed.push(entry.name);
    }

    return removed;
  } catch {
    return [];
  }
}

export async function ensureCommandResolvable(command: string, cwd: string, env: NodeJS.ProcessEnv) {
  const resolved = await resolveCommandPath(command, cwd, env);
  if (resolved) return;
  if (command.includes("/") || command.includes("\\")) {
    const absolute = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    throw new Error(`Command is not executable: "${command}" (resolved: "${absolute}")`);
  }
  throw new Error(`Command not found in PATH: "${command}"`);
}

export async function runChildProcess(
  runId: string,
  command: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    timeoutSec: number;
    graceSec: number;
    onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
    onLogError?: (err: unknown, runId: string, message: string) => void;
    onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
    stdin?: string;
    abortSignal?: AbortSignal;
  },
): Promise<RunProcessResult> {
  const onLogError = opts.onLogError ?? ((err, id, msg) => console.warn({ err, runId: id }, msg));

  return new Promise<RunProcessResult>((resolve, reject) => {
    const rawMerged: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
    const requestedHome =
      typeof opts.env.HOME === "string" && opts.env.HOME.trim().length > 0
        ? path.resolve(opts.env.HOME)
        : null;
    const inheritedHome =
      typeof process.env.HOME === "string" && process.env.HOME.trim().length > 0
        ? path.resolve(process.env.HOME)
        : null;
    const hasExplicitZdotdir =
      typeof opts.env.ZDOTDIR === "string" && opts.env.ZDOTDIR.trim().length > 0;

    // Strip Claude Code nesting-guard env vars so spawned `claude` processes
    // don't refuse to start with "cannot be launched inside another session".
    // These vars leak in when the Rudder server itself is started from
    // within a Claude Code session (e.g. `npx rudder run` in a terminal
    // owned by Claude Code) or when cron inherits a contaminated shell env.
    const CLAUDE_CODE_NESTING_VARS = [
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_SESSION",
      "CLAUDE_CODE_PARENT_SESSION",
    ] as const;
    for (const key of CLAUDE_CODE_NESTING_VARS) {
      delete rawMerged[key];
    }

    // When Rudder isolates HOME for child agents, don't let zsh keep using the
    // host user's startup dir via an inherited ZDOTDIR. That mismatch makes
    // child `zsh -lc` invocations source the host `.zshenv` with the agent HOME.
    if (requestedHome && requestedHome !== inheritedHome && !hasExplicitZdotdir) {
      delete rawMerged.ZDOTDIR;
    }

    const mergedEnv = ensurePathInEnv(rawMerged);
    void resolveSpawnTarget(command, args, opts.cwd, mergedEnv)
      .then((target) => {
        if (opts.abortSignal?.aborted) {
          resolve({
            exitCode: null,
            signal: "SIGTERM",
            timedOut: false,
            stdout: "",
            stderr: "",
            pid: null,
            startedAt: null,
          });
          return;
        }

        const child = spawn(target.command, target.args, {
          cwd: opts.cwd,
          env: mergedEnv,
          shell: false,
          stdio: [opts.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
        }) as ChildProcessWithEvents;
        const startedAt = new Date().toISOString();

        if (opts.stdin != null && child.stdin) {
          child.stdin.write(opts.stdin);
          child.stdin.end();
        }

        if (typeof child.pid === "number" && child.pid > 0 && opts.onSpawn) {
          void opts.onSpawn({ pid: child.pid, startedAt }).catch((err) => {
            onLogError(err, runId, "failed to record child process metadata");
          });
        }

        runningProcesses.set(runId, { child, graceSec: opts.graceSec });

        let timedOut = false;
        let aborted = false;
        let stdout = "";
        let stderr = "";
        let logChain: Promise<void> = Promise.resolve();

        const timeout =
          opts.timeoutSec > 0
            ? setTimeout(() => {
                timedOut = true;
                child.kill("SIGTERM");
                setTimeout(() => {
                  if (isChildProcessAlive(child)) {
                    child.kill("SIGKILL");
                  }
                }, Math.max(1, opts.graceSec) * 1000);
              }, opts.timeoutSec * 1000)
            : null;

        let abortCleanup: (() => void) | null = null;
        if (opts.abortSignal) {
          const onAbort = () => {
            aborted = true;
            child.kill("SIGTERM");
            setTimeout(() => {
              if (isChildProcessAlive(child)) {
                child.kill("SIGKILL");
              }
            }, Math.max(1, opts.graceSec) * 1000);
          };

          opts.abortSignal.addEventListener("abort", onAbort, { once: true });
          abortCleanup = () => opts.abortSignal?.removeEventListener("abort", onAbort);
        }

        child.stdout?.on("data", (chunk: unknown) => {
          const text = String(chunk);
          stdout = appendWithCap(stdout, text);
          logChain = logChain
            .then(() => opts.onLog("stdout", text))
            .catch((err) => onLogError(err, runId, "failed to append stdout log chunk"));
        });

        child.stderr?.on("data", (chunk: unknown) => {
          const text = String(chunk);
          stderr = appendWithCap(stderr, text);
          logChain = logChain
            .then(() => opts.onLog("stderr", text))
            .catch((err) => onLogError(err, runId, "failed to append stderr log chunk"));
        });

        child.on("error", (err: Error) => {
          if (timeout) clearTimeout(timeout);
          if (abortCleanup) abortCleanup();
          runningProcesses.delete(runId);
          const errno = (err as NodeJS.ErrnoException).code;
          const pathValue = mergedEnv.PATH ?? mergedEnv.Path ?? "";
          const msg =
            errno === "ENOENT"
              ? `Failed to start command "${command}" in "${opts.cwd}". Verify adapter command, working directory, and PATH (${pathValue}).`
              : `Failed to start command "${command}" in "${opts.cwd}": ${err.message}`;
          reject(new Error(msg));
        });

        child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
          if (timeout) clearTimeout(timeout);
          if (abortCleanup) abortCleanup();
          runningProcesses.delete(runId);
          void logChain.finally(() => {
            resolve({
              exitCode: code,
              signal: aborted ? "SIGTERM" : signal,
              timedOut,
              stdout,
              stderr,
              pid: child.pid ?? null,
              startedAt,
            });
          });
        });
      })
      .catch(reject);
  });
}
