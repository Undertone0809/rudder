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

interface ModelFallbackExecutionOptions {
  resolveAdapter?: (agentRuntimeType: string) => ServerAgentRuntimeModule | null;
  createAuthToken?: (agentRuntimeType: string) => string | undefined;
  onAttemptStart?: (attempt: ModelAttemptSpec, adapter: ServerAgentRuntimeModule) => Promise<void> | void;
}

const SHARED_ATTEMPT_CONFIG_KEYS = [
  "promptTemplate",
  "bootstrapPromptTemplate",
  "instructionsFilePath",
  "instructionsRootPath",
  "instructionsEntryFile",
  "instructionsBundleMode",
  "agentsMdPath",
  "rudderSkillSync",
  "paperclipSkillSync",
  "rudderRuntimeSkills",
  "paperclipRuntimeSkills",
];

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
  primaryRuntimeType: string,
): Record<string, unknown> {
  if (!attempt.isFallback) return baseConfig;
  if (attempt.agentRuntimeType === primaryRuntimeType) {
    const { modelFallbacks: _modelFallbacks, ...baseWithoutFallbacks } = baseConfig;
    return {
      ...baseWithoutFallbacks,
      ...(attempt.config ?? {}),
      model: attempt.model,
    };
  }
  const sharedConfig = Object.fromEntries(
    SHARED_ATTEMPT_CONFIG_KEYS
      .filter((key) => baseConfig[key] !== undefined)
      .map((key) => [key, baseConfig[key]]),
  );
  return {
    ...sharedConfig,
    ...(attempt.config ?? {}),
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
      agentRuntimeType: attempt.agentRuntimeType,
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
  const note = `model fallback ${attempt.fallbackIndex}/${attempt.totalFallbacks}: ${attempt.agentRuntimeType}/${attempt.model} after ${describeFailure(previousFailure)}`;
  return {
    ...meta,
    commandNotes: [...(meta.commandNotes ?? []), note],
    context: {
      ...(meta.context ?? {}),
      rudderModelFallback: {
        attemptIndex: attempt.index,
        agentRuntimeType: attempt.agentRuntimeType,
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
  options: ModelFallbackExecutionOptions = {},
): Promise<AgentRuntimeExecutionResult> {
  const attempts = buildModelAttemptSpecs(ctx.config, ctx.agent.agentRuntimeType);
  let previousFailure: AgentRuntimeExecutionResult | Error | null = null;

  for (const attempt of attempts) {
    const attemptRuntimeType = attempt.agentRuntimeType ?? ctx.agent.agentRuntimeType ?? adapter.type;
    const attemptAdapter = attempt.isFallback && attemptRuntimeType !== adapter.type
      ? options.resolveAdapter?.(attemptRuntimeType) ?? null
      : adapter;

    if (!attemptAdapter) {
      previousFailure = new Error(`No adapter found for fallback runtime ${attemptRuntimeType}`);
      continue;
    }

    if (attempt.isFallback) {
      await ctx.onLog(
        "stdout",
        `[rudder] ${describeFailure(previousFailure)}; retrying with fallback model ${attempt.fallbackIndex}/${attempt.totalFallbacks}: ${attemptRuntimeType}/${attempt.model}\n`,
      );
    }

    try {
      const attemptConfig = buildAttemptConfig(ctx.config, attempt, ctx.agent.agentRuntimeType ?? adapter.type);
      await options.onAttemptStart?.(attempt, attemptAdapter);
      const result = await attemptAdapter.execute({
        ...ctx,
        agent: {
          ...ctx.agent,
          agentRuntimeType: attemptRuntimeType,
          agentRuntimeConfig: attemptConfig,
        },
        config: attemptConfig,
        context: buildAttemptContext(ctx.context, attempt),
        runtime: attempt.isFallback ? clearRuntimeSession(ctx.runtime) : ctx.runtime,
        authToken: options.createAuthToken?.(attemptRuntimeType) ?? ctx.authToken,
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

  if (previousFailure instanceof Error) throw previousFailure;
  return previousFailure ?? {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: "No adapter execution attempt was made",
  };
}
