import { describe, expect, it, vi } from "vitest";
import type { DesktopOfflineGrantCredential } from "./identity-offline-grant.js";
import {
  connectDesktopLocalAccountSession,
  selectMatchingDesktopOfflineGrant,
} from "./identity-session-connection.js";

const issuer = "https://accounts.rudderhq.dev";

function offlineGrant(overrides: Partial<DesktopOfflineGrantCredential> = {}) {
  return {
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
    ...overrides,
  } satisfies DesktopOfflineGrantCredential;
}

function identityCredential(overrides: Partial<Pick<DesktopOfflineGrantCredential, "issuer" | "accountId" | "deviceId">> = {}) {
  return {
    issuer,
    accountId: "account-1",
    deviceId: "device-1",
    ...overrides,
  };
}

function unavailableError() {
  return Object.assign(new Error("Identity unavailable"), { code: "IDENTITY_UNAVAILABLE" });
}

function sessionRejectedError() {
  return Object.assign(new Error("Identity session rejected"), { code: "IDENTITY_SESSION_REJECTED" });
}

describe("Desktop local account session connection", () => {
  it("does not use an Offline Grant from another account or device", () => {
    const grant = offlineGrant();

    expect(selectMatchingDesktopOfflineGrant(grant, identityCredential(), issuer)).toBe(grant);
    expect(selectMatchingDesktopOfflineGrant(
      grant,
      identityCredential({ accountId: "another-account" }),
      issuer,
    )).toBeNull();
    expect(selectMatchingDesktopOfflineGrant(
      grant,
      identityCredential({ deviceId: "another-device" }),
      issuer,
    )).toBeNull();
  });

  it("uses a valid Offline Grant when the cloud exchange is unavailable", async () => {
    const createServerExchange = vi.fn(async () => { throw unavailableError(); });
    const establishOnline = vi.fn(async () => undefined);
    const establishOffline = vi.fn(async () => undefined);

    await connectDesktopLocalAccountSession({
      credential: offlineGrant(),
      createServerExchange,
      establishOnline,
      establishOffline,
      retryDelayMs: 0,
      sleep: vi.fn(async () => undefined),
    });

    expect(createServerExchange).toHaveBeenCalledOnce();
    expect(establishOnline).not.toHaveBeenCalled();
    expect(establishOffline).toHaveBeenCalledOnce();
  });

  it("retries online after a rejected Offline Grant", async () => {
    const createServerExchange = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(unavailableError())
      .mockResolvedValueOnce("fresh-online-exchange-code");
    const establishOnline = vi.fn(async (exchangeCode: string) => {
      expect(exchangeCode).toBe("fresh-online-exchange-code");
    });
    const establishOffline = vi.fn(async () => {
      throw new Error("Local Offline Grant rejected (403)");
    });

    await connectDesktopLocalAccountSession({
      credential: offlineGrant(),
      createServerExchange,
      establishOnline,
      establishOffline,
      retryDelayMs: 0,
      sleep: vi.fn(async () => undefined),
    });

    expect(createServerExchange).toHaveBeenCalledTimes(2);
    expect(establishOffline).toHaveBeenCalledOnce();
    expect(establishOnline).toHaveBeenCalledWith("fresh-online-exchange-code");
  });

  it("retries a transient online failure when no usable Offline Grant remains", async () => {
    const createServerExchange = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(unavailableError())
      .mockResolvedValueOnce("online-exchange-code");
    const establishOnline = vi.fn(async () => undefined);

    await connectDesktopLocalAccountSession({
      credential: null,
      createServerExchange,
      establishOnline,
      establishOffline: vi.fn(async () => undefined),
      retryDelayMs: 0,
      sleep: vi.fn(async () => undefined),
    });

    expect(createServerExchange).toHaveBeenCalledTimes(2);
    expect(establishOnline).toHaveBeenCalledWith("online-exchange-code");
  });

  it("does not downgrade or retry a rejected online session", async () => {
    const createServerExchange = vi.fn(async () => { throw sessionRejectedError(); });
    const establishOnline = vi.fn(async () => undefined);
    const establishOffline = vi.fn(async () => undefined);

    await expect(connectDesktopLocalAccountSession({
      credential: offlineGrant(),
      createServerExchange,
      establishOnline,
      establishOffline,
      retryDelayMs: 0,
      sleep: vi.fn(async () => undefined),
    })).rejects.toMatchObject({ code: "IDENTITY_SESSION_REJECTED" });

    expect(createServerExchange).toHaveBeenCalledOnce();
    expect(establishOnline).not.toHaveBeenCalled();
    expect(establishOffline).not.toHaveBeenCalled();
  });
});
