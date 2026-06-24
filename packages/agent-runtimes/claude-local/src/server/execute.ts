import { resolveOrganizationStorageKey, type AgentRuntimeExecutionContext, type AgentRuntimeExecutionResult } from "@rudderhq/agent-runtime-utils";
import { applyGitCredentialHelperPolicyEnv, applyGitIdentityPreparationEnv, ensureGitIdentityFileConfig } from "@rudderhq/agent-runtime-utils/git-identity";
import type { RunProcessResult } from "@rudderhq/agent-runtime-utils/server-utils";
import {
  asBoolean,
  asNumber,
  asString,
  buildRudderEnv,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensureLocalCliCredentialShimsInPath,
  ensurePathInEnv,
  ensureRudderCliInPath,
  joinPromptSections,
  loadAgentInstructionsPrefix,
  parseJson,
  parseObject,
  prepareAgentInstructionRuntimeContext,
  readRudderRuntimeSkillEntries,
  redactEnvForLogs,
  renderTemplate,
  resolveLocalOperatorHome,
  runChildProcess,
  selectPromptTemplate,
  shouldIncludeRuntimeHeartbeatInstructions,
  syncLocalCliCredentialHomeEntries,
} from "@rudderhq/agent-runtime-utils/server-utils";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  configuredClaudeExtraArgs,
  resolveClaudePermissionMode,
  sanitizeClaudeExtraArgs,
} from "./cli-args.js";
import {
  describeClaudeFailure,
  detectClaudeLoginRequired,
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError,
  parseClaudeStreamJson,
} from "./parse.js";
import { resolveClaudeDesiredSkillNames } from "./skills.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUDDER_INSTANCE_ID = "default";
const CLAUDE_PROTECTED_ENV_KEYS = new Set([
  "AGENT_HOME",
  "HOME",
  "RUDDER_AGENT_ROOT",
  "RUDDER_OPERATOR_HOME",
  "USERPROFILE",
]);
const SHARED_CLAUDE_HOME_ENTRIES = [
  ".config/claude",
  ".config/anthropic",
  ".anthropic",
] as const;
const CLAUDE_SETTINGS_AUTH_ENV_PREFIXES = ["ANTHROPIC_", "DEEPSEEK_"] as const;

/**
 * Create a tmpdir with `.claude/skills/` containing symlinks to skills from
 * the repo's `.agents/skills/` directory, so `--add-dir` makes Claude Code discover
 * them as proper registered skills.
 */
async function buildSkillsDir(config: Record<string, unknown>): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-skills-"));
  const target = path.join(tmp, ".claude", "skills");
  await fs.mkdir(target, { recursive: true });
  const availableEntries = await readRudderRuntimeSkillEntries(config, __moduleDir);
  const desiredNames = new Set(
    resolveClaudeDesiredSkillNames(
      config,
      availableEntries,
    ),
  );
  for (const entry of availableEntries) {
    if (!desiredNames.has(entry.key)) continue;
    await fs.symlink(
      entry.source,
      path.join(target, entry.runtimeName),
    );
  }
  return tmp;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function runtimeImagePaths(media: AgentRuntimeExecutionContext["media"]): string[] {
  return (media ?? [])
    .filter((item) => item.source === "chat_attachment" && item.contentType.toLowerCase().startsWith("image/"))
    .map((item) => item.localPath)
    .filter((value) => value.trim().length > 0);
}

function renderClaudeRudderSkillBoundaryPrompt(
  loadedSkills: Array<{ key: string; runtimeName?: string | null; name?: string | null }>,
): string {
  const skillLines = loadedSkills.length > 0
    ? loadedSkills.map((entry) => {
        const label = entry.name && entry.name !== entry.runtimeName
          ? `${entry.runtimeName ?? entry.key} (${entry.name})`
          : entry.runtimeName ?? entry.key;
        return `- ${label}: ${entry.key}`;
      })
    : ["- None. No optional Rudder skills are enabled for this run."];

  return [
    "# Enabled Rudder Skills",
    "",
    "Rudder is the source of truth for runtime skill enablement.",
    "Only skills listed in this section are enabled by Rudder for this run. Claude Code built-in/provider-native skills or slash commands may appear in Claude's own runtime metadata, but they are not Rudder-enabled skills and must not be described as this agent's Rudder skills unless listed here.",
    "When the user asks what skills are enabled, loaded, or available in Rudder, answer from this section and say provider-native Claude Code skills are separate if relevant.",
    "",
    ...skillLines,
  ].join("\n");
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

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function writeSanitizedClaudeSettings(sourceHome: string, targetHome: string): Promise<string> {
  const sourceSettings = await readJsonObject(path.join(sourceHome, ".claude", "settings.json"));
  const targetSettingsPath = path.join(targetHome, ".claude", "settings.json");
  const sourceEnv = parseObject(sourceSettings?.env);
  const authEnv: Record<string, string> = {};

  for (const [key, value] of Object.entries(sourceEnv)) {
    if (!CLAUDE_SETTINGS_AUTH_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    if (typeof value === "string" && value.trim().length > 0) authEnv[key] = value;
  }

  const sanitized = Object.keys(authEnv).length > 0 ? { env: authEnv } : {};
  await fs.mkdir(path.dirname(targetSettingsPath), { recursive: true });
  await fs.writeFile(targetSettingsPath, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
  return targetSettingsPath;
}

async function resolveClaudeExtraArgs(
  config: Record<string, unknown>,
  onLog: AgentRuntimeExecutionContext["onLog"],
): Promise<string[]> {
  const result = sanitizeClaudeExtraArgs(configuredClaudeExtraArgs(config));
  if (result.removedFlags.length > 0) {
    await onLog?.(
      "stderr",
      `[rudder] Ignored Claude extraArgs that would override Rudder-managed config isolation: ${result.removedFlags.join(", ")}\n`,
    );
  }
  return result.args;
}

function resolveSharedClaudeHomeDir(env: NodeJS.ProcessEnv): string {
  return path.resolve(nonEmpty(env.HOME) ?? os.homedir());
}

function resolveManagedClaudeHomeDir(env: NodeJS.ProcessEnv, orgId: string): string {
  const rudderHome = nonEmpty(env.RUDDER_HOME) ?? path.resolve(os.homedir(), ".rudder");
  const instanceId = nonEmpty(env.RUDDER_INSTANCE_ID) ?? DEFAULT_RUDDER_INSTANCE_ID;
  return path.resolve(rudderHome, "instances", instanceId, "organizations", resolveOrganizationStorageKey(orgId), "claude-home");
}

async function prepareManagedClaudeHome(
  env: NodeJS.ProcessEnv,
  onLog: AgentRuntimeExecutionContext["onLog"],
  orgId: string,
): Promise<{ home: string; configDir: string; settingsPath: string }> {
  const sourceHome = resolveSharedClaudeHomeDir(env);
  const targetHome = resolveManagedClaudeHomeDir(env, orgId);
  const configDir = path.join(targetHome, ".claude");
  if (targetHome === sourceHome) {
    return {
      home: targetHome,
      configDir,
      settingsPath: path.join(configDir, "settings.json"),
    };
  }

  await fs.mkdir(targetHome, { recursive: true });
  await fs.rm(path.join(configDir, "skills"), { recursive: true, force: true });
  await fs.rm(path.join(configDir, "plugins"), { recursive: true, force: true });
  await fs.rm(path.join(targetHome, ".claude.json"), { force: true });
  await fs.mkdir(path.join(configDir, "skills"), { recursive: true });
  const settingsPath = await writeSanitizedClaudeSettings(sourceHome, targetHome);

  for (const relativeEntry of SHARED_CLAUDE_HOME_ENTRIES) {
    const source = path.join(sourceHome, relativeEntry);
    if (!(await pathExists(source))) continue;
    await ensureSymlink(path.join(targetHome, relativeEntry), source);
  }

  await onLog(
    "stdout",
    `[rudder] Using Rudder-managed Claude home "${targetHome}" (seeded from "${sourceHome}").\n`,
  );
  return { home: targetHome, configDir, settingsPath };
}

interface ClaudeExecutionInput {
  runId: string;
  agent: AgentRuntimeExecutionContext["agent"];
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  authToken?: string;
  onLog?: AgentRuntimeExecutionContext["onLog"];
}

interface ClaudeRuntimeConfig {
  command: string;
  cwd: string;
  workspaceId: string | null;
  workspaceRepoUrl: string | null;
  workspaceRepoRef: string | null;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  extraArgs: string[];
  permissionMode: string;
  settingsPath: string;
  runtimeTmpDir: string;
}

function buildLoginResult(input: {
  proc: RunProcessResult;
  loginUrl: string | null;
}) {
  return {
    exitCode: input.proc.exitCode,
    signal: input.proc.signal,
    timedOut: input.proc.timedOut,
    stdout: input.proc.stdout,
    stderr: input.proc.stderr,
    loginUrl: input.loginUrl,
  };
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function resolveClaudeBillingType(env: Record<string, string>): "api" | "subscription" {
  // Claude uses API-key auth when ANTHROPIC_API_KEY is present; otherwise rely on local login/session auth.
  return hasNonEmptyEnvValue(env, "ANTHROPIC_API_KEY") ? "api" : "subscription";
}

async function buildClaudeRuntimeConfig(input: ClaudeExecutionInput): Promise<ClaudeRuntimeConfig> {
  const { runId, agent, config, context, authToken } = input;

  const command = asString(config.command, "claude");
  const workspaceContext = parseObject(context.rudderWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceId = asString(workspaceContext.workspaceId, "") || null;
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "") || null;
  const workspaceRepoRef = asString(workspaceContext.repoRef, "") || null;
  const workspaceBranch = asString(workspaceContext.branchName, "") || null;
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "") || null;
  const agentHome = asString(workspaceContext.agentHome, "") || null;
  const agentInstructionsDir = asString(workspaceContext.instructionsDir, "") || null;
  const agentMemoryDir = asString(workspaceContext.memoryDir, "") || null;
  const agentSkillsDir = asString(workspaceContext.agentSkillsDir, "") || null;
  const orgWorkspaceRoot = asString(workspaceContext.orgWorkspaceRoot, "") || null;
  const orgSkillsDir = asString(workspaceContext.orgSkillsDir, "") || null;
  const projectLibraryRoot = asString(workspaceContext.projectLibraryRoot, "") || null;
  const projectLibraryPath = asString(workspaceContext.projectLibraryRelativePath, "") || null;
  const workspaceHints = Array.isArray(context.rudderWorkspaces)
    ? context.rudderWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServiceIntents = Array.isArray(context.rudderRuntimeServiceIntents)
    ? context.rudderRuntimeServiceIntents.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServices = Array.isArray(context.rudderRuntimeServices)
    ? context.rudderRuntimeServices.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimePrimaryUrl = asString(context.rudderRuntimePrimaryUrl, "");
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.RUDDER_API_KEY === "string" && envConfig.RUDDER_API_KEY.trim().length > 0;
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

  if (wakeTaskId) {
    env.RUDDER_TASK_ID = wakeTaskId;
  }
  if (wakeReason) {
    env.RUDDER_WAKE_REASON = wakeReason;
  }
  if (wakeCommentId) {
    env.RUDDER_WAKE_COMMENT_ID = wakeCommentId;
  }
  if (approvalId) {
    env.RUDDER_APPROVAL_ID = approvalId;
  }
  if (approvalStatus) {
    env.RUDDER_APPROVAL_STATUS = approvalStatus;
  }
  if (linkedIssueIds.length > 0) {
    env.RUDDER_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  }
  if (effectiveWorkspaceCwd) {
    env.RUDDER_WORKSPACE_CWD = effectiveWorkspaceCwd;
  }
  if (workspaceSource) {
    env.RUDDER_WORKSPACE_SOURCE = workspaceSource;
  }
  if (workspaceStrategy) {
    env.RUDDER_WORKSPACE_STRATEGY = workspaceStrategy;
  }
  if (workspaceId) {
    env.RUDDER_WORKSPACE_ID = workspaceId;
  }
  if (workspaceRepoUrl) {
    env.RUDDER_WORKSPACE_REPO_URL = workspaceRepoUrl;
  }
  if (workspaceRepoRef) {
    env.RUDDER_WORKSPACE_REPO_REF = workspaceRepoRef;
  }
  if (workspaceBranch) {
    env.RUDDER_WORKSPACE_BRANCH = workspaceBranch;
  }
  if (workspaceWorktreePath) {
    env.RUDDER_WORKSPACE_WORKTREE_PATH = workspaceWorktreePath;
  }
  if (agentHome) {
    env.AGENT_HOME = agentHome;
    env.RUDDER_AGENT_ROOT = agentHome;
  }
  if (agentInstructionsDir) {
    env.RUDDER_AGENT_INSTRUCTIONS_DIR = agentInstructionsDir;
  }
  if (agentMemoryDir) {
    env.RUDDER_AGENT_MEMORY_DIR = agentMemoryDir;
  }
  if (agentSkillsDir) {
    env.RUDDER_AGENT_SKILLS_DIR = agentSkillsDir;
  }
  if (orgWorkspaceRoot) {
    env.RUDDER_ORG_WORKSPACE_ROOT = orgWorkspaceRoot;
  }
  if (orgSkillsDir) {
    env.RUDDER_ORG_SKILLS_DIR = orgSkillsDir;
  }
  if (projectLibraryRoot) {
    env.RUDDER_PROJECT_LIBRARY_ROOT = projectLibraryRoot;
  }
  if (projectLibraryPath) {
    env.RUDDER_PROJECT_LIBRARY_PATH = projectLibraryPath;
  }
  if (workspaceHints.length > 0) {
    env.RUDDER_WORKSPACES_JSON = JSON.stringify(workspaceHints);
  }
  if (runtimeServiceIntents.length > 0) {
    env.RUDDER_RUNTIME_SERVICE_INTENTS_JSON = JSON.stringify(runtimeServiceIntents);
  }
  if (runtimeServices.length > 0) {
    env.RUDDER_RUNTIME_SERVICES_JSON = JSON.stringify(runtimeServices);
  }
  if (runtimePrimaryUrl) {
    env.RUDDER_RUNTIME_PRIMARY_URL = runtimePrimaryUrl;
  }

  for (const [key, value] of Object.entries(envConfig)) {
    if (CLAUDE_PROTECTED_ENV_KEYS.has(key)) continue;
    if (typeof value === "string") env[key] = value;
  }

  const sourceEnv = { ...process.env };
  const operatorHome = resolveLocalOperatorHome(sourceEnv);
  const managedClaudeHome = await prepareManagedClaudeHome(
    { ...sourceEnv, ...env },
    input.onLog ?? (async () => {}),
    agent.orgId,
  );
  const managedHome = managedClaudeHome.home;
  const runtimeTmpDir = path.join(managedHome, "runtime-tmp", runId);
  await fs.rm(runtimeTmpDir, { recursive: true, force: true });
  await fs.mkdir(runtimeTmpDir, { recursive: true });
  await syncLocalCliCredentialHomeEntries({
    sourceHome: operatorHome,
    targetHome: managedHome,
    onLog: input.onLog,
  });
  const preparedGitIdentity = await ensureGitIdentityFileConfig({
    cwd,
    home: managedHome,
    sourceEnv,
    onLog: input.onLog,
  });

  if (!hasExplicitApiKey && authToken) {
    env.RUDDER_API_KEY = authToken;
  }
  env.HOME = managedHome;
  env.USERPROFILE = managedHome;
  env.CLAUDE_CONFIG_DIR = managedClaudeHome.configDir;
  env.RUDDER_CLAUDE_HOME = managedHome;
  env.RUDDER_OPERATOR_HOME = operatorHome;
  env.RUDDER_RUNTIME_TMPDIR = runtimeTmpDir;
  applyGitIdentityPreparationEnv(env, preparedGitIdentity);
  applyGitCredentialHelperPolicyEnv(env);

  const runtimeEnv = await ensureLocalCliCredentialShimsInPath({
    operatorHome,
    targetHome: managedHome,
    cwd,
    env: ensurePathInEnv(await ensureRudderCliInPath(__moduleDir, { ...process.env, ...env })),
    onLog: input.onLog,
  });
  if (typeof runtimeEnv.PATH === "string") env.PATH = runtimeEnv.PATH;
  if (typeof runtimeEnv.Path === "string") env.Path = runtimeEnv.Path;
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = await resolveClaudeExtraArgs(config, input.onLog ?? (async () => {}));
  const permissionMode = resolveClaudePermissionMode(config);

  return {
    command,
    cwd,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    timeoutSec,
    graceSec,
    extraArgs,
    permissionMode,
    settingsPath: managedClaudeHome.settingsPath,
    runtimeTmpDir,
  };
}

export async function runClaudeLogin(input: {
  runId: string;
  agent: AgentRuntimeExecutionContext["agent"];
  config: Record<string, unknown>;
  context?: Record<string, unknown>;
  authToken?: string;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}) {
  const onLog = input.onLog ?? (async () => {});
  const runtime = await buildClaudeRuntimeConfig({
    runId: input.runId,
    agent: input.agent,
    config: input.config,
    context: input.context ?? {},
    authToken: input.authToken,
    onLog,
  });

  const proc = await runChildProcess(input.runId, runtime.command, ["auth", "login"], {
    cwd: runtime.cwd,
    env: runtime.env,
    timeoutSec: runtime.timeoutSec,
    graceSec: runtime.graceSec,
    onLog,
  });

  const loginMeta = detectClaudeLoginRequired({
    parsed: null,
    stdout: proc.stdout,
    stderr: proc.stderr,
  });

  return buildLoginResult({
    proc,
    loginUrl: loginMeta.loginUrl,
  });
}

export async function execute(ctx: AgentRuntimeExecutionContext): Promise<AgentRuntimeExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = selectPromptTemplate(
    asString(config.promptTemplate, ""),
    context,
  );
  const model = asString(config.model, "");
  const effort = asString(config.effort, "");
  const chrome = asBoolean(config.chrome, false);
  const maxTurns = asNumber(config.maxTurnsPerRun, 0);
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, false);
  const runtimeConfig = await buildClaudeRuntimeConfig({
    runId,
    agent,
    config,
    context,
    authToken,
    onLog,
  });
  const {
    command,
    cwd,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    timeoutSec,
    graceSec,
    extraArgs,
    permissionMode,
    settingsPath,
    runtimeTmpDir,
  } = runtimeConfig;
  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const billingType = resolveClaudeBillingType(effectiveEnv);
  const skillsDir = await buildSkillsDir(config);
  const claudeSkillEntries = await readRudderRuntimeSkillEntries(config, __moduleDir);
  const desiredClaudeSkillNames = resolveClaudeDesiredSkillNames(config, claudeSkillEntries);
  const loadedSkills = claudeSkillEntries
    .filter((entry) => desiredClaudeSkillNames.includes(entry.key))
    .map((entry) => ({
      key: entry.key,
      runtimeName: entry.runtimeName,
      name: entry.name ?? null,
      description: entry.description ?? null,
    }));
  const skillBoundaryPrompt = renderClaudeRudderSkillBoundaryPrompt(loadedSkills);
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionRuntimeContext = prepareAgentInstructionRuntimeContext(context as Record<string, unknown>);
  const loadedInstructions = await loadAgentInstructionsPrefix({
    instructionsFilePath,
    includeHeartbeatInstructions: shouldIncludeRuntimeHeartbeatInstructions(context as Record<string, unknown>),
    contextSectionsBeforeCurrentTime: instructionRuntimeContext.contextSectionsBeforeCurrentTime,
    onLog,
    warningStream: "stderr",
  });
  const instructionsFileDir = loadedInstructions.instructionsDir;
  const imagePaths = runtimeImagePaths(ctx.media);
  const imageAttachmentNote =
    imagePaths.length > 0
      ? `Provided ${imagePaths.length} local image attachment path${imagePaths.length === 1 ? "" : "s"} in the prompt for Claude Code inspection.`
      : null;

  // When instructionsFilePath is configured, create a combined temp file that
  // includes both the file content and the path directive, so we only need
  // --append-system-prompt-file (Claude CLI forbids using both flags together).
  let effectiveInstructionsFilePath: string | undefined;
  const claudeSystemPrompt = joinPromptSections([
    loadedInstructions.prefix,
    skillBoundaryPrompt,
  ]);
  if (claudeSystemPrompt) {
    const combinedPath = path.join(skillsDir, "agent-instructions.md");
    await fs.writeFile(combinedPath, claudeSystemPrompt, "utf-8");
    effectiveInstructionsFilePath = combinedPath;
  }
  const commandNotes = (() => {
    if (!instructionsFilePath) {
      return [
        ...loadedInstructions.commandNotes,
        "Injected Rudder operating contract via --append-system-prompt-file.",
        "Injected Rudder enabled-skill boundary via --append-system-prompt-file.",
        ...(imageAttachmentNote ? [imageAttachmentNote] : []),
      ];
    }
    if (!loadedInstructions.prefix) {
      return [
        ...loadedInstructions.commandNotes,
        ...(imageAttachmentNote ? [imageAttachmentNote] : []),
      ];
    }
    return [
      ...loadedInstructions.commandNotes,
      `Injected agent instructions via --append-system-prompt-file ${instructionsFilePath} (with path directive appended; relative references from ${instructionsFileDir}).`,
      "Injected Rudder enabled-skill boundary via --append-system-prompt-file.",
      ...(imageAttachmentNote ? [imageAttachmentNote] : []),
    ];
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
      `[rudder] Claude session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }
  /**
   * Final prompt assembly order is intentional and shared across runtimes:
   * 1) optional bootstrap prompt (only when not resuming a prior session),
   * 2) optional session handoff markdown,
   * 3) heartbeat prompt selected by wake trigger (assignment, mention, retry, fallback).
   *
   * Prompt example (comment mention wakeup):
   * [bootstrap prompt]
   * [session handoff note]
   * You are agent agent-456 (Backend Worker). You were mentioned in a comment and your attention is needed.
   * Issue: "Stabilize queue worker"
   * Comment: "@agent please check timeout handling in retry path."
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
    renderedBootstrapPrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);
  const agentInstructionStack = joinPromptSections([
    claudeSystemPrompt,
    prompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    ...loadedInstructions.metrics,
    skillBoundaryPromptChars: skillBoundaryPrompt.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const buildClaudeArgs = (resumeSessionId: string | null) => {
    const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
    else args.push("--permission-mode", permissionMode);
    if (chrome) args.push("--chrome");
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
    if (effectiveInstructionsFilePath) {
      args.push("--append-system-prompt-file", effectiveInstructionsFilePath);
    }
    args.push("--settings", settingsPath, "--setting-sources", "user", "--strict-mcp-config");
    args.push("--add-dir", skillsDir);
    args.push("--add-dir", runtimeTmpDir);
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const parseFallbackErrorMessage = (proc: RunProcessResult) => {
    const stderrLine =
      proc.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? "";

    if ((proc.exitCode ?? 0) === 0) {
      return "Failed to parse claude JSON output";
    }

    return stderrLine
      ? `Claude exited with code ${proc.exitCode ?? -1}: ${stderrLine}`
      : `Claude exited with code ${proc.exitCode ?? -1}`;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildClaudeArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        agentRuntimeType: "claude_local",
        command,
        cwd,
        commandArgs: args,
        commandNotes,
        env: redactEnvForLogs(env),
        prompt,
        agentInstructionStack,
        promptMetrics,
        loadedSkills,
        realizedSkills: loadedSkills,
        context,
      });
    }

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env,
      stdin: prompt,
      timeoutSec,
      graceSec,
      onSpawn,
      abortSignal: ctx.abortSignal,
      onLog,
    });

    const parsedStream = parseClaudeStreamJson(proc.stdout);
    const parsed = parsedStream.resultJson ?? parseJson(proc.stdout);
    return { proc, parsedStream, parsed };
  };

  const toAdapterResult = (
    attempt: {
      proc: RunProcessResult;
      parsedStream: ReturnType<typeof parseClaudeStreamJson>;
      parsed: Record<string, unknown> | null;
    },
    opts: { fallbackSessionId: string | null; clearSessionOnMissingSession?: boolean },
  ): AgentRuntimeExecutionResult => {
    const { proc, parsedStream, parsed } = attempt;
    const loginMeta = detectClaudeLoginRequired({
      parsed,
      stdout: proc.stdout,
      stderr: proc.stderr,
    });
    const errorMeta =
      loginMeta.loginUrl != null
        ? {
            loginUrl: loginMeta.loginUrl,
          }
        : undefined;

    if (proc.timedOut) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: "timeout",
        errorMeta,
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    if (!parsed) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: false,
        errorMessage: parseFallbackErrorMessage(proc),
        errorCode: loginMeta.requiresLogin ? "claude_auth_required" : null,
        errorMeta,
        resultJson: {
          stdout: proc.stdout,
          stderr: proc.stderr,
        },
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    const usage =
      parsedStream.usage ??
      (() => {
        const usageObj = parseObject(parsed.usage);
        const cacheReadInputTokens = asNumber(usageObj.cache_read_input_tokens, 0);
        const cacheCreationInputTokens = asNumber(usageObj.cache_creation_input_tokens, 0);
        return {
          inputTokens: asNumber(usageObj.input_tokens, 0),
          cachedInputTokens: cacheReadInputTokens + cacheCreationInputTokens,
          outputTokens: asNumber(usageObj.output_tokens, 0),
        };
      })();

    const resolvedSessionId =
      parsedStream.sessionId ??
      (asString(parsed.session_id, opts.fallbackSessionId ?? "") || opts.fallbackSessionId);
    const resolvedSessionParams = resolvedSessionId
      ? ({
        sessionId: resolvedSessionId,
        cwd,
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      } as Record<string, unknown>)
      : null;
    const clearSessionForMaxTurns = isClaudeMaxTurnsResult(parsed);

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage:
        (proc.exitCode ?? 0) === 0
          ? null
          : describeClaudeFailure(parsed) ?? `Claude exited with code ${proc.exitCode ?? -1}`,
      errorCode: loginMeta.requiresLogin ? "claude_auth_required" : null,
      errorMeta,
      usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "anthropic",
      biller: "anthropic",
      model: parsedStream.model || asString(parsed.model, model),
      billingType,
      costUsd: parsedStream.costUsd ?? asNumber(parsed.total_cost_usd, 0),
      resultJson: parsed,
      summary: parsedStream.summary || asString(parsed.result, ""),
      clearSession: clearSessionForMaxTurns || Boolean(opts.clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  try {
    const initial = await runAttempt(sessionId ?? null);
    if (
      sessionId &&
      !initial.proc.timedOut &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      initial.parsed &&
      isClaudeUnknownSessionError(initial.parsed)
    ) {
      await onLog(
        "stdout",
        `[rudder] Claude resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
      );
      const retry = await runAttempt(null);
      return toAdapterResult(retry, { fallbackSessionId: null, clearSessionOnMissingSession: true });
    }

    return toAdapterResult(initial, { fallbackSessionId: runtimeSessionId || runtime.sessionId });
  } finally {
    fs.rm(skillsDir, { recursive: true, force: true }).catch(() => {});
  }
}
