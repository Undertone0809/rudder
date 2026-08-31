import { describe, expect, it, vi } from "vitest";

const issuer = "https://accounts.rudderhq.dev";
const currentCredential = {
  version: 1,
  issuer,
  accountId: "account-1",
  accountEmail: "account@example.com",
  accountName: "Account One",
  deviceId: "device-1",
  refreshToken: "refresh-token",
  refreshTokenExpiresAt: "2099-01-01T00:00:00.000Z",
};
const offlineCredential = {
  version: 1,
  issuer,
  accountId: "account-1",
  deviceId: "device-1",
  installationId: "installation-1",
  grant: "offline-grant",
  expiresAtMs: 1_900_000_000_000,
  keyId: "identity-key",
  identityPublicKeySpki: "identity-public-key",
  devicePrivateKeyPkcs8: "device-private-key",
  devicePublicKeySpki: "device-public-key",
  trustedTimeMs: 1_700_000_000_000,
  localSignOutEpoch: 0,
};

const mocks = vi.hoisted(() => {
  const createServerExchange = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(Object.assign(new Error("Identity unavailable"), {
      code: "IDENTITY_UNAVAILABLE",
    }))
    .mockResolvedValueOnce("fresh-online-exchange-code");
  const client = {
    createServerExchange,
    getAuthProviders: vi.fn(async () => []),
    issueProductAnalyticsAssertion: vi.fn(async () => "assertion"),
    recordProductAnalyticsConsent: vi.fn(async () => ({ consentEpoch: 1 })),
  };
  const establishOnline = vi.fn(async () => undefined);
  const establishOffline = vi.fn(async () => {
    throw new Error("Local Offline Grant rejected (403)");
  });
  const vault = {
    read: vi.fn(() => currentCredential),
    status: vi.fn(() => ({ available: true, backend: "win32" })),
  };
  const offlineGrantStore = {
    read: vi.fn(() => offlineCredential),
    updateTrustedTime: vi.fn(),
  };
  return {
    client,
    establishOnline,
    establishOffline,
    vault,
    offlineGrantStore,
  };
});

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getPath: vi.fn(() => "C:\\Users\\test\\AppData\\Roaming\\Rudder"),
  },
  ipcMain: {},
  session: {
    defaultSession: {
      cookies: {
        set: vi.fn(async () => undefined),
        get: vi.fn(async () => []),
        remove: vi.fn(async () => undefined),
      },
    },
  },
  shell: { openExternal: vi.fn(async () => undefined) },
}));

vi.mock("./identity-client.js", () => ({
  createDesktopIdentityClient: vi.fn(() => mocks.client),
}));
vi.mock("./identity-credential-vault.js", () => ({
  createIdentityCredentialVault: vi.fn(() => mocks.vault),
}));
vi.mock("./identity-ipc.js", () => ({
  createDesktopIdentityIpcController: vi.fn(() => ({})),
  registerDesktopIdentityIpcHandlers: vi.fn(),
  resolveDesktopIdentityOrigin: vi.fn(() => issuer),
}));
vi.mock("./identity-local-session.js", () => ({
  clearDesktopLocalSessionCookies: vi.fn(async () => undefined),
  establishDesktopLocalSession: mocks.establishOnline,
  establishDesktopOfflineLocalSession: mocks.establishOffline,
  revokeDesktopLocalSessions: vi.fn(async () => undefined),
}));
vi.mock("./identity-offline-grant.js", () => ({
  createDesktopOfflineGrantStore: vi.fn(() => mocks.offlineGrantStore),
}));
vi.mock("./identity-safe-storage-policy.js", () => ({
  resolveDesktopIdentitySafeStorage: vi.fn(({ safeStorage }: { safeStorage: unknown }) => safeStorage),
}));
vi.mock("./identity-session-store.js", () => ({
  createDesktopIdentitySessionStore: vi.fn(() => mocks.vault),
  desktopIdentityMemoryFallbackAllowed: vi.fn(() => false),
}));
vi.mock("./identity-startup-policy.js", () => ({
  desktopAccountBypassAllowed: vi.fn(() => false),
}));
vi.mock("./product-analytics-telemetry.js", () => ({
  loadOrCreateDesktopTelemetryState: vi.fn(async () => ({
    installationId: "installation-1",
    installationSecret: "installation-secret",
    state: { mode: "off" },
    statePath: "C:\\Users\\test\\telemetry\\state.json",
  })),
}));

const { createDesktopIdentityRuntime } = await import("./identity-runtime.js");

describe("Desktop identity runtime local-session wiring", () => {
  it("retries online after the wired Offline Grant session is rejected", async () => {
    const runtime = createDesktopIdentityRuntime({
      installationId: "installation-1",
      appName: "Rudder",
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value),
        decryptString: (value: Buffer) => value.toString(),
      },
      getMainRenderer: () => null,
      getLocalApiUrl: () => "http://127.0.0.1:3200/api",
      onSignedIn: async () => undefined,
      onSignedOut: async () => undefined,
      onLocalExchange: vi.fn(),
    });

    const prepared = runtime.prepareLocalSession("default");
    await prepared.connect("http://127.0.0.1:3200/api");

    expect(prepared.localAccountAuth?.offline).toMatchObject({
      expectedAccountId: "account-1",
      expectedDeviceId: "device-1",
    });
    expect(mocks.client.createServerExchange).toHaveBeenCalledTimes(2);
    expect(mocks.establishOffline).toHaveBeenCalledOnce();
    expect(mocks.establishOnline).toHaveBeenCalledWith(expect.objectContaining({
      exchangeCode: "fresh-online-exchange-code",
      localApiUrl: "http://127.0.0.1:3200/api",
    }));
  });
});
