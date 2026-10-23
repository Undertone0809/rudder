import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { createAuthRuntime } from "./auth-runtime.js";

vi.mock("../board-claim.js", () => ({
  initializeBoardClaimChallenge: vi.fn(async () => undefined),
}));

function localTrustedConfig(host = "127.0.0.1") {
  return {
    deploymentMode: "local_trusted",
    host,
  } as Config;
}

describe("createAuthRuntime", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("wires local account exchange, HTTP, WebSocket, and revocation auth dependencies", async () => {
    const ensureLocalTrustedBoardPrincipal = vi.fn(async () => undefined);
    const runtime = await createAuthRuntime({
      db: {} as never,
      config: localTrustedConfig(),
      instanceId: "installation-1",
      localAccountAuth: {
        identityOrigin: "https://accounts.rudderhq.dev/path",
        audience: "rudder-desktop",
        sessionSecret: "local-session-secret",
      },
      ensureLocalTrustedBoardPrincipal,
    });

    expect(ensureLocalTrustedBoardPrincipal).toHaveBeenCalledOnce();
    expect(runtime.authReady).toBe(true);
    expect(runtime.browserSessionAuth).toEqual({
      issuer: "local_account", secret: "local-session-secret", secureCookie: false,
    });
    expect(Object.isFrozen(runtime.browserSessionAuth)).toBe(true);
    expect(runtime.localAccountExchangePolicy).toMatchObject({
      expectedIssuer: "https://accounts.rudderhq.dev",
      audience: "rudder-desktop",
      installationId: "installation-1",
      sessionSecret: "local-session-secret",
      secureCookie: false,
    });
    expect(runtime.resolveSession).toBeTypeOf("function");
    expect(runtime.resolveSessionFromHeaders).toBeTypeOf("function");
    expect(await runtime.resolveSessionFromHeaders?.(new Headers())).toBeNull();
    expect(runtime.localAccountSessionRevocation).toBeDefined();
  });

  it("rejects local account auth on a non-loopback runtime", async () => {
    await expect(
      createAuthRuntime({
        db: {} as never,
        config: localTrustedConfig("0.0.0.0"),
        instanceId: "installation-1",
        localAccountAuth: {
          identityOrigin: "https://accounts.rudderhq.dev",
          audience: "rudder-desktop",
          sessionSecret: "local-session-secret",
        },
        ensureLocalTrustedBoardPrincipal: async () => undefined,
      }),
    ).rejects.toThrow(
      "Desktop account authentication is supported only by a loopback local_trusted runtime",
    );
  });

  it("transports Better Auth's resolved origin including an environment URL port", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "auth-runtime-test-secret-with-more-than-32-characters");
    vi.stubEnv("BETTER_AUTH_URL", "https://auth.example:8443");
    vi.stubEnv("BETTER_AUTH_BASE_URL", undefined);
    vi.stubEnv("BETTER_AUTH_TRUSTED_ORIGINS", undefined);
    vi.stubEnv("RUDDER_PUBLIC_URL", undefined);
    vi.stubEnv("RUDDER_AGENT_JWT_SECRET", undefined);

    const runtime = await createAuthRuntime({
      db: {} as never,
      config: {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        host: "127.0.0.1",
        authBaseUrlMode: "auto",
        authPublicBaseUrl: "https://auth.example:8443",
        allowedHostnames: ["auth.example"],
        authDisableSignUp: false,
      } as Config,
      instanceId: "installation-1",
      ensureLocalTrustedBoardPrincipal: async () => undefined,
    });

    expect(runtime.browserSessionAuth).toMatchObject({
      issuer: "better_auth",
      trustedOrigins: expect.arrayContaining(["https://auth.example:8443"]),
    });
  });
});
