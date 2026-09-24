type RuntimeTranscriptSourceRecord = {
  contextSnapshot?: unknown;
  resultJson?: unknown;
};

export type NativeTranscriptSourceOptions = {
  hasRuntimeSpan?: boolean;
  bindingContinuity?: "native" | "context_handoff" | "legacy" | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function markLegacyTranscriptSource(resultJson: unknown): Record<string, unknown> {
  const payload = asRecord(resultJson);
  return {
    ...(payload ?? {}),
    retention: {
      ...(asRecord(payload?.retention) ?? {}),
      transcriptSource: "legacy",
    },
  };
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasNativeIdentityMarker(record: Record<string, unknown> | null): boolean {
  if (!record) return false;
  return hasNonEmptyString(record.runtimeBindingId)
    || hasNonEmptyString(record.nativeBindingId)
    || hasNonEmptyString(record.runtimeSegmentId)
    || hasNonEmptyString(record.nativeSegmentId);
}

/**
 * A native source is explicit and durable. In particular, an empty native
 * span must remain native so an old log cannot become a second transcript.
 */
export function isNativeTranscriptSource(
  run: RuntimeTranscriptSourceRecord,
  options: NativeTranscriptSourceOptions = {},
): boolean {
  if (isExplicitLegacyTranscriptSource(run, options)) return false;
  if (options.hasRuntimeSpan === true) return true;
  if (options.bindingContinuity) return true;

  const context = asRecord(run.contextSnapshot);
  const admission = asRecord(context?.unifiedAgentRun);
  const retention = asRecord(asRecord(run.resultJson)?.retention);
  const contextSource = context?.transcriptSource;
  const retentionSource = retention?.transcriptSource;
  if (contextSource === "native" || contextSource === "native_plus_objects"
    || retentionSource === "native" || retentionSource === "native_plus_objects") return true;
  return hasNativeIdentityMarker(context)
    || hasNativeIdentityMarker(admission);
}

export function isExplicitLegacyTranscriptSource(
  run: RuntimeTranscriptSourceRecord,
  options: NativeTranscriptSourceOptions = {},
): boolean {
  const context = asRecord(run.contextSnapshot);
  const retention = asRecord(asRecord(run.resultJson)?.retention);
  return context?.transcriptSource === "legacy"
    || retention?.transcriptSource === "legacy"
    || options.bindingContinuity === "legacy";
}
