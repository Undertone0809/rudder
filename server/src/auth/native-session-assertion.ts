import type { Request, RequestHandler } from "express";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const HEADER = "x-rudder-native-session-proof";
const SCHEMA = "rudder.native-session-assertion.v1";
const AUDIENCE = "rudder-node-private-ingress";
const MAX_LIFETIME_SECONDS = 30;
const MAX_NONCES = 50_000;
const NONCE_EXPIRY_BUCKETS = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type NonceExpiry = { nonce: string; expiresAt: number };
type NonceConsumeResult = "accepted" | "replayed" | "capacity";

/**
 * A bounded replay set with expiry buckets. Each accepted nonce is indexed in
 * one of 64 second slots (the signed proof lifetime is at most 30 seconds,
 * with at most five seconds of allowed issue-time skew), so ordinary requests
 * never scan the full registry. Entries are removed once as their expiry
 * buckets pass; a clock jump visits each slot at most once.
 */
export class NativeSessionAssertionNonceRegistry {
  private readonly usedNonces = new Map<string, number>();
  private readonly expiryBuckets: NonceExpiry[][] = Array.from(
    { length: NONCE_EXPIRY_BUCKETS },
    () => [],
  );
  private lastSweepSecond: number | undefined;

  constructor(private readonly capacity = MAX_NONCES) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_NONCES) {
      throw new RangeError(`Nonce registry capacity must be between 1 and ${MAX_NONCES}`);
    }
  }

  consume(nonce: string, expiresAt: number, now: number): NonceConsumeResult {
    this.purgeExpired(now);
    if (this.usedNonces.has(nonce)) return "replayed";
    if (this.usedNonces.size >= this.capacity) return "capacity";

    this.usedNonces.set(nonce, expiresAt);
    this.expiryBuckets[this.bucketIndex(expiresAt)]!.push({ nonce, expiresAt });
    return "accepted";
  }

  private purgeExpired(now: number): void {
    if (this.lastSweepSecond === undefined) {
      this.lastSweepSecond = now;
      return;
    }
    if (now <= this.lastSweepSecond) return;

    // Expiries are bounded to a 35-second horizon. On a large clock jump,
    // traversing the most recent full wheel is enough to visit every bucket.
    const firstSecond = now - this.lastSweepSecond >= NONCE_EXPIRY_BUCKETS
      ? now - NONCE_EXPIRY_BUCKETS + 1
      : this.lastSweepSecond + 1;
    for (let second = firstSecond; second <= now; second += 1) {
      const index = this.bucketIndex(second);
      const bucket = this.expiryBuckets[index]!;
      if (!bucket.length) continue;
      const retained: NonceExpiry[] = [];
      for (const entry of bucket) {
        if (entry.expiresAt <= now) this.usedNonces.delete(entry.nonce);
        else retained.push(entry);
      }
      this.expiryBuckets[index] = retained;
    }
    this.lastSweepSecond = now;
  }

  private bucketIndex(second: number): number {
    return ((second % NONCE_EXPIRY_BUCKETS) + NONCE_EXPIRY_BUCKETS) % NONCE_EXPIRY_BUCKETS;
  }
}

export type NativeSessionAssertionIdentity =
  | { kind: "none" }
  | { kind: "session"; session_id: string; user_id: string };

type NativeSessionAssertionPayload = {
  schema: typeof SCHEMA;
  audience: typeof AUDIENCE;
  method: string;
  target: string;
  issued_at: number;
  expires_at: number;
  request_id: string;
  nonce: string;
  identity: NativeSessionAssertionIdentity;
};

export type VerifiedNativeSessionAssertion = NativeSessionAssertionIdentity;

const verifiedAssertions = new WeakMap<Request, VerifiedNativeSessionAssertion>();

/**
 * This signed assertion carries only the public ingress session identity. It
 * is not a body signature or a route permission grant. The trusted boundary
 * is the fixed loopback Rust-to-Node hop; Rust strips client copies.
 */
export function signNativeSessionAssertion(input: {
  key: string;
  method: string;
  target: string;
  identity: NativeSessionAssertionIdentity;
  nowSeconds?: number;
  requestId?: string;
  nonce?: string;
}): string {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const payload: NativeSessionAssertionPayload = {
    schema: SCHEMA,
    audience: AUDIENCE,
    method: input.method,
    target: input.target,
    issued_at: now,
    expires_at: now + MAX_LIFETIME_SECONDS,
    request_id: input.requestId ?? randomUUID(),
    nonce: input.nonce ?? randomUUID(),
    identity: input.identity,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", input.key)
    .update(encoded, "ascii")
    .digest("base64url");
  return `${encoded}.${signature}`;
}

export function nativeSessionAssertionMiddleware(options: {
  key: string;
  nowSeconds?: () => number;
  /** Test seam; production uses the fixed MAX_NONCES limit. */
  maxNonces?: number;
}): RequestHandler {
  const nonceRegistry = new NativeSessionAssertionNonceRegistry(options.maxNonces ?? MAX_NONCES);
  return (req, res, next) => {
    if (isNodeOwnedLifecyclePath(req.method, req.originalUrl || req.url)) {
      next();
      return;
    }

    const authorization = req.headers.authorization;
    if (typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")) {
      next();
      return;
    }

    const assertion = req.headers[HEADER];
    if (typeof assertion !== "string") {
      res.status(401).json({ error: "Native session proof required", code: "native_session_proof_required" });
      return;
    }
    const payload = verifyAssertion(assertion, options.key);
    const now = options.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
    const target = req.originalUrl || req.url;
    if (!payload
      || payload.method !== req.method
      || payload.target !== target
      || payload.issued_at > now + 5
      || payload.expires_at <= now
      || payload.expires_at <= payload.issued_at
      || payload.expires_at - payload.issued_at > MAX_LIFETIME_SECONDS
      || !UUID.test(payload.request_id)
      || !UUID.test(payload.nonce)) {
      res.status(401).json({ error: "Native session proof is invalid", code: "native_session_proof_invalid" });
      return;
    }

    const nonceResult = nonceRegistry.consume(payload.nonce, payload.expires_at, now);
    if (nonceResult === "replayed") {
      res.status(401).json({ error: "Native session proof was already used", code: "native_session_proof_replayed" });
      return;
    }
    if (nonceResult === "capacity") {
      res.status(503).json({ error: "Native session proof admission is full", code: "native_session_proof_capacity" });
      return;
    }

    // Consume the nonce and bind the proof before body parsing or any route
    // side effect. Slow/chunked JSON bodies may outlive the assertion TTL.
    verifiedAssertions.set(req, payload.identity);
    delete req.headers[HEADER];
    next();
  };
}

export function getVerifiedNativeSessionAssertion(
  req: Request,
): VerifiedNativeSessionAssertion | undefined {
  return verifiedAssertions.get(req);
}

function verifyAssertion(value: string, keyHex: string): NativeSessionAssertionPayload | null {
  const [encoded, signature, extra] = value.split(".");
  if (!encoded || !signature || extra !== undefined
    || !/^[A-Za-z0-9_-]+$/.test(encoded)
    || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;
  let payloadBytes: Buffer;
  let supplied: Buffer;
  try {
    payloadBytes = Buffer.from(encoded, "base64url");
    supplied = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (payloadBytes.toString("base64url") !== encoded
    || supplied.toString("base64url") !== signature) return null;
  const expected = createHmac("sha256", keyHex)
    .update(encoded, "ascii")
    .digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.schema !== SCHEMA || record.audience !== AUDIENCE
    || typeof record.method !== "string" || !/^[A-Z]+$/.test(record.method)
    || typeof record.target !== "string" || !record.target.startsWith("/")
    || record.target.length > 16_384
    || typeof record.issued_at !== "number" || !Number.isSafeInteger(record.issued_at)
    || typeof record.expires_at !== "number" || !Number.isSafeInteger(record.expires_at)
    || typeof record.request_id !== "string" || typeof record.nonce !== "string"
    || !record.identity || typeof record.identity !== "object" || Array.isArray(record.identity)) return null;
  const identity = record.identity as Record<string, unknown>;
  if (identity.kind === "none") {
    if (Object.keys(identity).length !== 1) return null;
  } else if (identity.kind === "session") {
    if (Object.keys(identity).length !== 3
      || typeof identity.session_id !== "string" || !identity.session_id
      || identity.session_id.length > 512
      || typeof identity.user_id !== "string" || !identity.user_id
      || identity.user_id.length > 512) return null;
  } else {
    return null;
  }
  if (Object.keys(record).length !== 9) return null;
  return parsed as NativeSessionAssertionPayload;
}

function isNodeOwnedLifecyclePath(method: string, rawTarget: string): boolean {
  const path = rawTarget.split("?", 1)[0] ?? "";
  const normalized = path.replace(/\/+$/, "").toLowerCase();
  if (normalized === "/api/auth/get-session") {
    return method !== "GET" && method !== "HEAD";
  }
  return normalized === "/api/auth" || normalized.startsWith("/api/auth/");
}
