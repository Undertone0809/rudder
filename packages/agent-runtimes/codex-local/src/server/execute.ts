import {
  applyRudderBrowserCapabilityEnv,
  classifyAgentRuntimeNetworkFailure,
  inferOpenAiCompatibleBiller,
  pickRudderMcpManagedEnv,
  resolveManagedExternalMcpBindings,
  rudderBrowserMcpRuntimeMetadata,
  rudderMcpRuntimeMetadata,
  type AgentRuntimeControlHandleLease,
  type AgentRuntimeExecutionContext,
  type AgentRuntimeExecutionResult,
  type RudderMcpCliCommand,
  type RudderMcpPreflightResult,
} from "@rudderhq/agent-runtime-utils";
import { applyGitCredentialHelperPolicyEnv, applyGitIdentityPreparationEnv, ensureGitIdentityFileConfig } from "@rudderhq/agent-runtime-utils/git-identity";
import {
  preflightRudderBrowserMcpServer,
  preflightRudderMcpServer,
} from "@rudderhq/agent-runtime-utils/rudder-mcp-preflight";
import {
  resolveRudderBrowserMcpCliCommand,
  resolveRudderComputerMcpCliCommand,
  resolveRudderMcpCliCommand,
} from "@rudderhq/agent-runtime-utils/rudder-mcp-server";
import {
  RUDDER_PROMPT_SECTION_TAGS,
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildRudderEnv,
  createTerminalFailureAbortReason,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  ensureRudderCliInPath,
  filterRudderDesiredSkillsForBrowserCapability,
  joinPromptSections,
  loadAgentInstructionsPrefix,
  parseObject,
  prepareAgentInstructionRuntimeContext,
  readRudderRuntimeSkillEntries,
  redactEnvForLogs,
  renderTemplate,
  resolveRudderDesiredSkillNames,
  runChildProcess,
  selectPromptTemplate,
  shouldIncludeRuntimeHeartbeatInstructions,
  wrapPromptSection,
} from "@rudderhq/agent-runtime-utils/server-utils";
import { COMPUTER_USE_AGENT_INSTRUCTION } from "@rudderhq/shared";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodexLocalModel, resolveCodexLocalReasoningEffort } from "../defaults.js";
import { executeCodexAppServerChat } from "./app-server-chat.js";
import {
  discoverExternalCodexSkillDisablePaths,
  prepareManagedCodexHome,
  realizeManagedCodexSkillEntries,
  resolveManagedCodexHomeDir,
  resolveTrustedOperatorHome,
} from "./codex-home.js";
import { estimateCodexCostUsd } from "./cost.js";
import { captureCodexInlineVisuals, codexInlineVisualDirectiveBody } from "./inline-visuals.js";
import { buildCodexLoadedMcpServers } from "./mcp-evidence.js";
import {
  isCodexProviderAuthFailure,
  isCodexTransportDisconnectError,
  isCodexUnknownSessionError,
  parseCodexJsonl,
} from "./parse.js";
import { codexConfiguredEnvironment } from "./profile-env.js";
import {
  buildCodexReadinessFingerprint,
  claimCodexAuthProbe,
  clearMatchingCodexAuthFailure,
  clearObservedCodexAuthSuccess,
  recordCodexAuthFailure,
  renewCodexAuthProbe,
  type CodexAuthProbeLease,
} from "./readiness-gate.js";
import { resolveCodexCommand } from "./resolve-command.js";
import { CODEX_STDERR_LINE_BUFFER_LIMIT, createCodexStderrLineFilter, splitCompleteLines, stripCodexBenignStderr } from "./stderr-filter.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const CODEX_AUTH_FAILURE_HARD_DEADLINE_MS = 2_000;
const CODEX_AUTH_PROBE_RENEW_INTERVAL_MS = 30_000;


function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function firstMeaningfulErrorLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const informative = lines.find((line) => {
    if (/^file:\/\//i.test(line)) return false;
    if (/^\^+$/.test(line)) return false;
    if (/^throw\s+new\s+[A-Za-z]*Error\b/.test(line)) return false;
    if (/^(at\s|node:internal\b|Node\.js v\d+)/.test(line)) return false;
    return true;
  });

  return informative ?? lines[0] ?? "";
}

const CODEX_NATIVE_SESSION_PARAM_FIELDS = [
  "threadId",
  "rootSessionId",
  "forkedFromId",
  "model",
  "modelProvider",
  "ephemeral",
  "transport",
] as const;

function providerProfileSessionParams(config: Record<string, unknown>, orgId: string): Record<string, unknown> {
  const profileHostId = asString(config.providerHostId ?? config.hostId, "local").trim() || "local";
  const profileId = asString(config.providerProfileId ?? config.profileId, "default").trim() || "default";
  const capabilityRevision = asString(config.capabilityRevision, "").trim();
  const profileBindingId = asString(config.providerBindingId ?? config.bindingId, "").trim();
  const profileOrgId = asString(config.providerOrgId ?? config.orgId ?? orgId, "").trim() || orgId;
  const workspaceBindingId = asString(
    config.providerWorkspaceBindingId ?? config.workspaceBindingId,
    "",
  ).trim();
  return {
    profileHostId,
    profileId,
    ...(profileBindingId ? { profileBindingId } : {}),
    ...(profileOrgId ? { profileOrgId } : {}),
    ...(workspaceBindingId ? { workspaceBindingId } : {}),
    ...(capabilityRevision ? { capabilityRevision } : {}),
  };
}

function storedString(params: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = asString(params[key], "").trim();
    if (value) return value;
  }
  return "";
}

export function validateCodexResumeSession(input: {
  sessionId: string;
  sessionParams: Record<string, unknown>;
  cwd: string;
  expectedTransport: "codex_app_server" | "codex_cli";
  workspaceId?: string;
  repoUrl?: string;
  repoRef?: string;
  profile: Record<string, unknown>;
}): string | null {
  const params = input.sessionParams;
  const storedSessionId = storedString(params, ["sessionId", "threadId"]);
  if (storedSessionId && storedSessionId !== input.sessionId) {
    return "Codex persisted session identity does not match the requested session.";
  }
  const storedCwd = storedString(params, ["cwd", "workdir", "folder"]);
  if (storedCwd && path.resolve(storedCwd) !== path.resolve(input.cwd)) {
    return `Codex session cwd "${storedCwd}" does not match the requested workspace cwd "${input.cwd}".`;
  }
  const identityFields: Array<[string, readonly string[], string]> = [
    ["host", ["profileHostId", "providerHostId", "hostId"], asString(input.profile.profileHostId, "").trim()],
    ["profile", ["profileId", "providerProfileId"], asString(input.profile.profileId, "").trim()],
    ["binding", ["profileBindingId", "providerBindingId", "bindingId"], asString(input.profile.profileBindingId, "").trim()],
    ["organization", ["profileOrgId", "providerOrgId", "orgId"], asString(input.profile.profileOrgId, "").trim()],
    ["workspace binding", ["workspaceBindingId", "providerWorkspaceBindingId"], asString(input.profile.workspaceBindingId, "").trim()],
    ["capability revision", ["capabilityRevision"], asString(input.profile.capabilityRevision, "").trim()],
  ];
  for (const [label, keys, expected] of identityFields) {
    const stored = storedString(params, keys);
    if (stored && stored !== expected) {
      return `Codex session ${label} identity does not match the requested provider binding.`;
    }
  }
  const storedTransport = storedString(params, ["transport", "codexTransport"]);
  if (storedTransport && storedTransport !== input.expectedTransport) {
    return `Codex session transport ${storedTransport} does not match ${input.expectedTransport}.`;
  }
  const workspaceFields: Array<[string, readonly string[], string]> = [
    ["workspace", ["workspaceId", "workspace_id"], input.workspaceId ?? ""],
    ["repository URL", ["repoUrl", "repo_url"], input.repoUrl ?? ""],
    ["repository ref", ["repoRef", "repo_ref"], input.repoRef ?? ""],
  ];
  for (const [label, keys, expected] of workspaceFields) {
    const stored = storedString(params, keys);
    if (stored && stored !== expected) {
      return `Codex session ${label} identity does not match the requested workspace.`;
    }
  }
  return null;
}

/** Keep only provider-native metadata that the App Server actually returned. */
export function buildCodexSessionParams(input: {
  sessionId: string | null | undefined;
  cwd: string;
  native?: Record<string, unknown> | null;
  workspaceId?: string;
  repoUrl?: string;
  repoRef?: string;
  profile?: Record<string, unknown> | null;
  transport?: "codex_app_server" | "codex_cli";
  chatDeveloperInstructionsRevision?: string | null;
}): Record<string, unknown> | null {
  const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
  if (!sessionId) return null;
  const native = input.native ?? {};
  const nativeEntries: Array<readonly [string, string | boolean]> = [];
  for (const key of CODEX_NATIVE_SESSION_PARAM_FIELDS) {
    const value = native[key];
    if (typeof value === "string" && value.trim()) nativeEntries.push([key, value.trim()]);
    else if (typeof value === "boolean") nativeEntries.push([key, value]);
  }
  const nativeParams = Object.fromEntries(nativeEntries);
  return {
    ...nativeParams,
    sessionId,
    cwd: input.cwd,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.repoUrl ? { repoUrl: input.repoUrl } : {}),
    ...(input.repoRef ? { repoRef: input.repoRef } : {}),
    ...(input.transport ? { transport: input.transport } : {}),
    ...(input.chatDeveloperInstructionsRevision
      ? { rudderChatDeveloperInstructionsRevision: input.chatDeveloperInstructionsRevision }
      : {}),
    ...(input.profile ?? {}),
  };
}

function hasCliArg(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parseCodexAppServerExtraArgs(extraArgs: string[]): {
  sandboxMode: "read-only" | null;
  unsupportedArgs: string[];
} {
  let sandboxMode: "read-only" | null = null;
  const unsupportedArgs: string[] = [];

  for (let index = 0; index < extraArgs.length; index += 1) {
    const arg = extraArgs[index];
    if (arg === "--skip-git-repo-check") continue;
    if (arg === "--sandbox=read-only") {
      sandboxMode = "read-only";
      continue;
    }
    if ((arg === "-s" || arg === "--sandbox") && extraArgs[index + 1] === "read-only") {
      sandboxMode = "read-only";
      index += 1;
      continue;
    }
    unsupportedArgs.push(arg);
  }

  return { sandboxMode, unsupportedArgs };
}

function runtimeImagePaths(media: AgentRuntimeExecutionContext["media"]): string[] {
  return (media ?? [])
    .filter((item) => item.source === "chat_attachment" && item.contentType.toLowerCase().startsWith("image/"))
    .map((item) => item.localPath)
    .filter((value) => value.trim().length > 0);
}

function renderCodexRudderSkillBoundaryPrompt(
  loadedSkills: Array<{ key: string; runtimeName?: string | null; name?: string | null }>,
): string {
  const skillLines = loadedSkills.length > 0
    ? loadedSkills.map((entry) => `- ${entry.runtimeName ?? entry.key}`)
    : ["- None. No optional Rudder skills are enabled for this run."];

  return wrapPromptSection(RUDDER_PROMPT_SECTION_TAGS.enabledSkills, [
    "Rudder is the source of truth for runtime skill enablement.",
    "Only skills listed in this section are enabled by Rudder for this run. Codex built-in/provider-native skills, repo instructions, host-global skills, and the current Codex client session may expose other capabilities, but they are not Rudder-enabled skills and must not be described as this agent's Rudder skills unless listed here.",
    "When the user asks what skills are enabled, loaded, available, or what skills you have in Rudder, answer with only the runtime skill names listed in this section. Use a plain newline-separated list. Do not use prose, bullets, Markdown, code spans, explanations, prefixes, or suffixes. If exactly one skill is listed, answer exactly that runtime skill name and nothing else. Do not list, summarize, or explain provider-native Codex skills, repo instructions, host-global skills, or current-session capabilities in that answer.",
    "",
    ...skillLines,
  ].join("\n"));
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function resolveCodexBillingType(env: Record<string, string>): "api" | "subscription" {
  // Codex uses API-key auth when OPENAI_API_KEY is present; otherwise rely on local login/session auth.
  return hasNonEmptyEnvValue(env, "OPENAI_API_KEY") ? "api" : "subscription";
}

function resolveCodexBiller(env: Record<string, string>, billingType: "api" | "subscription"): string {
  const openAiCompatibleBiller = inferOpenAiCompatibleBiller(env, "openai");
  if (openAiCompatibleBiller === "openrouter") return "openrouter";
  return billingType === "subscription" ? "chatgpt" : openAiCompatibleBiller ?? "openai";
}

function resolveCodexResultBillingType(
  billingType: "api" | "subscription",
  countSubscriptionUsageAsCost: boolean,
  hasEstimatedCost: boolean,
): "api" | "subscription" | "metered_api" {
  if (billingType === "subscription" && countSubscriptionUsageAsCost && hasEstimatedCost) return "metered_api";
  return billingType;
}

function envStrings(envConfig: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(envConfig).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function resolveFallbackAgentHome(effectiveCodexHome: string, agentId: string): string {
  const orgRoot = path.dirname(path.dirname(path.dirname(effectiveCodexHome)));
  return path.join(orgRoot, "workspaces", "agents", agentId);
}

export function resolveCodexAgentHome(input: {
  configuredAgentHome: string;
  cwd: string;
  runtimeScene: string;
  effectiveCodexHome: string;
  agentId: string;
}): string {
  if (input.configuredAgentHome) return input.configuredAgentHome;
  // Product Intelligence uses a synthetic agent identity for the common
  // runtime contract, but must not materialize that identity as a Library
  // workspace. Its temporary cwd is the only appropriate home for this run.
  if (input.runtimeScene === "product_intelligence") return input.cwd;
  return resolveFallbackAgentHome(input.effectiveCodexHome, input.agentId);
}

export async function getProviderReadinessFingerprint(
  ctx: AgentRuntimeExecutionContext,
): Promise<string> {
  const envConfig = parseObject(ctx.config.env);
  const envConfigStrings = envStrings(envConfig);
  const operatorHome = resolveTrustedOperatorHome();
  const sharedCodexHomeOverride =
    typeof envConfig.CODEX_HOME === "string" && envConfig.CODEX_HOME.trim().length > 0
      ? path.resolve(envConfig.CODEX_HOME.trim())
      : null;
  const sharedCodexHome = sharedCodexHomeOverride ?? (
    typeof process.env.CODEX_HOME === "string" && process.env.CODEX_HOME.trim().length > 0
      ? path.resolve(process.env.CODEX_HOME.trim())
      : path.join(operatorHome, ".codex")
  );
  const codexTargetEnv = {
    ...process.env,
    RUDDER_SHARED_CODEX_HOME: sharedCodexHome,
  };
  // Model-fallback preflight must inspect the same managed snapshot that
  // execute() will run. This also removes deleted provider config before a
  // fallback compares its readiness scope.
  const effectiveCodexHome = await prepareManagedCodexHome(
    codexTargetEnv,
    ctx.onLog,
    ctx.agent.orgId,
    ctx.agent.id,
  );

  return buildCodexReadinessFingerprint({
    env: Object.fromEntries(
      Object.entries({ ...process.env, ...envConfigStrings }).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    sharedCodexHome,
    codexHome: effectiveCodexHome,
    model: resolveCodexLocalModel(ctx.config),
  });
}

export async function execute(ctx: AgentRuntimeExecutionContext): Promise<AgentRuntimeExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = selectPromptTemplate(
    asString(config.promptTemplate, ""),
    context,
  );
  const command = asString(config.command, "codex");
  const model = resolveCodexLocalModel(config);
  const countSubscriptionUsageAsCost = asBoolean(config.countSubscriptionUsageAsCost, true);
  const modelReasoningEffort = resolveCodexLocalReasoningEffort(config);
  const search = asBoolean(config.search, false);
  const bypass = asBoolean(
    config.dangerouslyBypassApprovalsAndSandbox,
    asBoolean(config.dangerouslyBypassSandbox, false),
  );

  const workspaceContext = parseObject(context.rudderWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const workspaceBranch = asString(workspaceContext.branchName, "");
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "");
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
  const runtimeScene = asString(context.rudderScene, "");
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  const envConfig = parseObject(config.env);
  const envConfigStrings = envStrings(envConfig);
  const sharedCodexHomeOverride =
    typeof envConfig.CODEX_HOME === "string" && envConfig.CODEX_HOME.trim().length > 0
      ? path.resolve(envConfig.CODEX_HOME.trim())
      : null;
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  const operatorHome = resolveTrustedOperatorHome();
  const sharedCodexHome = sharedCodexHomeOverride ?? (
    typeof process.env.CODEX_HOME === "string" && process.env.CODEX_HOME.trim().length > 0
      ? path.resolve(process.env.CODEX_HOME.trim())
      : path.join(operatorHome, ".codex")
  );
  const codexTargetEnv = {
    ...process.env,
    RUDDER_SHARED_CODEX_HOME: sharedCodexHome,
  };
  const providerNativeSkillsHome = path.join(sharedCodexHome, "skills");
  const externalCodexSkillPaths = await discoverExternalCodexSkillDisablePaths([
    path.join(operatorHome, ".agents", "skills"),
    path.join(sharedCodexHome, "skills"),
    path.join(cwd, ".agents", "skills"),
  ], [providerNativeSkillsHome]);
  const preparedManagedCodexHome = await prepareManagedCodexHome(
    codexTargetEnv,
    onLog,
    agent.orgId,
    agent.id,
    {
      disabledSkillPaths: externalCodexSkillPaths,
      preservedSkillPaths: [providerNativeSkillsHome],
    },
    __moduleDir,
  );
  const defaultCodexHome = resolveManagedCodexHomeDir(codexTargetEnv, agent.orgId, agent.id);
  const effectiveCodexHome = preparedManagedCodexHome ?? defaultCodexHome;
  await fs.mkdir(effectiveCodexHome, { recursive: true });
  const effectiveAgentHome = resolveCodexAgentHome({
    configuredAgentHome: agentHome,
    cwd,
    runtimeScene,
    effectiveCodexHome,
    agentId: agent.id,
  });
  await fs.mkdir(effectiveAgentHome, { recursive: true });
  const gitSidecarHome = path.join(effectiveCodexHome, "git");
  const preparedGitIdentity = await ensureGitIdentityFileConfig({
    cwd,
    home: gitSidecarHome,
    sourceEnv: {
      ...process.env,
      ...envConfigStrings,
      HOME: operatorHome,
      USERPROFILE: process.env.USERPROFILE ?? operatorHome,
      CODEX_HOME: sharedCodexHome,
    },
    onLog,
  });
  const codexSkillEntries = await readRudderRuntimeSkillEntries(config, __moduleDir);
  const desiredCodexSkillNames = resolveRudderDesiredSkillNames(config, codexSkillEntries);
  const env: Record<string, string> = { ...buildRudderEnv(agent) };
  env.CODEX_HOME = effectiveCodexHome;
  env.HOME = operatorHome;
  env.USERPROFILE = process.env.USERPROFILE ?? operatorHome;
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
  env.AGENT_HOME = effectiveAgentHome;
  env.RUDDER_AGENT_ROOT = effectiveAgentHome;
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
  Object.assign(env, codexConfiguredEnvironment(envConfig));
  let browserEnabled = applyRudderBrowserCapabilityEnv(env, config);
  let computerEnabled = asBoolean(config.rudderComputerEnabled, false);
  env.RUDDER_COMPUTER_ENABLED = computerEnabled ? "true" : "false";
  env.CODEX_HOME = effectiveCodexHome;
  env.HOME = operatorHome;
  env.USERPROFILE = process.env.USERPROFILE ?? operatorHome;
  env.AGENT_HOME = effectiveAgentHome;
  env.RUDDER_AGENT_ROOT = effectiveAgentHome;
  env.RUDDER_OPERATOR_HOME = operatorHome;
  if (authToken) {
    env.RUDDER_API_KEY = authToken;
  }
  applyGitIdentityPreparationEnv(env, preparedGitIdentity);
  applyGitCredentialHelperPolicyEnv(env);
  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const billingType = resolveCodexBillingType(effectiveEnv);
  const runtimeEnv = ensurePathInEnv(await ensureRudderCliInPath(__moduleDir, effectiveEnv));
  let rudderMcpCommand: RudderMcpCliCommand | undefined;
  let rudderMcpPreflight: RudderMcpPreflightResult;
  try {
    rudderMcpCommand = await resolveRudderMcpCliCommand(__moduleDir);
    rudderMcpPreflight = await preflightRudderMcpServer({
      command: rudderMcpCommand,
      runtimeEnv,
      managedEnv: pickRudderMcpManagedEnv(env),
      browserEnabled: false,
    });
  } catch {
    rudderMcpPreflight = {
      available: false,
      provenance: "repo",
      version: null,
      contractVersion: null,
      coreContractHash: null,
      diagnosticCode: "core_bundle_handshake_failed",
      diagnostic: "Rudder MCP capability preparation failed.",
      tools: [],
    };
  }
  if (!rudderMcpPreflight.available) {
    await onLog(
      "stderr",
      `[rudder] Rudder MCP is unavailable; continuing without Rudder MCP tools: ${rudderMcpPreflight.diagnostic}\n`,
    );
  }
  const browserMcpCommand = browserEnabled
    ? await resolveRudderBrowserMcpCliCommand(__moduleDir).catch(() => null)
    : null;
  const browserMcpPreflight = browserMcpCommand
    ? await preflightRudderBrowserMcpServer({
        command: browserMcpCommand,
        runtimeEnv,
        managedEnv: pickRudderMcpManagedEnv(env),
      }).catch(() => null)
    : null;
  if (browserEnabled && !browserMcpPreflight?.browserAvailable) {
    browserEnabled = false;
    env.RUDDER_BROWSER_ENABLED = "false";
    runtimeEnv.RUDDER_BROWSER_ENABLED = "false";
    await onLog("stderr", `[rudder] ${browserMcpPreflight?.diagnostic}\n`);
  }
  const computerMcpCommand = computerEnabled
    ? await resolveRudderComputerMcpCliCommand(__moduleDir).catch(() => null)
    : null;
  if (computerEnabled && (!computerMcpCommand || !rudderMcpPreflight.available)) {
    computerEnabled = false;
    env.RUDDER_COMPUTER_ENABLED = "false";
    runtimeEnv.RUDDER_COMPUTER_ENABLED = "false";
    await onLog("stderr", "[rudder] Rudder Computer MCP is unavailable; continuing without Computer Use.\n");
  }
  const effectiveDesiredCodexSkillNames = filterRudderDesiredSkillsForBrowserCapability(
    codexSkillEntries,
    desiredCodexSkillNames,
    browserEnabled,
  );
  const selectedCodexSkillEntries = codexSkillEntries
    .filter((entry) => effectiveDesiredCodexSkillNames.includes(entry.key));
  const loadedSkills = selectedCodexSkillEntries.map((entry) => ({
    key: entry.key,
    runtimeName: entry.runtimeName,
    name: entry.name ?? null,
    description: entry.description ?? null,
  }));
  const skillBoundaryPrompt = renderCodexRudderSkillBoundaryPrompt(loadedSkills);
  await realizeManagedCodexSkillEntries(
    {
      ...codexTargetEnv,
      CODEX_HOME: sharedCodexHome,
    },
    effectiveCodexHome,
    selectedCodexSkillEntries.map((entry) => entry.source),
    onLog,
    {
      disabledSkillPaths: externalCodexSkillPaths,
      preservedSkillPaths: [providerNativeSkillsHome],
    },
    __moduleDir,
    pickRudderMcpManagedEnv(env),
    rudderMcpCommand,
    browserMcpCommand ?? undefined,
    config,
    rudderMcpPreflight.available,
    computerMcpCommand ?? undefined,
    codexSkillEntries.map((entry) => entry.source),
  );
  const loadedMcpServers = buildCodexLoadedMcpServers({
    coreEnabled: rudderMcpPreflight.available,
    browserEnabled,
    computerEnabled,
    externalBindings: resolveManagedExternalMcpBindings(config, runtimeEnv),
  });
  if (typeof runtimeEnv.PATH === "string") env.PATH = runtimeEnv.PATH;
  if (typeof runtimeEnv.Path === "string") env.Path = runtimeEnv.Path;
  const executableCommand = await resolveCodexCommand(command, cwd, runtimeEnv);
  await ensureCommandResolvable(executableCommand, cwd, runtimeEnv);

  await onLog(
    "stdout",
    `[rudder] Using operator HOME "${operatorHome}" with AGENT_HOME "${effectiveAgentHome}" and isolated CODEX_HOME "${effectiveCodexHome}".\n`,
  );

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();
  const profileSessionParams = providerProfileSessionParams(config, agent.orgId);

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const persistedSessionId = asString(
    runtimeSessionParams.sessionId ?? runtimeSessionParams.threadId,
    "",
  ).trim();
  const runtimeSessionId = persistedSessionId || asString(runtime.sessionId, "").trim();
  const sessionId = runtimeSessionId;
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionRuntimeContext = prepareAgentInstructionRuntimeContext(context as Record<string, unknown>);
  const loadedInstructions = await loadAgentInstructionsPrefix({
    instructionsFilePath,
    includeHeartbeatInstructions: shouldIncludeRuntimeHeartbeatInstructions(context as Record<string, unknown>),
    instructionContextSections: instructionRuntimeContext.instructionContextSections,
    onLog,
  });
  const instructionsPrefix = loadedInstructions.prefix;
  const instructionsDir = loadedInstructions.instructionsDir;
  const imagePaths = runtimeImagePaths(ctx.media);
  const repoAgentsNote =
    "Codex exec automatically applies repo-scoped AGENTS.md instructions from the current workspace; Rudder does not currently suppress that discovery.";
  const imageAttachmentNote =
    imagePaths.length > 0
      ? `Attached ${imagePaths.length} image attachment${imagePaths.length === 1 ? "" : "s"} to the initial Codex prompt via --image.`
      : null;
  const commandNotes = (() => {
    const rudderMcpNote = "Configured first-party Rudder MCP tools for Codex.";
    if (!instructionsFilePath) {
      return [
        ...loadedInstructions.commandNotes,
        rudderMcpNote,
        "Prepended Rudder operating contract to stdin prompt.",
        ...(imageAttachmentNote ? [imageAttachmentNote] : []),
        repoAgentsNote,
      ];
    }
    if (instructionsPrefix.length > 0) {
      return [
        ...loadedInstructions.commandNotes,
        rudderMcpNote,
        `Prepended instructions + path directive to stdin prompt (relative references from ${instructionsDir}).`,
        ...(imageAttachmentNote ? [imageAttachmentNote] : []),
        repoAgentsNote,
      ];
    }
    return [
      ...loadedInstructions.commandNotes,
      rudderMcpNote,
      ...(imageAttachmentNote ? [imageAttachmentNote] : []),
      repoAgentsNote,
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
   * Description: "Users land on a blank page after login."
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
  const instructionFrame = wrapPromptSection(
    RUDDER_PROMPT_SECTION_TAGS.agentInstruction,
    joinPromptSections([
      instructionsPrefix,
      skillBoundaryPrompt,
      computerEnabled ? COMPUTER_USE_AGENT_INSTRUCTION : "",
    ]),
  );
  const rawCodexChatPrompt = context.rudderCodexChatPrompt;
  const codexChatPrompt = rawCodexChatPrompt && typeof rawCodexChatPrompt === "object" && !Array.isArray(rawCodexChatPrompt)
    ? rawCodexChatPrompt as Record<string, unknown>
    : null;
  if (rawCodexChatPrompt !== undefined && (
    codexChatPrompt?.version !== 1 || typeof codexChatPrompt.developerInstructions !== "string"
  )) {
    throw new Error("Unsupported Rudder native Codex Chat prompt contract");
  }
  const codexChatDeveloperInstructions = codexChatPrompt
    ? asString(codexChatPrompt.developerInstructions, "").trim()
    : "";
  const prompt = joinPromptSections([
    instructionFrame,
    codexChatDeveloperInstructions,
    renderedBootstrapPrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    ...loadedInstructions.metrics,
    skillBoundaryPromptChars: skillBoundaryPrompt.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  // Plan mode's CLI-shaped read-only overlay must preserve App Server's native
  // turn controls; other custom args still require exec compatibility fallback.
  // Traceability: doc/plans/2026-07-23-plan-mode-steer-queue-simplification.md
  const appServerExtraArgs = parseCodexAppServerExtraArgs(extraArgs);
  const useAppServerChat =
    runtimeScene === "chat"
    && context.chatMode === true
    && context.rudderChatResultRepair !== true
    && asBoolean(config.chatAppServerEnabled, command === "codex")
    && appServerExtraArgs.unsupportedArgs.length === 0;
  const expectedSessionTransport = useAppServerChat ? "codex_app_server" : "codex_cli";
  if (runtimeSessionId) {
    const resumeRejection = validateCodexResumeSession({
      sessionId: runtimeSessionId,
      sessionParams: runtimeSessionParams,
      cwd,
      expectedTransport: expectedSessionTransport,
      workspaceId,
      repoUrl: workspaceRepoUrl,
      repoRef: workspaceRepoRef,
      profile: profileSessionParams,
    });
    if (resumeRejection) {
      await onLog("stderr", `[rudder] Codex resume rejected: ${resumeRejection}\n`);
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `Codex resume rejected: ${resumeRejection}`,
        errorCode: "codex_resume_rejected",
        sessionId: runtimeSessionId,
        sessionParams: runtimeSessionParams,
        sessionDisplayId: runtimeSessionId,
        provider: "openai",
        biller: resolveCodexBiller(effectiveEnv, billingType),
        model,
        billingType,
        resultJson: {
          resume: {
            status: "rejected",
            reason: resumeRejection,
            transport: expectedSessionTransport,
          },
        },
        clearSession: false,
      };
    }
  }

  // Claim only after the managed home has its final staged auth/config snapshot
  // and all prompt/metadata preparation has completed. The lease makes expiry
  // a single-probe transition across server processes without leaving a probe
  // behind when preparation fails before execution starts.
  const readinessFingerprint = agentHome
    ? await buildCodexReadinessFingerprint({
        env: effectiveEnv,
        sharedCodexHome,
        codexHome: effectiveCodexHome,
        model,
      })
    : null;
  let authProbeLease: CodexAuthProbeLease | null = null;
  let authProbeObservation: CodexAuthProbeLease | null = null;
  if (readinessFingerprint) {
    const probeClaim = await claimCodexAuthProbe(effectiveAgentHome, readinessFingerprint);
    if (!probeClaim.claimed && probeClaim.readinessState !== "probing") {
      const readinessBusy = probeClaim.readinessState === "busy";
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: readinessBusy ? "codex_provider_readiness_busy" : "codex_provider_auth_required",
        errorMessage: readinessBusy
          ? "Codex provider readiness is busy; retry after the active readiness operation completes."
          : "Codex provider authentication remains unavailable for the current readiness fingerprint.",
        provider: "openai",
        biller: resolveCodexBiller(effectiveEnv, billingType),
        model,
        billingType,
        resultJson: {
          providerFailure: {
            classification: readinessBusy ? "readiness" : "authentication",
            retryable: readinessBusy,
            shortCircuited: true,
            reason: readinessBusy ? "codex_provider_readiness_busy" : "codex_provider_auth_required",
            readinessFingerprint,
            readinessState: probeClaim.readinessState,
          },
        },
        clearSession: false,
      };
    }
    if (probeClaim.claimed) authProbeLease = probeClaim.lease;
    else if (probeClaim.readinessState === "probing") authProbeObservation = probeClaim.observation;
  }
  const persistAuthFailureGate = async () => {
    if (!readinessFingerprint || !authProbeLease) return;
    await recordCodexAuthFailure(effectiveAgentHome, readinessFingerprint, authProbeLease).catch(async () => {
      await onLog(
        "stderr",
        "[rudder] Failed to persist the Codex provider readiness failure gate.\n",
      ).catch(() => undefined);
    });
  };
  const clearAuthFailureGate = async () => {
    if (!readinessFingerprint || !authProbeLease) return;
    await clearMatchingCodexAuthFailure(effectiveAgentHome, readinessFingerprint, authProbeLease).catch(async () => {
      await onLog(
        "stderr",
        "[rudder] Failed to clear the Codex provider readiness failure gate.\n",
      ).catch(() => undefined);
    });
  };
  const clearObservedAuthSuccess = async () => {
    if (!readinessFingerprint || !authProbeObservation) return;
    await clearObservedCodexAuthSuccess(
      effectiveAgentHome,
      readinessFingerprint,
      authProbeObservation,
    ).catch(async () => {
      await onLog(
        "stderr",
        "[rudder] Failed to clear the observed Codex provider readiness probe.\n",
      ).catch(() => undefined);
    });
  };
  let readinessRenewalTimer: ReturnType<typeof setInterval> | null = null;
  let readinessRenewalInFlight: Promise<void> | null = null;
  let readinessLeaseLost = false;
  const readinessLeaseAbortController = new AbortController();
  const markReadinessLeaseLost = (message: string) => {
    if (readinessLeaseLost) return;
    readinessLeaseLost = true;
    readinessLeaseAbortController.abort(
      createTerminalFailureAbortReason(CODEX_AUTH_FAILURE_HARD_DEADLINE_MS),
    );
    void onLog("stderr", `[rudder] ${message}\n`).catch(() => undefined);
  };
  const renewReadinessLease = () => {
    if (!readinessFingerprint || !authProbeLease || readinessLeaseLost || readinessRenewalInFlight) return;
    readinessRenewalInFlight = renewCodexAuthProbe(
      effectiveAgentHome,
      readinessFingerprint,
      authProbeLease,
    ).then(async (renewed) => {
      if (renewed) return;
      markReadinessLeaseLost(
        "Codex provider readiness lease was lost; the current probe was terminated and will not update readiness state.",
      );
    }).catch(async () => {
      markReadinessLeaseLost(
        "Failed to renew the Codex provider readiness lease; the current probe was terminated.",
      );
    }).finally(() => {
      readinessRenewalInFlight = null;
    });
  };
  const stopReadinessLeaseRenewal = async () => {
    if (readinessRenewalTimer) {
      clearInterval(readinessRenewalTimer);
      readinessRenewalTimer = null;
    }
    await readinessRenewalInFlight;
  };
  if (readinessFingerprint && authProbeLease) {
    readinessRenewalTimer = setInterval(renewReadinessLease, CODEX_AUTH_PROBE_RENEW_INTERVAL_MS);
    readinessRenewalTimer.unref?.();
  }

  if (useAppServerChat) {
    const appServerArgs = ["app-server", "--stdio"];
    const appServerPrompt = codexChatPrompt
      ? joinPromptSections([renderedBootstrapPrompt, sessionHandoffNote, renderedPrompt])
      : prompt;
    const appServerDeveloperInstructions = codexChatPrompt
      ? joinPromptSections([instructionFrame, codexChatDeveloperInstructions])
      : null;
    const appServerDeveloperInstructionsRevision = appServerDeveloperInstructions
      ? createHash("sha256").update(appServerDeveloperInstructions).digest("hex")
      : null;
    const persistedDeveloperInstructionsRevision = storedString(runtimeSessionParams, [
      "rudderChatDeveloperInstructionsRevision",
    ]) || null;
    try {
      if (onMeta) {
        await onMeta({
          agentRuntimeType: "codex_local",
          command: executableCommand,
          cwd,
          commandNotes: [
            ...commandNotes,
            "Using Codex App Server for interactive chat Steer and Stop controls.",
          ],
          commandArgs: appServerArgs,
          env: redactEnvForLogs(env),
          prompt: appServerPrompt,
          agentInstructionStack: appServerDeveloperInstructions
            ? joinPromptSections([appServerDeveloperInstructions, appServerPrompt])
            : appServerPrompt,
          promptMetrics: {
            ...promptMetrics,
            promptChars: appServerPrompt.length,
            codexDeveloperInstructionsChars: appServerDeveloperInstructions?.length ?? 0,
          },
          loadedMcpServers,
          loadedSkills,
          realizedSkills: loadedSkills,
          rudderMcp: rudderMcpRuntimeMetadata({ browserEnabled, preflight: rudderMcpPreflight }),
          browserMcp: rudderBrowserMcpRuntimeMetadata({
            available: browserEnabled,
            preflight: browserMcpPreflight,
          }),
          context,
        });
      }
      const appStartedAt = new Date();
      const appResult = await executeCodexAppServerChat({
        command: executableCommand,
        cwd,
        env: Object.fromEntries(
          Object.entries(runtimeEnv).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
        prompt: appServerPrompt,
        ...(appServerDeveloperInstructions ? {
          chatDeveloperInstructions: appServerDeveloperInstructions,
          chatDeveloperInstructionsRevision: appServerDeveloperInstructionsRevision,
          persistedChatDeveloperInstructionsRevision: persistedDeveloperInstructionsRevision,
        } : {}),
        model,
        modelReasoningEffort,
        search,
        bypassApprovalsAndSandbox: bypass,
        sandboxMode: appServerExtraArgs.sandboxMode,
        imagePaths,
        sessionId,
        timeoutSec,
        onLog,
        onSpawn,
        requestApproval: ctx.requestApproval,
        waitForApproval: ctx.waitForApproval,
        abortSignal: ctx.abortSignal
          ? AbortSignal.any([ctx.abortSignal, readinessLeaseAbortController.signal])
          : readinessLeaseAbortController.signal,
        controlAttempt: ctx.controlAttempt,
        onProviderAuthFailure: persistAuthFailureGate,
      });
      const appEndedAt = new Date();
      const providerAuthFailure = isCodexProviderAuthFailure(
        appResult.errorMessage,
        appResult.stdout,
        appResult.stderr,
      );
      if (providerAuthFailure && readinessFingerprint) {
        await persistAuthFailureGate();
      } else if (!providerAuthFailure && readinessFingerprint) {
        await clearAuthFailureGate();
        if (appResult.exitCode === 0 && appResult.signal === null) {
          await clearObservedAuthSuccess();
        }
      }
      const inlineVisuals = appResult.sessionId
        && appResult.exitCode === 0
        && appResult.signal === null
        ? await captureCodexInlineVisuals({
          body: codexInlineVisualDirectiveBody(appResult.summary),
          codexHome: effectiveCodexHome,
          threadId: appResult.sessionId,
          startedAt: appStartedAt,
          endedAt: appEndedAt,
        }).catch(async () => {
          await onLog("stderr", "[rudder] Codex inline visual capture failed; the visual will be unavailable.\n").catch(() => {});
          return [];
        })
        : [];
      const estimatedCostUsd =
        billingType === "subscription" && countSubscriptionUsageAsCost
          ? estimateCodexCostUsd(model, appResult.usage)
          : null;
      const resolvedSessionParams = buildCodexSessionParams({
        sessionId: appResult.sessionId,
        native: appResult.sessionParams,
        chatDeveloperInstructionsRevision: appResult.chatDeveloperInstructionsRevision
          ?? persistedDeveloperInstructionsRevision,
        cwd,
        workspaceId,
        repoUrl: workspaceRepoUrl,
        repoRef: workspaceRepoRef,
        profile: profileSessionParams,
        transport: "codex_app_server",
      });
      return {
        exitCode: appResult.exitCode,
        signal: appResult.signal,
        timedOut: appResult.timedOut,
        nativeWriterQuiescence: appResult.nativeWriterQuiescence,
        errorMessage: appResult.errorMessage,
        ...(providerAuthFailure ? { errorCode: "codex_provider_auth_required" } : {}),
        usage: appResult.usage,
        sessionId: appResult.sessionId,
        sessionParams: resolvedSessionParams,
        sessionDisplayId: appResult.sessionId,
        provider: "openai",
        biller: resolveCodexBiller(effectiveEnv, billingType),
        model,
        billingType: resolveCodexResultBillingType(
          billingType,
          countSubscriptionUsageAsCost,
          estimatedCostUsd !== null,
        ),
        costUsd: estimatedCostUsd,
        resultJson: {
          stdout: appResult.stdout,
          stderr: appResult.stderr,
          providerThreadId: appResult.sessionId,
          providerTurnId: appResult.providerTurnId,
          transport: "codex_app_server",
          ...(providerAuthFailure
            ? {
              providerFailure: {
                classification: "authentication",
                retryable: false,
                shortCircuited: true,
                reason: "codex_provider_auth_required",
                ...(readinessFingerprint
                  ? { readinessFingerprint, readinessState: "failed" }
                  : {}),
              },
            }
            : {}),
          ...(inlineVisuals.length > 0 ? { inlineVisuals } : {}),
        },
        summary: appResult.summary,
        clearSession: appResult.clearSession,
      };
    } finally {
      await stopReadinessLeaseRenewal();
      await clearAuthFailureGate();
    }
  }

  const buildArgs = (resumeSessionId: string | null) => {
    const args = ["exec", "--json"];
    if (search) args.unshift("--search");
    if (bypass) args.push("--dangerously-bypass-approvals-and-sandbox");
    if (model) args.push("--model", model);
    if (modelReasoningEffort) args.push("-c", `model_reasoning_effort=${JSON.stringify(modelReasoningEffort)}`);
    for (const imagePath of imagePaths) {
      args.push("--image", imagePath);
    }
    if (["chat", "product_intelligence"].includes(runtimeScene) && !hasCliArg(extraArgs, "--skip-git-repo-check")) {
      args.push("--skip-git-repo-check");
    }
    if (extraArgs.length > 0) args.push(...extraArgs);
    if (resumeSessionId) args.push("resume", resumeSessionId, "-");
    else args.push("-");
    return args;
  };

  const transportContinuationPrompt = [
    "The previous Codex turn was interrupted by a temporary provider transport disconnect before Rudder received a terminal response.",
    "Continue the existing task from the current Codex session and workspace state.",
    "Inspect the current state before acting. Do not repeat completed actions or resubmit an external side effect unless you can verify it did not complete.",
    "When the task is complete, provide the final response.",
  ].join("\n");

  const runAttempt = async (
    resumeSessionId: string | null,
    attemptPrompt = prompt,
    isTransportContinuation = false,
  ) => {
    const startedAt = new Date();
    const args = buildArgs(resumeSessionId);
    const attemptCommandNotes = isTransportContinuation
      ? [...commandNotes, "Continuing the same Codex session once after a provider transport disconnect."]
      : commandNotes;
    if (onMeta) {
      await onMeta({
        agentRuntimeType: "codex_local",
        command,
        cwd,
        commandNotes: attemptCommandNotes,
        commandArgs: args.map((value, idx) => {
          if (idx === args.length - 1 && value !== "-") return `<prompt ${attemptPrompt.length} chars>`;
          return value;
        }),
        env: redactEnvForLogs(env),
        prompt: attemptPrompt,
        agentInstructionStack: attemptPrompt,
        promptMetrics: isTransportContinuation
          ? { ...promptMetrics, promptChars: attemptPrompt.length }
          : promptMetrics,
        loadedMcpServers,
        loadedSkills,
        realizedSkills: loadedSkills,
        rudderMcp: rudderMcpRuntimeMetadata({ browserEnabled, preflight: rudderMcpPreflight }),
        browserMcp: rudderBrowserMcpRuntimeMetadata({
          available: browserEnabled,
          preflight: browserMcpPreflight,
        }),
        context: isTransportContinuation
          ? { ...context, rudderCodexTransportRecovery: true }
          : context,
      });
    }

    let stderrBuffer = "";
    let authScanBuffer = "";
    let providerAuthFailure: string | null = null;
    const attemptAbortController = new AbortController();
    const forwardExternalAbort = () => attemptAbortController.abort(ctx.abortSignal?.reason);
    const forwardReadinessLeaseAbort = () => attemptAbortController.abort(readinessLeaseAbortController.signal.reason);
    if (ctx.abortSignal?.aborted) forwardExternalAbort();
    else ctx.abortSignal?.addEventListener("abort", forwardExternalAbort, { once: true });
    if (readinessLeaseAbortController.signal.aborted) forwardReadinessLeaseAbort();
    else readinessLeaseAbortController.signal.addEventListener("abort", forwardReadinessLeaseAbort, { once: true });
    const isBenignStderrLine = createCodexStderrLineFilter();
    const flushBufferedStderr = async (force: boolean) => {
      if (!stderrBuffer) return;
      const { lines, remainder } = splitCompleteLines(stderrBuffer);
      stderrBuffer = force ? "" : remainder;
      const emittedLines = force ? [...lines, ...(remainder ? [remainder] : [])] : lines;
      for (const line of emittedLines) {
        if (isBenignStderrLine(line)) continue;
        if (providerAuthFailure && isCodexProviderAuthFailure(line)) continue;
        await onLog("stderr", line);
      }
    };

    const proc = await runChildProcess(runId, executableCommand, args, {
      cwd,
      env,
      stdin: attemptPrompt,
      timeoutSec,
      graceSec,
      onSpawn,
      abortSignal: attemptAbortController.signal,
      onLog: async (stream, chunk) => {
        if (stream !== "stderr") {
          await onLog(stream, chunk);
          return;
        }
        authScanBuffer = (authScanBuffer + chunk).slice(-CODEX_STDERR_LINE_BUFFER_LIMIT);
        if (!providerAuthFailure && isCodexProviderAuthFailure(authScanBuffer)) {
          providerAuthFailure = authScanBuffer
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => isCodexProviderAuthFailure(line))
            ?? firstMeaningfulErrorLine(authScanBuffer);
          await persistAuthFailureGate();
          attemptAbortController.abort(
            createTerminalFailureAbortReason(CODEX_AUTH_FAILURE_HARD_DEADLINE_MS),
          );
        }
        stderrBuffer += chunk;
        if (stderrBuffer.length > CODEX_STDERR_LINE_BUFFER_LIMIT) {
          const overflow = stderrBuffer.slice(0, stderrBuffer.length - CODEX_STDERR_LINE_BUFFER_LIMIT);
          stderrBuffer = stderrBuffer.slice(-CODEX_STDERR_LINE_BUFFER_LIMIT);
          if (!isBenignStderrLine(overflow)) await onLog("stderr", overflow);
        }
        await flushBufferedStderr(false);
      },
    }).finally(() => {
      ctx.abortSignal?.removeEventListener("abort", forwardExternalAbort);
      readinessLeaseAbortController.signal.removeEventListener("abort", forwardReadinessLeaseAbort);
    });
    await flushBufferedStderr(true);
    const cleanedStderr = stripCodexBenignStderr(proc.stderr)
      .split(/(?<=\n)/u)
      .filter((line) => !isCodexProviderAuthFailure(line))
      .join("");
    return {
      proc: {
        ...proc,
        stderr: cleanedStderr,
      },
      rawStderr: proc.stderr,
      parsed: parseCodexJsonl(proc.stdout),
      providerAuthFailure,
      startedAt,
      endedAt: new Date(),
    };
  };

  const toResult = async (
    attempt: { proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string; pid?: number | null; startedAt?: string | null }; rawStderr: string; parsed: ReturnType<typeof parseCodexJsonl>; providerAuthFailure: string | null; startedAt: Date; endedAt: Date },
    clearSessionOnMissingSession = false,
    transportRecovery?: {
      kind: "codex_transport_disconnect";
      outcome: "succeeded" | "failed";
      sessionId: string;
      initialError: string;
    },
  ): Promise<AgentRuntimeExecutionResult> => {
    if (attempt.providerAuthFailure && readinessFingerprint) {
      await persistAuthFailureGate();
    } else if (readinessFingerprint) {
      await clearAuthFailureGate();
      if (attempt.proc.exitCode === 0 && attempt.proc.signal === null && !attempt.proc.timedOut) {
        await clearObservedAuthSuccess();
      }
    }
    if (attempt.proc.timedOut) {
      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: true,
        nativeWriterQuiescence: attempt.proc.pid != null && attempt.proc.startedAt != null
          ? { status: "confirmed", source: "process_exit" }
          : { status: "unconfirmed", reason: "Codex timed out before child-process exit was observed." },
        errorMessage: `Timed out after ${timeoutSec}s`,
        ...(transportRecovery ? { errorCode: "codex_transport_continuation_failed" } : {}),
        ...(transportRecovery ? { resultJson: { transportRecovery } } : {}),
        clearSession: clearSessionOnMissingSession,
      };
    }

    const resolvedSessionId = attempt.parsed.sessionId ?? runtimeSessionId ?? runtime.sessionId ?? null;
    const resolvedSessionParams = buildCodexSessionParams({
      sessionId: resolvedSessionId,
      cwd,
      workspaceId,
      repoUrl: workspaceRepoUrl,
      repoRef: workspaceRepoRef,
      profile: profileSessionParams,
      transport: "codex_cli",
    });
    const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
    const stderrLine = firstMeaningfulErrorLine(attempt.proc.stderr);
    const fallbackErrorMessage =
      attempt.providerAuthFailure ||
      parsedError ||
      stderrLine ||
      `Codex exited with code ${attempt.proc.exitCode ?? -1}`;

    const networkSuspension = classifyAgentRuntimeNetworkFailure({
      errorCode: transportRecovery ? "codex_transport_continuation_failed" : null,
      message: transportRecovery?.initialError || parsedError || null,
      stdout: attempt.proc.stdout,
      stderr: attempt.rawStderr,
      provider: "openai",
      model,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      modelOutputObserved: attempt.parsed.modelOutputObserved,
      toolActivityObserved: attempt.parsed.toolActivityObserved,
      terminalEventObserved: attempt.parsed.terminalEventObserved,
    });

    const estimatedCostUsd =
      billingType === "subscription" && countSubscriptionUsageAsCost
        ? estimateCodexCostUsd(model, attempt.parsed.usage)
        : null;
    const resultBillingType = resolveCodexResultBillingType(
      billingType,
      countSubscriptionUsageAsCost,
      estimatedCostUsd !== null,
    );
    const inlineVisuals = resolvedSessionId
      && attempt.proc.exitCode === 0
      && attempt.proc.signal === null
      ? await captureCodexInlineVisuals({
        body: codexInlineVisualDirectiveBody(attempt.parsed.summary),
        codexHome: effectiveCodexHome,
        threadId: resolvedSessionId,
        startedAt: attempt.startedAt,
        endedAt: attempt.endedAt,
      }).catch(async () => {
        await onLog("stderr", "[rudder] Codex inline visual capture failed; the visual will be unavailable.\n").catch(() => {});
        return [];
      })
      : [];

    const resultJson = {
      stdout: attempt.proc.stdout,
      stderr: attempt.proc.stderr,
      ...(inlineVisuals.length > 0 ? { inlineVisuals } : {}),
      ...(transportRecovery ? { transportRecovery } : {}),
      ...(attempt.providerAuthFailure
        ? {
          providerFailure: {
            classification: "authentication",
            retryable: false,
            shortCircuited: true,
            reason: "codex_provider_auth_required",
            ...(readinessFingerprint
              ? { readinessFingerprint, readinessState: "failed" }
              : {}),
          },
        }
        : {}),
    };
    return {
      exitCode: attempt.proc.exitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      nativeWriterQuiescence: attempt.proc.pid != null && attempt.proc.startedAt != null
        ? { status: "confirmed", source: "process_exit" }
        : { status: "unconfirmed", reason: "Codex child-process exit was not observed." },
      errorMessage:
        attempt.proc.exitCode === 0 && attempt.proc.signal === null && !attempt.providerAuthFailure
          ? null
          : fallbackErrorMessage,
      ...(attempt.providerAuthFailure ? { errorCode: "codex_provider_auth_required" } : {}),
      ...(networkSuspension ? { networkSuspension } : {}),
      ...(!attempt.providerAuthFailure && transportRecovery && (attempt.proc.exitCode ?? 0) !== 0
        ? { errorCode: "codex_transport_continuation_failed" }
        : {}),
      usage: attempt.parsed.usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "openai",
      biller: resolveCodexBiller(effectiveEnv, billingType),
      model,
      billingType: resultBillingType,
      costUsd: estimatedCostUsd,
      resultJson,
      summary: attempt.parsed.summary,
      clearSession: Boolean(clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  let cliControlLease: AgentRuntimeControlHandleLease | null = null;
  try {
    if (ctx.controlAttempt) {
      cliControlLease = await ctx.controlAttempt.register({
        runtimeType: "codex_local",
        providerThreadId: sessionId,
        providerTurnId: null,
        capabilities: { steer: "interrupt_continue", interrupt: "process" },
        async steer() {
          return {
            disposition: "unsupported",
            reason: "Codex exec cannot append input to an active turn",
          };
        },
        async interrupt() {
          return ctx.abortSignal?.aborted ? "acknowledged" : "unverified";
        },
        async dispose() {
          // Process lifetime is owned by runChildProcess and the attempt abort signal.
        },
      });
      if (!cliControlLease) {
        throw new Error("Codex exec control handle lost its attempt lease");
      }
    }

    const initial = await runAttempt(sessionId);
    const transportRecoverySessionId = initial.parsed.sessionId ?? sessionId;
    if (
      !ctx.abortSignal?.aborted
      && transportRecoverySessionId
      && !initial.proc.timedOut
      && (initial.proc.exitCode ?? 0) !== 0
      && !initial.parsed.terminalEventObserved
      && !initial.parsed.terminalCompleted
      && !initial.parsed.modelOutputObserved
      && !initial.providerAuthFailure
      && isCodexTransportDisconnectError(initial.proc.stdout, initial.rawStderr)
    ) {
      const initialError = initial.parsed.errorMessage?.trim() || firstMeaningfulErrorLine(initial.proc.stderr);
      await onLog(
        "stdout",
        `[rudder] Codex stream disconnected before completion; continuing Codex session "${transportRecoverySessionId}" once.\n`,
      );
      const retry = await runAttempt(
        transportRecoverySessionId,
        transportContinuationPrompt,
        true,
      );
      return await toResult(retry, false, {
        kind: "codex_transport_disconnect",
        outcome: retry.proc.exitCode === 0 && retry.proc.signal === null && !retry.proc.timedOut
          ? "succeeded"
          : "failed",
        sessionId: transportRecoverySessionId,
        initialError,
      });
    }
    if (
      sessionId &&
      !initial.proc.timedOut &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      isCodexUnknownSessionError(initial.proc.stdout, initial.rawStderr)
    ) {
      await onLog(
        "stderr",
        `[rudder] Codex resume session "${sessionId}" was rejected; a fresh session is not allowed.\n`,
      );
      const rejected = await toResult(initial);
      return {
        ...rejected,
        errorCode: "codex_resume_rejected",
        errorMessage: rejected.errorMessage || `Codex resume session "${sessionId}" was rejected.`,
        clearSession: false,
        resultJson: {
          ...(rejected.resultJson ?? {}),
          resume: { status: "rejected", reason: "provider_unknown_session" },
        },
      };
    }

    return await toResult(initial);
  } finally {
    await cliControlLease?.release().catch(() => undefined);
    await stopReadinessLeaseRenewal();
    await clearAuthFailureGate();
  }
}
