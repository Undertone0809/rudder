import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import { runRuntimeSpans } from "@rudderhq/db";
import { and, eq } from "drizzle-orm";
import { attachRuntimeSpanSupplement } from "./native-session.js";
import { getTranscriptObjectStore, type TranscriptObjectHandle, type TranscriptObjectStore } from "./transcript-object-store.js";

type CursorSupplementScope = {
  orgId: string;
  runId: string;
  spanId: string;
  ownerToken: string;
  attemptEpoch: number;
};

export function createCursorTranscriptSupplementCapture(
  db: Db,
  store: TranscriptObjectStore = getTranscriptObjectStore(),
  onSealError?: (error: unknown) => void,
) {
  const handles = new Map<string, Promise<TranscriptObjectHandle>>();

  async function ownedSpan(scope: CursorSupplementScope) {
    const [span] = await db.select({ supplementalObjectRef: runRuntimeSpans.supplementalObjectRef })
      .from(runRuntimeSpans).where(and(
        eq(runRuntimeSpans.orgId, scope.orgId),
        eq(runRuntimeSpans.runId, scope.runId),
        eq(runRuntimeSpans.id, scope.spanId),
        eq(runRuntimeSpans.ownerToken, scope.ownerToken),
        eq(runRuntimeSpans.attemptEpoch, scope.attemptEpoch),
        eq(runRuntimeSpans.state, "open"),
      )).limit(1);
    if (!span) throw new Error("Cursor transcript span owner is stale");
    return span;
  }

  async function open(scope: CursorSupplementScope) {
    const span = await ownedSpan(scope);
    const binding = { orgId: scope.orgId, runId: scope.runId, spanId: scope.spanId, ownerToken: scope.ownerToken };
    if (span.supplementalObjectRef) return store.resume({ ...binding, objectRef: span.supplementalObjectRef });
    const created = await store.begin(binding);
    const attached = await attachRuntimeSpanSupplement(db, { ...scope, objectRef: created.objectRef });
    if (!attached) throw new Error("Cursor transcript supplement lost its span owner");
    if (attached.supplementalObjectRef !== created.objectRef) {
      if (!attached.supplementalObjectRef) throw new Error("Cursor transcript supplement attachment is missing");
      return store.resume({ ...binding, objectRef: attached.supplementalObjectRef });
    }
    return created;
  }

  return {
    async append(scope: CursorSupplementScope, entries: readonly TranscriptEntry[]) {
      if (entries.length === 0) return;
      if (!scope.spanId || !scope.ownerToken) throw new Error("Cursor transcript requires an owned Run span");
      const key = `${scope.runId}:${scope.spanId}:${scope.ownerToken}:${scope.attemptEpoch}`;
      let pending = handles.get(key);
      if (!pending) {
        pending = open(scope).catch((error) => {
          handles.delete(key);
          throw error;
        });
        handles.set(key, pending);
      }
      const handle = await pending;
      const span = await ownedSpan(scope);
      if (span.supplementalObjectRef !== handle.objectRef) throw new Error("Cursor transcript supplement attachment changed");
      await store.append(handle, entries);
    },
    async seal() {
      try {
        for (const [key, pending] of handles) {
          const handle = await pending;
          await store.finalize(handle, { completeness: "partial" });
          handles.delete(key);
        }
      } catch (error) {
        if (!onSealError) throw error;
        onSealError(error);
      }
    },
  };
}
