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
  joinPromptSections,
  redactEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensureLocalCliCredentialShimsInPath,
  ensureRudderRuntimeSkillSymlinks,
  ensureRudderCliInPath,
  ensurePathInEnv,
  resolveLocalOperatorHome,
  syncLocalCliCredentialHomeEntries,
  readInstalledSkillTargets,
  renderTemplate,
  runChildProcess,
  readRudderRuntimeSkillEntries,
  readSkillMetadataFromPath,
  resolveRudderDesiredSkillNames,
  selectPromptTemplate,
  loadAgentInstructionsPrefix,
  renderRudderRuntimeSkillBoundaryPrompt,
} from "@rudderhq/agent-runtime-utils/server-utils";
import {
  applyManagedOpenCodeEnv,
  prepareManagedOpenCodeHome,
  resolveManagedOpenCodeSkillsDir,
} from "./home.js";
import { isOpenCodeUnknownSessionError, parseOpenCodeJsonl } from "./parse.js";
import { ensureOpenCodeModelConfiguredAndAvailable } from "./models.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

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

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function hasOpenCodePureArg(args: string[]): boolean {
  return args.includes("--pure") || args.includes("--no-pure");
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
    "Use the runtime shell command tool with the Rudder-managed CLI for Rudder control-plane work.",
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

async function resolveOpenCodeRuntimeSkillEntries(
  config: Record<string, unknown>,
  moduleDir: string,
  skillsHome: string,
) {
  const rudderEntries = await readRudderRuntimeSkillEntries(config, moduleDir);
  const desiredSkillNames = resolveRudderDesiredSkillNames(config, rudderEntries);
  const knownKeys = new Set(rudderEntries.map((entry) => entry.key));
  const entries = [...rudderEntries];
  const installed = await readInstalledSkillTargets(skillsHome);

  for (const desiredSkillName of desiredSkillNames) {
    if (knownKeys.has(desiredSkillName)) continue;
    const installedEntry = installed.get(desiredSkillName);
    if (!installedEntry) continue;

    const source = installedEntry.targetPath ?? path.join(skillsHome, desiredSkillName);
    const metadata = await readSkillMetadataFromPath(source);
    entries.push({
      key: desiredSkillName,
      runtimeName: desiredSkillName,
      source,
      name: metadata.name ?? desiredSkillName,
      description: metadata.description,
    });
    knownKeys.add(desiredSkillName);
  }

  return {
    entries,
    desiredSkillNames,
  };
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
  if (orgArtifactsDir) env.RUDDER_ORG_ARTIFACTS_DIR = orgArtifactsDir;
  if (workspaceHints.length > 0) env.RUDDER_WORKSPACES_JSON = JSON.stringify(workspaceHints);

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const sourceEnv = { ...process.env, ...env };
  const operatorHome = resolveLocalOperatorHome(sourceEnv);
  const managedHome = await prepareManagedOpenCodeHome({
    env: sourceEnv,
    orgId: agent.orgId,
    agentId: agent.id,
    onPrepared: (message) => onLog("stdout", message),
  });
  await syncLocalCliCredentialHomeEntries({ sourceHome: operatorHome, targetHome: managedHome, onLog });
  const preparedGitIdentity = await ensureGitIdentityFileConfig({
    cwd,
    home: managedHome,
    sourceEnv,
    onLog,
  });
  Object.assign(env, applyManagedOpenCodeEnv(env, managedHome));
  env.RUDDER_OPERATOR_HOME = operatorHome;
  if (!hasExplicitApiKey && authToken) {
    env.RUDDER_API_KEY = authToken;
  }
  applyGitIdentityPreparationEnv(env, preparedGitIdentity);
  applyGitCredentialHelperPolicyEnv(env);
  const openCodeSkillsHome = resolveManagedOpenCodeSkillsDir(managedHome);
  const {
    entries: openCodeSkillEntries,
    desiredSkillNames: desiredOpenCodeSkillNames,
  } = await resolveOpenCodeRuntimeSkillEntries(config, __moduleDir, openCodeSkillsHome);
  const loadedSkills = await ensureRudderRuntimeSkillSymlinks({
    onLog,
    runtimeLabel: "OpenCode",
    skillsHome: openCodeSkillsHome,
    availableEntries: openCodeSkillEntries,
    desiredSkillKeys: desiredOpenCodeSkillNames,
  });
  const runtimeEnv = Object.fromEntries(
    Object.entries(await ensureLocalCliCredentialShimsInPath({
      operatorHome,
      targetHome: managedHome,
      cwd,
      env: ensurePathInEnv(await ensureRudderCliInPath(__moduleDir, { ...process.env, ...env })),
      onLog,
    })).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  if (typeof runtimeEnv.RUDDER_CLI === "string") env.RUDDER_CLI = runtimeEnv.RUDDER_CLI;
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();
  const usePureMode = !extraArgs.includes("--no-pure");

  await ensureOpenCodeModelConfiguredAndAvailable({
    model,
    command,
    cwd,
    env: runtimeEnv,
    pure: usePureMode,
  });

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
  const loadedInstructions = await loadAgentInstructionsPrefix({
    instructionsFilePath: resolvedInstructionsFilePath,
    onLog,
  });
  const instructionsPrefix = loadedInstructions.prefix;
  const instructionsDir = loadedInstructions.instructionsDir;

  const commandNotes = (() => {
    if (!resolvedInstructionsFilePath) {
      return [
        ...loadedInstructions.commandNotes,
        "Prepended Rudder operating contract and runtime skill boundary to stdin prompt.",
      ];
    }
    if (instructionsPrefix.length > 0) {
      return [
        ...loadedInstructions.commandNotes,
        `Prepended instructions + path directive, Rudder operating contract, and runtime skill boundary to stdin prompt (relative references from ${instructionsDir}).`,
      ];
    }
    return [
      ...loadedInstructions.commandNotes,
      "Prepended Rudder operating contract and runtime skill boundary to stdin prompt.",
    ];
  })();

  /**
   * Final prompt assembly order is intentional and shared across runtimes:
   * 1) optional injected instructions prefix,
   * 2) runtime skill boundary,
   * 3) optional bootstrap prompt (only when not resuming a prior session),
   * 4) optional session handoff markdown,
   * 5) runtime/API access notes,
   * 6) heartbeat prompt selected by wake trigger (assignment, mention, retry, fallback).
   *
   * Prompt example (assignment wakeup):
   * [instructions prefix]
   * [skill boundary]
   * [bootstrap prompt]
   * [session handoff note]
   * [runtime/API access notes]
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
    const args: string[] = [];
    if (!hasOpenCodePureArg(extraArgs)) args.push("--pure");
    args.push("run", "--format", "json");
    if (resumeSessionId) args.push("--session", resumeSessionId);
    if (model) args.push("--model", model);
    if (variant) args.push("--variant", variant);
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        agentRuntimeType: "opencode_local",
        command,
        cwd,
        commandNotes,
        commandArgs: [...args, `<stdin prompt ${prompt.length} chars>`],
        env: redactEnvForLogs(env),
        prompt,
        promptMetrics,
        loadedSkills,
        context,
      });
    }

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env: runtimeEnv,
      stdin: prompt,
      timeoutSec,
      graceSec,
      onSpawn,
      abortSignal: ctx.abortSignal,
      onLog,
    });
    return {
      proc,
      rawStderr: proc.stderr,
      parsed: parseOpenCodeJsonl(proc.stdout),
    };
  };

  const toResult = (
    attempt: {
      proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string };
      rawStderr: string;
      parsed: ReturnType<typeof parseOpenCodeJsonl>;
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

    const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
    const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
    const rawExitCode = attempt.proc.exitCode;
    const synthesizedExitCode = parsedError && (rawExitCode ?? 0) === 0 ? 1 : rawExitCode;
    const fallbackErrorMessage =
      parsedError ||
      stderrLine ||
      `OpenCode exited with code ${synthesizedExitCode ?? -1}`;
    const modelId = model || null;

    return {
      exitCode: synthesizedExitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage: (synthesizedExitCode ?? 0) === 0 ? null : fallbackErrorMessage,
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
      },
      summary: attempt.parsed.summary,
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
