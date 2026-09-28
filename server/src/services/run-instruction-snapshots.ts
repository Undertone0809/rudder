import {
  heartbeatRunAttempts,
  heartbeatRunEvents,
  runRuntimeSpans,
  type Db,
} from "@rudderhq/db";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { ContentAddressedStorageService, StorageService } from "../storage/types.js";

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

export async function storeRunInstructionSnapshot(input: {
  storage: ContentAddressedStorageService;
  orgId: string;
  text: string;
}): Promise<RunInstructionSnapshotLocator> {
  const body = Buffer.from(input.text, "utf8");
  if (body.length === 0 || body.length > MAX_RUN_INSTRUCTION_SNAPSHOT_BYTES) {
    throw new Error("Instruction snapshot size is unsupported");
  }
  const stored = await input.storage.putContentAddressedFile({
    orgId: input.orgId,
    namespace: RUN_INSTRUCTION_SNAPSHOT_NAMESPACE,
    originalFilename: null,
    contentType: "text/plain; charset=utf-8",
    body,
  });
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
}): Promise<{ agentInstructionStack: string; sha256: string; byteSize: number } | null> {
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

  if (locator?.status !== "available" || !attemptId || !spanId || !objectKey || !sha256 || !/^[a-f0-9]{64}$/u.test(sha256)
    || !Number.isSafeInteger(byteSize) || (byteSize as number) <= 0
    || (byteSize as number) > MAX_RUN_INSTRUCTION_SNAPSHOT_BYTES
    || objectKey !== `${input.orgId}/${RUN_INSTRUCTION_SNAPSHOT_NAMESPACE}/${sha256}`) {
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

  const stored = await input.storage.getObject(input.orgId, objectKey);
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
    return {
      agentInstructionStack: new TextDecoder("utf-8", { fatal: true }).decode(body),
      sha256,
      byteSize: byteSize as number,
    };
  } catch {
    return null;
  }
}
