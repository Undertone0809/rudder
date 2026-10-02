import {
  heartbeatRunAttempts,
  heartbeatRunEvents,
  heartbeatRuns,
  nativeSegments,
  runRuntimeSpans,
  runtimeBindings,
  type Db,
} from "@rudderhq/db";
import type { RecoveredRunDeveloperInstructions } from "@rudderhq/shared";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import path from "node:path";
import { resolveOrganizationRoot, resolveRudderInstanceRoot } from "../home-paths.js";
import type { ContentAddressedStorageService, StorageService } from "../storage/types.js";
import { recoverCodexDeveloperInstructions } from "./run-instruction-recovery.js";

export const RUN_INSTRUCTION_SNAPSHOT_NAMESPACE = "run-instruction-snapshots";
export const MAX_RUN_INSTRUCTION_SNAPSHOT_BYTES = 16 * 1024 * 1024;

export interface RunInstructionSnapshotLocator {
  objectKey: string;
  sha256: string;
  byteSize: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Recovery never replaces an available (even unreadable) snapshot. Historical
 * binding, profile, attempt and native turn must agree before touching disk. */
export async function readRecoveredRunDeveloperInstructions(input: {
  db: Db;
  orgId: string;
  runId: string;
  eventId: number;
}): Promise<RecoveredRunDeveloperInstructions | null> {
  const [event] = await input.db.select({ payload: heartbeatRunEvents.payload })
    .from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.id, input.eventId), eq(heartbeatRunEvents.orgId, input.orgId),
      eq(heartbeatRunEvents.runId, input.runId), eq(heartbeatRunEvents.eventType, "adapter.invoke"),
    )).limit(1);
  const payload = asRecord(event?.payload);
  if (!payload || asRecord(payload.invocationInstructionSnapshot)?.status === "available"
    || payload.agentRuntimeType !== "codex_local"
    || typeof payload.invocationAttemptId !== "string" || typeof payload.invocationSpanId !== "string") return null;
  const [row] = await input.db.select({
    agentId: heartbeatRuns.agentId, context: heartbeatRuns.contextSnapshot,
    attempt: heartbeatRunAttempts,
    binding: runtimeBindings, segment: nativeSegments, span: runRuntimeSpans,
  }).from(heartbeatRuns)
    .innerJoin(runRuntimeSpans, and(eq(runRuntimeSpans.runId, heartbeatRuns.id), eq(runRuntimeSpans.orgId, heartbeatRuns.orgId)))
    .innerJoin(heartbeatRunAttempts, and(eq(heartbeatRunAttempts.id, runRuntimeSpans.attemptId),
      eq(heartbeatRunAttempts.runId, heartbeatRuns.id), eq(heartbeatRunAttempts.orgId, heartbeatRuns.orgId)))
    .innerJoin(runtimeBindings, and(eq(runtimeBindings.id, runRuntimeSpans.bindingId), eq(runtimeBindings.orgId, heartbeatRuns.orgId)))
    .innerJoin(nativeSegments, and(eq(nativeSegments.id, runRuntimeSpans.segmentId),
      eq(nativeSegments.bindingId, runtimeBindings.id), eq(nativeSegments.orgId, heartbeatRuns.orgId)))
    .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.orgId, input.orgId),
      eq(runRuntimeSpans.id, payload.invocationSpanId), eq(heartbeatRunAttempts.id, payload.invocationAttemptId)))
    .limit(1);
  if (!row) return null;
  const context = asRecord(row.context);
  const admission = asRecord(context?.unifiedAgentRun);
  // Incoming session intent describes the previous turn's instructions. Only
  // this exact completed Attempt can attest the revision used by this turn.
  // The Segment's provider state may already describe a later continuation.
  const params = asRecord(row.attempt.sessionParamsJson);
  const profile = asRecord(context?.runtimeProviderProfile);
  const selector = asRecord(row.span.selectorJson);
  const revision = params?.rudderChatDeveloperInstructionsRevision;
  if (row.binding.agentId !== row.agentId || row.binding.runtimeType !== "codex_local"
    || row.binding.continuity !== "native" || row.binding.hostId !== "local"
    || row.segment.runtimeType !== "codex_local" || row.span.relation === "native_subagent"
    || row.attempt.agentId !== row.agentId || row.attempt.runtimeType !== "codex_local"
    || !row.attempt.finishedAt || !["succeeded", "failed", "cancelled", "timed_out"].includes(row.attempt.status)
    || row.attempt.submissionPhase !== "accepted"
    || admission?.runtimeBindingId !== row.binding.id || admission.runtimeSegmentId !== row.segment.id
    || context?.runtimeBindingId !== row.binding.id || context.runtimeSegmentId !== row.segment.id
    || admission.runtimeType !== "codex_local" || admission.agentId !== row.agentId
    || params?.transport !== "codex_app_server" || params.profileOrgId !== input.orgId
    || params.profileBindingId !== row.binding.id || params.profileHostId !== row.binding.hostId
    || params.profileId !== row.binding.profileId || params.workspaceBindingId !== row.binding.workspaceBindingId
    || params.capabilityRevision !== row.binding.capabilityRevision
    || selector?.kind !== "codex_turn" || selector.runId !== input.runId
    || selector.threadId !== row.segment.nativeSessionId
    || row.attempt.providerThreadId !== selector.threadId || row.attempt.providerTurnId !== selector.turnId
    || params.threadId !== selector.threadId || params.sessionId !== selector.threadId
    || typeof selector.threadId !== "string" || typeof selector.turnId !== "string"
    || profile?.runtimeType !== "codex_local" || typeof profile.codexHome !== "string"
    || typeof revision !== "string") return null;
  const recovered = await recoverCodexDeveloperInstructions({
    managedRoot: resolveRudderInstanceRoot(),
    managedHome: path.join(resolveOrganizationRoot(input.orgId), "codex-home", "agents", row.agentId),
    persistedHome: profile.codexHome,
    sessionId: selector.threadId, turnId: selector.turnId, sha256: revision,
  });
  if (!recovered) return null;
  return {
    source: "codex_native_rollout", completeness: "partial", snapshotStatus: "missing",
    developerInstructions: recovered.text, sha256: recovered.sha256, byteSize: recovered.byteSize,
    spanId: row.span.id, sessionId: selector.threadId, turnId: selector.turnId,
  };
}

export async function storeRunInstructionSnapshot(input: {
  storage: ContentAddressedStorageService;
  orgId: string;
  text: string;
  /** Optional monotonic absolute deadline shared with readback proof. */
  deadlineAt?: number;
}): Promise<RunInstructionSnapshotLocator> {
  const body = Buffer.from(input.text, "utf8");
  if (body.length === 0 || body.length > MAX_RUN_INSTRUCTION_SNAPSHOT_BYTES) {
    throw new Error("Instruction snapshot size is unsupported");
  }
  const remaining = input.deadlineAt === undefined ? null : input.deadlineAt - performance.now();
  if (remaining !== null && (!Number.isFinite(remaining) || remaining <= 0)) {
    throw new Error("Instruction snapshot store deadline expired");
  }
  const storing = input.storage.putContentAddressedFile({
    orgId: input.orgId,
    namespace: RUN_INSTRUCTION_SNAPSHOT_NAMESPACE,
    originalFilename: null,
    contentType: "text/plain; charset=utf-8",
    body,
  });
  // Storage may settle after timeout. Promise.race observes late rejection;
  // no late locator escapes this invocation and late objects are not deleted.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stored: Awaited<typeof storing>;
  try {
    stored = remaining === null ? await storing : await Promise.race([
      storing,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Instruction snapshot store deadline expired")),
          Math.max(0, input.deadlineAt! - performance.now()));
        timer.unref();
      }),
    ]);
    if (input.deadlineAt !== undefined && performance.now() >= input.deadlineAt) {
      throw new Error("Instruction snapshot store deadline expired");
    }
  } finally { if (timer) clearTimeout(timer); }
  return {
    objectKey: stored.objectKey,
    sha256: stored.sha256,
    byteSize: stored.byteSize,
  };
}

export async function readRunInstructionSnapshotForEvent(input: {
  db: Db;
  storage: StorageService;
  orgId: string;
  runId: string;
  eventId: number;
}): Promise<{ source?: "persisted_invocation_inline"; agentInstructionStack: string; prompt?: string; sha256: string; byteSize: number } | null> {
  const [event] = await input.db
    .select({ payload: heartbeatRunEvents.payload })
    .from(heartbeatRunEvents)
    .where(and(
      eq(heartbeatRunEvents.id, input.eventId),
      eq(heartbeatRunEvents.orgId, input.orgId),
      eq(heartbeatRunEvents.runId, input.runId),
      eq(heartbeatRunEvents.eventType, "adapter.invoke"),
    ))
    .limit(1);
  const payload = asRecord(event?.payload);
  const locator = asRecord(payload?.invocationInstructionSnapshot);
  const attemptId = typeof payload?.invocationAttemptId === "string" ? payload.invocationAttemptId : null;
  const spanId = typeof payload?.invocationSpanId === "string" ? payload.invocationSpanId : null;
  const objectKey = typeof locator?.objectKey === "string" ? locator.objectKey : null;
  const sha256 = typeof locator?.sha256 === "string" ? locator.sha256 : null;
  const byteSize = locator?.byteSize;
  const alias = asRecord(payload?.agentInstructionStackAlias);
  const prompt = payload?.prompt;
  // Historical aliases are evidence about final persisted bytes, not a guess
  // that every absent stack is equal to its prompt. Broken available snapshots
  // must never be replaced with a different source.
  const inline = locator?.status !== "available" && payload && !Object.hasOwn(payload, "agentInstructionStack")
    && typeof prompt === "string" && prompt.length > 0
    && alias?.present === true && alias.sameAsPrompt === true
    && alias.textSource === "persisted_prompt" && alias.equality === "nonempty_sanitized_exact"
    && typeof alias.sanitizedForPersistence === "boolean"
    && [alias.sourceCharacterLength, alias.sourceUtf8ByteLength, alias.sanitizedCharacterLength, alias.sanitizedUtf8ByteLength]
      .every(length => Number.isSafeInteger(length) && (length as number) > 0)
    && alias.sanitizedCharacterLength === prompt.length
    && alias.sanitizedUtf8ByteLength === Buffer.byteLength(prompt, "utf8")
    && alias.sanitizedUtf8ByteLength <= MAX_RUN_INSTRUCTION_SNAPSHOT_BYTES
    && Buffer.from(prompt, "utf8").toString("utf8") === prompt
    && alias.sanitizedSha256 === createHash("sha256").update(prompt, "utf8").digest("hex");

  if (!attemptId || !spanId || (!inline && (locator?.status !== "available" || !objectKey || !sha256 || !/^[a-f0-9]{64}$/u.test(sha256)
    || !Number.isSafeInteger(byteSize) || (byteSize as number) <= 0
    || (byteSize as number) > MAX_RUN_INSTRUCTION_SNAPSHOT_BYTES
    || objectKey !== `${input.orgId}/${RUN_INSTRUCTION_SNAPSHOT_NAMESPACE}/${sha256}`))) {
    return null;
  }

  const [attempt] = await input.db
    .select({ id: heartbeatRunAttempts.id })
    .from(heartbeatRunAttempts)
    .where(and(
      eq(heartbeatRunAttempts.id, attemptId),
      eq(heartbeatRunAttempts.orgId, input.orgId),
      eq(heartbeatRunAttempts.runId, input.runId),
    ))
    .limit(1);
  if (!attempt) return null;

  const [span] = await input.db
    .select({ id: runRuntimeSpans.id })
    .from(runRuntimeSpans)
    .where(and(
      eq(runRuntimeSpans.id, spanId),
      eq(runRuntimeSpans.orgId, input.orgId),
      eq(runRuntimeSpans.runId, input.runId),
      eq(runRuntimeSpans.attemptId, attemptId),
    ))
    .limit(1);
  if (!span) return null;
  if (inline) return { source: "persisted_invocation_inline", agentInstructionStack: prompt as string,
    prompt: prompt as string, sha256: alias!.sanitizedSha256 as string, byteSize: alias!.sanitizedUtf8ByteLength as number };

  const stored = await input.storage.getObject(input.orgId, objectKey!);
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of stored.stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > (byteSize as number)) return null;
    chunks.push(buffer);
  }
  if (totalBytes !== byteSize) return null;

  const body = Buffer.concat(chunks);
  const actualSha256 = createHash("sha256").update(body).digest("hex");
  if (actualSha256 !== sha256) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    const reference = asRecord(payload?.invocationPromptReference);
    // A non-contained/ambiguous prompt is deliberately retained in this same
    // authorized event. Expose its exact text too; a range reference never
    // substitutes for an unverified or missing field.
    let restoredPrompt = typeof payload?.prompt === "string" ? payload.prompt : undefined;
    if (reference) {
      if (reference.source !== "stored_snapshot" || reference.sha256 !== sha256 || reference.byteSize !== byteSize) return null;
      if (reference.sameAsInstructions === true) restoredPrompt = text;
      else {
        const start = reference.byteStart;
        const length = reference.byteLength;
        if (reference.field !== "prompt" || !Number.isSafeInteger(start) || !Number.isSafeInteger(length)
          || (start as number) < 0 || (length as number) <= 0 || (start as number) + (length as number) > body.length) return null;
        const range = body.subarray(start as number, (start as number) + (length as number));
        if (createHash("sha256").update(range).digest("hex") !== reference.rangeSha256) return null;
        // Decode both surrounding regions too: a byte slice must not start or
        // end inside a UTF-8 codepoint, even if its digest was copied correctly.
        new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(0, start as number));
        new TextDecoder("utf-8", { fatal: true }).decode(body.subarray((start as number) + (length as number)));
        restoredPrompt = new TextDecoder("utf-8", { fatal: true }).decode(range);
      }
    }
    return {
      agentInstructionStack: text,
      ...(restoredPrompt === undefined ? {} : { prompt: restoredPrompt }),
      sha256,
      byteSize: byteSize as number,
    };
  } catch {
    return null;
  }
}
