import type { Db } from "@rudderhq/db";
import { heartbeatRunAttempts, heartbeatRuns } from "@rudderhq/db";
import { and, eq } from "drizzle-orm";
import { startRunRuntimeSpanInTransaction } from "./native-session.js";
import type { UnifiedAgentRunPersistenceAdapterOptions } from "./unified-agent-run.contracts.js";
import type { UnifiedAgentRunAdmission, UnifiedOwnerFence } from "./unified-agent-run.js";
import {
  assertPersistedRuntimeIdentity,
  contextWithAdmission,
  persistenceError,
  type UnifiedStoredAdmission,
} from "./unified-agent-run.persistence-support.js";

type NativeSpanResolver = NonNullable<UnifiedAgentRunPersistenceAdapterOptions["resolveNativeSpan"]>;

export async function startHeartbeatRetrySpan(input: {
  tx: Db;
  resolveNativeSpan: NativeSpanResolver;
  run: typeof heartbeatRuns.$inferSelect;
  stored: UnifiedStoredAdmission;
  admission: UnifiedAgentRunAdmission;
  attempt: typeof heartbeatRunAttempts.$inferSelect;
  runtimeType: string;
  fence: Pick<UnifiedOwnerFence, "ownerToken" | "attemptEpoch">;
}) {
  const nativeSpan = await input.resolveNativeSpan({
    db: input.tx,
    admission: input.admission,
    runId: input.run.id,
    attemptId: input.attempt.id,
    attemptIndex: input.attempt.attemptIndex,
    ownerToken: input.fence.ownerToken,
    attemptEpoch: input.fence.attemptEpoch,
  });
  if (!nativeSpan) {
    throw persistenceError("unsupported", `heartbeat run ${input.run.id} has no native resources for retry span`);
  }
  if (
    nativeSpan.binding.orgId !== input.run.orgId
    || nativeSpan.binding.agentId !== input.run.agentId
    || nativeSpan.binding.runtimeType !== input.runtimeType
    || nativeSpan.segment.orgId !== input.run.orgId
    || nativeSpan.segment.bindingId !== nativeSpan.binding.id
  ) {
    throw persistenceError("contract", `heartbeat run ${input.run.id} retry resolver returned a mismatched native identity`);
  }
  assertPersistedRuntimeIdentity({
    binding: nativeSpan.binding,
    segment: nativeSpan.segment,
    driverRuntimeType: input.runtimeType,
    context: `heartbeat run ${input.run.id} retry span`,
  });

  const attemptRef = `${input.stored.idempotencyKey}:attempt:${input.attempt.attemptIndex}`;
  const retrySpan = await startRunRuntimeSpanInTransaction(
    input.tx as unknown as Pick<Db, "select" | "insert" | "update" | "execute">,
    {
      orgId: input.run.orgId,
      runId: input.run.id,
      binding: nativeSpan.binding,
      segment: nativeSpan.segment,
      runtimeType: input.runtimeType,
      attemptRef,
      attemptId: input.attempt.id,
      attemptEpoch: input.fence.attemptEpoch,
      ownerToken: input.fence.ownerToken,
      inputCorrelationRef: nativeSpan.inputCorrelationRef ?? attemptRef,
      relation: "continuation",
    },
  );
  const nextStored = {
    ...input.stored,
    ownerFenceId: retrySpan.id,
    lastOwnerToken: input.fence.ownerToken,
    attemptEpoch: input.fence.attemptEpoch,
  } satisfies UnifiedStoredAdmission;
  await input.tx.update(heartbeatRuns)
    .set({ contextSnapshot: contextWithAdmission(input.run.contextSnapshot, nextStored) })
    .where(and(eq(heartbeatRuns.id, input.run.id), eq(heartbeatRuns.orgId, input.run.orgId)));
  return retrySpan;
}
