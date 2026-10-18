import { randomUUID } from "node:crypto";
import { createRustActorEnvelope, type RustFoundationActor } from "./rust-actor-envelope.js";
import type { RustFoundationResponse } from "./rust-foundation-bridge.js";

export type NativeChatMessageReaderInput = {
  operation: "read_conversation_messages";
  conversationId: string;
  limit?: number;
  cursor?: string;
  includeTranscript?: boolean;
};

export async function callNativeChatMessages(
  bridge: { nativeChatMessages?: (...args: any[]) => Promise<RustFoundationResponse> } | undefined,
  actor: RustFoundationActor,
  orgId: string,
  input: NativeChatMessageReaderInput,
): Promise<RustFoundationResponse> {
  if (!bridge?.nativeChatMessages) {
    return { status: 503, contentType: "application/json", body: Buffer.from(JSON.stringify({ error: "Rust Native Chat message authority is unavailable" })) };
  }
  try {
    return await bridge.nativeChatMessages(actor, orgId, input);
  } catch {
    return { status: 503, contentType: "application/json", body: Buffer.from(JSON.stringify({ error: "Rust Native Chat message authority is unavailable" })) };
  }
}

export async function requestNativeChatMessages(
  baseUrl: string,
  secret: string,
  timeoutMs: number,
  actor: RustFoundationActor,
  orgId: string,
  input: NativeChatMessageReaderInput,
): Promise<RustFoundationResponse> {
  const path = `/internal/orgs/${encodeURIComponent(orgId)}/runtime-spans`;
  const body = Buffer.from(JSON.stringify(input), "utf8");
  const requestId = randomUUID();
  const envelope = createRustActorEnvelope({
    actor,
    organizationId: orgId,
    method: "POST",
    path,
    action: "runtime.span.read_conversation_messages",
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
