import type { Response } from "express";
import { randomUUID } from "node:crypto";
import {
  createRustActorEnvelope, RustFoundationBridgeError,
  type RustFoundationActor, type RustFoundationBridge, type RustFoundationResponse,
} from "./rust-foundation-bridge.js";

export type AutomationReadInput = {
  operation: "list" | "detail" | "runs";
  automationId?: string;
  limit?: number;
};

export async function requestAutomationRead(
  baseUrl: string,
  secret: string,
  timeoutMs: number,
  actor: RustFoundationActor,
  orgId: string,
  input: AutomationReadInput,
): Promise<RustFoundationResponse> {
  const path = `/internal/orgs/${encodeURIComponent(orgId)}/automation-reads`;
  const body = Buffer.from(JSON.stringify(input));
  const requestId = randomUUID();
  const envelope = createRustActorEnvelope({ actor, organizationId: orgId, method: "POST", path,
    action: "automation.read", body, secret, requestId });
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rudder-actor-envelope": JSON.stringify(envelope), "x-rudder-request-id": requestId },
      body: body as unknown as BodyInit,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, contentType: response.headers.get("content-type") ?? "application/json", body: Buffer.from(await response.arrayBuffer()) };
  } catch (cause) {
    throw new RustFoundationBridgeError("request_failed", "Rust Automation read request failed", { cause });
  }
}

/** Selected GETs never fall back to Node projection or mutation ownership. */
export async function sendAutomationRead(
  res: Response,
  bridge: RustFoundationBridge | undefined,
  actor: RustFoundationActor,
  orgId: string,
  input: AutomationReadInput,
): Promise<void> {
  if (!bridge?.automationRead) {
    res.status(503).json({ error: "Rust Automation reads are unavailable", code: "rust_foundation_automation_read_unavailable" });
    return;
  }
  let response: RustFoundationResponse;
  try {
    response = await bridge.automationRead(actor, orgId, input);
  } catch {
    res.status(503).json({ error: "Rust Automation reads are unavailable", code: "rust_foundation_automation_read_request_failed" });
    return;
  }
  res.status(response.status).set("content-type", response.contentType).send(response.body);
}
