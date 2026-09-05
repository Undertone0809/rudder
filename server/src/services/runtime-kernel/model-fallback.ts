import type {
  AgentRuntimeExecutionContext,
  AgentRuntimeExecutionResult,
  AgentRuntimeInvocationMeta,
  AgentRuntimeState,
  ServerAgentRuntimeModule,
} from "@rudderhq/agent-runtime-utils";
import {
  buildModelAttemptSpecs,
  isAgentRuntimeNetworkSuspension,
  isSuccessfulRuntimeResult,
  type ModelAttemptSpec,
} from "@rudderhq/agent-runtime-utils";
import {
  isBrowserSkillSelectionKey,
  isSupportedBrowserRuntimeType,
} from "../browser-capability.js";

interface ModelFallbackExecutionOptions {
  resolveAdapter?: (agentRuntimeType: string) => ServerAgentRuntimeModule | null;
  createAuthToken?: (agentRuntimeType: string) => string | undefined;
  onAttemptStart?: (attempt: ModelAttemptSpec, adapter: ServerAgentRuntimeModule) => Promise<void> | void;
  /** Called only when this attempt failed and the next fallback will run. */
  onAttemptFailure?: (attempt: ModelAttemptSpec, failure: AgentRuntimeExecutionResult | Error) => Promise<void> | void;
  /** Resume a network-suspended fallback at its persisted model cursor. */
  startAttemptIndex?: number;
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
  "rudderBrowserEnabled",
];

type BrowserCapabilitySource = {
  instanceEligible: boolean;
  runtimeSkillEntries: unknown[];
};

function filterBrowserSkillList(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => {
    if (typeof entry === "string") return !isBrowserSkillSelectionKey(entry);
    if (!entry || typeof entry !== "object") return true;
    return !isBrowserSkillSelectionKey((entry as { key?: unknown }).key);
  });
}

function filterBrowserSkillSync(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return {
    ...record,
    desiredSkills: filterBrowserSkillList(record.desiredSkills),
  };
}

function selectBrowserSkillEntries(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => (
    Boolean(entry)
    && typeof entry === "object"
    && isBrowserSkillSelectionKey((entry as { key?: unknown }).key)
  ));
}

function resolveBrowserCapabilitySource(
  baseConfig: Record<string, unknown>,
): BrowserCapabilitySource {
  const configured = baseConfig.rudderBrowserCapability;
  if (configured && typeof configured === "object" && !Array.isArray(configured)) {
    const record = configured as Record<string, unknown>;
    return {
      instanceEligible: record.instanceEligible === true,
      runtimeSkillEntries: selectBrowserSkillEntries(record.runtimeSkillEntries),
    };
  }

  return {
    instanceEligible: false,
    runtimeSkillEntries: [],
  };
}

function addBrowserSkillList(value: unknown, browserSkillEntries: unknown[]) {
  return [
    ...(Array.isArray(value) ? filterBrowserSkillList(value) : []),
    ...browserSkillEntries,
  ];
}

function addBrowserSkillSync(value: unknown, browserSkillKeys: string[]) {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    ...record,
    desiredSkills: [
      ...(Array.isArray(record.desiredSkills)
        ? filterBrowserSkillList(record.desiredSkills)
        : []),
      ...browserSkillKeys,
    ],
  };
}

function projectBrowserCapabilityForAttempt(
  config: Record<string, unknown>,
  source: BrowserCapabilitySource,
  agentRuntimeType: string,
) {
  return projectBrowserCapability(
    config,
    source.instanceEligible && isSupportedBrowserRuntimeType(agentRuntimeType),
    source.runtimeSkillEntries,
  );
}

function projectBrowserCapability(
  config: Record<string, unknown>,
  browserEnabled: boolean,
  browserSkillEntries: unknown[],
) {
  const { rudderBrowserCapability: _rudderBrowserCapability, ...publicConfig } = config;
  if (browserEnabled) {
    const browserSkillKeys = browserSkillEntries
      .map((entry) => (entry as { key?: unknown }).key)
      .filter((key): key is string => typeof key === "string");
    return {
      ...publicConfig,
      rudderBrowserEnabled: true,
      rudderSkillSync: addBrowserSkillSync(publicConfig.rudderSkillSync, browserSkillKeys),
      paperclipSkillSync: addBrowserSkillSync(publicConfig.paperclipSkillSync, browserSkillKeys),
      rudderRuntimeSkills: addBrowserSkillList(
        publicConfig.rudderRuntimeSkills,
        browserSkillEntries,
      ),
      paperclipRuntimeSkills: addBrowserSkillList(
        publicConfig.paperclipRuntimeSkills,
        browserSkillEntries,
      ),
    };
  }
  return {
    ...publicConfig,
    rudderBrowserEnabled: false,
    rudderSkillSync: filterBrowserSkillSync(publicConfig.rudderSkillSync),
    paperclipSkillSync: filterBrowserSkillSync(publicConfig.paperclipSkillSync),
    rudderRuntimeSkills: filterBrowserSkillList(publicConfig.rudderRuntimeSkills),
    paperclipRuntimeSkills: filterBrowserSkillList(publicConfig.paperclipRuntimeSkills),
  };
}

export function sanitizeUntrustedRuntimeConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  return projectBrowserCapability(config, false, []);
}

export function projectPrimaryRuntimeConfig(
  config: Record<string, unknown>,
  agentRuntimeType: string,
): Record<string, unknown> {
  return projectBrowserCapabilityForAttempt(
    config,
    resolveBrowserCapabilitySource(config),
    agentRuntimeType,
  );
}

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

function isTerminalProviderAuthFailure(result: AgentRuntimeExecutionResult): boolean {
  const providerFailure = result.resultJson?.providerFailure;
  return result.errorCode === "codex_provider_auth_required"
    || Boolean(
      providerFailure
      && typeof providerFailure === "object"
      && !Array.isArray(providerFailure)
      && (providerFailure as Record<string, unknown>).classification === "authentication"
      && (providerFailure as Record<string, unknown>).retryable === false,
    );
}

function buildAttemptConfig(
  baseConfig: Record<string, unknown>,
  attempt: ModelAttemptSpec,
  primaryRuntimeType: string,
  attemptRuntimeType: string,
  browserCapabilitySource: BrowserCapabilitySource,
): Record<string, unknown> {
  if (!attempt.isFallback) {
    return projectPrimaryRuntimeConfig(baseConfig, attemptRuntimeType);
  }
  if (attemptRuntimeType === primaryRuntimeType) {
    const { modelFallbacks: _modelFallbacks, ...baseWithoutFallbacks } = baseConfig;
    return projectBrowserCapabilityForAttempt({
      ...baseWithoutFallbacks,
      ...(attempt.config ?? {}),
      model: attempt.model,
    }, browserCapabilitySource, attemptRuntimeType);
  }
  const sharedConfig = Object.fromEntries(
    SHARED_ATTEMPT_CONFIG_KEYS
      .filter((key) => baseConfig[key] !== undefined)
      .map((key) => [key, baseConfig[key]]),
  );
  return projectBrowserCapabilityForAttempt({
    ...sharedConfig,
    ...(attempt.config ?? {}),
    model: attempt.model,
  }, browserCapabilitySource, attemptRuntimeType);
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
  // Resolve once so per-attempt config cannot escalate instance-level Browser eligibility.
  const browserCapabilitySource = resolveBrowserCapabilitySource(ctx.config);
  let previousFailure: AgentRuntimeExecutionResult | Error | null = null;
  const authFailedRuntimeTypes = new Set<string>();
  const requestedStartIndex = Number.isFinite(options.startAttemptIndex)
    ? Math.max(0, Math.floor(options.startAttemptIndex as number))
    : 0;

  const startIndex = Math.min(requestedStartIndex, Math.max(0, attempts.length - 1));
  for (const attempt of attempts.slice(startIndex)) {
    const attemptRuntimeType = attempt.agentRuntimeType ?? ctx.agent.agentRuntimeType ?? adapter.type;
    const attemptAdapter = attempt.isFallback && attemptRuntimeType !== adapter.type
      ? options.resolveAdapter?.(attemptRuntimeType) ?? null
      : adapter;

    if (authFailedRuntimeTypes.has(attemptRuntimeType)) continue;

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

    let controlAttempt: Awaited<ReturnType<NonNullable<typeof ctx.controlCoordinator>["beginAttempt"]>> | null = null;
    let networkSuspended = false;
    try {
      const attemptConfig = buildAttemptConfig(
        ctx.config,
        attempt,
        ctx.agent.agentRuntimeType ?? adapter.type,
        attemptRuntimeType,
        browserCapabilitySource,
      );
      controlAttempt = await ctx.controlCoordinator?.beginAttempt({
        attemptIndex: attempt.index,
        runtimeType: attemptRuntimeType,
        model: attempt.model,
        isFallback: attempt.isFallback,
      }) ?? null;
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
        controlAttempt: controlAttempt ?? undefined,
        onMeta: ctx.onMeta
          ? async (meta) => {
            await ctx.onMeta?.(wrapMeta(meta, attempt, previousFailure));
          }
          : undefined,
      });

      if (isTerminalProviderAuthFailure(result)) {
        const hasCrossProviderFallback = attempts
          .slice(attempt.index + 1)
          .some((candidate) => (
            candidate.agentRuntimeType
            ?? ctx.agent.agentRuntimeType
            ?? adapter.type
          ) !== attemptRuntimeType);
        if (!hasCrossProviderFallback) return result;
        authFailedRuntimeTypes.add(attemptRuntimeType);
        await options.onAttemptFailure?.(attempt, result);
        previousFailure = result;
        continue;
      }

      // A provider transport suspension is non-terminal. Keep the current
      // attempt/fallback cursor pinned so recovery can resume the same model
      // instead of silently changing providers while the network is down.
      if (
        (isAgentRuntimeNetworkSuspension(result.networkSuspension)
          || isAgentRuntimeNetworkSuspension(result.suspension))
        || isSuccessfulRuntimeResult(result)
        || ctx.abortSignal?.aborted
          || attempt.index === attempts.length - 1
      ) {
        networkSuspended = Boolean(
          isAgentRuntimeNetworkSuspension(result.networkSuspension)
          || isAgentRuntimeNetworkSuspension(result.suspension),
        );
        return result;
      }

      await options.onAttemptFailure?.(attempt, result);
      previousFailure = result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (ctx.abortSignal?.aborted || attempt.index === attempts.length - 1) {
        throw err;
      }
      await options.onAttemptFailure?.(attempt, err);
      previousFailure = err;
    } finally {
      // Chat marks the durable generation as waiting after this result is
      // returned. Keep the in-process owner alive until that CAS transition
      // clears the lease; completing it here would briefly publish `closing`
      // and allow stale-owner recovery to terminalize a healthy waiting run.
      if (!networkSuspended) await controlAttempt?.complete();
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
