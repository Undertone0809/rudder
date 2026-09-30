import { isUuidLike, type HeartbeatRunEvent } from "@rudderhq/shared";
import { badRequest } from "../errors.js";

interface RunSummaryCursor {
  createdAt: string;
  id: string;
}

interface RunEventCursor {
  seq: number;
  id: number;
}

export function encodeRunSummaryCursor(row: { createdAt: Date; id: string }) {
  return Buffer.from(JSON.stringify({
    createdAt: row.createdAt.toISOString(),
    id: row.id,
  } satisfies RunSummaryCursor), "utf8").toString("base64url");
}

export function decodeRunSummaryCursor(value: string): { createdAt: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<RunSummaryCursor>;
    const createdAt = typeof parsed.createdAt === "string" ? new Date(parsed.createdAt) : null;
    if (
      !createdAt
      || Number.isNaN(createdAt.getTime())
      || typeof parsed.id !== "string"
      || !isUuidLike(parsed.id)
    ) {
      throw new Error("invalid cursor payload");
    }
    return { createdAt, id: parsed.id };
  } catch {
    throw badRequest("Invalid run summary cursor.");
  }
}

export function encodeRunEventCursor(row: Pick<HeartbeatRunEvent, "seq" | "id">) {
  return Buffer.from(JSON.stringify({ seq: row.seq, id: row.id } satisfies RunEventCursor), "utf8").toString("base64url");
}

export function decodeRunEventCursor(value: string): RunEventCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<RunEventCursor>;
    if (
      typeof parsed.seq !== "number"
      || !Number.isSafeInteger(parsed.seq)
      || parsed.seq < 0
      || typeof parsed.id !== "number"
      || !Number.isSafeInteger(parsed.id)
      || parsed.id < 0
    ) {
      throw new Error("invalid cursor payload");
    }
    return { seq: parsed.seq, id: parsed.id };
  } catch {
    throw badRequest("Invalid run event cursor.");
  }
}
