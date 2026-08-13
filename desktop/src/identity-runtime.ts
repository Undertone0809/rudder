import { app, ipcMain, session, shell } from "electron";
import { randomBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDesktopIdentityClient, type DesktopIdentityAuthProviders } from "./identity-client.js";
import {
  createIdentityCredentialVault,
  type IdentitySafeStorage,
} from "./identity-credential-vault.js";
import {
  createDesktopIdentityIpcController,
  registerDesktopIdentityIpcHandlers,
  resolveDesktopIdentityOrigin,
} from "./identity-ipc.js";
import {
  clearDesktopLocalSessionCookies,
  establishDesktopLocalSession,
  establishDesktopOfflineLocalSession,
  revokeDesktopLocalSessions,
} from "./identity-local-session.js";
import {
  createDesktopOfflineGrantStore,
  type DesktopOfflineGrantCredential,
} from "./identity-offline-grant.js";
import { resolveDesktopIdentitySafeStorage } from "./identity-safe-storage-policy.js";
import {
  createDesktopIdentitySessionStore,
  desktopIdentityMemoryFallbackAllowed,
} from "./identity-session-store.js";
import { desktopAccountBypassAllowed } from "./identity-startup-policy.js";
import { loadOrCreateDesktopTelemetryState } from "./product-analytics-telemetry.js";

export type DesktopLocalAccountAuth = {
  identityOrigin: string;
  audience: string;
  sessionSecret: string;
  secureCookie?: boolean;
  offline?: {
    identityKeyId: string;
    identityPublicKeySpki: string;
    expectedAccountId: string;
    expectedDeviceId: string;
    lastTrustedTimeMs: number;
    localSignOutEpoch: number;
  };
};

export type PreparedDesktopLocalAccountSession = {
  localAccountAuth?: DesktopLocalAccountAuth;
  connect(localApiUrl: string): Promise<void>;
};

type MainRenderer = {
  mainFrame: unknown;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
};

function booleanFlagEnabled(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

async function openDesktopIdentityExternal(url: string): Promise<void> {
  const smokeRecordPath = process.env.RUDDER_DESKTOP_SMOKE_IDENTITY_HANDOFF_PATH?.trim();
  if (!smokeRecordPath) {
    await shell.openExternal(url);
    return;
  }

  const loginUrl = new URL(url);
  const nextValue = loginUrl.searchParams.get("next");
  const nextUrl = nextValue ? new URL(nextValue, loginUrl.origin) : null;
  await appendFile(smokeRecordPath, `${JSON.stringify({
    origin: loginUrl.origin,
    pathname: loginUrl.pathname,
    searchParamNames: [...loginUrl.searchParams.keys()].sort(),
    nextOrigin: nextUrl?.origin ?? null,
    nextPathname: nextUrl?.pathname ?? null,
    nextParamNames: nextUrl ? [...nextUrl.searchParams.keys()].sort() : [],
  })}\n`, { encoding: "utf8", mode: 0o600 });
}

function localAuthOptions(
  origin: string,
  audience: string,
  sessionSecret: string,
  credential: DesktopOfflineGrantCredential | null,
): DesktopLocalAccountAuth {
  return {
    identityOrigin: origin,
    audience,
    sessionSecret,
    secureCookie: false,
    ...(credential ? {
      offline: {
        identityKeyId: credential.keyId,
        identityPublicKeySpki: credential.identityPublicKeySpki,
        expectedAccountId: credential.accountId,
        expectedDeviceId: credential.deviceId,
        lastTrustedTimeMs: credential.trustedTimeMs,
        localSignOutEpoch: credential.localSignOutEpoch,
      },
    } : {}),
  };
}

export function createDesktopIdentityRuntime(options: {
  installationId: string;
  appName: string;
  safeStorage: IdentitySafeStorage;
  getMainRenderer(): MainRenderer | null;
  getLocalApiUrl(): string | null;
  onSignedIn(): Promise<void>;
  onSignedOut(): Promise<void>;
  onLocalExchange(): void;
}) {
  const debug = booleanFlagEnabled(process.env.RUDDER_DESKTOP_DEBUG_STARTUP);
  if (debug) console.info("[rudder-desktop] identity-runtime:resolve-origin");
  const origin = resolveDesktopIdentityOrigin({
    isPackaged: app.isPackaged,
    override: process.env.RUDDER_IDENTITY_ORIGIN,
    packagedTestMarkerPath: path.join(process.resourcesPath, "native", "packaged-test-identity.marker"),
  });
  const safeStorage = resolveDesktopIdentitySafeStorage({
    safeStorage: options.safeStorage,
    isPackaged: app.isPackaged,
    platform: process.platform,
  });
  const credentialVault = createIdentityCredentialVault({
    safeStorage,
    platform: process.platform,
    credentialPath: path.join(app.getPath("userData"), "identity", "device-credential.bin"),
  });
  if (debug) console.info("[rudder-desktop] identity-runtime:create-session-store");
  const credentialVaultStatus = credentialVault.status();
  const vault = createDesktopIdentitySessionStore(credentialVault, {
    allowMemoryFallback: desktopIdentityMemoryFallbackAllowed({
      isPackaged: app.isPackaged,
      platform: process.platform,
      storageBackend: credentialVaultStatus.backend,
    }),
  });
  if (debug) console.info("[rudder-desktop] identity-runtime:create-offline-store");
  const offlineGrantStore = createDesktopOfflineGrantStore({
    safeStorage,
    platform: process.platform,
    statePath: path.join(app.getPath("userData"), "identity", "offline-grant.bin"),
    issuer: origin,
    installationId: options.installationId,
  });
  if (debug) console.info("[rudder-desktop] identity-runtime:create-client");
  let controller: ReturnType<typeof createDesktopIdentityIpcController>;
  const client = createDesktopIdentityClient({
    identityOrigin: origin,
    installationId: options.installationId,
    deviceName: `${options.appName} on ${os.hostname()}`.slice(0, 200),
    vault,
    offlineGrantStore,
    openExternal: openDesktopIdentityExternal,
    onDeviceAuthorizationPrompt: (prompt) => controller.showDeviceAuthorizationPrompt(prompt),
  });
  if (debug) console.info("[rudder-desktop] identity-runtime:create-controller");
  controller = createDesktopIdentityIpcController({
    origin,
    vault,
    client,
    getMainRenderer: options.getMainRenderer,
    onSignedIn: options.onSignedIn,
    onBeforeSignedOut: async () => {
      const localApiUrl = options.getLocalApiUrl();
      if (localApiUrl) {
        await revokeDesktopLocalSessions({
          localApiUrl,
          getCookies: (url) => session.defaultSession.cookies.get({ url }),
        });
      }
    },
    onSignedOut: async () => {
      const localApiUrl = options.getLocalApiUrl();
      if (localApiUrl) {
        await clearDesktopLocalSessionCookies({
          localApiUrl,
          removeCookie: (url, name) =>
            session.defaultSession.cookies.remove(url, name).catch(() => undefined),
        });
      }
      await options.onSignedOut();
    },
  });
  if (debug) console.info("[rudder-desktop] identity-runtime:ready");
  const accountRequired = !desktopAccountBypassAllowed({
    isPackaged: app.isPackaged,
    bypassRequested: booleanFlagEnabled(process.env.RUDDER_DESKTOP_AUTH_BYPASS),
  });
  const sessionSecret = randomBytes(32).toString("base64url");
  const telemetryStatePromise = loadOrCreateDesktopTelemetryState(app.getPath("userData"));

  return {
    accountRequired,
    telemetryStatePromise,
    controller,
    getAuthProviders(): Promise<DesktopIdentityAuthProviders> {
      return client.getAuthProviders();
    },

    registerIpc(): void {
      registerDesktopIdentityIpcHandlers(ipcMain, {
        getMainRenderer: options.getMainRenderer,
        controller,
      });
    },

    prepareLocalSession(audience: string): PreparedDesktopLocalAccountSession {
      const credential = offlineGrantStore.read();
      return {
        localAccountAuth: accountRequired
          ? localAuthOptions(origin, audience, sessionSecret, credential)
          : undefined,
        async connect(localApiUrl: string): Promise<void> {
          if (!accountRequired) return;
          options.onLocalExchange();
          let exchangeCode: string | null = null;
          try {
            exchangeCode = await client.createServerExchange(audience);
          } catch (onlineError) {
            if (
              !credential
              || (onlineError as { code?: unknown }).code === "IDENTITY_SESSION_REJECTED"
            ) throw onlineError;
          }
          if (exchangeCode) {
            await establishDesktopLocalSession({
              localApiUrl,
              exchangeCode,
              installCookie: (details) => session.defaultSession.cookies.set(details),
            });
            return;
          }
          await establishDesktopOfflineLocalSession({
            localApiUrl,
            credential: credential!,
            installCookie: (details) => session.defaultSession.cookies.set(details),
            updateTrustedTime: (next) => offlineGrantStore.updateTrustedTime(next),
          });
        },
      };
    },

    issueProductAnalyticsAssertion(input: Parameters<typeof client.issueProductAnalyticsAssertion>[0]): Promise<string> {
      return client.issueProductAnalyticsAssertion(input);
    },

    recordProductAnalyticsConsent(input: Parameters<typeof client.recordProductAnalyticsConsent>[0]): Promise<{ consentEpoch: number }> {
      return client.recordProductAnalyticsConsent(input);
    },
  };
}
