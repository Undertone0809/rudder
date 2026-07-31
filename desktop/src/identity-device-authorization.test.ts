import { describe, expect, it, vi } from "vitest";
import {
  runDesktopDeviceAuthorization,
  signInWithDesktopIdentityFallback,
} from "./identity-device-authorization.js";

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const deviceCode = {
  device_code: "device-secret",
  user_code: "ABCD-EFGH",
  verification_uri: "https://accounts.rudderhq.dev/device",
  expires_in: 600,
  interval: 5,
};

const deviceSession = {
  access_token: "device-access",
  token_type: "Bearer",
  expires_in: 900,
  refresh_token: "device-refresh",
  refresh_token_expires_in: 2_592_000,
  account: { id: "account-1", email: "user@example.com", name: "Rudder User", image: null },
  device: { id: "device-1", installationId: "default", displayName: "Test Mac" },
};

describe("Desktop Device Authorization fallback", () => {
  it("opens the approval page and polls the Rudder-owned contract for the final device session", async () => {
    let currentTime = Date.parse("2026-07-29T00:00:00.000Z");
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(200, deviceCode))
      .mockResolvedValueOnce(response(400, { error: "authorization_pending" }))
      .mockResolvedValueOnce(response(400, { error: "slow_down", interval: 10 }))
      .mockResolvedValueOnce(response(200, deviceSession));
    const sleep = vi.fn(async (delayMs: number) => {
      currentTime += delayMs;
    });
    const openExternal = vi.fn(async () => undefined);
    const onPrompt = vi.fn();

    const result = await runDesktopDeviceAuthorization({
      identityOrigin: "https://accounts.rudderhq.dev",
      installationId: "default",
      deviceName: "Test Mac",
      devicePublicKeyThumbprint: "thumbprint-1",
      fetch,
      sleep,
      now: () => currentTime,
      openExternal,
      onPrompt,
    });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      new URL("https://accounts.rudderhq.dev/api/desktop/device-code"),
      expect.objectContaining({
        body: JSON.stringify({
          client_id: "rudder-desktop",
          scope: "rudder.identity.device",
        }),
      }),
    );
    expect(openExternal).toHaveBeenCalledWith(
      "https://accounts.rudderhq.dev/device?user_code=ABCD-EFGH",
    );
    expect(onPrompt).toHaveBeenCalledWith(expect.objectContaining({
      userCode: "ABCD-EFGH",
      verificationUri: deviceCode.verification_uri,
    }));
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([5_000, 5_000, 10_000]);
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      new URL("https://accounts.rudderhq.dev/api/desktop/device-code/token"),
      expect.objectContaining({
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: "device-secret",
          client_id: "rudder-desktop",
          installation_id: "default",
          device_name: "Test Mac",
          sign_out_epoch: 0,
          device_public_key_thumbprint: "thumbprint-1",
        }),
      }),
    );
    expect(result).toEqual({
      accessToken: "device-access",
      refreshToken: "device-refresh",
      refreshTokenExpiresIn: 2_592_000,
      expiresIn: 900,
      account: deviceSession.account,
      device: deviceSession.device,
    });
  });

  it("stops polling after denial", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(200, deviceCode))
      .mockResolvedValueOnce(response(400, { error: "access_denied" }));

    await expect(runDesktopDeviceAuthorization({
      identityOrigin: "https://accounts.rudderhq.dev",
      installationId: "default",
      deviceName: "Test Mac",
      fetch,
      sleep: async () => undefined,
      openExternal: async () => undefined,
    })).rejects.toThrow("denied");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("surfaces server-side device-code expiry", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(200, deviceCode))
      .mockResolvedValueOnce(response(400, { error: "expired_token" }));

    await expect(runDesktopDeviceAuthorization({
      identityOrigin: "https://accounts.rudderhq.dev",
      installationId: "default",
      deviceName: "Test Mac",
      fetch,
      sleep: async () => undefined,
      openExternal: async () => undefined,
    })).rejects.toThrow("expired");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects an approval URL on another origin", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(200, {
      ...deviceCode,
      verification_uri_complete: "https://attacker.example/approve?user_code=ABCD-EFGH",
    }));
    const openExternal = vi.fn();

    await expect(runDesktopDeviceAuthorization({
      identityOrigin: "https://accounts.rudderhq.dev",
      installationId: "default",
      deviceName: "Test Mac",
      fetch,
      openExternal,
    })).rejects.toThrow("untrusted");
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("stops at the server-provided expiry without an extra poll", async () => {
    let currentTime = Date.parse("2026-07-29T00:00:00.000Z");
    const fetch = vi.fn().mockResolvedValueOnce(response(200, {
      ...deviceCode,
      expires_in: 5,
    }));

    await expect(runDesktopDeviceAuthorization({
      identityOrigin: "https://accounts.rudderhq.dev",
      installationId: "default",
      deviceName: "Test Mac",
      fetch,
      now: () => currentTime,
      sleep: async (delayMs) => {
        currentTime += delayMs;
      },
      openExternal: async () => undefined,
    })).rejects.toThrow("timed out");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("continues with a surfaced user code when the OS browser handoff fails", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(200, deviceCode))
      .mockResolvedValueOnce(response(200, deviceSession));
    const onPrompt = vi.fn();

    await expect(runDesktopDeviceAuthorization({
      identityOrigin: "https://accounts.rudderhq.dev",
      installationId: "default",
      deviceName: "Test Mac",
      fetch,
      sleep: async () => undefined,
      openExternal: async () => {
        throw new Error("No system browser");
      },
      onPrompt,
    })).resolves.toMatchObject({ accessToken: "device-access" });
    expect(onPrompt).toHaveBeenCalledWith(expect.objectContaining({
      userCode: "ABCD-EFGH",
      verificationUri: "https://accounts.rudderhq.dev/device",
    }));
  });

  it("falls back only for callback/browser transport failures", async () => {
    const fallback = vi.fn(async () => "device");
    await expect(signInWithDesktopIdentityFallback({
      signInWithPkce: async () => {
        throw new Error("Rudder sign-in timed out");
      },
      signInWithDeviceAuthorization: fallback,
    })).resolves.toBe("device");
    expect(fallback).toHaveBeenCalledOnce();

    await expect(signInWithDesktopIdentityFallback({
      signInWithPkce: async () => {
        throw new Error("Rudder Identity sign-in failed (401)");
      },
      signInWithDeviceAuthorization: fallback,
    })).rejects.toThrow("(401)");
    expect(fallback).toHaveBeenCalledOnce();
  });
});
