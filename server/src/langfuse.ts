import { createHash } from "node:crypto";
import { LangfuseClient } from "@langfuse/client";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  createTraceId,
  getActiveTraceId,
  LangfuseOtelSpanAttributes,
  propagateAttributes,
  setLangfuseTracerProvider,
  startActiveObservation,
  startObservation,
  type LangfuseObservation,
  type LangfuseObservationType,
} from "@langfuse/tracing";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { DeploymentMode, ExecutionLangfuseLink, ExecutionObservabilityContext } from "@rudderhq/shared";
import { logger } from "./middleware/logger.js";

export interface LangfuseRuntimeConfig {
  enabled: boolean;
  baseUrl: string;
  publicKey?: string;
  secretKey?: string;
  environment?: string;
  instanceId: string;
  deploymentMode: DeploymentMode;
  localEnv?: string | null;
  release: string;
}

export interface LangfuseScoreInput {
  id?: string;
  rootExecutionId: string;
  name: string;
  value: boolean | number | string;
  comment?: string;
  metadata?: Record<string, unknown>;
}

type ActiveObservationType = Exclude<LangfuseObservationType, "event">;
type TraceIoAttributes = {
  input?: unknown;
  output?: unknown;
};
type SpanContext = {
  traceId: string;
  spanId: string;
  traceFlags: number;
};
type OpenAiUsageLike = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};
type ExecutionObservationAttributes = {
  level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  statusMessage?: string;
  completionStartTime?: Date;
  model?: string;
  modelParameters?: {
    [key: string]: string | number;
  };
  usageDetails?: {
    [key: string]: number;
  } | OpenAiUsageLike;
  costDetails?: {
    [key: string]: number;
  };
};

const traceIdCache = new Map<string, string>();
const traceUrlCache = new Map<string, string>();

let runtimeConfig: LangfuseRuntimeConfig | null = null;
let client: LangfuseClient | null = null;
let provider: NodeTracerProvider | null = null;

function stableHex(seed: string, length: number) {
  return createHash("sha256").update(seed).digest("hex").slice(0, length);
}

export function createStableUuid(seed: string) {
  const hex = stableHex(seed, 32).split("");
  hex[12] = "4";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16] ?? "0", 16) % 4] ?? "8";
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20, 32).join("")}`;
}

export function createExecutionScoreId(rootExecutionId: string, scoreName: string) {
  return createStableUuid(`langfuse-score:${rootExecutionId}:${scoreName}`);
}

function coerceString(value: unknown) {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

export function redactLangfuseValue(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    if (/sk-[a-z0-9]/i.test(value) || /api[_-]?key/i.test(value)) return "***REDACTED***";
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => redactLangfuseValue(item));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => {
        const lowered = key.toLowerCase();
        if (
          lowered.includes("secret") ||
          lowered.includes("token") ||
          lowered.includes("password") ||
          lowered.includes("apikey") ||
          lowered.includes("api_key")
        ) {
          if (typeof nested === "number" || typeof nested === "boolean" || nested == null) {
            return [key, nested];
          }
          return [key, "***REDACTED***"];
        }
        return [key, redactLangfuseValue(nested)];
      }),
    );
  }
  return String(value);
}

function buildTags(context: ExecutionObservabilityContext) {
  const tags = new Set<string>(context.tags ?? []);
  const identity = resolveLangfuseTraceIdentity(context);
  tags.add(`surface:${context.surface}`);
  if (context.runtime) tags.add(`runtime:${context.runtime}`);
  if (context.trigger) tags.add(`trigger:${context.trigger}`);
  if (context.status) tags.add(`status:${context.status}`);
  if (context.localEnv) tags.add(`localEnv:${context.localEnv}`);
  if (context.deploymentMode) tags.add(`deploymentMode:${context.deploymentMode}`);
  if (identity.environment) tags.add(`environment:${identity.environment}`);
  if (identity.instanceId) tags.add(`instance:${identity.instanceId}`);
  if (identity.release) tags.add(`release:${identity.release}`);
  return [...tags];
}

export function resolveLangfuseTraceIdentity(
  context: Pick<ExecutionObservabilityContext, "environment" | "instanceId" | "release"> = {},
  config: Pick<LangfuseRuntimeConfig, "environment" | "instanceId" | "release"> | null = runtimeConfig,
) {
  return {
    environment: coerceString(context.environment ?? config?.environment),
    instanceId: coerceString(context.instanceId ?? config?.instanceId),
    release: coerceString(context.release ?? config?.release),
  };
}

function buildPropagatedMetadata(context: ExecutionObservabilityContext) {
  const identity = resolveLangfuseTraceIdentity(context);
  const propagated: Record<string, string> = {
    surface: context.surface,
    rootExecutionId: context.rootExecutionId,
  };

  for (const [key, value] of Object.entries({
    orgId: context.orgId,
    agentId: context.agentId,
    issueId: context.issueId,
    pluginId: context.pluginId,
    sessionKey: context.sessionKey,
    runtime: context.runtime,
    trigger: context.trigger,
    status: context.status,
    environment: identity.environment,
    release: identity.release,
    instanceId: identity.instanceId,
    deploymentMode: context.deploymentMode ?? runtimeConfig?.deploymentMode,
    localEnv: context.localEnv ?? runtimeConfig?.localEnv,
  })) {
    const next = coerceString(value);
    if (next) propagated[key] = next;
  }

  for (const [key, value] of Object.entries(context.metadata ?? {})) {
    const next = coerceString(value);
    if (next) propagated[key] = next;
  }

  return propagated;
}

function buildObservationMetadata(context: ExecutionObservabilityContext, metadata?: Record<string, unknown>) {
  const identity = resolveLangfuseTraceIdentity(context);
  return {
    surface: context.surface,
    rootExecutionId: context.rootExecutionId,
    orgId: context.orgId ?? null,
    agentId: context.agentId ?? null,
    issueId: context.issueId ?? null,
    pluginId: context.pluginId ?? null,
    sessionKey: context.sessionKey ?? null,
    runtime: context.runtime ?? null,
    trigger: context.trigger ?? null,
    status: context.status ?? null,
    environment: identity.environment ?? null,
    release: identity.release ?? null,
    instanceId: identity.instanceId ?? null,
    deploymentMode: context.deploymentMode ?? runtimeConfig?.deploymentMode ?? null,
    localEnv: context.localEnv ?? runtimeConfig?.localEnv ?? null,
    ...(redactLangfuseValue(context.metadata ?? {}) as Record<string, unknown>),
    ...(redactLangfuseValue(metadata ?? {}) as Record<string, unknown>),
  };
}

function buildExecutionObservationAttributes(
  context: ExecutionObservabilityContext,
  attributes: ExecutionObservationAttributes,
) {
  const identity = resolveLangfuseTraceIdentity(context);
  return {
    ...attributes,
    input: redactLangfuseValue(attributes.input),
    output: redactLangfuseValue(attributes.output),
    metadata: buildObservationMetadata(context, attributes.metadata),
    environment: identity.environment ?? undefined,
    version: identity.release ?? undefined,
  };
}

function buildTraceIoAttributes(attributes: TraceIoAttributes) {
  const traceIo: TraceIoAttributes = {};
  if (attributes.input !== undefined) traceIo.input = redactLangfuseValue(attributes.input);
  if (attributes.output !== undefined) traceIo.output = redactLangfuseValue(attributes.output);
  return traceIo;
}

export async function getExecutionTraceId(rootExecutionId: string) {
  const cached = traceIdCache.get(rootExecutionId);
  if (cached) return cached;
  const traceId = await createTraceId(rootExecutionId);
  traceIdCache.set(rootExecutionId, traceId);
  return traceId;
}

async function createDetachedParentSpanContext(rootExecutionId: string): Promise<SpanContext> {
  return {
    traceId: await getExecutionTraceId(rootExecutionId),
    spanId: stableHex(`rudder:${rootExecutionId}`, 16),
    traceFlags: 1,
  };
}

function withPropagatedContext<T>(
  context: ExecutionObservabilityContext,
  opts: { includeTraceAttributes: boolean },
  fn: () => T,
): T {
  return propagateAttributes(
    {
      sessionId: context.sessionKey ?? context.rootExecutionId,
      version: context.release ?? runtimeConfig?.release,
      traceName: opts.includeTraceAttributes ? `${context.surface}:${context.rootExecutionId}` : undefined,
      tags: opts.includeTraceAttributes ? buildTags(context) : undefined,
      metadata: opts.includeTraceAttributes ? buildPropagatedMetadata(context) : undefined,
    },
    fn,
  );
}

export function isLangfuseEnabled() {
  return Boolean(runtimeConfig?.enabled && client && provider);
}

export function initializeLangfuse(config: LangfuseRuntimeConfig) {
  runtimeConfig = config;

  if (!config.enabled) {
    logger.info("Langfuse integration disabled");
    return;
  }

  if (!config.publicKey || !config.secretKey) {
    logger.warn("Langfuse enabled but credentials are missing; integration disabled");
    return;
  }

  provider = new NodeTracerProvider({
    spanProcessors: [
      new LangfuseSpanProcessor({
        publicKey: config.publicKey,
        secretKey: config.secretKey,
        baseUrl: config.baseUrl,
        environment: config.environment,
        release: config.release,
      }),
    ],
  });
  provider.register();
  setLangfuseTracerProvider(provider);

  client = new LangfuseClient({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
  });

  logger.info(
    {
      baseUrl: config.baseUrl,
      environment: config.environment ?? null,
      instanceId: config.instanceId,
      release: config.release,
    },
    "Langfuse integration initialized",
  );
}

export async function shutdownLangfuse() {
  await client?.shutdown().catch((error) => {
    logger.warn({ err: error instanceof Error ? error.message : String(error) }, "Langfuse client shutdown failed");
  });
  await provider?.shutdown().catch((error) => {
    logger.warn({ err: error instanceof Error ? error.message : String(error) }, "Langfuse tracer shutdown failed");
  });
  setLangfuseTracerProvider(null);
  client = null;
  provider = null;
}

async function startActiveTypedObservation<T>(
  name: string,
  asType: ActiveObservationType,
  fn: (observation: LangfuseObservation) => Promise<T>,
  options: { parentSpanContext?: SpanContext },
) {
  switch (asType) {
    case "agent":
      return startActiveObservation(name, fn, { ...options, asType: "agent" });
    case "generation":
      return startActiveObservation(name, fn, { ...options, asType: "generation" });
    case "tool":
      return startActiveObservation(name, fn, { ...options, asType: "tool" });
    case "chain":
      return startActiveObservation(name, fn, { ...options, asType: "chain" });
    case "retriever":
      return startActiveObservation(name, fn, { ...options, asType: "retriever" });
    case "evaluator":
      return startActiveObservation(name, fn, { ...options, asType: "evaluator" });
    case "guardrail":
      return startActiveObservation(name, fn, { ...options, asType: "guardrail" });
    case "embedding":
      return startActiveObservation(name, fn, { ...options, asType: "embedding" });
    default:
      return startActiveObservation(name, fn, options);
  }
}

function startTypedObservation(
  name: string,
  asType: LangfuseObservationType,
  attributes: {
    level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
    input?: unknown;
    output?: unknown;
    metadata?: Record<string, unknown>;
    statusMessage?: string;
    environment?: string;
    version?: string;
  },
  options: { parentSpanContext?: SpanContext; startTime?: Date },
) {
  switch (asType) {
    case "event":
      return startObservation(name, attributes, { ...options, asType: "event" });
    case "agent":
      return startObservation(name, attributes, { ...options, asType: "agent" });
    case "generation":
      return startObservation(name, attributes, { ...options, asType: "generation" });
    case "tool":
      return startObservation(name, attributes, { ...options, asType: "tool" });
    case "chain":
      return startObservation(name, attributes, { ...options, asType: "chain" });
    case "retriever":
      return startObservation(name, attributes, { ...options, asType: "retriever" });
    case "evaluator":
      return startObservation(name, attributes, { ...options, asType: "evaluator" });
    case "guardrail":
      return startObservation(name, attributes, { ...options, asType: "guardrail" });
    case "embedding":
      return startObservation(name, attributes, { ...options, asType: "embedding" });
    default:
      return startObservation(name, attributes, options);
  }
}

export async function withExecutionObservation<T>(
  context: ExecutionObservabilityContext,
  input: {
    name: string;
    asType?: ActiveObservationType;
    input?: unknown;
    metadata?: Record<string, unknown>;
  },
  fn: (observation: LangfuseObservation | null) => Promise<T>,
): Promise<T> {
  if (!isLangfuseEnabled()) return fn(null);

  const activeTraceId = getActiveTraceId();
  const options = activeTraceId
    ? {}
    : { parentSpanContext: await createDetachedParentSpanContext(context.rootExecutionId) };

  return withPropagatedContext(
    context,
    { includeTraceAttributes: !activeTraceId },
    () =>
      startActiveTypedObservation(
        input.name,
        input.asType ?? "span",
        async (observation) => {
          observation.updateOtelSpanAttributes(
            buildExecutionObservationAttributes(context, {
              input: input.input,
              metadata: input.metadata,
            }),
          );
          if (input.input !== undefined) {
            observation.setTraceIO(buildTraceIoAttributes({ input: input.input }));
          }
          return fn(observation);
        },
        options,
      ),
  );
}

export async function observeExecutionEvent(
  context: ExecutionObservabilityContext,
  input: {
    name: string;
    asType?: LangfuseObservationType;
    level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
    input?: unknown;
    output?: unknown;
    metadata?: Record<string, unknown>;
    statusMessage?: string;
  },
): Promise<ExecutionLangfuseLink | null> {
  if (!isLangfuseEnabled()) return null;

  const activeTraceId = getActiveTraceId();
  const options = activeTraceId
    ? {}
    : { parentSpanContext: await createDetachedParentSpanContext(context.rootExecutionId) };

  return withPropagatedContext(context, { includeTraceAttributes: false }, () => {
    const observation = startTypedObservation(
      input.name,
      input.asType ?? "event",
      buildExecutionObservationAttributes(context, input),
      options,
    );
    observation.end();
    return {
      traceId: observation.traceId,
      traceUrl: null,
    };
  });
}

export function startExecutionChildObservation(
  parentObservation: LangfuseObservation | null,
  context: ExecutionObservabilityContext,
  input: {
    name: string;
    asType?: LangfuseObservationType;
    startTime?: Date;
  } & ExecutionObservationAttributes,
): LangfuseObservation | null {
  if (!isLangfuseEnabled() || !parentObservation) return null;

  const { name, asType, startTime, ...attributes } = input;

  return withPropagatedContext(context, { includeTraceAttributes: false }, () =>
    startTypedObservation(
      name,
      asType ?? "span",
      buildExecutionObservationAttributes(context, attributes),
      {
        parentSpanContext: parentObservation.otelSpan.spanContext(),
        startTime,
      },
    ));
}

export function updateExecutionObservation(
  observation: LangfuseObservation | null,
  context: ExecutionObservabilityContext,
  attributes: ExecutionObservationAttributes,
) {
  if (!observation) return;
  observation.updateOtelSpanAttributes(buildExecutionObservationAttributes(context, attributes));
}

export function updateExecutionTraceIO(
  observation: LangfuseObservation | null,
  attributes: TraceIoAttributes,
) {
  if (!observation) return;
  const traceIo = buildTraceIoAttributes(attributes);
  if (Object.keys(traceIo).length === 0) return;
  observation.setTraceIO(traceIo);
}

export function updateExecutionTraceSession(
  observation: LangfuseObservation | null,
  sessionId: string | null | undefined,
) {
  const next = coerceString(sessionId);
  if (!observation || !next) return;
  observation.otelSpan.setAttributes({
    [LangfuseOtelSpanAttributes.TRACE_SESSION_ID]: next,
  });
}

export function updateExecutionTraceName(
  observation: LangfuseObservation | null,
  traceName: string | null | undefined,
) {
  const next = coerceString(traceName);
  if (!observation || !next) return;
  observation.otelSpan.setAttributes({
    [LangfuseOtelSpanAttributes.TRACE_NAME]: next,
  });
}

export async function getExecutionLangfuseLink(rootExecutionId: string): Promise<ExecutionLangfuseLink | null> {
  if (!isLangfuseEnabled() || !client) return null;

  const traceId = await getExecutionTraceId(rootExecutionId);
  const cachedUrl = traceUrlCache.get(traceId);
  if (cachedUrl) {
    return { traceId, traceUrl: cachedUrl };
  }

  try {
    const traceUrl = await client.getTraceUrl(traceId);
    traceUrlCache.set(traceId, traceUrl);
    return { traceId, traceUrl };
  } catch (error) {
    logger.warn(
      {
        rootExecutionId,
        traceId,
        err: error instanceof Error ? error.message : String(error),
      },
      "Failed to resolve Langfuse trace URL",
    );
    return { traceId, traceUrl: null };
  }
}

export function normalizeLangfuseScoreValue(value: boolean | number | string): {
  value: number | string;
  dataType?: "BOOLEAN" | "NUMERIC" | "CATEGORICAL";
} {
  if (typeof value === "boolean") {
    return { value: value ? 1 : 0, dataType: "BOOLEAN" };
  }
  if (typeof value === "number") {
    return { value, dataType: "NUMERIC" };
  }
  return { value, dataType: "CATEGORICAL" };
}

export async function createExecutionScores(
  context: ExecutionObservabilityContext,
  scores: LangfuseScoreInput[],
) {
  if (!isLangfuseEnabled() || !client) return;

  const traceId = await getExecutionTraceId(context.rootExecutionId);
  for (const score of scores) {
    try {
      const normalized = normalizeLangfuseScoreValue(score.value);
      client.score.create({
        id: score.id ?? createExecutionScoreId(context.rootExecutionId, score.name),
        traceId,
        name: score.name,
        value: normalized.value,
        comment: score.comment,
        metadata: buildObservationMetadata(context, score.metadata),
        environment: runtimeConfig?.environment,
        dataType: normalized.dataType,
      });
    } catch (error) {
      logger.warn(
        {
          rootExecutionId: context.rootExecutionId,
          scoreName: score.name,
          err: error instanceof Error ? error.message : String(error),
        },
        "Failed to enqueue Langfuse score",
      );
    }
  }
}
