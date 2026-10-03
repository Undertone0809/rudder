import type { Db } from "@rudderhq/db";
import { nativeSegments, runRuntimeSpans, runtimeBindings } from "@rudderhq/db";
import { and, eq } from "drizzle-orm";
import { hasVerifiedHeartbeatNativeTranscriptProfile, type HeartbeatTranscriptRetentionInput } from "./runtime-kernel/heartbeat-transcript-retention.js";
import type { CoverageIdentity } from "./runtime-kernel/native-transcript-coverage.js";

// Qualification is called only for a NEW allocation after the immutable owner
// check. Unknown profile/range never upgrades an attached historical object.
export async function qualifiedCodexGapIdentity(
  db: Pick<Db, "select">,
  run: { id: string; orgId: string; runtimeAttemptRef?: { id: string } | null },
  identity: { id: string; ownerToken: string; attemptEpoch: number },
  span: Pick<typeof runRuntimeSpans.$inferSelect, "selectorJson" | "bindingId" | "segmentId" | "attemptId" | "nativeExecutionRef">,
  profile?: HeartbeatTranscriptRetentionInput["profileCapability"],
): Promise<CoverageIdentity | null> {
        // New allocation only. Profile support is not native durability: use a
        // self-contained dictionary, never discard the recovery transcript.
        if (profile?.runtimeType === "codex_local" && hasVerifiedHeartbeatNativeTranscriptProfile(profile)
          && profile.binding.orgId === run.orgId && span.attemptId === run.runtimeAttemptRef?.id
          && span.selectorJson.kind === "codex_turn" && span.selectorJson.runId === run.id
          && typeof span.selectorJson.threadId === "string" && span.selectorJson.threadId.length > 0
          && typeof span.selectorJson.turnId === "string" && span.selectorJson.turnId.length > 0
          && span.nativeExecutionRef === span.selectorJson.turnId) {
          const binding = await db.select().from(runtimeBindings).where(and(
            eq(runtimeBindings.id, span.bindingId), eq(runtimeBindings.orgId, run.orgId),
          )).limit(1).then(rows => rows[0] ?? null);
          const segment = binding ? await db.select().from(nativeSegments).where(and(
            eq(nativeSegments.id, span.segmentId), eq(nativeSegments.orgId, run.orgId),
            eq(nativeSegments.bindingId, binding.id),
          )).limit(1).then(rows => rows[0] ?? null) : null;
          if (binding?.runtimeType === "codex_local" && binding.status === "active" && binding.continuity === "native"
            && segment?.runtimeType === "codex_local" && segment.nativeSessionId === span.selectorJson.threadId
            && binding.hostId === profile.binding.hostId && binding.profileId === profile.binding.profileId
            && (binding.workspaceBindingId ?? null) === (profile.binding.workspaceBindingId ?? null)
            && (binding.capabilityRevision ?? null) === (profile.binding.capabilityRevision ?? null)) {
            return { orgId: run.orgId, runId: run.id, spanId: identity.id,
              attemptId: span.attemptId!, attemptEpoch: identity.attemptEpoch, ownerToken: identity.ownerToken,
              selector: span.selectorJson as CoverageIdentity["selector"] };
          }
        }
        return null;
}
