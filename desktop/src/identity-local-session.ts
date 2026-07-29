export type DesktopCookieDetails = {
  url: string;
  name: string;
  value: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  expirationDate?: number;
};

function parseSetCookie(raw: string, baseUrl: string): DesktopCookieDetails {
  const parts = raw.split(";").map((part) => part.trim()).filter(Boolean);
  const [pair, ...attributes] = parts;
  const separator = pair?.indexOf("=") ?? -1;
  if (separator <= 0) throw new Error("Local Rudder server did not return a valid session cookie");
  const name = pair!.slice(0, separator);
  if (name !== "better-auth.session_token" && name !== "__Secure-better-auth.session_token") {
    throw new Error("Local Rudder server returned an unexpected session cookie");
  }
  const details: DesktopCookieDetails = {
    url: new URL(baseUrl).origin,
    name,
    value: decodeURIComponent(pair!.slice(separator + 1)),
    path: "/",
    httpOnly: true,
    secure: false,
    sameSite: "lax",
  };
  let hasHttpOnly = false;
  for (const attribute of attributes) {
    const [rawKey, ...rawValue] = attribute.split("=");
    const key = rawKey?.toLowerCase();
    const value = rawValue.join("=");
    if (key === "secure") details.secure = true;
    if (key === "httponly") hasHttpOnly = true;
    if (key === "expires") {
      const expiresAt = Date.parse(value);
      if (!Number.isNaN(expiresAt)) details.expirationDate = expiresAt / 1000;
    }
  }
  if (!hasHttpOnly || details.secure !== name.startsWith("__Secure-")) {
    throw new Error("Local Rudder server returned an invalid session cookie policy");
  }
  return details;
}

export async function establishDesktopLocalSession(options: {
  localApiUrl: string;
  exchangeCode: string;
  fetch?: typeof globalThis.fetch;
  installCookie(details: DesktopCookieDetails): Promise<void>;
}): Promise<void> {
  const request = options.fetch ?? globalThis.fetch;
  const baseUrl = new URL(options.localApiUrl).origin;
  const exchange = await request(new URL("/api/auth/local-exchange", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ exchangeCode: options.exchangeCode }),
  });
  if (!exchange.ok) throw new Error(`Local Rudder account exchange failed (${exchange.status})`);
  const setCookie = exchange.headers.get("set-cookie");
  if (!setCookie) throw new Error("Local Rudder server did not issue a session cookie");
  const cookie = parseSetCookie(setCookie, baseUrl);
  await options.installCookie(cookie);

  const claim = await request(new URL("/api/auth/local-claim", baseUrl), {
    method: "POST",
    headers: { cookie: `${cookie.name}=${encodeURIComponent(cookie.value)}` },
  });
  if (!claim.ok) throw new Error(`Local Rudder legacy claim failed (${claim.status})`);
}

export async function establishDesktopOfflineLocalSession(options: {
  localApiUrl: string;
  credential: DesktopOfflineGrantCredential;
  nowMs?: number;
  fetch?: typeof globalThis.fetch;
  installCookie(details: DesktopCookieDetails): Promise<void>;
  updateTrustedTime(nextTrustedTimeMs: number): void;
}): Promise<void> {
  const request = options.fetch ?? globalThis.fetch;
  const baseUrl = new URL(options.localApiUrl).origin;
  const nowMs = options.nowMs ?? Date.now();
  const proof = createOfflineGrantProof({
    grant: options.credential.grant,
    devicePrivateKey: createPrivateKey({
      key: Buffer.from(options.credential.devicePrivateKeyPkcs8, "base64url"),
      format: "der",
      type: "pkcs8",
    }),
    method: "POST",
    path: "/api/auth/local-offline",
    bodyHash: offlineRequestBodyHash(""),
    nonce: randomBytes(24).toString("base64url"),
    issuedAtMs: nowMs,
  });
  const exchange = await request(new URL("/api/auth/local-offline", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant: options.credential.grant,
      devicePublicKeySpki: options.credential.devicePublicKeySpki,
      proof,
    }),
  });
  if (!exchange.ok) throw new Error(`Local Rudder Offline Grant failed (${exchange.status})`);
  const value = await exchange.json() as { nextTrustedTimeMs?: unknown };
  if (!Number.isSafeInteger(value.nextTrustedTimeMs)) {
    throw new Error("Local Rudder server returned invalid trusted time");
  }
  const setCookie = exchange.headers.get("set-cookie");
  if (!setCookie) throw new Error("Local Rudder server did not issue a session cookie");
  await options.installCookie(parseSetCookie(setCookie, baseUrl));
  options.updateTrustedTime(Number(value.nextTrustedTimeMs));
}

export async function clearDesktopLocalSessionCookies(options: {
  localApiUrl: string;
  removeCookie(url: string, name: string): Promise<void>;
}): Promise<void> {
  const origin = new URL(options.localApiUrl).origin;
  await Promise.all([
    "better-auth.session_token",
    "__Secure-better-auth.session_token",
  ].map((name) => options.removeCookie(origin, name)));
}

export async function revokeDesktopLocalSessions(options: {
  localApiUrl: string;
  fetch?: typeof globalThis.fetch;
  getCookies(url: string): Promise<Array<{ name: string; value: string }>>;
}): Promise<void> {
  const origin = new URL(options.localApiUrl).origin;
  const cookies = await options.getCookies(origin);
  const cookieHeader = cookies
    .filter(({ name }) =>
      name === "better-auth.session_token"
      || name === "__Secure-better-auth.session_token")
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  if (!cookieHeader) throw new Error("Local Rudder session cookie is unavailable");
  const response = await (options.fetch ?? globalThis.fetch)(
    new URL("/api/auth/local-signout-all", options.localApiUrl),
    {
      method: "POST",
      headers: { cookie: cookieHeader },
    },
  );
  if (!response.ok) {
    throw new Error(`Local Rudder session revocation failed (${response.status})`);
  }
}
import {
  createOfflineGrantProof,
  offlineRequestBodyHash,
} from "@rudderhq/identity-core";
import { createPrivateKey, randomBytes } from "node:crypto";
import type { DesktopOfflineGrantCredential } from "./identity-offline-grant.js";
