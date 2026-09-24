import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import {
  chatConversations,
  chatMessages,
  heartbeatRunEvents,
  heartbeatRuns,
  nativeSegments,
  runRuntimeSpans,
  runtimeBindings,
} from "@rudderhq/db";
import { buildTranscript, getTranscriptParser, parseNdjsonLog } from "@rudderhq/run-intelligence-core";
import type { ChatStreamTranscriptEntry } from "@rudderhq/shared";
import { and, asc, desc, eq, gt, isNull, or } from "drizzle-orm";
import { createHash } from "node:crypto";
import { badRequest, forbidden, notFound } from "../../errors.js";
import {
  loadChatTranscripts,
  type ChatTranscriptMessageSource,
} from "../chat-transcript-persistence.js";
import {
  getRunLogStore,
  type RunLogHandle,
  type RunLogReadResult,
  type RunLogStore,
} from "../run-log-store.js";

type ReadDatabase = Pick<Db, "select">;

type RuntimeBindingRecord = typeof runtimeBindings.$inferSelect;
type NativeSegmentRecord = typeof nativeSegments.$inferSelect;
type RunRuntimeSpanRecord = typeof runRuntimeSpans.$inferSelect;
type HeartbeatRunRecord = typeof heartbeatRuns.$inferSelect;

export type TranscriptSource = "native" | "native_plus_objects" | "legacy";
export type TranscriptAvailability = "available" | "offline" | "missing" | "expired" | "incompatible";
export type TranscriptCompleteness = "complete" | "partial" | "terminal_only" | "unknown";

/** The stable selector stored by the runtime kernel for one Run span. */
export type NativeSpanSelector =
  | { kind: "codex_turn"; threadId: string; turnId: string | null; inputCorrelationRef?: string | null; runId?: string }
  | { kind: "claude_chain"; sessionId: string; startExclusiveUuid: string | null; throughInclusiveUuid: string | null; inputCorrelationRef?: string | null; ancestryRevision?: string | null }
  | { kind: "hermes_execution"; sessionRef: string; providerExecutionRef: string | null; sourceRangeRef?: string | null; boundaryStatus?: string | null; inputCorrelationRef?: string | null }
  | { kind: "opencode_input"; sessionId: string; userMessageId: string | null; terminalMessageIds: string[]; inputCorrelationRef?: string | null }
  | { kind: "pi_branch_range"; sessionResourceRef: string; fromExclusive: string | null; throughInclusive: string | null; leafId: string | null; inputCorrelationRef?: string | null }
  | { kind: "cursor_execution"; sessionId: string; executionRef: string | null; nativeRangeRef: string | null; inputCorrelationRef?: string | null }
  | { kind: "native_execution" | "unresolved" | "pending"; runtimeType?: string; sessionId?: string | null; executionRef?: string | null; runId?: string; inputCorrelationRef?: string | null }
  | ({ kind: string } & Record<string, unknown>);

export interface TranscriptPrincipal {
  /** Principal kind used to bind cursors to the authenticated caller. */
  type?: string | null;
  /** The authenticated organization, when the caller carries one. */
  orgId?: string | null;
  /** Opaque authorization scope persisted on a Runtime Binding. */
  principalScopeRef?: string | null;
  /** Alias accepted for callers that use the shorter name. */
  scopeRef?: string | null;
  /** Additional scopes granted to the same principal. */
  scopeRefs?: readonly string[];
  id?: string | null;
  authorized?: boolean;
}

export interface TranscriptRangeBoundary {
  itemId?: string | null;
  ordinal?: number | null;
}

export interface TranscriptRange {
  /** Inclusive item id or zero-based item index. */
  start?: string | number | TranscriptRangeBoundary | null;
  /** Inclusive item id or zero-based item index. */
  end?: string | number | TranscriptRangeBoundary | null;
  /** Exclusive source item id or boundary. */
  fromExclusive?: string | number | TranscriptRangeBoundary | null;
  /** Inclusive source item id or boundary. */
  throughInclusive?: string | number | TranscriptRangeBoundary | null;
  /** Compatibility aliases for callers using cursor-like names. */
  after?: string | number | TranscriptRangeBoundary | null;
  before?: string | number | TranscriptRangeBoundary | null;
  itemId?: string | null;
}

export interface TranscriptItem {
  /** Stable id suitable for cursors, annotations, and detail reads. */
  id: string;
  /** Zero-based position in the resolved source range. */
  sequence?: number;
  /** Stable source ordinal when the provider exposes one. */
  ordinal: number;
  runId: string | null;
  spanId: string | null;
  sourceEntryId?: string;
  sourceRef: string | null;
  kind: string;
  ts: string;
  payload: unknown;
  visibility: "visible" | "hidden" | "unknown";
  origin?: "native" | "object" | "legacy";
  text?: string;
  entry?: TranscriptEntry;
}

export interface TranscriptPage {
  items: TranscriptItem[];
  nextCursor: string | null;
  source: TranscriptSource;
  revision: string;
  availability: TranscriptAvailability;
  completeness: TranscriptCompleteness;
}

export interface ReadTranscriptScope {
  orgId: string;
  principal: TranscriptPrincipal;
  spanId?: string | null;
  cursor?: string | null;
  limit?: number;
  range?: TranscriptRange | null;
  visibilityCutoffRef?: string | null;
  signal?: AbortSignal;
}

export interface ReadRunTranscript extends ReadTranscriptScope {
  runId: string;
}

export interface ReadConversationTranscript extends ReadTranscriptScope {
  conversationId: string;
}

export interface ReadTranscriptItem extends ReadTranscriptScope {
  runId?: string;
  conversationId?: string;
  itemId: string;
}

export type NativeTranscriptRawItem = TranscriptEntry | TranscriptItem | {
  id?: string;
  sourceEntryId?: string;
  entry?: TranscriptEntry;
  origin?: "native" | "object";
  [key: string]: unknown;
};

export interface NativeTranscriptReadInput {
  readonly: true;
  scope: "run";
  orgId: string;
  principal: TranscriptPrincipal;
  run: HeartbeatRunRecord;
  binding: RuntimeBindingRecord | null;
  segment: NativeSegmentRecord | null;
  span: RunRuntimeSpanRecord;
  selector: NativeSpanSelector;
  cursor: string | null;
  /** Maximum number of source items requested for this bounded read window. */
  limit?: number;
  itemId?: string | null;
  range?: TranscriptRange | null;
  visibilityCutoffRef?: string | null;
  signal?: AbortSignal;
}

export interface NativeTranscriptReadResult {
  items?: readonly NativeTranscriptRawItem[];
  entries?: readonly NativeTranscriptRawItem[];
  item?: NativeTranscriptRawItem | null;
  nextCursor?: string | null;
  revision?: string | null;
  source?: TranscriptSource;
  availability?: TranscriptAvailability;
  completeness?: TranscriptCompleteness;
}

export interface NativeTranscriptReaderHook {
  read?: (input: NativeTranscriptReadInput) => Promise<NativeTranscriptReadResult | readonly NativeTranscriptRawItem[]>;
  readRange?: (input: NativeTranscriptReadInput) => Promise<NativeTranscriptReadResult | readonly NativeTranscriptRawItem[]>;
  readItem?: (input: NativeTranscriptReadInput) => Promise<NativeTranscriptReadResult | NativeTranscriptRawItem | null>;
}

export interface LegacyTranscriptReadInput {
  readonly: true;
  run: HeartbeatRunRecord;
  runtimeType: string;
  spanId?: string | null;
  events?: readonly Record<string, unknown>[];
  signal?: AbortSignal;
}

export interface LegacyTranscriptReadResult {
  entries: readonly TranscriptEntry[];
  revision?: string | null;
  availability?: TranscriptAvailability;
  completeness?: TranscriptCompleteness;
}

export interface LegacyTranscriptReaderHook {
  readRun(input: LegacyTranscriptReadInput): Promise<LegacyTranscriptReadResult | readonly TranscriptEntry[]>;
}

export interface TranscriptReaderOptions {
  nativeReader?: NativeTranscriptReaderHook | null;
  /** Alias for a host reader that reads an object supplement instead of a native session. */
  objectReader?: NativeTranscriptReaderHook | null;
  legacyReader?: LegacyTranscriptReaderHook | null;
  logStore?: RunLogStore;
  maxLegacyReadBytes?: number;
  authorizePrincipal?: (input: {
    orgId: string;
    principal: TranscriptPrincipal;
    target: "run" | "conversation" | "span";
    runId?: string;
    conversationId?: string | null;
    binding?: RuntimeBindingRecord | null;
  }) => boolean | Promise<boolean>;
}

export type TranscriptStreamEvent =
  | { type: "snapshot"; page: TranscriptPage }
  | { type: "item"; item: TranscriptItem }
  | { type: "complete"; nextCursor: string | null };

export interface TranscriptReader {
  readRun(input: ReadRunTranscript): Promise<TranscriptPage>;
  readConversation(input: ReadConversationTranscript): Promise<TranscriptPage>;
  readItem(input: ReadTranscriptItem): Promise<TranscriptItem>;
  stream(input: ReadRunTranscript | ReadConversationTranscript): AsyncIterable<TranscriptStreamEvent>;
}

export interface TranscriptReadScope {
  orgId: string;
  principal: TranscriptPrincipal;
  runId: string;
  conversationId?: string | null;
  spanId?: string | null;
  mode?: "native" | "legacy";
  cursor?: string | null;
  limit?: number;
  range?: TranscriptRange | null;
  visibilityCutoffRef?: string | null;
}

export interface TranscriptReadAuthorization {
  org: boolean;
  principal: boolean;
  run: boolean;
  span: boolean;
  visibilityCutoffRef?: string | null;
  visibilityCutoff?: { ref: string; ordinal: number; itemId?: string | null } | null;
  spanDescriptor?: {
    id: string;
    runId: string;
    sourceRef: string;
    revision: string;
    selector: NativeSpanSelector;
    completeness: TranscriptCompleteness;
    visibilityCutoffRef?: string | null;
  } | null;
}

export interface CompatibilityTranscriptPage {
  items: readonly TranscriptItem[];
  nextCursor: string | null;
  source: TranscriptSource;
  revision: string;
  availability: TranscriptAvailability;
  completeness: TranscriptCompleteness;
}

export interface CompatibilityTranscriptReadInput extends TranscriptReadScope {
  scope: TranscriptReadScope;
  cursor: string | null;
  limit: number;
  range: TranscriptRange | null;
  visibilityCutoffRef: string | null;
  visibilityCutoff: { ref: string; ordinal: number; itemId: string | null } | null;
  expectedRevision: string | null;
}

export interface CompatibilityTranscriptReadResult {
  items?: readonly NativeTranscriptRawItem[];
  entries?: readonly NativeTranscriptRawItem[];
  item?: NativeTranscriptRawItem | null;
  nextCursor?: string | null;
  source?: TranscriptSource;
  revision?: string | null;
  availability?: TranscriptAvailability;
  completeness?: TranscriptCompleteness;
}

export type CompatibilityTranscriptReaderHook = (
  input: CompatibilityTranscriptReadInput,
) => Promise<CompatibilityTranscriptReadResult | readonly NativeTranscriptRawItem[]>;

export interface CompatibilityTranscriptReader {
  read(input: TranscriptReadScope): Promise<CompatibilityTranscriptPage>;
}

export type CompatibilityTranscriptReaderApi = CompatibilityTranscriptReader;

export interface TranscriptReaderFactoryOptions {
  authorize: (scope: TranscriptReadScope) => TranscriptReadAuthorization | Promise<TranscriptReadAuthorization>;
  nativeReader?: CompatibilityTranscriptReaderHook | null;
  legacyReader?: CompatibilityTranscriptReaderHook | null;
  defaultLimit?: number;
}

type CursorScope = "run" | "conversation";
type ConversationSourceKind = "run" | "message";
type ConversationSourceCursor = {
  kind: ConversationSourceKind;
  id: string;
  createdAt: string;
  updatedAt?: string | null;
  /** The source is exhausted but follows an earlier source still being read. */
  done?: boolean;
  /** Cursor for the current provider page of a Run source. */
  runCursor?: string | null;
  /** Offset into the selected message transcript source. */
  messageOffset?: number;
};

type CursorPayload = {
  version: 1;
  scope: CursorScope;
  orgId: string;
  principalScopeRef: string;
  principalType?: string;
  principalId?: string;
  runId?: string;
  conversationId?: string;
  spanId?: string | null;
  principalIdentity?: string;
  source?: TranscriptSource;
  range?: TranscriptRange | null;
  visibilityCutoffRef?: string | null;
  providerCursor?: string | null;
  /** Cursor used to obtain the provider page currently being consumed. */
  providerPageCursor?: string | null;
  /** Provider cursor returned after the current page. */
  providerNextCursor?: string | null;
  /** The span whose provider page is represented by this cursor. */
  activeSpanId?: string | null;
  /** Stable metadata revision for the run/span window. */
  windowRevision?: string;
  /** Revision reported by the active provider source. */
  providerRevision?: string | null;
  sourceTransition?: boolean;
  /** Stable keyset state for bounded Conversation reads. */
  conversationAfter?: Pick<ConversationSourceCursor, "kind" | "id" | "createdAt"> | null;
  conversationSources?: ConversationSourceCursor[];
  conversationMoreSources?: boolean;
  revision: string;
  position: number;
};

export type TranscriptCursor = CursorPayload;

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
const DEFAULT_LEGACY_READ_BYTES = 256 * 1024;
const MAX_LEGACY_READ_BYTES = 2 * 1024 * 1024;
const MAX_CONVERSATION_SOURCE_SCAN = MAX_PAGE_LIMIT * 4;

export type TranscriptReaderErrorCode =
  | "unauthorized"
  | "cursor_scope_mismatch"
  | "cursor_source_mismatch"
  | "cursor_revision_mismatch"
  | "cursor_invalid";

export class TranscriptReaderError extends Error {
  readonly status: number;

  constructor(readonly code: TranscriptReaderErrorCode, message: string, status = 400) {
    super(message);
    this.name = "TranscriptReaderError";
    this.status = status;
  }
}

function transcriptReaderError(code: TranscriptReaderErrorCode, message: string, status = 400): TranscriptReaderError {
  return new TranscriptReaderError(code, message, status);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isRawItemList(
  value: CompatibilityTranscriptReadResult | readonly NativeTranscriptRawItem[],
): value is readonly NativeTranscriptRawItem[] {
  return Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isoDate(value: unknown, fallback = new Date(0).toISOString()): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, item) => item instanceof Date ? item.toISOString() : item)).digest("hex");
}

function principalScopeRefs(principal: TranscriptPrincipal, orgId: string): string[] {
  const refs = [
    principal.principalScopeRef,
    principal.scopeRef,
    principal.id,
    ...(principal.scopeRefs ?? []),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim());
  return [...new Set(refs.length > 0 ? refs : [`org:${orgId}`])];
}

function selectedPrincipalScope(principal: TranscriptPrincipal, orgId: string): string {
  return principalScopeRefs(principal, orgId)[0]!;
}

function selectorFromSpan(span: RunRuntimeSpanRecord): NativeSpanSelector {
  const selector = asRecord(span.selectorJson);
  if (!selector) return { kind: "unresolved", runtimeType: undefined };
  const kind = nonEmptyString(selector.kind) ?? "unresolved";
  return { ...selector, kind } as NativeSpanSelector;
}

function runtimeTypeFromSelector(selector: NativeSpanSelector): string | null {
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

function assertSpanRuntimeConsistency(
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

function runtimeTypeFromRun(run: HeartbeatRunRecord, binding?: RuntimeBindingRecord | null): string {
  if (binding?.runtimeType) return binding.runtimeType;
  const context = asRecord(run.contextSnapshot);
  return nonEmptyString(context?.agentRuntimeType)
    ?? nonEmptyString(context?.agent_runtime_type)
    ?? "process";
}

function transcriptEntry(value: unknown): TranscriptEntry | null {
  const record = asRecord(value);
  if (!record || typeof record.kind !== "string" || typeof record.ts !== "string") return null;
  return record as TranscriptEntry;
}

function stringAt(record: Record<string, unknown> | null, keys: string[]): string | null {
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

function normalizeItems(
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

function normalizeNativeResult(
  raw: NativeTranscriptReadResult | readonly NativeTranscriptRawItem[] | NativeTranscriptRawItem | null,
): NativeTranscriptReadResult {
  if (Array.isArray(raw)) return { items: raw };
  const record = asRecord(raw);
  if (!record) return { items: [] };
  if (typeof record.kind === "string" && typeof record.ts === "string") return { items: [raw as NativeTranscriptRawItem] };
  return record as NativeTranscriptReadResult;
}

function availabilityRank(value: TranscriptAvailability): number {
  return { available: 0, offline: 1, missing: 2, expired: 3, incompatible: 4 }[value];
}

function completenessRank(value: TranscriptCompleteness): number {
  return { complete: 0, partial: 1, terminal_only: 2, unknown: 3 }[value];
}

function mergeAvailability(values: readonly TranscriptAvailability[]): TranscriptAvailability {
  return values.reduce((worst, value) => availabilityRank(value) > availabilityRank(worst) ? value : worst, "available");
}

function mergeCompleteness(values: readonly TranscriptCompleteness[]): TranscriptCompleteness {
  return values.reduce((worst, value) => completenessRank(value) > completenessRank(worst) ? value : worst, "complete");
}

function mergeSource(values: readonly TranscriptSource[]): TranscriptSource {
  const unique = new Set(values);
  if (unique.size === 0 || (unique.size === 1 && unique.has("native"))) return "native";
  if (unique.size === 1 && unique.has("legacy")) return "legacy";
  return "native_plus_objects";
}

function isUnavailable(value: TranscriptAvailability): boolean {
  return value === "offline" || value === "missing";
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_PAGE_LIMIT;
  return Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.floor(value!)));
}

function itemMatchesRef(item: TranscriptItem, ref: string): boolean {
  return item.id === ref || item.sourceEntryId === ref;
}

function lastItemMatchingRef(items: TranscriptItem[], ref: string): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (itemMatchesRef(items[index]!, ref)) return index;
  }
  return -1;
}

function applyVisibilityCutoff(items: TranscriptItem[], cutoff: string | null | undefined): TranscriptItem[] {
  const visible = items.filter((item) => item.visibility !== "hidden");
  if (!cutoff) return visible;
  const index = lastItemMatchingRef(visible, cutoff);
  if (index >= 0) return visible.slice(0, index + 1);
  if (/^\d+$/u.test(cutoff)) return visible.filter((item) => item.ordinal <= Number(cutoff));
  // An unknown stop marker must fail closed. It is safer to hide the source
  // than to expose the tail after a stop that cannot be resolved.
  return [];
}

function applyRange(items: TranscriptItem[], range: TranscriptRange | null | undefined): TranscriptItem[] {
  if (!range) return items;
  const sourceIndex = (item: TranscriptItem) => items.indexOf(item);
  if (range.itemId) return items.filter((item) => itemMatchesRef(item, range.itemId!));

  const ordinalFor = (value: string | number | TranscriptRangeBoundary | null | undefined): number | null => {
    if (typeof value === "number") return value;
    if (value && typeof value === "object" && typeof value.ordinal === "number") return value.ordinal;
    return null;
  };
  const idFor = (value: string | number | TranscriptRangeBoundary | null | undefined): string | null => {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") return value.itemId ?? null;
    return null;
  };
  const inclusiveStart = (value: string | number | TranscriptRangeBoundary | null | undefined): TranscriptItem[] => {
    const id = idFor(value);
    if (id) {
      const found = items.findIndex((item) => itemMatchesRef(item, id));
      if (found >= 0) return items.slice(found);
    }
    const ordinal = ordinalFor(value);
    if (ordinal !== null && typeof value !== "number") return items.filter((item) => item.ordinal >= ordinal);
    return !id && typeof value === "number" ? items.slice(Math.max(0, Math.floor(value))) : [];
  };
  const inclusiveEnd = (value: string | number | TranscriptRangeBoundary | null | undefined): TranscriptItem[] => {
    const id = idFor(value);
    if (id) {
      const found = lastItemMatchingRef(items, id);
      if (found >= 0) return items.slice(0, found + 1);
    }
    const ordinal = ordinalFor(value);
    if (ordinal !== null && typeof value !== "number") return items.filter((item) => item.ordinal <= ordinal);
    return !id && typeof value === "number" ? items.slice(0, Math.floor(value) + 1) : [];
  };
  let selected = range.start === undefined || range.start === null ? items : inclusiveStart(range.start);
  if (range.end !== undefined && range.end !== null) {
    const id = idFor(range.end);
    const found = id ? lastItemMatchingRef(selected, id) : -1;
    if (found >= 0) selected = selected.slice(0, found + 1);
    else {
      const ordinal = ordinalFor(range.end);
      if (ordinal !== null && typeof range.end !== "number") selected = selected.filter((item) => item.ordinal <= ordinal);
      else if (typeof range.end === "number") {
        const endIndex = Math.floor(range.end);
        selected = selected.filter((item) => sourceIndex(item) <= endIndex);
      }
      else selected = [];
    }
  }
  const exclusiveStart = range.fromExclusive ?? range.after ?? null;
  if (exclusiveStart !== null) {
    const id = idFor(exclusiveStart);
    const found = id ? lastItemMatchingRef(selected, id) : -1;
      if (found >= 0) selected = selected.slice(found + 1);
      else {
        const ordinal = ordinalFor(exclusiveStart);
        if (typeof exclusiveStart === "number") selected = selected.filter((item) => sourceIndex(item) > Math.floor(exclusiveStart));
        else if (ordinal !== null) selected = selected.filter((item) => item.ordinal > ordinal);
        else selected = [];
      }
  }
  const throughInclusive = range.throughInclusive ?? null;
  if (throughInclusive !== null) {
    const id = idFor(throughInclusive);
    const found = id ? lastItemMatchingRef(selected, id) : -1;
      if (found >= 0) selected = selected.slice(0, found + 1);
      else {
        const ordinal = ordinalFor(throughInclusive);
        if (typeof throughInclusive === "number") selected = selected.filter((item) => sourceIndex(item) <= Math.floor(throughInclusive));
        else if (ordinal !== null) selected = selected.filter((item) => item.ordinal <= ordinal);
        else selected = [];
      }
  }
  if (range.before !== undefined && range.before !== null) {
    const id = idFor(range.before);
    const found = id ? selected.findIndex((item) => itemMatchesRef(item, id)) : -1;
      if (found >= 0) selected = selected.slice(0, found);
      else {
        const ordinal = ordinalFor(range.before);
        if (typeof range.before === "number") {
          const beforeIndex = Math.floor(range.before);
          selected = selected.filter((item) => sourceIndex(item) < beforeIndex);
        }
        else if (ordinal !== null) selected = selected.filter((item) => item.ordinal < ordinal);
        else selected = [];
      }
  }
  return selected;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function encodeTranscriptCursor(payload: CursorPayload): string {
  return encodeCursor(payload);
}

function decodeCursor(value: string | null | undefined): CursorPayload | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CursorPayload>;
    if (parsed.version !== 1 || (parsed.scope !== "run" && parsed.scope !== "conversation")
      || typeof parsed.orgId !== "string" || typeof parsed.principalScopeRef !== "string"
      || typeof parsed.revision !== "string" || typeof parsed.position !== "number"
      || !Number.isSafeInteger(parsed.position) || parsed.position < 0) {
      throw new Error("invalid cursor");
    }
    return parsed as CursorPayload;
  } catch {
    throw transcriptReaderError("cursor_invalid", "Invalid transcript cursor");
  }
}

export function decodeTranscriptCursor(value: string | null | undefined): CursorPayload | null {
  return decodeCursor(value);
}

function assertCursor(
  cursor: CursorPayload | null,
  input: {
    scope: CursorScope;
    orgId: string;
    principalScopeRef: string;
    principalType?: string | null;
    principalId?: string | null;
    id: string;
    spanId?: string | null;
    source: TranscriptSource;
    range: TranscriptRange | null;
    visibilityCutoffRef: string | null;
    revision: string;
  },
) {
  if (!cursor) return 0;
  if (cursor.scope !== input.scope || cursor.orgId !== input.orgId || cursor.principalScopeRef !== input.principalScopeRef
    || cursor.revision !== input.revision
    || (input.scope === "run" ? cursor.runId !== input.id : cursor.conversationId !== input.id)
    || (cursor.principalType !== undefined && cursor.principalType !== (input.principalType ?? undefined))
    || (cursor.principalId !== undefined && cursor.principalId !== (input.principalId ?? undefined))
    || (cursor.spanId !== undefined && (cursor.spanId ?? null) !== (input.spanId ?? null))) {
    throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor does not belong to this scope");
  }
  if (cursor.source !== undefined && cursor.source !== input.source) {
    throw transcriptReaderError("cursor_source_mismatch", "Transcript cursor does not belong to this source");
  }
  if (cursor.range !== undefined && compatibilityValueKey(cursor.range) !== compatibilityValueKey(input.range)) {
    throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor does not belong to this range");
  }
  if (cursor.visibilityCutoffRef !== undefined
    && (cursor.visibilityCutoffRef ?? null) !== (input.visibilityCutoffRef ?? null)) {
    throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor does not belong to this visibility cutoff");
  }
  return cursor.position;
}

function pageFromItems(
  items: TranscriptItem[],
  input: {
    scope: CursorScope;
    id: string;
    orgId: string;
    principalScopeRef: string;
    principalType?: string | null;
    principalId?: string | null;
    spanId?: string | null;
    cursor?: string | null;
    limit?: number;
    source: TranscriptSource;
    range?: TranscriptRange | null;
    visibilityCutoffRef?: string | null;
    revision: string;
    availability: TranscriptAvailability;
    completeness: TranscriptCompleteness;
  },
): TranscriptPage {
  const cursor = decodeCursor(input.cursor);
  const position = assertCursor(cursor, {
    scope: input.scope,
    orgId: input.orgId,
    principalScopeRef: input.principalScopeRef,
    principalType: input.principalType,
    principalId: input.principalId,
    id: input.id,
    spanId: input.spanId ?? null,
    source: input.source,
    range: input.range ?? null,
    visibilityCutoffRef: input.visibilityCutoffRef ?? null,
    revision: input.revision,
  });
  const limit = normalizeLimit(input.limit);
  const pageItems = items.slice(position, position + limit);
  const nextPosition = position + pageItems.length;
  const nextCursor = nextPosition < items.length
    ? encodeCursor({
      version: 1,
      scope: input.scope,
      orgId: input.orgId,
      principalScopeRef: input.principalScopeRef,
      principalType: input.principalType ?? undefined,
      principalId: input.principalId ?? undefined,
      ...(input.scope === "run" ? { runId: input.id } : { conversationId: input.id }),
      spanId: input.spanId ?? null,
      source: input.source,
      range: input.range ?? null,
      visibilityCutoffRef: input.visibilityCutoffRef ?? null,
      revision: input.revision,
      position: nextPosition,
    })
    : null;
  return {
    items: pageItems,
    nextCursor,
    source: input.source,
    revision: input.revision,
    availability: input.availability,
    completeness: input.completeness,
  };
}

function runCursorPayload(input: {
  id: string;
  orgId: string;
  principal: TranscriptPrincipal;
  spanId: string | null;
  source: TranscriptSource;
  range: TranscriptRange | null;
  visibilityCutoffRef: string | null;
  windowRevision: string;
  providerRevision: string | null;
  activeSpanId: string | null;
  providerPageCursor: string | null;
  providerNextCursor: string | null;
  position: number;
  sourceTransition?: boolean;
}): CursorPayload {
  return {
    version: 1,
    scope: "run",
    orgId: input.orgId,
    principalScopeRef: selectedPrincipalScope(input.principal, input.orgId),
    principalType: input.principal.type ?? undefined,
    principalId: input.principal.id ?? undefined,
    runId: input.id,
    spanId: input.spanId,
    source: input.source,
    range: input.range,
    visibilityCutoffRef: input.visibilityCutoffRef,
    windowRevision: input.windowRevision,
    providerRevision: input.providerRevision,
    activeSpanId: input.activeSpanId,
    providerPageCursor: input.providerPageCursor,
    providerNextCursor: input.providerNextCursor,
    ...(input.sourceTransition ? { sourceTransition: true } : {}),
    revision: stableHash({
      windowRevision: input.windowRevision,
      providerRevision: input.providerRevision,
      activeSpanId: input.activeSpanId,
    }),
    position: input.position,
  } as CursorPayload;
}

function pageFromRunSource(
  source: ResolvedSource,
  input: {
    id: string;
    orgId: string;
    principal: TranscriptPrincipal;
    spanId?: string | null;
    cursor?: string | null;
    limit?: number;
    range?: TranscriptRange | null;
    visibilityCutoffRef?: string | null;
  },
): TranscriptPage {
  const cursor = decodeCursor(input.cursor);
  const range = input.range ?? null;
  const cutoff = input.visibilityCutoffRef ?? null;
  const windowRevision = source.windowRevision ?? stableHash({
    id: input.id,
    spanId: input.spanId ?? null,
    range,
    cutoff,
  });
  let position = 0;
  let sourceTransition = false;
  if (cursor) {
    if (cursor.scope !== "run"
      || cursor.orgId !== input.orgId
      || cursor.principalScopeRef !== selectedPrincipalScope(input.principal, input.orgId)
      || (cursor.principalType !== undefined && cursor.principalType !== (input.principal.type ?? undefined))
      || (cursor.principalId !== undefined && cursor.principalId !== (input.principal.id ?? undefined))
      || cursor.runId !== input.id
      || (cursor.spanId ?? null) !== (input.spanId ?? null)) {
      throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor does not belong to this scope");
    }
    if (cursor.range !== undefined && compatibilityValueKey(cursor.range) !== compatibilityValueKey(range)) {
      throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor does not belong to this range");
    }
    if (cursor.visibilityCutoffRef !== undefined && (cursor.visibilityCutoffRef ?? null) !== cutoff) {
      throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor does not belong to this visibility cutoff");
    }
    if (cursor.windowRevision && cursor.windowRevision !== windowRevision) {
      throw transcriptReaderError("cursor_revision_mismatch", "Transcript cursor window revision is no longer current");
    }
    if (cursor.activeSpanId && cursor.activeSpanId !== source.spanId) {
      throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor does not belong to this span");
    }
    sourceTransition = cursor.sourceTransition === true;
    const providerSource = source.providerSource ?? source.source;
    if (!sourceTransition && cursor.source && cursor.source !== providerSource) {
      throw transcriptReaderError("cursor_source_mismatch", "Transcript cursor does not belong to this source");
    }
    const providerRevision = source.providerRevision ?? source.revision;
    if (cursor.providerRevision && cursor.providerRevision !== providerRevision) {
      throw transcriptReaderError("cursor_revision_mismatch", "Transcript cursor provider revision is no longer current");
    }
    const expectedCursorRevision = stableHash({
      windowRevision,
      providerRevision: cursor.providerRevision ?? null,
      activeSpanId: cursor.activeSpanId ?? null,
    });
    if (cursor.revision !== expectedCursorRevision) {
      throw transcriptReaderError("cursor_revision_mismatch", "Transcript cursor revision is invalid");
    }
    position = cursor.position;
  }

  if (position > source.items.length) {
    throw transcriptReaderError("cursor_invalid", "Transcript cursor is past the provider page");
  }
  const limit = normalizeLimit(input.limit);
  const pageItems = source.items.slice(position, position + limit);
  const nextPosition = position + pageItems.length;
  let nextCursor: string | null = null;
  if (nextPosition < source.items.length) {
    nextCursor = encodeCursor(runCursorPayload({
      id: input.id,
      orgId: input.orgId,
      principal: input.principal,
      spanId: input.spanId ?? null,
      source: source.providerSource ?? source.source,
      range,
      visibilityCutoffRef: cutoff,
      windowRevision,
      providerRevision: source.providerRevision ?? source.revision,
      activeSpanId: source.spanId,
      providerPageCursor: source.providerCursor,
      providerNextCursor: source.providerNextCursor,
      position: nextPosition,
    }));
  } else if (source.providerNextCursor) {
    nextCursor = encodeCursor(runCursorPayload({
      id: input.id,
      orgId: input.orgId,
      principal: input.principal,
      spanId: input.spanId ?? null,
      source: source.providerSource ?? source.source,
      range,
      visibilityCutoffRef: cutoff,
      windowRevision,
      providerRevision: source.providerRevision ?? source.revision,
      activeSpanId: source.spanId,
      providerPageCursor: source.providerNextCursor,
      providerNextCursor: null,
      position: 0,
    }));
  } else if (source.nextSpanId) {
    nextCursor = encodeCursor(runCursorPayload({
      id: input.id,
      orgId: input.orgId,
      principal: input.principal,
      spanId: input.spanId ?? null,
      source: source.source,
      range,
      visibilityCutoffRef: cutoff,
      windowRevision,
      providerRevision: null,
      activeSpanId: source.nextSpanId,
      providerPageCursor: null,
      providerNextCursor: null,
      position: 0,
      sourceTransition: true,
    }));
  }

  if (nextCursor && nextCursor === input.cursor) {
    throw transcriptReaderError("cursor_invalid", "Transcript cursor did not advance");
  }

  return {
    items: pageItems,
    nextCursor,
    source: source.source,
    revision: source.revision,
    availability: source.availability,
    completeness: source.completeness,
  };
}

function pageItemsForRange(items: TranscriptItem[], input: { range?: TranscriptRange | null; visibilityCutoffRef?: string | null }) {
  return applyRange(applyVisibilityCutoff(items, input.visibilityCutoffRef), input.range);
}

function rawItemsFromResult(result: NativeTranscriptReadResult): readonly NativeTranscriptRawItem[] {
  if (Array.isArray(result.items)) return result.items;
  if (Array.isArray(result.entries)) return result.entries;
  return result.item ? [result.item] : [];
}

function defaultRevision(run: HeartbeatRunRecord, prefix: string): string {
  return stableHash({
    prefix,
    id: run.id,
    logSha256: run.logSha256,
    logBytes: run.logBytes,
    updatedAt: run.updatedAt,
  });
}

function transcriptCandidates(payload: unknown): TranscriptEntry[] {
  const record = asRecord(payload);
  if (!record) return [];
  const candidates = [record.__chatTranscript, record.transcript, record.entries, record.items];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const entries = candidate.map(transcriptEntry).filter((entry): entry is TranscriptEntry => Boolean(entry));
    if (entries.length > 0) return entries;
  }
  return [];
}

function entriesFromLegacyEvents(events: readonly Record<string, unknown>[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const event of events) {
    // Durable transcript events are the legacy compatibility source. Live-only
    // projections use seq=null and must never become historical transcript.
    if (event.eventType !== "transcript.entry" || event.seq === null) continue;
    const sourceEntryId = typeof event.id === "string" || typeof event.id === "number"
      ? String(event.id)
      : null;
    const payload = asRecord(event.payload);
    const candidates = [payload?.entry, payload?.transcriptEntry, payload?.transcript, event.payload];
    let found = false;
    for (const candidate of candidates) {
      const entry = transcriptEntry(candidate);
      if (entry) {
        entries.push(sourceEntryId && !entry.sourceEntryId ? { ...entry, sourceEntryId } : entry);
        found = true;
        break;
      }
    }
    if (found) continue;
    const message = nonEmptyString(event.message);
    if (!message) continue;
    const stream = event.stream === "stderr" ? "stderr" : event.stream === "system" ? "system" : "stdout";
    entries.push({
      kind: stream,
      ts: isoDate(event.createdAt),
      text: message,
      ...(sourceEntryId ? { sourceEntryId } : {}),
    });
  }
  return entries;
}

function eventSpanId(event: Record<string, unknown>): string | null {
  const payload = asRecord(event.payload);
  const nested = asRecord(payload?.entry ?? payload?.transcriptEntry ?? payload?.transcript);
  return stringAt(payload, ["spanId", "span_id"])
    ?? stringAt(nested, ["spanId", "span_id"]);
}

async function readAllLegacyLog(
  store: RunLogStore,
  handle: RunLogHandle,
  options: { maxReadBytes: number; signal?: AbortSignal },
): Promise<string> {
  let offset = 0;
  let content = "";
  for (let page = 0; page < 100_000; page += 1) {
    if (options.signal?.aborted) throw new Error("legacy transcript read cancelled");
    const result: RunLogReadResult = await store.read(handle, {
      offset,
      limitBytes: options.maxReadBytes,
      signal: options.signal,
    });
    content += result.content;
    if (result.eof) return content;
    const nextOffset = result.nextOffset ?? result.endOffset;
    if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset) throw new Error("Legacy transcript reader made no progress");
    offset = nextOffset;
  }
  throw new Error("Legacy transcript exceeds the readable page limit");
}

function legacyEntriesFromRun(run: HeartbeatRunRecord, rawLog: string, runtimeType: string, events: readonly Record<string, unknown>[]): TranscriptEntry[] {
  let rawLogFallback: TranscriptEntry[] = [];
  if (rawLog) {
    const chunks = parseNdjsonLog(rawLog);
    if (chunks.length > 0) {
      const entries = buildTranscript(chunks, getTranscriptParser(runtimeType));
      if (entries.length > 0) return entries;
    }
    rawLogFallback = [{ kind: "stdout", ts: isoDate(run.startedAt ?? run.createdAt), text: rawLog }];
  }
  const fromResult = transcriptCandidates(run.resultJson);
  if (fromResult.length > 0) return fromResult;
  const fromContext = transcriptCandidates(run.contextSnapshot);
  if (fromContext.length > 0) return fromContext;
  const fromEvents = entriesFromLegacyEvents(events);
  return fromEvents.length > 0 ? fromEvents : rawLogFallback;
}

export function createLegacyTranscriptReader(options: {
  logStore?: RunLogStore;
  maxReadBytes?: number;
} = {}): LegacyTranscriptReaderHook {
  const store = options.logStore ?? getRunLogStore();
  const maxReadBytes = Math.max(4, Math.min(MAX_LEGACY_READ_BYTES, Math.floor(options.maxReadBytes ?? DEFAULT_LEGACY_READ_BYTES)));
  return {
    async readRun(input) {
      if (input.run.logCompressed) {
        return {
          entries: [],
          revision: defaultRevision(input.run, "compressed"),
          availability: "incompatible",
          completeness: "unknown",
        };
      }
      let rawLog = "";
      if (input.run.logStore && input.run.logRef) {
        try {
          rawLog = await readAllLegacyLog(store, {
            store: input.run.logStore as RunLogHandle["store"],
            logRef: input.run.logRef,
          }, { maxReadBytes, signal: input.signal });
        } catch (error) {
          if ((error as { status?: unknown }).status === 404) {
            return {
              entries: [],
              revision: defaultRevision(input.run, "missing"),
              availability: "missing",
              completeness: "unknown",
            };
          }
          throw error;
        }
      }
      const entries = legacyEntriesFromRun(input.run, rawLog, input.runtimeType, input.events ?? []);
      return {
        entries,
        revision: defaultRevision(input.run, rawLog ? "log" : "payload"),
        availability: "available",
        completeness: entries.length > 0 ? "complete" : "terminal_only",
      };
    },
  };
}

async function selectRun(db: ReadDatabase, orgId: string, runId: string): Promise<HeartbeatRunRecord | null> {
  const rows = await db
    .select()
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.orgId, orgId), eq(heartbeatRuns.id, runId)))
    .limit(1);
  return rows[0] ?? null;
}

async function selectConversation(db: ReadDatabase, orgId: string, conversationId: string) {
  const rows = await db
    .select()
    .from(chatConversations)
    .where(and(eq(chatConversations.orgId, orgId), eq(chatConversations.id, conversationId)))
    .limit(1);
  return rows[0] ?? null;
}

async function selectBindingById(db: ReadDatabase, orgId: string, bindingId: string): Promise<RuntimeBindingRecord | null> {
  const rows = await db
    .select()
    .from(runtimeBindings)
    .where(and(eq(runtimeBindings.orgId, orgId), eq(runtimeBindings.id, bindingId)))
    .limit(1);
  return rows[0] ?? null;
}

async function selectBindingByConversation(db: ReadDatabase, orgId: string, conversationId: string): Promise<RuntimeBindingRecord | null> {
  const rows = await db
    .select()
    .from(runtimeBindings)
    .where(and(eq(runtimeBindings.orgId, orgId), eq(runtimeBindings.conversationId, conversationId), eq(runtimeBindings.status, "active")))
    .orderBy(desc(runtimeBindings.bindingEpoch))
    .limit(1);
  return rows[0] ?? null;
}

async function selectSegment(db: ReadDatabase, orgId: string, segmentId: string): Promise<NativeSegmentRecord | null> {
  const rows = await db
    .select()
    .from(nativeSegments)
    .where(and(eq(nativeSegments.orgId, orgId), eq(nativeSegments.id, segmentId)))
    .limit(1);
  return rows[0] ?? null;
}

async function selectSpans(db: ReadDatabase, orgId: string, runId: string): Promise<RunRuntimeSpanRecord[]> {
  return await db
    .select()
    .from(runRuntimeSpans)
    .where(and(eq(runRuntimeSpans.orgId, orgId), eq(runRuntimeSpans.runId, runId)))
    .orderBy(asc(runRuntimeSpans.ordinal), asc(runRuntimeSpans.id));
}

async function selectLegacyEvents(db: ReadDatabase, orgId: string, runId: string): Promise<Record<string, unknown>[]> {
  const rows = await db
    .select()
    .from(heartbeatRunEvents)
    .where(and(eq(heartbeatRunEvents.orgId, orgId), eq(heartbeatRunEvents.runId, runId)))
    .orderBy(asc(heartbeatRunEvents.seq), asc(heartbeatRunEvents.id));
  return rows as Record<string, unknown>[];
}

type ConversationSourceAnchor = Pick<ConversationSourceCursor, "kind" | "id" | "createdAt">;

type ConversationMessageRecord = {
  id: string;
  orgId: string;
  conversationId: string;
  role: string;
  body: string;
  kind: string;
  structuredPayload: Record<string, unknown> | null;
  runId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function conversationDateKey(value: Date | string | null | undefined): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = value ? new Date(value) : new Date(0);
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

function conversationSourceAnchor(
  kind: ConversationSourceKind,
  row: { id: string; createdAt: Date; updatedAt?: Date | null },
): ConversationSourceCursor {
  return {
    kind,
    id: row.id,
    createdAt: conversationDateKey(row.createdAt),
    updatedAt: row.updatedAt ? conversationDateKey(row.updatedAt) : null,
    ...(kind === "run" ? { runCursor: null } : { messageOffset: 0 }),
  };
}

async function selectConversationRuns(
  db: ReadDatabase,
  orgId: string,
  conversationId: string,
  after: ConversationSourceAnchor | null = null,
  limit = MAX_PAGE_LIMIT + 1,
): Promise<HeartbeatRunRecord[]> {
  const afterCondition = after
    ? (() => {
      const timestamp = new Date(after.createdAt);
      if (Number.isNaN(timestamp.getTime())) throw transcriptReaderError("cursor_invalid", "Invalid conversation source cursor");
      return or(
        gt(heartbeatRuns.createdAt, timestamp),
        and(eq(heartbeatRuns.createdAt, timestamp), gt(heartbeatRuns.id, after.id)),
      );
    })()
    : undefined;
  return await db
    .select()
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.orgId, orgId),
      eq(heartbeatRuns.chatConversationId, conversationId),
      afterCondition,
    ))
    .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
    .limit(Math.min(MAX_PAGE_LIMIT + 1, Math.max(1, limit)));
}

async function selectConversationMessages(
  db: ReadDatabase,
  orgId: string,
  conversationId: string,
  after: ConversationSourceAnchor | null = null,
  limit = MAX_PAGE_LIMIT + 1,
): Promise<ConversationMessageRecord[]> {
  const afterCondition = after
    ? (() => {
      const timestamp = new Date(after.createdAt);
      if (Number.isNaN(timestamp.getTime())) throw transcriptReaderError("cursor_invalid", "Invalid conversation source cursor");
      return or(
        gt(chatMessages.createdAt, timestamp),
        and(eq(chatMessages.createdAt, timestamp), gt(chatMessages.id, after.id)),
      );
    })()
    : undefined;
  return await db
    .select({
      id: chatMessages.id,
      orgId: chatMessages.orgId,
      conversationId: chatMessages.conversationId,
      role: chatMessages.role,
      body: chatMessages.body,
      kind: chatMessages.kind,
      structuredPayload: chatMessages.structuredPayload,
      runId: chatMessages.runId,
      createdAt: chatMessages.createdAt,
      updatedAt: chatMessages.updatedAt,
    })
    .from(chatMessages)
    .where(and(
      eq(chatMessages.orgId, orgId),
      eq(chatMessages.conversationId, conversationId),
      isNull(chatMessages.supersededAt),
      afterCondition,
    ))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
    .limit(Math.min(MAX_PAGE_LIMIT + 1, Math.max(1, limit)));
}

async function selectConversationMessage(
  db: ReadDatabase,
  orgId: string,
  conversationId: string,
  messageId: string,
): Promise<ConversationMessageRecord | null> {
  const rows = await db
    .select({
      id: chatMessages.id,
      orgId: chatMessages.orgId,
      conversationId: chatMessages.conversationId,
      role: chatMessages.role,
      body: chatMessages.body,
      kind: chatMessages.kind,
      structuredPayload: chatMessages.structuredPayload,
      runId: chatMessages.runId,
      createdAt: chatMessages.createdAt,
      updatedAt: chatMessages.updatedAt,
    })
    .from(chatMessages)
    .where(and(
      eq(chatMessages.orgId, orgId),
      eq(chatMessages.conversationId, conversationId),
      eq(chatMessages.id, messageId),
      isNull(chatMessages.supersededAt),
    ))
    .limit(1);
  return rows[0] ?? null;
}

type ConversationSourceRow =
  | { descriptor: ConversationSourceCursor; run: HeartbeatRunRecord; message?: never }
  | { descriptor: ConversationSourceCursor; run?: never; message: ConversationMessageRecord };

function compareConversationSourceRows(left: ConversationSourceRow, right: ConversationSourceRow): number {
  const createdAt = Date.parse(left.descriptor.createdAt) - Date.parse(right.descriptor.createdAt);
  if (createdAt !== 0) return createdAt;
  const id = left.descriptor.id.localeCompare(right.descriptor.id);
  if (id !== 0) return id;
  return left.descriptor.kind === right.descriptor.kind
    ? 0
    : left.descriptor.kind === "run" ? -1 : 1;
}

async function selectConversationSourceWindow(
  db: ReadDatabase,
  orgId: string,
  conversationId: string,
  after: ConversationSourceAnchor | null,
  limit: number,
): Promise<{ rows: ConversationSourceRow[]; hasMore: boolean }> {
  const sourceLimit = Math.min(MAX_PAGE_LIMIT, Math.max(1, limit));
  const [runs, messages] = await Promise.all([
    selectConversationRuns(db, orgId, conversationId, after, sourceLimit + 1),
    selectConversationMessages(db, orgId, conversationId, after, sourceLimit + 1),
  ]);
  const rows: ConversationSourceRow[] = [
    ...runs.map((run) => ({
      descriptor: conversationSourceAnchor("run", run),
      run,
    } satisfies ConversationSourceRow)),
    ...messages.map((message) => ({
      descriptor: conversationSourceAnchor("message", message),
      message,
    } satisfies ConversationSourceRow)),
  ].sort(compareConversationSourceRows);
  return {
    rows: rows.slice(0, sourceLimit),
    hasMore: rows.length > sourceLimit,
  };
}

async function authorize(
  options: TranscriptReaderOptions,
  input: {
    orgId: string;
    principal: TranscriptPrincipal;
    target: "run" | "conversation" | "span";
    runId?: string;
    conversationId?: string | null;
    binding?: RuntimeBindingRecord | null;
    storedPrincipalScopeRef?: string | null;
  },
) {
  if (input.principal.authorized === false || (input.principal.orgId && input.principal.orgId !== input.orgId)) {
    throw forbidden("Transcript access denied");
  }
  if (options.authorizePrincipal && !(await options.authorizePrincipal(input))) {
    throw forbidden("Transcript access denied");
  }
  const scopes = principalScopeRefs(input.principal, input.orgId);
  const expected = input.binding?.principalScopeRef ?? input.storedPrincipalScopeRef;
  const isBoardOperator = input.principal.type === "board" && input.principal.authorized === true;
  if (expected && !isBoardOperator && !scopes.includes(expected)) throw forbidden("Transcript access denied");
}

function storedPrincipalScope(run: HeartbeatRunRecord): string | null {
  const context = asRecord(run.contextSnapshot);
  return stringAt(context, ["principalScopeRef", "principal_scope_ref", "authorizedPrincipal", "authorized_principal"]);
}

async function resolveRunScope(db: ReadDatabase, options: TranscriptReaderOptions, input: ReadRunTranscript) {
  const run = await selectRun(db, input.orgId, input.runId);
  if (!run) throw notFound("Agent run not found");
  const allSpans = await selectSpans(db, input.orgId, input.runId);
  const spans = input.spanId === undefined || input.spanId === null
    ? allSpans
    : allSpans.filter((span) => span.id === input.spanId);
  if (input.spanId !== undefined && input.spanId !== null && spans.length === 0) {
    throw notFound("Transcript span not found");
  }
  const bindingById = new Map<string, RuntimeBindingRecord>();
  const segmentById = new Map<string, NativeSegmentRecord>();
  if (run.chatConversationId) {
    const binding = await selectBindingByConversation(db, input.orgId, run.chatConversationId);
    if (binding) bindingById.set(binding.id, binding);
  }
  for (const span of spans) {
    if (!bindingById.has(span.bindingId)) {
      const binding = await selectBindingById(db, input.orgId, span.bindingId);
      if (binding) bindingById.set(binding.id, binding);
    }
    if (!segmentById.has(span.segmentId)) {
      const segment = await selectSegment(db, input.orgId, span.segmentId);
      if (segment) segmentById.set(segment.id, segment);
    }
  }
  await authorize(options, {
    orgId: input.orgId,
    principal: input.principal,
    target: "run",
    runId: run.id,
    conversationId: run.chatConversationId,
    binding: run.chatConversationId ? [...bindingById.values()].find((binding) => binding.conversationId === run.chatConversationId) ?? null : null,
    storedPrincipalScopeRef: storedPrincipalScope(run),
  });
  for (const span of spans) {
    const binding = bindingById.get(span.bindingId) ?? null;
    const segment = segmentById.get(span.segmentId) ?? null;
    if (!binding || !segment || segment.bindingId !== span.bindingId || binding.conversationId !== run.chatConversationId) {
      throw forbidden("Transcript source is not authorized");
    }
    assertSpanRuntimeConsistency(binding, segment, selectorFromSpan(span));
    await authorize(options, {
      orgId: input.orgId,
      principal: input.principal,
      target: "span",
      runId: run.id,
      conversationId: run.chatConversationId,
      binding,
    });
  }
  return { run, spans, bindingById, segmentById };
}

type ResolvedSource = {
  items: TranscriptItem[];
  source: TranscriptSource;
  /** Source identity for the active provider continuation. */
  providerSource?: TranscriptSource | null;
  revision: string;
  /** Revision for the active provider page, distinct from a merged page revision. */
  providerRevision?: string | null;
  availability: TranscriptAvailability;
  completeness: TranscriptCompleteness;
  providerCursor: string | null;
  providerNextCursor: string | null;
  spanId: string | null;
  nextSpanId?: string | null;
  windowRevision?: string;
  /** True only when native has no readable item and legacy may be tried. */
  legacyFallbackEligible?: boolean;
};

async function readNativeSpan(
  options: TranscriptReaderOptions,
  input: NativeTranscriptReadInput,
  origin: "native" | "object",
): Promise<ResolvedSource> {
  const hook = origin === "object" ? options.objectReader : options.nativeReader;
  if (!hook) {
    return {
      items: [],
      source: origin === "object" ? "native_plus_objects" : "native",
      revision: stableHash({ spanId: input.span.id, selector: input.selector, updatedAt: input.span.updatedAt }),
      providerRevision: stableHash({ spanId: input.span.id, selector: input.selector, updatedAt: input.span.updatedAt }),
      availability: "offline",
      completeness: input.span.completeness,
      providerCursor: input.cursor,
      providerNextCursor: null,
      spanId: input.span.id,
      legacyFallbackEligible: true,
    };
  }

  const canRead = Boolean(input.itemId && hook.readItem || hook.readRange || hook.read);
  if (!canRead) {
    return {
      items: [],
      source: origin === "object" ? "native_plus_objects" : "native",
      revision: stableHash({ spanId: input.span.id, selector: input.selector, updatedAt: input.span.updatedAt }),
      providerRevision: stableHash({ spanId: input.span.id, selector: input.selector, updatedAt: input.span.updatedAt }),
      availability: "offline",
      completeness: input.span.completeness,
      providerCursor: input.cursor,
      providerNextCursor: null,
      spanId: input.span.id,
      legacyFallbackEligible: true,
    };
  }

  if (input.signal?.aborted) throw new Error("transcript read cancelled");
  const hookInput = { ...input, limit: normalizeLimit(input.limit) };
  let raw: NativeTranscriptReadResult | readonly NativeTranscriptRawItem[] | NativeTranscriptRawItem | null;
  if (input.itemId && hook.readItem) raw = await hook.readItem(hookInput);
  else if (hook.readRange) raw = await hook.readRange(hookInput);
  else if (hook.read) raw = await hook.read(hookInput);
  else raw = [];
  const result = normalizeNativeResult(raw);
  const items = normalizeItems(rawItemsFromResult(result), {
    runId: input.run.id,
    spanId: input.span.id,
    origin,
  });
  const revision = nonEmptyString(result.revision)
    ?? stableHash({ spanId: input.span.id, selector: input.selector, updatedAt: input.span.updatedAt });
  const availability = result.availability ?? "available";
  const completeness = result.completeness ?? input.span.completeness;
  const nextCursor = nonEmptyString(result.nextCursor);
  if (nextCursor && nextCursor === input.cursor) throw new Error("Native transcript reader cursor made no progress");
  return {
    items,
    source: origin === "object" ? "native_plus_objects" : "native",
    revision,
    providerRevision: revision,
    availability,
    completeness,
    providerCursor: input.cursor,
    providerNextCursor: nextCursor,
    spanId: input.span.id,
    legacyFallbackEligible: items.length === 0 && isUnavailable(availability),
  };
}

async function readNativeSources(
  db: ReadDatabase,
  options: TranscriptReaderOptions,
  input: {
    orgId: string;
    principal: TranscriptPrincipal;
    run: HeartbeatRunRecord;
    spans: RunRuntimeSpanRecord[];
    bindings: Map<string, RuntimeBindingRecord>;
    segments: Map<string, NativeSegmentRecord>;
    range?: TranscriptRange | null;
    visibilityCutoffRef?: string | null;
    activeSpanId?: string | null;
    providerCursor?: string | null;
    allowLegacyFallback?: boolean;
    limit?: number;
    itemId?: string | null;
    signal?: AbortSignal;
  },
): Promise<ResolvedSource> {
  const sources: ResolvedSource[] = [];
  const activeSpanIndex = input.activeSpanId
    ? input.spans.findIndex((candidate) => candidate.id === input.activeSpanId)
    : 0;
  if (activeSpanIndex < 0) throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor span is not part of this run");
  const pageLimit = normalizeLimit(input.limit);
  const spans = input.spans.slice(activeSpanIndex);
  for (const [spanOffset, span] of spans.entries()) {
    const collectedCount = sources.reduce((count, source) => count + source.items.length, 0);
    if (collectedCount >= pageLimit) break;
    const providerCursor = spanOffset === 0 ? input.providerCursor ?? null : null;
    const binding = input.bindings.get(span.bindingId) ?? null;
    const segment = input.segments.get(span.segmentId) ?? null;
    const hookInput: NativeTranscriptReadInput = {
      readonly: true,
      scope: "run",
      orgId: input.orgId,
      principal: input.principal,
      run: input.run,
      binding,
      segment,
      span,
      selector: selectorFromSpan(span),
      cursor: providerCursor,
      limit: pageLimit - collectedCount,
      itemId: input.itemId ?? null,
      range: input.range,
      visibilityCutoffRef: input.visibilityCutoffRef ?? span.visibilityCutoffRef,
      signal: input.signal,
    };
    const objectRef = nonEmptyString(span.supplementalObjectRef);
    const itemsForSpan = (candidate: ResolvedSource) => candidate.items.filter((item) =>
      item.runId === input.run.id && item.spanId === span.id,
    );
    let result = options.nativeReader
      ? await readNativeSpan(options, hookInput, "native")
      : objectRef && options.objectReader
        ? await readNativeSpan(options, hookInput, "object")
        : await readNativeSpan(options, hookInput, "native");
    if (options.nativeReader
      && objectRef
      && options.objectReader
      && isUnavailable(result.availability)
      && itemsForSpan(result).length === 0) {
      const objectResult = await readNativeSpan(options, hookInput, "object");
      if (objectResult.items.length > 0 || objectResult.availability === "available") {
        result = objectResult;
      } else {
        const availability = mergeAvailability([result.availability, objectResult.availability]);
        result = {
          ...result,
          source: "native_plus_objects",
          revision: stableHash([result.revision, objectResult.revision]),
          availability,
          completeness: mergeCompleteness([result.completeness, objectResult.completeness]),
          legacyFallbackEligible: itemsForSpan(result).length === 0 && isUnavailable(availability),
        };
      }
    }
    let spanItems = itemsForSpan(result);
    // A native binding is an explicit source contract. Old duplicated logs
    // cannot silently replace an offline or pruned provider history.
    const nativeSourceContract = binding?.continuity === "native"
      || asRecord(input.run.contextSnapshot)?.transcriptSource === "native";
    const allowLegacyFallback = input.allowLegacyFallback !== false && !nativeSourceContract;
    if (allowLegacyFallback && spanItems.length === 0 && isUnavailable(result.availability)) {
      const legacy = await readLegacySource(db, options, {
        orgId: input.orgId,
        run: input.run,
        binding,
        spanId: span.id,
        signal: input.signal,
      });
      if (legacy.items.length > 0) {
        result = legacy;
        spanItems = itemsForSpan(result);
      } else if (legacy.availability !== "available") {
        result = {
          ...result,
          source: mergeSource([result.source, legacy.source]),
          revision: stableHash([result.revision, legacy.revision]),
          availability: mergeAvailability([result.availability, legacy.availability]),
          completeness: mergeCompleteness([result.completeness, legacy.completeness]),
        };
      }
    }
    const source = {
      ...result,
      // A native hook owns one span. Apply that span's visibility boundary and
      // requested range before combining sources so one span cannot affect the
      // pagination or cutoff of another span.
      items: pageItemsForRange(spanItems, {
        range: input.range,
        visibilityCutoffRef: input.visibilityCutoffRef ?? span.visibilityCutoffRef,
      }),
      legacyFallbackEligible: allowLegacyFallback && spanItems.length === 0 && isUnavailable(result.availability),
      providerRevision: result.providerRevision ?? result.revision,
    } satisfies ResolvedSource;
    sources.push(source);

    // A provider continuation owns the remainder of this page. Do not read
    // another span until that continuation has been consumed.
    if (source.providerNextCursor || source.items.length >= pageLimit - collectedCount) break;
    if (!allowLegacyFallback
      && source.items.length === 0
      && isUnavailable(source.availability)) break;
  }
  const items = sources.flatMap((source) => source.items);
  const source = mergeSource(sources.map((entry) => entry.source));
  const activeSource = sources.at(-1);
  const activeSpanIndexForCursor = activeSource
    ? activeSpanIndex + sources.length - 1
    : activeSpanIndex;
  return {
    items,
    source,
    revision: stableHash(sources.map((entry) => entry.revision)),
    providerSource: activeSource?.source ?? null,
    providerRevision: activeSource?.providerRevision ?? null,
    availability: mergeAvailability(sources.map((entry) => entry.availability)),
    completeness: mergeCompleteness(sources.map((entry) => entry.completeness)),
    providerCursor: activeSource?.providerCursor ?? null,
    providerNextCursor: activeSource?.providerNextCursor ?? null,
    spanId: activeSource?.spanId ?? null,
    nextSpanId: input.spans[activeSpanIndexForCursor + 1]?.id ?? null,
    legacyFallbackEligible: sources.length > 0
      && items.length === 0
      && sources.some((entry) => entry.legacyFallbackEligible === true),
  };
}

async function readLegacySource(
  db: ReadDatabase,
  options: TranscriptReaderOptions,
  input: {
    orgId: string;
    run: HeartbeatRunRecord;
    binding: RuntimeBindingRecord | null;
    spanId?: string | null;
    signal?: AbortSignal;
  },
): Promise<ResolvedSource> {
  const legacyReader = options.legacyReader ?? createLegacyTranscriptReader({
    logStore: options.logStore,
    maxReadBytes: options.maxLegacyReadBytes,
  });
  let events: Record<string, unknown>[] = [];
  if (transcriptCandidates(input.run.resultJson).length === 0
    && transcriptCandidates(input.run.contextSnapshot).length === 0) {
    // A finalized log can be empty or unparsable while durable transcript
    // events still contain the only readable history.
    events = await selectLegacyEvents(db, input.orgId, input.run.id);
  }
  if (input.spanId) {
    events = events.filter((event) => {
      const spanId = eventSpanId(event);
      return spanId === null || spanId === input.spanId;
    });
  }
  const raw = await legacyReader.readRun({
    readonly: true,
    run: input.run,
    runtimeType: runtimeTypeFromRun(input.run, input.binding),
    spanId: input.spanId ?? null,
    events,
    signal: input.signal,
  });
  const result: LegacyTranscriptReadResult = Array.isArray(raw)
    ? { entries: raw }
    : raw as LegacyTranscriptReadResult;
  return {
    items: normalizeItems(result.entries, { runId: input.run.id, spanId: input.spanId ?? null, origin: "legacy" }),
    source: "legacy",
    revision: nonEmptyString(result.revision) ?? defaultRevision(input.run, "legacy"),
    providerRevision: nonEmptyString(result.revision) ?? defaultRevision(input.run, "legacy"),
    availability: result.availability ?? "available",
    completeness: result.completeness ?? (result.entries.length > 0 ? "complete" : "terminal_only"),
    providerCursor: null,
    providerNextCursor: null,
    spanId: input.spanId ?? null,
  };
}

async function readRunItems(
  db: ReadDatabase,
  options: TranscriptReaderOptions,
  input: ReadRunTranscript,
  itemId?: string | null,
): Promise<ResolvedSource> {
  const resolved = await resolveRunScope(db, options, input);
  const cursor = decodeCursor(input.cursor);
  const windowRevision = stableHash({
    runId: resolved.run.id,
    spanId: input.spanId ?? null,
    spans: resolved.spans.map((span) => ({
      id: span.id,
      ordinal: span.ordinal,
      updatedAt: span.updatedAt,
      selector: span.selectorJson,
      cutoff: span.visibilityCutoffRef,
      supplementalObjectRef: span.supplementalObjectRef,
    })),
    range: input.range ?? null,
    visibilityCutoffRef: input.visibilityCutoffRef ?? null,
  });
  const binding = resolved.run.chatConversationId
    ? [...resolved.bindingById.values()].find((candidate) => candidate.conversationId === resolved.run.chatConversationId) ?? null
    : null;
  const source = resolved.spans.length > 0
    ? await readNativeSources(db, options, {
      orgId: input.orgId,
      principal: input.principal,
      run: resolved.run,
      spans: resolved.spans,
      bindings: resolved.bindingById,
      segments: resolved.segmentById,
      range: input.range,
      visibilityCutoffRef: input.visibilityCutoffRef,
      activeSpanId: cursor?.activeSpanId ?? input.spanId ?? null,
      providerCursor: cursor?.providerPageCursor ?? cursor?.providerCursor ?? null,
      allowLegacyFallback: !cursor || cursor.providerRevision === null,
      limit: input.limit,
      itemId,
      signal: input.signal,
    })
    : await readLegacySource(db, options, {
      orgId: input.orgId,
      run: resolved.run,
      binding,
      spanId: input.spanId ?? null,
      signal: input.signal,
    });
  if (resolved.spans.length > 0) {
    const currentIndex = resolved.spans.findIndex((span) => span.id === source.spanId);
    return {
      ...source,
      nextSpanId: currentIndex >= 0 ? resolved.spans[currentIndex + 1]?.id ?? null : null,
      windowRevision,
    };
  }
  return {
    ...source,
    windowRevision,
    items: pageItemsForRange(source.items, {
      range: input.range,
      visibilityCutoffRef: input.visibilityCutoffRef ?? null,
    }),
  };
}

function timestampForItem(item: TranscriptItem): number {
  const parsed = Date.parse(item.ts);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function sortConversationItems(items: TranscriptItem[]): TranscriptItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => timestampForItem(left.item) - timestampForItem(right.item)
      || left.item.id.localeCompare(right.item.id)
      || left.index - right.index)
    .map(({ item }, sequence) => ({ ...item, sequence }));
}

function messageEntries(
  message: {
    id: string;
    role: string;
    kind: string;
    body: string;
    createdAt: Date;
    runId: string | null;
  },
  transcript: readonly ChatStreamTranscriptEntry[] | undefined,
): TranscriptItem[] {
  const timestamp = message.createdAt.toISOString();
  const entries = transcript && transcript.length > 0
    ? transcript.map((entry) => ({ ...entry, ts: typeof entry.ts === "string" ? entry.ts : timestamp }))
    : message.body.trim()
      ? [{
        kind: message.role === "user" ? "user" : message.role === "system" ? "system" : "assistant",
        ts: timestamp,
        text: message.body,
      } as TranscriptEntry]
      : [];
  return normalizeItems(entries, { runId: message.runId, spanId: null, origin: "legacy" }).map((item, index) => ({
    ...item,
    id: item.id === `${message.runId ?? "transcript"}:${index}` ? `message:${message.id}:${index}` : item.id,
    sourceEntryId: item.sourceEntryId?.startsWith(message.runId ?? "\u0000")
      ? `message:${message.id}:${index}`
      : item.sourceEntryId ?? `message:${message.id}:${index}`,
  }));
}

type ConversationSourceState = {
  descriptor: ConversationSourceCursor;
  row: ConversationSourceRow;
  candidate: TranscriptItem | null;
  candidateNextCursor: string | null;
  messageItems?: TranscriptItem[];
  source: TranscriptSource;
  availability: TranscriptAvailability;
  completeness: TranscriptCompleteness;
  exhausted: boolean;
};

type ConversationReadPage = Pick<TranscriptPage, "items" | "nextCursor" | "source" | "revision" | "availability" | "completeness">;

function conversationRevision(
  conversation: { id: string; updatedAt?: Date | null },
  input: ReadConversationTranscript,
): string {
  return stableHash({
    conversationId: conversation.id,
    updatedAt: conversation.updatedAt ?? null,
    range: input.range ?? null,
    visibilityCutoffRef: input.visibilityCutoffRef ?? null,
  });
}

function assertConversationCursor(
  cursor: CursorPayload | null,
  input: ReadConversationTranscript,
  revision: string,
): ConversationSourceCursor[] {
  if (!cursor) return [];
  if (cursor.scope !== "conversation"
    || cursor.orgId !== input.orgId
    || cursor.principalScopeRef !== selectedPrincipalScope(input.principal, input.orgId)
    || (cursor.principalType !== undefined && cursor.principalType !== (input.principal.type ?? undefined))
    || (cursor.principalId !== undefined && cursor.principalId !== (input.principal.id ?? undefined))
    || cursor.conversationId !== input.conversationId
    || (cursor.spanId ?? null) !== (input.spanId ?? null)) {
    throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor does not belong to this scope");
  }
  if (cursor.range !== undefined && compatibilityValueKey(cursor.range) !== compatibilityValueKey(input.range ?? null)) {
    throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor does not belong to this range");
  }
  if (cursor.visibilityCutoffRef !== undefined
    && (cursor.visibilityCutoffRef ?? null) !== (input.visibilityCutoffRef ?? null)) {
    throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor does not belong to this visibility cutoff");
  }
  if (cursor.revision !== revision) {
    throw transcriptReaderError("cursor_revision_mismatch", "Transcript cursor revision is no longer current");
  }
  if (cursor.conversationSources === undefined || cursor.conversationMoreSources === undefined) {
    throw transcriptReaderError("cursor_invalid", "Invalid conversation transcript cursor");
  }
  const sources = cursor.conversationSources;
  if (!Array.isArray(sources) || sources.length > MAX_PAGE_LIMIT) {
    throw transcriptReaderError("cursor_invalid", "Invalid conversation transcript cursor");
  }
  for (const source of sources) {
    if ((source.kind !== "run" && source.kind !== "message")
      || typeof source.id !== "string"
      || typeof source.createdAt !== "string"
      || Number.isNaN(Date.parse(source.createdAt))) {
      throw transcriptReaderError("cursor_invalid", "Invalid conversation transcript cursor");
    }
    if (source.kind === "run" && source.runCursor !== undefined && source.runCursor !== null && typeof source.runCursor !== "string") {
      throw transcriptReaderError("cursor_invalid", "Invalid conversation transcript cursor");
    }
    if (source.kind === "message"
      && (!Number.isSafeInteger(source.messageOffset ?? 0) || (source.messageOffset ?? 0) < 0)) {
      throw transcriptReaderError("cursor_invalid", "Invalid conversation transcript cursor");
    }
    if (source.done !== undefined && typeof source.done !== "boolean") {
      throw transcriptReaderError("cursor_invalid", "Invalid conversation transcript cursor");
    }
  }
  if (cursor.conversationAfter) {
    if ((cursor.conversationAfter.kind !== "run" && cursor.conversationAfter.kind !== "message")
      || typeof cursor.conversationAfter.id !== "string"
      || typeof cursor.conversationAfter.createdAt !== "string"
      || Number.isNaN(Date.parse(cursor.conversationAfter.createdAt))) {
      throw transcriptReaderError("cursor_invalid", "Invalid conversation transcript cursor");
    }
  }
  if (cursor.conversationMoreSources !== undefined && typeof cursor.conversationMoreSources !== "boolean") {
    throw transcriptReaderError("cursor_invalid", "Invalid conversation transcript cursor");
  }
  return sources;
}

async function resolveConversationSourceRows(
  db: ReadDatabase,
  orgId: string,
  conversationId: string,
  descriptors: readonly ConversationSourceCursor[],
): Promise<ConversationSourceRow[]> {
  return await Promise.all(descriptors.map(async (descriptor): Promise<ConversationSourceRow> => {
    if (descriptor.kind === "run") {
      const run = await selectRun(db, orgId, descriptor.id);
      if (!run || run.chatConversationId !== conversationId) {
        throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor does not belong to this conversation");
      }
      if (conversationDateKey(run.createdAt) !== descriptor.createdAt
        || (descriptor.updatedAt && conversationDateKey(run.updatedAt) !== descriptor.updatedAt)) {
        throw transcriptReaderError("cursor_revision_mismatch", "Transcript source revision is no longer current");
      }
      return { descriptor, run };
    }
    const message = await selectConversationMessage(db, orgId, conversationId, descriptor.id);
    if (!message) throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor does not belong to this conversation");
    if (conversationDateKey(message.createdAt) !== descriptor.createdAt
      || (descriptor.updatedAt && conversationDateKey(message.updatedAt) !== descriptor.updatedAt)) {
      throw transcriptReaderError("cursor_revision_mismatch", "Transcript source revision is no longer current");
    }
    return { descriptor, message };
  }));
}

function transcriptDuplicateKey(item: TranscriptItem): string {
  return `${item.kind}\u0000${item.text ?? ""}`;
}

function compareConversationCandidates(
  left: ConversationSourceState,
  right: ConversationSourceState,
): number {
  const leftItem = left.candidate!;
  const rightItem = right.candidate!;
  return timestampForItem(leftItem) - timestampForItem(rightItem)
    || leftItem.id.localeCompare(rightItem.id)
    || left.descriptor.id.localeCompare(right.descriptor.id);
}

async function readConversationRunCandidate(
  db: ReadDatabase,
  options: TranscriptReaderOptions,
  input: ReadConversationTranscript,
  descriptor: ConversationSourceCursor,
): Promise<{
  item: TranscriptItem | null;
  nextCursor: string | null;
  source: TranscriptSource;
  availability: TranscriptAvailability;
  completeness: TranscriptCompleteness;
}> {
  const runInput: ReadRunTranscript = {
    orgId: input.orgId,
    runId: descriptor.id,
    principal: input.principal,
    spanId: input.spanId,
    cursor: descriptor.runCursor ?? null,
    limit: 1,
    range: input.range ?? null,
    visibilityCutoffRef: input.visibilityCutoffRef ?? null,
    signal: input.signal,
  };
  const source = await readRunItems(db, options, runInput);
  const page = pageFromRunSource(source, {
    ...runInput,
    id: descriptor.id,
    cursor: descriptor.runCursor ?? null,
    limit: 1,
  });
  return {
    item: page.items[0] ?? null,
    nextCursor: page.nextCursor,
    source: page.source,
    availability: page.availability,
    completeness: page.completeness,
  };
}

async function primeConversationSource(
  db: ReadDatabase,
  options: TranscriptReaderOptions,
  input: ReadConversationTranscript,
  state: ConversationSourceState,
  runItemsByRunId: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<void> {
  if (state.candidate || state.exhausted) return;
  if (state.descriptor.kind === "run") {
    for (let attempt = 0; attempt < MAX_PAGE_LIMIT; attempt += 1) {
      const result = await readConversationRunCandidate(db, options, input, state.descriptor);
      state.source = result.source;
      state.availability = result.availability;
      state.completeness = result.completeness;
      if (result.item) {
        state.candidate = result.item;
        state.candidateNextCursor = result.nextCursor;
        return;
      }
      if (!result.nextCursor) {
        state.exhausted = true;
        return;
      }
      state.descriptor.runCursor = result.nextCursor;
    }
    throw transcriptReaderError("cursor_invalid", "Native transcript reader did not yield a bounded page");
  }

  if (!state.messageItems) {
    const message = state.row.message!;
    const source: ChatTranscriptMessageSource = {
      id: message.id,
      orgId: message.orgId,
      conversationId: message.conversationId,
      role: message.role,
      structuredPayload: message.structuredPayload,
    };
    // The persistence helper selects the complete transcript for one message;
    // the Conversation source window bounds message count, but not this
    // provider's entry-level read until it exposes an entry cursor.
    const transcripts = await loadChatTranscripts(db, [source]);
    state.messageItems = messageEntries(message, transcripts.get(message.id));
    state.source = "legacy";
    state.availability = "available";
    state.completeness = state.messageItems.length > 0 ? "complete" : "terminal_only";
  }
  const runItems = state.row.message?.runId ? runItemsByRunId.get(state.row.message.runId) : undefined;
  let offset = state.descriptor.messageOffset ?? 0;
  while (offset < state.messageItems.length) {
    const candidate = state.messageItems[offset]!;
    offset += 1;
    if (runItems?.has(transcriptDuplicateKey(candidate))) continue;
    state.descriptor.messageOffset = offset - 1;
    state.candidate = candidate;
    state.candidateNextCursor = null;
    return;
  }
  state.descriptor.messageOffset = offset;
  state.exhausted = true;
}

function conversationCursorFor(input: {
  orgId: string;
  principal: TranscriptPrincipal;
  conversationId: string;
  spanId?: string | null;
  cursor: CursorPayload | null;
  revision: string;
  after: ConversationSourceAnchor | null;
  sources: readonly ConversationSourceCursor[];
  moreSources: boolean;
  source: TranscriptSource;
}): string {
  return encodeCursor({
    version: 1,
    scope: "conversation",
    orgId: input.orgId,
    principalScopeRef: selectedPrincipalScope(input.principal, input.orgId),
    principalType: input.principal.type ?? undefined,
    principalId: input.principal.id ?? undefined,
    conversationId: input.conversationId,
    spanId: input.spanId ?? null,
    source: input.source,
    range: input.cursor?.range ?? null,
    visibilityCutoffRef: input.cursor?.visibilityCutoffRef ?? null,
    conversationAfter: input.after,
    conversationSources: [...input.sources],
    conversationMoreSources: input.moreSources,
    revision: input.revision,
    position: 0,
  });
}

async function readConversationItems(
  db: ReadDatabase,
  options: TranscriptReaderOptions,
  input: ReadConversationTranscript,
): Promise<ConversationReadPage> {
  const conversation = await selectConversation(db, input.orgId, input.conversationId);
  if (!conversation) throw notFound("Conversation not found");
  const binding = await selectBindingByConversation(db, input.orgId, input.conversationId);
  await authorize(options, {
    orgId: input.orgId,
    principal: input.principal,
    target: "conversation",
    conversationId: conversation.id,
    binding,
  });

  const revision = conversationRevision(conversation, input);
  const cursor = decodeCursor(input.cursor);
  const cursorSources = assertConversationCursor(cursor, input, revision);
  const limit = normalizeLimit(input.limit);
  let after: ConversationSourceAnchor | null = cursor?.conversationAfter ?? null;
  let moreSources = cursor?.conversationMoreSources ?? false;
  let rows = cursorSources.length > 0
    ? await resolveConversationSourceRows(db, input.orgId, input.conversationId, cursorSources)
    : [];
  const sourceValues: TranscriptSource[] = [];
  const availabilityValues: TranscriptAvailability[] = [];
  const completenessValues: TranscriptCompleteness[] = [];
  const items: TranscriptItem[] = [];
  let scannedSources = 0;
  const runItemsByRunId = new Map<string, Set<string>>();

  while (items.length < limit && scannedSources < MAX_CONVERSATION_SOURCE_SCAN) {
    if (rows.length === 0) {
      if (!moreSources && (cursorSources.length > 0 || cursor?.conversationMoreSources === false)) break;
      const window = await selectConversationSourceWindow(
        db,
        input.orgId,
        input.conversationId,
        after,
        limit,
      );
      rows = window.rows;
      moreSources = window.hasMore;
      if (rows.length === 0) break;
    }

    scannedSources += rows.length;
    const states: ConversationSourceState[] = rows.map((row) => ({
      descriptor: { ...row.descriptor },
      row,
      candidate: null,
      candidateNextCursor: null,
      source: row.descriptor.kind === "run" ? "native" : "legacy",
      availability: "available",
      completeness: "unknown",
      exhausted: row.descriptor.done === true,
    }));
    for (const state of states.filter((candidate) => candidate.descriptor.kind === "run")) {
      await primeConversationSource(db, options, input, state, runItemsByRunId);
      if (state.candidate && state.row.run) {
        const keys = runItemsByRunId.get(state.row.run.id) ?? new Set<string>();
        keys.add(transcriptDuplicateKey(state.candidate));
        runItemsByRunId.set(state.row.run.id, keys);
      }
    }
    for (const state of states.filter((candidate) => candidate.descriptor.kind === "message")) {
      await primeConversationSource(db, options, input, state, runItemsByRunId);
    }
    for (const state of states) {
      if (state.descriptor.kind === "run" || state.candidate) {
        sourceValues.push(state.source);
        availabilityValues.push(state.availability);
        completenessValues.push(state.completeness);
      }
    }

    while (items.length < limit) {
      const available = states.filter((state) => !state.exhausted && state.candidate);
      if (available.length === 0) break;
      const state = [...available].sort(compareConversationCandidates)[0]!;
      const candidate = state.candidate!;
      state.candidate = null;
      if (candidate.visibility !== "hidden") items.push(candidate);
      if (state.row.run && candidate.runId === state.row.run.id) {
        const keys = runItemsByRunId.get(state.row.run.id) ?? new Set<string>();
        keys.add(transcriptDuplicateKey(candidate));
        runItemsByRunId.set(state.row.run.id, keys);
      }
      if (state.descriptor.kind === "run") {
        if (state.candidateNextCursor) state.descriptor.runCursor = state.candidateNextCursor;
        else state.exhausted = true;
      } else {
        state.descriptor.messageOffset = (state.descriptor.messageOffset ?? 0) + 1;
      }
      if (state.exhausted) state.descriptor.done = true;
      state.candidateNextCursor = null;
      if (!state.exhausted && items.length < limit) {
        await primeConversationSource(db, options, input, state, runItemsByRunId);
      }
    }

    for (const state of states) {
      if (state.exhausted) state.descriptor.done = true;
    }
    let contiguousAfter = after;
    let firstPendingIndex = 0;
    for (const [index, state] of states.entries()) {
      if (!state.exhausted) break;
      contiguousAfter = {
        kind: state.descriptor.kind,
        id: state.descriptor.id,
        createdAt: state.descriptor.createdAt,
      };
      firstPendingIndex = index + 1;
    }
    after = contiguousAfter;

    const pendingRows = states.slice(firstPendingIndex);
    rows = pendingRows.map((state) => ({
      ...state.row,
      descriptor: { ...state.descriptor },
    }));
    if (items.length >= limit || rows.length > 0) break;
  }

  const pendingSources = rows.map((row) => row.descriptor);
  const pageItems = sortConversationItems(pageItemsForRange(items, input));
  const source = mergeSource(sourceValues);
  const nextCursor = pendingSources.length > 0 || moreSources
    ? conversationCursorFor({
      orgId: input.orgId,
      principal: input.principal,
      conversationId: input.conversationId,
      spanId: input.spanId,
      cursor: cursor ?? {
        version: 1,
        scope: "conversation",
        orgId: input.orgId,
        principalScopeRef: selectedPrincipalScope(input.principal, input.orgId),
        conversationId: input.conversationId,
        range: input.range ?? null,
        visibilityCutoffRef: input.visibilityCutoffRef ?? null,
        revision,
        position: 0,
      },
      revision,
      after,
      sources: pendingSources,
      moreSources,
      source,
    })
    : null;
  return {
    items: pageItems,
    nextCursor,
    source,
    revision,
    availability: mergeAvailability(availabilityValues),
    completeness: mergeCompleteness(completenessValues),
  };
}

function createDatabaseTranscriptReader(database: ReadDatabase, options: TranscriptReaderOptions = {}): TranscriptReader {
  async function readRun(input: ReadRunTranscript): Promise<TranscriptPage> {
    const source = await readRunItems(database, options, input);
    return pageFromRunSource(source, { ...input, id: input.runId });
  }

  async function readConversation(input: ReadConversationTranscript): Promise<TranscriptPage> {
    return await readConversationItems(database, options, input);
  }

  async function readItem(input: ReadTranscriptItem): Promise<TranscriptItem> {
    if (input.runId) {
      const source = await readRunItems(database, options, { ...input, runId: input.runId }, input.itemId);
      const item = source.items.find((candidate) => itemMatchesRef(candidate, input.itemId));
      if (!item) throw notFound("Transcript item not found");
      return item;
    }
    if (input.conversationId) {
      let cursor: string | null = input.cursor ?? null;
      for (let pageCount = 0; pageCount < MAX_CONVERSATION_SOURCE_SCAN; pageCount += 1) {
        const page = await readConversationItems(database, options, {
          ...input,
          conversationId: input.conversationId,
          cursor,
          limit: MAX_PAGE_LIMIT,
        });
        const item = page.items.find((candidate) => itemMatchesRef(candidate, input.itemId));
        if (item) return item;
        if (!page.nextCursor) break;
        if (page.nextCursor === cursor) throw transcriptReaderError("cursor_invalid", "Transcript cursor did not advance");
        cursor = page.nextCursor;
      }
      throw notFound("Transcript item not found");
    }
    throw badRequest("Transcript item requires a runId or conversationId");
  }

  async function* stream(input: ReadRunTranscript | ReadConversationTranscript): AsyncIterable<TranscriptStreamEvent> {
    const page = "runId" in input ? await readRun(input) : await readConversation(input);
    yield { type: "snapshot", page };
    for (const item of page.items) yield { type: "item", item };
    yield { type: "complete", nextCursor: page.nextCursor };
  }

  return { readRun, readConversation, readItem, stream };
}

function compatibilityScopeKey(scope: TranscriptReadScope): string {
  return JSON.stringify({
    orgId: scope.orgId,
    principal: scope.principal,
    runId: scope.runId,
    spanId: scope.spanId ?? null,
  });
}

function compatibilityValueKey(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function compatibilityLimit(value: number | undefined, defaultLimit: number): number {
  if (value === undefined) return defaultLimit;
  if (!Number.isSafeInteger(value) || value < 1) throw badRequest("Invalid transcript page limit");
  return Math.min(MAX_PAGE_LIMIT, value);
}

function compatibilityItems(
  items: readonly TranscriptItem[],
  scope: TranscriptReadScope,
  range: TranscriptRange | null,
  cutoff: TranscriptReadAuthorization["visibilityCutoff"] | null,
): TranscriptItem[] {
  const scoped = items.filter((item) => item.runId === scope.runId
    && (scope.spanId === undefined || scope.spanId === null || item.spanId === scope.spanId)
    && item.visibility !== "hidden");
  const cutoffItems = cutoff?.itemId
    ? applyVisibilityCutoff(scoped, cutoff.itemId)
    : cutoff?.ordinal === undefined || cutoff?.ordinal === null
      ? scoped
      : scoped.filter((item) => item.ordinal <= cutoff.ordinal);
  return applyRange(cutoffItems, range);
}

function compatibilitySourceIsNative(source: TranscriptSource | undefined): boolean {
  return source === undefined || source === "native" || source === "native_plus_objects";
}

function compatibilityUnavailable(source: TranscriptSource, availability: TranscriptAvailability): CompatibilityTranscriptPage {
  return {
    items: [],
    nextCursor: null,
    source,
    revision: "unavailable",
    availability,
    completeness: "unknown",
  };
}

function compatibilityCursorFor(input: {
  scope: TranscriptReadScope;
  source: TranscriptSource;
  revision: string;
  range: TranscriptRange | null;
  visibilityCutoffRef: string | null;
  providerCursor: string | null;
}): string {
  return encodeCursor({
    version: 1,
    scope: "run",
    orgId: input.scope.orgId,
    principalScopeRef: selectedPrincipalScope(input.scope.principal, input.scope.orgId),
    principalType: input.scope.principal.type ?? undefined,
    principalId: input.scope.principal.id ?? undefined,
    runId: input.scope.runId,
    spanId: input.scope.spanId ?? null,
    source: input.source,
    range: input.range,
    visibilityCutoffRef: input.visibilityCutoffRef,
    revision: input.revision,
    providerCursor: input.providerCursor,
    position: 0,
  });
}

function assertCompatibilityCursor(
  cursor: CursorPayload | null,
  input: {
    scope: TranscriptReadScope;
    sourceMode: "native" | "legacy";
    range: TranscriptRange | null;
    visibilityCutoffRef: string | null;
  },
): { source: TranscriptSource | null; providerCursor: string | null; range: TranscriptRange | null } {
  if (!cursor) return { source: null, providerCursor: null, range: input.range };
  if (cursor.scope !== "run"
    || cursor.orgId !== input.scope.orgId
    || cursor.principalScopeRef !== selectedPrincipalScope(input.scope.principal, input.scope.orgId)
    || (cursor.principalType !== undefined && cursor.principalType !== (input.scope.principal.type ?? undefined))
    || (cursor.principalId !== undefined && cursor.principalId !== (input.scope.principal.id ?? undefined))
    || cursor.runId !== input.scope.runId
    || (cursor.spanId ?? null) !== (input.scope.spanId ?? null)) {
    throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor does not belong to this scope");
  }
  if (cursor.source && ((input.sourceMode === "legacy" && compatibilitySourceIsNative(cursor.source))
    || (input.sourceMode === "native" && cursor.source === "legacy"))) {
    throw transcriptReaderError("cursor_source_mismatch", "Transcript cursor does not belong to this source");
  }
  if (cursor.range !== undefined && compatibilityValueKey(cursor.range) !== compatibilityValueKey(input.range)) {
    throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor does not belong to this range");
  }
  if (cursor.visibilityCutoffRef !== undefined
    && (cursor.visibilityCutoffRef ?? null) !== (input.visibilityCutoffRef ?? null)) {
    throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor does not belong to this visibility cutoff");
  }
  return {
    source: cursor.source ?? null,
    providerCursor: cursor.providerCursor ?? null,
    range: cursor.range ?? input.range,
  };
}

function createCompatibilityTranscriptReader(options: TranscriptReaderFactoryOptions): CompatibilityTranscriptReader {
  const defaultLimit = compatibilityLimit(options.defaultLimit, DEFAULT_PAGE_LIMIT);
  const read = async (input: TranscriptReadScope): Promise<CompatibilityTranscriptPage> => {
    const scope: TranscriptReadScope = {
      ...input,
      principal: { ...input.principal },
      spanId: input.spanId ?? null,
    };
    const authorization = await options.authorize(scope);
    if (!authorization.org || !authorization.principal || !authorization.run || !authorization.span) {
      throw transcriptReaderError("unauthorized", "Transcript access denied", 403);
    }
    const cutoffRef = authorization.visibilityCutoffRef ?? authorization.visibilityCutoff?.ref ?? null;
    const requestedMode = input.mode ?? "native";
    const sourceMode = requestedMode === "legacy" ? "legacy" : "native";
    const cursor = decodeCursor(input.cursor);
    const cursorState = assertCompatibilityCursor(cursor, {
      scope,
      sourceMode,
      range: input.range ?? null,
      visibilityCutoffRef: cutoffRef,
    });
    const range = cursorState.range;
    const limit = compatibilityLimit(input.limit, defaultLimit);
    const providerInput: CompatibilityTranscriptReadInput = {
      ...scope,
      scope: input,
      cursor: cursorState.providerCursor,
      limit,
      range,
      visibilityCutoffRef: cutoffRef,
      visibilityCutoff: authorization.visibilityCutoff
        ? {
          ref: authorization.visibilityCutoff.ref,
          ordinal: authorization.visibilityCutoff.ordinal,
          itemId: authorization.visibilityCutoff.itemId ?? null,
        }
        : null,
      expectedRevision: cursor?.revision ?? null,
    };
    const useLegacy = cursorState.source === "legacy" || sourceMode === "legacy";
    const nativeReader = options.nativeReader;
    const legacyReader = options.legacyReader;

    const readHook = async (
      hook: CompatibilityTranscriptReaderHook,
      source: "native" | "legacy",
    ): Promise<{ page: CompatibilityTranscriptPage; rawItemCount: number }> => {
      const rawResult = await hook(providerInput);
      const result: CompatibilityTranscriptReadResult = isRawItemList(rawResult)
        ? { items: rawResult }
        : rawResult;
      const rawItems = result.items ?? result.entries ?? (result.item ? [result.item] : []);
      const revision = nonEmptyString(result.revision);
      if (!Array.isArray(rawItems) || !revision) {
        throw badRequest("Invalid transcript reader response");
      }
      if (cursor?.revision && revision !== cursor.revision) {
        throw transcriptReaderError("cursor_revision_mismatch", "Transcript cursor revision is no longer current");
      }
      const availability = result.availability ?? "available";
      const completeness = result.completeness ?? (rawItems.length > 0 ? "complete" : "unknown");
      const resolvedSource: TranscriptSource = source === "legacy"
        ? "legacy"
        : result.source && compatibilitySourceIsNative(result.source) ? result.source : "native";
      const items = compatibilityItems(
        normalizeItems(rawItems, {
          runId: scope.runId ?? null,
          spanId: scope.spanId ?? null,
          origin: source === "legacy" ? "legacy" : "native",
          sourceRef: authorization.spanDescriptor?.sourceRef ?? null,
        }),
        scope,
        range,
        authorization.visibilityCutoff ?? null,
      ).slice(0, limit);
      const nextCursor = result.nextCursor && availability === "available"
        ? compatibilityCursorFor({
          scope,
          source: resolvedSource,
          revision,
          range,
          visibilityCutoffRef: cutoffRef,
          providerCursor: result.nextCursor,
        })
        : null;
      return {
        page: {
          items,
          nextCursor,
          source: resolvedSource,
          revision,
          availability,
          completeness,
        },
        rawItemCount: rawItems.length,
      };
    };

    if (!useLegacy && nativeReader) {
      const nativeResult = await readHook(nativeReader, "native");
      const nativePage = nativeResult.page;
      if (!isUnavailable(nativePage.availability)
        || nativeResult.rawItemCount > 0
        || cursor
        || input.mode === "native"
        || !legacyReader) return nativePage;
    }
    if (cursorState.source && cursorState.source !== "legacy" && !nativeReader) {
      return compatibilityUnavailable(cursorState.source, "offline");
    }
    if (legacyReader) return (await readHook(legacyReader, "legacy")).page;
    return compatibilityUnavailable(sourceMode, sourceMode === "native" ? "offline" : "missing");
  };

  return { read };
}

export function createTranscriptReader(database: ReadDatabase, options?: TranscriptReaderOptions): TranscriptReader;
export function createTranscriptReader(options: TranscriptReaderFactoryOptions): CompatibilityTranscriptReader;
export function createTranscriptReader(
  databaseOrOptions: ReadDatabase | TranscriptReaderFactoryOptions,
  options: TranscriptReaderOptions = {},
): TranscriptReader | CompatibilityTranscriptReader {
  if ("authorize" in databaseOrOptions) return createCompatibilityTranscriptReader(databaseOrOptions);
  return createDatabaseTranscriptReader(databaseOrOptions, options);
}
