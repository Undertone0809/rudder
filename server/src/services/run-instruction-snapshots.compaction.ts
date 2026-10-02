import { heartbeatRunAttempts, runRuntimeSpans, type Db } from "@rudderhq/db";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { StorageService } from "../storage/types.js";
import { MAX_RUN_INSTRUCTION_SNAPSHOT_BYTES, RUN_INSTRUCTION_SNAPSHOT_NAMESPACE } from "./run-instruction-snapshots.js";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Consistency check for the persisted producer projection, NOT a new physical
 * readback or authorization proof. Invalid metadata never licenses deletion. */
export function readConsistentStoredInstructionSummary(payload: Record<string, unknown>): Record<string, unknown> | null {
  const locator = record(payload.invocationInstructionSnapshot);
  const reference = record(payload.invocationInstructionTextReference);
  const summary = record(payload.invocationContent);
  const stack = record(summary?.agentInstructionStack);
  const prompt = record(summary?.prompt);
  const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
  const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
  const size = (value: unknown, allowZero = false) => Number.isSafeInteger(value) && (value as number) >= (allowZero ? 0 : 1);
  const inline = typeof payload.prompt === "string" || typeof payload.agentInstructionStack === "string";
  const sameObject = (ref: Record<string, unknown>) => ref.present === true && ref.source === "stored_snapshot"
    && ref.via === "invocation-instructions" && ref.sha256 === locator?.sha256 && ref.byteSize === locator?.byteSize;
  const metrics = (value: Record<string, unknown>, digest: unknown, bytes: unknown, allowZero = false) => value.present === true
    && value.sanitizedSha256 === digest && value.sanitizedUtf8ByteLength === bytes
    && size(value.sanitizedCharacterLength, allowZero) && (value.sanitizedCharacterLength as number) <= (bytes as number);
  if (!locator || !reference || !summary || !stack || !prompt || locator.status !== "available"
    || !hash(locator.sha256) || !size(locator.byteSize) || (locator.byteSize as number) > MAX_RUN_INSTRUCTION_SNAPSHOT_BYTES
    || typeof locator.objectKey !== "string"
    || !new RegExp(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/${RUN_INSTRUCTION_SNAPSHOT_NAMESPACE}/${locator.sha256}$`, "u").test(locator.objectKey)
    || ![payload.invocationAttemptId, payload.invocationSpanId].every(id => typeof id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id))
    || !sameObject(reference) || reference.field !== "agentInstructionStack" || Object.hasOwn(payload, "agentInstructionStack")
    || !keys(reference, ["present", "source", "via", "field", "sha256", "byteSize"])
    || summary.textSource !== "stored_snapshot" || summary.snapshotTextStored !== true || summary.textStored !== inline
    || !keys(summary, ["textSource", "snapshotTextStored", "textStored", "prompt", "agentInstructionStack"])
    || !metrics(stack, locator.sha256, locator.byteSize)
    || !keys(stack, ["present", "sanitizedSha256", "sanitizedUtf8ByteLength", "sanitizedCharacterLength", "sameAsPrompt",
      "sourceCharacterLength", "sourceUtf8ByteLength", "sanitizedForPersistence", "textSource", "equality"])
    || prompt.inline !== Object.hasOwn(payload, "prompt")
    || !keys(prompt, ["present", "inline", "sanitizedSha256", "sanitizedUtf8ByteLength", "sanitizedCharacterLength"])) return null;
  if (Object.hasOwn(payload, "agentInstructionStackAlias") !== (stack.textSource !== undefined)) return null;
  if (stack.textSource !== undefined) {
    const alias = record(payload.agentInstructionStackAlias);
    if (!alias || stack.textSource !== "persisted_prompt" || stack.equality !== "nonempty_sanitized_exact"
      || stack.sameAsPrompt !== true || typeof stack.sanitizedForPersistence !== "boolean"
      || !size(stack.sourceCharacterLength) || !size(stack.sourceUtf8ByteLength)
      || Object.keys(stack).some(key => stack[key] !== alias[key])) return null;
  } else if ([stack.sourceCharacterLength, stack.sourceUtf8ByteLength, stack.sanitizedForPersistence, stack.equality].some(value => value !== undefined)) return null;
  if (Object.hasOwn(payload, "invocationPromptReference")) {
    const ref = record(payload.invocationPromptReference);
    if (!ref || !sameObject(ref) || ref.field !== "prompt" || Object.hasOwn(payload, "prompt")) return null;
    if (ref.sameAsInstructions === true) {
      if (!keys(ref, ["present", "source", "via", "field", "sha256", "byteSize", "sameAsInstructions"])
        || stack.sameAsPrompt !== true || !metrics(prompt, locator.sha256, locator.byteSize)
        || prompt.sanitizedCharacterLength !== stack.sanitizedCharacterLength) return null;
    } else if (ref.sameAsInstructions !== undefined || stack.sameAsPrompt !== undefined
      || !keys(ref, ["present", "source", "via", "field", "sha256", "byteSize", "byteStart", "byteLength", "rangeSha256"])
      || !size(ref.byteStart, true) || !size(ref.byteLength) || !hash(ref.rangeSha256)
      || (ref.byteStart as number) + (ref.byteLength as number) > (locator.byteSize as number)
      || !metrics(prompt, ref.rangeSha256, ref.byteLength)) return null;
  } else {
    if (stack.sameAsPrompt !== undefined) return null;
    if (typeof payload.prompt === "string") {
      if (!metrics(prompt, createHash("sha256").update(payload.prompt, "utf8").digest("hex"), Buffer.byteLength(payload.prompt, "utf8"), true)
        || prompt.sanitizedCharacterLength !== payload.prompt.length) return null;
    } else if (prompt.present !== false || !keys(prompt, ["present", "inline"])) return null;
  }
  return summary;
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
  /** Same monotonic absolute deadline as the caller's optional snapshot store. */
  deadlineAt?: number;
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
  const now = performance.now();
  if (input.deadlineAt !== undefined && (!Number.isFinite(input.deadlineAt) || input.deadlineAt <= now)) {
    return fallback("snapshot_readback_unavailable");
  }
  const expiresAt = Math.min(input.deadlineAt ?? now + 5_000, now + 5_000);
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
    }, Math.max(0, expiresAt - performance.now()));
    timeout.unref();
  });
  const verify = async () => {
    try {
      if (isExpired()) return fallback("snapshot_readback_unavailable");
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
          projected.invocationPromptReference = { ...reference, field: "prompt", sameAsInstructions: true };
        } else if (typeof original.prompt === "string" && original.prompt.length > 0) {
          const body = Buffer.concat(chunks);
          const promptBytes = Buffer.from(original.prompt, "utf8");
          const start = body.indexOf(promptBytes);
          // Only one complete byte occurrence can stand for the debug input.
          // No substring normalization or text-hash identity; ambiguous matches
          // retain their original inline field.
          if (start >= 0 && body.indexOf(promptBytes, start + 1) === -1
            && new TextDecoder("utf-8", { fatal: true }).decode(promptBytes) === original.prompt) {
            new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(0, start));
            new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(start + promptBytes.length));
            delete projected.prompt;
            projected.invocationPromptReference = { ...reference, field: "prompt", byteStart: start,
              byteLength: promptBytes.length, rangeSha256: createHash("sha256").update(promptBytes).digest("hex") };
          }
        }
        const summarize = (value: unknown) => typeof value === "string" ? {
          present: true, sanitizedCharacterLength: value.length, sanitizedUtf8ByteLength: Buffer.byteLength(value, "utf8"),
          sanitizedSha256: createHash("sha256").update(value, "utf8").digest("hex"),
        } : { present: false };
        projected.invocationContent = { textStored: typeof projected.prompt === "string" || typeof projected.agentInstructionStack === "string",
          textSource: "stored_snapshot", snapshotTextStored: true,
          prompt: { ...summarize(original.prompt), inline: Object.hasOwn(projected, "prompt") },
          agentInstructionStack: { ...(aliased ? alias : {}), ...summarize(text),
            ...(original.prompt === text ? { sameAsPrompt: true } : {}) } };
        return isExpired() ? fallback("snapshot_readback_unavailable") : projected;
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
