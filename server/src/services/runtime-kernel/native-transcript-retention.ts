import type { Db } from "@rudderhq/db";
import { heartbeatRunAttempts, heartbeatRunEvents, heartbeatRuns, runRuntimeSpans } from "@rudderhq/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { summarizeHeartbeatRunResultJson } from "../heartbeat-run-summary.js";
import type { RunLogStore } from "../run-log-store.js";
import type { TranscriptObjectStore } from "./transcript-object-store.js";
import type { TranscriptReader } from "./transcript-reader.js";

export type NativeTranscriptSpanProof = {
  spanId: string;
  ownerToken: string;
  attemptEpoch: number;
  attemptId: string;
  sourceRevision: string;
  itemCount: number;
  selectorJson: Record<string, unknown>;
  supplementalObjectRef: string | null;
};

export type NativeTranscriptRunProof = {
  orgId: string;
  runId: string;
  spans: NativeTranscriptSpanProof[];
  itemCount: number;
};

export type NativeTranscriptRecoveryLocation =
  | { kind: "transcript_object"; objectRef: string; spanId: string; stageId: string }
  | { kind: "transcript_supplement"; objectRef: string; spanId: string }
  | { kind: "run_log"; store: "local_file"; logRef: string; sha256?: string; stageId: string };

export type NativeTranscriptProofResult =
  | { ok: true; proof: NativeTranscriptRunProof }
  | { ok: false; reason: string };

const INCOMPLETE_BOUNDARIES = new Set(["missing", "unknown", "partial", "terminal_only"]);
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

function ownerTokenHash(ownerToken: string) {
  return createHash("sha256").update(ownerToken).digest("hex");
}

export function nativeTranscriptProofSnapshot(proof: NativeTranscriptRunProof) {
  return {
    proofOrgId: proof.orgId,
    proofRunId: proof.runId,
    spans: proof.spans.map((span) => ({
      spanId: span.spanId,
      attemptId: span.attemptId,
      ownerTokenHash: ownerTokenHash(span.ownerToken),
      attemptEpoch: span.attemptEpoch,
      selectorHash: createHash("sha256").update(stableJson(span.selectorJson)).digest("hex"),
      sourceRevision: span.sourceRevision,
      itemCount: span.itemCount,
      ...(span.supplementalObjectRef ? { objectRef: span.supplementalObjectRef } : {}),
    })),
  };
}

export function matchesNativeTranscriptProofSnapshot(
  snapshot: Record<string, unknown>,
  proof: NativeTranscriptRunProof,
): boolean {
  if (snapshot.proofOrgId !== proof.orgId
    || snapshot.proofRunId !== proof.runId
    || !Array.isArray(snapshot.spans)
    || snapshot.spans.length !== proof.spans.length) return false;

  const savedById = new Map(snapshot.spans.flatMap((value) => {
    const saved = record(value);
    return nonEmpty(saved?.spanId) ? [[saved.spanId, saved] as const] : [];
  }));
  if (savedById.size !== proof.spans.length) return false;
  return proof.spans.every((span) => {
    const saved = savedById.get(span.spanId);
    return Boolean(saved
      && saved.attemptId === span.attemptId
      && saved.sourceRevision === span.sourceRevision
      && saved.itemCount === span.itemCount
      && saved.attemptEpoch === span.attemptEpoch
      && saved.ownerTokenHash === ownerTokenHash(span.ownerToken)
      && saved.selectorHash === createHash("sha256").update(stableJson(span.selectorJson)).digest("hex")
      && (!span.supplementalObjectRef || saved.objectRef === span.supplementalObjectRef));
  });
}

export function matchesNativeTranscriptRecoverySnapshot(input: {
  snapshot: Record<string, unknown>;
  proof: NativeTranscriptRunProof;
  recovery: NativeTranscriptRecoveryLocation[];
}): boolean {
  if (!matchesNativeTranscriptProofSnapshot(input.snapshot, input.proof)) return false;
  const snapshotSpans = input.snapshot.spans as unknown[];
  const savedSpans = new Map<string, Record<string, unknown>>(snapshotSpans.flatMap((value) => {
    const saved = record(value);
    return nonEmpty(saved?.spanId) ? [[saved.spanId, saved] as [string, Record<string, unknown>]] : [];
  }));
  return input.recovery.every((location) => {
    if (location.kind !== "transcript_object" && location.kind !== "transcript_supplement") return true;
    const saved = savedSpans.get(location.spanId);
    return Boolean(saved && saved.objectRef === location.objectRef);
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasExactSpanAttemptCoverage(input: {
  spans: Array<{ id: string; attemptId: string | null }>;
  attempts: Array<{ id: string }>;
  expected?: Array<{ spanId: string; attemptId: string }>;
}): boolean {
  if (input.spans.length === 0 || input.attempts.length === 0) return false;

  const attemptIds = new Set(input.attempts.map((attempt) => attempt.id));
  if (attemptIds.size !== input.attempts.length) return false;
  const spanAttempts = new Map<string, string>();
  const coveredAttempts = new Set<string>();
  for (const span of input.spans) {
    if (!span.id || spanAttempts.has(span.id) || !span.attemptId || !attemptIds.has(span.attemptId)) return false;
    spanAttempts.set(span.id, span.attemptId);
    coveredAttempts.add(span.attemptId);
  }
  if (coveredAttempts.size !== attemptIds.size) return false;

  if (input.expected) {
    const expectedBySpanId = new Map(input.expected.map((span) => [span.spanId, span.attemptId] as const));
    if (expectedBySpanId.size !== input.expected.length || expectedBySpanId.size !== spanAttempts.size) return false;
    for (const [spanId, attemptId] of spanAttempts) {
      if (expectedBySpanId.get(spanId) !== attemptId) return false;
    }
  }
  return true;
}

function selectorBoundaryIsExact(value: unknown): boolean {
  const selector = record(value);
  if (!selector || typeof selector.kind !== "string") return false;
  if (selector.kind === "pending" || selector.kind === "unresolved") return false;
  if ([selector.completeness, selector.boundaryStatus].some((status) =>
    typeof status === "string" && INCOMPLETE_BOUNDARIES.has(status))) return false;

  switch (selector.kind) {
    case "codex_turn":
      return nonEmpty(selector.threadId) && nonEmpty(selector.turnId) && nonEmpty(selector.runId);
    case "claude_chain":
      return nonEmpty(selector.sessionId) && nonEmpty(selector.throughInclusiveUuid);
    case "hermes_execution":
      return nonEmpty(selector.sessionRef)
        && (nonEmpty(selector.sourceRangeRef) || nonEmpty(selector.providerExecutionRef));
    case "opencode_input":
      return nonEmpty(selector.sessionId)
        && nonEmpty(selector.userMessageId)
        && selector.boundaryStatus === "exact"
        && Array.isArray(selector.terminalMessageIds)
        && selector.terminalMessageIds.some(nonEmpty);
    case "pi_branch_range":
      return nonEmpty(selector.sessionResourceRef) && nonEmpty(selector.throughInclusive);
    case "cursor_execution":
      return nonEmpty(selector.sessionId)
        && (nonEmpty(selector.nativeRangeRef) || nonEmpty(selector.executionRef));
    default:
      return false;
  }
}

async function readExactSpan(
  reader: TranscriptReader,
  input: { orgId: string; runId: string; spanId: string },
): Promise<{ sourceRevision: string; itemCount: number } | null> {
  let cursor: string | null = null;
  let revision: string | null = null;
  let itemCount = 0;
  const seenCursors = new Set<string>();

  for (let pageCount = 0; pageCount < 100_000; pageCount += 1) {
    const page = await reader.readRun({
      orgId: input.orgId,
      runId: input.runId,
      spanId: input.spanId,
      principal: { type: "board", orgId: input.orgId, authorized: true },
      cursor,
      limit: 200,
    });
    if (page.source !== "native"
      || page.availability !== "available"
      || page.completeness !== "complete"
      || page.limitReached
      || !nonEmpty(page.revision)
      || (revision !== null && page.revision !== revision)
      || page.items.some((item) => item.runId !== input.runId || item.spanId !== input.spanId)) {
      return null;
    }
    revision ??= page.revision;
    itemCount += page.items.length;
    if (!page.nextCursor) break;
    if (page.nextCursor === cursor || seenCursors.has(page.nextCursor) || page.items.length === 0) return null;
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
    if (pageCount === 99_999) return null;
  }

  if (!revision || itemCount === 0) return null;
  const confirmation = await reader.readRun({
    orgId: input.orgId,
    runId: input.runId,
    spanId: input.spanId,
    principal: { type: "board", orgId: input.orgId, authorized: true },
    cursor: null,
    limit: 1,
  });
  if (confirmation.source !== "native"
    || confirmation.availability !== "available"
    || confirmation.completeness !== "complete"
    || confirmation.revision !== revision
    || confirmation.items.some((item) => item.runId !== input.runId || item.spanId !== input.spanId)) return null;
  return { sourceRevision: revision, itemCount };
}

export async function proveSealedNativeRunTranscript(input: {
  db: Db;
  reader: TranscriptReader;
  orgId: string;
  runId: string;
  expectedOwner?: { spanId: string; ownerToken: string; attemptEpoch: number; attemptId?: string } | null;
}): Promise<NativeTranscriptProofResult> {
  const [run] = await input.db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.orgId, input.orgId),
    eq(heartbeatRuns.id, input.runId),
  )).limit(1);
  if (!run || run.status !== "succeeded" || run.executionOwnerToken !== null
    || run.terminalEffectsPending || !run.processExitedAt) return { ok: false, reason: "run_not_sealed" };

  const spans = await input.db.select().from(runRuntimeSpans).where(and(
    eq(runRuntimeSpans.orgId, input.orgId),
    eq(runRuntimeSpans.runId, input.runId),
  )).orderBy(asc(runRuntimeSpans.ordinal), asc(runRuntimeSpans.id));
  const attempts = await input.db.select().from(heartbeatRunAttempts).where(and(
    eq(heartbeatRunAttempts.orgId, input.orgId),
    eq(heartbeatRunAttempts.runId, input.runId),
  ));
  if (!hasExactSpanAttemptCoverage({ spans, attempts })) {
    return { ok: false, reason: "span_attempt_set_mismatch" };
  }

  const attemptById = new Map<string, typeof heartbeatRunAttempts.$inferSelect>(
    attempts.map((attempt) => [attempt.id, attempt] as const),
  );
  const proofSpans: NativeTranscriptSpanProof[] = [];
  for (const span of spans) {
    const attempt = span.attemptId ? attemptById.get(span.attemptId) : null;
    if (!attempt || !span.ownerToken || !Number.isInteger(span.attemptEpoch)
      || span.state !== "sealed" || span.completeness !== "complete"
      || !span.writerLeaseReleasedAt
      || span.visibilityCutoffRef || !selectorBoundaryIsExact(span.selectorJson)
      || attempt.ownerToken !== span.ownerToken || attempt.attemptEpoch !== span.attemptEpoch
      || !TERMINAL_STATUSES.has(attempt.status) || !attempt.finishedAt) {
      return { ok: false, reason: "span_attempt_identity_incomplete" };
    }
    if (input.expectedOwner && span.id === input.expectedOwner.spanId
      && (span.ownerToken !== input.expectedOwner.ownerToken
        || span.attemptEpoch !== input.expectedOwner.attemptEpoch
        || (input.expectedOwner.attemptId && span.attemptId !== input.expectedOwner.attemptId))) {
      return { ok: false, reason: "owner_fence_mismatch" };
    }
    const read = await readExactSpan(input.reader, {
      orgId: input.orgId,
      runId: input.runId,
      spanId: span.id,
    }).catch(() => null);
    if (!read) return { ok: false, reason: "native_range_read_incomplete" };
    proofSpans.push({
      spanId: span.id,
      ownerToken: span.ownerToken,
      attemptEpoch: span.attemptEpoch,
      attemptId: attempt.id,
      sourceRevision: read.sourceRevision,
      itemCount: read.itemCount,
      selectorJson: span.selectorJson,
      supplementalObjectRef: span.supplementalObjectRef,
    });
  }

  if (input.expectedOwner && !proofSpans.some((span) => span.spanId === input.expectedOwner!.spanId)) {
    return { ok: false, reason: "expected_span_missing" };
  }

  const currentRun = await input.db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.orgId, input.orgId),
    eq(heartbeatRuns.id, input.runId),
  )).limit(1).then((rows) => rows[0] ?? null);
  if (!currentRun || currentRun.status !== run.status || currentRun.executionOwnerToken !== null
    || currentRun.terminalEffectsPending || !currentRun.processExitedAt) return { ok: false, reason: "run_identity_changed" };
  for (const proof of proofSpans) {
    const [span] = await input.db.select().from(runRuntimeSpans).where(and(
      eq(runRuntimeSpans.orgId, input.orgId),
      eq(runRuntimeSpans.runId, input.runId),
      eq(runRuntimeSpans.id, proof.spanId),
    )).limit(1);
    const [attempt] = await input.db.select().from(heartbeatRunAttempts).where(and(
      eq(heartbeatRunAttempts.orgId, input.orgId),
      eq(heartbeatRunAttempts.runId, input.runId),
      eq(heartbeatRunAttempts.id, proof.attemptId),
    )).limit(1);
    if (!span || !attempt || span.ownerToken !== proof.ownerToken
      || span.attemptEpoch !== proof.attemptEpoch || span.attemptId !== proof.attemptId
      || span.state !== "sealed" || span.completeness !== "complete"
      || !span.writerLeaseReleasedAt
      || !attempt.finishedAt || attempt.ownerToken !== proof.ownerToken
      || attempt.attemptEpoch !== proof.attemptEpoch) return { ok: false, reason: "span_attempt_identity_changed" };
  }

  return {
    ok: true,
    proof: {
      orgId: input.orgId,
      runId: input.runId,
      spans: proofSpans,
      itemCount: proofSpans.reduce((count, span) => count + span.itemCount, 0),
    },
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value) ?? "null";
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

type TranscriptEventIdentity = { spanId: string; attemptId: string };

function transcriptEventIdentities(proof: NativeTranscriptRunProof) {
  return new Set(proof.spans.map((span) => `${span.spanId}:${span.attemptId}`));
}

function recoveryLocations(input: {
  objects: Array<{ span: NativeTranscriptSpanProof; stageId: string }>;
  runLog: Awaited<ReturnType<NonNullable<RunLogStore["stageRunRemoval"]>>> | null;
}): NativeTranscriptRecoveryLocation[] {
  return [
    ...input.objects.map(({ span, stageId }) => ({
      kind: "transcript_object" as const,
      objectRef: span.supplementalObjectRef!,
      spanId: span.spanId,
      stageId,
    })),
    ...(input.runLog ? [{
      kind: "run_log" as const,
      store: input.runLog.handle.store,
      logRef: input.runLog.handle.logRef,
      sha256: input.runLog.expectedSha256,
      stageId: input.runLog.stageId,
    }] : []),
  ];
}

function hasExactTranscriptEventIdentity(payload: unknown, allowed: ReadonlySet<string>): boolean {
  const value = record(payload);
  return nonEmpty(value?.spanId)
    && nonEmpty(value?.attemptId)
    && allowed.has(`${value.spanId}:${value.attemptId}`);
}

export async function selectAndVerifyNativeTranscriptCleanupState(tx: any, proof: NativeTranscriptRunProof) {
  const [run] = await tx.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.orgId, proof.orgId),
    eq(heartbeatRuns.id, proof.runId),
  )).for("update").limit(1);
  if (!run || run.status !== "succeeded" || run.executionOwnerToken !== null
    || run.terminalEffectsPending || !run.processExitedAt) return null;

  const spans = await tx.select().from(runRuntimeSpans).where(and(
    eq(runRuntimeSpans.orgId, proof.orgId),
    eq(runRuntimeSpans.runId, proof.runId),
  )).orderBy(asc(runRuntimeSpans.ordinal), asc(runRuntimeSpans.id)).for("update");
  const attempts = await tx.select().from(heartbeatRunAttempts).where(and(
    eq(heartbeatRunAttempts.orgId, proof.orgId),
    eq(heartbeatRunAttempts.runId, proof.runId),
  )).for("update");
  if (!hasExactSpanAttemptCoverage({
    spans,
    attempts,
    expected: proof.spans.map((span) => ({ spanId: span.spanId, attemptId: span.attemptId })),
  })) return null;
  const spanById = new Map<string, typeof runRuntimeSpans.$inferSelect>(
    spans.map((span: typeof runRuntimeSpans.$inferSelect) => [span.id, span] as const),
  );
  const attemptById = new Map<string, typeof heartbeatRunAttempts.$inferSelect>(
    attempts.map((attempt: typeof heartbeatRunAttempts.$inferSelect) => [attempt.id, attempt] as const),
  );
  for (const expected of proof.spans) {
    const span = spanById.get(expected.spanId);
    const attempt = attemptById.get(expected.attemptId);
    if (!span || !attempt || span.orgId !== proof.orgId || span.runId !== proof.runId
      || span.ownerToken !== expected.ownerToken || span.attemptEpoch !== expected.attemptEpoch
      || span.attemptId !== expected.attemptId || span.state !== "sealed" || span.completeness !== "complete"
      || !span.writerLeaseReleasedAt
      || stableJson(span.selectorJson) !== stableJson(expected.selectorJson)
      || span.supplementalObjectRef !== expected.supplementalObjectRef
      || attempt.ownerToken !== expected.ownerToken || attempt.attemptEpoch !== expected.attemptEpoch
      || !TERMINAL_STATUSES.has(attempt.status) || !attempt.finishedAt) return null;
  }

  const transcriptEvents = await tx.select().from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.orgId, proof.orgId),
    eq(heartbeatRunEvents.runId, proof.runId),
    inArray(heartbeatRunEvents.eventType, ["transcript.entry", "transcript.run"]),
  ));
  const allowedEvents = transcriptEventIdentities(proof);
  if (transcriptEvents.some((event: { payload: unknown }) => !hasExactTranscriptEventIdentity(event.payload, allowedEvents))) {
    return null;
  }
  const invocationEvents = await tx.select().from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.orgId, proof.orgId),
    eq(heartbeatRunEvents.runId, proof.runId),
    eq(heartbeatRunEvents.eventType, "adapter.invoke"),
  ));
  for (const event of invocationEvents) {
    const payload = record(event.payload);
    const hasRawInvocation = Boolean(payload && ("prompt" in payload || "agentInstructionStack" in payload || "context" in payload));
    const identityIsExact = nonEmpty(payload?.invocationSpanId)
      && nonEmpty(payload?.invocationAttemptId)
      && transcriptEventIdentities(proof).has(`${payload.invocationSpanId}:${payload.invocationAttemptId}`);
    if (hasRawInvocation && !identityIsExact) return null;
  }
  return { run, transcriptEvents, invocationEvents };
}

export async function cleanSealedNativeTranscriptMirrors(input: {
  db: Db;
  proof: NativeTranscriptRunProof;
  runLogStore: RunLogStore;
  transcriptObjectStore: TranscriptObjectStore;
  readerFactory: (database: Pick<Db, "select">) => TranscriptReader;
  retainResultJson: (value: Record<string, unknown> | null, spanId: string) => Record<string, unknown>;
  compactAdapterInvokePayload?: (payload: Record<string, unknown>) => Record<string, unknown>;
}): Promise<
  | { cleaned: true }
  | { cleaned: false; reason: string; recovery?: NativeTranscriptRecoveryLocation[] }
> {
  const stagedObjects: Array<{ span: NativeTranscriptSpanProof; stageId: string }> = [];
  let stagedRunLog: Awaited<ReturnType<NonNullable<RunLogStore["stageRunRemoval"]>>> | null = null;
  try {
    const committed = await input.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.proof.runId}))`);
      const prepared = await selectAndVerifyNativeTranscriptCleanupState(tx, input.proof);
      if (!prepared) throw new Error("cleanup_identity_mismatch");

      if (input.proof.spans.some((span) => span.supplementalObjectRef)
        && (!input.transcriptObjectStore.stageSealedRemoval
          || !input.transcriptObjectStore.restoreStagedRemoval
          || !input.transcriptObjectStore.purgeStagedRemoval)) {
        throw new Error("transcript_object_store_cannot_stage_removal");
      }
      if ((prepared.run.logRef || prepared.run.logStore)
        && (!input.runLogStore.stageRunRemoval
          || !input.runLogStore.restoreStagedRunRemoval
          || !input.runLogStore.purgeStagedRunRemoval)) {
        throw new Error("run_log_store_cannot_stage_removal");
      }

      for (const span of input.proof.spans) {
        if (!span.supplementalObjectRef) continue;
        const staged = await input.transcriptObjectStore.stageSealedRemoval!({
          objectRef: span.supplementalObjectRef,
          orgId: input.proof.orgId,
          runId: input.proof.runId,
          spanId: span.spanId,
          ownerToken: span.ownerToken,
          allowOwnerRecovery: true,
        });
        stagedObjects.push({ span, stageId: staged.stageId });
      }

      const run = prepared.run;
      if (run.logRef || run.logStore) {
        if (run.logStore !== "local_file" || !run.logRef || !run.logSha256) {
          throw new Error("run_log_identity_unavailable");
        }
        stagedRunLog = await input.runLogStore.stageRunRemoval!({
          orgId: input.proof.orgId,
          agentId: run.agentId,
          runId: input.proof.runId,
          handle: { store: run.logStore, logRef: run.logRef },
          expectedSha256: run.logSha256,
        });
      }

      const allowedInvocations = new Set(input.proof.spans.map((span) => `${span.spanId}:${span.attemptId}`));
      for (const event of prepared.invocationEvents) {
        const payload = record(event.payload);
        const identity: TranscriptEventIdentity | null = nonEmpty(payload?.invocationSpanId)
          && nonEmpty(payload?.invocationAttemptId)
          && allowedInvocations.has(`${payload.invocationSpanId}:${payload.invocationAttemptId}`)
          ? { spanId: payload.invocationSpanId, attemptId: payload.invocationAttemptId }
          : null;
        if (!identity) continue;
        if (!input.compactAdapterInvokePayload) throw new Error("adapter_invoke_compactor_unavailable");
        await tx.update(heartbeatRunEvents).set({
          payload: input.compactAdapterInvokePayload(payload!) as Record<string, unknown>,
        }).where(and(
          eq(heartbeatRunEvents.orgId, input.proof.orgId),
          eq(heartbeatRunEvents.runId, input.proof.runId),
          eq(heartbeatRunEvents.id, event.id),
        ));
      }

      if (prepared.transcriptEvents.length > 0) {
        await tx.delete(heartbeatRunEvents).where(and(
          eq(heartbeatRunEvents.orgId, input.proof.orgId),
          eq(heartbeatRunEvents.runId, input.proof.runId),
          inArray(heartbeatRunEvents.id, prepared.transcriptEvents.map((event: { id: number }) => event.id)),
        ));
      }
      const retained = input.retainResultJson(run.resultJson, input.proof.spans.at(-1)!.spanId);
      const context = record(run.contextSnapshot) ?? {};
      const cleanupLease = {
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      };
      const [updated] = await tx.update(heartbeatRuns).set({
        resultJson: retained,
        resultSummaryJson: summarizeHeartbeatRunResultJson(retained),
        logStore: null,
        logRef: null,
        stdoutExcerpt: null,
        stderrExcerpt: null,
        terminalEffectsJson: null,
        contextSnapshot: {
          ...context,
          nativeTranscriptRetention: {
            status: "cleanup_pending",
            itemCount: input.proof.itemCount,
            ...nativeTranscriptProofSnapshot(input.proof),
            recovery: recoveryLocations({ objects: stagedObjects, runLog: stagedRunLog }),
            proofedAt: new Date().toISOString(),
            cleanupLease,
          },
        },
        updatedAt: new Date(),
      }).where(and(
        eq(heartbeatRuns.orgId, input.proof.orgId),
        eq(heartbeatRuns.id, input.proof.runId),
        eq(heartbeatRuns.status, "succeeded"),
        isNull(heartbeatRuns.executionOwnerToken),
      )).returning({ id: heartbeatRuns.id });
      if (!updated) throw new Error("cleanup_run_identity_changed");

      for (const span of input.proof.spans) {
        const [cleared] = await tx.update(runRuntimeSpans).set({
          supplementalObjectRef: null,
          updatedAt: new Date(),
        }).where(and(
          eq(runRuntimeSpans.orgId, input.proof.orgId),
          eq(runRuntimeSpans.runId, input.proof.runId),
          eq(runRuntimeSpans.id, span.spanId),
          eq(runRuntimeSpans.ownerToken, span.ownerToken),
          eq(runRuntimeSpans.attemptEpoch, span.attemptEpoch),
          eq(runRuntimeSpans.attemptId, span.attemptId),
          eq(runRuntimeSpans.state, "sealed"),
        )).returning({ id: runRuntimeSpans.id });
        if (!cleared) throw new Error("cleanup_span_identity_changed");
      }

      const verificationReader = input.readerFactory(tx as unknown as Pick<Db, "select">);
      for (const span of input.proof.spans) {
        const verified = await readExactSpan(verificationReader, {
          orgId: input.proof.orgId,
          runId: input.proof.runId,
          spanId: span.spanId,
        });
        if (!verified || verified.sourceRevision !== span.sourceRevision || verified.itemCount !== span.itemCount) {
          throw new Error("post_cleanup_native_read_incomplete_or_changed");
        }
      }
      return true;
    });
    if (!committed) throw new Error("cleanup_transaction_not_committed");

    const purgeFailures: Array<{ message: string; recovery: NativeTranscriptRecoveryLocation }> = [];
    if (stagedRunLog) {
      try {
        await input.runLogStore.purgeStagedRunRemoval!(stagedRunLog);
      } catch (error) {
        purgeFailures.push({
          message: error instanceof Error ? error.message : "run_log_purge_failed",
          recovery: recoveryLocations({ objects: [], runLog: stagedRunLog })[0]!,
        });
      }
    }
    if (purgeFailures.length > 0) {
      purgeFailures.push(...stagedObjects.map((item) => ({
        message: "transcript_supplement_retained_until_run_log_cleanup",
        recovery: recoveryLocations({ objects: [item], runLog: null })[0]!,
      })));
      return {
        cleaned: false,
        reason: `staged_copy_purge_failed:${purgeFailures[0]!.message.slice(0, 180)}`,
        recovery: purgeFailures.map((failure) => failure.recovery),
      };
    }
    for (const item of stagedObjects) {
      try {
        await input.transcriptObjectStore.purgeStagedRemoval!({
          objectRef: item.span.supplementalObjectRef!,
          orgId: input.proof.orgId,
          runId: input.proof.runId,
          spanId: item.span.spanId,
          ownerToken: item.span.ownerToken,
          allowOwnerRecovery: true,
          stageId: item.stageId,
        });
      } catch (error) {
        purgeFailures.push({
          message: error instanceof Error ? error.message : "transcript_object_purge_failed",
          recovery: recoveryLocations({ objects: [item], runLog: null })[0]!,
        });
      }
    }
    if (purgeFailures.length > 0) {
      return {
        cleaned: false,
        reason: `staged_copy_purge_failed:${purgeFailures[0]!.message.slice(0, 180)}`,
        recovery: purgeFailures.map((failure) => failure.recovery),
      };
    }

    const finalizedProof: NativeTranscriptRunProof = {
      ...input.proof,
      spans: input.proof.spans.map((span) => ({ ...span, supplementalObjectRef: null })),
    };
    const markedReferenceOnly = await input.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.proof.runId}))`);
      const prepared = await selectAndVerifyNativeTranscriptCleanupState(tx, finalizedProof);
      if (!prepared) return false;
      const [updated] = await tx.update(heartbeatRuns).set({
        contextSnapshot: sql`jsonb_set(
          coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb),
          '{nativeTranscriptRetention}',
          (coalesce(${heartbeatRuns.contextSnapshot}->'nativeTranscriptRetention', '{}'::jsonb) - 'reason' - 'cleanupLease')
            || jsonb_build_object('status', 'reference_only', 'recovery', '[]'::jsonb, 'cleanedAt', ${new Date().toISOString()}::text),
          true
        )`,
        updatedAt: new Date(),
      }).where(and(
        eq(heartbeatRuns.orgId, input.proof.orgId),
        eq(heartbeatRuns.id, input.proof.runId),
        eq(heartbeatRuns.status, "succeeded"),
        isNull(heartbeatRuns.executionOwnerToken),
        sql`${heartbeatRuns.contextSnapshot}->'nativeTranscriptRetention'->>'status' = 'cleanup_pending'`,
      )).returning({ id: heartbeatRuns.id });
      return Boolean(updated);
    });
    if (!markedReferenceOnly) {
      return { cleaned: false, reason: "cleanup_completion_identity_changed", recovery: [] };
    }
    return { cleaned: true };
  } catch (error) {
    const restoreErrors: string[] = [];
    const recovery: NativeTranscriptRecoveryLocation[] = [];
    if (stagedRunLog && input.runLogStore.restoreStagedRunRemoval) {
      try {
        await input.runLogStore.restoreStagedRunRemoval(stagedRunLog);
      } catch (restoreError) {
        restoreErrors.push(restoreError instanceof Error ? restoreError.message : "run_log_restore_failed");
        recovery.push(...recoveryLocations({ objects: [], runLog: stagedRunLog }));
      }
    }
    for (const item of [...stagedObjects].reverse()) {
      if (!input.transcriptObjectStore.restoreStagedRemoval) break;
      try {
        await input.transcriptObjectStore.restoreStagedRemoval({
          objectRef: item.span.supplementalObjectRef!,
          orgId: input.proof.orgId,
          runId: input.proof.runId,
          spanId: item.span.spanId,
          ownerToken: item.span.ownerToken,
          allowOwnerRecovery: true,
          stageId: item.stageId,
        });
      } catch (restoreError) {
        restoreErrors.push(restoreError instanceof Error ? restoreError.message : "transcript_object_restore_failed");
        recovery.push(...recoveryLocations({ objects: [item], runLog: null }));
      }
    }
    return {
      cleaned: false,
      reason: [error instanceof Error ? error.message.slice(0, 180) : "cleanup_failed", ...restoreErrors]
        .join("; ").slice(0, 240),
      ...(recovery.length > 0 ? { recovery } : {}),
    };
  }
}

export async function markNativeTranscriptRetentionIncomplete(input: {
  db: Db;
  orgId: string;
  runId: string;
  reason: string;
  expectedOwner?: { spanId: string; ownerToken: string; attemptEpoch: number; attemptId?: string } | null;
  status?: "incomplete" | "cleanup_failed";
  recovery?: NativeTranscriptRecoveryLocation[];
  proof?: NativeTranscriptRunProof;
}) {
  const [run] = await input.db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.orgId, input.orgId),
    eq(heartbeatRuns.id, input.runId),
  )).limit(1);
  if (!run || !TERMINAL_STATUSES.has(run.status) || run.executionOwnerToken !== null) return false;
  if (input.expectedOwner) {
    const [span] = await input.db.select().from(runRuntimeSpans).where(and(
      eq(runRuntimeSpans.orgId, input.orgId),
      eq(runRuntimeSpans.runId, input.runId),
      eq(runRuntimeSpans.id, input.expectedOwner.spanId),
    )).limit(1);
    if (!span || span.ownerToken !== input.expectedOwner.ownerToken
      || span.attemptEpoch !== input.expectedOwner.attemptEpoch
      || (input.expectedOwner.attemptId && span.attemptId !== input.expectedOwner.attemptId)
      || span.state !== "sealed") return false;
  }
  const context = record(run.contextSnapshot) ?? {};
  const retention = record(context.nativeTranscriptRetention) ?? {};
  const attachedSupplements = input.recovery === undefined
    ? await input.db.select({ id: runRuntimeSpans.id, supplementalObjectRef: runRuntimeSpans.supplementalObjectRef })
      .from(runRuntimeSpans).where(and(
        eq(runRuntimeSpans.orgId, input.orgId),
        eq(runRuntimeSpans.runId, input.runId),
      ))
    : [];
  const attachedRecovery = attachedSupplements.flatMap((span) => span.supplementalObjectRef
    ? [{ kind: "transcript_supplement" as const, objectRef: span.supplementalObjectRef, spanId: span.id }]
    : []);
  const recovery = input.recovery
    ?? (attachedRecovery.length > 0
      ? attachedRecovery
      : Array.isArray(retention.recovery) ? retention.recovery as NativeTranscriptRecoveryLocation[] : undefined);
  const { cleanupLease: _cleanupLease, ...retentionWithoutLease } = retention;
  const retryCount = Number.isInteger(retention.retryCount) && Number(retention.retryCount) >= 0
    ? Number(retention.retryCount)
    : 0;
  const retryDelayMs = Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** Math.min(retryCount, 6));
  const [updated] = await input.db.update(heartbeatRuns).set({
    contextSnapshot: {
      ...context,
      nativeTranscriptRetention: {
        ...(input.status === "cleanup_failed" ? retentionWithoutLease : retention),
        status: input.status ?? "incomplete",
        reason: input.reason.slice(0, 240),
        ...(input.proof ? nativeTranscriptProofSnapshot(input.proof) : {}),
        ...(recovery !== undefined ? { recovery } : {}),
        ...(input.status === "cleanup_failed" ? {
          retryCount: retryCount + 1,
          retryAfter: new Date(Date.now() + retryDelayMs).toISOString(),
        } : {}),
      },
    },
    updatedAt: new Date(),
  }).where(and(
    eq(heartbeatRuns.orgId, input.orgId),
    eq(heartbeatRuns.id, input.runId),
    inArray(heartbeatRuns.status, [...TERMINAL_STATUSES]),
    isNull(heartbeatRuns.executionOwnerToken),
  )).returning({ id: heartbeatRuns.id });
  return Boolean(updated);
}
