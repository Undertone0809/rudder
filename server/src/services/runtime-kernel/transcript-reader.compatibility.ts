import { badRequest } from "../../errors.js";
import type {
  CompatibilityTranscriptPage,
  CompatibilityTranscriptReader,
  CompatibilityTranscriptReaderHook,
  CompatibilityTranscriptReadInput,
  CompatibilityTranscriptReadResult,
  CursorPayload,
  TranscriptAvailability,
  TranscriptItem,
  TranscriptRange,
  TranscriptReadAuthorization,
  TranscriptReaderFactoryOptions,
  TranscriptReadScope,
  TranscriptSource
} from "./transcript-reader.contracts.js";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
} from "./transcript-reader.contracts.js";
import {
  compatibilityValueKey,
  isRawItemList,
  isUnavailable,
  nonEmptyString,
  normalizeItems,
  selectedPrincipalScope,
  transcriptReaderError,
} from "./transcript-reader.normalize.js";
import {
  applyRange,
  applyVisibilityCutoff,
  decodeCursor,
  encodeCursor,
} from "./transcript-reader.pages.js";

function compatibilityScopeKey(scope: TranscriptReadScope): string {
  return JSON.stringify({
    orgId: scope.orgId,
    principal: scope.principal,
    runId: scope.runId,
    spanId: scope.spanId ?? null,
  });
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

export function createCompatibilityTranscriptReader(options: TranscriptReaderFactoryOptions): CompatibilityTranscriptReader {
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
