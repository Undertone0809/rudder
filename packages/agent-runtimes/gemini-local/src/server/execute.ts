import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRuntimeExecutionContext, AgentRuntimeExecutionResult } from "@rudderhq/agent-runtime-utils";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildRudderEnv,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensureRudderSkillSymlink,
  ensureRudderCliInPath,
  joinPromptSections,
  loadAgentInstructionsPrefix,
  ensurePathInEnv,
  readRudderRuntimeSkillEntries,
  resolveRudderDesiredSkillNames,
  removeMaintainerOnlySkillSymlinks,
  parseObject,
  redactEnvForLogs,
  renderTemplate,
  runChildProcess,
  selectPromptTemplate,
} from "@rudderhq/agent-runtime-utils/server-utils";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "../index.js";
import {
  describeGeminiFailure,
  detectGeminiAuthRequired,
  isGeminiTurnLimitResult,
  isGeminiUnknownSessionError,
  parseGeminiJsonl,
} from "./parse.js";
import { firstNonEmptyLine } from "./utils.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUDDER_INSTANCE_ID = "default";

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function resolveGeminiBillingType(env: Record<string, string>): "api" | "subscription" {
  return hasNonEmptyEnvValue(env, "GEMINI_API_KEY") || hasNonEmptyEnvValue(env, "GOOGLE_API_KEY")
    ? "api"
    : "subscription";
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
    "Use run_shell_command with the `rudder` CLI for Rudder control-plane work.",
    "Read example:",
    `  run_shell_command({ command: "rudder agent me --json" })`,
    "Mutating example:",
    `  run_shell_command({ command: "rudder issue checkout {id} --json" })`,
    "",
    "",
  ].join("\n");
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

function resolveSharedGeminiHomeDir(env: NodeJS.ProcessEnv): string {
  return path.resolve(nonEmpty(env.HOME) ?? os.homedir());
}

function resolveManagedGeminiHomeDir(env: NodeJS.ProcessEnv, orgId: string): string {
  const rudderHome = nonEmpty(env.RUDDER_HOME) ?? path.resolve(os.homedir(), ".rudder");
  const instanceId = nonEmpty(env.RUDDER_INSTANCE_ID) ?? DEFAULT_RUDDER_INSTANCE_ID;
  return path.resolve(rudderHome, "instances", instanceId, "organizations", orgId, "gemini-home");
}

function resolveManagedGeminiSkillsDir(homeDir: string): string {
  return path.join(homeDir, ".gemini", "skills");
}

async function syncGeminiSharedHomeEntries(sourceHome: string, targetHome: string) {
  const sourceGeminiDir = path.join(sourceHome, ".gemini");
  const entries = await fs.readdir(sourceGeminiDir, { withFileTypes: true }).catch(() => []);
  const targetGeminiDir = path.join(targetHome, ".gemini");
  await fs.mkdir(targetGeminiDir, { recursive: true });
  for (const entry of entries) {
    if (entry.name === "skills") continue;
    await ensureSymlink(
      path.join(targetGeminiDir, entry.name),
      path.join(sourceGeminiDir, entry.name),
    );
  }
}

async function prepareManagedGeminiHome(
  env: NodeJS.ProcessEnv,
  onLog: AgentRuntimeExecutionContext["onLog"],
  orgId: string,
): Promise<string> {
  const sourceHome = resolveSharedGeminiHomeDir(env);
  const targetHome = resolveManagedGeminiHomeDir(env, orgId);
  if (targetHome === sourceHome) return targetHome;

  await fs.mkdir(resolveManagedGeminiSkillsDir(targetHome), { recursive: true });
  if (await pathExists(path.join(sourceHome, ".gemini"))) {
    await syncGeminiSharedHomeEntries(sourceHome, targetHome);
  }

  await onLog(
    "stdout",
    `[rudder] Using Rudder-managed Gemini home "${targetHome}" (seeded from "${sourceHome}").\n`,
  );
  return targetHome;
}

function geminiSkillsHome(): string {
  return path.join(os.homedir(), ".gemini", "skills");
}

/**
 * Inject Rudder skills directly into `~/.gemini/skills/` via symlinks.
 * This avoids needing GEMINI_CLI_HOME overrides, so the CLI naturally finds
 * both its auth credentials and the injected skills in the real home directory.
 */
async function ensureGeminiSkillsInjected(
  onLog: AgentRuntimeExecutionContext["onLog"],
  skillsEntries: Array<{ key: string; runtimeName: string; source: string }>,
  desiredSkillNames?: string[],
  targetSkillsHome?: string,
): Promise<void> {
  const desiredSet = new Set(desiredSkillNames ?? skillsEntries.map((entry) => entry.key));
  const selectedEntries = skillsEntries.filter((entry) => desiredSet.has(entry.key));
  if (selectedEntries.length === 0) return;

  const skillsHome = targetSkillsHome ?? geminiSkillsHome();
  try {
    await fs.mkdir(skillsHome, { recursive: true });
  } catch (err) {
    await onLog(
      "stderr",
      `[rudder] Failed to prepare Gemini skills directory ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return;
  }
  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    skillsHome,
    selectedEntries.map((entry) => entry.runtimeName),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[rudder] Removed maintainer-only Gemini skill "${skillName}" from ${skillsHome}\n`,
    );
  }

  for (const entry of selectedEntries) {
    const target = path.join(skillsHome, entry.runtimeName);

    try {
      const result = await ensureRudderSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[rudder] ${result === "repaired" ? "Repaired" : "Linked"} Gemini skill: ${entry.key}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[rudder] Failed to link Gemini skill "${entry.key}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

export async function execute(ctx: AgentRuntimeExecutionContext): Promise<AgentRuntimeExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = selectPromptTemplate(
    asString(config.promptTemplate, ""),
    context,
  );
  const command = asString(config.command, "gemini");
  const model = asString(config.model, DEFAULT_GEMINI_LOCAL_MODEL).trim();
  const sandbox = asBoolean(config.sandbox, false);

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
  const managedHome = await prepareManagedGeminiHome(
    {
      ...process.env,
      ...Object.fromEntries(
        Object.entries(envConfig).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    },
    onLog,
    agent.orgId,
  );
  const geminiSkillEntries = await readRudderRuntimeSkillEntries(config, __moduleDir);
  const desiredGeminiSkillNames = resolveRudderDesiredSkillNames(config, geminiSkillEntries);
  await ensureGeminiSkillsInjected(
    onLog,
    geminiSkillEntries,
    desiredGeminiSkillNames,
    resolveManagedGeminiSkillsDir(managedHome),
  );

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
  if (orgPlansDir) env.RUDDER_ORG_PLANS_DIR = orgPlansDir;
  if (workspaceHints.length > 0) env.RUDDER_WORKSPACES_JSON = JSON.stringify(workspaceHints);

  for (const [key, value] of Object.entries(envConfig)) {
    if (key === "HOME") continue;
    if (typeof value === "string") env[key] = value;
  }
  env.HOME = managedHome;
  if (!hasExplicitApiKey && authToken) {
    env.RUDDER_API_KEY = authToken;
  }
  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const billingType = resolveGeminiBillingType(effectiveEnv);
  const runtimeEnv = ensurePathInEnv(await ensureRudderCliInPath(__moduleDir, effectiveEnv));
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const timeoutSec = asNumber(config.timeoutSec, 0);
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
      `[rudder] Gemini session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
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
    const notes: string[] = ["Prompt is passed to Gemini via --prompt for non-interactive execution."];
    notes.push("Added --approval-mode yolo for unattended execution.");
    if (!instructionsFilePath) return notes;
    if (instructionsPrefix.length > 0) {
      notes.push(
        ...loadedInstructions.commandNotes,
        `Prepended instructions + path directive to prompt (relative references from ${instructionsDir}).`,
      );
      return notes;
    }
    notes.push(...loadedInstructions.commandNotes);
    return notes;
  })();

  /**
   * Final prompt assembly order is intentional and shared across runtimes:
   * 1) optional injected instructions prefix,
   * 2) optional bootstrap prompt (only when not resuming a prior session),
   * 3) optional session handoff markdown,
   * 4) runtime/API access notes,
   * 5) heartbeat prompt selected by wake trigger (assignment, mention, retry, fallback).
   *
   * Prompt example (comment mention wakeup):
   * [instructions prefix]
   * [bootstrap prompt]
   * [session handoff note]
   * [runtime/API access notes]
   * You are agent agent-456 (Backend Worker). You were mentioned in a comment and your attention is needed.
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
  const rudderEnvNote = renderRudderEnvNote(env);
  const apiAccessNote = renderApiAccessNote(env);
  const prompt = joinPromptSections([
    instructionsPrefix,
    renderedBootstrapPrompt,
    sessionHandoffNote,
    rudderEnvNote,
    apiAccessNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    ...loadedInstructions.metrics,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    runtimeNoteChars: rudderEnvNote.length + apiAccessNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const buildArgs = (resumeSessionId: string | null) => {
    const args = ["--output-format", "stream-json"];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (model && model !== DEFAULT_GEMINI_LOCAL_MODEL) args.push("--model", model);
    args.push("--approval-mode", "yolo");
    if (sandbox) {
      args.push("--sandbox");
    } else {
      args.push("--sandbox=none");
    }
    if (extraArgs.length > 0) args.push(...extraArgs);
    args.push("--prompt", prompt);
    return args;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        agentRuntimeType: "gemini_local",
        command,
        cwd,
        commandNotes,
        commandArgs: args.map((value, index) => (
          index === args.length - 1 ? `<prompt ${prompt.length} chars>` : value
        )),
        env: redactEnvForLogs(env),
        prompt,
        promptMetrics,
        context,
      });
    }

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env,
      timeoutSec,
      graceSec,
      onSpawn,
      abortSignal: ctx.abortSignal,
      onLog,
    });
    return {
      proc,
      parsed: parseGeminiJsonl(proc.stdout),
    };
  };

  const toResult = (
    attempt: {
      proc: {
        exitCode: number | null;
        signal: string | null;
        timedOut: boolean;
        stdout: string;
        stderr: string;
      };
      parsed: ReturnType<typeof parseGeminiJsonl>;
    },
    clearSessionOnMissingSession = false,
    isRetry = false,
  ): AgentRuntimeExecutionResult => {
    const authMeta = detectGeminiAuthRequired({
      parsed: attempt.parsed.resultEvent,
      stdout: attempt.proc.stdout,
      stderr: attempt.proc.stderr,
    });

    if (attempt.proc.timedOut) {
      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: authMeta.requiresAuth ? "gemini_auth_required" : null,
        clearSession: clearSessionOnMissingSession,
      };
    }

    const clearSessionForTurnLimit = isGeminiTurnLimitResult(attempt.parsed.resultEvent, attempt.proc.exitCode);

    // On retry, don't fall back to old session ID — the old session was stale
    const canFallbackToRuntimeSession = !isRetry;
    const resolvedSessionId = attempt.parsed.sessionId
      ?? (canFallbackToRuntimeSession ? (runtimeSessionId ?? runtime.sessionId ?? null) : null);
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
    const structuredFailure = attempt.parsed.resultEvent
      ? describeGeminiFailure(attempt.parsed.resultEvent)
      : null;
    const fallbackErrorMessage =
      parsedError ||
      structuredFailure ||
      stderrLine ||
      `Gemini exited with code ${attempt.proc.exitCode ?? -1}`;

    return {
      exitCode: attempt.proc.exitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage: (attempt.proc.exitCode ?? 0) === 0 ? null : fallbackErrorMessage,
      errorCode: (attempt.proc.exitCode ?? 0) !== 0 && authMeta.requiresAuth ? "gemini_auth_required" : null,
      usage: attempt.parsed.usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "google",
      biller: "google",
      model,
      billingType,
      costUsd: attempt.parsed.costUsd,
      resultJson: attempt.parsed.resultEvent ?? {
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
      },
      summary: attempt.parsed.summary,
      question: attempt.parsed.question,
      clearSession: clearSessionForTurnLimit || Boolean(clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  const initial = await runAttempt(sessionId);
  if (
    sessionId &&
    !initial.proc.timedOut &&
    (initial.proc.exitCode ?? 0) !== 0 &&
    isGeminiUnknownSessionError(initial.proc.stdout, initial.proc.stderr)
  ) {
    await onLog(
      "stdout",
      `[rudder] Gemini resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
    );
    const retry = await runAttempt(null);
    return toResult(retry, true, true);
  }

  return toResult(initial);
}
