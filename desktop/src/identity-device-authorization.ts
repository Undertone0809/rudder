import type { IdentityAccount, IdentityDevice } from "./identity-client.js";

const DESKTOP_CLIENT_ID = "rudder-desktop";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export type DesktopDeviceAuthorizationPrompt = {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: string;
};

export type DesktopDeviceAuthorizationResult = {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresIn?: number;
  expiresIn: number;
  account: IdentityAccount;
  device: IdentityDevice;
  offlineGrant?: string;
  offlineGrantExpiresAt?: string;
  offlineGrantKeyId?: string;
};

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

function parseDeviceCodeResponse(value: unknown): DeviceCodeResponse {
  if (!value || typeof value !== "object") throw new Error("Rudder Identity returned an invalid device code");
  const record = value as Record<string, unknown>;
  if (
    typeof record.device_code !== "string"
    || typeof record.user_code !== "string"
    || typeof record.verification_uri !== "string"
    || typeof record.verification_uri_complete !== "string"
    || typeof record.expires_in !== "number"
    || typeof record.interval !== "number"
    || record.expires_in <= 0
    || record.expires_in > 15 * 60
    || record.interval < 1
    || record.interval > 30
  ) throw new Error("Rudder Identity returned an invalid device code");
  return value as DeviceCodeResponse;
}

function requireSameIdentityOrigin(value: string, identityOrigin: string): string {
  const url = new URL(value, identityOrigin);
  if (url.origin !== identityOrigin) {
    throw new Error("Rudder Identity returned an untrusted device approval URL");
  }
  return url.toString();
}

function parseDeviceSession(value: unknown): DesktopDeviceAuthorizationResult {
  if (!value || typeof value !== "object") throw new Error("Rudder Identity returned an invalid device session");
  const record = value as Record<string, unknown>;
  const account = record.account as Record<string, unknown> | undefined;
  const device = record.device as Record<string, unknown> | undefined;
  if (
    typeof record.access_token !== "string"
    || record.token_type !== "Bearer"
    || typeof record.expires_in !== "number"
    || typeof record.refresh_token !== "string"
    || !account
    || typeof account.id !== "string"
    || typeof account.email !== "string"
    || typeof account.name !== "string"
    || !device
    || typeof device.id !== "string"
    || typeof device.installationId !== "string"
    || typeof device.displayName !== "string"
  ) throw new Error("Rudder Identity returned an invalid device session");
  return {
    accessToken: record.access_token,
    refreshToken: record.refresh_token,
    refreshTokenExpiresIn:
      typeof record.refresh_token_expires_in === "number" ? record.refresh_token_expires_in : undefined,
    expiresIn: record.expires_in,
    account: {
      id: account.id,
      email: account.email,
      name: account.name,
      image: typeof account.image === "string" ? account.image : null,
    },
    device: {
      id: device.id,
      installationId: device.installationId,
      displayName: device.displayName,
    },
    offlineGrant: typeof record.offline_grant === "string" ? record.offline_grant : undefined,
    offlineGrantExpiresAt:
      typeof record.offline_grant_expires_at === "string" ? record.offline_grant_expires_at : undefined,
    offlineGrantKeyId:
      typeof record.offline_grant_key_id === "string" ? record.offline_grant_key_id : undefined,
  };
}

function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Device authorization was cancelled"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Device authorization was cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runDesktopDeviceAuthorization(options: {
  identityOrigin: string;
  installationId: string;
  deviceName: string;
  devicePublicKeyThumbprint?: string;
  signOutEpoch?: number;
  openExternal(url: string): Promise<void>;
  onPrompt?(prompt: DesktopDeviceAuthorizationPrompt): void;
  fetch?: typeof globalThis.fetch;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<DesktopDeviceAuthorizationResult> {
  const identityOrigin = new URL(options.identityOrigin).origin;
  const request = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const codeResponse = await request(new URL("/api/auth/device/code", identityOrigin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: DESKTOP_CLIENT_ID,
      scope: "rudder.identity.device",
    }),
    signal: options.signal,
  });
  if (!codeResponse.ok) throw new Error(`Rudder Identity device authorization failed (${codeResponse.status})`);
  const code = parseDeviceCodeResponse(await codeResponse.json());
  const verificationUri = requireSameIdentityOrigin(code.verification_uri, identityOrigin);
  const verificationUriComplete = requireSameIdentityOrigin(code.verification_uri_complete, identityOrigin);
  const deadline = now() + code.expires_in * 1000;
  const prompt: DesktopDeviceAuthorizationPrompt = {
    userCode: code.user_code,
    verificationUri,
    verificationUriComplete,
    expiresAt: new Date(deadline).toISOString(),
  };
  options.onPrompt?.(prompt);
  try {
    await options.openExternal(verificationUriComplete);
  } catch (error) {
    // A surfaced prompt lets Desktop display/copy the URL and user code even
    // when the OS browser handoff is unavailable. Without that UI contract,
    // fail instead of polling a request the user cannot approve.
    if (!options.onPrompt) throw error;
  }

  let intervalMs = code.interval * 1000;
  while (now() < deadline) {
    await sleep(intervalMs, options.signal);
    if (now() >= deadline) break;
    const tokenResponse = await request(new URL("/api/auth/device/token", identityOrigin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: DEVICE_GRANT_TYPE,
        device_code: code.device_code,
        client_id: DESKTOP_CLIENT_ID,
      }),
      signal: options.signal,
    });
    const tokenBody = await tokenResponse.json().catch(() => ({})) as Record<string, unknown>;
    if (!tokenResponse.ok) {
      if (tokenBody.error === "authorization_pending") continue;
      if (tokenBody.error === "slow_down") {
        intervalMs += 5_000;
        continue;
      }
      if (tokenBody.error === "access_denied") throw new Error("Rudder Account device authorization was denied");
      if (tokenBody.error === "expired_token") throw new Error("Rudder Account device authorization expired");
      throw new Error("Rudder Account device authorization failed");
    }
    if (typeof tokenBody.access_token !== "string" || tokenBody.token_type !== "Bearer") {
      throw new Error("Rudder Identity returned an invalid device authorization token");
    }

    // The RFC 8628 token proves the approved Better Auth user. This final
    // exchange registers the same installation in Rudder's identityDevices
    // registry and returns the normal device access/refresh credential pair.
    const sessionResponse = await request(new URL("/api/desktop/device-session", identityOrigin), {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenBody.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        client_id: DESKTOP_CLIENT_ID,
        installation_id: options.installationId,
        device_name: options.deviceName,
        sign_out_epoch: options.signOutEpoch ?? 0,
        ...(options.devicePublicKeyThumbprint
          ? { device_public_key_thumbprint: options.devicePublicKeyThumbprint }
          : {}),
      }),
      signal: options.signal,
    });
    if (!sessionResponse.ok) {
      throw new Error(`Rudder Identity device registration failed (${sessionResponse.status})`);
    }
    return parseDeviceSession(await sessionResponse.json());
  }
  throw new Error("Rudder Account device authorization timed out");
}

export function shouldFallbackToDeviceAuthorization(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return (
    code === "PKCE_CALLBACK_UNAVAILABLE"
    || code === "EXTERNAL_BROWSER_UNAVAILABLE"
    || error.message === "Rudder sign-in timed out"
    || error.message === "Unable to open the Rudder sign-in callback"
  );
}

export async function signInWithDesktopIdentityFallback<T>(options: {
  signInWithPkce(): Promise<T>;
  signInWithDeviceAuthorization(): Promise<T>;
}): Promise<T> {
  try {
    return await options.signInWithPkce();
  } catch (error) {
    if (!shouldFallbackToDeviceAuthorization(error)) throw error;
    return options.signInWithDeviceAuthorization();
  }
}
