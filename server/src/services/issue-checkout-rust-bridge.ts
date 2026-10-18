import { randomUUID } from "node:crypto";
import { createRustActorEnvelope, type RustFoundationActor } from "./rust-actor-envelope.js";
import { RustFoundationBridgeError } from "./rust-foundation-bridge-error.js";
import type { RustFoundationResponse } from "./rust-foundation-bridge.js";

export type IssueCheckoutInput = {
  issueId: string;
  agentId: string;
  expectedStatuses: string[];
};

export type IssueCheckoutBridgeContext = {
  ensureStarted: () => Promise<void>;
  baseUrl: string | null;
  actorEnvelopeKey: string;
};

export async function requestIssueCheckout(
  context: IssueCheckoutBridgeContext,
  actor: RustFoundationActor,
  orgId: string,
  input: IssueCheckoutInput,
): Promise<RustFoundationResponse> {
  await context.ensureStarted();
  if (!context.baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
  const requestPath = `/internal/orgs/${encodeURIComponent(orgId)}/issue-checkout`;
  const body = Buffer.from(JSON.stringify({
    orgId,
    issueId: input.issueId,
    agentId: input.agentId,
    expectedStatuses: input.expectedStatuses,
    actorRunId: actor.type === "agent" ? actor.runId ?? null : null,
  }));
  const requestId = randomUUID();
  const envelope = createRustActorEnvelope({
    actor,
    organizationId: orgId,
    method: "POST",
    path: requestPath,
    action: "issue.checkout",
    body,
    secret: context.actorEnvelopeKey,
    requestId,
  });
  try {
    const response = await fetch(`${context.baseUrl}${requestPath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rudder-actor-envelope": JSON.stringify(envelope),
        "x-rudder-request-id": requestId,
      },
      body: body as unknown as BodyInit,
      // Checkout commits issue state, activity, and the mutation outbox in one
      // transaction. Do not abort after admission; a retry could duplicate activity.
    });
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/json",
      body: Buffer.from(await response.arrayBuffer()),
    } satisfies RustFoundationResponse;
  } catch (error) {
    throw new RustFoundationBridgeError("request_failed", "Rust Issue checkout request failed", { cause: error });
  }
}
