import type { Db } from "@rudderhq/db";
import { sql } from "drizzle-orm";
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import { HttpError } from "../errors.js";
import { createRustActorEnvelope, type RustFoundationActor, type RustFoundationBridge, type RustFoundationResponse } from "./rust-foundation-bridge.js";

export type RunWorkspaceReadInput = { operation: "list" | "detail"; workspaceId?: string; projectId?: unknown;
  projectWorkspaceId?: unknown; issueId?: unknown; statuses?: string[]; reuseEligible?: boolean; legacyDateTimezone?: string };

export async function requestRunWorkspaceRead(baseUrl: string, secret: string, timeoutMs: number,
  actor: RustFoundationActor, orgId: string, input: RunWorkspaceReadInput): Promise<RustFoundationResponse> {
  const requestPath = `/internal/orgs/${encodeURIComponent(orgId)}/run-workspace-reads`;
  const body = Buffer.from(JSON.stringify(input), "utf8"), requestId = randomUUID();
  const envelope = createRustActorEnvelope({ actor, organizationId: orgId, method: "POST", path: requestPath,
    action: "run-workspace.read", body, secret, requestId });
  const response = await fetch(`${baseUrl}${requestPath}`, { method: "POST", body: body as unknown as BodyInit,
    headers: { "content-type": "application/json", "x-rudder-actor-envelope": JSON.stringify(envelope), "x-rudder-request-id": requestId },
    signal: AbortSignal.timeout(timeoutMs) });
  return { status: response.status, contentType: response.headers.get("content-type") ?? "application/json",
    body: Buffer.from(await response.arrayBuffer()) };
}

export async function sendRunWorkspaceRead(db: Db, res: Response, bridge: RustFoundationBridge | undefined,
  actor: RustFoundationActor, orgId: string, input: RunWorkspaceReadInput): Promise<void> {
  if (!bridge?.runWorkspaceRead) throw new HttpError(503, "Rust run workspace reads are unavailable");
  let response;
  try {
    const [context] = await db.execute(sql<{ timezone: string }>`SELECT current_setting('TimeZone') AS timezone`);
    if (typeof context?.timezone !== "string") throw new Error("Missing database date context");
    response = await bridge.runWorkspaceRead(actor, orgId, { ...input, legacyDateTimezone: context.timezone });
  } catch { throw new HttpError(503, "Rust run workspace reads are unavailable"); }
  res.status(response.status).type(response.contentType).send(response.body);
}
