import { describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { createAuthRuntime } from "./auth-runtime.js";

function localTrustedConfig(host = "127.0.0.1") {
  return {
    deploymentMode: "local_trusted",
    host,
  } as Config;
}

describe("createAuthRuntime", () => {
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
});
