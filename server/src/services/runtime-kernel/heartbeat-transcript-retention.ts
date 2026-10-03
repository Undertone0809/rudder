import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import {
  runtimeProviderBindingsMatch,
  type RuntimeProviderBindingRef,
  type RuntimeProviderCapabilityResolution,
} from "./provider-capabilities.js";

export type HeartbeatTranscriptCapabilityStatus = "supported" | "unsupported" | "unknown";
export type HeartbeatTranscriptBindingContinuity = "native" | "context_handoff" | "legacy";
export type HeartbeatTranscriptRetentionMode = "native" | "legacy";

export type HeartbeatTranscriptRetentionReason =
  | "native_transcript_capability"
  | "native_profile_unverified"
  | "missing_native_binding"
  | "legacy_binding"
  | "native_transcript_unknown"
  | "native_transcript_unsupported";

export interface HeartbeatTranscriptRetentionPolicy {
  mode: HeartbeatTranscriptRetentionMode;
  reason: HeartbeatTranscriptRetentionReason;
  /** Raw stdout/stderr object-log writes are disabled for native transcripts. */
  persistRawLog: boolean;
  /** Full parsed stdout/stderr transcript accumulation is disabled for native transcripts. */
  persistRawTranscript: boolean;
  /** Raw transcript payloads in terminal effects/events are disabled for native transcripts. */
  persistRawTranscriptEvent: boolean;
  /** Full adapter result payloads are disabled for native transcripts. */
  persistRawResult: boolean;
}

export interface HeartbeatTranscriptRetentionInput {
  hasBinding: boolean;
  bindingContinuity?: HeartbeatTranscriptBindingContinuity | null;
  capabilityStatus?: HeartbeatTranscriptCapabilityStatus | null;
  profileCapability?: {
    runtimeType: string;
    binding: RuntimeProviderBindingRef;
    driverStatus: HeartbeatTranscriptCapabilityStatus;
    resolution: RuntimeProviderCapabilityResolution | null;
  } | null;
}

const MAX_NATIVE_TRANSCRIPT_MEMORY_ENTRIES = 128;
const MAX_NATIVE_TRANSCRIPT_MEMORY_BYTES = 128 * 1024;

/** Keep execution decisions bounded after the native provider becomes the transcript source. */
export function boundNativeHeartbeatTranscriptMemory(transcript: TranscriptEntry[]) {
  while (transcript.length > MAX_NATIVE_TRANSCRIPT_MEMORY_ENTRIES) transcript.shift();
  let bytes = 0;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index];
    let entryBytes = 0;
    try {
      entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
    } catch {
      entryBytes = MAX_NATIVE_TRANSCRIPT_MEMORY_BYTES;
    }
    bytes += entryBytes;
    if (bytes <= MAX_NATIVE_TRANSCRIPT_MEMORY_BYTES) continue;
    transcript.splice(0, index + 1);
    break;
  }
}

const LEGACY_RETENTION = {
  mode: "legacy",
  persistRawLog: true,
  persistRawTranscript: true,
  persistRawTranscriptEvent: true,
  persistRawResult: true,
} as const;

const NATIVE_RETENTION = {
  mode: "native",
  reason: "native_transcript_capability",
  persistRawLog: false,
  persistRawTranscript: false,
  persistRawTranscriptEvent: false,
  persistRawResult: false,
} as const;

export function hasVerifiedHeartbeatNativeTranscriptProfile(input: NonNullable<HeartbeatTranscriptRetentionInput["profileCapability"]>): boolean {
  const resolution = input.resolution;
  const transcript = resolution?.adapter.transcript;
  const evidence = transcript?.evidence;
  return input.driverStatus === "supported"
    && resolution?.profileResolved === true
    && resolution.adapter.runtimeType === input.runtimeType
    && runtimeProviderBindingsMatch(resolution.binding, input.binding)
    && evidence?.status === "supported"
    && evidence.profileBound === true
    && transcript != null
    && typeof transcript.readRange === "function";
}

/**
 * Native retention is enabled only after both the durable binding continuity
 * and the profile-bound transcript capability are explicitly supported.
 * Unknown, unsupported, legacy, or missing identity stays on the old path.
 */
export function resolveHeartbeatTranscriptRetention(
  input: HeartbeatTranscriptRetentionInput,
): HeartbeatTranscriptRetentionPolicy {
  if (!input.hasBinding) {
    return { ...LEGACY_RETENTION, reason: "missing_native_binding" };
  }
  if (input.bindingContinuity !== "native") {
    return { ...LEGACY_RETENTION, reason: "legacy_binding" };
  }
  if (input.capabilityStatus === "unknown" || input.capabilityStatus == null) {
    return { ...LEGACY_RETENTION, reason: "native_transcript_unknown" };
  }
  if (input.capabilityStatus !== "supported") {
    return { ...LEGACY_RETENTION, reason: "native_transcript_unsupported" };
  }
  if (!input.profileCapability || !hasVerifiedHeartbeatNativeTranscriptProfile(input.profileCapability)) {
    return { ...LEGACY_RETENTION, reason: "native_profile_unverified" };
  }
  return NATIVE_RETENTION;
}

const RAW_NATIVE_RESULT_KEYS = new Set([
  "stdout",
  "stderr",
  "response",
  "events",
  "rawjsonl",
  "rawstdout",
  "rawstderr",
  "transcript",
  "nativetranscript",
  "providerresponse",
  "providerevents",
  "messages",
  "parts",
  "entries",
  "items",
  "output",
  "body",
  "content",
  "text",
  "result",
]);

const NATIVE_RESULT_MAX_BYTES = 32 * 1024;
const NATIVE_RESULT_MAX_STRING_CHARS = 2_000;
const NATIVE_RESULT_MAX_ARRAY_ITEMS = 64;
const NATIVE_RESULT_MAX_OBJECT_KEYS = 64;
const NATIVE_RESULT_MAX_DEPTH = 5;

function normalizedKey(key: string) {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function boundedNativeDiagnosticValue(value: unknown, depth: number): unknown {
  if (depth > NATIVE_RESULT_MAX_DEPTH) return undefined;
  if (typeof value === "string") {
    return value.length > NATIVE_RESULT_MAX_STRING_CHARS
      ? value.slice(0, NATIVE_RESULT_MAX_STRING_CHARS)
      : value;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, NATIVE_RESULT_MAX_ARRAY_ITEMS)
      .map((entry) => boundedNativeDiagnosticValue(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  if (typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  const bounded: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record).slice(0, NATIVE_RESULT_MAX_OBJECT_KEYS)) {
    if (RAW_NATIVE_RESULT_KEYS.has(normalizedKey(key))) continue;
    const next = boundedNativeDiagnosticValue(child, depth + 1);
    if (next !== undefined) bounded[key] = next;
  }
  return bounded;
}

function serializedBytes(value: unknown) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Keep provider IDs, status, and bounded structured diagnostics while removing
 * fields that are commonly full transcript/log mirrors. Existing legacy rows
 * are never rewritten by this helper.
 */
export function retainNativeHeartbeatResultJson(
  resultJson: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const retained: Record<string, unknown> = {
    retention: {
      transcriptSource: "native",
      rawTranscriptPersisted: false,
      rawTranscriptEventPersisted: false,
      rawLogPersisted: false,
      rawResultPersisted: false,
    },
  };

  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) return retained;
  for (const [key, value] of Object.entries(resultJson)) {
    if (normalizedKey(key) === "retention") continue;
    if (RAW_NATIVE_RESULT_KEYS.has(normalizedKey(key))) continue;
    const bounded = boundedNativeDiagnosticValue(value, 0);
    if (bounded === undefined) continue;
    const candidate = { ...retained, [key]: bounded };
    if (serializedBytes(candidate) > NATIVE_RESULT_MAX_BYTES) continue;
    retained[key] = bounded;
  }
  return retained;
}

/** Native terminal effects must not receive a raw transcript fallback. */
export function transcriptForHeartbeatRetention(
  policy: HeartbeatTranscriptRetentionPolicy,
  transcript: readonly TranscriptEntry[],
): TranscriptEntry[] {
  return policy.persistRawTranscriptEvent ? [...transcript] : [];
}
