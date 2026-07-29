import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  sign,
  verify,
} from "node:crypto";

export const MAX_OFFLINE_GRANT_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const CLOCK_ROLLBACK_TOLERANCE_MS = 5 * 60 * 1000;
const PROOF_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_TOKEN_BYTES = 32 * 1024;

type OfflineGrantHeader = {
  alg: "EdDSA";
  typ: "rudder-offline-grant+jwt";
  kid: string;
};

export type OfflineGrantClaims = {
  version: 1;
  issuer: string;
  accountId: string;
  deviceId: string;
  installationId: string;
  audience: "rudder-local-board";
  publicKeyThumbprint: string;
  issuedAtMs: number;
  expiresAtMs: number;
  trustedTimeMs: number;
  signOutEpoch: number;
  jti: string;
};

export type OfflineGrantProof = {
  payload: {
    version: 1;
    grantHash: string;
    method: string;
    path: string;
    bodyHash: string;
    nonce: string;
    issuedAtMs: number;
  };
  signature: string;
};

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid_encoding");
  return Buffer.from(value, "base64url");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function requirePrivateKey(value: KeyObject | string | Buffer): KeyObject {
  return value instanceof KeyObject ? value : createPrivateKey(value);
}

function requirePublicKey(value: KeyObject | string | Buffer): KeyObject {
  return value instanceof KeyObject ? value : createPublicKey(value);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function assertSafeString(value: unknown, label: string, max = 512): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`invalid_${label}`);
  }
}

function assertNonce(value: unknown): asserts value is string {
  if (
    typeof value !== "string"
    || value.length < 16
    || value.length > 256
    || !/^[A-Za-z0-9_-]+$/.test(value)
  ) throw new Error("invalid_nonce");
}

function parseClaims(value: unknown): OfflineGrantClaims {
  if (!value || typeof value !== "object") throw new Error("invalid_offline_grant");
  const claims = value as Record<string, unknown>;
  if (
    claims.version !== 1
    || claims.audience !== "rudder-local-board"
    || !Number.isSafeInteger(claims.issuedAtMs)
    || !Number.isSafeInteger(claims.expiresAtMs)
    || !Number.isSafeInteger(claims.trustedTimeMs)
    || !Number.isSafeInteger(claims.signOutEpoch)
    || Number(claims.signOutEpoch) < 0
  ) throw new Error("invalid_offline_grant");
  assertSafeString(claims.issuer, "issuer");
  assertSafeString(claims.accountId, "account_id");
  assertSafeString(claims.deviceId, "device_id");
  assertSafeString(claims.installationId, "installation_id");
  assertSafeString(claims.publicKeyThumbprint, "public_key_thumbprint");
  assertSafeString(claims.jti, "jti");
  return claims as OfflineGrantClaims;
}

export function generateOfflineDeviceKeyPair(): { privateKey: KeyObject; publicKey: KeyObject; thumbprint: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey, thumbprint: offlineDevicePublicKeyThumbprint(publicKey) };
}

export function offlineDevicePublicKeyThumbprint(publicKey: KeyObject | string | Buffer): string {
  const jwk = requirePublicKey(publicKey).export({ format: "jwk" });
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new Error("Offline device keys must use Ed25519");
  }
  return sha256(stableJson({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }));
}

export function issueOfflineGrant(input: {
  signingPrivateKey: KeyObject | string | Buffer;
  keyId: string;
  issuer: string;
  accountId: string;
  deviceId: string;
  installationId: string;
  publicKeyThumbprint: string;
  nowMs: number;
  expiresAtMs?: number;
  trustedTimeMs: number;
  signOutEpoch: number;
  jti: string;
}): string {
  const expiresAtMs = input.expiresAtMs ?? input.nowMs + MAX_OFFLINE_GRANT_LIFETIME_MS;
  if (
    !Number.isSafeInteger(input.nowMs)
    || !Number.isSafeInteger(expiresAtMs)
    || expiresAtMs <= input.nowMs
    || expiresAtMs - input.nowMs > MAX_OFFLINE_GRANT_LIFETIME_MS
    || !Number.isSafeInteger(input.trustedTimeMs)
    || input.trustedTimeMs > input.nowMs
    || !Number.isSafeInteger(input.signOutEpoch)
    || input.signOutEpoch < 0
  ) throw new Error("invalid_offline_grant_lifetime");
  for (const [label, value] of [
    ["key_id", input.keyId],
    ["issuer", input.issuer],
    ["account_id", input.accountId],
    ["device_id", input.deviceId],
    ["installation_id", input.installationId],
    ["public_key_thumbprint", input.publicKeyThumbprint],
    ["jti", input.jti],
  ] as const) assertSafeString(value, label);

  const header: OfflineGrantHeader = {
    alg: "EdDSA",
    typ: "rudder-offline-grant+jwt",
    kid: input.keyId,
  };
  const claims: OfflineGrantClaims = {
    version: 1,
    issuer: input.issuer,
    accountId: input.accountId,
    deviceId: input.deviceId,
    installationId: input.installationId,
    audience: "rudder-local-board",
    publicKeyThumbprint: input.publicKeyThumbprint,
    issuedAtMs: input.nowMs,
    expiresAtMs,
    trustedTimeMs: input.trustedTimeMs,
    signOutEpoch: input.signOutEpoch,
    jti: input.jti,
  };
  const signingInput = `${base64url(stableJson(header))}.${base64url(stableJson(claims))}`;
  const signature = sign(null, Buffer.from(signingInput), requirePrivateKey(input.signingPrivateKey));
  return `${signingInput}.${base64url(signature)}`;
}

export function verifyOfflineGrant(input: {
  grant: string;
  identityPublicKey: KeyObject | string | Buffer;
  expectedKeyId: string;
  expectedIssuer: string;
  expectedInstallationId: string;
  expectedDeviceId?: string;
  expectedAccountId?: string;
  nowMs: number;
  lastTrustedTimeMs: number;
  localSignOutEpoch: number;
}): OfflineGrantClaims {
  if (
    !Number.isSafeInteger(input.nowMs)
    || !Number.isSafeInteger(input.lastTrustedTimeMs)
    || !Number.isSafeInteger(input.localSignOutEpoch)
    || input.localSignOutEpoch < 0
  ) throw new Error("invalid_offline_verification_state");
  if (Buffer.byteLength(input.grant, "utf8") > MAX_TOKEN_BYTES) throw new Error("invalid_offline_grant");
  const parts = input.grant.split(".");
  if (parts.length !== 3) throw new Error("invalid_offline_grant");
  let headerValue: unknown;
  let claimsValue: unknown;
  try {
    headerValue = JSON.parse(decodeBase64url(parts[0]).toString("utf8"));
    claimsValue = JSON.parse(decodeBase64url(parts[1]).toString("utf8"));
  } catch {
    throw new Error("invalid_offline_grant");
  }
  const header = headerValue as Partial<OfflineGrantHeader>;
  if (
    header.alg !== "EdDSA"
    || header.typ !== "rudder-offline-grant+jwt"
    || header.kid !== input.expectedKeyId
  ) throw new Error("invalid_offline_grant_header");
  const signatureValid = verify(
    null,
    Buffer.from(`${parts[0]}.${parts[1]}`),
    requirePublicKey(input.identityPublicKey),
    decodeBase64url(parts[2]),
  );
  if (!signatureValid) throw new Error("invalid_offline_grant_signature");

  const claims = parseClaims(claimsValue);
  if (
    claims.issuer !== input.expectedIssuer
    || claims.installationId !== input.expectedInstallationId
    || (input.expectedDeviceId !== undefined && claims.deviceId !== input.expectedDeviceId)
    || (input.expectedAccountId !== undefined && claims.accountId !== input.expectedAccountId)
  ) throw new Error("offline_grant_binding_mismatch");
  if (
    claims.expiresAtMs <= claims.issuedAtMs
    || claims.expiresAtMs - claims.issuedAtMs > MAX_OFFLINE_GRANT_LIFETIME_MS
  ) throw new Error("offline_grant_expired");
  if (
    input.nowMs + CLOCK_ROLLBACK_TOLERANCE_MS
    < Math.max(claims.trustedTimeMs, input.lastTrustedTimeMs)
  ) throw new Error("offline_clock_rollback");
  if (
    input.nowMs < claims.issuedAtMs - PROOF_CLOCK_SKEW_MS
    || input.nowMs >= claims.expiresAtMs
  ) throw new Error("offline_grant_expired");
  if (input.localSignOutEpoch > claims.signOutEpoch) throw new Error("offline_grant_signed_out");
  return claims;
}

export function createOfflineGrantProof(input: {
  grant: string;
  devicePrivateKey: KeyObject | string | Buffer;
  method: string;
  path: string;
  bodyHash: string;
  nonce: string;
  issuedAtMs: number;
}): OfflineGrantProof {
  assertSafeString(input.method, "method", 16);
  assertSafeString(input.path, "path", 2048);
  assertSafeString(input.bodyHash, "body_hash", 128);
  assertNonce(input.nonce);
  const payload: OfflineGrantProof["payload"] = {
    version: 1,
    grantHash: sha256(input.grant),
    method: input.method.toUpperCase(),
    path: input.path,
    bodyHash: input.bodyHash,
    nonce: input.nonce,
    issuedAtMs: input.issuedAtMs,
  };
  const signature = sign(null, Buffer.from(stableJson(payload)), requirePrivateKey(input.devicePrivateKey));
  return { payload, signature: base64url(signature) };
}

export function verifyOfflineGrantAndProof(input: {
  grant: string;
  proof: OfflineGrantProof;
  identityPublicKey: KeyObject | string | Buffer;
  expectedKeyId: string;
  devicePublicKey: KeyObject | string | Buffer;
  expectedIssuer: string;
  expectedInstallationId: string;
  expectedDeviceId?: string;
  expectedAccountId?: string;
  expectedMethod: string;
  expectedPath: string;
  expectedBodyHash: string;
  nowMs: number;
  lastTrustedTimeMs: number;
  localSignOutEpoch: number;
  consumeNonce(nonce: string): boolean;
}): { claims: OfflineGrantClaims; nextTrustedTimeMs: number } {
  const claims = verifyOfflineGrant(input);
  if (offlineDevicePublicKeyThumbprint(input.devicePublicKey) !== claims.publicKeyThumbprint) {
    throw new Error("offline_device_key_mismatch");
  }
  const proof = input.proof;
  if (
    !proof
    || proof.payload?.version !== 1
    || proof.payload.grantHash !== sha256(input.grant)
    || proof.payload.method !== input.expectedMethod.toUpperCase()
    || proof.payload.path !== input.expectedPath
    || proof.payload.bodyHash !== input.expectedBodyHash
    || !Number.isSafeInteger(proof.payload.issuedAtMs)
    || Math.abs(input.nowMs - proof.payload.issuedAtMs) > PROOF_CLOCK_SKEW_MS
  ) throw new Error("invalid_offline_proof");
  assertNonce(proof.payload.nonce);
  let signature: Buffer;
  try {
    signature = decodeBase64url(proof.signature);
  } catch {
    throw new Error("invalid_offline_proof");
  }
  if (!verify(
    null,
    Buffer.from(stableJson(proof.payload)),
    requirePublicKey(input.devicePublicKey),
    signature,
  )) throw new Error("invalid_offline_proof_signature");
  if (!input.consumeNonce(proof.payload.nonce)) throw new Error("offline_proof_replay");
  return {
    claims,
    nextTrustedTimeMs: Math.max(input.nowMs, input.lastTrustedTimeMs, claims.trustedTimeMs),
  };
}

export function offlineRequestBodyHash(body: Buffer | string): string {
  return sha256(body);
}
