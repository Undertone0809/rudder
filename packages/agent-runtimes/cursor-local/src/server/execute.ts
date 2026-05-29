import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inferOpenAiCompatibleBiller, type AgentRuntimeExecutionContext, type AgentRuntimeExecutionResult } from "@rudderhq/agent-runtime-utils";
import { applyGitCredentialHelperPolicyEnv, applyGitIdentityPreparationEnv, ensureGitIdentityFileConfig } from "@rudderhq/agent-runtime-utils/git-identity";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildRudderEnv,
  redactEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensureLocalCliCredentialShimsInPath,
  ensureRudderRuntimeSkillSymlinks,
  ensureRudderCliInPath,
  ensurePathInEnv,
  resolveLocalOperatorHome,
  syncLocalCliCredentialHomeEntries,
  readRudderRuntimeSkillEntries,
  resolveRudderDesiredSkillNames,
  renderTemplate,
  renderRudderRuntimeSkillBoundaryPrompt,
  joinPromptSections,
  loadAgentInstructionsPrefix,
  runChildProcess,
  selectPromptTemplate,
} from "@rudderhq/agent-runtime-utils/server-utils";
import { DEFAULT_CURSOR_LOCAL_COMMAND, DEFAULT_CURSOR_LOCAL_MODEL } from "../index.js";
import {
  detectCursorAuthRequired,
  detectCursorToolHandlerUnsupported,
  parseCursorJsonl,
  isCursorUnknownSessionError,
} from "./parse.js";
import { normalizeCursorStreamLine } from "../shared/stream.js";
import { hasCursorTrustBypassArg } from "../shared/trust.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUDDER_INSTANCE_ID = "default";

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function resolveCursorBillingType(env: Record<string, string>): "api" | "subscription" {
  return hasNonEmptyEnvValue(env, "CURSOR_API_KEY") || hasNonEmptyEnvValue(env, "OPENAI_API_KEY")
    ? "api"
    : "subscription";
}

function resolveCursorBiller(
  env: Record<string, string>,
  billingType: "api" | "subscription",
  provider: string | null,
): string {
  const openAiCompatibleBiller = inferOpenAiCompatibleBiller(env, null);
  if (openAiCompatibleBiller === "openrouter") return "openrouter";
  if (billingType === "subscription") return "cursor";
  return provider ?? "cursor";
}

function resolveProviderFromModel(model: string): string | null {
  const trimmed = model.trim().toLowerCase();
  if (!trimmed) return null;
  const slash = trimmed.indexOf("/");
  if (slash > 0) return trimmed.slice(0, slash);
  if (trimmed.includes("sonnet") || trimmed.includes("claude")) return "anthropic";
  if (trimmed.startsWith("gpt") || trimmed.startsWith("o")) return "openai";
  return null;
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
    "Use Cursor's runtime shell command capability with the Rudder-managed CLI for Rudder control-plane work.",
    "Read example:",
    "  \"${RUDDER_CLI:-rudder}\" agent me --json",
    "Common mutating examples:",
    "  \"${RUDDER_CLI:-rudder}\" issue checkout {id} --json",
    "  printf '%s\\n' \"progress\" | \"${RUDDER_CLI:-rudder}\" issue comment {id} --body-file - --json",
    "  printf '%s\\n' \"done\" | \"${RUDDER_CLI:-rudder}\" issue done {id} --comment-file - --json",
    "  \"${RUDDER_CLI:-rudder}\" agent hire --org-id \"$RUDDER_ORG_ID\" --payload '{\"name\":\"<requested helper name>\",\"role\":\"<requested helper role>\",\"title\":\"<requested helper title or name>\",\"capabilities\":\"<requested helper capabilities>\",\"desiredSkills\":[\"<requested org skill ref>\"],\"agentRuntimeType\":\"<requested runtime type>\",\"agentRuntimeConfig\":{}}' --json",
    "",
    "",
  ].join("\n");
}

function hasCursorResultEvent(stdout: string): boolean {
  return parseCursorJsonl(stdout).resultSeen;
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

function resolveSharedCursorHomeDir(env: NodeJS.ProcessEnv): string {
  return path.resolve(nonEmpty(env.HOME) ?? os.homedir());
}

function resolveManagedCursorHomeDir(env: NodeJS.ProcessEnv, orgId: string, agentId: string): string {
  const rudderHome = nonEmpty(env.RUDDER_HOME) ?? path.resolve(os.homedir(), ".rudder");
  const instanceId = nonEmpty(env.RUDDER_INSTANCE_ID) ?? DEFAULT_RUDDER_INSTANCE_ID;
  return path.resolve(rudderHome, "instances", instanceId, "organizations", orgId, "cursor-home", "agents", agentId);
}

function resolveManagedCursorSkillsDir(homeDir: string): string {
  return path.join(homeDir, ".cursor", "skills");
}

const CURSOR_SKILL_HOME_ENTRIES = new Set(["skills", "skills-cursor"]);

async function removeManagedCursorSkillEntry(targetCursorDir: string, entryName: string): Promise<void> {
  const target = path.join(targetCursorDir, entryName);
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) return;

  if (entryName === "skills" && existing.isDirectory() && !existing.isSymbolicLink()) {
    return;
  }

  await fs.rm(target, { recursive: true, force: true });
}

async function syncCursorSharedHomeEntries(sourceHome: string, targetHome: string) {
  const sourceCursorDir = path.join(sourceHome, ".cursor");
  const entries = await fs.readdir(sourceCursorDir, { withFileTypes: true }).catch(() => []);
  const targetCursorDir = path.join(targetHome, ".cursor");
  await fs.mkdir(targetCursorDir, { recursive: true });
  for (const entryName of CURSOR_SKILL_HOME_ENTRIES) {
    await removeManagedCursorSkillEntry(targetCursorDir, entryName);
  }
  for (const entry of entries) {
    if (CURSOR_SKILL_HOME_ENTRIES.has(entry.name)) continue;
    await ensureSymlink(
      path.join(targetCursorDir, entry.name),
      path.join(sourceCursorDir, entry.name),
    );
  }
}

async function syncCursorMacOSKeychainSearchPath(sourceHome: string, targetHome: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;

  const sourceKeychainsDir = path.join(sourceHome, "Library", "Keychains");
  if (!(await pathExists(sourceKeychainsDir))) return false;

  await ensureSymlink(
    path.join(targetHome, "Library", "Keychains"),
    sourceKeychainsDir,
  );
  return true;
}

async function prepareManagedCursorHome(
  env: NodeJS.ProcessEnv,
  onLog: AgentRuntimeExecutionContext["onLog"],
  orgId: string,
  agentId: string,
): Promise<string> {
  const sourceHome = resolveSharedCursorHomeDir(env);
  const targetHome = resolveManagedCursorHomeDir(env, orgId, agentId);
  if (targetHome === sourceHome) return targetHome;

  await fs.mkdir(resolveManagedCursorSkillsDir(targetHome), { recursive: true });
  if (await pathExists(path.join(sourceHome, ".cursor"))) {
    await syncCursorSharedHomeEntries(sourceHome, targetHome);
  }
  const keychainLinked = await syncCursorMacOSKeychainSearchPath(sourceHome, targetHome);

  await onLog(
    "stdout",
    `[rudder] Using Rudder-managed Cursor home "${targetHome}" (seeded from "${sourceHome}").\n`,
  );
  if (keychainLinked) {
    await onLog(
      "stdout",
      "[rudder] Shared macOS Keychain search path into managed Cursor home for subscription authentication.\n",
    );
  }
  return targetHome;
}

function cursorSkillsHome(): string {
  return path.join(os.homedir(), ".cursor", "skills");
}

type EnsureCursorSkillsInjectedOptions = {
  skillsDir?: string | null;
  skillsEntries?: Array<{ key: string; runtimeName: string; source: string }>;
  desiredSkillKeys?: string[];
  skillsHome?: string;
  linkSkill?: (source: string, target: string) => Promise<void>;
};

export async function ensureCursorSkillsInjected(
  onLog: AgentRuntimeExecutionContext["onLog"],
  options: EnsureCursorSkillsInjectedOptions = {},
) {
  const skillsEntries = options.skillsEntries
    ?? (options.skillsDir
      ? (await fs.readdir(options.skillsDir, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => ({
            key: entry.name,
            runtimeName: entry.name,
            source: path.join(options.skillsDir!, entry.name),
          }))
      : await readRudderRuntimeSkillEntries({}, __moduleDir));
  if (skillsEntries.length === 0) return;

  const skillsHome = options.skillsHome ?? cursorSkillsHome();
  await ensureRudderRuntimeSkillSymlinks({
    onLog,
    runtimeLabel: "Cursor",
    skillsHome,
    availableEntries: skillsEntries,
    desiredSkillKeys: options.desiredSkillKeys ?? [],
    linkSkill: options.linkSkill,
    pruneUnselected: false,
    replaceConflictingEntries: false,
  });
}

export async function execute(ctx: AgentRuntimeExecutionContext): Promise<AgentRuntimeExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = selectPromptTemplate(
    asString(config.promptTemplate, ""),
    context,
  );
  const command = asString(config.command, DEFAULT_CURSOR_LOCAL_COMMAND);
  const model = asString(config.model, DEFAULT_CURSOR_LOCAL_MODEL).trim();

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
  const orgPlansDir = asString(workspaceContext.orgPlansDir, "");
  const orgArtifactsDir = asString(
    workspaceContext.orgArtifactsDir,
    orgWorkspaceRoot ? path.join(orgWorkspaceRoot, "artifacts") : "",
  );
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
  const sourceEnv = {
    ...process.env,
    ...Object.fromEntries(
      Object.entries(envConfig).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  };
  const operatorHome = resolveLocalOperatorHome(sourceEnv);
  const managedHome = await prepareManagedCursorHome(sourceEnv, onLog, agent.orgId, agent.id);
  await syncLocalCliCredentialHomeEntries({ sourceHome: operatorHome, targetHome: managedHome, onLog });
  const preparedGitIdentity = await ensureGitIdentityFileConfig({
    cwd,
    home: managedHome,
    sourceEnv,
    onLog,
  });
  const cursorSkillEntries = await readRudderRuntimeSkillEntries(config, __moduleDir);
  const desiredCursorSkillNames = resolveRudderDesiredSkillNames(config, cursorSkillEntries);
  const loadedSkills = await ensureRudderRuntimeSkillSymlinks({
    onLog,
    runtimeLabel: "Cursor",
    skillsHome: resolveManagedCursorSkillsDir(managedHome),
    availableEntries: cursorSkillEntries,
    desiredSkillKeys: desiredCursorSkillNames,
  });
  const hasExplicitApiKey =
    typeof envConfig.RUDDER_API_KEY === "string" && envConfig.RUDDER_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildRudderEnv(agent) };
  env.HOME = managedHome;
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
  if (workspaceId) {
    env.RUDDER_WORKSPACE_ID = workspaceId;
  }
  if (workspaceRepoUrl) {
    env.RUDDER_WORKSPACE_REPO_URL = workspaceRepoUrl;
  }
  if (workspaceRepoRef) {
    env.RUDDER_WORKSPACE_REPO_REF = workspaceRepoRef;
  }
  if (agentHome) {
    env.AGENT_HOME = agentHome;
    env.RUDDER_AGENT_ROOT = agentHome;
  }
  if (agentInstructionsDir) env.RUDDER_AGENT_INSTRUCTIONS_DIR = agentInstructionsDir;
  if (agentMemoryDir) env.RUDDER_AGENT_MEMORY_DIR = agentMemoryDir;
  if (agentSkillsDir) env.RUDDER_AGENT_SKILLS_DIR = agentSkillsDir;
  if (orgWorkspaceRoot) env.RUDDER_ORG_WORKSPACE_ROOT = orgWorkspaceRoot;
  if (orgSkillsDir) env.RUDDER_ORG_SKILLS_DIR = orgSkillsDir;
  if (orgPlansDir) env.RUDDER_ORG_PLANS_DIR = orgPlansDir;
  if (orgArtifactsDir) env.RUDDER_ORG_ARTIFACTS_DIR = orgArtifactsDir;
  if (workspaceHints.length > 0) {
    env.RUDDER_WORKSPACES_JSON = JSON.stringify(workspaceHints);
  }
  for (const [k, v] of Object.entries(envConfig)) {
    if (k === "HOME") continue;
    if (typeof v === "string") env[k] = v;
  }
  env.HOME = managedHome;
  env.RUDDER_OPERATOR_HOME = operatorHome;
  if (!hasExplicitApiKey && authToken) {
    env.RUDDER_API_KEY = authToken;
  }
  applyGitIdentityPreparationEnv(env, preparedGitIdentity);
  applyGitCredentialHelperPolicyEnv(env);
  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const billingType = resolveCursorBillingType(effectiveEnv);
  const runtimeEnv = await ensureLocalCliCredentialShimsInPath({
    operatorHome,
    targetHome: managedHome,
    cwd,
    env: ensurePathInEnv(await ensureRudderCliInPath(__moduleDir, effectiveEnv)),
    onLog,
  });
  if (typeof runtimeEnv.PATH === "string") env.PATH = runtimeEnv.PATH;
  if (typeof runtimeEnv.Path === "string") env.Path = runtimeEnv.Path;
  if (typeof runtimeEnv.RUDDER_CLI === "string") env.RUDDER_CLI = runtimeEnv.RUDDER_CLI;
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();
  const autoTrustEnabled = !hasCursorTrustBypassArg(extraArgs);

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
      `[rudder] Cursor session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const loadedInstructions = await loadAgentInstructionsPrefix({
    instructionsFilePath,
    onLog,
  });
  const instructionsPrefix = loadedInstructions.prefix;
  const instructionsDir = loadedInstructions.instructionsDir;
  const commandNotes = (() => {
    const notes: string[] = [];
    if (autoTrustEnabled) {
      notes.push("Auto-added -f to force non-interactive command allowance.");
    }
    notes.push("Prompt is piped to Cursor via stdin.");
    if (!instructionsFilePath) {
      notes.push(...loadedInstructions.commandNotes, "Prepended Rudder operating contract and runtime skill boundary to prompt.");
      return notes;
    }
    if (instructionsPrefix.length > 0) {
      notes.push(
        ...loadedInstructions.commandNotes,
        `Prepended instructions + path directive, Rudder operating contract, and runtime skill boundary to prompt (relative references from ${instructionsDir}).`,
      );
      return notes;
    }
    notes.push(...loadedInstructions.commandNotes, "Prepended Rudder operating contract and runtime skill boundary to prompt.");
    return notes;
  })();

  /**
   * Final prompt assembly order is intentional and shared across runtimes:
   * 1) optional injected instructions prefix,
   * 2) optional bootstrap prompt (only when not resuming a prior session),
   * 3) optional session handoff markdown,
   * 4) runtime-specific env note,
   * 5) heartbeat prompt selected by wake trigger (assignment, mention, retry, fallback).
   *
   * Prompt example (assignment wakeup):
   * [instructions prefix]
   * [bootstrap prompt]
   * [session handoff note]
   * [runtime env note]
   * You are agent agent-123 (Frontend Maintainer). You have been assigned to work on an issue.
   * Issue: "Fix onboarding redirect"
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
  const skillBoundaryPrompt = renderRudderRuntimeSkillBoundaryPrompt(loadedSkills);
  const rudderEnvNote = renderRudderEnvNote(env);
  const apiAccessNote = renderApiAccessNote(env);
  const prompt = joinPromptSections([
    instructionsPrefix,
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

  const buildArgs = (resumeSessionId: string | null) => {
    const args = ["-p", "--output-format", "stream-json"];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (model) args.push("--model", model);
    if (autoTrustEnabled) args.push("-f");
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        agentRuntimeType: "cursor",
        command,
        cwd,
        commandNotes,
        commandArgs: args,
        env: redactEnvForLogs(env),
        prompt,
        promptMetrics,
        loadedSkills,
        context,
      });
    }

    let stdoutLineBuffer = "";
    const emitNormalizedStdoutLine = async (rawLine: string) => {
      const normalized = normalizeCursorStreamLine(rawLine);
      if (!normalized.line) return;
      await onLog(normalized.stream ?? "stdout", `${normalized.line}\n`);
    };
    const flushStdoutChunk = async (chunk: string, finalize = false) => {
      const combined = `${stdoutLineBuffer}${chunk}`;
      const lines = combined.split(/\r?\n/);
      stdoutLineBuffer = lines.pop() ?? "";

      for (const line of lines) {
        await emitNormalizedStdoutLine(line);
      }

      if (finalize) {
        const trailing = stdoutLineBuffer.trim();
        stdoutLineBuffer = "";
        if (trailing) {
          await emitNormalizedStdoutLine(trailing);
        }
      }
    };

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env,
      timeoutSec,
      graceSec,
      stdin: prompt,
      onSpawn,
      abortSignal: ctx.abortSignal,
      shouldTerminate: (event) =>
        (event.stream === "stdout" && hasCursorResultEvent(event.stdout)) ||
        detectCursorToolHandlerUnsupported(event.stdout, event.stderr),
      onLog: async (stream, chunk) => {
        if (stream !== "stdout") {
          await onLog(stream, chunk);
          return;
        }
        await flushStdoutChunk(chunk);
      },
    });
    await flushStdoutChunk("", true);

    return {
      proc,
      parsed: parseCursorJsonl(proc.stdout),
    };
  };

  const providerFromModel = resolveProviderFromModel(model);

  const toResult = (
    attempt: {
      proc: {
        exitCode: number | null;
        signal: string | null;
        timedOut: boolean;
        terminatedEarly?: boolean;
        stdout: string;
        stderr: string;
      };
      parsed: ReturnType<typeof parseCursorJsonl>;
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

    const resolvedSessionId = attempt.parsed.sessionId ?? runtimeSessionId ?? runtime.sessionId ?? null;
    const resolvedSessionParams = resolvedSessionId
      ? ({
          sessionId: resolvedSessionId,
          cwd,
          ...(workspaceId ? { workspaceId } : {}),
          ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
          ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
        } as Record<string, unknown>)
      : null;
    const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
    const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
    const authRequired = detectCursorAuthRequired(attempt.proc.stdout, attempt.proc.stderr);
    const toolHandlerUnsupported = detectCursorToolHandlerUnsupported(attempt.proc.stdout, attempt.proc.stderr);
    const completedBeforeTermination =
      attempt.parsed.resultSeen &&
      !attempt.parsed.resultIsError &&
      attempt.proc.terminatedEarly === true;
    const resolvedExitCode = completedBeforeTermination ? 0 : attempt.proc.exitCode;
    const failed =
      resolvedExitCode !== 0 &&
      !(resolvedExitCode === null && attempt.proc.signal === null);
    const fallbackErrorMessage =
      parsedError ||
      (authRequired ? "Cursor CLI authentication is required." : "") ||
      (toolHandlerUnsupported ? "Cursor CLI tool execution failed: no handler found for a server tool message." : "") ||
      stderrLine ||
      `Cursor exited with code ${attempt.proc.exitCode ?? -1}`;

    return {
      exitCode: resolvedExitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage:
        !failed
          ? null
          : fallbackErrorMessage,
      errorCode:
        failed && authRequired
          ? "cursor_auth_required"
          : failed && toolHandlerUnsupported
            ? "cursor_tool_handler_unsupported"
            : null,
      usage: attempt.parsed.usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: providerFromModel,
      biller: resolveCursorBiller(effectiveEnv, billingType, providerFromModel),
      model,
      billingType,
      costUsd: attempt.parsed.costUsd,
      resultJson: {
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
      },
      summary: attempt.parsed.summary,
      clearSession: Boolean(clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  const initial = await runAttempt(sessionId);
  if (
    sessionId &&
    !initial.proc.timedOut &&
    (initial.proc.exitCode ?? 0) !== 0 &&
    isCursorUnknownSessionError(initial.proc.stdout, initial.proc.stderr)
  ) {
    await onLog(
      "stdout",
      `[rudder] Cursor resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
    );
    const retry = await runAttempt(null);
    return toResult(retry, true);
  }

  return toResult(initial);
}
