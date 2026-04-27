import type {
  AgentRuntimeExecutionContext,
  AgentRuntimeExecutionResult,
  AgentRuntimeInvocationMeta,
  AgentRuntimeState,
  ServerAgentRuntimeModule,
} from "@rudderhq/agent-runtime-utils";
import {
  buildModelAttemptSpecs,
  isSuccessfulRuntimeResult,
  type ModelAttemptSpec,
} from "@rudderhq/agent-runtime-utils";

function clearRuntimeSession(runtime: AgentRuntimeState): AgentRuntimeState {
  return {
    ...runtime,
    sessionId: null,
    sessionParams: null,
    sessionDisplayId: null,
  };
}

function describeFailure(failure: AgentRuntimeExecutionResult | Error | null): string {
  if (!failure) return "previous attempt failed";
  if (failure instanceof Error) return failure.message || "adapter threw";
  if (failure.timedOut) return "timed out";
  if (failure.errorMessage) return failure.errorMessage;
  if (failure.errorCode) return failure.errorCode;
  return `exit code ${failure.exitCode ?? -1}`;
}

function buildAttemptConfig(
  baseConfig: Record<string, unknown>,
  attempt: ModelAttemptSpec,
): Record<string, unknown> {
  if (!attempt.isFallback) return baseConfig;
  return {
    ...baseConfig,
    model: attempt.model,
  };
}

function buildAttemptContext(
  baseContext: Record<string, unknown>,
  attempt: ModelAttemptSpec,
): Record<string, unknown> {
  if (!attempt.isFallback) return baseContext;
  return {
    ...baseContext,
    rudderModelFallback: {
      attemptIndex: attempt.index,
      fallbackIndex: attempt.fallbackIndex,
      totalFallbacks: attempt.totalFallbacks,
      model: attempt.model,
    },
  };
}

function wrapMeta(
  meta: AgentRuntimeInvocationMeta,
  attempt: ModelAttemptSpec,
  previousFailure: AgentRuntimeExecutionResult | Error | null,
): AgentRuntimeInvocationMeta {
  if (!attempt.isFallback) return meta;
  const note = `model fallback ${attempt.fallbackIndex}/${attempt.totalFallbacks}: ${attempt.model} after ${describeFailure(previousFailure)}`;
  return {
    ...meta,
    commandNotes: [...(meta.commandNotes ?? []), note],
    context: {
      ...(meta.context ?? {}),
      rudderModelFallback: {
        attemptIndex: attempt.index,
        fallbackIndex: attempt.fallbackIndex,
        totalFallbacks: attempt.totalFallbacks,
        model: attempt.model,
        previousFailure: describeFailure(previousFailure),
      },
    },
  };
}

export async function executeAdapterWithModelFallbacks(
  adapter: ServerAgentRuntimeModule,
  ctx: AgentRuntimeExecutionContext,
): Promise<AgentRuntimeExecutionResult> {
  const attempts = buildModelAttemptSpecs(ctx.config);
  let previousFailure: AgentRuntimeExecutionResult | Error | null = null;

  for (const attempt of attempts) {
    if (attempt.isFallback) {
      await ctx.onLog(
        "stdout",
        `[rudder] ${describeFailure(previousFailure)}; retrying with fallback model ${attempt.fallbackIndex}/${attempt.totalFallbacks}: ${attempt.model}\n`,
      );
    }

    try {
      const result = await adapter.execute({
        ...ctx,
        config: buildAttemptConfig(ctx.config, attempt),
        context: buildAttemptContext(ctx.context, attempt),
        runtime: attempt.isFallback ? clearRuntimeSession(ctx.runtime) : ctx.runtime,
        onMeta: ctx.onMeta
          ? async (meta) => {
            await ctx.onMeta?.(wrapMeta(meta, attempt, previousFailure));
          }
          : undefined,
      });

      if (isSuccessfulRuntimeResult(result) || ctx.abortSignal?.aborted || attempt.index === attempts.length - 1) {
        return result;
      }

      previousFailure = result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (ctx.abortSignal?.aborted || attempt.index === attempts.length - 1) {
        throw err;
      }
      previousFailure = err;
    }
  }

  throw new Error("No adapter execution attempt was made");
}
