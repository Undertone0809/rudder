import { approvals, issues, type Db } from "@rudderhq/db";
import { eq, sql } from "drizzle-orm";
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import {
  createRustActorEnvelope, RustFoundationBridgeError,
  type RustFoundationActor, type RustFoundationBridge, type RustFoundationResponse,
} from "./rust-foundation-bridge.js";

export type ApprovalReadInput = (
  | { operation: "list"; status?: string }
  | { operation: "detail" | "issues" | "issue-approvals"; targetId: string }
  | { operation: "labels" }
) & { legacyDateTimezone?: string };

/** Match the legacy postgres-js text binding after Express's simple parser. */
export function approvalStatusQuery(value: unknown): string | undefined {
  return value ? String(value) : undefined;
}

/** Identity only; Rust rechecks this target and owns all response projection. */
export async function approvalReadIdentity(db: Db, kind: "approval" | "issue", id: string) {
  const table = kind === "approval" ? approvals : issues;
  return db.select({ id: table.id, orgId: table.orgId }).from(table).where(eq(table.id, id))
    .then((rows) => rows[0] ?? null);
}

export async function requestApprovalRead(
  baseUrl: string,
  secret: string,
  timeoutMs: number,
  actor: RustFoundationActor,
  orgId: string,
  input: ApprovalReadInput,
): Promise<RustFoundationResponse> {
  const path = `/internal/orgs/${encodeURIComponent(orgId)}/approval-reads`;
  const body = Buffer.from(JSON.stringify(input));
  const requestId = randomUUID();
  const envelope = createRustActorEnvelope({ actor, organizationId: orgId, method: "POST", path,
    action: "approval.read", body, secret, requestId });
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rudder-actor-envelope": JSON.stringify(envelope), "x-rudder-request-id": requestId },
      body: body as unknown as BodyInit,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, contentType: response.headers.get("content-type") ?? "application/json", body: Buffer.from(await response.arrayBuffer()) };
  } catch (cause) {
    throw new RustFoundationBridgeError("request_failed", "Rust Approval read request failed", { cause });
  }
}

/** Selected GETs never fall back to Node projection or mutation ownership. */
export async function sendApprovalRead(
  res: Response,
  bridge: RustFoundationBridge | undefined,
  actor: RustFoundationActor,
  orgId: string,
  input: ApprovalReadInput,
  db: Db,
): Promise<void> {
  if (!bridge?.approvalRead) {
    res.status(503).json({ error: "Rust Approval reads are unavailable", code: "rust_foundation_approval_read_unavailable" });
    return;
  }
  let response: RustFoundationResponse;
  try {
    const [context] = await db.execute(sql<{ timezone: string }>`SELECT current_setting('TimeZone') AS timezone`);
    if (typeof context?.timezone !== "string") throw new Error("Missing database date context");
    response = await bridge.approvalRead(actor, orgId, { ...input, legacyDateTimezone: context.timezone });
  } catch {
    res.status(503).json({ error: "Rust Approval reads are unavailable", code: "rust_foundation_approval_read_request_failed" });
    return;
  }
  res.status(response.status).set("content-type", response.contentType).send(response.body);
}
