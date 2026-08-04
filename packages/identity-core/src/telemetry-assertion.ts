import { createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

export const PRODUCT_ANALYTICS_ASSERTION_AUDIENCE = "telemetry-collector" as const;
export const MAX_PRODUCT_ANALYTICS_ASSERTION_LIFETIME_MS = 15 * 60 * 1000;

export function deriveProductAnalyticsSubject(secret: string, subject: string): string {
  return createHmac("sha256", secret).update(`rudder-telemetry-subject:v1:${subject}`).digest("hex");
}

export function deriveProductAnalyticsInstallationId(secret: string, installationId: string): string {
  return createHmac("sha256", secret).update(`rudder-telemetry-installation:v1:${installationId}`).digest("hex");
}

export type ProductAnalyticsAssertionClaims = {
  version: 1;
  issuer: string;
  audience: typeof PRODUCT_ANALYTICS_ASSERTION_AUDIENCE;
  installationId: string;
  pseudonymousInstallationId: string;
  analyticsSubject: string | null;
  consentVersion: string;
  consentEpoch: number;
  issuedAtMs: number;
  expiresAtMs: number;
  jti: string;
};

type AssertionHeader = { alg: "EdDSA"; typ: "rudder-telemetry-assertion+jwt"; kid: string };

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
}

function encode(value: unknown) {
  return Buffer.from(stableJson(value)).toString("base64url");
}

function decode<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
}

function key(value: KeyObject | string | Buffer, privateKey: boolean) {
  const isKeyObject = typeof value === "object" && value !== null && "type" in value;
  return isKeyObject ? value as KeyObject : privateKey ? createPrivateKey(value) : createPublicKey(value);
}

function assertClaimShape(claims: ProductAnalyticsAssertionClaims) {
  if (claims.version !== 1 || claims.audience !== PRODUCT_ANALYTICS_ASSERTION_AUDIENCE
    || typeof claims.issuer !== "string" || typeof claims.installationId !== "string"
    || typeof claims.pseudonymousInstallationId !== "string" || (claims.analyticsSubject !== null && typeof claims.analyticsSubject !== "string")
    || typeof claims.consentVersion !== "string" || !Number.isInteger(claims.consentEpoch) || claims.consentEpoch < 1
    || !Number.isSafeInteger(claims.issuedAtMs) || !Number.isSafeInteger(claims.expiresAtMs)
    || claims.expiresAtMs <= claims.issuedAtMs || claims.expiresAtMs - claims.issuedAtMs > MAX_PRODUCT_ANALYTICS_ASSERTION_LIFETIME_MS
    || typeof claims.jti !== "string") throw new Error("invalid_telemetry_assertion");
}

export function issueProductAnalyticsAssertion(input: {
  signingPrivateKey: KeyObject | string | Buffer;
  keyId: string;
  issuer: string;
  installationId: string;
  pseudonymousInstallationId: string;
  analyticsSubject?: string | null;
  consentVersion: string;
  consentEpoch: number;
  nowMs: number;
  expiresAtMs?: number;
  jti: string;
}) {
  const claims: ProductAnalyticsAssertionClaims = {
    version: 1,
    issuer: input.issuer,
    audience: PRODUCT_ANALYTICS_ASSERTION_AUDIENCE,
    installationId: input.installationId,
    pseudonymousInstallationId: input.pseudonymousInstallationId,
    analyticsSubject: input.analyticsSubject ?? null,
    consentVersion: input.consentVersion,
    consentEpoch: input.consentEpoch,
    issuedAtMs: input.nowMs,
    expiresAtMs: input.expiresAtMs ?? input.nowMs + MAX_PRODUCT_ANALYTICS_ASSERTION_LIFETIME_MS,
    jti: input.jti,
  };
  assertClaimShape(claims);
  const header: AssertionHeader = { alg: "EdDSA", typ: "rudder-telemetry-assertion+jwt", kid: input.keyId };
  const signingInput = `${encode(header)}.${encode(claims)}`;
  return `${signingInput}.${sign(null, Buffer.from(signingInput), key(input.signingPrivateKey, true)).toString("base64url")}`;
}

export function verifyProductAnalyticsAssertion(input: {
  assertion: string;
  identityPublicKey: KeyObject | string | Buffer;
  expectedKeyId: string;
  expectedIssuer: string;
  expectedInstallationId: string;
  nowMs: number;
  expectedConsentEpoch?: number;
  expectedAnalyticsSubject?: string | null;
}): ProductAnalyticsAssertionClaims {
  const parts = input.assertion.split(".");
  if (parts.length !== 3) throw new Error("invalid_telemetry_assertion");
  const header = decode<AssertionHeader>(parts[0]!);
  const claims = decode<ProductAnalyticsAssertionClaims>(parts[1]!);
  if (header.alg !== "EdDSA" || header.typ !== "rudder-telemetry-assertion+jwt" || header.kid !== input.expectedKeyId) throw new Error("invalid_telemetry_assertion");
  if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key(input.identityPublicKey, false), Buffer.from(parts[2]!, "base64url"))) throw new Error("invalid_telemetry_assertion");
  assertClaimShape(claims);
  if (claims.issuer !== input.expectedIssuer || claims.installationId !== input.expectedInstallationId || claims.expiresAtMs <= input.nowMs || claims.issuedAtMs > input.nowMs + 60_000) throw new Error("invalid_telemetry_assertion");
  if (input.expectedConsentEpoch !== undefined && claims.consentEpoch !== input.expectedConsentEpoch) throw new Error("telemetry_consent_revoked");
  if (input.expectedAnalyticsSubject !== undefined && claims.analyticsSubject !== input.expectedAnalyticsSubject) throw new Error("telemetry_subject_mismatch");
  return claims;
}

export function generateProductAnalyticsAssertionKeyPair() {
  return generateKeyPairSync("ed25519");
}
