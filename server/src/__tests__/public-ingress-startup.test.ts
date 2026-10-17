import { createServer } from "node:net";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RudderAppHandle } from "../app.js";
import { selectAvailablePort } from "../bootstrap/port-selection.js";
import { assertPublicIngressExposure, preparePublicIngressStartup } from "../bootstrap/public-ingress-startup.js";
import type { Config } from "../config.js";

vi.mock("../bootstrap/port-selection.js", () => ({ selectAvailablePort: vi.fn() }));
const config = (overrides: Partial<Config> = {}) => ({
  host: "127.0.0.1", deploymentMode: "local_trusted", deploymentExposure: "private", allowedHostnames: [], rustPublicIngressMode: "required", ...overrides,
}) as Config;
beforeEach(() => vi.mocked(selectAvailablePort).mockReset());
afterEach(() => vi.unstubAllEnvs());

describe("explicit public ingress startup", () => {
  it("keeps the ordinary listener and app options when off", async () => {
    const ingress = await preparePublicIngressStartup(config({ host: "0.0.0.0", rustPublicIngressMode: "off" }), 3100);
    expect(ingress).toMatchObject({ nodeListenHost: "0.0.0.0", nodeListenPort: 3100, publicApiUrl: "http://localhost:3100", appOptions: {} });
    expect(selectAvailablePort).not.toHaveBeenCalled();
    const ready = vi.fn();
    const reject = vi.fn();
    await ingress.onListening({} as RudderAppHandle, reject, ready)();
    expect(ready).toHaveBeenCalledOnce();
    expect(reject).not.toHaveBeenCalled();
  });

  it("does not enable local implicit identity when Desktop explicitly disables native ingress", async () => {
    const ingress = await preparePublicIngressStartup(
      config({ rustPublicIngressMode: "off" }),
      3100,
      undefined,
      "desktop",
    );
    expect(ingress).toMatchObject({
      nodeListenHost: "127.0.0.1",
      nodeListenPort: 3100,
      appOptions: {},
    });
  });

  it("rejects implicit Board exposure and nonnumeric topology before resource acquisition", () => {
    expect(() => assertPublicIngressExposure(config({ host: "0.0.0.0" }), false)).toThrow("implicit local Board");
    expect(() => assertPublicIngressExposure(config({ host: "localhost" }), false)).toThrow("numeric listener");
    expect(() => assertPublicIngressExposure(config(), false, "desktop")).toThrow("Desktop account authentication");
    expect(() => assertPublicIngressExposure(config({ host: "::1" }), false)).not.toThrow();
    expect(() => assertPublicIngressExposure(config({ host: "0.0.0.0", deploymentMode: "authenticated" }), false)).not.toThrow();
  });

  it("separates private ports and authorization keys while preserving an explicit actor signer", async () => {
    vi.mocked(selectAvailablePort).mockResolvedValue(3101);
    const ingress = await preparePublicIngressStartup(config({ rustFoundationActorEnvelopeKey: "existing-actor-signer", rustPublicIngressTrustedProxies: "192.0.2.1,::1" }), 3100, undefined, "cli");
    expect(ingress.nodeListenHost).toBe("127.0.0.1");
    expect(ingress.nodeListenPort).toBe(3101);
    expect(selectAvailablePort).toHaveBeenCalledWith(3101, "127.0.0.1");
    expect(ingress.appOptions.rustPublicIngress).toMatchObject({ listenAddr: "127.0.0.1:3100", nodeUpstream: "http://127.0.0.1:3101" });
    expect(ingress.appOptions.rustFoundationActorEnvelopeKey).toBe("existing-actor-signer");
    expect(ingress.appOptions.rustPublicIngressAuthKey).toMatch(/^[a-f0-9]{64}$/);
    expect(ingress.appOptions.rustPublicIngress?.authorizationKey).toBe(ingress.appOptions.rustPublicIngressAuthKey);
    expect(ingress.appOptions.rustPublicIngressAuthKey).not.toBe(ingress.appOptions.rustFoundationActorEnvelopeKey);
    expect(ingress.appOptions.rustPublicIngress?.trustedProxies).toBe("192.0.2.1,::1");
    expect(ingress.appOptions.rustPublicIngress?.sessionAuth).toBeUndefined();
    expect(ingress.appOptions.rustPublicIngress?.localAccountLifecycle).toBeUndefined();
    expect(ingress.appOptions.rustPublicIngress?.identityAuth).toMatchObject({
      localImplicitEnabled: true,
      assertionKey: expect.any(String),
    });
  });

  it("transports the constructed issuer without selecting a different policy", async () => {
    vi.mocked(selectAvailablePort).mockResolvedValue(3101);
    const descriptor = Object.freeze({ issuer: "local_account" as const, secret: " raw-issuer-secret ", secureCookie: true });
    const ingress = await preparePublicIngressStartup(config(), 3100, undefined, descriptor);
    expect(ingress.appOptions.rustPublicIngress?.browserSessionAuth).toBe(descriptor);
    const disabled = await preparePublicIngressStartup(config({ rustPublicIngressMode: "off" }), 3100, undefined, descriptor);
    expect(disabled.appOptions).toEqual({});
  });

  it("uses the constructed issuer for both Rust resolvers and rejects conflicting local handoffs", async () => {
    vi.mocked(selectAvailablePort).mockResolvedValue(3101);
    vi.stubEnv("BETTER_AUTH_SECRET", "changed-after-issuer-construction");
    const descriptor = Object.freeze({ issuer: "better_auth" as const, secret: "original-issuer-secret", secureCookie: true,
      sessionCookieName: "better-auth.session_token", dontRememberCookieName: "better-auth.dont_remember",
      expiresIn: 604800, updateAge: 86400, disableSessionRefresh: false });
    const ingress = await preparePublicIngressStartup(config({ deploymentMode: "authenticated" }), 3100, undefined, descriptor);
    expect(ingress.appOptions.rustPublicIngress?.sessionAuth).toMatchObject({
      kind: descriptor.issuer, secret: descriptor.secret, secureCookie: true,
    });
    await expect(preparePublicIngressStartup(config(), 3100, { sessionSecret: "different" }, descriptor))
      .rejects.toThrow("issuer settings disagree");
  });

  it("fails closed if private port selection collides with the public port", async () => {
    vi.mocked(selectAvailablePort).mockResolvedValue(65535);
    await expect(preparePublicIngressStartup(config(), 65535)).rejects.toThrow("distinct ports");
  });

  it("requires the effective Better Auth session secret in authenticated native mode", async () => {
    vi.mocked(selectAvailablePort).mockResolvedValue(3101);
    vi.stubEnv("BETTER_AUTH_SECRET", undefined);
    vi.stubEnv("RUDDER_AGENT_JWT_SECRET", undefined);
    vi.stubEnv("RUDDER_PUBLIC_URL", undefined);
    await expect(preparePublicIngressStartup(config({ deploymentMode: "authenticated" }), 3100))
      .rejects.toThrow("configured Better Auth session secret");

    vi.stubEnv("BETTER_AUTH_SECRET", "exact-better-auth-secret");
    const ingress = await preparePublicIngressStartup(config({ deploymentMode: "authenticated" }), 3100);
    expect(ingress.appOptions.rustPublicIngress?.privateHostGate).toMatchObject({
      enabled: true,
      allowedHostnames: [],
      bindHost: "127.0.0.1",
    });
    expect(ingress.appOptions.rustPublicIngress?.sessionAuth).toMatchObject({
      kind: "better_auth",
      secret: "exact-better-auth-secret",
      secureCookie: false,
    });
    expect(ingress.appOptions.rustPublicIngress?.identityAuth?.localImplicitEnabled).toBe(false);
    expect(ingress.appOptions.rustPublicIngress?.sessionAuth?.websocketCookieFallback).toBeUndefined();
    expect(ingress.appOptions.rustPublicIngress?.localAccountLifecycle).toBeUndefined();
  });

  it("keeps the native private-host gate disabled for authenticated public exposure", async () => {
    vi.mocked(selectAvailablePort).mockResolvedValue(3101);
    vi.stubEnv("BETTER_AUTH_SECRET", "exact-better-auth-secret");
    const ingress = await preparePublicIngressStartup(
      config({ deploymentMode: "authenticated", deploymentExposure: "public", allowedHostnames: ["board.example.test"] }),
      3100,
    );
    expect(ingress.appOptions.rustPublicIngress?.privateHostGate).toMatchObject({
      enabled: false,
      allowedHostnames: ["board.example.test"],
      bindHost: "127.0.0.1",
    });
  });

  it("requires Desktop's separate session secret and passes the exact local-cookie mode", async () => {
    vi.mocked(selectAvailablePort).mockResolvedValue(3101);
    await expect(preparePublicIngressStartup(config(), 3100, undefined, "desktop"))
      .rejects.toThrow("Desktop account authentication");
    expect(selectAvailablePort).not.toHaveBeenCalled();

    await expect(preparePublicIngressStartup(config(), 3100, { sessionSecret: "   " }))
      .rejects.toThrow("Desktop account session secret");

    const ingress = await preparePublicIngressStartup(config(), 3100, {
      sessionSecret: "desktop-session-secret",
      secureCookie: true,
    }, "desktop");
    expect(ingress.appOptions.rustPublicIngress?.sessionAuth).toMatchObject({
      kind: "local_account",
      secret: "desktop-session-secret",
      secureCookie: true,
      websocketCookieFallback: "session",
    });
    expect(ingress.appOptions.rustPublicIngress?.identityAuth?.localImplicitEnabled).toBe(false);
    expect(ingress.nodeListenHost).toBe("127.0.0.1");
  });

  it("waits for public readiness before reporting the listener and rejects missing identity", async () => {
    vi.mocked(selectAvailablePort).mockResolvedValue(3101);
    const ingress = await preparePublicIngressStartup(config(), 3100);
    let release!: () => void;
    const readiness = new Promise<void>((resolve) => { release = resolve; });
    const ready = vi.fn();
    const reject = vi.fn();
    const app = { publicIngressBaseUrl: "http://127.0.0.1:3100", waitForPublicIngressReady: () => readiness } as RudderAppHandle;
    const pending = ingress.onListening(app, reject, ready)();
    expect(ready).not.toHaveBeenCalled();
    release();
    await pending;
    expect(ready).toHaveBeenCalledOnce();
    await ingress.onListening({} as RudderAppHandle, reject, ready)();
    expect(reject).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("listener identity") }));
    expect(ready).toHaveBeenCalledOnce();
  });

  it("propagates readiness failure without reporting an alternate listener", async () => {
    vi.mocked(selectAvailablePort).mockResolvedValue(3101);
    const ingress = await preparePublicIngressStartup(config({ host: "::1" }), 3100);
    expect(ingress.publicApiUrl).toBe("http://[::1]:3100");
    const failure = new Error("upstream unavailable");
    const ready = vi.fn();
    const reject = vi.fn();
    await ingress.onListening({ publicIngressBaseUrl: "http://[::1]:3100", waitForPublicIngressReady: () => Promise.reject(failure) } as RudderAppHandle, reject, ready)();
    expect(reject).toHaveBeenCalledWith(failure);
    expect(ready).not.toHaveBeenCalled();
  });
});

describe("bounded listener port selection", () => {
  it("skips an occupied port on loopback without enumerating interfaces", async () => {
    const { selectAvailablePort: selectRealPort } = await vi.importActual<typeof import("../bootstrap/port-selection.js")>(
      "../bootstrap/port-selection.js",
    );
    const networkInterfaces = vi.spyOn(os, "networkInterfaces");
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("Expected an occupied TCP port");

    try {
      const selected = await selectRealPort(address.port, "127.0.0.1");
      expect(selected).not.toBe(address.port);
      expect(selected).toBeGreaterThan(0);
      expect(networkInterfaces).not.toHaveBeenCalled();
    } finally {
      networkInterfaces.mockRestore();
      await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("propagates an unavailable listener address instead of searching unrelated interfaces", async () => {
    const { selectAvailablePort: selectRealPort } = await vi.importActual<typeof import("../bootstrap/port-selection.js")>(
      "../bootstrap/port-selection.js",
    );
    await expect(selectRealPort(0, "192.0.2.123")).rejects.toMatchObject({ code: "EADDRNOTAVAIL" });
  });
});
