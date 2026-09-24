import { createHash } from "node:crypto";
import { forbidden } from "../../errors.js";
import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type {
  CompatibilityTranscriptReadResult,
  HeartbeatRunRecord,
  NativeSegmentRecord,
  NativeSpanSelector,
  NativeTranscriptRawItem,
  NativeTranscriptReadResult,
  RunRuntimeSpanRecord,
  RuntimeBindingRecord,
  TranscriptAvailability,
  TranscriptCompleteness,
  TranscriptItem,
  TranscriptPrincipal,
  TranscriptRange,
  TranscriptReaderErrorCode,
  TranscriptSource,
} from "./transcript-reader.contracts.js";

export class TranscriptReaderError extends Error {
  readonly status: number;

  constructor(readonly code: TranscriptReaderErrorCode, message: string, status = 400) {
    super(message);
    this.name = "TranscriptReaderError";
    this.status = status;
  }
}

export function transcriptReaderError(code: TranscriptReaderErrorCode, message: string, status = 400): TranscriptReaderError {
  return new TranscriptReaderError(code, message, status);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function isRawItemList(
  value: CompatibilityTranscriptReadResult | readonly NativeTranscriptRawItem[],
): value is readonly NativeTranscriptRawItem[] {
  return Array.isArray(value);
}

export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function isoDate(value: unknown, fallback = new Date(0).toISOString()): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, item) => item instanceof Date ? item.toISOString() : item)).digest("hex");
}

export function principalScopeRefs(principal: TranscriptPrincipal, orgId: string): string[] {
  const refs = [
    principal.principalScopeRef,
    principal.scopeRef,
    principal.id,
    ...(principal.scopeRefs ?? []),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim());
  return [...new Set(refs.length > 0 ? refs : [`org:${orgId}`])];
}

export function selectedPrincipalScope(principal: TranscriptPrincipal, orgId: string): string {
  return principalScopeRefs(principal, orgId)[0]!;
}

export function selectorFromSpan(span: RunRuntimeSpanRecord): NativeSpanSelector {
  const selector = asRecord(span.selectorJson);
  if (!selector) return { kind: "unresolved", runtimeType: undefined };
  const kind = nonEmptyString(selector.kind) ?? "unresolved";
  return { ...selector, kind } as NativeSpanSelector;
}

export function runtimeTypeFromSelector(selector: NativeSpanSelector): string | null {
  const declared = nonEmptyString(asRecord(selector)?.runtimeType);
  if (declared) return declared;
  switch (selector.kind) {
    case "codex_turn":
      return "codex_local";
    case "claude_chain":
      return "claude_local";
    case "hermes_execution":
      return "hermes_gateway";
    case "opencode_input":
      return "opencode_local";
    case "pi_branch_range":
      return "pi_local";
    case "cursor_execution":
      return "cursor";
    default:
      return null;
  }
}

export function assertSpanRuntimeConsistency(
  binding: RuntimeBindingRecord,
  segment: NativeSegmentRecord,
  selector: NativeSpanSelector,
): void {
  const bindingRuntimeType = nonEmptyString(binding.runtimeType);
  const segmentRuntimeType = nonEmptyString(segment.runtimeType);
  const selectorRuntime = runtimeTypeFromSelector(selector);
  if (!bindingRuntimeType || !segmentRuntimeType || bindingRuntimeType !== segmentRuntimeType) {
    throw forbidden("Transcript source runtime identity is inconsistent");
  }
  if (selectorRuntime && selectorRuntime !== bindingRuntimeType) {
    throw forbidden("Transcript selector runtime identity is inconsistent");
  }
}

export function runtimeTypeFromRun(run: HeartbeatRunRecord, binding?: RuntimeBindingRecord | null): string {
  if (binding?.runtimeType) return binding.runtimeType;
  const context = asRecord(run.contextSnapshot);
  return nonEmptyString(context?.agentRuntimeType)
    ?? nonEmptyString(context?.agent_runtime_type)
    ?? "process";
}

export function transcriptEntry(value: unknown): TranscriptEntry | null {
  const record = asRecord(value);
  if (!record || typeof record.kind !== "string" || typeof record.ts !== "string") return null;
  return record as TranscriptEntry;
}

export function stringAt(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = nonEmptyString(record[key]);
    if (value) return value;
  }
  return null;
}

function sourceEntryIdFor(entry: TranscriptEntry, raw: NativeTranscriptRawItem, fallback: string): string {
  const record = asRecord(raw);
  return stringAt(record, ["sourceEntryId", "source_entry_id", "id"])
    ?? stringAt(asRecord(entry), ["sourceEntryId", "source_entry_id", "id"])
    ?? fallback;
}

function normalizeRawItem(
  raw: NativeTranscriptRawItem,
  input: {
    runId: string | null;
    spanId: string | null;
    sequence: number;
    fallbackId: string;
    origin: "native" | "object" | "legacy";
  },
): TranscriptItem | null {
  const record = asRecord(raw);
  const structured = record
    && typeof record.kind === "string"
    && typeof record.ts === "string"
    && "payload" in record;
  if (structured) {
    const sourceEntryId = sourceEntryIdFor(record as TranscriptEntry, raw, input.fallbackId);
    const id = stringAt(record, ["id"]) ?? sourceEntryId;
    const ordinal = typeof record.ordinal === "number" && Number.isFinite(record.ordinal)
      ? record.ordinal
      : input.sequence;
    const visibility = record.visibility === "hidden" || record.visibility === "unknown"
      ? record.visibility
      : "visible";
    return {
      ...record,
      id,
      sequence: input.sequence,
      ordinal,
      runId: nonEmptyString(record.runId) ?? input.runId,
      spanId: nonEmptyString(record.spanId) ?? input.spanId,
      sourceEntryId,
      sourceRef: nonEmptyString(record.sourceRef),
      kind: String(record.kind),
      ts: String(record.ts),
      payload: record.payload,
      visibility,
      origin: (stringAt(record, ["origin"]) as TranscriptItem["origin"] | null) ?? input.origin,
    };
  }
  const nested = transcriptEntry(record?.entry) ?? transcriptEntry(raw);
  if (!nested) return null;
  const sourceEntryId = sourceEntryIdFor(nested, raw, input.fallbackId);
  const id = stringAt(record, ["id"]) ?? sourceEntryId;
  return {
    id,
    sequence: input.sequence,
    ordinal: input.sequence,
    runId: input.runId,
    spanId: input.spanId,
    sourceEntryId: sourceEntryIdFor(nested, raw, sourceEntryId),
    sourceRef: null,
    kind: nested.kind,
    ts: nested.ts,
    payload: nested,
    visibility: "visible",
    text: "text" in nested ? String((nested as { text?: unknown }).text ?? "") : undefined,
    entry: nested,
    origin: (stringAt(record, ["origin"]) as TranscriptItem["origin"] | null) ?? input.origin,
  };
}

export function normalizeItems(
  rawItems: readonly NativeTranscriptRawItem[],
  input: {
    runId: string | null;
    spanId: string | null;
    origin: "native" | "object" | "legacy";
    sourceRef?: string | null;
    sequenceOffset?: number;
  },
): TranscriptItem[] {
  const seen = new Set<string>();
  const items: TranscriptItem[] = [];
  for (const raw of rawItems) {
    const sequence = (input.sequenceOffset ?? 0) + items.length;
    const item = normalizeRawItem(raw, {
      ...input,
      sequence,
      fallbackId: `${input.spanId ?? input.runId ?? "transcript"}:${sequence}`,
    });
    if (!item) continue;
    let id = item.id;
    if (seen.has(id)) {
      let suffix = 2;
      while (seen.has(`${id}:${suffix}`)) suffix += 1;
      id = `${id}:${suffix}`;
    }
    seen.add(id);
    items.push({ ...item, id, sourceRef: item.sourceRef ?? input.sourceRef ?? null });
  }
  return items;
}

export function normalizeNativeResult(
  raw: NativeTranscriptReadResult | readonly NativeTranscriptRawItem[] | NativeTranscriptRawItem | null,
): NativeTranscriptReadResult {
  if (Array.isArray(raw)) return { items: raw };
  const record = asRecord(raw);
  if (!record) return { items: [] };
  if (typeof record.kind === "string" && typeof record.ts === "string") return { items: [raw as NativeTranscriptRawItem] };
  return record as NativeTranscriptReadResult;
}

export function availabilityRank(value: TranscriptAvailability): number {
  return { available: 0, offline: 1, missing: 2, expired: 3, incompatible: 4 }[value];
}

export function completenessRank(value: TranscriptCompleteness): number {
  return { complete: 0, partial: 1, terminal_only: 2, unknown: 3 }[value];
}

export function mergeAvailability(values: readonly TranscriptAvailability[]): TranscriptAvailability {
  return values.reduce((worst, value) => availabilityRank(value) > availabilityRank(worst) ? value : worst, "available");
}

export function mergeCompleteness(values: readonly TranscriptCompleteness[]): TranscriptCompleteness {
  return values.reduce((worst, value) => completenessRank(value) > completenessRank(worst) ? value : worst, "complete");
}

export function mergeSource(values: readonly TranscriptSource[]): TranscriptSource {
  const unique = new Set(values);
  if (unique.size === 0 || (unique.size === 1 && unique.has("native"))) return "native";
  if (unique.size === 1 && unique.has("legacy")) return "legacy";
  return "native_plus_objects";
}

export function isUnavailable(value: TranscriptAvailability): boolean {
  return value === "offline" || value === "missing";
}

export function mergeSupplementItems(
  primary: readonly TranscriptItem[],
  supplement: readonly TranscriptItem[],
): TranscriptItem[] {
  const items = [...primary];
  const seen = new Set<string>();
  for (const item of primary) {
    seen.add(item.id);
    if (item.sourceEntryId) seen.add(`source:${item.sourceEntryId}`);
  }
  for (const item of supplement) {
    if (seen.has(item.id) || (item.sourceEntryId && seen.has(`source:${item.sourceEntryId}`))) continue;
    items.push(item);
    seen.add(item.id);
    if (item.sourceEntryId) seen.add(`source:${item.sourceEntryId}`);
  }
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const ordinalDelta = left.item.ordinal - right.item.ordinal;
      return ordinalDelta !== 0 ? ordinalDelta : left.index - right.index;
    })
    .map(({ item }) => item);
}

export function compatibilityValueKey(value: unknown): string {
  return JSON.stringify(value ?? null);
}
