import { describe, expect, it, vi } from "vitest";
import {
  createDesktopIdentityIpcController,
  DESKTOP_IDENTITY_IPC_CHANNELS,
  registerDesktopIdentityIpcHandlers,
  resolveDesktopIdentityOrigin,
} from "./identity-ipc.js";

function fixture() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn(),
  };
  const renderer = {
    mainFrame: {},
    isDestroyed: () => false,
    send: vi.fn(),
  };
  const clear = vi.fn();
  const listDeviceSessions = vi.fn(async () => [{
    id: "device-1",
    name: "Test Mac",
    platform: null,
    createdAt: "2026-07-29T00:00:00.000Z",
    lastSeenAt: "2026-07-29T01:00:00.000Z",
    current: true,
  }]);
  const revokeDeviceSession = vi.fn(async () => undefined);
  const signIn = vi.fn(async () => ({
    accessToken: "not-exposed",
    account: { id: "account-1", email: "verified@example.com", name: "Rudder User", image: null },
    device: { id: "device-1", installationId: "default", displayName: "Test Mac" },
  }));
  const controller = createDesktopIdentityIpcController({
    origin: "https://accounts.rudderhq.dev",
    vault: {
      status: () => ({ available: true as const, backend: "keychain" }),
      read: () => null,
    },
    client: {
      signIn,
      signOut: async () => clear(),
      listDeviceSessions,
      revokeDeviceSession,
    },
    getMainRenderer: () => renderer,
  });
  registerDesktopIdentityIpcHandlers(ipcMain, {
    getMainRenderer: () => renderer,
    controller,
  });
  return { handlers, renderer, clear, listDeviceSessions, revokeDeviceSession, controller, signIn };
}

describe("Desktop Rudder Account IPC", () => {
  it("pins packaged builds and permits only an explicit development loopback override", () => {
    expect(resolveDesktopIdentityOrigin({
      isPackaged: true,
      override: "http://127.0.0.1:4111",
    })).toBe("https://accounts.rudderhq.dev");
    expect(resolveDesktopIdentityOrigin({
      isPackaged: false,
      override: "http://127.0.0.1:4111/path",
    })).toBe("http://127.0.0.1:4111");
    expect(() => resolveDesktopIdentityOrigin({
      isPackaged: false,
      override: "https://identity.attacker.example",
    })).toThrow("explicit HTTP loopback");
    expect(() => resolveDesktopIdentityOrigin({
      isPackaged: false,
      override: "http://user:secret@localhost:4111",
    })).toThrow("explicit HTTP loopback");
  });

  it("rejects non-main-frame callers and renderer-controlled arguments", async () => {
    const { handlers, renderer } = fixture();
    const getState = handlers.get(DESKTOP_IDENTITY_IPC_CHANNELS.getState);
    const revoke = handlers.get(DESKTOP_IDENTITY_IPC_CHANNELS.revokeDeviceSession);

    await expect(getState?.({ sender: {}, senderFrame: renderer.mainFrame })).rejects.toThrow(
      "current renderer main frame",
    );
    await expect(getState?.({ sender: renderer, senderFrame: {} })).rejects.toThrow(
      "current renderer main frame",
    );
    await expect(getState?.({ sender: renderer, senderFrame: renderer.mainFrame }, "unexpected")).rejects.toThrow(
      "does not accept renderer arguments",
    );
    await expect(revoke?.(
      { sender: renderer, senderFrame: renderer.mainFrame },
      { deviceId: "device-1", accessToken: "renderer-secret" },
    )).rejects.toThrow("valid opaque device id");
  });

  it("accepts only bounded login method hints and normalizes the optional email", async () => {
    const { handlers, renderer, signIn: clientSignIn } = fixture();
    const event = { sender: renderer, senderFrame: renderer.mainFrame };
    const signIn = handlers.get(DESKTOP_IDENTITY_IPC_CHANNELS.signIn);

    await signIn?.(event, { method: "email_otp", email: "River@Example.com" });
    expect(clientSignIn).toHaveBeenCalledWith({
      method: "email_otp",
      email: "river@example.com",
    });
    await expect(signIn?.(event, { method: "saml" })).rejects.toThrow("valid method hint");
    await expect(signIn?.(event, {
      method: "password",
      email: "river@example.com",
      password: ["must", "not", "cross", "ipc"].join("-"),
    })).rejects.toThrow("valid method hint");
    await expect(signIn?.(event, {
      method: "password_reset",
      email: "not-an-email",
    })).rejects.toThrow("invalid email hint");
  });

  it("publishes state without exposing the access token", async () => {
    const { handlers, renderer } = fixture();
    const event = { sender: renderer, senderFrame: renderer.mainFrame };

    const result = await handlers.get(DESKTOP_IDENTITY_IPC_CHANNELS.signIn)?.(event);

    expect(result).toMatchObject({
      status: "signed-in",
      account: { email: "verified@example.com" },
      deviceId: "device-1",
    });
    expect(JSON.stringify(result)).not.toContain("not-exposed");
    expect(renderer.send).toHaveBeenCalledWith(
      DESKTOP_IDENTITY_IPC_CHANNELS.stateChanged,
      expect.objectContaining({ status: "signing-in" }),
    );
    expect(renderer.send).toHaveBeenLastCalledWith(
      DESKTOP_IDENTITY_IPC_CHANNELS.stateChanged,
      expect.objectContaining({ status: "signed-in" }),
    );
  });

  it("publishes only safe device approval details while fallback polling continues", () => {
    const { controller, renderer } = fixture();
    controller.showDeviceAuthorizationPrompt({
      userCode: "ABCD-EFGH",
      verificationUri: "https://accounts.rudderhq.dev/device",
      verificationUriComplete: "https://accounts.rudderhq.dev/device?user_code=ABCD-EFGH",
      expiresAt: "2026-07-29T01:00:00.000Z",
    });

    expect(renderer.send).toHaveBeenLastCalledWith(
      DESKTOP_IDENTITY_IPC_CHANNELS.stateChanged,
      expect.objectContaining({
        status: "device-authorization",
        userCode: "ABCD-EFGH",
      }),
    );
    expect(JSON.stringify(renderer.send.mock.lastCall)).not.toContain("device_code");
  });

  it("clears local credentials and delegates device session management without exposing credentials", async () => {
    const { handlers, renderer, clear, listDeviceSessions, revokeDeviceSession } = fixture();
    const event = { sender: renderer, senderFrame: renderer.mainFrame };

    await expect(handlers.get(DESKTOP_IDENTITY_IPC_CHANNELS.signOut)?.(event)).resolves.toMatchObject({
      status: "signed-out",
    });
    expect(clear).toHaveBeenCalledOnce();
    await expect(
      handlers.get(DESKTOP_IDENTITY_IPC_CHANNELS.listDeviceSessions)?.(event),
    ).resolves.toEqual([expect.objectContaining({ id: "device-1", current: true })]);
    expect(listDeviceSessions).toHaveBeenCalledOnce();
    await expect(
      handlers.get(DESKTOP_IDENTITY_IPC_CHANNELS.revokeDeviceSession)?.(event, { deviceId: "device-1" }),
    ).resolves.toBeUndefined();
    expect(revokeDeviceSession).toHaveBeenCalledWith("device-1");
  });

  it("still clears Identity credentials when Local session revocation fails", async () => {
    const signOut = vi.fn(async () => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const controller = createDesktopIdentityIpcController({
      origin: "https://accounts.rudderhq.dev",
      vault: {
        status: () => ({ available: true as const, backend: "keychain" }),
        read: () => ({
          version: 1,
          issuer: "https://accounts.rudderhq.dev",
          accountId: "account-1",
          accountEmail: "user@example.com",
          accountName: "User",
          deviceId: "device-1",
          refreshToken: "refresh-secret",
          refreshTokenExpiresAt: "2026-08-29T00:00:00.000Z",
        }),
      },
      client: {
        signIn: vi.fn(),
        signOut,
        listDeviceSessions: vi.fn(),
        revokeDeviceSession: vi.fn(),
      },
      getMainRenderer: () => null,
      onBeforeSignedOut: async () => {
        throw new Error("Local session revocation failed");
      },
    });

    await expect(controller.signOut()).resolves.toEqual({ status: "signed-out" });
    expect(signOut).toHaveBeenCalledOnce();
    expect(controller.getState()).toEqual({ status: "signed-out" });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("continuing account sign-out"),
      expect.any(Error),
    );
    warn.mockRestore();
  });
});
