import { logger } from "../../middleware/logger.js";
import type { CoverageIdentity } from "./native-transcript-coverage.js";
import type { CodexTimelineShadowReader } from "./transcript-object-store.js";
import type {
  NativeTranscriptReadInput, NativeTranscriptReadResult, TranscriptAvailability,
  TranscriptCompleteness, TranscriptItem, TranscriptReaderOptions,
} from "./transcript-reader.contracts.js";
import { stableHash } from "./transcript-reader.normalize.js";

// Observe the normalized public single-span projection without re-resolving
// native data or changing the primary Reader response.
export async function compareResolvedCodexTimelineShadow({
  options, input, origin, items, revision, availability, completeness,
  nextCursor, result, rawItemCount,
}: {
  options: TranscriptReaderOptions;
  input: NativeTranscriptReadInput;
  origin: "native" | "object";
  items: readonly TranscriptItem[];
  revision: string;
  availability: TranscriptAvailability;
  completeness: TranscriptCompleteness;
  nextCursor: string | null;
  result: NativeTranscriptReadResult;
  rawItemCount: number;
}) {
  // Shadow comparison only: reuse this already-resolved exact native snapshot.
  // Never ask a provider again, replace primary items/revisions, or promote a
  // partial supplement. Small/paged/ranged/item reads keep their existing path.
  const shadowReader = options.objectReader as CodexTimelineShadowReader | null | undefined;
  if (origin === "native" && input.binding?.runtimeType === "codex_local"
    && input.selector.kind === "codex_turn" && input.span.state === "sealed"
    && input.span.writerLeaseReleasedAt && input.span.attemptId && input.span.supplementalObjectRef
    && !input.span.supplementalRetentionExpiredAt && !input.cursor && !input.itemId
    && !input.range && !input.visibilityCutoffRef && !nextCursor && !result.limitReached && !result.truncated
    && availability === "available" && completeness === "complete" && rawItemCount <= 256
    && shadowReader?.compareCodexTimelineShadow) {
    const identity: CoverageIdentity = { orgId: input.orgId, runId: input.run.id, spanId: input.span.id,
      attemptId: input.span.attemptId, attemptEpoch: input.span.attemptEpoch, ownerToken: input.span.ownerToken,
      selector: input.selector as CoverageIdentity["selector"] };
    try {
      const compared = await shadowReader.compareCodexTimelineShadow(input, { identity, source: "native",
        availability: "available", completeness: "complete",
        // Single selected span public Reader revision/projection, identical to
        // the caller's readRun({spanId}) snapshot, not the raw provider layer.
        revisionBefore: stableHash([revision]), revisionAfter: stableHash([revision]),
        entries: items.map((item) => item.entry as unknown as Record<string, unknown>) });
      if (!compared.ok && compared.reason !== "shadow_not_present") logger.warn({ orgId: input.orgId,
        runId: input.run.id, spanId: input.span.id, reason: compared.reason }, "Codex shadow comparison failed; original source retained");
    } catch {
      logger.warn({ orgId: input.orgId, runId: input.run.id, spanId: input.span.id }, "Codex shadow comparison failed; original source retained");
    }
  }
}
