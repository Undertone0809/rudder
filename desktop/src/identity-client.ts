import type { IdentityCredentialVault, IdentityDeviceCredential } from "./identity-credential-vault.js";
import {
  runDesktopDeviceAuthorization,
  signInWithDesktopIdentityFallback,
  type DesktopDeviceAuthorizationPrompt,
} from "./identity-device-authorization.js";
import type { DesktopSignInHint } from "./identity-ipc.js";
import type { createDesktopOfflineGrantStore } from "./identity-offline-grant.js";
import { createIdentityPkceRequest, openIdentityLoopbackCallback } from "./identity-pkce.js";

const DESKTOP_CLIENT_ID = "rudder-desktop";

export type IdentityAccount = {
  id: string;
  email: string;
  name: string;
  image: string | null;
};

export type IdentityDevice = {
  id: string;
  installationId: string;
  displayName: string;
};

export type DesktopIdentityAuthProviders = {
  google: boolean;
  github: boolean;
};

type IdentityTokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_in?: number;
  account: IdentityAccount;
  device: IdentityDevice;
  offline_grant?: string;
  offline_grant_expires_at?: string;
  offline_grant_key_id?: string;
};

export type DesktopIdentityClientOptions = {
  identityOrigin: string;
  installationId: string;
  deviceName: string;
  vault: Pick<IdentityCredentialVault, "read" | "write" | "clear">;
  openExternal(url: string): Promise<void>;
  fetch?: typeof globalThis.fetch;
  authProviderFallback?: DesktopIdentityAuthProviders;
  devicePublicKeyThumbprint?: string;
  offlineGrantStore?: Pick<
    ReturnType<typeof createDesktopOfflineGrantStore>,
    "prepareDeviceKey" | "acceptGrant" | "signOut"
  >;
  onDeviceAuthorizationPrompt?(prompt: DesktopDeviceAuthorizationPrompt): void;
};

export type IdentityDeviceSession = {
  id: string;
  name: string;
  platform: string | null;
  createdAt: string | null;
  lastSeenAt: string;
  current: boolean;
};

export type ProductAnalyticsAssertionRequest = {
  mode: "anonymous" | "account_linked";
  consentVersion: string;
  consentEpoch: number;
  pseudonymousInstallationId: string;
  consentedLocalUserId?: string | null;
};

export type ProductAnalyticsConsentRequest = {
  mode: "anonymous" | "account_linked";
  decision: "granted" | "revoked";
  consentVersion: string;
};

type DesktopNativeSignInInput =
  | { method: "email_otp"; email: string; token: string }
  | { method: "password"; email: string; password: string }
  | { method: "password_reset"; email: string; token: string; newPassword: string };

function normalizedIdentityOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(
    url.protocol === "http:"
    && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
  )) {
    throw new Error("Rudder Identity must use HTTPS outside local development");
  }
  return url.origin;
}

export function applyDesktopSignInIntent(url: URL, intent: string): URL {
  if (!/^[A-Za-z0-9_-]{32,2048}$/u.test(intent)) {
    throw new Error("Rudder Identity returned an invalid sign-in intent");
  }
  url.searchParams.set("login_intent", intent);
  return url;
}

function parseTokenResponse(value: unknown): IdentityTokenResponse {
  if (!value || typeof value !== "object") throw new Error("Rudder Identity returned an invalid response");
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
    || (typeof account.image !== "string" && account.image !== null)
    || !device
    || typeof device.id !== "string"
    || typeof device.installationId !== "string"
    || typeof device.displayName !== "string"
  ) {
    throw new Error("Rudder Identity returned an invalid response");
  }
  return value as IdentityTokenResponse;
}

function parseIdentityAccount(value: unknown): IdentityAccount {
  if (!value || typeof value !== "object") {
    throw new Error("Rudder Identity returned an invalid account profile");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string"
    || typeof record.email !== "string"
    || typeof record.name !== "string"
    || (typeof record.image !== "string" && record.image !== null)
  ) {
    throw new Error("Rudder Identity returned an invalid account profile");
  }
  return {
    id: record.id,
    email: record.email,
    name: record.name,
    image: record.image,
  };
}

function identityFallbackError(
  code: "PKCE_CALLBACK_UNAVAILABLE" | "EXTERNAL_BROWSER_UNAVAILABLE",
  message: string,
  cause: unknown,
): Error {
  return Object.assign(new Error(message, { cause }), { code });
}

export function createDesktopIdentityClient(options: DesktopIdentityClientOptions) {
  const identityOrigin = normalizedIdentityOrigin(options.identityOrigin);
  const request = options.fetch ?? globalThis.fetch;
  const authProviderFallback = {
    google: options.authProviderFallback?.google === true,
    github: options.authProviderFallback?.github === true,
  };
  const fallbackAuthProviders = (): DesktopIdentityAuthProviders => ({
    google: authProviderFallback.google,
    github: authProviderFallback.github,
  });
  let accessToken: string | null = null;
  let refreshInFlight: Promise<string> | null = null;
  const storedCredential = options.vault.read();
  let latestAccount: IdentityAccount | null = storedCredential?.issuer === identityOrigin
    ? {
      id: storedCredential.accountId,
      email: storedCredential.accountEmail,
      name: storedCredential.accountName,
      image: storedCredential.accountImage ?? null,
    }
    : null;
  const offlineMaterial = () => options.offlineGrantStore?.prepareDeviceKey() ?? null;

  const nativeAuthRequest = (path: string, body: Record<string, unknown>): Promise<Response> =>
    request(new URL(path, identityOrigin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const requireNativeAuthSuccess = async (response: Response, fallback: string): Promise<Record<string, unknown>> => {
    const value = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (response.ok) return value ?? {};
    const messages: Record<string, string> = {
      invalid_credentials: "The email or password is incorrect.",
      invalid_otp: "The verification code is incorrect or expired.",
      otp_expired: "The verification code is incorrect or expired.",
      over_email_send_rate_limit: "Too many email attempts. Try again later.",
      rudder_credential_revocation_pending:
        "The password changed, but security cleanup is still pending. Sign in again shortly.",
    };
    const code = typeof value?.error === "string" ? value.error : "";
    throw new Error(messages[code] ?? `${fallback} (${response.status})`);
  };

  const persistToken = (token: IdentityTokenResponse): string => {
    const now = Date.now();
    const refreshLifetimeSeconds = token.refresh_token_expires_in ?? 30 * 24 * 60 * 60;
    const credential: IdentityDeviceCredential = {
      version: 1,
      issuer: identityOrigin,
      accountId: token.account.id,
      accountEmail: token.account.email,
      accountName: token.account.name,
      accountImage: token.account.image,
      deviceId: token.device.id,
      refreshToken: token.refresh_token,
      refreshTokenExpiresAt: new Date(now + refreshLifetimeSeconds * 1000).toISOString(),
    };
    options.vault.write(credential);
    latestAccount = token.account;
    accessToken = token.access_token;
    return token.access_token;
  };

  const persistAccount = (account: IdentityAccount): IdentityAccount => {
    latestAccount = account;
    const credential = options.vault.read();
    if (
      credential
      && credential.issuer === identityOrigin
      && credential.accountId === account.id
    ) {
      options.vault.write({
        ...credential,
        accountEmail: account.email,
        accountName: account.name,
        accountImage: account.image,
      });
    }
    return account;
  };

  const persistOfflineGrant = async (
    token: IdentityTokenResponse,
    material: ReturnType<typeof offlineMaterial>,
  ): Promise<void> => {
    if (!material || !token.offline_grant) return;
    if (
      typeof token.offline_grant_expires_at !== "string"
      || typeof token.offline_grant_key_id !== "string"
    ) throw new Error("Rudder Identity returned an invalid Offline Grant");
    const keyResponse = await request(new URL("/.well-known/rudder-offline-grant-key", identityOrigin), {
      headers: { accept: "application/json" },
    });
    if (!keyResponse.ok) throw new Error("Rudder Identity Offline Grant key is unavailable");
    const key = await keyResponse.json() as Record<string, unknown>;
    if (
      key.issuer !== identityOrigin
      || key.kid !== token.offline_grant_key_id
      || key.alg !== "EdDSA"
      || typeof key.public_key_spki !== "string"
    ) throw new Error("Rudder Identity returned an invalid Offline Grant trust anchor");
    const expiresAtMs = Date.parse(token.offline_grant_expires_at);
    if (Number.isNaN(expiresAtMs)) throw new Error("Rudder Identity returned an invalid Offline Grant expiry");
    options.offlineGrantStore!.acceptGrant({
      grant: token.offline_grant,
      expiresAtMs,
      keyId: token.offline_grant_key_id,
      identityPublicKeySpki: key.public_key_spki,
      accountId: token.account.id,
      deviceId: token.device.id,
    });
  };

  const refreshAccess = async (): Promise<string> => {
    if (refreshInFlight) return refreshInFlight;
    const credential = options.vault.read();
    if (!credential || credential.issuer !== identityOrigin) {
      throw Object.assign(new Error("Rudder Account is not signed in"), {
        code: "IDENTITY_NOT_SIGNED_IN",
      });
    }
    const pending = (async () => {
      const material = offlineMaterial();
      let response: Response;
      try {
        response = await request(new URL("/api/desktop/refresh", identityOrigin), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            grant_type: "refresh_token",
            client_id: DESKTOP_CLIENT_ID,
            refresh_token: credential.refreshToken,
            sign_out_epoch: material?.localSignOutEpoch ?? 0,
          }),
        });
      } catch (cause) {
        throw Object.assign(
          new Error("Rudder Identity is temporarily unavailable", { cause }),
          { code: "IDENTITY_UNAVAILABLE" },
        );
      }
      if (!response.ok) {
        const errorBody = await response.json().catch(() => null) as { error?: unknown } | null;
        const sessionRejected = response.status === 401
          || (response.status === 400 && errorBody?.error === "invalid_grant");
        if (sessionRejected) {
          if (options.vault.read()?.refreshToken === credential.refreshToken) {
            options.offlineGrantStore?.signOut();
            options.vault.clear();
            accessToken = null;
          }
          throw Object.assign(new Error("Rudder Account session has expired"), {
            code: "IDENTITY_SESSION_REJECTED",
          });
        }
        throw Object.assign(
          new Error(`Rudder Identity is temporarily unavailable (${response.status})`),
          { code: "IDENTITY_UNAVAILABLE" },
        );
      }
      const token = parseTokenResponse(await response.json());
      persistToken(token);
      await persistOfflineGrant(token, material);
      return token.access_token;
    })();
    refreshInFlight = pending;
    try {
      return await pending;
    } finally {
      if (refreshInFlight === pending) refreshInFlight = null;
    }
  };

  const authenticatedRequest = async (
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    if (!accessToken) accessToken = await refreshAccess();
    let response = await request(new URL(path, identityOrigin), {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${accessToken}` },
    });
    if (response.status === 401) {
      accessToken = await refreshAccess();
      response = await request(new URL(path, identityOrigin), {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${accessToken}` },
      });
    }
    return response;
  };

  const nativeSignIn = async (
    path: string,
    body: Record<string, unknown>,
  ): Promise<{
    account: IdentityAccount;
    device: IdentityDevice;
    accessToken: string;
  }> => {
    const material = offlineMaterial();
    const pkce = createIdentityPkceRequest();
    const callback = await openIdentityLoopbackCallback({ expectedState: pkce.state })
      .catch((error: unknown) => {
        throw identityFallbackError(
          "PKCE_CALLBACK_UNAVAILABLE",
          "Unable to open the Rudder sign-in callback",
          error,
        );
      });
    try {
      const authorizeResponse = await nativeAuthRequest(path, {
        ...body,
        client_id: DESKTOP_CLIENT_ID,
        redirect_uri: callback.redirectUri,
        code_challenge: pkce.challenge,
        code_challenge_method: pkce.method,
        audience: options.installationId,
      });
      const authorizeValue = await requireNativeAuthSuccess(
        authorizeResponse,
        "Rudder Identity sign-in authorization failed",
      );
      const code = authorizeValue.code;
      if (typeof code !== "string" || code.length < 16) {
        throw new Error("Rudder Identity returned an invalid sign-in authorization");
      }
      const response = await request(new URL("/api/desktop/token", identityOrigin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          client_id: DESKTOP_CLIENT_ID,
          redirect_uri: callback.redirectUri,
          code_verifier: pkce.verifier,
          installation_id: options.installationId,
          device_name: options.deviceName,
          sign_out_epoch: material?.localSignOutEpoch ?? 0,
          ...(material?.thumbprint || options.devicePublicKeyThumbprint
            ? { device_public_key_thumbprint: material?.thumbprint ?? options.devicePublicKeyThumbprint }
            : {}),
        }),
      });
      if (!response.ok) throw new Error(`Rudder Identity sign-in failed (${response.status})`);
      const token = parseTokenResponse(await response.json());
      persistToken(token);
      await persistOfflineGrant(token, material);
      return {
        account: token.account,
        device: token.device,
        accessToken: token.access_token,
      };
    } finally {
      await callback.close();
    }
  };

  return {
    async getAuthProviders(): Promise<DesktopIdentityAuthProviders> {
      try {
        const response = await request(new URL("/api/health", identityOrigin), {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) {
          console.warn(
            `[rudder-desktop] Identity provider capability probe returned ${response.status}; using fallback`,
          );
          return fallbackAuthProviders();
        }
        const value = await response.json() as {
          providers?: { google?: unknown; github?: unknown };
        };
        return {
          google: typeof value.providers?.google === "boolean"
            ? value.providers.google
            : authProviderFallback.google,
          github: typeof value.providers?.github === "boolean"
            ? value.providers.github
            : authProviderFallback.github,
        };
      } catch (error) {
        console.warn(
          "[rudder-desktop] Identity provider capability probe unavailable; using fallback",
          error,
        );
        return fallbackAuthProviders();
      }
    },

    async createServerExchange(audience: string): Promise<string> {
      if (!audience.trim() || audience.length > 256) {
        throw new Error("Local Rudder server audience is invalid");
      }
      const response = await authenticatedRequest("/api/server/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          installation_id: options.installationId,
          audience,
        }),
      });
      if (!response.ok) {
        throw Object.assign(
          new Error(`Unable to authorize the local Rudder server (${response.status})`),
          { code: response.status === 401 ? "IDENTITY_SESSION_REJECTED" : "IDENTITY_UNAVAILABLE" },
        );
      }
      const value = await response.json() as { code?: unknown };
      if (typeof value.code !== "string" || value.code.length < 16) {
        throw new Error("Rudder Identity returned an invalid server exchange");
      }
      return value.code;
    },

    async issueProductAnalyticsAssertion(input: ProductAnalyticsAssertionRequest): Promise<string> {
      if (!/^[0-9a-f]{64}$/u.test(input.pseudonymousInstallationId)) {
        throw new Error("Product analytics installation pseudonym is invalid");
      }
      const response = await authenticatedRequest("/api/desktop/telemetry/assertion", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          installation_id: options.installationId,
          mode: input.mode,
          consent_version: input.consentVersion,
          pseudonymous_installation_id: input.pseudonymousInstallationId,
          ...(input.mode === "account_linked" && input.consentedLocalUserId ? { consented_local_user_id: input.consentedLocalUserId } : {}),
        }),
      });
      if (!response.ok) {
        throw Object.assign(
          new Error(`Unable to authorize product analytics upload (${response.status})`),
          { code: response.status === 401 ? "IDENTITY_SESSION_REJECTED" : "IDENTITY_UNAVAILABLE" },
        );
      }
      const value = await response.json() as { assertion?: unknown };
      if (typeof value.assertion !== "string" || value.assertion.length < 32) {
        throw new Error("Rudder Identity returned an invalid telemetry assertion");
      }
      return `Bearer ${value.assertion}`;
    },

    async recordProductAnalyticsConsent(input: ProductAnalyticsConsentRequest): Promise<{ consentEpoch: number }> {
      const response = await authenticatedRequest("/api/desktop/telemetry/consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          installation_id: options.installationId,
          mode: input.mode,
          decision: input.decision,
          consent_version: input.consentVersion,
        }),
      });
      if (!response.ok) {
        throw Object.assign(
          new Error(`Unable to record product analytics consent (${response.status})`),
          { code: response.status === 401 ? "IDENTITY_SESSION_REJECTED" : "IDENTITY_UNAVAILABLE" },
        );
      }
      const value = await response.json() as { consentEpoch?: unknown };
      if (!Number.isSafeInteger(value.consentEpoch) || Number(value.consentEpoch) < 1) {
        throw new Error("Rudder Identity returned an invalid telemetry consent");
      }
      return { consentEpoch: Number(value.consentEpoch) };
    },

    async signIn(hint?: DesktopSignInHint): Promise<{
      account: IdentityAccount;
      device: IdentityDevice;
      accessToken: string;
    }> {
      if (hint && hint.method !== "google" && hint.method !== "github") {
        throw new Error("Email and password sign-in must use the native Desktop flow");
      }
      return signInWithDesktopIdentityFallback({
        signInWithPkce: async () => {
          const material = offlineMaterial();
          const pkce = createIdentityPkceRequest();
          const callback = await openIdentityLoopbackCallback({ expectedState: pkce.state })
            .catch((error: unknown) => {
              throw identityFallbackError(
                "PKCE_CALLBACK_UNAVAILABLE",
                "Unable to open the Rudder sign-in callback",
                error,
              );
            });
          try {
            const authorizeUrl = new URL("/api/desktop/authorize", identityOrigin);
            authorizeUrl.searchParams.set("client_id", DESKTOP_CLIENT_ID);
            authorizeUrl.searchParams.set("redirect_uri", callback.redirectUri);
            authorizeUrl.searchParams.set("code_challenge", pkce.challenge);
            authorizeUrl.searchParams.set("code_challenge_method", pkce.method);
            authorizeUrl.searchParams.set("state", pkce.state);
            authorizeUrl.searchParams.set("audience", options.installationId);
            if (hint) {
              const intentResponse = await request(
                new URL("/api/desktop/sign-in-intent", identityOrigin),
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    client_id: DESKTOP_CLIENT_ID,
                    redirect_uri: callback.redirectUri,
                    code_challenge: pkce.challenge,
                    state: pkce.state,
                    method: hint.method,
                    ...(hint.email ? { email: hint.email } : {}),
                  }),
                },
              );
              if (!intentResponse.ok) {
                throw new Error(`Unable to prepare Rudder sign-in (${intentResponse.status})`);
              }
              const intentValue = await intentResponse.json() as { intent?: unknown };
              if (typeof intentValue.intent !== "string") {
                throw new Error("Rudder Identity returned an invalid sign-in intent");
              }
              applyDesktopSignInIntent(authorizeUrl, intentValue.intent);
            }
            // Let the hosted Account page establish the browser session before
            // continuing to the Desktop authorization endpoint. The latter
            // intentionally requires an active browser session and otherwise
            // returns `Auth session missing` instead of starting OAuth itself.
            const loginUrl = new URL("/", identityOrigin);
            loginUrl.searchParams.set(
              "next",
              `${authorizeUrl.pathname}${authorizeUrl.search}`,
            );
            await options.openExternal(loginUrl.toString()).catch((error: unknown) => {
              throw identityFallbackError(
                "EXTERNAL_BROWSER_UNAVAILABLE",
                "Unable to open the Rudder sign-in browser",
                error,
              );
            });

            const code = await callback.waitForCode;
            const response = await request(new URL("/api/desktop/token", identityOrigin), {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                grant_type: "authorization_code",
                code,
                client_id: DESKTOP_CLIENT_ID,
                redirect_uri: callback.redirectUri,
                code_verifier: pkce.verifier,
                installation_id: options.installationId,
                device_name: options.deviceName,
                sign_out_epoch: material?.localSignOutEpoch ?? 0,
                ...(material?.thumbprint || options.devicePublicKeyThumbprint
                  ? { device_public_key_thumbprint: material?.thumbprint ?? options.devicePublicKeyThumbprint }
                  : {}),
              }),
            });
            if (!response.ok) throw new Error(`Rudder Identity sign-in failed (${response.status})`);
            const token = parseTokenResponse(await response.json());
            persistToken(token);
            await persistOfflineGrant(token, material);
            return {
              account: token.account,
              device: token.device,
              accessToken: token.access_token,
            };
          } finally {
            await callback.close();
          }
        },
        signInWithDeviceAuthorization: async () => {
          const material = offlineMaterial();
          const result = await runDesktopDeviceAuthorization({
            identityOrigin,
            installationId: options.installationId,
            deviceName: options.deviceName,
            devicePublicKeyThumbprint: material?.thumbprint ?? options.devicePublicKeyThumbprint,
            localSignOutEpoch: material?.localSignOutEpoch ?? 0,
            openExternal: async (url) => {
              try {
                await options.openExternal(url);
              } catch (error) {
                if (!options.onDeviceAuthorizationPrompt) {
                  throw identityFallbackError(
                    "EXTERNAL_BROWSER_UNAVAILABLE",
                    "Unable to open the Rudder device approval page",
                    error,
                  );
                }
              }
            },
            onPrompt: options.onDeviceAuthorizationPrompt,
            fetch: request,
          });
          const token: IdentityTokenResponse = {
            access_token: result.accessToken,
            token_type: "Bearer",
            expires_in: result.expiresIn,
            refresh_token: result.refreshToken,
            refresh_token_expires_in: result.refreshTokenExpiresIn,
            account: result.account,
            device: result.device,
            offline_grant: result.offlineGrant,
            offline_grant_expires_at: result.offlineGrantExpiresAt,
            offline_grant_key_id: result.offlineGrantKeyId,
          };
          persistToken(token);
          await persistOfflineGrant(token, material);
          return {
            account: result.account,
            device: result.device,
            accessToken: result.accessToken,
          };
        },
      });
    },

    async sendEmailOtp(email: string): Promise<void> {
      const response = await nativeAuthRequest("/api/desktop/native-auth/email-otp/send", {
        client_id: DESKTOP_CLIENT_ID,
        email,
      });
      await requireNativeAuthSuccess(response, "Unable to send the email code");
    },

    async requestPasswordReset(email: string): Promise<void> {
      const response = await nativeAuthRequest("/api/desktop/native-auth/password/reset/request", {
        client_id: DESKTOP_CLIENT_ID,
        email,
      });
      await requireNativeAuthSuccess(response, "Unable to request a password reset");
    },

    async nativeSignIn(input: DesktopNativeSignInInput): Promise<{
      account: IdentityAccount;
      device: IdentityDevice;
      accessToken: string;
    }> {
      return input.method === "email_otp"
        ? nativeSignIn("/api/desktop/native-auth/email-otp/verify", {
          email: input.email,
          token: input.token,
        })
        : input.method === "password"
          ? nativeSignIn("/api/desktop/native-auth/password/sign-in", {
            email: input.email,
            password: input.password,
          })
          : nativeSignIn("/api/desktop/native-auth/password/reset/confirm", {
            email: input.email,
            token: input.token,
            newPassword: input.newPassword,
          });
    },

    async listDeviceSessions(): Promise<IdentityDeviceSession[]> {
      const response = await authenticatedRequest("/api/account/devices");
      if (!response.ok) throw new Error(`Unable to load Rudder Account devices (${response.status})`);
      const value = await response.json() as { devices?: unknown };
      if (!Array.isArray(value.devices)) throw new Error("Rudder Identity returned an invalid device list");
      return value.devices.map((device): IdentityDeviceSession => {
        if (!device || typeof device !== "object") {
          throw new Error("Rudder Identity returned an invalid device list");
        }
        const record = device as Record<string, unknown>;
        if (
          typeof record.id !== "string"
          || typeof record.displayName !== "string"
          || typeof record.lastSeenAt !== "string"
          || Number.isNaN(Date.parse(record.lastSeenAt))
          || (record.createdAt !== null && typeof record.createdAt !== "string")
          || (record.revokedAt !== null && record.revokedAt !== undefined)
        ) throw new Error("Rudder Identity returned an invalid device list");
        return {
          id: record.id,
          name: record.displayName,
          platform: null,
          createdAt: record.createdAt,
          lastSeenAt: record.lastSeenAt,
          current: record.current === true,
        };
      });
    },

    async revokeDeviceSession(deviceId: string): Promise<void> {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(deviceId)) throw new Error("Rudder Account device id is invalid");
      const response = await authenticatedRequest(`/api/account/devices/${encodeURIComponent(deviceId)}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(`Unable to revoke Rudder Account device (${response.status})`);
      if (options.vault.read()?.deviceId === deviceId) {
        options.vault.clear();
        accessToken = null;
      }
    },

    async getProfile(): Promise<IdentityAccount> {
      const response = await authenticatedRequest("/api/account/profile");
      if (response.status === 404 && latestAccount) return latestAccount;
      if (!response.ok) throw new Error(`Unable to load Rudder Account profile (${response.status})`);
      return persistAccount(parseIdentityAccount(await response.json()));
    },

    async updateProfile(input: { image: string | null }): Promise<IdentityAccount> {
      const response = await authenticatedRequest("/api/account/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image: input.image }),
      });
      if (!response.ok) {
        const value = await response.json().catch(() => null) as { error?: unknown } | null;
        const message = typeof value?.error === "string" ? value.error : `Request failed (${response.status})`;
        throw new Error(message);
      }
      return persistAccount(parseIdentityAccount(await response.json()));
    },

    async signOut(): Promise<void> {
      const deviceId = options.vault.read()?.deviceId;
      try {
        if (deviceId) await this.revokeDeviceSession(deviceId);
      } catch {
        // Signing out locally must remain available while Identity is offline.
      } finally {
        accessToken = null;
        const cleanupErrors: unknown[] = [];
        try {
          options.offlineGrantStore?.signOut();
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          options.vault.clear();
        } catch (error) {
          cleanupErrors.push(error);
        }
        if (cleanupErrors.length > 0) {
          console.warn(
            "[rudder-desktop] local account credentials could not be fully removed",
            ...cleanupErrors,
          );
        }
      }
    },
  };
}
