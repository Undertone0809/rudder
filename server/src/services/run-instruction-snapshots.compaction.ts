import { heartbeatRunAttempts, runRuntimeSpans, type Db } from "@rudderhq/db";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { StorageService } from "../storage/types.js";
import { MAX_RUN_INSTRUCTION_SNAPSHOT_BYTES, RUN_INSTRUCTION_SNAPSHOT_NAMESPACE } from "./run-instruction-snapshots.js";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** New-event projection only. Never updates an event or removes any object.
 * Caller passes the final redacted inline payload, and retains its fenced append.
 * A snapshot proves only equal invocation text, not transcript supplements/logs. */
export async function compactReadableInstructionSnapshot(input: {
  db: Pick<Db, "select">;
  storage: Pick<StorageService, "getObject">;
  orgId: string;
  runId: string;
  attemptId: string | null;
  spanId: string | null;
  payload: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const original = { ...input.payload };
  // Only this owned readback can issue field references on a new event.
  delete original.invocationInstructionTextReference;
  delete original.invocationPromptReference;
  const locator = record(original.invocationInstructionSnapshot);
  // No available snapshot means the caller must retain its inline fallback.
  if (locator?.status !== "available") return original;
  const fallback = (reason: string) => ({ ...original,
    invocationInstructionSnapshot: { ...locator, status: "unavailable", reason },
  });
  const sha256 = locator.sha256;
  const bytes = locator.byteSize;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
  if (![input.orgId, input.runId, input.attemptId, input.spanId].every(id => typeof id === "string" && uuid.test(id))
    || !input.attemptId || !input.spanId || !input.runId
    || original.invocationAttemptId !== input.attemptId || original.invocationSpanId !== input.spanId
    || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256)
    || !Number.isSafeInteger(bytes) || (bytes as number) <= 0 || (bytes as number) > MAX_RUN_INSTRUCTION_SNAPSHOT_BYTES
    || locator.objectKey !== `${input.orgId}/${RUN_INSTRUCTION_SNAPSHOT_NAMESPACE}/${sha256}`) {
    return fallback("snapshot_identity_invalid");
  }
  const { attemptId, spanId, orgId, runId } = input;
  let expired = false;
  const expiresAt = performance.now() + 5_000;
  const isExpired = () => expired || performance.now() >= expiresAt;
  let stream: Readable | undefined;
  let timeout: ReturnType<typeof setTimeout>;
  // The optional proof has one budget, including DB and object acquisition.
  // Those APIs cannot be cancelled here; observe their eventual settlement and
  // prevent an expired worker from starting further IO or minting references.
  const deadline = new Promise<Record<string, unknown>>(resolve => {
    timeout = setTimeout(() => {
      expired = true;
      stream?.once("error", () => undefined);
      stream?.destroy();
      resolve(fallback("snapshot_readback_unavailable"));
    }, 5_000);
    timeout.unref();
  });
  const verify = async () => {
    try {
      const [attempt] = await input.db.select({ id: heartbeatRunAttempts.id, orgId: heartbeatRunAttempts.orgId, runId: heartbeatRunAttempts.runId })
        .from(heartbeatRunAttempts).where(and(eq(heartbeatRunAttempts.id, attemptId),
          eq(heartbeatRunAttempts.orgId, orgId), eq(heartbeatRunAttempts.runId, runId))).limit(1);
      if (isExpired()) return fallback("snapshot_readback_unavailable");
      const [span] = await input.db.select({ id: runRuntimeSpans.id, orgId: runRuntimeSpans.orgId,
        runId: runRuntimeSpans.runId, attemptId: runRuntimeSpans.attemptId })
        .from(runRuntimeSpans).where(and(eq(runRuntimeSpans.id, spanId), eq(runRuntimeSpans.orgId, orgId),
          eq(runRuntimeSpans.runId, runId), eq(runRuntimeSpans.attemptId, attemptId))).limit(1);
      if (isExpired()) return fallback("snapshot_readback_unavailable");
      if (attempt?.id !== attemptId || attempt.orgId !== orgId || attempt.runId !== runId
        || span?.id !== spanId || span.orgId !== orgId || span.runId !== runId || span.attemptId !== attemptId) {
        return fallback("snapshot_run_linkage_invalid");
      }
      const stored = await input.storage.getObject(orgId, locator.objectKey as string);
      stream = stored.stream;
      try {
        if (isExpired()) return fallback("snapshot_readback_unavailable");
        const chunks: Buffer[] = [];
        let total = 0;
        const hash = createHash("sha256");
        for await (const chunk of stored.stream) {
          if (isExpired()) return fallback("snapshot_readback_unavailable");
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buffer.length;
          if (total > (bytes as number)) return fallback("snapshot_size_mismatch");
          hash.update(buffer);
          chunks.push(buffer);
        }
        if (isExpired()) return fallback("snapshot_readback_unavailable");
        if (total !== bytes) return fallback("snapshot_size_mismatch");
        if (hash.digest("hex") !== sha256) return fallback("snapshot_digest_mismatch");
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
        catch { return fallback("snapshot_utf8_invalid"); }

        const stack = original.agentInstructionStack;
        const alias = record(original.agentInstructionStackAlias);
        const aliased = !Object.hasOwn(original, "agentInstructionStack")
          && alias?.present === true && alias.sameAsPrompt === true
          && alias.textSource === "persisted_prompt" && alias.equality === "nonempty_sanitized_exact";
        const inlineInstructions = typeof stack === "string" ? stack : aliased ? original.prompt : undefined;
        // Strict string equality also preserves newlines/Unicode; no normalization,
        // substring matching, digest-only equivalence, or guessed absent Instructions.
        if (typeof inlineInstructions !== "string" || inlineInstructions.length === 0 || inlineInstructions !== text) {
          return fallback("snapshot_inline_not_equivalent");
        }
        if (isExpired()) return fallback("snapshot_readback_unavailable");
        const projected = { ...original };
        const reference = { present: true, source: "stored_snapshot", via: "invocation-instructions",
          field: "agentInstructionStack", sha256, byteSize: bytes };
        delete projected.agentInstructionStack;
        projected.invocationInstructionTextReference = reference;
        if (typeof original.prompt === "string" && original.prompt === text) {
          delete projected.prompt;
          projected.invocationPromptReference = { ...reference, sameAsInstructions: true };
        }
        return projected;
      } finally {
        // A late-acquired stream was never iterated, so it needs its own error
        // observer while closing; asynchronous close errors cannot escape.
        stored.stream.once("error", () => undefined);
        stored.stream.destroy();
      }
    } catch {
      return fallback("snapshot_readback_unavailable");
    }
  };
  try {
    return await Promise.race([verify(), deadline]);
  } finally {
    clearTimeout(timeout!);
  }
}
