import type {
  AgentRuntimeExecutionContext,
  AgentRuntimeExecutionResult,
  AgentRuntimeLoadedSkillMeta,
} from "@rudderhq/agent-runtime-utils";
import {
  asNumber,
  asString,
  parseObject,
  readRudderRuntimeSkillEntries,
  resolveRudderDesiredSkillNames,
  RUDDER_PROMPT_SECTION_TAGS,
  wrapPromptSection,
} from "@rudderhq/agent-runtime-utils/server-utils";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asRecord, baseUrl, endpoint, hasBearerAuth, positiveMs, preflightBaseUrl, requestHeaders, requestJson, textFrom } from "./http.js";

const MAX_PROJECTED_EVENTS = 200;
const MAX_PROJECTED_EVENT_BYTES = 64 * 1024;
const MAX_PROJECTED_CONTEXT_BYTES = 512 * 1024;
const MAX_PROJECTED_TOKENS = 32_000;
const MAX_SAFE_EVENT_TEXT = MAX_PROJECTED_EVENT_BYTES;
const STOP_RECONCILIATION_MS = 1_500;
const MAX_SKILL_BYTES = 128 * 1024;
const MAX_SKILL_PROJECTION_BYTES = 512 * 1024;
const MAX_SESSION_LINEAGE_DEPTH = 32;
const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

type RunEvent = Record<string, unknown>;

function sessionKey(ctx: AgentRuntimeExecutionContext): string {
  const config = parseObject(ctx.config);
  const configured = asString(config.sessionKey, "").trim();
  const strategy = asString(config.sessionKeyStrategy, "issue").trim().toLowerCase();
  const issueId = asString(ctx.context.issueId ?? ctx.context.taskId, "").trim();
  if (strategy === "run") return `rudder:run:${ctx.runId}`;
  if (strategy === "fixed" && configured) return configured;
  if (issueId) return `rudder:issue:${issueId}`;
  return configured || `rudder:run:${ctx.runId}`;
}

function storedSessionId(ctx: AgentRuntimeExecutionContext): string | null {
  const runtimeParams = parseObject(ctx.runtime.sessionParams);
  const configured = asString(runtimeParams.hermesSessionId ?? runtimeParams.sessionId, "").trim();
  return configured || asString(ctx.runtime.sessionId, "").trim() || null;
}

function responseSessionId(body: Record<string, unknown>): string | null {
  const session = asRecord(body.session);
  const id = asString(session?.id ?? body.id ?? body.session_id, "").trim();
  return id || null;
}

type HermesSessionResolution = {
  providerSessionId: string;
  messageCount: number | null;
  created: boolean;
};

async function verifyHermesMessageSessionLineage(params: {
  base: URL;
  config: Record<string, unknown>;
  requestedSessionId: string;
  returnedSessionId: string;
  requestTimeout: number;
}): Promise<void> {
  let childSessionId = params.returnedSessionId;
  const seen = new Set<string>();

  for (let depth = 0; depth < MAX_SESSION_LINEAGE_DEPTH; depth += 1) {
    if (seen.has(childSessionId)) break;
    seen.add(childSessionId);

    const childResponse = await requestJson(
      endpoint(params.base, `/api/sessions/${encodeURIComponent(childSessionId)}`),
      params.config,
      {},
      params.requestTimeout,
    );
    if (!childResponse.response.ok) break;
    const returnedChildId = responseSessionId(childResponse.body);
    if (returnedChildId !== childSessionId) break;

    const child = asRecord(childResponse.body.session);
    const parentSessionId = asString(child?.parent_session_id, "").trim();
    if (!parentSessionId) break;

    const parentResponse = await requestJson(
      endpoint(params.base, `/api/sessions/${encodeURIComponent(parentSessionId)}`),
      params.config,
      {},
      params.requestTimeout,
    );
    if (!parentResponse.response.ok) break;
    const returnedParentId = responseSessionId(parentResponse.body);
    const parent = asRecord(parentResponse.body.session);
    const parentEndReason = asString(parent?.end_reason, "").trim().toLowerCase();

    // Hermes redirects message reads to the live tip after context compression.
    // Only compression edges are accepted so forks and unrelated descendants
    // cannot silently replace the provider session Rudder persisted.
    if (returnedParentId !== parentSessionId || parentEndReason !== "compression") break;
    if (parentSessionId === params.requestedSessionId) return;
    childSessionId = parentSessionId;
  }

  throw new Error(
    `Hermes session messages returned provider ID "${params.returnedSessionId}", ` +
    `which is not a verified compression continuation of "${params.requestedSessionId}".`,
  );
}

async function resolveHermesSession(params: {
  base: URL;
  config: Record<string, unknown>;
  ctx: AgentRuntimeExecutionContext;
  model: string;
  requestTimeout: number;
}): Promise<HermesSessionResolution> {
  let providerSessionId = storedSessionId(params.ctx);
  let created = false;

  if (providerSessionId) {
    const current = await requestJson(
      endpoint(params.base, `/api/sessions/${encodeURIComponent(providerSessionId)}`),
      params.config,
      {},
      params.requestTimeout,
    );
    if (!current.response.ok) {
      throw new Error(`Hermes session mapping could not be read (HTTP ${current.response.status}).`);
    }
    const returnedId = responseSessionId(current.body);
    if (!returnedId || returnedId !== providerSessionId) {
      throw new Error(
        `Hermes session mapping returned provider ID "${returnedId ?? "missing"}" ` +
        `for requested session "${providerSessionId}".`,
      );
    }
  } else {
    const createdResponse = await requestJson(
      endpoint(params.base, "/api/sessions"),
      params.config,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "rudder",
          ...(params.model ? { model: params.model } : {}),
        }),
      },
      params.requestTimeout,
    );
    if (!createdResponse.response.ok) {
      throw new Error(`Hermes session mapping could not be created (HTTP ${createdResponse.response.status}).`);
    }
    providerSessionId = responseSessionId(createdResponse.body);
    if (!providerSessionId) {
      throw new Error("Hermes session creation did not return a provider session ID.");
    }
    created = true;
  }

  const messages = await requestJson(
    endpoint(params.base, `/api/sessions/${encodeURIComponent(providerSessionId)}/messages`),
    params.config,
    {},
    params.requestTimeout,
  );
  if (!messages.response.ok) {
    throw new Error(`Hermes session messages could not be read (HTTP ${messages.response.status}).`);
  }
  const messageData = Array.isArray(messages.body.data) ? messages.body.data : [];
  const returnedMessageSessionId = asString(messages.body.session_id, "").trim();
  if (returnedMessageSessionId && returnedMessageSessionId !== providerSessionId) {
    await verifyHermesMessageSessionLineage({
      base: params.base,
      config: params.config,
      requestedSessionId: providerSessionId,
      returnedSessionId: returnedMessageSessionId,
      requestTimeout: params.requestTimeout,
    });
  }

  return { providerSessionId, messageCount: messageData.length, created };
}

function shortHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function boundedText(value: unknown): string | null {
  const text = textFrom(value);
  return text ? text.slice(0, MAX_SAFE_EVENT_TEXT) : null;
}

function buildToolContextProjection(ctx: AgentRuntimeExecutionContext, sessionId: string): {
  text: string;
  hash: string;
  eventCount: number;
  refusal: string | null;
} {
  const raw = Array.isArray(ctx.context.rudderToolContext)
    ? ctx.context.rudderToolContext
    : Array.isArray(ctx.context.transcript)
      ? ctx.context.transcript
      : [];
  const source = raw.slice(0, MAX_PROJECTED_EVENTS).map((entry) => asRecord(entry) ?? {});
  const ids = new Set<string>();
  const projected = source.map((entry, index) => {
    const kind = asString(entry.kind ?? entry.type ?? entry.event, "event").trim().slice(0, 64);
    const toolCallId = asString(entry.toolCallId ?? entry.tool_call_id ?? entry.id, "").trim().slice(0, 160) || null;
    if (kind === "tool_call" && toolCallId) ids.add(toolCallId);
    const content = textFrom(entry.content ?? entry.text ?? entry.output) ?? "";
    return {
      index,
      kind,
      tool: asString(entry.tool ?? entry.name, "").trim().slice(0, 160) || null,
      toolCallId,
      approvalId: asString(entry.approvalId ?? entry.approval_id, "").trim().slice(0, 160) || null,
      status: asString(entry.status, "").trim().slice(0, 64) || null,
      contentHash: shortHash(boundedText(content) ?? ""),
      contentBytes: Buffer.byteLength(content, "utf8"),
    };
  });
  const unpaired = projected.some((entry) =>
    (entry.kind === "tool_result" || entry.kind === "approval") && entry.toolCallId && !ids.has(entry.toolCallId),
  );
  const projection = {
    version: "RUDDER_TOOL_CONTEXT_V1",
    sessionId,
    transcriptHash: shortHash(projected),
    events: projected,
  };
  const serialized = JSON.stringify(projection);
  const projectedBytes = Buffer.byteLength(serialized, "utf8");
  const refusal = raw.length > MAX_PROJECTED_EVENTS
    ? "canonical tool context exceeds the 200-event limit"
    : projected.some((entry) => entry.contentBytes > MAX_PROJECTED_EVENT_BYTES)
      ? "a canonical event exceeds the 64 KiB per-event limit"
      : projectedBytes > MAX_PROJECTED_CONTEXT_BYTES
        ? "bounded tool context exceeds the 512 KiB aggregate limit"
        : Math.ceil(projectedBytes / 4) > MAX_PROJECTED_TOKENS
          ? "bounded tool context exceeds the 32,000-token estimate"
          : unpaired
    ? "causal tool/approval pairing is incomplete"
      : null;
  const bounded = refusal ? JSON.stringify({ version: "RUDDER_TOOL_CONTEXT_V1", sessionId, transcriptHash: shortHash([]), events: [] }) : serialized;
  return {
    text: `\n\nRUDDER_TOOL_CONTEXT_V1\n${bounded}`,
    hash: shortHash(bounded),
    eventCount: refusal ? 0 : projected.length,
    refusal,
  };
}

type HermesSkillProjection = {
  prompt: string;
  skills: AgentRuntimeLoadedSkillMeta[];
  bytes: number;
};

async function buildHermesSkillProjection(
  config: Record<string, unknown>,
): Promise<HermesSkillProjection> {
  const availableEntries = await readRudderRuntimeSkillEntries(config, __moduleDir);
  const availableByKey = new Map(availableEntries.map((entry) => [entry.key, entry]));
  const desiredSkills = resolveRudderDesiredSkillNames(config, availableEntries);
  const missing = desiredSkills.filter((key) => !availableByKey.has(key));
  if (missing.length > 0) {
    throw new Error(`Rudder could not resolve selected Hermes skills: ${missing.join(", ")}.`);
  }

  const sections: string[] = [];
  const skills: AgentRuntimeLoadedSkillMeta[] = [];
  let bytes = 0;
  for (const key of desiredSkills) {
    const entry = availableByKey.get(key)!;
    const skillPath = path.join(entry.source, "SKILL.md");
    const content = await fs.readFile(skillPath, "utf8").catch(() => null);
    if (!content?.trim()) {
      throw new Error(`Selected Hermes skill "${key}" has no readable SKILL.md.`);
    }
    const contentBytes = Buffer.byteLength(content, "utf8");
    if (contentBytes > MAX_SKILL_BYTES) {
      throw new Error(`Selected Hermes skill "${key}" exceeds the 128 KiB per-skill limit.`);
    }
    bytes += contentBytes;
    if (bytes > MAX_SKILL_PROJECTION_BYTES) {
      throw new Error("Selected Hermes skills exceed the 512 KiB aggregate limit.");
    }
    sections.push(`## Skill: ${key}\n\n${content.trim()}`);
    skills.push({
      key: entry.key,
      runtimeName: entry.runtimeName,
      name: entry.name ?? null,
    });
  }

  if (sections.length === 0) return { prompt: "", skills, bytes };
  return {
    prompt: wrapPromptSection(RUDDER_PROMPT_SECTION_TAGS.enabledSkills, [
      "Rudder is the source of truth for runtime skill enablement.",
      "Only skills listed in this section are enabled by Rudder for this run. Hermes provider-native, operator-home, project, global, or session skills are outside this Rudder projection and must not be described as Rudder-enabled skills.",
      "When asked which Rudder skills are enabled, answer from this section only.",
      "",
      sections.join("\n\n"),
    ].join("\n")),
    skills,
    bytes,
  };
}

function runMessage(
  ctx: AgentRuntimeExecutionContext,
  skillPrompt: string,
  toolContext: string,
): string {
  const context = ctx.context;
  const chatPrompt = context.chatMode === true ? asString(context.chatPrompt, "").trim() : "";
  const basePrompt = chatPrompt || [
    "Rudder wake event for Hermes API Server.",
    `run_id=${ctx.runId}`,
    `agent_id=${ctx.agent.id}`,
    `wake_reason=${asString(context.wakeReason, "manual")}`,
    asString(context.issueId ?? context.taskId, "")
      ? `issue_id=${asString(context.issueId ?? context.taskId, "")}`
      : null,
    "Use the authenticated Rudder context for this run and return a concise result.",
  ].filter(Boolean).join("\n");
  return [basePrompt, skillPrompt, toolContext].filter(Boolean).join("\n\n");
}

function terminalStatus(status: string): boolean {
  return ["completed", "failed", "cancelled", "stopped", "error"].includes(status.toLowerCase());
}

function statusFromTerminalEvent(event: RunEvent | null): string | null {
  const kind = asString(event?.event, "");
  if (kind === "run.completed") return "completed";
  if (kind === "run.failed") return "failed";
  if (kind === "run.cancelled") return "cancelled";
  return null;
}

function eventText(event: RunEvent): string | null {
  return textFrom(event.delta) ?? textFrom(event.output) ?? textFrom(event.content) ?? textFrom(event.message);
}

function usageFrom(value: unknown): { inputTokens: number; outputTokens: number } | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const inputTokens = asNumber(record.input_tokens ?? record.inputTokens, 0);
  const outputTokens = asNumber(record.output_tokens ?? record.outputTokens, 0);
  return inputTokens || outputTokens ? { inputTokens, outputTokens } : undefined;
}

function safeEvent(event: Record<string, unknown>): Record<string, unknown> {
  return {
    event: asString(event.event, "event").slice(0, 80),
    run_id: asString(event.run_id, "").slice(0, 120) || undefined,
    tool: asString(event.tool ?? event.name, "").slice(0, 160) || undefined,
    tool_call_id: asString(event.tool_call_id ?? event.call_id, "").slice(0, 160) || undefined,
    approval_id: asString(event.approval_id ?? event.approvalId, "").slice(0, 160) || undefined,
    status: asString(event.status, "").slice(0, 64) || undefined,
    choice: asString(event.choice, "").slice(0, 32) || undefined,
    deltaHash: event.delta !== undefined ? shortHash(boundedText(event.delta) ?? "") : undefined,
    outputHash: event.output !== undefined ? shortHash(boundedText(event.output) ?? "") : undefined,
  };
}

async function consumeSse(
  response: Response,
  onEvent: (event: RunEvent) => Promise<void>,
): Promise<{ malformed: boolean }> {
  if (!response.body) return { malformed: true };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let malformed = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        const event = asRecord(parsed);
        if (event) await onEvent(event);
      } catch {
        // Ignore malformed keepalive/application fragments; terminal status is
        // reconciled with GET /v1/runs below.
        malformed = true;
      }
    }
  }
  if (buffer.trim()) malformed = true;
  return { malformed };
}

export async function execute(ctx: AgentRuntimeExecutionContext): Promise<AgentRuntimeExecutionResult> {
  const config = parseObject(ctx.config);
  const base = baseUrl(config.url);
  if (!base) return { exitCode: 1, signal: null, timedOut: false, errorMessage: "Hermes API Server URL is missing or invalid.", errorCode: "hermes_gateway_url_invalid" };
  const endpointPreflight = await preflightBaseUrl(base);
  if (!endpointPreflight.ok) return { exitCode: 1, signal: null, timedOut: false, errorMessage: endpointPreflight.reason, errorCode: "hermes_gateway_endpoint_rejected" };
  if (!hasBearerAuth(config)) return { exitCode: 1, signal: null, timedOut: false, errorMessage: "Hermes API Server requires an explicit Bearer API key.", errorCode: "hermes_gateway_bearer_missing" };

  let skillProjection: HermesSkillProjection;
  try {
    skillProjection = await buildHermesSkillProjection(config);
  } catch (error) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: error instanceof Error ? error.message : "Hermes skill projection failed.",
      errorCode: "hermes_gateway_skill_projection_failed",
    };
  }

  const timeoutMs = positiveMs(config.timeoutMs ?? (asNumber(config.timeoutSec, 120) * 1000), 120_000);
  const requestTimeout = Math.min(timeoutMs, 15_000);
  const template = parseObject(config.payloadTemplate);
  const workstreamKey = sessionKey(ctx);
  const preliminaryToolContext = buildToolContextProjection(ctx, workstreamKey);
  if (preliminaryToolContext.refusal) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Hermes tool context refused: ${preliminaryToolContext.refusal}.`,
      errorCode: "hermes_gateway_continuity_refused",
      resultJson: {
        synthetic_tool_continuity: {
          mode: "synthetic_tool_continuity",
          native: false,
          lossless: false,
          projectionVersion: "RUDDER_TOOL_CONTEXT_V1",
          refusal: preliminaryToolContext.refusal,
        },
      },
    };
  }
  let session: HermesSessionResolution;
  try {
    session = await resolveHermesSession({
      base,
      config,
      ctx,
      model: asString(config.model, "").trim(),
      requestTimeout,
    });
  } catch (error) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: error instanceof Error ? error.message : "Hermes session mapping failed.",
      errorCode: "hermes_gateway_session_mapping_failed",
      resultJson: { sessionMapping: { mode: "hermes_sessions_api_v1", verified: false } },
    };
  }
  const toolContext = buildToolContextProjection(ctx, session.providerSessionId);
  if (toolContext.refusal) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Hermes tool context refused: ${toolContext.refusal}.`,
      errorCode: "hermes_gateway_continuity_refused",
      sessionParams: { sessionId: session.providerSessionId, hermesSessionId: session.providerSessionId },
      sessionDisplayId: session.providerSessionId,
      resultJson: {
        synthetic_tool_continuity: {
          mode: "synthetic_tool_continuity",
          native: false,
          lossless: false,
          projectionVersion: "RUDDER_TOOL_CONTEXT_V1",
          refusal: toolContext.refusal,
        },
      },
    };
  }
  const input = runMessage(ctx, skillProjection.prompt, toolContext.text);
  const body: Record<string, unknown> = {
    ...template,
    input,
    session_id: session.providerSessionId,
    idempotency_key: ctx.runId,
    ...(asString(config.model, "").trim() ? { model: asString(config.model, "").trim() } : {}),
  };
  delete body.message;

  if (ctx.onMeta) {
    await ctx.onMeta({
      agentRuntimeType: "hermes_gateway",
      command: "hermes-api",
      commandArgs: ["POST", endpoint(base, "/v1/runs").toString()],
      loadedSkills: skillProjection.skills,
      desiredSkills: skillProjection.skills,
      promptInjectedSkills: skillProjection.skills,
      promptMetrics: {
        promptChars: input.length,
        skillCount: skillProjection.skills.length,
        skillBytes: skillProjection.bytes,
      },
      context: ctx.context,
    });
  }
  await ctx.onLog("stdout", `[hermes-gateway] submitting run upstream=hermes-api base=${base.origin}\n`);

  let upstreamRunId: string | null = null;
  let stopSent = false;
  let stopStartedAt: number | null = null;
  let stopRequestAccepted = false;
  let stopRequestError: string | null = null;
  const stopUpstream = async (): Promise<boolean> => {
    if (!upstreamRunId) return false;
    if (stopSent) return stopRequestAccepted;
    stopSent = true;
    stopStartedAt = Date.now();
    try {
      const response = await requestJson(endpoint(base, `/v1/runs/${encodeURIComponent(upstreamRunId)}/stop`), config, { method: "POST", body: JSON.stringify({ reason: "rudder_abort" }), headers: { "content-type": "application/json" } }, requestTimeout);
      stopRequestAccepted = response.response.ok && ["stopping", "cancelled", "stopped"].includes(asString(response.body.status, "").toLowerCase());
      if (!stopRequestAccepted) stopRequestError = `HTTP ${response.response.status}`;
      await ctx.onLog("stdout", `[hermes-gateway] stop requested upstreamRunId=${upstreamRunId} accepted=${stopRequestAccepted}\n`);
    } catch (error) {
      stopRequestError = error instanceof Error ? error.message : String(error);
      await ctx.onLog("stderr", `[hermes-gateway] stop request failed upstreamRunId=${upstreamRunId}\n`);
    }
    return stopRequestAccepted;
  };
  const abortHandler = () => { void stopUpstream(); };
  ctx.abortSignal?.addEventListener("abort", abortHandler, { once: true });

  const started = await requestJson(endpoint(base, "/v1/runs"), config, { method: "POST", headers: { "content-type": "application/json", "x-hermes-session-key": workstreamKey }, body: JSON.stringify(body) }, requestTimeout);
  if (!started.response.ok) {
    ctx.abortSignal?.removeEventListener("abort", abortHandler);
    const message = textFrom(started.body) ?? `Hermes run submission returned HTTP ${started.response.status}`;
    return { exitCode: 1, signal: null, timedOut: false, errorMessage: message, errorCode: "hermes_gateway_submission_failed", resultJson: started.body };
  }
  upstreamRunId = asString(started.body.run_id ?? started.body.id, "").trim() || null;
  if (!upstreamRunId) {
    ctx.abortSignal?.removeEventListener("abort", abortHandler);
    return { exitCode: 1, signal: null, timedOut: false, errorMessage: "Hermes API Server did not return a run_id.", errorCode: "hermes_gateway_submission_indeterminate", resultJson: started.body };
  }
  await ctx.onLog("stdout", `[hermes-gateway] run accepted upstreamRunId=${upstreamRunId}\n`);

  let controlLease: { release(): Promise<void> } | null = null;
  if (ctx.controlAttempt) {
    controlLease = await ctx.controlAttempt.register({
      runtimeType: "hermes_gateway",
      providerThreadId: session.providerSessionId,
      providerTurnId: upstreamRunId,
      capabilities: { steer: "interrupt_continue", interrupt: "remote" },
      async steer() {
        return { disposition: "unsupported", reason: "Hermes Runs does not expose native steer." };
      },
      async interrupt() {
        return (await stopUpstream()) ? "acknowledged" : "unverified";
      },
      async dispose() {},
    });
    if (!controlLease) {
      await stopUpstream();
      ctx.abortSignal?.removeEventListener("abort", abortHandler);
      return { exitCode: 1, signal: null, timedOut: false, errorMessage: "Hermes runtime control lease was lost.", errorCode: "hermes_gateway_control_lost", sessionParams: { sessionId: session.providerSessionId, hermesSessionId: session.providerSessionId }, sessionDisplayId: session.providerSessionId };
    }
  }

  const startedAt = Date.now();
  const events: RunEvent[] = [];
  const assistant: string[] = [];
  let latestStatus: Record<string, unknown> = { ...started.body };
  let terminalEvent: RunEvent | null = null;
  let sseConnected = false;
  let sseMalformed = false;
  let sseError: string | null = null;
  let approvalPending = false;
  let approvalResolved = false;
  let approvalError: string | null = null;
  let approvalDecision: "once" | "deny" | null = null;
  let rudderApprovalId: string | null = null;
  const approvalChoice = (value: unknown): string | null => {
    const normalized = asString(value, "").trim().toLowerCase();
    if (["approved", "approve", "allow", "once"].includes(normalized)) return "once";
    if (["deny", "denied", "rejected", "reject"].includes(normalized)) return "deny";
    return null;
  };
  const resolveApproval = async (requestedChoice?: string | null) => {
    const choice = requestedChoice ?? approvalChoice(ctx.context.approvalStatus);
    if (!choice) return;
    const response = await requestJson(endpoint(base, `/v1/runs/${encodeURIComponent(upstreamRunId!)}/approval`), config, { method: "POST", body: JSON.stringify({ choice }), headers: { "content-type": "application/json" } }, requestTimeout);
    if (!response.response.ok) throw new Error(`Hermes approval returned HTTP ${response.response.status}`);
    approvalResolved = true;
    approvalDecision = choice as "once" | "deny";
    await ctx.onLog("stdout", `[hermes-gateway] approval resolved upstreamRunId=${upstreamRunId} choice=${choice}\n`);
  };
  const recordEvent = async (event: RunEvent) => {
    if (events.length < MAX_PROJECTED_EVENTS) events.push(event);
    const kind = asString(event.event, "event");
    await ctx.onLog("stdout", `[hermes-gateway:event] run=${upstreamRunId} type=${kind} summary=${JSON.stringify(safeEvent(event))}\n`);
    // Preserve leading/trailing whitespace in streaming deltas. `textFrom`
    // intentionally trims ordinary result fields, but trimming each delta
    // corrupts word boundaries when Hermes splits a sentence across events.
    const text = kind === "message.delta" && typeof event.delta === "string"
      ? event.delta
      : eventText(event);
    if (kind === "message.delta" && text) assistant.push(text);
    if (["run.completed", "run.failed", "run.cancelled"].includes(kind)) terminalEvent = event;
    if (kind === "approval.request") {
      approvalPending = true;
      try {
        const configuredChoice = approvalChoice(ctx.context.approvalStatus);
        if (configuredChoice) {
          await resolveApproval(configuredChoice);
        } else if (ctx.requestApproval && ctx.waitForApproval) {
          const request = await ctx.requestApproval({
            type: "agent_runtime",
            payload: {
              provider: "hermes",
              runtimeType: "hermes_gateway",
              upstreamRunId,
              sessionId: session.providerSessionId,
              event: safeEvent(event),
              choices: ["once", "deny"],
            },
          });
          rudderApprovalId = request.id;
          await ctx.onLog("stdout", `[hermes-gateway] Rudder approval requested id=${request.id} upstreamRunId=${upstreamRunId}\n`);
          const decision = await ctx.waitForApproval(request.id, timeoutMs);
          if (decision.status === "approved") await resolveApproval("once");
          else if (decision.status === "rejected") await resolveApproval("deny");
          else approvalError = "Hermes approval remained unresolved before the bounded wait expired.";
        } else {
          approvalError = "Hermes approval is pending and no Rudder approval bridge is available.";
        }
      } catch (error) {
        approvalError = error instanceof Error ? error.message : String(error);
      }
      await ctx.onLog("stderr", `[hermes-gateway] approval required upstreamRunId=${upstreamRunId} resolved=${approvalResolved}\n`);
    }
  };

  try {
    const sseController = new AbortController();
    const abortSse = () => sseController.abort();
    ctx.abortSignal?.addEventListener("abort", abortSse, { once: true });
    const sseTimer = setTimeout(() => sseController.abort(), timeoutMs);
    try {
      const sse = await fetch(endpoint(base, `/v1/runs/${encodeURIComponent(upstreamRunId)}/events`), { headers: requestHeaders(config), redirect: "error", signal: sseController.signal });
      if (sse.ok) {
        sseConnected = true;
        const stream = await consumeSse(sse, recordEvent);
        sseMalformed = stream.malformed;
      } else {
        sseError = `events_http_${sse.status}`;
        await ctx.onLog("stderr", `[hermes-gateway] events endpoint returned HTTP ${sse.status}; reconciling status\n`);
      }
    } finally {
      clearTimeout(sseTimer);
      ctx.abortSignal?.removeEventListener("abort", abortSse);
    }
  } catch (error) {
    sseError = error instanceof Error ? error.message : "events_stream_failed";
    await ctx.onLog("stderr", `[hermes-gateway] events stream ended: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  // Hermes emits the terminal lifecycle event before closing the SSE stream,
  // while the initial POST response intentionally remains `started`. Preserve
  // that authoritative terminal observation so a completed run cannot fall
  // through to the bounded timeout loop when the status GET races the stream.
  const observedTerminalEvent = terminalEvent as RunEvent | null;
  const eventStatus = statusFromTerminalEvent(observedTerminalEvent);
  if (eventStatus && !terminalStatus(asString(latestStatus.status, ""))) {
    latestStatus = {
      ...latestStatus,
      status: eventStatus,
      ...(observedTerminalEvent?.output !== undefined ? { output: observedTerminalEvent.output } : {}),
      ...(observedTerminalEvent?.error !== undefined ? { error: observedTerminalEvent.error } : {}),
      ...(observedTerminalEvent?.usage !== undefined ? { usage: observedTerminalEvent.usage } : {}),
    };
  }

  const reconciliationDeadline = () => stopSent && stopStartedAt ? stopStartedAt + STOP_RECONCILIATION_MS : startedAt + timeoutMs;
  while (!terminalStatus(asString(latestStatus.status, "")) && Date.now() < reconciliationDeadline()) {
    if (ctx.abortSignal?.aborted) {
      await stopUpstream();
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      const polled = await requestJson(endpoint(base, `/v1/runs/${encodeURIComponent(upstreamRunId)}`), config, {}, Math.min(requestTimeout, 5_000));
      latestStatus = polled.body;
      const status = asString(latestStatus.status, "");
      if (terminalStatus(status)) break;
    } catch {
      // Keep the last authenticated status and allow the bounded timeout to
      // produce an honest indeterminate result.
    }
  }
  ctx.abortSignal?.removeEventListener("abort", abortHandler);
  await controlLease?.release();

  if (!terminalStatus(asString(latestStatus.status, "")) && !stopSent) {
    await stopUpstream();
    while (!terminalStatus(asString(latestStatus.status, "")) && Date.now() < reconciliationDeadline()) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        const polled = await requestJson(endpoint(base, `/v1/runs/${encodeURIComponent(upstreamRunId)}`), config, {}, Math.min(requestTimeout, 5_000));
        latestStatus = polled.body;
      } catch {
        // Keep the last authenticated status; the final result records that cancellation was unverified.
      }
    }
  }

  const status = asString(latestStatus.status, "").toLowerCase();
  const terminal = terminalEvent as RunEvent | null;
  const output = assistant.join("").trim() || textFrom(terminal) || textFrom(latestStatus.output) || null;
  const usage = usageFrom(terminal?.usage ?? latestStatus.usage);
  const continuity = {
    mode: "synthetic_tool_continuity",
    native: false,
    lossless: false,
    projectionVersion: "RUDDER_TOOL_CONTEXT_V1",
    maxEvents: MAX_PROJECTED_EVENTS,
    maxEventBytes: MAX_PROJECTED_EVENT_BYTES,
    maxAggregateBytes: MAX_PROJECTED_CONTEXT_BYTES,
    maxTokenEstimate: MAX_PROJECTED_TOKENS,
    eventCount: events.length,
    toolContextHash: toolContext.hash,
    projectedEventCount: toolContext.eventCount,
  };
  if (approvalPending && !approvalResolved && !approvalError) {
    approvalError = "Hermes approval is pending and no Rudder approval decision was supplied.";
  }
  const resultJson = {
    upstreamRunId,
    status,
    output,
    events: events.map((event) => safeEvent(event)),
    synthetic_tool_continuity: continuity,
    sessionMapping: {
      mode: "hermes_sessions_api_v1",
      providerSessionId: session.providerSessionId,
      created: session.created,
      verified: true,
      messageCount: session.messageCount,
    },
    control: { stopRequested: stopSent, stopAccepted: stopRequestAccepted, stopRequestError },
    approval: { pending: approvalPending, resolved: approvalResolved, decision: approvalDecision, rudderApprovalId, error: approvalError },
    eventCompleteness: {
      status: terminalEvent
        ? (sseMalformed ? "partial" : "complete")
        : (sseConnected || sseError ? "partial" : "terminal_only"),
      sseConnected,
      terminalEventObserved: Boolean(terminalEvent),
      malformedEvents: sseMalformed,
      eventCount: events.length,
      reason: sseError ?? (sseMalformed ? "malformed_sse_event" : terminalEvent ? null : "terminal_status_reconciled_without_terminal_event"),
    },
  };
  if (approvalError) {
    return { exitCode: 1, signal: null, timedOut: false, errorMessage: approvalError, errorCode: "hermes_gateway_approval_unresolved", sessionParams: { sessionId: session.providerSessionId, hermesSessionId: session.providerSessionId }, sessionDisplayId: session.providerSessionId, resultJson };
  }
  if (ctx.abortSignal?.aborted || stopSent || status === "cancelled" || status === "stopped") {
    if (!terminalStatus(status) || !["cancelled", "stopped"].includes(status)) {
      return { exitCode: 1, signal: "SIGTERM", timedOut: false, errorMessage: "Hermes stop was requested but terminal state was not verified.", errorCode: "hermes_gateway_cancel_unverified", sessionParams: { sessionId: session.providerSessionId, hermesSessionId: session.providerSessionId }, sessionDisplayId: session.providerSessionId, resultJson, ...(output ? { summary: output } : {}) };
    }
    return { exitCode: 1, signal: "SIGTERM", timedOut: false, errorMessage: "Hermes run stopped.", errorCode: "hermes_gateway_stopped", sessionParams: { sessionId: session.providerSessionId, hermesSessionId: session.providerSessionId }, sessionDisplayId: session.providerSessionId, resultJson, ...(output ? { summary: output } : {}) };
  }
  if (!terminalStatus(status) || Date.now() - startedAt >= timeoutMs) {
    return { exitCode: 1, signal: null, timedOut: !stopSent, errorMessage: stopSent ? "Hermes stop was requested but terminal state was not verified." : `Hermes run timed out after ${timeoutMs}ms.`, errorCode: stopSent ? "hermes_gateway_cancel_unverified" : "hermes_gateway_timeout", sessionParams: { sessionId: session.providerSessionId, hermesSessionId: session.providerSessionId }, sessionDisplayId: session.providerSessionId, resultJson };
  }
  if (status !== "completed") {
    return { exitCode: 1, signal: null, timedOut: false, errorMessage: textFrom(latestStatus.error) ?? `Hermes run ended with status ${status}.`, errorCode: "hermes_gateway_run_failed", sessionParams: { sessionId: session.providerSessionId, hermesSessionId: session.providerSessionId }, sessionDisplayId: session.providerSessionId, resultJson, ...(output ? { summary: output } : {}) };
  }
  return { exitCode: 0, signal: null, timedOut: false, provider: "hermes", model: asString(latestStatus.model, "") || null, ...(usage ? { usage } : {}), sessionParams: { sessionId: session.providerSessionId, hermesSessionId: session.providerSessionId }, sessionDisplayId: session.providerSessionId, resultJson, ...(output ? { summary: output } : {}) };
}
