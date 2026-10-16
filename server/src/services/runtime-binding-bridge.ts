import { randomUUID } from "node:crypto";
import { HttpError } from "../errors.js";
import { createRustActorEnvelope, type RustFoundationActor } from "./rust-actor-envelope.js";
import type {
  RustFoundationBridge,
  RustFoundationResponse,
} from "./rust-foundation-bridge.js";

export type RuntimeBindingTarget = {
  targetType: "chat_conversation";
  targetId: string;
};

export type RuntimeBindingIdentityInput = {
  agentId: string;
  hostId?: string | null;
  profileId?: string | null;
  workspaceBindingId?: string | null;
  instructionsRevision?: string | null;
  capabilityRevision?: string | null;
};

/** Internal transport contract. Rust resolves target ownership, validates
 * identity, and owns every binding/segment query and mutation. */
export type RuntimeBindingInput =
  | { operation: "ensure"; target: RuntimeBindingTarget; identity: RuntimeBindingIdentityInput }
  | { operation: "current" | "public_current"; target: RuntimeBindingTarget }
  | { operation: "read" | "public_read"; bindingId: string };

export async function requestRuntimeBinding(
  baseUrl: string,
  secret: string,
  timeoutMs: number,
  actor: RustFoundationActor,
  orgId: string,
  input: RuntimeBindingInput,
): Promise<RustFoundationResponse> {
  const requestPath = `/internal/orgs/${encodeURIComponent(orgId)}/runtime-bindings`;
  const body = Buffer.from(JSON.stringify(input), "utf8");
  const requestId = randomUUID();
  const envelope = createRustActorEnvelope({
    actor, organizationId: orgId, method: "POST", path: requestPath,
    action: `runtime.binding.${input.operation}`, body, secret, requestId,
  });
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-rudder-actor-envelope": JSON.stringify(envelope),
      "x-rudder-request-id": requestId,
    },
    body: body as unknown as BodyInit,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:;|$)/i.test(contentType)
      || (response.status !== 200 && (response.status < 400 || response.status > 599))) {
    await response.body?.cancel();
    throw new Error("Invalid Rust runtime binding response envelope");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!response.body) throw new Error("Missing Rust runtime binding response");
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 1024 * 1024) throw new Error("Rust runtime binding response exceeds transport limit");
    chunks.push(chunk);
  }
  const responseBody = Buffer.concat(chunks);
  const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBody));
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Invalid Rust runtime binding response envelope");
  if (response.status === 200 && (!("binding" in decoded) || !("segment" in decoded))) throw new Error("Invalid Rust runtime binding response envelope");
  if (response.status === 200) {
    for (const value of Object.values(decoded)) {
      if (value !== null && (typeof value !== "object" || Array.isArray(value))) throw new Error("Invalid Rust runtime binding response envelope");
    }
  }
  if (response.status >= 400 && (!("error" in decoded) || typeof decoded.error !== "string")) throw new Error("Invalid Rust runtime binding error envelope");
  return {
    status: response.status,
    contentType,
    body: responseBody,
  };
}

/** No local lookup, synthetic session, or legacy writer on authority failure. */
export async function callRuntimeBinding(
  bridge: RustFoundationBridge | undefined,
  actor: RustFoundationActor,
  orgId: string,
  input: RuntimeBindingInput,
): Promise<RustFoundationResponse> {
  if (!bridge?.runtimeBinding) throw new HttpError(503, "Rust runtime binding authority is unavailable");
  try {
    return await bridge.runtimeBinding(actor, orgId, input);
  } catch {
    throw new HttpError(503, "Rust runtime binding authority is unavailable");
  }
}
