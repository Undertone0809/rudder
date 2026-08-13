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
  const getProfile = vi.fn(async () => ({
    id: "account-1",
    email: "verified@example.com",
    name: "Rudder User",
    image: null,
  }));
  const updateProfile = vi.fn(async ({ image }: { image: string | null }) => ({
    id: "account-1",
    email: "verified@example.com",
    name: "Rudder User",
    image,
  }));
  const signIn = vi.fn(async () => ({
    accessToken: "not-exposed",
    account: { id: "account-1", email: "verified@example.com", name: "Rudder User", image: null },
    device: { id: "device-1", installationId: "default", displayName: "Test Mac" },
  }));
  const nativeSignIn = vi.fn(async () => ({
    accessToken: "not-exposed",
    account: { id: "account-1", email: "verified@example.com", name: "Rudder User", image: null },
    device: { id: "device-1", installationId: "default", displayName: "Test Mac" },
  }));
  const sendEmailOtp = vi.fn(async () => undefined);
  const requestPasswordReset = vi.fn(async () => undefined);
  const controller = createDesktopIdentityIpcController({
    origin: "https://accounts.rudderhq.dev",
    vault: {
      status: () => ({ available: true as const, backend: "keychain" }),
      read: () => null,
    },
    client: {
      signIn,
      nativeSignIn,
      sendEmailOtp,
      requestPasswordReset,
      signOut: async () => clear(),
      listDeviceSessions,
      revokeDeviceSession,
      getProfile,
      updateProfile,
    },
    getMainRenderer: () => renderer,
  });
  registerDesktopIdentityIpcHandlers(ipcMain, {
    getMainRenderer: () => renderer,
    controller,
  });
  return {
    handlers,
    renderer,
    clear,
    listDeviceSessions,
    revokeDeviceSession,
    getProfile,
    updateProfile,
    controller,
    signIn,
    nativeSignIn,
    sendEmailOtp,
    requestPasswordReset,
  };
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

  it("separates browser OAuth hints from bounded native email credentials", async () => {
    const {
      handlers,
      renderer,
      signIn: clientSignIn,
      nativeSignIn,
      sendEmailOtp,
      requestPasswordReset,
    } = fixture();
    const event = { sender: renderer, senderFrame: renderer.mainFrame };
    const signIn = handlers.get(DESKTOP_IDENTITY_IPC_CHANNELS.signIn);

    await signIn?.(event, { method: "google" });
    expect(clientSignIn).toHaveBeenCalledWith({ method: "google" });
    await handlers.get(DESKTOP_IDENTITY_IPC_CHANNELS.sendEmailOtp)?.(event, {
      email: "River@Example.com",
    });
    expect(sendEmailOtp).toHaveBeenCalledWith("river@example.com");
    await handlers.get(DESKTOP_IDENTITY_IPC_CHANNELS.verifyEmailOtp)?.(event, {
      email: "River@Example.com",
      token: "123456",
    });
    expect(nativeSignIn).toHaveBeenCalledWith({
      method: "email_otp",
      email: "river@example.com",
      token: "123456",
    });
    await handlers.get(DESKTOP_IDENTITY_IPC_CHANNELS.requestPasswordReset)?.(event, {
      email: "River@Example.com",
    });
    expect(requestPasswordReset).toHaveBeenCalledWith("river@example.com");
    await expect(signIn?.(event, { method: "saml" })).rejects.toThrow("valid method hint");
    await expect(signIn?.(event, {
      method: "password",
      email: "river@example.com",
      password: ["must", "not", "cross", "ipc"].join("-"),
    })).rejects.toThrow("valid method hint");
    await expect(signIn?.(event, {
      method: "password_reset",
      email: "not-an-email",
    })).rejects.toThrow("valid method hint");
    await expect(handlers.get(DESKTOP_IDENTITY_IPC_CHANNELS.verifyEmailOtp)?.(event, {
      email: "river@example.com",
      token: "<script>",
    })).rejects.toThrow("valid verification code");
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

  it("blocks credential-issuing sign-in before any client side effect when secure storage is unavailable", async () => {
    const renderer = {
      mainFrame: {},
      isDestroyed: () => false,
      send: vi.fn(),
    };
    const signIn = vi.fn();
    const nativeSignIn = vi.fn();
    const sendEmailOtp = vi.fn(async () => undefined);
    const requestPasswordReset = vi.fn(async () => undefined);
    const controller = createDesktopIdentityIpcController({
      origin: "https://accounts.rudderhq.dev",
      vault: {
        status: () => ({
          available: false as const,
          backend: "unavailable",
          reason: "encryption_unavailable" as const,
        }),
        read: vi.fn(() => null),
      },
      client: {
        signIn,
        nativeSignIn,
        sendEmailOtp,
        requestPasswordReset,
        signOut: vi.fn(async () => undefined),
        listDeviceSessions: vi.fn(async () => []),
        revokeDeviceSession: vi.fn(async () => undefined),
        getProfile: vi.fn(async () => ({ id: "account-1", email: "user@example.com", name: "User", image: null })),
        updateProfile: vi.fn(async ({ image }: { image: string | null }) => ({
          id: "account-1",
          email: "user@example.com",
          name: "User",
          image,
        })),
      },
      getMainRenderer: () => renderer,
    });

    await expect(controller.signIn({ method: "google" })).resolves.toMatchObject({
      status: "error",
      recoverable: false,
    });
    await expect(controller.nativeSignIn({
      method: "password",
      email: "river@example.com",
      password: "correct horse battery staple",
    })).resolves.toMatchObject({ status: "error", recoverable: false });
    await expect(controller.nativeSignIn({
      method: "email_otp",
      email: "river@example.com",
      token: "123456",
    })).resolves.toMatchObject({ status: "error", recoverable: false });
    await expect(controller.nativeSignIn({
      method: "password_reset",
      email: "river@example.com",
      token: "123456",
      newPassword: "correct horse battery staple",
    })).resolves.toMatchObject({ status: "error", recoverable: false });

    expect(signIn).not.toHaveBeenCalled();
    expect(nativeSignIn).not.toHaveBeenCalled();

    await expect(controller.sendEmailOtp("river@example.com")).resolves.toBeUndefined();
    await expect(controller.requestPasswordReset("river@example.com")).resolves.toBeUndefined();
    expect(sendEmailOtp).toHaveBeenCalledOnce();
    expect(requestPasswordReset).toHaveBeenCalledOnce();
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
    const { handlers, renderer, clear, listDeviceSessions, revokeDeviceSession, getProfile, updateProfile } = fixture();
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
    await expect(handlers.get(DESKTOP_IDENTITY_IPC_CHANNELS.getProfile)?.(event)).resolves.toMatchObject({
      id: "account-1",
      image: null,
    });
    const avatar = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    await expect(
      handlers.get(DESKTOP_IDENTITY_IPC_CHANNELS.updateProfile)?.(event, { image: avatar }),
    ).resolves.toMatchObject({ image: avatar });
    expect(getProfile).toHaveBeenCalledOnce();
    expect(updateProfile).toHaveBeenCalledWith({ image: avatar });
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
        getProfile: vi.fn(),
        updateProfile: vi.fn(),
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
