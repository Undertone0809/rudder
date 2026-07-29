import { app, ipcMain, safeStorage, session, shell } from "electron";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createDesktopIdentityClient } from "./identity-client.js";
import { createIdentityCredentialVault } from "./identity-credential-vault.js";
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
import { createDesktopIdentitySessionStore } from "./identity-session-store.js";
import { desktopAccountBypassAllowed } from "./identity-startup-policy.js";

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
        localSignOutEpoch: credential.signOutEpoch,
      },
    } : {}),
  };
}

export function createDesktopIdentityRuntime(options: {
  installationId: string;
  appName: string;
  getMainRenderer(): MainRenderer | null;
  getLocalApiUrl(): string | null;
  onSignedIn(): Promise<void>;
  onSignedOut(): Promise<void>;
  onLocalExchange(): void;
}) {
  const origin = resolveDesktopIdentityOrigin({
    isPackaged: app.isPackaged,
    override: process.env.RUDDER_IDENTITY_ORIGIN,
  });
  const credentialVault = createIdentityCredentialVault({
    safeStorage,
    platform: process.platform,
    credentialPath: path.join(app.getPath("userData"), "identity", "device-credential.bin"),
  });
  const vault = createDesktopIdentitySessionStore(credentialVault);
  const offlineGrantStore = createDesktopOfflineGrantStore({
    safeStorage,
    platform: process.platform,
    statePath: path.join(app.getPath("userData"), "identity", "offline-grant.bin"),
    issuer: origin,
    installationId: options.installationId,
  });
  let controller: ReturnType<typeof createDesktopIdentityIpcController>;
  const client = createDesktopIdentityClient({
    identityOrigin: origin,
    installationId: options.installationId,
    deviceName: `${options.appName} on ${os.hostname()}`.slice(0, 200),
    vault,
    offlineGrantStore,
    openExternal: (url) => shell.openExternal(url),
    onDeviceAuthorizationPrompt: (prompt) => controller.showDeviceAuthorizationPrompt(prompt),
  });
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
  const accountRequired = !desktopAccountBypassAllowed({
    isPackaged: app.isPackaged,
    bypassRequested: booleanFlagEnabled(process.env.RUDDER_DESKTOP_AUTH_BYPASS),
  });
  const sessionSecret = randomBytes(32).toString("base64url");

  return {
    accountRequired,
    controller,

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
  };
}
