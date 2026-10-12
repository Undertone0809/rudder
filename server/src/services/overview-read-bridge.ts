import type { Db } from "@rudderhq/db";
import { sql } from "drizzle-orm";
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import { HttpError } from "../errors.js";
import { createRustActorEnvelope, type RustFoundationActor, type RustFoundationBridge, type RustFoundationResponse } from "./rust-foundation-bridge.js";

export type OverviewReadInput = { operation: "dashboard-summary" | "budget-overview"; legacyDateTimezone?: string };

export async function requestOverviewRead(baseUrl: string, secret: string, timeoutMs: number,
  actor: RustFoundationActor, orgId: string, input: OverviewReadInput): Promise<RustFoundationResponse> {
  // Startup and database-context awaits have completed. This one sample also
  // supplies envelope issuance; only the host-local calendar constructor stays Node.
  const nowMs = Date.now(), now = new Date(nowMs);
  const hostLocalMonthStartMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const requestPath = `/internal/orgs/${encodeURIComponent(orgId)}/overview-reads`;
  const body = Buffer.from(JSON.stringify({ ...input, nowMs, hostLocalMonthStartMs }), "utf8"), requestId = randomUUID();
  const envelope = createRustActorEnvelope({ actor, organizationId: orgId, method: "POST", path: requestPath,
    action: "overview.read", body, secret, requestId, nowSeconds: Math.floor(nowMs / 1000) });
  const response = await fetch(`${baseUrl}${requestPath}`, { method: "POST", body: body as unknown as BodyInit,
    headers: { "content-type": "application/json", "x-rudder-actor-envelope": JSON.stringify(envelope), "x-rudder-request-id": requestId },
    signal: AbortSignal.timeout(timeoutMs) });
  return { status: response.status, contentType: response.headers.get("content-type") ?? "application/json",
    body: Buffer.from(await response.arrayBuffer()) };
}

export async function sendOverviewRead(db: Db, res: Response, bridge: RustFoundationBridge | undefined,
  actor: RustFoundationActor, orgId: string, input: OverviewReadInput): Promise<void> {
  if (!bridge?.overviewRead) throw new HttpError(503, "Rust Overview reads are unavailable");
  let response;
  try {
    const [context] = await db.execute(sql<{ timezone: string }>`SELECT current_setting('TimeZone') AS timezone`);
    if (typeof context?.timezone !== "string") throw new Error("Missing database date context");
    response = await bridge.overviewRead(actor, orgId, { ...input, legacyDateTimezone: context.timezone });
  } catch { throw new HttpError(503, "Rust Overview reads are unavailable"); }
  res.status(response.status).type(response.contentType).send(response.body);
}
