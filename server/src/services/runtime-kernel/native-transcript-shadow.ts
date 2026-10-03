import type { Db } from "@rudderhq/db";
import { sql } from "drizzle-orm";
import { stableJson } from "../chat-agent-runs.helpers.js";
import type { CodexMixedCoverageInput, CoverageIdentity } from "./native-transcript-coverage.js";
import { selectAndVerifyNativeTranscriptCleanupState, type NativeTranscriptRunProof } from "./native-transcript-retention.js";
import type { CodexTimelineShadowResult, TranscriptObjectStore } from "./transcript-object-store.js";
import type { TranscriptReader } from "./transcript-reader.js";

/** Shadow-only terminal caller. Object -> Run advisory -> row locks, matching
 * sweep's object -> retention-row order. No terminal replay or delete claim. */
export async function persistCodexTimelineShadows(input: {
  db: Db;
  proof: NativeTranscriptRunProof;
  store: TranscriptObjectStore;
  readerFactory: (db: Pick<Db, "select">) => TranscriptReader;
}): Promise<Array<{ spanId: string; result: CodexTimelineShadowResult }>> {
  const results: Array<{ spanId: string; result: CodexTimelineShadowResult }> = [];
  for (const span of input.proof.spans) {
    if (span.selectorJson.kind !== "codex_turn" || !span.supplementalObjectRef || span.itemCount > 256) continue;
    const fail = (reason: string): CodexTimelineShadowResult => ({ ok: false, reason, authorizesOldObjectDelete: false });
    try {
      if (!input.store.withCodexTimelineShadowLock) {
        results.push({ spanId: span.spanId, result: fail("shadow_object_lock_unavailable") });
        continue;
      }
      const result = await input.store.withCodexTimelineShadowLock(span.supplementalObjectRef, write =>
        input.db.transaction(async tx => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.proof.runId}))`);
          const prepared = await selectAndVerifyNativeTranscriptCleanupState(tx, input.proof);
          if (!prepared) return fail("shadow_owner_fence_changed");
          const retention = prepared.run.contextSnapshot?.nativeTranscriptRetention as { cleanupLease?: { expiresAt?: string } } | undefined;
          if (retention?.cleanupLease && (!retention.cleanupLease.expiresAt
            || Date.parse(retention.cleanupLease.expiresAt) > Date.now()
            || !Number.isFinite(Date.parse(retention.cleanupLease.expiresAt)))) return fail("shadow_retention_lease_active");
          const identity: CoverageIdentity = { orgId: input.proof.orgId, runId: input.proof.runId, spanId: span.spanId,
            attemptId: span.attemptId, attemptEpoch: span.attemptEpoch, ownerToken: span.ownerToken,
            selector: span.selectorJson as CoverageIdentity["selector"] };
          const reader = input.readerFactory(tx as unknown as Pick<Db, "select">);
          const snapshot = async (): Promise<CodexMixedCoverageInput["native"]> => {
            const entries: Record<string, unknown>[] = [];
            let cursor: string | null = null;
            for (let pageIndex = 0; pageIndex < 2; pageIndex += 1) {
              const page = await reader.readRun({ orgId: input.proof.orgId, runId: input.proof.runId, spanId: span.spanId,
                principal: { type: "board", orgId: input.proof.orgId, authorized: true }, cursor, limit: 200,
                signal: AbortSignal.timeout(5000) });
              if (page.source !== "native" || page.availability !== "available" || page.revision !== span.sourceRevision
                || page.limitReached || page.truncated || (page.completeness !== "complete" && !page.nextCursor)
                || page.items.some(item => item.runId !== input.proof.runId || item.spanId !== span.spanId || !item.entry)) throw new Error("shadow_native_snapshot_incomplete");
              entries.push(...page.items.map(item => item.entry as unknown as Record<string, unknown>));
              if (entries.length > 256) throw new Error("shadow_native_snapshot_bounds");
              if (!page.nextCursor) {
                if (entries.length !== span.itemCount) throw new Error("shadow_native_snapshot_count");
                return { identity, source: "native", availability: "available", completeness: "complete",
                  revisionBefore: page.revision, revisionAfter: page.revision, entries };
              }
              if (page.nextCursor === cursor) throw new Error("shadow_native_cursor_stalled");
              cursor = page.nextCursor;
            }
            throw new Error("shadow_native_snapshot_bounds");
          };
          const native = await snapshot();
          return write({ objectRef: span.supplementalObjectRef!, identity, native,
            beforePublish: async () => Boolean(await selectAndVerifyNativeTranscriptCleanupState(tx, input.proof))
              && stableJson(await snapshot()) === stableJson(native) });
        }));
      results.push({ spanId: span.spanId, result });
    } catch {
      results.push({ spanId: span.spanId, result: fail("shadow_persistence_refused") });
    }
  }
  return results;
}
