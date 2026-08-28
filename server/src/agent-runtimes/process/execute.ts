import type { AgentRuntimeExecutionContext, AgentRuntimeExecutionResult } from "../types.js";
import {
  asNumber,
  asString,
  asStringArray,
  buildRudderEnv,
  parseObject,
  redactEnvForLogs,
  runChildProcess,
} from "../utils.js";

export async function execute(ctx: AgentRuntimeExecutionContext): Promise<AgentRuntimeExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta, onSpawn, abortSignal } = ctx;
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

  const proc = await runChildProcess(runId, command, args, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onLog,
    onSpawn,
    ...(runtimePrompt !== null ? { stdin: runtimePrompt } : {}),
    abortSignal,
  });

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
    };
  }

  if ((proc.exitCode ?? 0) !== 0) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage: `Process exited with code ${proc.exitCode ?? -1}`,
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
