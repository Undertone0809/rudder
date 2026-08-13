import { createPublicKey, verify } from "node:crypto";

export type DesktopUpdatePolicyRelease = {
  version: string;
  assetName: string;
  assetSha256: string;
  releaseDigest: string;
  revoked?: boolean;
};

export type DesktopUpdatePolicyPayload = {
  schema: 1;
  sequence: number;
  keyId: string;
  issuedAt: string;
  expiresAt: string;
  channel: "stable" | "canary";
  platform: "darwin";
  arch: string;
  minSafeVersion?: string;
  releases: DesktopUpdatePolicyRelease[];
};

export type SignedDesktopUpdatePolicy = {
  payload: DesktopUpdatePolicyPayload;
  signature: string;
};

export type DesktopUpdatePolicyTrust = {
  /** PEM or DER public keys keyed by the policy's immutable key id. */
  keys: Readonly<Record<string, string | Buffer>>;
  highestAcceptedSequence?: number;
  now?: Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/iu.test(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function decodeSignature(value: string): Buffer | null {
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === 64 ? decoded : null;
  } catch {
    return null;
  }
}

export function verifyDesktopUpdatePolicy(
  envelope: unknown,
  trust: DesktopUpdatePolicyTrust,
): { ok: true; policy: DesktopUpdatePolicyPayload } | { ok: false; reason: string } {
  if (!isRecord(envelope) || !isRecord(envelope.payload) || typeof envelope.signature !== "string") {
    return { ok: false, reason: "malformed_policy" };
  }
  const payload = envelope.payload as Partial<DesktopUpdatePolicyPayload>;
  if (
    payload.schema !== 1
    || typeof payload.sequence !== "number"
    || !Number.isSafeInteger(payload.sequence)
    || payload.sequence < 0
    || typeof payload.keyId !== "string"
    || !isIsoDate(payload.issuedAt)
    || !isIsoDate(payload.expiresAt)
    || (payload.channel !== "stable" && payload.channel !== "canary")
    || payload.platform !== "darwin"
    || typeof payload.arch !== "string"
    || !Array.isArray(payload.releases)
    || payload.releases.length > 100
  ) {
    return { ok: false, reason: "invalid_policy_fields" };
  }

  const now = (trust.now ?? new Date()).getTime();
  if (Date.parse(payload.issuedAt) > now || Date.parse(payload.expiresAt) <= now) {
    return { ok: false, reason: "policy_expired_or_not_yet_valid" };
  }
  if (payload.sequence <= (trust.highestAcceptedSequence ?? -1)) {
    return { ok: false, reason: "policy_sequence_replay" };
  }

  const key = trust.keys[payload.keyId];
  const signature = decodeSignature(envelope.signature);
  if (!key || !signature) return { ok: false, reason: "unknown_policy_key_or_signature" };
  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = Buffer.isBuffer(key)
      ? createPublicKey({ key, format: "der", type: "spki" })
      : createPublicKey(key);
  } catch {
    return { ok: false, reason: "invalid_policy_key" };
  }
  if (!verify(null, Buffer.from(canonicalize(payload), "utf8"), publicKey, signature)) {
    return { ok: false, reason: "invalid_policy_signature" };
  }

  for (const release of payload.releases) {
    if (
      !isRecord(release)
      || typeof release.version !== "string"
      || typeof release.assetName !== "string"
      || !isSha256(release.assetSha256)
      || !isSha256(release.releaseDigest)
      || release.assetName.includes("/")
  ) {
      return { ok: false, reason: "invalid_release_binding" };
    }
  }
  return { ok: true, policy: payload as DesktopUpdatePolicyPayload };
}

export function findAuthorizedDesktopRelease(
  policy: DesktopUpdatePolicyPayload,
  input: { version: string; assetName: string; assetSha256: string; releaseDigest: string },
): DesktopUpdatePolicyRelease | null {
  const release = policy.releases.find((item) =>
    item.version === input.version
    && item.assetName === input.assetName
    && item.assetSha256.toLowerCase() === input.assetSha256.toLowerCase()
    && item.releaseDigest.toLowerCase() === input.releaseDigest.toLowerCase(),
  );
  return release && !release.revoked ? release : null;
}
