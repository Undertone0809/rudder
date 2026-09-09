import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { Request } from "express";
import type { BetterAuthSessionResult } from "./better-auth.js";
import type { LocalAccountSessionRevocation } from "../services/local-account-session-revocation.js";

/**
 * This bridge is a private transport adapter, not an authentication authority.
 * Node session middleware remains authoritative until a later, explicit cutover.
 */
export const ACTOR_ENVELOPE_BRIDGE_AUTHORITY = "private_non_authoritative" as const;
export const ACTOR_ENVELOPE_PROTOCOL_SCHEMA = "rudder.actor-envelope.v2" as const;
export const ACTOR_ENVELOPE_PROTOCOL_VERSION = 2 as const;
export const ACTOR_ENVELOPE_MAX_TTL_SECONDS = 300 as const;

const MAX_FIELD_BYTES = 256;
const SHA256_HEX_LENGTH = 64;
const DEFAULT_TTL_SECONDS = 60;
const DEFAULT_NONCE_CAPACITY = 16_384;

type ActorEnvelopeBridgeErrorCode =
  | "invalid_configuration"
  | "signing_key_unavailable"
  | "session_required"
  | "session_unavailable"
  | "session_changed"
  | "actor_context_mismatch"
  | "organization_not_authorized"
  | "body_unavailable"
  | "invalid_request"
  | "invalid_claims"
  | "nonce_replay"
  | "nonce_capacity";

/** Safe error values intentionally contain no claim values or secret material. */
export class PrivateActorEnvelopeBridgeError extends Error {
  readonly code: ActorEnvelopeBridgeErrorCode;

  constructor(code: ActorEnvelopeBridgeErrorCode, message: string) {
    super(message);
    this.name = "PrivateActorEnvelopeBridgeError";
    this.code = code;
  }

  toJSON(): { code: ActorEnvelopeBridgeErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }
}

export type ActorEnvelopeV2Actor = Readonly<{
  kind: string;
  id: string;
}>;

/** Claims covered by the Rust auth-core v2 HMAC. The key is not part of this type. */
export type ActorEnvelopeV2UnsignedClaims = Readonly<{
  protocolVersion: typeof ACTOR_ENVELOPE_PROTOCOL_VERSION;
  actor: ActorEnvelopeV2Actor;
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
  issuedAt: number;
  expiresAt: number;
}>;

export type ActorEnvelopeV2 = ActorEnvelopeV2UnsignedClaims & Readonly<{
  signature: string;
}>;

/** Values a server route has already selected and authorized. */
export type TrustedActorEnvelopeRequest = Readonly<{
  organizationId: string;
  action: string;
}>;

export type PrivateActorEnvelopeBridgeOptions = Readonly<{
  /** Injected from the existing server secret boundary; never request data. */
  signingKey?: string | Uint8Array;
  /** Fixed native verifier audience; never taken from a request or model payload. */
  audience: string;
  /** Existing Node-owned session resolver, normally createLocalAccountSessionResolver. */
  resolveSessionFromHeaders: (
    headers: Headers,
  ) => Promise<BetterAuthSessionResult | null>;
  /** Existing server-owned global revocation generation. */
  sessionRevocation: LocalAccountSessionRevocation;
  /** Test/runtime clock in Unix seconds. Defaults to the server clock. */
  now?: () => number;
  /** Rust auth-core rejects lifetimes greater than 300 seconds. */
  envelopeLifetimeSeconds?: number;
  /** Internal injection points for deterministic tests; never supplied per request. */
  requestIdFactory?: () => string;
  nonceFactory?: () => string;
  nonceCapacity?: number;
}>;

export type PrivateActorEnvelopeBridge = Readonly<{
  /** Explicit marker preventing accidental treatment as public auth authority. */
  authority: typeof ACTOR_ENVELOPE_BRIDGE_AUTHORITY;
  issue: (
    request: Request,
    trusted: TrustedActorEnvelopeRequest,
  ) => Promise<ActorEnvelopeV2>;
  currentAuthEpoch: () => number;
  toJSON: () => { authority: typeof ACTOR_ENVELOPE_BRIDGE_AUTHORITY };
}>;

function bridgeError(
  code: ActorEnvelopeBridgeErrorCode,
  message: string,
): PrivateActorEnvelopeBridgeError {
  return new PrivateActorEnvelopeBridgeError(code, message);
}

function isNonEmptyText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const bytes = Buffer.byteLength(value, "utf8");
  return (
    value.length > 0 &&
    value.trim().length > 0 &&
    bytes <= MAX_FIELD_BYTES &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint === 0 || codePoint <= 0x1f || codePoint === 0x7f;
    })
  );
}

function assertText(value: unknown): asserts value is string {
  if (!isNonEmptyText(value)) {
    throw bridgeError("invalid_claims", "Actor envelope contains an invalid text claim");
  }
}

function assertSafeInteger(value: unknown, field: string): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw bridgeError("invalid_claims", `Actor envelope contains an invalid ${field}`);
  }
}

function uint16Bytes(value: number): Buffer {
  const output = Buffer.allocUnsafe(2);
  output.writeUInt16BE(value, 0);
  return output;
}

function uint64Bytes(value: number): Buffer {
  const output = Buffer.allocUnsafe(8);
  output.writeBigUInt64BE(BigInt(value), 0);
  return output;
}

function lengthPrefixedText(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([uint64Bytes(bytes.length), bytes]);
}

function validateUnsignedClaims(claims: ActorEnvelopeV2UnsignedClaims): void {
  if (claims.protocolVersion !== ACTOR_ENVELOPE_PROTOCOL_VERSION) {
    throw bridgeError("invalid_claims", "Actor envelope has an unsupported protocol version");
  }
  if (!claims.actor || typeof claims.actor !== "object") {
    throw bridgeError("invalid_claims", "Actor envelope contains an invalid actor claim");
  }
  assertText(claims.actor.kind);
  assertText(claims.actor.id);
  assertText(claims.organizationId);
  assertText(claims.sessionId);
  assertText(claims.audience);
  assertText(claims.method);
  assertText(claims.path);
  if (!claims.path.startsWith("/")) {
    throw bridgeError("invalid_claims", "Actor envelope contains an invalid path claim");
  }
  assertText(claims.action);
  assertText(claims.requestId);
  assertText(claims.nonce);
  if (
    typeof claims.bodySha256 !== "string" ||
    claims.bodySha256.length !== SHA256_HEX_LENGTH ||
    !/^[0-9a-f]{64}$/u.test(claims.bodySha256)
  ) {
    throw bridgeError("invalid_claims", "Actor envelope contains an invalid body hash");
  }
  assertSafeInteger(claims.authEpoch, "auth epoch");
  assertSafeInteger(claims.issuedAt, "issued-at timestamp");
  assertSafeInteger(claims.expiresAt, "expiry timestamp");
  if (
    claims.expiresAt <= claims.issuedAt ||
    claims.expiresAt - claims.issuedAt > ACTOR_ENVELOPE_MAX_TTL_SECONDS
  ) {
    throw bridgeError("invalid_claims", "Actor envelope lifetime is outside the Rust limit");
  }
}

/**
 * Rust auth-core's exact v2 canonicalization:
 * schema NUL, big-endian u16 version, eleven u64-length-prefixed UTF-8
 * strings, then big-endian u64 epoch/issued/expiry values.
 */
export function canonicalActorEnvelopeV2SigningBytes(
  claims: ActorEnvelopeV2UnsignedClaims,
): Buffer {
  validateUnsignedClaims(claims);
  const fields = [
    claims.actor.kind,
    claims.actor.id,
    claims.organizationId,
    claims.sessionId,
    claims.audience,
    claims.method,
    claims.path,
    claims.action,
    claims.bodySha256,
    claims.requestId,
    claims.nonce,
  ];
  return Buffer.concat([
    Buffer.from(ACTOR_ENVELOPE_PROTOCOL_SCHEMA, "utf8"),
    Buffer.from([0]),
    uint16Bytes(claims.protocolVersion),
    ...fields.map(lengthPrefixedText),
    uint64Bytes(claims.authEpoch),
    uint64Bytes(claims.issuedAt),
    uint64Bytes(claims.expiresAt),
  ]);
}

export function actorEnvelopeBodySha256(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function headersFromNodeHeaders(rawHeaders: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(rawHeaders)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
    } else {
      headers.set(key, raw);
    }
  }
  return headers;
}

function requestPath(request: Request): string {
  const rawUrl = request.originalUrl || request.url;
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    throw bridgeError("invalid_request", "Actor envelope request path is unavailable");
  }
  const queryStart = rawUrl.search(/[?#]/u);
  const path = queryStart >= 0 ? rawUrl.slice(0, queryStart) : rawUrl;
  if (!path.startsWith("/")) {
    throw bridgeError("invalid_request", "Actor envelope request path is unavailable");
  }
  return path;
}

function requestBody(request: Request): Buffer {
  if (request.rawBody !== undefined) return Buffer.from(request.rawBody);
  if (request.body === undefined) return Buffer.alloc(0);
  throw bridgeError("body_unavailable", "Actor envelope raw request body is unavailable");
}

function currentWireAuthEpoch(sessionRevocation: LocalAccountSessionRevocation): number {
  let generation: number;
  try {
    generation = sessionRevocation.generation();
  } catch {
    throw bridgeError("session_unavailable", "Actor envelope revocation state is unavailable");
  }
  if (!Number.isSafeInteger(generation) || generation < 0 || generation >= Number.MAX_SAFE_INTEGER) {
    throw bridgeError("session_unavailable", "Actor envelope revocation state is unavailable");
  }
  // Rust auth-core requires auth_epoch > 0; preserve the existing zero-based
  // server generation as a one-based wire epoch without creating a new store.
  return generation + 1;
}

function validateFactoryOptions(options: PrivateActorEnvelopeBridgeOptions): Buffer {
  if (!isNonEmptyText(options.audience)) {
    throw bridgeError("invalid_configuration", "Actor envelope audience is unavailable");
  }
  if (options.signingKey === undefined) {
    throw bridgeError("signing_key_unavailable", "Actor envelope signing key is unavailable");
  }
  const key = typeof options.signingKey === "string"
    ? Buffer.from(options.signingKey, "utf8")
    : Buffer.from(options.signingKey);
  if (key.length === 0) {
    throw bridgeError("signing_key_unavailable", "Actor envelope signing key is unavailable");
  }
  if (typeof options.resolveSessionFromHeaders !== "function") {
    throw bridgeError("invalid_configuration", "Actor envelope session resolver is unavailable");
  }
  if (!options.sessionRevocation || typeof options.sessionRevocation.generation !== "function") {
    throw bridgeError("invalid_configuration", "Actor envelope revocation state is unavailable");
  }
  return key;
}

function validateLifetime(value: number | undefined): number {
  const lifetime = value ?? DEFAULT_TTL_SECONDS;
  if (
    !Number.isSafeInteger(lifetime) ||
    lifetime <= 0 ||
    lifetime > ACTOR_ENVELOPE_MAX_TTL_SECONDS
  ) {
    throw bridgeError("invalid_configuration", "Actor envelope lifetime is outside the Rust limit");
  }
  return lifetime;
}

function validateNonceCapacity(value: number | undefined): number {
  const capacity = value ?? DEFAULT_NONCE_CAPACITY;
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw bridgeError("invalid_configuration", "Actor envelope nonce capacity is invalid");
  }
  return capacity;
}

function validateGeneratedId(value: unknown, field: string): asserts value is string {
  if (!isNonEmptyText(value)) {
    throw bridgeError("invalid_request", `Actor envelope ${field} is unavailable`);
  }
}

function serverActorMatchesSession(request: Request, session: BetterAuthSessionResult): boolean {
  const actor = request.actor;
  return (
    !!actor &&
    actor.type === "board" &&
    actor.source === "session" &&
    typeof actor.userId === "string" &&
    typeof session.user?.id === "string" &&
    typeof session.session?.userId === "string" &&
    actor.userId === session.user.id &&
    session.session.userId === session.user.id
  );
}

/**
 * Build a private, signed envelope from Node's already-resolved session.
 * Callers must pass only route-selected organization/action values; audience,
 * actor, session, epoch, method, path, body, request ID, and nonce are not
 * accepted from request/model payloads.
 */
export function createPrivateActorEnvelopeBridge(
  options: PrivateActorEnvelopeBridgeOptions,
): PrivateActorEnvelopeBridge {
  const key = validateFactoryOptions(options);
  const lifetime = validateLifetime(options.envelopeLifetimeSeconds);
  const nonceCapacity = validateNonceCapacity(options.nonceCapacity);
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  const requestIdFactory = options.requestIdFactory ?? randomUUID;
  const nonceFactory = options.nonceFactory ?? (() => randomBytes(24).toString("base64url"));
  const issuedNonces = new Map<string, number>();

  function pruneNonces(nowSeconds: number): void {
    for (const [nonce, expiresAt] of issuedNonces) {
      if (expiresAt <= nowSeconds) issuedNonces.delete(nonce);
    }
  }

  function reserveNonce(nonce: string, expiresAt: number, nowSeconds: number): void {
    pruneNonces(nowSeconds);
    if (issuedNonces.has(nonce)) {
      throw bridgeError("nonce_replay", "Actor envelope nonce has already been issued");
    }
    if (issuedNonces.size >= nonceCapacity) {
      throw bridgeError("nonce_capacity", "Actor envelope nonce capacity is exhausted");
    }
    issuedNonces.set(nonce, expiresAt);
  }

  const bridge: PrivateActorEnvelopeBridge = {
    authority: ACTOR_ENVELOPE_BRIDGE_AUTHORITY,
    async issue(request, trusted) {
      if (!request || typeof request !== "object") {
        throw bridgeError("invalid_request", "Actor envelope request is unavailable");
      }
      if (!trusted || typeof trusted !== "object") {
        throw bridgeError("invalid_request", "Actor envelope trusted route context is unavailable");
      }
      if (!isNonEmptyText(trusted.organizationId) || !isNonEmptyText(trusted.action)) {
        throw bridgeError("invalid_request", "Actor envelope trusted route context is invalid");
      }

      const epochBefore = currentWireAuthEpoch(options.sessionRevocation);
      let resolvedSession: BetterAuthSessionResult | null;
      try {
        resolvedSession = await options.resolveSessionFromHeaders(
          headersFromNodeHeaders(request.headers),
        );
      } catch {
        throw bridgeError("session_unavailable", "Actor envelope session resolution failed");
      }
      const epochAfter = currentWireAuthEpoch(options.sessionRevocation);
      if (epochBefore !== epochAfter) {
        throw bridgeError("session_changed", "Actor envelope session changed during resolution");
      }
      if (
        !resolvedSession?.session ||
        !resolvedSession.user ||
        !isNonEmptyText(resolvedSession.session.id) ||
        !isNonEmptyText(resolvedSession.session.userId) ||
        !isNonEmptyText(resolvedSession.user.id)
      ) {
        throw bridgeError("session_required", "Actor envelope requires an active session");
      }
      if (!serverActorMatchesSession(request, resolvedSession)) {
        throw bridgeError("actor_context_mismatch", "Actor envelope actor context does not match the session");
      }
      const organizationIds = request.actor?.orgIds;
      if (!Array.isArray(organizationIds) || !organizationIds.includes(trusted.organizationId)) {
        throw bridgeError("organization_not_authorized", "Actor envelope organization is not authorized");
      }

      const method = request.method;
      if (!isNonEmptyText(method)) {
        throw bridgeError("invalid_request", "Actor envelope request method is unavailable");
      }
      const path = requestPath(request);
      const body = requestBody(request);
      let issuedAt: number;
      try {
        issuedAt = now();
      } catch {
        throw bridgeError("invalid_request", "Actor envelope clock is unavailable");
      }
      if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) {
        throw bridgeError("invalid_request", "Actor envelope clock is unavailable");
      }
      const expiresAt = issuedAt + lifetime;
      if (!Number.isSafeInteger(expiresAt)) {
        throw bridgeError("invalid_request", "Actor envelope expiry is unavailable");
      }
      let requestId: string;
      let nonce: string;
      try {
        requestId = requestIdFactory();
        nonce = nonceFactory();
      } catch {
        throw bridgeError("invalid_request", "Actor envelope request identifiers are unavailable");
      }
      validateGeneratedId(requestId, "request ID");
      validateGeneratedId(nonce, "nonce");

      const claims: ActorEnvelopeV2UnsignedClaims = {
        protocolVersion: ACTOR_ENVELOPE_PROTOCOL_VERSION,
        actor: Object.freeze({ kind: "user", id: resolvedSession.user.id }),
        organizationId: trusted.organizationId,
        sessionId: resolvedSession.session.id,
        authEpoch: epochAfter,
        audience: options.audience,
        method,
        path,
        action: trusted.action,
        bodySha256: actorEnvelopeBodySha256(body),
        requestId,
        nonce,
        issuedAt,
        expiresAt,
      };
      const signingBytes = canonicalActorEnvelopeV2SigningBytes(claims);
      const signature = createHmac("sha256", key).update(signingBytes).digest("hex");
      reserveNonce(nonce, expiresAt, issuedAt);
      return Object.freeze({ ...claims, signature });
    },
    currentAuthEpoch() {
      return currentWireAuthEpoch(options.sessionRevocation);
    },
    toJSON() {
      return { authority: ACTOR_ENVELOPE_BRIDGE_AUTHORITY };
    },
  };

  return Object.freeze(bridge);
}
