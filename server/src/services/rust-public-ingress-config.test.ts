import { describe, expect, it } from "vitest";
import { nativeLocalAccountLifecycleEnvironment, nativeSessionAuthEnvironment, type RustNativeSessionAuthOptions } from "./rust-public-ingress-config.js";

const local: RustNativeSessionAuthOptions = {
  kind: "local_account", secret: "test-only", secureCookie: false, assertionKey: "test-proof",
};

describe("native WebSocket session fallback configuration", () => {
  it("rejects ambiguous local-account credential precedence before starting Rust", () => {
    expect(() => nativeSessionAuthEnvironment(local)).toThrow("explicit WebSocket cookie fallback");
  });

  it.each(["session", "local_implicit"] as const)("passes the explicit %s fallback", (fallback) => {
    expect(nativeSessionAuthEnvironment({ ...local, websocketCookieFallback: fallback }))
      .toHaveProperty("RUDDER_NATIVE_WEBSOCKET_COOKIE_FALLBACK", fallback);
  });

  it("preserves configurations without local-account sessions", () => {
    expect(nativeSessionAuthEnvironment()).toEqual({});
    expect(nativeSessionAuthEnvironment({ ...local, kind: "better_auth" }))
      .not.toHaveProperty("RUDDER_NATIVE_WEBSOCKET_COOKIE_FALLBACK");
  });
});

describe("native local-account lifecycle transport", () => {
  const lifecycle = {
    installationId: "test-installation", expectedIssuer: "https://identity.example",
    identityOrigin: "https://identity.example", audience: "test-audience",
  };
  const ingress = { listenAddr: "127.0.0.1:3100", nodeUpstream: "http://127.0.0.1:3101", authorizationKey: "test-only" };

  it("passes only lifecycle configuration and leaves session secrets in their dedicated transport", () => {
    const env = nativeLocalAccountLifecycleEnvironment({ ...ingress, sessionAuth: local, localAccountLifecycle: lifecycle });
    expect(JSON.parse(env.RUDDER_NATIVE_LOCAL_ACCOUNT_AUTH_CONFIG)).toEqual(lifecycle);
    expect(env.RUDDER_NATIVE_LOCAL_ACCOUNT_AUTH_CONFIG).not.toContain(local.secret);
  });

  it("rejects lifecycle authority without the matching local-account session mode", () => {
    expect(() => nativeLocalAccountLifecycleEnvironment({ ...ingress, localAccountLifecycle: lifecycle })).toThrow();
    expect(() => nativeLocalAccountLifecycleEnvironment({ ...ingress, sessionAuth: { ...local, kind: "better_auth" }, localAccountLifecycle: lifecycle })).toThrow();
    expect(nativeLocalAccountLifecycleEnvironment(ingress)).toEqual({});
  });
});
