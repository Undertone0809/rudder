import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRuntimeExecutionContext, AgentRuntimeExecutionResult } from "@rudderhq/agent-runtime-utils";
import { applyGitCredentialHelperPolicyEnv, applyGitIdentityPreparationEnv, ensureGitIdentityFileConfig } from "@rudderhq/agent-runtime-utils/git-identity";
import type { RunProcessResult } from "@rudderhq/agent-runtime-utils/server-utils";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  parseJson,
  buildRudderEnv,
  readRudderRuntimeSkillEntries,
  joinPromptSections,
  redactEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensureLocalCliCredentialShimsInPath,
  ensureRudderCliInPath,
  ensurePathInEnv,
  resolveLocalOperatorHome,
  syncLocalCliCredentialHomeEntries,
  renderRudderRuntimeSkillBoundaryPrompt,
  renderTemplate,
  loadAgentInstructionsPrefix,
  runChildProcess,
  selectPromptTemplate,
} from "@rudderhq/agent-runtime-utils/server-utils";
import {
  parseClaudeStreamJson,
  describeClaudeFailure,
  detectClaudeLoginRequired,
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError,
} from "./parse.js";
import { resolveClaudeDesiredSkillNames } from "./skills.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUDDER_INSTANCE_ID = "default";
const SHARED_CLAUDE_HOME_ENTRIES = [
  ".config/claude",
  ".config/anthropic",
  ".anthropic",
] as const;
const CLAUDE_SINGLE_VALUE_SKILL_SOURCE_FLAGS = new Set([
  "--plugin-dir",
  "--plugin-url",
  "--settings",
  "--setting-sources",
]);
const CLAUDE_ADAPTER_OWNED_SKILL_NAMES = [
  "batch",
  "claude-api",
  "clear",
  "code-review",
  "compact",
  "context",
  "debug",
  "fewer-permission-prompts",
  "goal",
  "heapdump",
  "init",
  "insights",
  "keybindings-help",
  "loop",
  "review",
  "run",
  "run-skill-generator",
  "security-review",
  "team-onboarding",
  "update-config",
  "usage",
  "verify",
] as const;

type EnabledClaudeSkill = {
  runtimeName: string;
  source: string;
};

type LoadedClaudeSkill = {
  key: string;
  runtimeName: string;
  name: string | null;
  description: string | null;
};

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function runtimeImagePaths(media: AgentRuntimeExecutionContext["media"]): string[] {
  return (media ?? [])
    .filter((item) => item.source === "chat_attachment" && item.contentType.toLowerCase().startsWith("image/"))
    .map((item) => item.localPath)
    .filter((value) => value.trim().length > 0);
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

function resolveSharedClaudeHomeDir(env: NodeJS.ProcessEnv): string {
  return path.resolve(nonEmpty(env.HOME) ?? os.homedir());
}

function resolveManagedClaudeHomeDir(env: NodeJS.ProcessEnv, orgId: string, agentId: string): string {
  const rudderHome = nonEmpty(env.RUDDER_HOME) ?? path.resolve(os.homedir(), ".rudder");
  const instanceId = nonEmpty(env.RUDDER_INSTANCE_ID) ?? DEFAULT_RUDDER_INSTANCE_ID;
  return path.resolve(
    rudderHome,
    "instances",
    instanceId,
    "organizations",
    orgId,
    "claude-home",
    "agents",
    agentId,
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeManagedClaudeSettings(input: {
  sourceHome: string;
  targetHome: string;
  enabledSkills: EnabledClaudeSkill[];
}) {
  const sourceSettings = await readJsonFile(path.join(input.sourceHome, ".claude", "settings.json"));
  const managedSettings: Record<string, unknown> = {};
  const sourceEnv = sourceSettings?.env;
  if (isPlainRecord(sourceEnv)) {
    managedSettings.env = sourceEnv;
  }

  const apiKeyHelper = sourceSettings?.apiKeyHelper;
  if (typeof apiKeyHelper === "string" && apiKeyHelper.trim().length > 0) {
    managedSettings.apiKeyHelper = apiKeyHelper;
  }

  const enabledSkillNames = Array.from(new Set(input.enabledSkills.map((skill) => skill.runtimeName))).sort((left, right) =>
    left.localeCompare(right),
  );
  managedSettings.skillOverrides = {
    ...Object.fromEntries(CLAUDE_ADAPTER_OWNED_SKILL_NAMES.map((skillName) => [skillName, "off"])),
    ...Object.fromEntries(enabledSkillNames.map((skillName) => [skillName, true])),
  };

  const target = path.join(input.targetHome, ".claude", "settings.json");
  await ensureParentDir(target);
  await fs.writeFile(target, `${JSON.stringify(managedSettings, null, 2)}\n`, "utf8");
  return target;
}

async function ensureManagedClaudeJson(targetHome: string) {
  const target = path.join(targetHome, ".claude.json");
  const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });

  if (stat?.isFile()) return;
  if (stat) {
    await fs.rm(target, { recursive: true, force: true });
  }
  await fs.writeFile(target, "{}\n", { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
}

async function prepareManagedClaudeHome(
  env: NodeJS.ProcessEnv,
  onLog: AgentRuntimeExecutionContext["onLog"],
  orgId: string,
  agentId: string,
  enabledSkills: EnabledClaudeSkill[],
): Promise<string> {
  const sourceHome = resolveSharedClaudeHomeDir(env);
  const targetHome = resolveManagedClaudeHomeDir(env, orgId, agentId);
  if (targetHome === sourceHome) return targetHome;

  await fs.mkdir(targetHome, { recursive: true });
  await ensureManagedClaudeJson(targetHome);
  await fs.rm(path.join(targetHome, ".claude", "skills"), { recursive: true, force: true });
  await fs.mkdir(path.join(targetHome, ".claude", "skills"), { recursive: true });
  for (const skill of enabledSkills) {
    await ensureSymlink(path.join(targetHome, ".claude", "skills", skill.runtimeName), skill.source);
  }
  await writeManagedClaudeSettings({ sourceHome, targetHome, enabledSkills });

  for (const relativeEntry of SHARED_CLAUDE_HOME_ENTRIES) {
    const source = path.join(sourceHome, relativeEntry);
    if (!(await pathExists(source))) continue;
    await ensureSymlink(path.join(targetHome, relativeEntry), source);
  }

  await onLog(
    "stdout",
    `[rudder] Using per-agent Rudder-managed Claude home "${targetHome}" (seeded from "${sourceHome}").\n`,
  );
  return targetHome;
}

function stripClaudeSkillSourceArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--add-dir") {
      while (index + 1 < args.length && !args[index + 1]!.startsWith("-")) {
        index += 1;
      }
      continue;
    }
    if (CLAUDE_SINGLE_VALUE_SKILL_SOURCE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    if (
      arg.startsWith("--add-dir=") ||
      arg.startsWith("--plugin-dir=") ||
      arg.startsWith("--plugin-url=") ||
      arg.startsWith("--settings=") ||
      arg.startsWith("--setting-sources=")
    ) {
      continue;
    }
    out.push(arg);
  }
  return out;
}

function renderRudderSkillBoundaryPrompt(loadedSkills: LoadedClaudeSkill[]): string {
  return renderRudderRuntimeSkillBoundaryPrompt(loadedSkills);
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

function renderRudderEnvNote(env: Record<string, string>): string {
  const rudderKeys = Object.keys(env)
    .filter((key) => key.startsWith("RUDDER_"))
    .sort();
  if (rudderKeys.length === 0) return "";
  return [
    "Rudder runtime note:",
    `The following RUDDER_* environment variables are available in this run: ${rudderKeys.join(", ")}`,
    "Do not assume these variables are missing without checking your shell environment.",
    "",
    "",
  ].join("\n");
}

function renderApiAccessNote(env: Record<string, string>): string {
  if (!hasNonEmptyEnvValue(env, "RUDDER_API_URL") || !hasNonEmptyEnvValue(env, "RUDDER_API_KEY")) return "";
  return [
    "Rudder CLI access note:",
    "Use the runtime bash tool with the Rudder-managed CLI for Rudder control-plane work.",
    "Read example:",
    "  \"${RUDDER_CLI:-rudder}\" agent me --json",
    "Common mutating examples:",
    "  \"${RUDDER_CLI:-rudder}\" issue checkout {id} --json",
    "  printf '%s\\n' \"progress\" | \"${RUDDER_CLI:-rudder}\" issue comment {id} --body-file - --json",
    "  printf '%s\\n' \"done\" | \"${RUDDER_CLI:-rudder}\" issue done {id} --comment-file - --json",
    "  \"${RUDDER_CLI:-rudder}\" agent hire --org-id \"$RUDDER_ORG_ID\" --payload '{\"name\":\"<requested helper name>\",\"role\":\"general\",\"title\":\"<requested helper title or name>\",\"capabilities\":\"<requested helper capabilities>\",\"desiredSkills\":[\"rudder/rudder\"],\"agentRuntimeType\":\"codex_local\",\"agentRuntimeConfig\":{}}' --json",
    "",
    "",
  ].join("\n");
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
  const orgPlansDir = asString(workspaceContext.orgPlansDir, "") || null;
  const orgArtifactsDir = asString(
    workspaceContext.orgArtifactsDir,
    orgWorkspaceRoot ? path.join(orgWorkspaceRoot, "artifacts") : "",
  ) || null;
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
  if (orgPlansDir) {
    env.RUDDER_ORG_PLANS_DIR = orgPlansDir;
  }
  if (orgArtifactsDir) {
    env.RUDDER_ORG_ARTIFACTS_DIR = orgArtifactsDir;
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
    if (typeof value === "string") env[key] = value;
  }
  env.CLAUDE_CODE_DISABLE_AGENT_VIEW = "1";
  env.CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

  const sourceEnv = { ...process.env, ...env };
  const operatorHome = resolveLocalOperatorHome(sourceEnv);
  const claudeSkillEntries = await readRudderRuntimeSkillEntries(config, __moduleDir);
  const desiredClaudeSkillNames = resolveClaudeDesiredSkillNames(config, claudeSkillEntries);
  const enabledClaudeSkills = claudeSkillEntries
    .filter((entry) => desiredClaudeSkillNames.includes(entry.key))
    .map((entry) => ({
      runtimeName: entry.runtimeName,
      source: entry.source,
    }));
  env.HOME = await prepareManagedClaudeHome(
    sourceEnv,
    input.onLog ?? (async () => {}),
    agent.orgId,
    agent.id,
    enabledClaudeSkills,
  );
  await syncLocalCliCredentialHomeEntries({
    sourceHome: operatorHome,
    targetHome: env.HOME,
    onLog: input.onLog,
  });
  const preparedGitIdentity = await ensureGitIdentityFileConfig({
    cwd,
    home: env.HOME,
    sourceEnv,
    onLog: input.onLog,
  });

  if (!hasExplicitApiKey && authToken) {
    env.RUDDER_API_KEY = authToken;
  }
  env.RUDDER_OPERATOR_HOME = operatorHome;
  applyGitIdentityPreparationEnv(env, preparedGitIdentity);
  applyGitCredentialHelperPolicyEnv(env);

  const runtimeEnv = await ensureLocalCliCredentialShimsInPath({
    operatorHome,
    targetHome: env.HOME,
    cwd,
    env: ensurePathInEnv(await ensureRudderCliInPath(__moduleDir, { ...process.env, ...env })),
    onLog: input.onLog,
  });
  if (typeof runtimeEnv.PATH === "string") env.PATH = runtimeEnv.PATH;
  if (typeof runtimeEnv.Path === "string") env.Path = runtimeEnv.Path;
  if (typeof runtimeEnv.RUDDER_CLI === "string") env.RUDDER_CLI = runtimeEnv.RUDDER_CLI;
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return stripClaudeSkillSourceArgs(fromExtraArgs);
    return stripClaudeSkillSourceArgs(asStringArray(config.args));
  })();

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
  } = runtimeConfig;
  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const billingType = resolveClaudeBillingType(effectiveEnv);
  const claudeSkillEntries = await readRudderRuntimeSkillEntries(config, __moduleDir);
  const desiredClaudeSkillNames = resolveClaudeDesiredSkillNames(config, claudeSkillEntries);
  const loadedSkills = claudeSkillEntries
    .filter((entry) => desiredClaudeSkillNames.includes(entry.key))
    .map((entry): LoadedClaudeSkill => ({
      key: entry.key,
      runtimeName: entry.runtimeName,
      name: entry.name ?? null,
      description: entry.description ?? null,
    }));
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const loadedInstructions = await loadAgentInstructionsPrefix({
    instructionsFilePath,
    onLog,
    warningStream: "stderr",
  });
  const instructionsFileDir = loadedInstructions.instructionsDir;
  const imagePaths = runtimeImagePaths(ctx.media);
  const imageAttachmentNote =
    imagePaths.length > 0
      ? `Provided ${imagePaths.length} local image attachment path${imagePaths.length === 1 ? "" : "s"} in the prompt for Claude Code inspection.`
      : null;

  const commandNotes = (() => {
    if (!instructionsFilePath) {
      return [
        ...loadedInstructions.commandNotes,
        "Prepended Rudder operating contract to stdin prompt.",
        "Prepended Rudder runtime skill boundary to stdin prompt.",
        "Isolated Claude Code HOME without host .claude.json and disabled slash-command/MCP auto-loading.",
        ...(imageAttachmentNote ? [imageAttachmentNote] : []),
      ];
    }
    if (!loadedInstructions.prefix) {
      return [
        ...loadedInstructions.commandNotes,
        "Prepended Rudder runtime skill boundary to stdin prompt.",
        "Isolated Claude Code HOME without host .claude.json and disabled slash-command/MCP auto-loading.",
        ...(imageAttachmentNote ? [imageAttachmentNote] : []),
      ];
    }
    return [
      ...loadedInstructions.commandNotes,
      `Prepended instructions + path directive to stdin prompt (relative references from ${instructionsFileDir}).`,
      "Prepended Rudder runtime skill boundary to stdin prompt.",
      "Isolated Claude Code HOME without host .claude.json and disabled slash-command/MCP auto-loading.",
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
   * 1) optional injected instructions prefix,
   * 2) runtime skill boundary,
   * 3) optional bootstrap prompt (only when not resuming a prior session),
   * 4) optional session handoff markdown,
   * 5) runtime/API access notes,
   * 6) heartbeat prompt selected by wake trigger (assignment, mention, retry, fallback).
   *
   * Prompt example (comment mention wakeup):
   * [instructions prefix]
   * [skill boundary]
   * [bootstrap prompt]
   * [session handoff note]
   * [runtime/API access notes]
   * You are agent agent-456 (Backend Worker). You were mentioned in a comment and your attention is needed.
   * Issue: "Stabilize queue worker"
   * Comment: "@agent please check timeout handling in retry path."
   *
   * Reasoning: assignment/mention heartbeat templates carry issue/comment context so
   * the agent can start useful work on turn one without spending extra tool calls on
   * "what changed?" discovery.
   *
   * Traceability:
   * - doc/plans/2026-04-07-agent-prompt-context-injection.md
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
    context,
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
  const skillBoundaryPrompt = renderRudderSkillBoundaryPrompt(loadedSkills);
  const rudderEnvNote = renderRudderEnvNote(env);
  const apiAccessNote = renderApiAccessNote(env);
  const prompt = joinPromptSections([
    loadedInstructions.prefix,
    skillBoundaryPrompt,
    renderedBootstrapPrompt,
    sessionHandoffNote,
    rudderEnvNote,
    apiAccessNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    ...loadedInstructions.metrics,
    skillBoundaryPromptChars: skillBoundaryPrompt.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    runtimeNoteChars: rudderEnvNote.length + apiAccessNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const buildClaudeArgs = (resumeSessionId: string | null) => {
    const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
    if (chrome) args.push("--chrome");
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
    args.push("--disable-slash-commands");
    args.push("--strict-mcp-config");
    args.push("--setting-sources", "user");
    args.push("--settings", path.join(env.HOME, ".claude", "settings.json"));
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
        promptMetrics,
        loadedSkills,
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
}
