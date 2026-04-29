import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inferOpenAiCompatibleBiller, type AgentRuntimeExecutionContext, type AgentRuntimeExecutionResult } from "@rudderhq/agent-runtime-utils";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  buildRudderEnv,
  redactEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensureRudderCliInPath,
  ensurePathInEnv,
  readRudderRuntimeSkillEntries,
  resolveRudderDesiredSkillNames,
  renderTemplate,
  joinPromptSections,
  runChildProcess,
  selectPromptTemplate,
} from "@rudderhq/agent-runtime-utils/server-utils";
import { parseCodexJsonl, isCodexUnknownSessionError } from "./parse.js";
import {
  prepareManagedCodexHome,
  realizeManagedCodexSkillEntries,
  resolveManagedCodexHomeDir,
} from "./codex-home.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const CODEX_BENIGN_STDERR_RES = [
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+ERROR\s+codex_core::rollout::list:\s+state db missing rollout path for thread\s+[a-z0-9-]+$/i,
  /^Error:\s+thread\/resume:\s+thread\/resume failed:\s+no rollout found for thread id\s+[a-z0-9-]+$/i,
  /^\d{4}-\d{2}-\d{2}T[^\s]+\s+WARN\s+codex_core::shell_snapshot:\s+Failed to delete shell snapshot at\s+".+?\.tmp-\d+":\s+Os\s+\{\s+code:\s*2,\s+kind:\s*NotFound,\s+message:\s*"No such file or directory"\s+\}$/i,
] as const;

function isBenignCodexStderrLine(line: string): boolean {
  return CODEX_BENIGN_STDERR_RES.some((pattern) => pattern.test(line.trim()));
}

function stripCodexBenignStderr(text: string): string {
  const parts = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      kept.push(part);
      continue;
    }
    if (isBenignCodexStderrLine(trimmed)) continue;
    kept.push(part);
  }
  return kept.join("\n");
}

function splitCompleteLines(text: string): { lines: string[]; remainder: string } {
  const lines: string[] = [];
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") continue;
    lines.push(text.slice(start, index + 1));
    start = index + 1;
  }

  return {
    lines,
    remainder: text.slice(start),
  };
}

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

function hasCliArg(args: string[], flag: string): boolean {
  return args.includes(flag);
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

export async function execute(ctx: AgentRuntimeExecutionContext): Promise<AgentRuntimeExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = selectPromptTemplate(
    asString(config.promptTemplate, ""),
    context,
  );
  const command = asString(config.command, "codex");
  const model = asString(config.model, "");
  const modelReasoningEffort = asString(
    config.modelReasoningEffort,
    asString(config.reasoningEffort, ""),
  );
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
  const orgPlansDir = asString(workspaceContext.orgPlansDir, "");
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
  const configuredCodexHome =
    typeof envConfig.CODEX_HOME === "string" && envConfig.CODEX_HOME.trim().length > 0
      ? path.resolve(envConfig.CODEX_HOME.trim())
      : null;
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  const sourceEnv = {
    ...process.env,
    ...Object.fromEntries(
      Object.entries(envConfig).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  };
  const preparedManagedCodexHome =
    configuredCodexHome ? null : await prepareManagedCodexHome(sourceEnv, onLog, agent.orgId, agent.id);
  const defaultCodexHome = resolveManagedCodexHomeDir(sourceEnv, agent.orgId, agent.id);
  const effectiveCodexHome = configuredCodexHome ?? preparedManagedCodexHome ?? defaultCodexHome;
  await fs.mkdir(effectiveCodexHome, { recursive: true });
  const isolatedHome = agentHome || path.join(effectiveCodexHome, "home");
  await fs.mkdir(isolatedHome, { recursive: true });
  const codexSkillEntries = await readRudderRuntimeSkillEntries(config, __moduleDir);
  const desiredCodexSkillNames = resolveRudderDesiredSkillNames(config, codexSkillEntries);
  await realizeManagedCodexSkillEntries(
    {
      ...sourceEnv,
      CODEX_HOME: effectiveCodexHome,
    },
    effectiveCodexHome,
    codexSkillEntries
      .filter((entry) => desiredCodexSkillNames.includes(entry.key))
      .map((entry) => entry.source),
    onLog,
  );
  const hasExplicitApiKey =
    typeof envConfig.RUDDER_API_KEY === "string" && envConfig.RUDDER_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildRudderEnv(agent) };
  env.CODEX_HOME = effectiveCodexHome;
  env.HOME = isolatedHome;
  env.USERPROFILE = isolatedHome;
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
  env.AGENT_HOME = agentHome || isolatedHome;
  if (agentHome) {
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
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") env[k] = v;
  }
  if (!hasExplicitApiKey && authToken) {
    env.RUDDER_API_KEY = authToken;
  }
  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const billingType = resolveCodexBillingType(effectiveEnv);
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
      `[rudder] Codex session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  let instructionsChars = 0;
  if (instructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
      instructionsChars = instructionsPrefix.length;
      await onLog(
        "stdout",
        `[rudder] Loaded agent instructions file: ${instructionsFilePath}\n`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[rudder] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }
  const repoAgentsNote =
    "Codex exec automatically applies repo-scoped AGENTS.md instructions from the current workspace; Rudder does not currently suppress that discovery.";
  const commandNotes = (() => {
    if (!instructionsFilePath) {
      return [repoAgentsNote];
    }
    if (instructionsPrefix.length > 0) {
      return [
        `Loaded agent instructions from ${instructionsFilePath}`,
        `Prepended instructions + path directive to stdin prompt (relative references from ${instructionsDir}).`,
        repoAgentsNote,
      ];
    }
    return [
      `Configured instructionsFilePath ${instructionsFilePath}, but file could not be read; continuing without injected instructions.`,
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
  const prompt = joinPromptSections([
    instructionsPrefix,
    renderedBootstrapPrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    instructionsChars,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const buildArgs = (resumeSessionId: string | null) => {
    const args = ["exec", "--json", "--disable", "plugins"];
    if (search) args.unshift("--search");
    if (bypass) args.push("--dangerously-bypass-approvals-and-sandbox");
    if (model) args.push("--model", model);
    if (modelReasoningEffort) args.push("-c", `model_reasoning_effort=${JSON.stringify(modelReasoningEffort)}`);
    if (runtimeScene === "chat" && !hasCliArg(extraArgs, "--skip-git-repo-check")) {
      args.push("--skip-git-repo-check");
    }
    if (extraArgs.length > 0) args.push(...extraArgs);
    args.push("-c", "skills.bundled.enabled=false");
    if (resumeSessionId) args.push("resume", resumeSessionId, "-");
    else args.push("-");
    return args;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        agentRuntimeType: "codex_local",
        command,
        cwd,
        commandNotes,
        commandArgs: args.map((value, idx) => {
          if (idx === args.length - 1 && value !== "-") return `<prompt ${prompt.length} chars>`;
          return value;
        }),
        env: redactEnvForLogs(env),
        prompt,
        promptMetrics,
        context,
      });
    }

    let stderrBuffer = "";
    const flushBufferedStderr = async (force: boolean) => {
      if (!stderrBuffer) return;
      const { lines, remainder } = splitCompleteLines(stderrBuffer);
      stderrBuffer = force ? "" : remainder;
      const emittedLines = force ? [...lines, ...(remainder ? [remainder] : [])] : lines;
      for (const line of emittedLines) {
        if (isBenignCodexStderrLine(line)) continue;
        await onLog("stderr", line);
      }
    };

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env,
      stdin: prompt,
      timeoutSec,
      graceSec,
      onSpawn,
      abortSignal: ctx.abortSignal,
      onLog: async (stream, chunk) => {
        if (stream !== "stderr") {
          await onLog(stream, chunk);
          return;
        }
        stderrBuffer += chunk;
        await flushBufferedStderr(false);
      },
    });
    await flushBufferedStderr(true);
    const cleanedStderr = stripCodexBenignStderr(proc.stderr);
    return {
      proc: {
        ...proc,
        stderr: cleanedStderr,
      },
      rawStderr: proc.stderr,
      parsed: parseCodexJsonl(proc.stdout),
    };
  };

  const toResult = (
    attempt: { proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string }; rawStderr: string; parsed: ReturnType<typeof parseCodexJsonl> },
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
    const stderrLine = firstMeaningfulErrorLine(attempt.proc.stderr);
    const fallbackErrorMessage =
      parsedError ||
      stderrLine ||
      `Codex exited with code ${attempt.proc.exitCode ?? -1}`;

    return {
      exitCode: attempt.proc.exitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage:
        (attempt.proc.exitCode ?? 0) === 0
          ? null
          : fallbackErrorMessage,
      usage: attempt.parsed.usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "openai",
      biller: resolveCodexBiller(effectiveEnv, billingType),
      model,
      billingType,
      costUsd: null,
      resultJson: {
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
      },
      summary: attempt.parsed.summary,
      question: attempt.parsed.question,
      clearSession: Boolean(clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  const initial = await runAttempt(sessionId);
  if (
    sessionId &&
    !initial.proc.timedOut &&
    (initial.proc.exitCode ?? 0) !== 0 &&
    isCodexUnknownSessionError(initial.proc.stdout, initial.rawStderr)
  ) {
    await onLog(
      "stdout",
      `[rudder] Codex resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
    );
    const retry = await runAttempt(null);
    return toResult(retry, true);
  }

  return toResult(initial);
}
