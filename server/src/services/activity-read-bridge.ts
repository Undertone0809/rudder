import type { Db } from "@rudderhq/db";
import { sql } from "drizzle-orm";
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import { badRequest, HttpError } from "../errors.js";
import type { ActivityFilters } from "./activity.js";
import { createRustActorEnvelope, type RustFoundationActor, type RustFoundationBridge, type RustFoundationResponse } from "./rust-foundation-bridge.js";

type ActivityCursor = { createdAt: string; id: string };
export type ActivityReadInput = Omit<ActivityFilters, "orgId"> & {
  operation: "list" | "list-page" | "issue"; issueId?: string; limit?: number; cursor?: ActivityCursor | null; legacyDateTimezone?: string;
};

/** Retain the public Node Buffer/Date parser, including accepted base64 variants.
 * Only transport validation remains here; native code owns paging and selection. */
export function activityListReadInput(filters: Omit<ActivityFilters, "orgId">, limit: number | undefined,
  rawCursor: string | undefined): ActivityReadInput {
  if (limit === undefined && rawCursor === undefined) return { operation: "list", ...filters };
  if (limit !== undefined && (limit < 1 || limit > 100)) throw badRequest("'limit' must be between 1 and 100");
  let cursor: ActivityCursor | null = null;
  if (rawCursor) {
    try {
      const value = JSON.parse(Buffer.from(rawCursor, "base64url").toString("utf8"));
      if (typeof value?.id !== "string" || typeof value?.createdAt !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id)
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.createdAt)
        || Number.isNaN(new Date(value.createdAt).getTime())) throw new Error("Invalid cursor");
      cursor = { createdAt: value.createdAt, id: value.id };
    } catch { throw badRequest("Activity cursor is invalid or expired"); }
  }
  return { operation: "list-page", ...filters, limit: limit ?? 30, cursor };
}

export async function requestActivityRead(baseUrl: string, secret: string, timeoutMs: number,
  actor: RustFoundationActor, orgId: string, input: ActivityReadInput): Promise<RustFoundationResponse> {
  const requestPath = `/internal/orgs/${encodeURIComponent(orgId)}/activity-reads`;
  const body = Buffer.from(JSON.stringify(input), "utf8"), requestId = randomUUID();
  const envelope = createRustActorEnvelope({ actor, organizationId: orgId, method: "POST", path: requestPath,
    action: "activity.read", body, secret, requestId });
  const response = await fetch(`${baseUrl}${requestPath}`, { method: "POST", body: body as unknown as BodyInit,
    headers: { "content-type": "application/json", "x-rudder-actor-envelope": JSON.stringify(envelope), "x-rudder-request-id": requestId },
    signal: AbortSignal.timeout(timeoutMs) });
  return { status: response.status, contentType: response.headers.get("content-type") ?? "application/json",
    body: Buffer.from(await response.arrayBuffer()) };
}

export async function sendActivityRead(db: Db, res: Response, bridge: RustFoundationBridge | undefined,
  actor: RustFoundationActor, orgId: string, input: ActivityReadInput): Promise<void> {
  if (!bridge?.activityRead) throw new HttpError(503, "Rust Activity reads are unavailable");
  let response;
  try {
    // Connection metadata only. All activity rows and public JSON stay native.
    const [context] = await db.execute(sql<{ timezone: string }>`SELECT current_setting('TimeZone') AS timezone`);
    if (typeof context?.timezone !== "string") throw new Error("Missing database date context");
    response = await bridge.activityRead(actor, orgId, { ...input, legacyDateTimezone: context.timezone });
  } catch { throw new HttpError(503, "Rust Activity reads are unavailable"); }
  res.status(response.status).type(response.contentType).send(response.body);
}
