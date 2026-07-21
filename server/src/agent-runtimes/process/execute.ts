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

  if (onMeta) {
    await onMeta({
      agentRuntimeType: "process",
      command,
      cwd,
      commandArgs: args,
      env: redactEnvForLogs(env),
      ...(chatPrompt !== null ? { prompt: chatPrompt } : {}),
    });
  }

  const proc = await runChildProcess(runId, command, args, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onLog,
    onSpawn,
    ...(chatPrompt !== null ? { stdin: chatPrompt } : {}),
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
    ...(chatPrompt !== null && proc.stdout.trim().length > 0
      ? { summary: proc.stdout.trim() }
      : {}),
    resultJson: {
      stdout: proc.stdout,
      stderr: proc.stderr,
    },
  };
}
