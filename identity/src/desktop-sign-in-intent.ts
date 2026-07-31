import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

export type DesktopSignInMethod =
  | "google"
  | "github"
  | "email_otp"
  | "password"
  | "password_reset";

type DesktopSignInIntent = {
  clientId: string;
  codeChallenge: string;
  email?: string;
  expiresAt: number;
  method: DesktopSignInMethod;
  redirectUri: string;
  state: string;
};

const INTENT_TTL_MS = 5 * 60 * 1_000;
const METHODS = new Set<DesktopSignInMethod>([
  "google",
  "github",
  "email_otp",
  "password",
  "password_reset",
]);

function encryptionKey(secret: string): Buffer {
  return createHash("sha256").update(`rudder-desktop-sign-in-intent:${secret}`).digest();
}

function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

export function createDesktopSignInIntent(input: {
  clientId: string;
  codeChallenge: string;
  email?: string;
  method: DesktopSignInMethod;
  now?: number;
  redirectUri: string;
  secret: string;
  state: string;
}): string {
  if (
    !METHODS.has(input.method)
    || input.clientId.length < 1
    || input.clientId.length > 128
    || !/^[A-Za-z0-9_-]{43,128}$/u.test(input.codeChallenge)
    || input.state.length < 16
    || input.state.length > 512
    || (input.email !== undefined && !validEmail(input.email))
  ) {
    throw new Error("invalid_request");
  }
  const payload: DesktopSignInIntent = {
    clientId: input.clientId,
    codeChallenge: input.codeChallenge,
    expiresAt: (input.now ?? Date.now()) + INTENT_TTL_MS,
    method: input.method,
    redirectUri: input.redirectUri,
    state: input.state,
    ...(input.email ? { email: input.email.toLowerCase() } : {}),
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(input.secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

export function resolveDesktopSignInIntent(input: {
  clientId: string;
  codeChallenge: string;
  intent: string;
  now?: number;
  redirectUri: string;
  secret: string;
  state: string;
}): { email?: string; method: DesktopSignInMethod } {
  try {
    const encoded = Buffer.from(input.intent, "base64url");
    if (encoded.length < 29 || encoded.length > 2_048) throw new Error("invalid_request");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(input.secret),
      encoded.subarray(0, 12),
    );
    decipher.setAuthTag(encoded.subarray(12, 28));
    const plaintext = Buffer.concat([
      decipher.update(encoded.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
    const value = JSON.parse(plaintext) as Partial<DesktopSignInIntent>;
    const now = input.now ?? Date.now();
    if (
      !value.method
      || !METHODS.has(value.method)
      || typeof value.expiresAt !== "number"
      || value.expiresAt < now
      || value.expiresAt > now + INTENT_TTL_MS
      || value.clientId !== input.clientId
      || value.codeChallenge !== input.codeChallenge
      || value.redirectUri !== input.redirectUri
      || value.state !== input.state
      || (value.email !== undefined && (typeof value.email !== "string" || !validEmail(value.email)))
    ) {
      throw new Error("invalid_request");
    }
    return {
      method: value.method,
      ...(value.email ? { email: value.email } : {}),
    };
  } catch {
    throw new Error("invalid_request");
  }
}
