import {
  RUDDER_BROWSER_MCP_SERVER_NAME,
  RUDDER_BROWSER_MCP_TOOL_NAMES,
  RUDDER_CORE_MCP_TOOL_NAMES,
  RUDDER_MCP_LEGACY_SERVER_NAMES,
  RUDDER_MCP_MANAGED_ENV_KEYS,
  RUDDER_MCP_SERVER_NAME,
  applyRudderBrowserCapabilityEnv,
  classifyAgentRuntimeNetworkFailure,
  inferOpenAiCompatibleBiller,
  rudderBrowserMcpRuntimeMetadata,
  rudderMcpRuntimeMetadata,
  type AgentRuntimeExecutionContext,
  type AgentRuntimeExecutionResult
} from "@rudderhq/agent-runtime-utils";
import { applyGitCredentialHelperPolicyEnv, applyGitIdentityPreparationEnv, ensureGitIdentityFileConfig } from "@rudderhq/agent-runtime-utils/git-identity";
import {
  preflightRudderBrowserMcpServer,
  preflightRudderMcpServer,
} from "@rudderhq/agent-runtime-utils/rudder-mcp-preflight";
import {
  resolveRudderBrowserMcpCliCommand,
  resolveRudderMcpCliCommand,
} from "@rudderhq/agent-runtime-utils/rudder-mcp-server";
import {
  RUDDER_PROMPT_SECTION_TAGS,
  asNumber,
  asString,
  asStringArray,
  buildRudderEnv,
  cleanupRetiredRudderManagedEntries,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  ensureRudderCliInPath,
  ensureRudderSkillSymlink,
  filterRudderDesiredSkillsForBrowserCapability,
  formatRetiredRudderManagedEntryCleanupWarnings,
  joinPromptSections,
  loadAgentInstructionsPrefix,
  parseJson,
  parseObject,
  prepareAgentInstructionRuntimeContext,
  readRudderRuntimeSkillEntries,
  redactEnvForLogs,
  removeUnselectedRudderSkillSymlinks,
  renderTemplate,
  resolveLocalOperatorHome,
  resolveRudderDesiredSkillNames,
  runChildProcess,
  selectPromptTemplate,
  shouldIncludeRuntimeHeartbeatInstructions,
  wrapPromptSection,
} from "@rudderhq/agent-runtime-utils/server-utils";
import { RUDDER_AGENT_V1_MCP_TOOL_NAMES } from "@rudderhq/shared";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PI_PROTECTED_ENV_KEYS } from "./config.js";
import {
  discoverPiManagedExternalMcpBindings,
  renderPiManagedExternalMcpExtension,
} from "./managed-external-mcp.js";
import { readPiLoadedMcpServers } from "./mcp-evidence.js";
import { ensurePiModelConfiguredAndAvailable } from "./models.js";
import {
  ensurePiOpenCodeAnonymousModelsConfig,
  parsePiModelId,
  parsePiModelProvider,
} from "./opencode-anonymous-config.js";
import { isPiUnknownSessionError, parsePiJsonl, parsePiJsonlLine } from "./parse.js";
import { prepareManagedPiHome } from "./skills.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const MAX_PI_LOG_TEXT_CHARS = 4_000;
const MAX_PI_RESULT_STDOUT_BYTES = 64 * 1024;
const PI_MANAGED_EXTERNAL_MCP_EXTENSION_NAME = "rudder-managed-external-mcp";
const PI_AUTH_REQUIRED_RE =
  /(?:auth(?:entication)?\s+required|api[-_\s]*key|invalid\s*api[-_\s]*key|x[-_\s]*api[-_\s]*key|not\s+logged\s+in|free\s+usage\s+exceeded|membership\s+benefits|membership\s+is\s+active|\b401\b.*status\s+code|\b401\b.*unauthorized)/i;

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function isPiAuthRequiredEvidence(...parts: Array<string | null | undefined>): boolean {
  return PI_AUTH_REQUIRED_RE.test(parts.filter(Boolean).join("\n"));
}

function truncateText(value: string, maxChars = MAX_PI_LOG_TEXT_CHARS): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}... [truncated ${value.length - maxChars} chars]`;
}

function extractPiTextContentForLog(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: string; text?: string } =>
      typeof item === "object" &&
      item !== null &&
      !Array.isArray(item) &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string")
    .map((item) => item.text ?? "")
    .join("");
}

function redactNoisyPiValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated-depth]";
  if (typeof value === "string") return truncateText(value);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactNoisyPiValue(item, depth + 1));

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/signature|thinking|reasoning/i.test(key)) {
      output[key] = "[redacted]";
      continue;
    }
    output[key] = redactNoisyPiValue(child, depth + 1);
  }
  return output;
}

function previewJsonValue(value: unknown, maxChars = MAX_PI_LOG_TEXT_CHARS): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return truncateText(value, maxChars);
  try {
    return truncateText(JSON.stringify(redactNoisyPiValue(value)), maxChars);
  } catch {
    return truncateText(String(value), maxChars);
  }
}

function sanitizePiStdoutLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "";
  const event = parseJson(trimmed);
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return JSON.stringify({ type: "malformed_event", redacted: true });
  }

  const record = event as Record<string, unknown>;
  const type = asString(record.type, "");
  const output: Record<string, unknown> = type ? { type } : { type: "event" };

  if (type === "session") {
    for (const key of ["version", "id", "timestamp", "cwd"]) {
      if (record[key] !== undefined) output[key] = record[key];
    }
    return JSON.stringify(output);
  }

  if (type === "agent_end") {
    const messages = Array.isArray(record.messages) ? record.messages : [];
    const lastAssistant = [...messages].reverse().find((message) =>
      typeof message === "object" &&
      message !== null &&
      !Array.isArray(message) &&
      (message as { role?: unknown }).role === "assistant") as Record<string, unknown> | undefined;
    const finalText = lastAssistant ? extractPiTextContentForLog(lastAssistant.content) : "";
    output.messageCount = messages.length;
    if (finalText) output.finalText = truncateText(finalText);
    return JSON.stringify(output);
  }

  if (type === "turn_end") {
    const message = record.message && typeof record.message === "object" && !Array.isArray(record.message)
      ? record.message as Record<string, unknown>
      : null;
    if (message) {
      output.message = {
        role: message.role,
        stopReason: message.stopReason,
        errorMessage: message.errorMessage,
        text: truncateText(extractPiTextContentForLog(message.content)),
        usage: message.usage,
      };
    }
    const toolResults = Array.isArray(record.toolResults) ? record.toolResults : [];
    if (toolResults.length > 0) {
      output.toolResults = toolResults.map((toolResult) => {
        if (typeof toolResult !== "object" || toolResult === null || Array.isArray(toolResult)) {
          return { content: previewJsonValue(toolResult) };
        }
        const toolRecord = toolResult as Record<string, unknown>;
        return {
          toolCallId: toolRecord.toolCallId,
          isError: toolRecord.isError === true,
          content: previewJsonValue(toolRecord.content),
        };
      });
    }
    return JSON.stringify(output);
  }

  if (type === "message_update") {
    const assistantEvent = record.assistantMessageEvent &&
      typeof record.assistantMessageEvent === "object" &&
      !Array.isArray(record.assistantMessageEvent)
      ? record.assistantMessageEvent as Record<string, unknown>
      : null;
    const messageType = assistantEvent ? asString(assistantEvent.type, "") : "";
    output.assistantMessageEvent = {
      type: messageType || "unknown",
      ...(messageType === "text_delta" ? { delta: truncateText(asString(assistantEvent?.delta, "")) } : {}),
    };
    return JSON.stringify(output);
  }

  if (type === "tool_execution_start" || type === "tool_execution_end") {
    output.toolCallId = record.toolCallId;
    output.toolName = record.toolName;
    if (record.args !== undefined) output.args = previewJsonValue(record.args);
    if (record.result !== undefined) output.result = previewJsonValue(record.result);
    if (record.isError !== undefined) output.isError = record.isError === true;
    return JSON.stringify(output);
  }

  if (type === "usage" || record.usage !== undefined) {
    output.usage = record.usage;
    return JSON.stringify(output);
  }

  return JSON.stringify(output);
}

function sanitizePiStdout(stdout: string): string {
  const sanitized = stdout
    .split(/\r?\n/)
    .map(sanitizePiStdoutLine)
    .filter(Boolean)
    .join("\n");
  if (Buffer.byteLength(sanitized, "utf8") <= MAX_PI_RESULT_STDOUT_BYTES) return sanitized;
  return `${sanitized.slice(0, MAX_PI_RESULT_STDOUT_BYTES)}\n[rudder] Pi stdout sanitized and truncated for persistence.`;
}

function resolvePiRoot(homeDir: string): string {
  return path.join(homeDir, ".pi");
}

function resolvePiSessionsDir(homeDir: string): string {
  return path.join(resolvePiRoot(homeDir), "paperclips");
}

function resolvePiSkillsDir(homeDir: string): string {
  return path.join(resolvePiRoot(homeDir), "agent", "skills");
}

function resolvePiExtensionsDir(homeDir: string): string {
  return path.join(resolvePiRoot(homeDir), "agent", "extensions");
}

function renderJsonForTs(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export type RudderMcpToolManifestEntry = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export function resolvePiRudderMcpToolEntries(
  manifestTools: RudderMcpToolManifestEntry[],
  surface: "core" | "browser",
): RudderMcpToolManifestEntry[] {
  const tools = manifestTools.length > 0
    ? manifestTools
    : RUDDER_AGENT_V1_MCP_TOOL_NAMES.map((name) => ({
        name,
        description: `Rudder Agent V1 Rudder tool ${name}. Runtime identity and authorization are injected by Rudder; do not pass orgId, agentId, runId, apiBase, or apiKey.`,
        inputSchema: {
          type: "object",
          additionalProperties: true,
          properties: {},
        },
      }));
  const allowedNames = new Set<string>(
    surface === "browser" ? RUDDER_BROWSER_MCP_TOOL_NAMES : RUDDER_CORE_MCP_TOOL_NAMES,
  );
  return tools.filter((tool) => allowedNames.has(tool.name));
}

async function ensurePiRudderToolsExtension(input: {
  surface: "core" | "browser";
  browserEnabled: boolean;
  homeDir: string;
  moduleDir: string;
  runtimeEnv: Record<string, string>;
  onLog: AgentRuntimeExecutionContext["onLog"];
}): Promise<{
  active: boolean;
  path: string;
  configuredToolCount: number;
  toolNames: string[];
  schemaFallbackReason: string | null;
  browserEnabled: boolean;
  rudderMcpPreflight: Awaited<ReturnType<typeof preflightRudderMcpServer>>;
}> {
  const serverName = input.surface === "browser" ? RUDDER_BROWSER_MCP_SERVER_NAME : RUDDER_MCP_SERVER_NAME;
  const rudderMcp = input.surface === "browser"
    ? await resolveRudderBrowserMcpCliCommand(input.moduleDir)
    : await resolveRudderMcpCliCommand(input.moduleDir);
  const extensionsDir = resolvePiExtensionsDir(input.homeDir);
  if (input.surface === "core") {
    for (const legacyServerName of RUDDER_MCP_LEGACY_SERVER_NAMES) {
      await fs.rm(path.join(extensionsDir, legacyServerName), { recursive: true, force: true });
    }
  }
  const extensionDir = path.join(extensionsDir, serverName);
  const extensionPath = path.join(extensionDir, "index.ts");
  const command = rudderMcp.command;
  const commandArgs = rudderMcp.args;
  const commandEnv = rudderMcp.env ?? {};
  const rudderMcpPreflight = input.surface === "browser"
    ? await preflightRudderBrowserMcpServer({ command: rudderMcp, runtimeEnv: input.runtimeEnv })
    : await preflightRudderMcpServer({
        command: rudderMcp,
        runtimeEnv: input.runtimeEnv,
        browserEnabled: false,
      });
  if (input.surface === "core" && !rudderMcpPreflight.available) {
    await input.onLog(
      "stderr",
      `[rudder] Rudder MCP is unavailable; continuing without verified Rudder MCP tools: ${rudderMcpPreflight.diagnostic}\n`,
    );
    await fs.rm(extensionDir, { recursive: true, force: true });
    return {
      active: false,
      path: extensionPath,
      configuredToolCount: 0,
      toolNames: [],
      schemaFallbackReason: rudderMcpPreflight.diagnostic
        ?? "Rudder MCP capability preparation failed.",
      browserEnabled: input.browserEnabled,
      rudderMcpPreflight,
    };
  }
  const browserEnabled = input.surface === "browser"
    ? input.browserEnabled && rudderMcpPreflight.browserAvailable === true
    : input.browserEnabled;
  if (input.surface === "browser" && input.browserEnabled && !browserEnabled) {
    await input.onLog("stderr", `[rudder] ${rudderMcpPreflight.diagnostic}\n`);
  }
  const toolEntries = resolvePiRudderMcpToolEntries(rudderMcpPreflight.tools, input.surface);
  const toolNames = toolEntries.map((entry) => entry.name);
  const source = `import { spawn } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RUDDER_MCP_COMMAND = ${renderJsonForTs(command)};
const RUDDER_MCP_ARGS = ${renderJsonForTs(commandArgs)} as string[];
const RUDDER_MCP_ENV = ${renderJsonForTs(commandEnv)} as Record<string, string>;
const RUDDER_MCP_MANAGED_ENV_KEYS = ${renderJsonForTs([...RUDDER_MCP_MANAGED_ENV_KEYS])} as string[];
const RUDDER_MCP_TOOLS = ${renderJsonForTs(toolEntries)} as Array<{
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}>;

function pickManagedRuntimeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of RUDDER_MCP_MANAGED_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) env[key] = value;
  }
  return env;
}

function invokeRudderMcpTool(toolName: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Rudder MCP tool call aborted"));
      return;
    }
    const child = spawn(RUDDER_MCP_COMMAND, RUDDER_MCP_ARGS, {
      env: { ...process.env, ...RUDDER_MCP_ENV, ...pickManagedRuntimeEnv() },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const abort = () => {
      child.kill("SIGTERM");
      reject(new Error("Rudder MCP tool call aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      signal?.removeEventListener("abort", abort);
      reject(err);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || \`Rudder MCP server exited with code \${code ?? -1}\`));
        return;
      }
      const line = stdout.split(/\\r?\\n/).map((entry) => entry.trim()).find(Boolean);
      if (!line) {
        reject(new Error("Rudder MCP server returned an empty response"));
        return;
      }
      try {
        const response = JSON.parse(line) as Record<string, unknown>;
        if (response.error && typeof response.error === "object") {
          const error = response.error as { message?: unknown };
          reject(new Error(typeof error.message === "string" ? error.message : JSON.stringify(response.error)));
          return;
        }
        const result = (response.result && typeof response.result === "object" ? response.result : response) as Record<string, unknown>;
        if (result.isError === true) {
          const content = Array.isArray(result.content) ? result.content : [];
          const textContent = content
            .map((item) => {
              if (!item || typeof item !== "object" || Array.isArray(item)) return "";
              const record = item as Record<string, unknown>;
              return record.type === "text" && typeof record.text === "string" ? record.text : "";
            })
            .filter(Boolean)
            .join("\\n");
          reject(new Error(textContent || JSON.stringify(result.structuredContent ?? result)));
          return;
        }
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
    child.stdin.end(JSON.stringify({
      jsonrpc: "2.0",
      id: "pi-rudder-tool",
      method: "tools/call",
      params: { name: toolName, arguments: params ?? {} },
    }) + "\\n");
  });
}

export default function rudderAgentTools(pi: ExtensionAPI) {
  for (const tool of RUDDER_MCP_TOOLS) {
    const toolName = tool.name;
    pi.registerTool({
      name: toolName,
      label: toolName,
      description: tool.description || \`Rudder Agent V1 Rudder tool \${toolName}. Runtime identity and authorization are injected by Rudder; do not pass orgId, agentId, runId, apiBase, or apiKey.\`,
      promptSnippet: \`Call Rudder tool \${toolName} with runtime-managed authentication.\`,
      promptGuidelines: ["Prefer Rudder tools for Rudder work. Do not call the rudder CLI from bash for Rudder operations."],
      parameters: tool.inputSchema ?? Type.Object({}, { additionalProperties: true }),
      async execute(_toolCallId, params, signal) {
        const result = await invokeRudderMcpTool(toolName, params as Record<string, unknown>, signal);
        const content = Array.isArray(result.content) ? result.content : [{ type: "text", text: JSON.stringify(result.structuredContent ?? result) }];
        return {
          content,
          details: result,
        };
      },
    });
  }
}
`;

  await fs.mkdir(extensionDir, { recursive: true });
  await fs.writeFile(extensionPath, source, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(extensionPath, 0o600);
  await input.onLog(
    "stdout",
    `[rudder] Wrote managed Pi ${serverName} tool extension into ${extensionPath}.\n`,
  );
  if (!rudderMcpPreflight.available) {
    await input.onLog("stderr", `[rudder] Pi Rudder tool extension fell back to permissive schemas: ${rudderMcpPreflight.diagnostic}\n`);
  }
  return {
    active: true,
    path: extensionPath,
    configuredToolCount: toolEntries.length,
    toolNames,
    schemaFallbackReason: rudderMcpPreflight.available ? null : rudderMcpPreflight.diagnostic,
    browserEnabled,
    rudderMcpPreflight,
  };
}

function renderPiRudderSkillBoundaryPrompt(
  loadedSkills: Array<{ key: string; runtimeName?: string | null; name?: string | null }>,
): string {
  const skillLines = loadedSkills.length > 0
    ? loadedSkills.map((entry) => `- ${entry.runtimeName ?? entry.key}`)
    : ["- None. No optional Rudder skills are enabled for this run."];

  return wrapPromptSection(RUDDER_PROMPT_SECTION_TAGS.enabledSkills, [
    "Rudder is the source of truth for runtime skill enablement.",
    "Only skills listed in this section are enabled by Rudder for this run. Pi built-in/provider-native skills, operator-home skills, project skills, host-global skills, bundled skills, vendor-default skills, and the current Pi client session may expose other capabilities, but they are not Rudder-enabled skills and must not be described as this agent's Rudder skills unless listed here.",
    "When the user asks what skills are enabled, loaded, available, or what skills you have in Rudder, answer with only the runtime skill names listed in this section. Use a plain newline-separated list. Do not use prose, bullets, Markdown, code spans, explanations, prefixes, or suffixes. If exactly one skill is listed, answer exactly that runtime skill name and nothing else. Do not list, summarize, or explain provider-native Pi skills, operator-home skills, project skills, host-global skills, bundled skills, vendor-default skills, or current-session capabilities in that answer.",
    "",
    ...skillLines,
  ].join("\n"));
}

async function ensurePiSkillsInjected(
  onLog: AgentRuntimeExecutionContext["onLog"],
  skillsEntries: Array<{ key: string; runtimeName: string; source: string }>,
  skillsDir: string,
  desiredSkillNames?: string[],
) {
  const desiredSet = new Set(desiredSkillNames ?? skillsEntries.map((entry) => entry.key));
  const selectedEntries = skillsEntries.filter((entry) => desiredSet.has(entry.key));
  await fs.mkdir(skillsDir, { recursive: true });
  const cleanupResults = await cleanupRetiredRudderManagedEntries(skillsDir, selectedEntries);
  for (const warning of formatRetiredRudderManagedEntryCleanupWarnings(cleanupResults, skillsDir)) {
    await onLog("stderr", `[rudder] ${warning}\n`);
  }
  const allowedSkillNames = selectedEntries.map((entry) => entry.runtimeName);
  for (const cleanupResult of cleanupResults) {
    if (cleanupResult.state === "collision" || cleanupResult.state === "failed") {
      allowedSkillNames.push(cleanupResult.runtimeName);
    }
  }
  const removedSkills = await removeUnselectedRudderSkillSymlinks(
    skillsDir,
    allowedSkillNames,
    skillsEntries.map((entry) => entry.source),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[rudder] Removed maintainer-only Pi skill "${skillName}" from ${skillsDir}\n`,
    );
  }

  for (const entry of selectedEntries) {
    const target = path.join(skillsDir, entry.runtimeName);

    try {
      const result = await ensureRudderSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[rudder] ${result === "repaired" ? "Repaired" : "Injected"} Pi skill "${entry.runtimeName}" into ${skillsDir}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[rudder] Failed to inject Pi skill "${entry.runtimeName}" into ${skillsDir}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

function resolvePiBiller(env: Record<string, string>, provider: string | null): string {
  return inferOpenAiCompatibleBiller(env, null) ?? provider ?? "unknown";
}

async function ensureSessionsDir(sessionsDir: string): Promise<string> {
  await fs.mkdir(sessionsDir, { recursive: true });
  return sessionsDir;
}

function buildSessionPath(sessionsDir: string, agentId: string, timestamp: string): string {
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  return path.join(sessionsDir, `${safeTimestamp}-${agentId}.jsonl`);
}

export async function execute(ctx: AgentRuntimeExecutionContext): Promise<AgentRuntimeExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const configuredPromptTemplate = asString(config.promptTemplate, "");
  const hasConfiguredPromptTemplate = configuredPromptTemplate.trim().length > 0;
  const promptTemplate = selectPromptTemplate(
    configuredPromptTemplate,
    context,
  );
  const command = asString(config.command, "pi");
  const model = asString(config.model, "").trim();
  const thinking = asString(config.thinking, "").trim();

  // Parse model into provider and model id
  const provider = parsePiModelProvider(model);
  const modelId = parsePiModelId(model);

  const workspaceContext = parseObject(context.rudderWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const agentInstructionsDir = asString(workspaceContext.instructionsDir, "");
  const agentMemoryDir = asString(workspaceContext.memoryDir, "");
  const agentSkillsDir = asString(workspaceContext.agentSkillsDir, "");
  const orgWorkspaceRoot = asString(workspaceContext.orgWorkspaceRoot, "");
  const orgSkillsDir = asString(workspaceContext.orgSkillsDir, "");
  const projectLibraryRoot = asString(workspaceContext.projectLibraryRoot, "");
  const projectLibraryPath = asString(workspaceContext.projectLibraryRelativePath, "");
  const workspaceHints = Array.isArray(context.rudderWorkspaces)
    ? context.rudderWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  const envConfig = parseObject(config.env);
  const envConfigStrings = Object.fromEntries(
    Object.entries(envConfig).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && !PI_PROTECTED_ENV_KEYS.has(entry[0]),
    ),
  );
  const sourceEnv = {
    ...process.env,
  };
  const operatorHome = resolveLocalOperatorHome(sourceEnv);
  const managedHome = await prepareManagedPiHome({ ...sourceEnv, ...envConfigStrings }, operatorHome, onLog, agent.orgId);
  const preparedGitIdentity = await ensureGitIdentityFileConfig({
    cwd,
    home: managedHome,
    sourceEnv,
    onLog,
  });
  const sessionsDir = resolvePiSessionsDir(managedHome);
  const skillsDir = resolvePiSkillsDir(managedHome);
  
  // Ensure sessions directory exists
  await ensureSessionsDir(sessionsDir);
  
  // Inject skills
  const piSkillEntries = await readRudderRuntimeSkillEntries(config, __moduleDir);
  const desiredPiSkillNames = resolveRudderDesiredSkillNames(config, piSkillEntries);

  // Build environment
  const env: Record<string, string> = { ...buildRudderEnv(agent) };
  env.HOME = operatorHome;
  env.USERPROFILE = operatorHome;
  env.PI_CODING_AGENT_DIR = path.join(managedHome, ".pi", "agent");
  env.PI_CODING_AGENT_SESSION_DIR = sessionsDir;
  env.RUDDER_RUN_ID = runId;
  
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
    
  if (wakeTaskId) env.RUDDER_TASK_ID = wakeTaskId;
  if (wakeReason) env.RUDDER_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.RUDDER_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.RUDDER_APPROVAL_ID = approvalId;
  if (approvalStatus) env.RUDDER_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.RUDDER_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (workspaceCwd) env.RUDDER_WORKSPACE_CWD = workspaceCwd;
  if (workspaceSource) env.RUDDER_WORKSPACE_SOURCE = workspaceSource;
  if (workspaceId) env.RUDDER_WORKSPACE_ID = workspaceId;
  if (workspaceRepoUrl) env.RUDDER_WORKSPACE_REPO_URL = workspaceRepoUrl;
  if (workspaceRepoRef) env.RUDDER_WORKSPACE_REPO_REF = workspaceRepoRef;
  if (agentHome) {
    env.AGENT_HOME = agentHome;
    env.RUDDER_AGENT_ROOT = agentHome;
  }
  if (agentInstructionsDir) env.RUDDER_AGENT_INSTRUCTIONS_DIR = agentInstructionsDir;
  if (agentMemoryDir) env.RUDDER_AGENT_MEMORY_DIR = agentMemoryDir;
  if (agentSkillsDir) env.RUDDER_AGENT_SKILLS_DIR = agentSkillsDir;
  if (orgWorkspaceRoot) env.RUDDER_ORG_WORKSPACE_ROOT = orgWorkspaceRoot;
  if (orgSkillsDir) env.RUDDER_ORG_SKILLS_DIR = orgSkillsDir;
  if (projectLibraryRoot) env.RUDDER_PROJECT_LIBRARY_ROOT = projectLibraryRoot;
  if (projectLibraryPath) env.RUDDER_PROJECT_LIBRARY_PATH = projectLibraryPath;
  if (workspaceHints.length > 0) env.RUDDER_WORKSPACES_JSON = JSON.stringify(workspaceHints);

  for (const [key, value] of Object.entries(envConfig)) {
    if (PI_PROTECTED_ENV_KEYS.has(key)) continue;
    if (typeof value === "string") env[key] = value;
  }
  let browserEnabled = applyRudderBrowserCapabilityEnv(env, config);
  env.HOME = operatorHome;
  env.USERPROFILE = operatorHome;
  env.PI_CODING_AGENT_DIR = path.join(managedHome, ".pi", "agent");
  env.PI_CODING_AGENT_SESSION_DIR = sessionsDir;
  env.RUDDER_OPERATOR_HOME = operatorHome;
  if (authToken) env.RUDDER_API_KEY = authToken;
  applyGitIdentityPreparationEnv(env, preparedGitIdentity);
  applyGitCredentialHelperPolicyEnv(env);
  const piModelConfigNotes = await ensurePiOpenCodeAnonymousModelsConfig({
    modelProvider: provider,
    modelId,
    piAgentDir: env.PI_CODING_AGENT_DIR,
    sourceEnv,
    runtimeEnv: env,
    onLog,
  });
  
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv(await ensureRudderCliInPath(__moduleDir, { ...process.env, ...env })))
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  const rudderPiExtensionPath = await ensurePiRudderToolsExtension({
    surface: "core",
    browserEnabled,
    homeDir: managedHome,
    moduleDir: __moduleDir,
    runtimeEnv,
    onLog,
  }).catch(async () => {
    await fs.rm(
      path.join(resolvePiExtensionsDir(managedHome), RUDDER_MCP_SERVER_NAME),
      { recursive: true, force: true },
    );
    await onLog(
      "stderr",
      "[rudder] Rudder MCP capability preparation failed; continuing without Rudder MCP tools.\n",
    );
    return {
      active: false,
      path: path.join(resolvePiExtensionsDir(managedHome), RUDDER_MCP_SERVER_NAME, "index.ts"),
      configuredToolCount: 0,
      toolNames: [],
      schemaFallbackReason: "Rudder MCP capability preparation failed.",
      browserEnabled,
      rudderMcpPreflight: {
        available: false,
        provenance: "repo" as const,
        version: null,
        contractVersion: null,
        coreContractHash: null,
        diagnosticCode: "core_bundle_handshake_failed" as const,
        diagnostic: "Rudder MCP capability preparation failed.",
        tools: [],
      },
    };
  });
  const managedExternalMcpBindings = await discoverPiManagedExternalMcpBindings(
    config,
    runtimeEnv,
    {
      signal: ctx.abortSignal,
      onFailure: async (serverName) => {
        await onLog(
          "stderr",
          `[rudder] Managed MCP ${serverName ? `server "${serverName}"` : "configuration"} was unavailable during Pi tool discovery and was omitted.\n`,
        );
      },
    },
  );
  const managedExternalMcpExtensionDir = path.join(
    resolvePiExtensionsDir(managedHome),
    PI_MANAGED_EXTERNAL_MCP_EXTENSION_NAME,
  );
  const managedExternalMcpExtensionPath = managedExternalMcpBindings.length > 0
    ? path.join(managedExternalMcpExtensionDir, "index.ts")
    : null;
  if (managedExternalMcpExtensionPath) {
    await fs.mkdir(managedExternalMcpExtensionDir, { recursive: true });
    const tempPath = `${managedExternalMcpExtensionPath}.${runId}.tmp`;
    try {
      await fs.writeFile(
        tempPath,
        renderPiManagedExternalMcpExtension(managedExternalMcpBindings),
        { encoding: "utf8", mode: 0o600 },
      );
      await fs.rename(tempPath, managedExternalMcpExtensionPath);
      await fs.chmod(managedExternalMcpExtensionPath, 0o600);
    } finally {
      await fs.rm(tempPath, { force: true });
    }
    await onLog(
      "stdout",
      `[rudder] Wrote managed Pi external MCP bridge with ${managedExternalMcpBindings.length} independent server${managedExternalMcpBindings.length === 1 ? "" : "s"}.\n`,
    );
  } else {
    await fs.rm(managedExternalMcpExtensionDir, { recursive: true, force: true });
  }
  const browserExtensionDir = path.join(resolvePiExtensionsDir(managedHome), RUDDER_BROWSER_MCP_SERVER_NAME);
  const attemptedBrowserPiExtension = browserEnabled
    ? await ensurePiRudderToolsExtension({
        surface: "browser",
        browserEnabled,
        homeDir: managedHome,
        moduleDir: __moduleDir,
        runtimeEnv,
        onLog,
      }).catch(async () => {
        await onLog(
          "stderr",
          "[rudder] Browser MCP capability preparation failed; continuing without browser tools.\n",
        );
        return null;
      })
    : null;
  const rudderBrowserPiExtensionPath = attemptedBrowserPiExtension?.browserEnabled
    ? attemptedBrowserPiExtension
    : null;
  browserEnabled = rudderBrowserPiExtensionPath !== null;
  if (!browserEnabled) {
    await fs.rm(browserExtensionDir, { recursive: true, force: true });
  }
  delete runtimeEnv.RUDDER_DESKTOP_CLI_ENTRY;
  delete runtimeEnv.RUDDER_MCP_RUDDER_BIN;
  env.RUDDER_BROWSER_ENABLED = browserEnabled ? "true" : "false";
  runtimeEnv.RUDDER_BROWSER_ENABLED = browserEnabled ? "true" : "false";
  const effectiveDesiredPiSkillNames = filterRudderDesiredSkillsForBrowserCapability(
    piSkillEntries,
    desiredPiSkillNames,
    browserEnabled,
  );
  const selectedPiSkillEntries = piSkillEntries
    .filter((entry) => effectiveDesiredPiSkillNames.includes(entry.key));
  const loadedSkills = selectedPiSkillEntries.map((entry) => ({
    key: entry.key,
    runtimeName: entry.runtimeName,
    name: entry.name ?? null,
    description: entry.description ?? null,
  }));
  const skillBoundaryPrompt = renderPiRudderSkillBoundaryPrompt(loadedSkills);
  await ensurePiSkillsInjected(onLog, piSkillEntries, skillsDir, effectiveDesiredPiSkillNames);
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  // Validate model is available before execution
  await ensurePiModelConfiguredAndAvailable({
    model,
    command,
    cwd,
    env: runtimeEnv,
  });

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  // Handle session
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionPath = canResumeSession
    ? runtimeSessionId
    : buildSessionPath(sessionsDir, agent.id, new Date().toISOString());
  
  if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[rudder] Pi session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  // Ensure session file exists (Pi requires this on first run)
  if (!canResumeSession) {
    try {
      await fs.writeFile(sessionPath, "", { flag: "wx" });
    } catch (err) {
      // File may already exist, that's ok
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }
  }

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const resolvedInstructionsFilePath = instructionsFilePath
    ? path.resolve(cwd, instructionsFilePath)
    : "";
  const instructionRuntimeContext = prepareAgentInstructionRuntimeContext(context as Record<string, unknown>);
  const loadedInstructions = await loadAgentInstructionsPrefix({
    instructionsFilePath: resolvedInstructionsFilePath,
    includeHeartbeatInstructions:
      !hasConfiguredPromptTemplate &&
      shouldIncludeRuntimeHeartbeatInstructions(context as Record<string, unknown>),
    instructionContextSections: instructionRuntimeContext.instructionContextSections,
    onLog,
  });
  const systemPromptExtension = loadedInstructions.prefix
    ? joinPromptSections([
      loadedInstructions.prefix,
      "You are agent {{agent.id}} ({{agent.name}}). Continue your Rudder work.",
    ])
    : promptTemplate;
  const instructionsFileDir = loadedInstructions.instructionsDir;

  /**
   * Final prompt assembly order is intentional and shared across runtimes:
   * 1) optional bootstrap prompt (only when not resuming a prior session),
   * 2) optional session handoff markdown,
   * 3) heartbeat prompt selected by wake trigger (assignment, mention, retry, fallback).
   *
   * Prompt example (retry wakeup):
   * [bootstrap prompt]
   * [session handoff note]
   * You are agent agent-789 (Infra Agent). Your previous run was interrupted and is being resumed.
   * Previous Run ID: run-123
   * Reason: heartbeat_timeout
   *
   * PI also keeps a rendered system prompt extension in sync with the heartbeat prompt.
   * Reasoning: assignment/mention heartbeat templates carry issue/comment context so
   * the agent can start useful work on turn one without spending extra tool calls on
   * "what changed?" discovery.
   *
   * Traceability:
   * - doc/engineering/DEVELOPING.md
   */
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    orgId: agent.orgId,
    runId,
    organization: { id: agent.orgId },
    agent,
    run: {
      id: runId,
      source: context.wakeSource ?? "on_demand",
      wakeReason: context.wakeReason ?? null,
    },
    context: instructionRuntimeContext.promptContext,
    // Issue and comment context for enriched prompts
    issue: context.issue ?? null,
    comment: context.comment ?? null,
    wakeReason: context.wakeReason ?? null,
    wakeSource: context.wakeSource ?? null,
  };
  const renderedSystemPromptExtension = wrapPromptSection(
    RUDDER_PROMPT_SECTION_TAGS.agentInstruction,
    joinPromptSections([
      renderTemplate(systemPromptExtension, templateData),
      skillBoundaryPrompt,
    ]),
  );
  const renderedHeartbeatPrompt = renderTemplate(promptTemplate, templateData);
  const renderedBootstrapPrompt =
    !canResumeSession && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const sessionHandoffNote = asString(context.rudderSessionHandoffMarkdown, "").trim();
  const userPrompt = joinPromptSections([
    renderedBootstrapPrompt,
    sessionHandoffNote,
    renderedHeartbeatPrompt,
  ]);
  const agentInstructionStack = joinPromptSections([
    renderedSystemPromptExtension,
    userPrompt,
  ]);
  const promptMetrics = {
    systemPromptChars: renderedSystemPromptExtension.length,
    promptChars: userPrompt.length,
    ...loadedInstructions.metrics,
    skillBoundaryPromptChars: skillBoundaryPrompt.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedHeartbeatPrompt.length,
  };

  const commandNotes = (() => {
    const baseNotes = [
      ...loadedInstructions.commandNotes,
      ...piModelConfigNotes,
    ];
    if (!resolvedInstructionsFilePath) {
      return [
        ...baseNotes,
        "Appended Rudder operating contract to system prompt.",
      ];
    }
    if (loadedInstructions.readFailed) return baseNotes;
    return [
      ...baseNotes,
      `Appended instructions + path directive to system prompt (relative references from ${instructionsFileDir}).`,
    ];
  })();

  const buildArgs = (sessionFile: string): string[] => {
    const args: string[] = [];

    // Use headless JSON mode so the process exits only after the model turn finishes.
    args.push("--print", "--mode", "json");
    
    // Use --append-system-prompt to extend Pi's default system prompt
    args.push("--append-system-prompt", renderedSystemPromptExtension);
    
    if (provider) args.push("--provider", provider);
    if (modelId) args.push("--model", modelId);
    if (thinking) args.push("--thinking", thinking);

    args.push("--tools", [
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      ...rudderPiExtensionPath.toolNames,
      ...(rudderBrowserPiExtensionPath?.toolNames ?? []),
      ...managedExternalMcpBindings.flatMap((binding) =>
        binding.tools.map((tool) => tool.name)),
    ].join(","));
    args.push("--session", sessionFile);
    if (rudderPiExtensionPath.active) {
      args.push("--extension", rudderPiExtensionPath.path);
    }
    if (rudderBrowserPiExtensionPath) args.push("--extension", rudderBrowserPiExtensionPath.path);
    if (managedExternalMcpExtensionPath) {
      args.push("--extension", managedExternalMcpExtensionPath);
    }

    // Disable Pi's default user/project skill discovery, then add only Rudder's
    // selected managed skill directory for this run.
    args.push("--no-skills", "--skill", skillsDir);

    if (extraArgs.length > 0) args.push(...extraArgs);

    return args;
  };

  const runAttempt = async (sessionFile: string) => {
    const args = buildArgs(sessionFile);
    const processArgs = [...args, userPrompt];
    if (onMeta) {
      await onMeta({
        agentRuntimeType: "pi_local",
        command,
        cwd,
        commandNotes,
        commandArgs: [...args, `<prompt ${userPrompt.length} chars>`],
        env: redactEnvForLogs(env),
        prompt: userPrompt,
        agentInstructionStack,
        promptMetrics,
        loadedMcpServers: readPiLoadedMcpServers(),
        loadedSkills,
        realizedSkills: loadedSkills,
        rudderMcp: rudderMcpRuntimeMetadata({
          available: false,
          browserEnabled,
          preflight: rudderPiExtensionPath.rudderMcpPreflight,
          fallbackReason: "Pi CLI does not expose a supported MCP server configuration surface; Rudder tools are injected through a managed Pi extension.",
        }),
        browserMcp: rudderBrowserMcpRuntimeMetadata({
          available: false,
          preflight: attemptedBrowserPiExtension?.rudderMcpPreflight,
          fallbackReason: attemptedBrowserPiExtension?.rudderMcpPreflight.diagnostic ?? (
            browserEnabled
              ? "Pi CLI does not expose a supported MCP server configuration surface; Rudder Browser tools are injected through a separate managed Pi extension."
              : "Rudder Browser is disabled for this run."
          ),
        }),
        rudderNativeTools: {
          available: rudderPiExtensionPath.schemaFallbackReason === null,
          transport: "pi_extension",
          serverName: RUDDER_MCP_SERVER_NAME,
          toolCount: rudderPiExtensionPath.configuredToolCount,
          toolNames: rudderPiExtensionPath.toolNames,
          authMode: "runtime_managed",
          modelVisibleCliFallback: false,
          fallbackReason: rudderPiExtensionPath.schemaFallbackReason,
        },
        browserNativeTools: rudderBrowserPiExtensionPath
          ? {
              available: rudderBrowserPiExtensionPath.schemaFallbackReason === null,
              transport: "pi_extension",
              serverName: RUDDER_BROWSER_MCP_SERVER_NAME,
              toolCount: rudderBrowserPiExtensionPath.configuredToolCount,
              toolNames: rudderBrowserPiExtensionPath.toolNames,
              provenance: rudderBrowserPiExtensionPath.rudderMcpPreflight.provenance,
              version: rudderBrowserPiExtensionPath.rudderMcpPreflight.version,
              diagnosticCode: rudderBrowserPiExtensionPath.rudderMcpPreflight.diagnosticCode,
              authMode: "runtime_managed",
              modelVisibleCliFallback: false,
              fallbackReason: rudderBrowserPiExtensionPath.schemaFallbackReason,
            }
          : {
              available: false,
              transport: "pi_extension",
              serverName: RUDDER_BROWSER_MCP_SERVER_NAME,
              toolCount: 0,
              toolNames: [],
              provenance: attemptedBrowserPiExtension?.rudderMcpPreflight.provenance ?? null,
              version: attemptedBrowserPiExtension?.rudderMcpPreflight.version ?? null,
              diagnosticCode: attemptedBrowserPiExtension?.rudderMcpPreflight.diagnosticCode ?? null,
              authMode: "runtime_managed",
              modelVisibleCliFallback: false,
              fallbackReason: attemptedBrowserPiExtension?.rudderMcpPreflight.diagnostic
                ?? "Rudder Browser is disabled for this run.",
            },
        context,
      });
    }

    let sawAssistantText = false;
    let stoppedAfterTerminalText = false;
    const terminalStopController = new AbortController();
    const abortSignals: AbortSignal[] = [
      ctx.abortSignal,
      terminalStopController.signal,
    ].filter((signal): signal is AbortSignal => Boolean(signal));
    const combinedAbortSignal = abortSignals.length > 0
      ? AbortSignal.any(abortSignals)
      : undefined;

    // Buffer stdout by lines to handle partial JSON chunks
    let stdoutBuffer = "";
    const bufferedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
      if (stream === "stderr") {
        // Pass stderr through immediately (not JSONL)
        await onLog(stream, chunk);
        return;
      }
      
      // Buffer stdout and emit only complete lines
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      // Keep the last (potentially incomplete) line in the buffer
      stdoutBuffer = lines.pop() || "";
      
      // Emit complete lines
      for (const line of lines) {
        if (line) {
          const sanitizedLine = sanitizePiStdoutLine(line);
          const parsedLine = sanitizedLine ? parsePiJsonlLine(sanitizedLine) : null;
          if (parsedLine?.type === "assistantText" && parsedLine.text.trim().length > 0) {
            sawAssistantText = true;
          }
          if (
            parsedLine?.type === "turnEnd" &&
            sawAssistantText &&
            parsedLine.stopReason !== "toolUse" &&
            !terminalStopController.signal.aborted
          ) {
            stoppedAfterTerminalText = true;
            terminalStopController.abort();
          }
          if (sanitizedLine) await onLog(stream, `${sanitizedLine}\n`);
        }
      }
    };

    const proc = await runChildProcess(runId, command, processArgs, {
      cwd,
      env: runtimeEnv,
      timeoutSec,
      graceSec,
      onSpawn,
      abortSignal: combinedAbortSignal,
      onLog: bufferedOnLog,
    });
    
    // Flush any remaining buffer content
    if (stdoutBuffer) {
      const sanitizedLine = sanitizePiStdoutLine(stdoutBuffer);
      if (sanitizedLine) await onLog("stdout", sanitizedLine);
    }
    
    return {
      proc: stoppedAfterTerminalText && !proc.timedOut && proc.signal === "SIGTERM"
        ? { ...proc, exitCode: 0, signal: null }
        : proc,
      rawStderr: proc.stderr,
      parsed: parsePiJsonl(proc.stdout),
    };
  };

  const toResult = (
    attempt: {
      proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string };
      rawStderr: string;
      parsed: ReturnType<typeof parsePiJsonl>;
    },
    clearSessionOnMissingSession = false,
  ): AgentRuntimeExecutionResult => {
    if (attempt.proc.timedOut) {
      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        clearSession: clearSessionOnMissingSession,
      };
    }

    const resolvedSessionId = clearSessionOnMissingSession ? null : sessionPath;
    const resolvedSessionParams = resolvedSessionId
      ? { sessionId: resolvedSessionId, cwd }
      : null;

    const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
    const rawExitCode = attempt.proc.exitCode;
    const parsedError = attempt.parsed.errors.find((message) => message.trim().length > 0)?.trim() ?? "";
    const fallbackErrorMessage = parsedError || stderrLine || `Pi exited with code ${rawExitCode ?? -1}`;
    const hasSemanticError = parsedError.length > 0;
    const failed = (rawExitCode ?? 0) !== 0 || hasSemanticError;
    const authRequired = failed && isPiAuthRequiredEvidence(parsedError, attempt.proc.stderr);
    const networkSuspension = classifyAgentRuntimeNetworkFailure({
      errorCode: authRequired ? "pi_auth_required" : null,
      message: fallbackErrorMessage,
      stdout: attempt.proc.stdout,
      stderr: attempt.rawStderr,
      provider,
      model,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      modelOutputObserved: attempt.parsed.modelOutputObserved,
      toolActivityObserved: attempt.parsed.toolActivityObserved,
      terminalEventObserved: attempt.parsed.errors.length > 0,
    });

    return {
      exitCode: rawExitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage: (rawExitCode ?? 0) === 0 && !hasSemanticError ? null : fallbackErrorMessage,
      errorCode: authRequired ? "pi_auth_required" : null,
      usage: {
        inputTokens: attempt.parsed.usage.inputTokens,
        outputTokens: attempt.parsed.usage.outputTokens,
        cachedInputTokens: attempt.parsed.usage.cachedInputTokens,
      },
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: provider,
      biller: resolvePiBiller(runtimeEnv, provider),
      model: model,
      billingType: "unknown",
      costUsd: attempt.parsed.usage.costUsd,
      resultJson: {
        stdout: sanitizePiStdout(attempt.proc.stdout),
        stderr: attempt.proc.stderr,
        rawStdoutBytes: Buffer.byteLength(attempt.proc.stdout, "utf8"),
        stdoutSanitized: true,
      },
      summary: attempt.parsed.finalMessage ?? attempt.parsed.messages.join("\n\n").trim(),
      clearSession: Boolean(clearSessionOnMissingSession),
      ...(networkSuspension ? { networkSuspension } : {}),
    };
  };

  const initial = await runAttempt(sessionPath);
  const initialFailed =
    !initial.proc.timedOut && ((initial.proc.exitCode ?? 0) !== 0 || initial.parsed.errors.length > 0);
  
  if (
    canResumeSession &&
    initialFailed &&
    isPiUnknownSessionError(initial.proc.stdout, initial.rawStderr)
  ) {
    await onLog(
      "stdout",
      `[rudder] Pi session "${runtimeSessionId}" is unavailable; retrying with a fresh session.\n`,
    );
    const newSessionPath = buildSessionPath(sessionsDir, agent.id, new Date().toISOString());
    try {
      await fs.writeFile(newSessionPath, "", { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }
    const retry = await runAttempt(newSessionPath);
    return toResult(retry, true);
  }

  return toResult(initial);
}
