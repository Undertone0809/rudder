import type { Request } from "express";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { RustFoundationBridgeError } from "./rust-foundation-bridge-error.js";

export type RustFoundationActor = Request["actor"] & {
  sessionId?: string;
  authEpoch?: number;
};
type BridgeActor = RustFoundationActor;

const ACTOR_ENVELOPE_AUDIENCE = "rudder-server-foundation";
const ACTOR_ENVELOPE_PROTOCOL_VERSION = 2;
const ACTOR_ENVELOPE_SCHEMA = "rudder.actor-envelope.v2";
const ACTOR_ENVELOPE_LIFETIME_SECONDS = 60;

function actorIdentity(actor: BridgeActor) {
  if (actor.type === "agent") {
    if (!actor.agentId) throw new RustFoundationBridgeError("request_failed", "Authenticated agent has no agent id");
    return { kind: "agent", id: actor.agentId };
  }
  if (actor.type === "board") {
    return { kind: "user", id: actor.userId ?? "local-board" };
  }
  throw new RustFoundationBridgeError("request_failed", "Rust bridge requires an authenticated actor");
}

function actorSession(actor: BridgeActor) {
  const explicit = actor.sessionId?.trim();
  if (explicit) return explicit;
  return `${actor.source}:${actor.keyId ?? actor.userId ?? actor.agentId ?? "unknown"}`;
}

function appendLengthPrefixed(output: Buffer[], value: string) {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  output.push(length, bytes);
}

function canonicalSigningBytes(input: {
  actor: { kind: string; id: string };
  organizationId: string;
  sessionId: string;
  authEpoch: number;
  audience: string;
  method: string;
  path: string;
  action: string;
  bodySha256: string;
  requestId: string;
  nonce: string;
  idempotencyKey?: string | null;
  issuedAt: number;
  expiresAt: number;
}) {
  const output: Buffer[] = [Buffer.from(ACTOR_ENVELOPE_SCHEMA, "utf8"), Buffer.from([0])];
  const protocol = Buffer.allocUnsafe(2);
  protocol.writeUInt16BE(ACTOR_ENVELOPE_PROTOCOL_VERSION);
  output.push(protocol);
  for (const field of [
    input.actor.kind,
    input.actor.id,
    input.organizationId,
    input.sessionId,
    input.audience,
    input.method,
    input.path,
    input.action,
    input.bodySha256,
    input.requestId,
    input.nonce,
  ]) {
    appendLengthPrefixed(output, field);
  }
  if (input.idempotencyKey) {
    appendLengthPrefixed(output, input.idempotencyKey);
  }
  for (const value of [input.authEpoch, input.issuedAt, input.expiresAt]) {
    const encoded = Buffer.allocUnsafe(8);
    encoded.writeBigUInt64BE(BigInt(value));
    output.push(encoded);
  }
  return Buffer.concat(output);
}

export function createRustActorEnvelope(input: {
  actor: BridgeActor;
  organizationId: string;
  method: string;
  path: string;
  action: string;
  body: Buffer;
  secret: string;
  nowSeconds?: number;
  requestId?: string;
  nonce?: string;
  idempotencyKey?: string;
  allowAnonymous?: boolean;
}) {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const requestId = input.requestId ?? randomUUID();
  const nonce = input.nonce ?? randomUUID();
  const actor = input.allowAnonymous && input.actor.type === "none" ? { kind: "anonymous", id: "anonymous" } : actorIdentity(input.actor);
  const sessionId = actorSession(input.actor);
  const authEpoch = Number.isSafeInteger(input.actor.authEpoch) && (input.actor.authEpoch ?? 0) > 0
    ? input.actor.authEpoch!
    : 1;
  const unsigned = {
    protocolVersion: ACTOR_ENVELOPE_PROTOCOL_VERSION,
    actor,
    organizationId: input.organizationId,
    sessionId,
    authEpoch,
    audience: ACTOR_ENVELOPE_AUDIENCE,
    method: input.method,
    path: input.path,
    action: input.action,
    bodySha256: createHash("sha256").update(input.body).digest("hex"),
    requestId,
    nonce,
    idempotencyKey: input.idempotencyKey ?? null,
    issuedAt: Math.max(1, now - 1),
    expiresAt: now + ACTOR_ENVELOPE_LIFETIME_SECONDS,
  };
  const signature = createHmac(
    "sha256",
    Buffer.from(input.secret, "utf8"),
  ).update(canonicalSigningBytes(unsigned)).digest("hex");
  return { ...unsigned, signature };
}

/** Fixed private transport identity for already-created legacy event frames. */
export function createRustLiveEventTransportEnvelope(input: {
  organizationId: string;
  body: Buffer;
  secret: string;
  requestId?: string;
  nonce?: string;
  nowSeconds?: number;
}) {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const unsigned = {
    protocolVersion: ACTOR_ENVELOPE_PROTOCOL_VERSION,
    actor: { kind: "system", id: "node-live-events-transport" },
    organizationId: input.organizationId,
    sessionId: "node-live-events-transport",
    authEpoch: 1,
    audience: ACTOR_ENVELOPE_AUDIENCE,
    method: "POST",
    path: "/internal/live-events/forward",
    action: "live.events.forward",
    bodySha256: createHash("sha256").update(input.body).digest("hex"),
    requestId: input.requestId ?? randomUUID(),
    nonce: input.nonce ?? randomUUID(),
    idempotencyKey: null,
    issuedAt: Math.max(1, now - 1),
    expiresAt: now + ACTOR_ENVELOPE_LIFETIME_SECONDS,
  };
  const signature = createHmac("sha256", Buffer.from(input.secret, "utf8"))
    .update(canonicalSigningBytes(unsigned)).digest("hex");
  return { ...unsigned, signature };
}
