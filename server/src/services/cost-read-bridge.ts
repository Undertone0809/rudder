import { randomUUID } from "node:crypto";

import {
  createRustActorEnvelope,
  RustFoundationBridgeError,
  type CostReadInput,
  type RustFoundationActor,
  type RustFoundationResponse,
} from "./rust-foundation-bridge.js";

/** Cost transport stays separate from bridge lifecycle and startup ownership. */
export async function requestCostRead(
  baseUrl: string,
  actorEnvelopeKey: string,
  requestTimeoutMs: number,
  actor: RustFoundationActor,
  orgId: string,
  input: CostReadInput,
): Promise<RustFoundationResponse> {
  const requestPath = `/internal/orgs/${encodeURIComponent(orgId)}/cost-reads`;
  const body = Buffer.from(JSON.stringify(input), "utf8");
  const requestId = randomUUID();
  const envelope = createRustActorEnvelope({
    actor,
    organizationId: orgId,
    method: "POST",
    path: requestPath,
    action: "cost.read",
    body,
    secret: actorEnvelopeKey,
    requestId,
  });
  try {
    const response = await fetch(`${baseUrl}${requestPath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rudder-actor-envelope": JSON.stringify(envelope),
        "x-rudder-request-id": requestId,
      },
      body: body as unknown as BodyInit,
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/json",
      body: Buffer.from(await response.arrayBuffer()),
    } satisfies RustFoundationResponse;
  } catch (error) {
    throw new RustFoundationBridgeError("request_failed", "Rust Cost read request failed", { cause: error });
  }
}
