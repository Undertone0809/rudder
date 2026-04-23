import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inferOpenAiCompatibleBiller, type AgentRuntimeExecutionContext, type AgentRuntimeExecutionResult } from "@rudder/agent-runtime-utils";
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
  ensureRudderSkillSymlink,
  ensureRudderCliInPath,
  ensurePathInEnv,
  readRudderRuntimeSkillEntries,
  resolveRudderDesiredSkillNames,
  removeMaintainerOnlySkillSymlinks,
  renderTemplate,
  runChildProcess,
  selectPromptTemplate,
} from "@rudder/agent-runtime-utils/server-utils";
import { isPiUnknownSessionError, parsePiJsonl } from "./parse.js";
import { ensurePiModelConfiguredAndAvailable } from "./models.js";

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

function resolveManagedPiHomeDir(env: NodeJS.ProcessEnv, orgId: string): string {
  const rudderHome = nonEmpty(env.RUDDER_HOME) ?? path.resolve(os.homedir(), ".rudder");
  const instanceId = nonEmpty(env.RUDDER_INSTANCE_ID) ?? DEFAULT_RUDDER_INSTANCE_ID;
  return path.resolve(rudderHome, "instances", instanceId, "organizations", orgId, "pi-home");
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
  const targetHome = resolveManagedPiHomeDir(env, orgId);
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
  const managedHome = await prepareManagedPiHome(
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
  
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv(await ensureRudderCliInPath(__moduleDir, { ...process.env, ...env }))).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
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

  // Handle instructions file and build system prompt extension
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const resolvedInstructionsFilePath = instructionsFilePath
    ? path.resolve(cwd, instructionsFilePath)
    : "";
  const instructionsFileDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  
  let systemPromptExtension = "";
  let instructionsReadFailed = false;
  if (resolvedInstructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(resolvedInstructionsFilePath, "utf8");
      systemPromptExtension =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsFileDir}.\n\n` +
        `You are agent {{agent.id}} ({{agent.name}}). Continue your Rudder work.`;
      await onLog(
        "stdout",
        `[rudder] Loaded agent instructions file: ${resolvedInstructionsFilePath}\n`,
      );
    } catch (err) {
      instructionsReadFailed = true;
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[rudder] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
      );
      // Fall back to base prompt template
      systemPromptExtension = promptTemplate;
    }
  } else {
    systemPromptExtension = promptTemplate;
  }

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
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedHeartbeatPrompt.length,
  };

  const commandNotes = (() => {
    if (!resolvedInstructionsFilePath) return [] as string[];
    if (instructionsReadFailed) {
      return [
        `Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`,
      ];
    }
    return [
      `Loaded agent instructions from ${resolvedInstructionsFilePath}`,
      `Appended instructions + path directive to system prompt (relative references from ${instructionsFileDir}).`,
    ];
  })();

  const buildArgs = (sessionFile: string): string[] => {
    const args: string[] = [];
    
    // Use RPC mode for proper lifecycle management (waits for agent completion)
    args.push("--mode", "rpc");
    
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

  const buildRpcStdin = (): string => {
    // Send the prompt as an RPC command
    const promptCommand = {
      type: "prompt",
      message: userPrompt,
    };
    return JSON.stringify(promptCommand) + "\n";
  };

  const runAttempt = async (sessionFile: string) => {
    const args = buildArgs(sessionFile);
    if (onMeta) {
      await onMeta({
        agentRuntimeType: "pi_local",
        command,
        cwd,
        commandNotes,
        commandArgs: args,
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
          await onLog(stream, line + "\n");
        }
      }
    };

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env: runtimeEnv,
      timeoutSec,
      graceSec,
      onSpawn,
      abortSignal: ctx.abortSignal,
      onLog: bufferedOnLog,
      stdin: buildRpcStdin(),
    });
    
    // Flush any remaining buffer content
    if (stdoutBuffer) {
      await onLog("stdout", stdoutBuffer);
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
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
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
