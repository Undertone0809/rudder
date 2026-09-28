import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import {
  heartbeatRuns,
  nativeSegments,
  runRuntimeSpans,
  runtimeBindings,
} from "@rudderhq/db";
import type { RunLogStore } from "../run-log-store.js";

export type ReadDatabase = Pick<Db, "select">;

export type RuntimeBindingRecord = typeof runtimeBindings.$inferSelect;
export type NativeSegmentRecord = typeof nativeSegments.$inferSelect;
export type RunRuntimeSpanRecord = typeof runRuntimeSpans.$inferSelect;
export type HeartbeatRunRecord = typeof heartbeatRuns.$inferSelect;

export type TranscriptSource = "native" | "native_plus_objects" | "legacy";
export type TranscriptAvailability = "available" | "offline" | "missing" | "expired" | "incompatible";
export type TranscriptCompleteness = "complete" | "partial" | "terminal_only" | "unknown";

/** The stable selector stored by the runtime kernel for one Run span. */
export type NativeSpanSelector =
  | { kind: "codex_turn"; threadId: string; turnId: string | null; inputCorrelationRef?: string | null; runId?: string }
  | { kind: "claude_chain"; sessionId: string; startExclusiveUuid: string | null; throughInclusiveUuid: string | null; inputCorrelationRef?: string | null; ancestryRevision?: string | null }
  | { kind: "hermes_execution"; sessionRef: string; providerExecutionRef: string | null; sourceRangeRef?: string | null; boundaryStatus?: string | null; inputCorrelationRef?: string | null }
  | {
    kind: "opencode_input";
    sessionId: string;
    userMessageId: string | null;
    terminalMessageIds: string[];
    observedAssistantMessageIds?: string[];
    completeness?: "partial";
    boundaryStatus?: string | null;
    inputCorrelationRef?: string | null;
  }
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

/** For Run reads, numeric bounds index visible items across selected spans and provider pages before range selection. */
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
  limitReached?: TranscriptReadLimit | null;
}

export type TranscriptReadLimitReason = "page_bytes" | "total_bytes" | "total_items" | "item_bytes";

export interface TranscriptReadLimit {
  reason: TranscriptReadLimitReason;
  maximum: number;
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
  /** Numeric position bounds are applied by Transcript Reader across provider pages. */
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
  cursor?: string | null;
  limit?: number;
  events?: readonly Record<string, unknown>[];
  readEvents?: (input: {
    cursor?: string | null;
    limit: number;
    maxBytes: number;
    maxItemBytes: number;
    signal?: AbortSignal;
  }) => Promise<LegacyTranscriptEventPage>;
  signal?: AbortSignal;
}

export interface LegacyTranscriptEventPage {
  events: readonly Record<string, unknown>[];
  nextCursor: string | null;
  revision: string;
  readBytes: number;
  limitReached?: TranscriptReadLimit | null;
}

export interface LegacyTranscriptReadResult {
  entries: readonly TranscriptEntry[];
  itemOffset?: number;
  nextCursor?: string | null;
  revision?: string | null;
  availability?: TranscriptAvailability;
  completeness?: TranscriptCompleteness;
  limitReached?: TranscriptReadLimit | null;
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
  maxLegacyTotalBytes?: number;
  maxLegacyTotalItems?: number;
  maxLegacyItemBytes?: number;
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

export type CursorScope = "run" | "conversation";
export type ConversationSourceKind = "run" | "message";
export type ConversationSourceCursor = {
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

export type CursorPayload = {
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
  /** Visible-item position in the selected Run before this provider page, including preceding spans. */
  providerOffset?: number;
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

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;
export const DEFAULT_LEGACY_READ_BYTES = 256 * 1024;
export const MAX_LEGACY_READ_BYTES = 2 * 1024 * 1024;
export const DEFAULT_LEGACY_TOTAL_READ_BYTES = 64 * 1024 * 1024;
export const MAX_LEGACY_TOTAL_READ_BYTES = 256 * 1024 * 1024;
export const DEFAULT_LEGACY_TOTAL_ITEMS = 20_000;
export const MAX_LEGACY_TOTAL_ITEMS = 100_000;
export const DEFAULT_LEGACY_ITEM_BYTES = 1024 * 1024;
export const MAX_LEGACY_ITEM_BYTES = 2 * 1024 * 1024;
export const MAX_CONVERSATION_SOURCE_SCAN = MAX_PAGE_LIMIT * 4;

export type TranscriptReaderErrorCode =
  | "unauthorized"
  | "cursor_scope_mismatch"
  | "cursor_source_mismatch"
  | "cursor_revision_mismatch"
  | "cursor_invalid";

export type ConversationSourceAnchor = Pick<ConversationSourceCursor, "kind" | "id" | "createdAt">;

export type ConversationMessageRecord = {
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

export type ConversationSourceRow =
  | { descriptor: ConversationSourceCursor; run: HeartbeatRunRecord; message?: never }
  | { descriptor: ConversationSourceCursor; run?: never; message: ConversationMessageRecord };

export type ResolvedSource = {
  items: TranscriptItem[];
  source: TranscriptSource;
  /** Source identity for the active provider continuation. */
  providerSource?: TranscriptSource | null;
  revision: string;
  /** Revision for the active provider page, distinct from a merged page revision. */
  providerRevision?: string | null;
  availability: TranscriptAvailability;
  completeness: TranscriptCompleteness;
  limitReached?: TranscriptReadLimit | null;
  providerCursor: string | null;
  providerNextCursor: string | null;
  /** Visible-item position in the selected Run before this provider page, including preceding spans. */
  providerOffset?: number;
  /** Visible-item position after this provider page, before range selection. */
  providerNextOffset?: number;
  spanId: string | null;
  nextSpanId?: string | null;
  windowRevision?: string;
  /** True only when native has no readable item and legacy may be tried. */
  legacyFallbackEligible?: boolean;
};

export type ConversationSourceState = {
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

export type ConversationReadPage = Pick<TranscriptPage, "items" | "nextCursor" | "source" | "revision" | "availability" | "completeness">;
