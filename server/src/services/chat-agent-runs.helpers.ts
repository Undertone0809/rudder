import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { AgentRuntimeInvocationMeta } from "../agent-runtimes/index.js";
import { readConsistentStoredInstructionSummary } from "./run-instruction-snapshots.compaction.js";
import { buildHeartbeatAdapterInvokePayload } from "./runtime-kernel/heartbeat.core.js";

const MAX_EVENT_TEXT_CHARS = 2_000;
const NATIVE_CHAT_TRANSCRIPT_RETENTION = {
  mode: "native",
  persistRawTranscript: false,
  reason: "native_transcript_capability",
} as const;

export function boundedText(value: string | null | undefined, max = MAX_EVENT_TEXT_CHARS) {
  if (!value) return null;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function runtimeSkillsFromInvocationPayload(payload: Record<string, unknown>) {
  const desiredSkills = Array.isArray(payload.desiredSkills) ? payload.desiredSkills : [];
  return desiredSkills.flatMap((value) => {
    const skill = asRecord(value);
    const key = nonEmptyText(skill?.key);
    if (!key) return [];
    return [{
      key,
      runtimeName: nonEmptyText(skill?.runtimeName) ?? key,
      name: nonEmptyText(skill?.name),
      description: nonEmptyText(skill?.description),
    }];
  });
}

export function compactNativeAdapterInvokePayload(payload: Record<string, unknown>) {
  const summary = buildHeartbeatAdapterInvokePayload({
    meta: payload as unknown as AgentRuntimeInvocationMeta,
    preservePersistedInstructionAlias: true,
    runtimeSkills: runtimeSkillsFromInvocationPayload(payload),
    transcriptRetention: NATIVE_CHAT_TRANSCRIPT_RETENTION,
  });
  // Native transcript completeness is not invocation-text equivalence. Only
  // the new-event snapshot readback may remove text; keep every raw fallback.
  return { ...summary, ...payload, invocationContent: readConsistentStoredInstructionSummary(payload) ?? {
    ...(summary.invocationContent as Record<string, unknown>),
    textStored: typeof payload.prompt === "string" || typeof payload.agentInstructionStack === "string",
    textSource: typeof payload.prompt === "string" || typeof payload.agentInstructionStack === "string"
      ? "persisted_invocation_inline" : payload.invocationInstructionTextReference ? "unverified_snapshot_reference" : "persisted_invocation_inline",
  } };
}

export function transcriptEventPayload(entry: TranscriptEntry): Record<string, unknown> {
  return entry as unknown as Record<string, unknown>;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value) ?? "null";
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

export function normalizeSourceSpanInput(input: {
  sourceRunId?: string | null;
  sourceSpanId?: string | null;
  sourceSelectorJson?: Record<string, unknown> | null;
}) {
  const sourceRunId = input.sourceRunId?.trim() || null;
  const sourceSpanId = input.sourceSpanId?.trim() || null;
  const sourceSelectorJson = input.sourceSelectorJson
    ? { ...input.sourceSelectorJson }
    : null;
  if (!sourceRunId && !sourceSpanId && !sourceSelectorJson) return null;
  if (!sourceRunId || !sourceSpanId || !sourceSelectorJson) {
    throw new Error("Chat source span metadata requires sourceRunId, sourceSpanId, and sourceSelectorJson");
  }
  if (typeof sourceSelectorJson.kind !== "string" || sourceSelectorJson.kind.trim().length === 0) {
    throw new Error("Chat source span selectorJson.kind is required");
  }
  if (sourceSelectorJson.kind === "pending" || sourceSelectorJson.kind === "unresolved") {
    throw new Error("Chat source span selectorJson must identify a completed native boundary");
  }
  return { sourceRunId, sourceSpanId, sourceSelectorJson };
}
