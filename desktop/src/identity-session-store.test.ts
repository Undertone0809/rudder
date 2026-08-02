import { describe, expect, it, vi } from "vitest";
import type { IdentityDeviceCredential } from "./identity-credential-vault.js";
import {
  createDesktopIdentitySessionStore,
  desktopIdentityMemoryFallbackAllowed,
} from "./identity-session-store.js";

const credential: IdentityDeviceCredential = {
  version: 1,
  issuer: "https://accounts.rudderhq.dev",
  accountId: "account-1",
  accountEmail: "user@example.com",
  accountName: "Rudder User",
  deviceId: "device-1",
  refreshToken: "refresh-secret",
  refreshTokenExpiresAt: "2026-08-28T00:00:00.000Z",
};

describe("Desktop Identity session store", () => {
  it.each([
    { isPackaged: false, platform: "darwin" as const, expected: true },
    { isPackaged: false, platform: "win32" as const, expected: true },
    { isPackaged: false, platform: "linux" as const, expected: true },
    { isPackaged: true, platform: "linux" as const, expected: true },
    { isPackaged: true, platform: "darwin" as const, expected: false },
    { isPackaged: true, platform: "win32" as const, expected: false },
  ])("selects the platform memory fallback policy (%o)", ({ expected, ...input }) => {
    expect(desktopIdentityMemoryFallbackAllowed(input)).toBe(expected);
  });

  it("delegates to secure persistence when the vault is available", () => {
    const read = vi.fn(() => credential);
    const write = vi.fn();
    const clear = vi.fn();
    const store = createDesktopIdentitySessionStore({
      status: () => ({ available: true, backend: "keychain" }),
      read,
      write,
      clear,
    });

    expect(store.persistence).toBe("secure");
    expect(store.read()).toEqual(credential);
    store.write(credential);
    store.clear();
    expect(write).toHaveBeenCalledWith(credential);
    expect(clear).toHaveBeenCalledOnce();
  });

  it("uses process-only memory when Linux exposes basic_text", () => {
    const write = vi.fn();
    const store = createDesktopIdentitySessionStore({
      status: () => ({
        available: false,
        backend: "basic_text",
        reason: "insecure_linux_backend",
      }),
      read: vi.fn(() => null),
      write,
      clear: vi.fn(),
    });

    expect(store.persistence).toBe("memory");
    expect(store.status()).toMatchObject({
      available: true,
      backend: "memory",
      persistence: "process-only",
      reason: "insecure_linux_backend",
    });
    store.write(credential);
    expect(store.read()).toEqual(credential);
    expect(store.read()).not.toBe(credential);
    expect(write).not.toHaveBeenCalled();
  });

  it("loses a memory session on restart and clears stale durable state on sign-out", () => {
    const clear = vi.fn();
    const unavailableVault = {
      status: () => ({
        available: false as const,
        backend: "unavailable",
        reason: "encryption_unavailable" as const,
      }),
      read: vi.fn(() => null),
      write: vi.fn(),
      clear,
    };
    const firstProcess = createDesktopIdentitySessionStore(unavailableVault);
    firstProcess.write(credential);
    expect(firstProcess.read()).toEqual(credential);

    const restartedProcess = createDesktopIdentitySessionStore(unavailableVault);
    expect(restartedProcess.read()).toBeNull();

    firstProcess.clear();
    expect(firstProcess.read()).toBeNull();
    expect(clear).toHaveBeenCalledOnce();
  });

  it("fails closed instead of accepting a process-only formal session", () => {
    const clear = vi.fn();
    const write = vi.fn();
    const store = createDesktopIdentitySessionStore({
      status: () => ({
        available: false,
        backend: "unavailable",
        reason: "encryption_unavailable",
      }),
      read: vi.fn(() => null),
      write,
      clear,
    }, { allowMemoryFallback: false });

    expect(store.persistence).toBe("unavailable");
    expect(store.status()).toEqual({
      available: false,
      backend: "unavailable",
      reason: "encryption_unavailable",
    });
    expect(store.read()).toBeNull();
    expect(() => store.write(credential)).toThrow(
      "Secure credential storage is unavailable on this device",
    );
    expect(write).not.toHaveBeenCalled();
    store.clear();
    expect(clear).toHaveBeenCalledOnce();
  });

  it("recovers formal persistence when the platform vault becomes available", () => {
    let available = false;
    const read = vi.fn(() => credential);
    const write = vi.fn();
    const store = createDesktopIdentitySessionStore({
      status: () => available
        ? { available: true, backend: "keychain" }
        : {
          available: false,
          backend: "unavailable",
          reason: "encryption_unavailable",
        },
      read,
      write,
      clear: vi.fn(),
    }, { allowMemoryFallback: false });

    expect(store.read()).toBeNull();
    expect(() => store.write(credential)).toThrow("Secure credential storage is unavailable");

    available = true;
    expect(store.read()).toEqual(credential);
    store.write(credential);
    expect(read).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(credential);
  });
});
