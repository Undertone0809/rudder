import {
  RUDDER_MCP_MANAGED_ENV_KEYS,
  RUDDER_MCP_SERVER_NAME,
  applyRudderBrowserCapabilityEnv,
  inferOpenAiCompatibleBiller,
  pickRudderMcpManagedEnv,
  rudderMcpRuntimeMetadata,
  type AgentRuntimeExecutionContext,
  type AgentRuntimeExecutionResult,
  type RudderMcpManagedEnv,
} from "@rudderhq/agent-runtime-utils";
import { applyGitCredentialHelperPolicyEnv, applyGitIdentityPreparationEnv, ensureGitIdentityFileConfig } from "@rudderhq/agent-runtime-utils/git-identity";
import {
  assertRudderMcpCoreAvailable,
  preflightRudderMcpServer,
} from "@rudderhq/agent-runtime-utils/rudder-mcp-preflight";
import { resolveRudderMcpCliCommand } from "@rudderhq/agent-runtime-utils/rudder-mcp-server";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildRudderEnv,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  ensureRudderCliInPath,
  ensureRudderSkillSymlink,
  joinPromptSections,
  loadAgentInstructionsPrefix,
  parseObject,
  prepareAgentInstructionRuntimeContext,
  pruneLegacyLocalCliCredentialHomeEntries,
  readRudderRuntimeSkillEntries,
  redactEnvForLogs,
  removeUnselectedRudderSkillSymlinks,
  renderTemplate,
  resolveLocalOperatorHome,
  resolveRudderDesiredSkillNames,
  runChildProcess,
  selectPromptTemplate,
  shouldIncludeRuntimeHeartbeatInstructions,
} from "@rudderhq/agent-runtime-utils/server-utils";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateOpenCodeModelConfig } from "./models.js";
import { isOpenCodeUnknownSessionError, parseOpenCodeJsonl, parseOpenCodeJsonlLine } from "./parse.js";
import { resolveManagedOpenCodeHomeDir } from "./skills.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const OPENCODE_PROTECTED_ENV_KEYS = new Set([
  "AGENT_HOME",
  "HOME",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_CLAUDE_CODE_PROMPT",
  "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
  ...RUDDER_MCP_MANAGED_ENV_KEYS,
  "RUDDER_DESKTOP_CLI_ENTRY",
  "RUDDER_AGENT_ROOT",
  "RUDDER_OPERATOR_HOME",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);
const OPENCODE_INHERITED_ENV_BLOCKLIST = new Set([
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG_DIR",
]);
const SHARED_OPENCODE_HOME_ENTRIES = [
  ".local/share/opencode",
  ".cache/opencode",
] as const;
const OPENCODE_CONFIG_FILE_CANDIDATES = ["opencode.json", "opencode.jsonc"] as const;
const MANAGED_OPENCODE_CONFIG_FILE = "opencode.json";
const OPENCODE_PROMPT_FILE_MESSAGE = "Follow the attached Rudder runtime prompt file exactly.";
const CHAT_MODE_DEFAULT_TIMEOUT_SEC = 60;
const DEFAULT_STARTUP_IDLE_TIMEOUT_SEC = 90;
const DEFAULT_TOOL_LOOP_IDLE_TIMEOUT_SEC = 90;
const SAFE_OPENCODE_STRING_CONFIG_KEYS = [
  "$schema",
  "model",
  "small_model",
  "theme",
  "username",
] as const;
const UNSAFE_OPENCODE_CONFIG_ENTRIES = [
  "agent",
  "agents",
  "mode",
  "modes",
  "skill",
  "skills",
  "plugin",
  "plugins",
  "tools",
  "command",
  "commands",
  "hooks",
  "mcp",
] as const;
const UNSAFE_OPENCODE_CONFIG_ENTRY_SET = new Set<string>(UNSAFE_OPENCODE_CONFIG_ENTRIES);

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function parseModelProvider(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return null;
  return trimmed.slice(0, trimmed.indexOf("/")).trim() || null;
}

function resolveOpenCodeBiller(env: Record<string, string>, provider: string | null): string {
  return inferOpenAiCompatibleBiller(env, null) ?? provider ?? "unknown";
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

async function removeManagedOpenCodeConfigExtensions(configDir: string) {
  for (const entry of UNSAFE_OPENCODE_CONFIG_ENTRIES) {
    await fs.rm(path.join(configDir, entry), { recursive: true, force: true }).catch(() => {});
  }
  for (const fileName of OPENCODE_CONFIG_FILE_CANDIDATES) {
    if (fileName === MANAGED_OPENCODE_CONFIG_FILE) continue;
    await fs.rm(path.join(configDir, fileName), { force: true }).catch(() => {});
  }
}

function sanitizeOpenCodeConfig(rawConfig: unknown): Record<string, unknown> {
  const source = parseObject(rawConfig);
  const sanitized: Record<string, unknown> = {};
  for (const key of SAFE_OPENCODE_STRING_CONFIG_KEYS) {
    const value = source[key];
    if (typeof value === "string") sanitized[key] = value;
  }
  const provider = sanitizeOpenCodeProviderConfig(source.provider);
  if (provider) sanitized.provider = provider;
  sanitized.autoupdate = false;
  if (typeof sanitized.$schema !== "string") {
    sanitized.$schema = "https://opencode.ai/config.json";
  }
  return sanitized;
}

function sanitizeOpenCodeProviderConfig(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const sanitized = sanitizeOpenCodeProviderValue(value);
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) return null;
  return Object.keys(sanitized).length > 0 ? sanitized as Record<string, unknown> : null;
}

function sanitizeOpenCodeProviderValue(value: unknown): unknown {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeOpenCodeProviderValue(entry))
      .filter((entry) => entry !== undefined);
  }
  if (typeof value !== "object") return undefined;

  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (UNSAFE_OPENCODE_CONFIG_ENTRY_SET.has(key)) continue;
    const next = sanitizeOpenCodeProviderValue(entry);
    if (next !== undefined) sanitized[key] = next;
  }
  return sanitized;
}

async function readOpenCodeConfigFile(sourceHome: string): Promise<Record<string, unknown>> {
  for (const fileName of OPENCODE_CONFIG_FILE_CANDIDATES) {
    const configPath = path.join(sourceHome, ".config", "opencode", fileName);
    const content = await fs.readFile(configPath, "utf8").catch(() => "");
    if (!content.trim()) continue;
    try {
      return sanitizeOpenCodeConfig(JSON.parse(content));
    } catch {
      continue;
    }
  }
  return sanitizeOpenCodeConfig({});
}

export async function resolveRudderOpenCodeMcpConfig(
  managedEnv: RudderMcpManagedEnv = {},
): Promise<Record<string, unknown>> {
  const rudderMcp = await resolveRudderMcpCliCommand(__moduleDir);
  const env = {
    ...(rudderMcp.env ?? {}),
    ...managedEnv,
  };
  return {
    type: "local",
    command: [rudderMcp.command, ...rudderMcp.args],
    enabled: true,
    ...(Object.keys(env).length > 0 ? { environment: env } : {}),
  };
}

async function ensureManagedOpenCodeConfig(input: {
  sourceHome: string;
  targetHome: string;
  managedEnv?: RudderMcpManagedEnv;
  onLog: AgentRuntimeExecutionContext["onLog"];
}) {
  const configDir = path.join(input.targetHome, ".config", "opencode");
  const existing = await fs.lstat(configDir).catch(() => null);
  if (existing?.isSymbolicLink()) {
    await fs.unlink(configDir);
  }

  await fs.mkdir(configDir, { recursive: true });
  await removeManagedOpenCodeConfigExtensions(configDir);

  const config = await readOpenCodeConfigFile(input.sourceHome);
  config.mcp = {
    [RUDDER_MCP_SERVER_NAME]: await resolveRudderOpenCodeMcpConfig(input.managedEnv ?? {}),
  };
  await fs.writeFile(
    path.join(configDir, MANAGED_OPENCODE_CONFIG_FILE),
    `${JSON.stringify(config, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.chmod(path.join(configDir, MANAGED_OPENCODE_CONFIG_FILE), 0o600);
  await input.onLog(
    "stdout",
    `[rudder] Wrote sanitized OpenCode config into adapter-managed runtime state ${configDir}.\n`,
  );
}

function resolveSharedOpenCodeHomeDir(env: NodeJS.ProcessEnv): string {
  return path.resolve(nonEmpty(env.HOME) ?? os.homedir());
}

function resolveManagedOpenCodeSkillsDir(homeDir: string): string {
  return path.join(homeDir, ".claude", "skills");
}

async function prepareManagedOpenCodeHome(
  env: NodeJS.ProcessEnv,
  operatorHome: string,
  onLog: AgentRuntimeExecutionContext["onLog"],
  orgId: string,
  managedEnv: RudderMcpManagedEnv = {},
): Promise<string> {
  const sourceHome = path.resolve(operatorHome);
  const targetHome = resolveManagedOpenCodeHomeDir({ env }, orgId);
  if (targetHome === sourceHome) return targetHome;

  await fs.mkdir(targetHome, { recursive: true });
  await pruneLegacyLocalCliCredentialHomeEntries({ targetHome, onLog });
  await fs.mkdir(resolveManagedOpenCodeSkillsDir(targetHome), { recursive: true });

  for (const relativeEntry of SHARED_OPENCODE_HOME_ENTRIES) {
    const source = path.join(sourceHome, relativeEntry);
    if (!(await pathExists(source))) continue;
    await ensureSymlink(path.join(targetHome, relativeEntry), source);
  }
  await ensureManagedOpenCodeConfig({ sourceHome, targetHome, managedEnv, onLog });

  await onLog(
    "stdout",
    `[rudder] Using adapter-managed OpenCode runtime state "${targetHome}" with operator HOME "${sourceHome}".\n`,
  );
  return targetHome;
}

async function ensureOpenCodeSkillsInjected(
  onLog: AgentRuntimeExecutionContext["onLog"],
  skillsHome: string,
  skillsEntries: Array<{ key: string; runtimeName: string; source: string }>,
  desiredSkillNames?: string[],
) {
  await fs.mkdir(skillsHome, { recursive: true });
  const desiredSet = new Set(desiredSkillNames ?? skillsEntries.map((entry) => entry.key));
  const selectedEntries = skillsEntries.filter((entry) => desiredSet.has(entry.key));
  const removedSkills = await removeUnselectedRudderSkillSymlinks(
    skillsHome,
    selectedEntries.map((entry) => entry.runtimeName),
    skillsEntries.map((entry) => entry.source),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[rudder] Removed maintainer-only OpenCode skill "${skillName}" from ${skillsHome}\n`,
    );
  }
  for (const entry of selectedEntries) {
    const target = path.join(skillsHome, entry.runtimeName);

    try {
      const result = await ensureRudderSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[rudder] ${result === "repaired" ? "Repaired" : "Injected"} OpenCode skill "${entry.key}" into ${skillsHome}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[rudder] Failed to inject OpenCode skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

async function renderSelectedOpenCodeSkillPrompt(
  onLog: AgentRuntimeExecutionContext["onLog"],
  skillsHome: string,
  skillsEntries: Array<{ key: string; runtimeName: string }>,
): Promise<string> {
  const sections: string[] = [];
  for (const entry of skillsEntries) {
    const skillPath = path.join(skillsHome, entry.runtimeName, "SKILL.md");
    const content = await fs.readFile(skillPath, "utf8").catch(async (err) => {
      await onLog(
        "stderr",
        `[rudder] Failed to load OpenCode skill "${entry.key}" from ${skillPath}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return "";
    });
    if (!content.trim()) continue;
    sections.push(`## Skill: ${entry.key}\n\n${content.trim()}`);
  }
  if (sections.length === 0) return "";
  return [
    "# Enabled Rudder Skills",
    "",
    "Rudder is the source of truth for runtime skill enablement.",
    "Only skills listed in this section are enabled by Rudder for this run. OpenCode built-in/provider-native skills, Claude-compatible operator-home skills, project skills, host-global skills, bundled skills, vendor-default skills, and the current OpenCode client session may expose other capabilities, but they are not Rudder-enabled skills and must not be described as this agent's Rudder skills unless listed here.",
    "When the user asks what skills are enabled, loaded, available, or what skills you have in Rudder, answer with only the runtime skill names listed in this section. Use a plain newline-separated list. Do not use prose, bullets, Markdown, code spans, explanations, prefixes, or suffixes. If exactly one skill is listed, answer exactly that runtime skill name and nothing else. Do not list, summarize, or explain provider-native OpenCode skills, operator-home skills, project skills, host-global skills, bundled skills, vendor-default skills, or current-session capabilities in that answer.",
    "",
    sections.join("\n\n"),
  ].join("\n");
}

export async function execute(ctx: AgentRuntimeExecutionContext): Promise<AgentRuntimeExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = selectPromptTemplate(
    asString(config.promptTemplate, ""),
    context,
  );
  const command = asString(config.command, "opencode");
  const model = asString(config.model, "").trim();
  const variant = asString(config.variant, "").trim();
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, false);

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
  const env: Record<string, string> = { ...buildRudderEnv(agent) };
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
  if (effectiveWorkspaceCwd) env.RUDDER_WORKSPACE_CWD = effectiveWorkspaceCwd;
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
    if (OPENCODE_PROTECTED_ENV_KEYS.has(key)) continue;
    if (typeof value === "string") env[key] = value;
  }
  let browserEnabled = applyRudderBrowserCapabilityEnv(env, config);
  const sourceEnv = { ...process.env };
  const operatorHome = resolveLocalOperatorHome(sourceEnv);
  if (authToken) env.RUDDER_API_KEY = authToken;
  const managedHome = await prepareManagedOpenCodeHome(
    { ...sourceEnv, ...env },
    operatorHome,
    onLog,
    agent.orgId,
    pickRudderMcpManagedEnv(env),
  );
  const preparedGitIdentity = await ensureGitIdentityFileConfig({
    cwd,
    home: managedHome,
    sourceEnv,
    onLog,
  });
  env.HOME = operatorHome;
  env.USERPROFILE = operatorHome;
  env.OPENCODE_CONFIG = path.join(managedHome, ".config", "opencode", MANAGED_OPENCODE_CONFIG_FILE);
  env.OPENCODE_DISABLE_CLAUDE_CODE = "true";
  env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT = "true";
  env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "true";
  env.RUDDER_OPERATOR_HOME = operatorHome;
  env.XDG_CONFIG_HOME = path.join(managedHome, ".config");
  env.XDG_DATA_HOME = path.join(managedHome, ".local", "share");
  env.XDG_CACHE_HOME = path.join(managedHome, ".cache");
  applyGitIdentityPreparationEnv(env, preparedGitIdentity);
  applyGitCredentialHelperPolicyEnv(env);
  const openCodeSkillEntries = await readRudderRuntimeSkillEntries(config, __moduleDir);
  const desiredOpenCodeSkillNames = resolveRudderDesiredSkillNames(config, openCodeSkillEntries);
  const isChatResultRepair = context.rudderChatResultRepair === true;
  const selectedOpenCodeSkillEntries = isChatResultRepair
    ? []
    : openCodeSkillEntries.filter((entry) => desiredOpenCodeSkillNames.includes(entry.key));
  const loadedSkills = openCodeSkillEntries
    .filter((entry) => desiredOpenCodeSkillNames.includes(entry.key))
    .map((entry) => ({
      key: entry.key,
      runtimeName: entry.runtimeName,
      name: entry.name ?? null,
      description: entry.description ?? null,
    }));
  const managedOpenCodeSkillsDir = resolveManagedOpenCodeSkillsDir(managedHome);
  await ensureOpenCodeSkillsInjected(
    onLog,
    managedOpenCodeSkillsDir,
    openCodeSkillEntries,
    desiredOpenCodeSkillNames,
  );
  const selectedSkillPrompt = await renderSelectedOpenCodeSkillPrompt(
    onLog,
    managedOpenCodeSkillsDir,
    selectedOpenCodeSkillEntries,
  );
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv(await ensureRudderCliInPath(__moduleDir, { ...process.env, ...env })))
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  for (const key of OPENCODE_INHERITED_ENV_BLOCKLIST) {
    delete runtimeEnv[key];
  }
  for (const key of RUDDER_MCP_MANAGED_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) runtimeEnv[key] = value;
    else delete runtimeEnv[key];
  }
  const rudderMcpPreflight = await preflightRudderMcpServer({
    command: await resolveRudderMcpCliCommand(__moduleDir),
    runtimeEnv,
    managedEnv: pickRudderMcpManagedEnv(env),
    browserEnabled,
  });
  assertRudderMcpCoreAvailable(rudderMcpPreflight);
  delete runtimeEnv.RUDDER_DESKTOP_CLI_ENTRY;
  delete runtimeEnv.RUDDER_MCP_RUDDER_BIN;
  if (browserEnabled && !rudderMcpPreflight?.browserAvailable) {
    browserEnabled = false;
    env.RUDDER_BROWSER_ENABLED = "false";
    runtimeEnv.RUDDER_BROWSER_ENABLED = "false";
    await onLog("stderr", `[rudder] ${rudderMcpPreflight?.diagnostic}\n`);
  }
  await ensureManagedOpenCodeConfig({
    sourceHome: operatorHome,
    targetHome: managedHome,
    managedEnv: pickRudderMcpManagedEnv(env),
    onLog,
  });
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  validateOpenCodeModelConfig({ model });

  const configuredTimeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[rudder] OpenCode session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
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
  const instructionsPrefix = loadedInstructions.prefix;
  const instructionsDir = loadedInstructions.instructionsDir;

  const commandNotes = (() => {
    const rudderMcpNote = "Configured first-party Rudder MCP tools for OpenCode.";
    if (!resolvedInstructionsFilePath) {
      return [
        ...loadedInstructions.commandNotes,
        rudderMcpNote,
        "Prepended Rudder operating contract to stdin prompt.",
      ];
    }
    if (instructionsPrefix.length > 0) {
      return [
        ...loadedInstructions.commandNotes,
        rudderMcpNote,
        `Prepended instructions + path directive to stdin prompt (relative references from ${instructionsDir}).`,
      ];
    }
    return [
      ...loadedInstructions.commandNotes,
      rudderMcpNote,
    ];
  })();

  /**
   * Final prompt assembly order is intentional and shared across runtimes:
   * 1) optional injected instructions prefix,
   * 2) optional bootstrap prompt (only when not resuming a prior session),
   * 3) optional session handoff markdown,
   * 4) heartbeat prompt selected by wake trigger (assignment, mention, retry, fallback).
   *
   * Prompt example (assignment wakeup):
   * [instructions prefix]
   * [bootstrap prompt]
   * [session handoff note]
   * You are agent agent-123 (Frontend Maintainer). You have been assigned to work on an issue.
   * Issue: "Fix onboarding redirect"
   *
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
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const renderedBootstrapPrompt =
    !sessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const sessionHandoffNote = asString(context.rudderSessionHandoffMarkdown, "").trim();
  const prompt = joinPromptSections([
    instructionsPrefix,
    selectedSkillPrompt,
    renderedBootstrapPrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    ...loadedInstructions.metrics,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };
  const runtimeTmpDir = path.join(managedHome, "runtime-tmp", runId);
  await fs.mkdir(runtimeTmpDir, { recursive: true });
  const promptFilePath = path.join(runtimeTmpDir, "rudder-prompt.md");
  await fs.writeFile(promptFilePath, prompt, "utf8");
  const useStdinPrompt = context.chatMode === true;
  const hasChatModeTimeoutFallback = useStdinPrompt && configuredTimeoutSec <= 0;
  const timeoutSec = hasChatModeTimeoutFallback
    ? CHAT_MODE_DEFAULT_TIMEOUT_SEC
    : configuredTimeoutSec;
  const toolLoopIdleTimeoutSec = Math.max(
    1,
    asNumber(config.toolLoopIdleTimeoutSec, asNumber(env.RUDDER_OPENCODE_TOOL_LOOP_IDLE_TIMEOUT_SEC, DEFAULT_TOOL_LOOP_IDLE_TIMEOUT_SEC)),
  );
  const startupIdleTimeoutSec = Math.max(
    1,
    asNumber(config.startupIdleTimeoutSec, asNumber(env.RUDDER_OPENCODE_STARTUP_IDLE_TIMEOUT_SEC, DEFAULT_STARTUP_IDLE_TIMEOUT_SEC)),
  );
  const effectiveCommandNotes = hasChatModeTimeoutFallback
    ? [
        ...commandNotes,
        `Applied ${CHAT_MODE_DEFAULT_TIMEOUT_SEC}s default timeout for OpenCode chat mode because timeoutSec was unset.`,
      ]
    : commandNotes;

  const buildArgs = (resumeSessionId: string | null, redactPromptFile: boolean) => {
    const args = ["run", "--pure", "--format", "json", "--dir", cwd];
    if (!useStdinPrompt) args.push(OPENCODE_PROMPT_FILE_MESSAGE);
    if (resumeSessionId) args.push("--session", resumeSessionId);
    if (model) args.push("--model", model);
    if (variant) args.push("--variant", variant);
    if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
    if (extraArgs.length > 0) args.push(...extraArgs);
    if (!useStdinPrompt) {
      args.push("--file", redactPromptFile ? `<rudder prompt file ${prompt.length} chars>` : promptFilePath);
    }
    return args;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildArgs(resumeSessionId, false);
    if (onMeta) {
      await onMeta({
        agentRuntimeType: "opencode_local",
        command,
        cwd,
        commandNotes: effectiveCommandNotes,
        commandArgs: buildArgs(resumeSessionId, true),
        env: redactEnvForLogs(env),
        prompt,
        agentInstructionStack: prompt,
        promptMetrics,
        loadedSkills,
        realizedSkills: loadedSkills,
        promptInjectedSkills: loadedSkills,
        rudderMcp: rudderMcpRuntimeMetadata({ browserEnabled, preflight: rudderMcpPreflight }),
        context,
      });
    }

    let stdoutBuffer = "";
    let sawTerminalContent = false;
    let sawTerminalCompletionSummary = false;
    let stoppedAfterTerminalText = false;
    let stoppedAfterToolLoopIdle = false;
    let stoppedAfterStartupIdle = false;
    const terminalStopController = new AbortController();
    let startupIdleTimer: ReturnType<typeof setTimeout> | null = null;
    let toolLoopIdleTimer: ReturnType<typeof setTimeout> | null = null;
    const clearStartupIdleTimer = () => {
      if (!startupIdleTimer) return;
      clearTimeout(startupIdleTimer);
      startupIdleTimer = null;
    };
    const clearToolLoopIdleTimer = () => {
      if (!toolLoopIdleTimer) return;
      clearTimeout(toolLoopIdleTimer);
      toolLoopIdleTimer = null;
    };
    const armToolLoopIdleTimer = () => {
      clearToolLoopIdleTimer();
      toolLoopIdleTimer = setTimeout(() => {
        stoppedAfterToolLoopIdle = true;
        if (!terminalStopController.signal.aborted) terminalStopController.abort();
      }, toolLoopIdleTimeoutSec * 1000);
    };
    startupIdleTimer = setTimeout(() => {
      stoppedAfterStartupIdle = true;
      if (!terminalStopController.signal.aborted) terminalStopController.abort();
    }, startupIdleTimeoutSec * 1000);
    const abortSignals: AbortSignal[] = [
      ctx.abortSignal,
      terminalStopController.signal,
    ].filter((signal): signal is AbortSignal => Boolean(signal));
    const combinedAbortSignal = abortSignals.length > 0
      ? AbortSignal.any(abortSignals)
      : undefined;
    const bufferedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
      if (stream !== "stdout") {
        await onLog(stream, chunk);
        return;
      }

      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsedLine = parseOpenCodeJsonlLine(line.trim());
        if (parsedLine) clearStartupIdleTimer();
        if (parsedLine?.type === "assistantText" && parsedLine.text.trim().length > 0) {
          sawTerminalContent = true;
        }
        const sawCompletionSummary =
          parsedLine?.type === "syntheticText" &&
          parsedLine.completion &&
          parsedLine.text.trim().length > 0;
        if (parsedLine && parsedLine.type !== "other") clearToolLoopIdleTimer();
        if (sawCompletionSummary) {
          sawTerminalCompletionSummary = true;
        }
        if (parsedLine?.type === "toolCallsStepFinish") {
          armToolLoopIdleTimer();
        }
        if (parsedLine?.type === "terminalStop" && sawTerminalContent && !terminalStopController.signal.aborted) {
          stoppedAfterTerminalText = true;
          terminalStopController.abort();
        }
        if (parsedLine?.type === "terminalStop" && sawTerminalCompletionSummary && !terminalStopController.signal.aborted) {
          stoppedAfterTerminalText = true;
          terminalStopController.abort();
        }
      }
      await onLog(stream, chunk);
    };

    const proc = await runChildProcess(runId, command, args, {
        cwd,
        env: runtimeEnv,
        timeoutSec,
        graceSec,
        stdin: useStdinPrompt ? prompt : undefined,
        onSpawn,
        abortSignal: combinedAbortSignal,
        onLog: bufferedOnLog,
      })
      .finally(() => {
        clearStartupIdleTimer();
        clearToolLoopIdleTimer();
      });
    return {
      proc: stoppedAfterTerminalText && !proc.timedOut && proc.signal === "SIGTERM"
        ? { ...proc, exitCode: 0, signal: null }
        : proc,
      rawStderr: proc.stderr,
      parsed: parseOpenCodeJsonl(proc.stdout),
      stoppedAfterTerminalText,
      stoppedAfterToolLoopIdle,
      stoppedAfterStartupIdle,
    };
  };

  const toResult = (
    attempt: {
      proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string };
      rawStderr: string;
      parsed: ReturnType<typeof parseOpenCodeJsonl>;
      stoppedAfterToolLoopIdle?: boolean;
      stoppedAfterStartupIdle?: boolean;
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

    const resolvedSessionId =
      attempt.parsed.sessionId ??
      (clearSessionOnMissingSession ? null : runtimeSessionId ?? runtime.sessionId ?? null);
    const resolvedSessionParams = resolvedSessionId
      ? ({
          sessionId: resolvedSessionId,
          cwd,
          ...(workspaceId ? { workspaceId } : {}),
          ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
          ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
        } as Record<string, unknown>)
      : null;

    const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
    const rawExitCode = attempt.proc.exitCode;
    const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
    const parsedSummary = attempt.parsed.summary.trim() || attempt.parsed.completionSummary?.trim() || "";
    const startupIdle = attempt.stoppedAfterStartupIdle === true;
    const toolLoopIdle = attempt.stoppedAfterToolLoopIdle === true;
    const missingFinalSummary =
      !parsedError &&
      !startupIdle &&
      !toolLoopIdle &&
      (rawExitCode ?? 0) === 0 &&
      parsedSummary.length === 0;
    const synthesizedExitCode =
      (parsedError || missingFinalSummary || startupIdle || toolLoopIdle) && (rawExitCode ?? 0) === 0 ? 1 : rawExitCode;
    const fallbackErrorMessage =
      parsedError ||
      (startupIdle
        ? `OpenCode stopped after ${startupIdleTimeoutSec}s without emitting JSON output.`
        : "") ||
      (toolLoopIdle
        ? `OpenCode stopped after ${toolLoopIdleTimeoutSec}s without continuing after a Rudder tool-call step.`
        : "") ||
      (missingFinalSummary
        ? "OpenCode completed without a final text summary; Rudder requires final text to persist a trustworthy run result."
        : "") ||
      stderrLine ||
      `OpenCode exited with code ${synthesizedExitCode ?? -1}`;
    const modelId = model || null;

    return {
      exitCode: synthesizedExitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage: (synthesizedExitCode ?? 0) === 0 ? null : fallbackErrorMessage,
      errorCode: startupIdle ? "opencode_startup_idle" : toolLoopIdle ? "opencode_tool_loop_idle" : null,
      usage: {
        inputTokens: attempt.parsed.usage.inputTokens,
        outputTokens: attempt.parsed.usage.outputTokens,
        cachedInputTokens: attempt.parsed.usage.cachedInputTokens,
      },
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: parseModelProvider(modelId),
      biller: resolveOpenCodeBiller(runtimeEnv, parseModelProvider(modelId)),
      model: modelId,
      billingType: "unknown",
      costUsd: attempt.parsed.costUsd,
      resultJson: {
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
        ...(missingFinalSummary ? { summaryStatus: "missing_final_text" } : {}),
        ...(startupIdle ? { summaryStatus: "startup_idle", stoppedAfterStartupIdle: true } : {}),
        ...(toolLoopIdle ? { summaryStatus: "tool_loop_idle", stoppedAfterToolLoopIdle: true } : {}),
      },
      summary: parsedSummary || ((synthesizedExitCode ?? 0) === 0 ? "" : fallbackErrorMessage),
      clearSession: Boolean(clearSessionOnMissingSession && !attempt.parsed.sessionId),
    };
  };

  const initial = await runAttempt(sessionId);
  const initialFailed =
    !initial.proc.timedOut && ((initial.proc.exitCode ?? 0) !== 0 || Boolean(initial.parsed.errorMessage));
  if (
    sessionId &&
    initialFailed &&
    isOpenCodeUnknownSessionError(initial.proc.stdout, initial.rawStderr)
  ) {
    await onLog(
      "stdout",
      `[rudder] OpenCode session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
    );
    const retry = await runAttempt(null);
    return toResult(retry, true);
  }

  return toResult(initial);
}
