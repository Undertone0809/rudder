import { inferOpenAiCompatibleBiller, type AgentRuntimeExecutionContext, type AgentRuntimeExecutionResult } from "@rudderhq/agent-runtime-utils";
import { applyGitCredentialHelperPolicyEnv, applyGitIdentityPreparationEnv, ensureGitIdentityFileConfig } from "@rudderhq/agent-runtime-utils/git-identity";
import {
  asNumber,
  asString,
  asStringArray,
  buildRudderEnv,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensureLocalCliCredentialShimsInPath,
  ensurePathInEnv,
  ensureRudderCliInPath,
  ensureRudderSkillSymlink,
  joinPromptSections,
  loadAgentInstructionsPrefix,
  parseJson,
  parseObject,
  prepareAgentInstructionRuntimeContext,
  readRudderRuntimeSkillEntries,
  redactEnvForLogs,
  removeMaintainerOnlySkillSymlinks,
  renderTemplate,
  resolveLocalOperatorHome,
  resolveRudderDesiredSkillNames,
  runChildProcess,
  selectPromptTemplate,
  shouldIncludeRuntimeHeartbeatInstructions,
  syncLocalCliCredentialHomeEntries,
} from "@rudderhq/agent-runtime-utils/server-utils";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePiModelConfiguredAndAvailable } from "./models.js";
import { isPiUnknownSessionError, parsePiJsonl } from "./parse.js";
import { resolveManagedPiHomeDir } from "./skills.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const MAX_PI_LOG_TEXT_CHARS = 4_000;
const MAX_PI_RESULT_STDOUT_BYTES = 64 * 1024;
const PI_PROTECTED_ENV_KEYS = new Set([
  "AGENT_HOME",
  "HOME",
  "RUDDER_AGENT_ROOT",
  "RUDDER_OPERATOR_HOME",
  "USERPROFILE",
]);

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
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
    return truncateText(trimmed);
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

function parseModelProvider(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return null;
  return trimmed.slice(0, trimmed.indexOf("/")).trim() || null;
}

function parseModelId(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return trimmed || null;
  return trimmed.slice(trimmed.indexOf("/") + 1).trim() || null;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

async function ensureParentDir(target: string) {
  await fs.mkdir(path.dirname(target), { recursive: true });
}

async function ensureSymlink(target: string, source: string) {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await ensureParentDir(target);
    await fs.symlink(source, target);
    return;
  }
  if (!existing.isSymbolicLink()) return;

  const linkedPath = await fs.readlink(target).catch(() => null);
  const resolvedLinkedPath = linkedPath ? path.resolve(path.dirname(target), linkedPath) : null;
  if (resolvedLinkedPath === source) return;
  await fs.unlink(target);
  await fs.symlink(source, target);
}

function resolveSharedPiHomeDir(env: NodeJS.ProcessEnv): string {
  return path.resolve(nonEmpty(env.HOME) ?? os.homedir());
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

async function syncPiSharedHomeEntries(sourceHome: string, targetHome: string) {
  const sourcePiDir = resolvePiRoot(sourceHome);
  const targetPiDir = resolvePiRoot(targetHome);
  await fs.mkdir(targetPiDir, { recursive: true });

  const topEntries = await fs.readdir(sourcePiDir, { withFileTypes: true }).catch(() => []);
  for (const entry of topEntries) {
    if (entry.name === "agent" || entry.name === "paperclips") continue;
    await ensureSymlink(
      path.join(targetPiDir, entry.name),
      path.join(sourcePiDir, entry.name),
    );
  }

  const sourceAgentDir = path.join(sourcePiDir, "agent");
  if (!(await pathExists(sourceAgentDir))) return;
  const targetAgentDir = path.join(targetPiDir, "agent");
  await fs.mkdir(targetAgentDir, { recursive: true });
  const agentEntries = await fs.readdir(sourceAgentDir, { withFileTypes: true }).catch(() => []);
  for (const entry of agentEntries) {
    if (entry.name === "skills") continue;
    await ensureSymlink(
      path.join(targetAgentDir, entry.name),
      path.join(sourceAgentDir, entry.name),
    );
  }
}

async function prepareManagedPiHome(
  env: NodeJS.ProcessEnv,
  onLog: AgentRuntimeExecutionContext["onLog"],
  orgId: string,
): Promise<string> {
  const sourceHome = resolveSharedPiHomeDir(env);
  const targetHome = resolveManagedPiHomeDir({ env }, orgId);
  if (targetHome === sourceHome) return targetHome;

  await fs.mkdir(resolvePiSkillsDir(targetHome), { recursive: true });
  await fs.mkdir(resolvePiSessionsDir(targetHome), { recursive: true });
  if (await pathExists(resolvePiRoot(sourceHome))) {
    await syncPiSharedHomeEntries(sourceHome, targetHome);
  }

  await onLog(
    "stdout",
    `[rudder] Using Rudder-managed Pi home "${targetHome}" (seeded from "${sourceHome}").\n`,
  );
  return targetHome;
}

async function ensurePiSkillsInjected(
  onLog: AgentRuntimeExecutionContext["onLog"],
  skillsEntries: Array<{ key: string; runtimeName: string; source: string }>,
  skillsDir: string,
  desiredSkillNames?: string[],
) {
  const desiredSet = new Set(desiredSkillNames ?? skillsEntries.map((entry) => entry.key));
  const selectedEntries = skillsEntries.filter((entry) => desiredSet.has(entry.key));
  if (selectedEntries.length === 0) return;
  await fs.mkdir(skillsDir, { recursive: true });
  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    skillsDir,
    selectedEntries.map((entry) => entry.runtimeName),
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

  const promptTemplate = selectPromptTemplate(
    asString(config.promptTemplate, ""),
    context,
  );
  const command = asString(config.command, "pi");
  const model = asString(config.model, "").trim();
  const thinking = asString(config.thinking, "").trim();

  // Parse model into provider and model id
  const provider = parseModelProvider(model);
  const modelId = parseModelId(model);

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
  const managedHome = await prepareManagedPiHome({ ...sourceEnv, ...envConfigStrings }, onLog, agent.orgId);
  await syncLocalCliCredentialHomeEntries({ sourceHome: operatorHome, targetHome: managedHome, onLog });
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
  await ensurePiSkillsInjected(onLog, piSkillEntries, skillsDir, desiredPiSkillNames);

  // Build environment
  const hasExplicitApiKey =
    typeof envConfig.RUDDER_API_KEY === "string" && envConfig.RUDDER_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildRudderEnv(agent) };
  env.HOME = operatorHome;
  env.USERPROFILE = process.env.USERPROFILE ?? operatorHome;
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
  env.HOME = operatorHome;
  env.USERPROFILE = process.env.USERPROFILE ?? operatorHome;
  env.PI_CODING_AGENT_DIR = path.join(managedHome, ".pi", "agent");
  env.PI_CODING_AGENT_SESSION_DIR = sessionsDir;
  env.RUDDER_OPERATOR_HOME = operatorHome;
  if (!hasExplicitApiKey && authToken) {
    env.RUDDER_API_KEY = authToken;
  }
  applyGitIdentityPreparationEnv(env, preparedGitIdentity);
  applyGitCredentialHelperPolicyEnv(env);
  
  const runtimeEnv = Object.fromEntries(
    Object.entries(await ensureLocalCliCredentialShimsInPath({
      operatorHome,
      targetHome: managedHome,
      cwd,
      env: ensurePathInEnv(await ensureRudderCliInPath(__moduleDir, { ...process.env, ...env })),
      onLog,
    })).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
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
    includeHeartbeatInstructions: shouldIncludeRuntimeHeartbeatInstructions(context as Record<string, unknown>),
    contextSectionsBeforeCurrentTime: instructionRuntimeContext.contextSectionsBeforeCurrentTime,
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
   * - doc/DEVELOPING.md
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
  const renderedSystemPromptExtension = renderTemplate(systemPromptExtension, templateData);
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
  const promptMetrics = {
    systemPromptChars: renderedSystemPromptExtension.length,
    promptChars: userPrompt.length,
    ...loadedInstructions.metrics,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedHeartbeatPrompt.length,
  };

  const commandNotes = (() => {
    if (!resolvedInstructionsFilePath) {
      return [
        ...loadedInstructions.commandNotes,
        "Appended Rudder operating contract to system prompt.",
      ];
    }
    if (loadedInstructions.readFailed) return loadedInstructions.commandNotes;
    return [
      ...loadedInstructions.commandNotes,
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

    args.push("--tools", "read,bash,edit,write,grep,find,ls");
    args.push("--session", sessionFile);

    // Add Rudder skills directory so Pi can load the rudder skill
    args.push("--skill", skillsDir);

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
        promptMetrics,
        context,
      });
    }

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
      abortSignal: ctx.abortSignal,
      onLog: bufferedOnLog,
    });
    
    // Flush any remaining buffer content
    if (stdoutBuffer) {
      const sanitizedLine = sanitizePiStdoutLine(stdoutBuffer);
      if (sanitizedLine) await onLog("stdout", sanitizedLine);
    }
    
    return {
      proc,
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
    const fallbackErrorMessage = stderrLine || `Pi exited with code ${rawExitCode ?? -1}`;

    return {
      exitCode: rawExitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage: (rawExitCode ?? 0) === 0 ? null : fallbackErrorMessage,
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
