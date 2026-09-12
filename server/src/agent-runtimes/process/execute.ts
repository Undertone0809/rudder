import path from "node:path";

import type { AgentRuntimeExecutionContext, AgentRuntimeExecutionResult } from "../types.js";
import {
  asNumber,
  asString,
  asStringArray,
  buildRudderEnv,
  parseObject,
  redactEnvForLogs,
  resolveSpawnTarget,
  runChildProcess,
  runNativeChildProcessV2,
} from "../utils.js";

export async function execute(ctx: AgentRuntimeExecutionContext): Promise<AgentRuntimeExecutionResult> {
  const {
    runId,
    agent,
    config,
    context,
    nativeProcessAuthority,
    onLog,
    onMeta,
    onSpawn,
    abortSignal,
  } = ctx;
  const command = asString(config.command, "");
  if (!command) throw new Error("Process adapter missing command");

  const args = asStringArray(config.args);
  const cwd = asString(config.cwd, process.cwd());
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildRudderEnv(agent) };
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") env[k] = v;
  }

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 15);
  const chatPrompt = context.chatMode === true && typeof context.chatPrompt === "string"
    ? context.chatPrompt
    : null;
  const delegationTask = (context.scene === "delegation" || context.rudderScene === "delegation") && typeof context.delegationTask === "string"
    ? context.delegationTask.trim()
    : "";
  const delegationPrompt = delegationTask
    ? `You are agent ${agent.id} (${agent.name}) running an independent Rudder Delegation Run.

Source Run ${asString(context.sourceRunId, "unknown")} and Source Agent ${asString(context.sourceAgentId, "unknown")} are provenance only. Do not inherit the source Run's transcript, session, workspace, credentials, environment variables, or arbitrary paths. Use the target Agent's own runtime, workspace, instructions, and skills.

## Delegated Task

${delegationTask}

Complete only this bounded task and report the result through the normal Run evidence path.`
    : null;
  const runtimePrompt = chatPrompt ?? delegationPrompt;
  if (delegationTask) env.RUDDER_DELEGATION_TASK = delegationTask;

  if (onMeta) {
    await onMeta({
      agentRuntimeType: "process",
      command,
      cwd,
      commandArgs: args,
      env: redactEnvForLogs(env),
      ...(runtimePrompt !== null ? { prompt: runtimePrompt } : {}),
    });
  }

  const nativeSpawnTarget = nativeProcessAuthority === undefined
    ? null
    : await resolveSpawnTarget(command, args, cwd, { ...process.env, ...env });
  if (nativeSpawnTarget !== null && !path.isAbsolute(nativeSpawnTarget.command)) {
    throw new Error(`Native process host requires an absolute executable; could not resolve ${command}`);
  }

  const processOptions = {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onLog,
    onSpawn,
    ...(runtimePrompt !== null ? { stdin: runtimePrompt } : {}),
    abortSignal,
  };
  const proc = nativeProcessAuthority !== undefined
    ? await runNativeChildProcessV2(runId, nativeSpawnTarget!.command, nativeSpawnTarget!.args, {
      ...processOptions,
      authority: nativeProcessAuthority,
    })
    : await runChildProcess(runId, command, args, processOptions);

  const terminalStatus = proc.terminalStatus;
  const terminalErrorCode = proc.errorCode ?? null;
  if (terminalStatus === "timed_out" || proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorCode: terminalErrorCode ?? "process_timeout",
      errorMessage: terminalErrorCode
        ? `Process timed out (${terminalErrorCode})`
        : `Timed out after ${timeoutSec}s`,
    };
  }

  if (terminalStatus === "cancelled") {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorCode: terminalErrorCode ?? "process_cancelled",
      errorMessage: `Process cancelled${terminalErrorCode ? ` (${terminalErrorCode})` : ""}`,
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
      },
    };
  }

  if (terminalStatus === "failed") {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorCode: terminalErrorCode ?? "process_failed",
      errorMessage: `Process exited with terminal status failed${terminalErrorCode ? ` (${terminalErrorCode})` : ""}`,
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
      },
    };
  }

  if (proc.exitCode === null) {
    return {
      exitCode: null,
      signal: proc.signal,
      timedOut: false,
      errorCode: "process_exit_unknown",
      errorMessage: "Process ended without a terminal exit code",
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
      },
    };
  }

  if (proc.exitCode !== 0) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorCode: "process_exit_nonzero",
      errorMessage: `Process exited with code ${proc.exitCode}`,
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
      },
    };
  }

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    ...(runtimePrompt !== null && proc.stdout.trim().length > 0
      ? { summary: proc.stdout.trim() }
      : {}),
    resultJson: {
      stdout: proc.stdout,
      stderr: proc.stderr,
    },
  };
}
