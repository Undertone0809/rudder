import { randomUUID } from "node:crypto";
import { HttpError } from "../errors.js";
import { createRustActorEnvelope, type RustFoundationActor } from "./rust-actor-envelope.js";
import type { RustFoundationBridge, RustFoundationResponse } from "./rust-foundation-bridge.js";

export type NativeChatTranscriptInput = {
  operation: "read_message_transcript";
  messageId: string;
  afterSeq?: number;
  limit?: number;
};

export async function requestNativeChatTranscript(
  baseUrl: string,
  secret: string,
  timeoutMs: number,
  actor: RustFoundationActor,
  orgId: string,
  input: NativeChatTranscriptInput,
): Promise<RustFoundationResponse> {
  const path = `/internal/orgs/${encodeURIComponent(orgId)}/runtime-spans`;
  const body = Buffer.from(JSON.stringify(input), "utf8");
  const requestId = randomUUID();
  const envelope = createRustActorEnvelope({
    actor,
    organizationId: orgId,
    method: "POST",
    path,
    action: "runtime.span.read_message_transcript",
    body,
    secret,
    requestId,
  });
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-rudder-actor-envelope": JSON.stringify(envelope),
      "x-rudder-request-id": requestId,
    },
    body: body as unknown as BodyInit,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "application/json",
    body: Buffer.from(await response.arrayBuffer()),
  };
}

export async function callNativeChatTranscript(
  bridge: RustFoundationBridge | undefined,
  actor: RustFoundationActor,
  orgId: string,
  input: NativeChatTranscriptInput,
): Promise<RustFoundationResponse> {
  if (!bridge?.nativeChatTranscript) {
    throw new HttpError(503, "Rust Native Chat transcript authority is unavailable");
  }
  try {
    return await bridge.nativeChatTranscript(actor, orgId, input);
  } catch {
    throw new HttpError(503, "Rust Native Chat transcript authority is unavailable");
  }
}
