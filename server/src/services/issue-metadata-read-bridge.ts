import { issues, type Db } from "@rudderhq/db";
import { eq, sql } from "drizzle-orm";
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import {
  createRustActorEnvelope, RustFoundationBridgeError,
  type RustFoundationActor, type RustFoundationBridge, type RustFoundationResponse,
} from "./rust-foundation-bridge.js";

export type IssueMetadataReadInput = {
  operation: "attachments" | "work-products" | "follows";
  issueId?: string;
  /** Trusted adapter evidence that a Board userId was actually present. */
  boardUserContext?: boolean;
  /** Signed Node connection context, never a caller-controlled query filter. */
  legacyDateTimezone?: string;
};

export async function requestIssueMetadataRead(
  baseUrl: string,
  secret: string,
  timeoutMs: number,
  actor: RustFoundationActor,
  orgId: string,
  input: IssueMetadataReadInput,
): Promise<RustFoundationResponse> {
  const path = `/internal/orgs/${encodeURIComponent(orgId)}/issue-metadata-reads`;
  const body = Buffer.from(JSON.stringify(input));
  const requestId = randomUUID();
  const envelope = createRustActorEnvelope({ actor, organizationId: orgId, method: "POST", path,
    action: "issue_metadata.read", body, secret, requestId });
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rudder-actor-envelope": JSON.stringify(envelope), "x-rudder-request-id": requestId },
      body: body as unknown as BodyInit,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, contentType: response.headers.get("content-type") ?? "application/json", body: Buffer.from(await response.arrayBuffer()) };
  } catch (cause) {
    throw new RustFoundationBridgeError("request_failed", "Rust Issue metadata read request failed", { cause });
  }
}

/** Selected GETs never fall back to Node projection or mutation ownership. */
export async function sendIssueMetadataRead(
  res: Response,
  bridge: RustFoundationBridge | undefined,
  actor: RustFoundationActor,
  orgId: string,
  input: IssueMetadataReadInput,
  db: Db,
): Promise<void> {
  if (!bridge?.issueMetadataRead) {
    res.status(503).json({ error: "Rust Issue metadata reads are unavailable", code: "rust_foundation_issue_metadata_read_unavailable" });
    return;
  }
  let response: RustFoundationResponse;
  try {
    const [context] = await db.execute(sql<{ timezone: string }>`SELECT current_setting('TimeZone') AS timezone`);
    if (typeof context?.timezone !== "string") throw new Error("Missing database date context");
    response = await bridge.issueMetadataRead(actor, orgId, { ...input, legacyDateTimezone: context.timezone });
  } catch {
    res.status(503).json({ error: "Rust Issue metadata reads are unavailable", code: "rust_foundation_issue_metadata_read_request_failed" });
    return;
  }
  res.status(response.status).set("content-type", response.contentType).send(response.body);
}

/** Identity only: projection and linked-row organization checks belong to Rust. */
export async function issueMetadataReadIdentity(db: Db, issueId: string) {
  return db.select({ id: issues.id, orgId: issues.orgId }).from(issues)
    .where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
}
