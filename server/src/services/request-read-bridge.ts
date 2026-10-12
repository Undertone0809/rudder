import type { Db } from "@rudderhq/db";
import { sql } from "drizzle-orm";
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import {
  createRustActorEnvelope, RustFoundationBridgeError,
  type RustFoundationActor, type RustFoundationBridge, type RustFoundationResponse,
} from "./rust-foundation-bridge.js";

export type RequestReadInput = {
  operation: "detail" | "block-audit-attempts";
  requestId: string;
  /** Signed Node connection context, never a caller-controlled query filter. */
  legacyDateTimezone?: string;
};

export async function requestRequestRead(
  baseUrl: string,
  secret: string,
  timeoutMs: number,
  actor: RustFoundationActor,
  orgId: string,
  input: RequestReadInput,
): Promise<RustFoundationResponse> {
  const path = `/internal/orgs/${encodeURIComponent(orgId)}/request-reads`;
  const body = Buffer.from(JSON.stringify(input));
  const requestId = randomUUID();
  const envelope = createRustActorEnvelope({ actor, organizationId: orgId, method: "POST", path,
    action: "request.read", body, secret, requestId });
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rudder-actor-envelope": JSON.stringify(envelope), "x-rudder-request-id": requestId },
      body: body as unknown as BodyInit,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, contentType: response.headers.get("content-type") ?? "application/json", body: Buffer.from(await response.arrayBuffer()) };
  } catch (cause) {
    throw new RustFoundationBridgeError("request_failed", "Rust Request read request failed", { cause });
  }
}

/** Selected GETs never fall back to Node projection or mutation ownership. */
export async function sendRequestRead(
  res: Response,
  bridge: RustFoundationBridge | undefined,
  actor: RustFoundationActor,
  orgId: string,
  input: RequestReadInput,
  db: Db,
): Promise<void> {
  if (!bridge?.requestRead) {
    res.status(503).json({ error: "Rust Request reads are unavailable", code: "rust_foundation_request_read_unavailable" });
    return;
  }
  let response: RustFoundationResponse;
  try {
    const [context] = await db.execute(sql<{ timezone: string }>`SELECT current_setting('TimeZone') AS timezone`);
    if (typeof context?.timezone !== "string") throw new Error("Missing database date context");
    response = await bridge.requestRead(actor, orgId, { ...input, legacyDateTimezone: context.timezone });
  } catch {
    res.status(503).json({ error: "Rust Request reads are unavailable", code: "rust_foundation_request_read_request_failed" });
    return;
  }
  res.status(response.status).set("content-type", response.contentType).send(response.body);
}
