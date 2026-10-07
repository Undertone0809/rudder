import detectPort from "detect-port";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RudderAppHandle } from "../app.js";
import { assertPublicIngressExposure, preparePublicIngressStartup } from "../bootstrap/public-ingress-startup.js";
import type { Config } from "../config.js";

vi.mock("detect-port", () => ({ default: vi.fn() }));
const config = (overrides: Partial<Config> = {}) => ({
  host: "127.0.0.1", deploymentMode: "local_trusted", rustPublicIngressMode: "required", ...overrides,
}) as Config;
beforeEach(() => vi.mocked(detectPort).mockReset());

describe("explicit public ingress startup", () => {
  it("keeps the ordinary listener and app options when off", async () => {
    const ingress = await preparePublicIngressStartup(config({ host: "0.0.0.0", rustPublicIngressMode: "off" }), 3100);
    expect(ingress).toMatchObject({ nodeListenHost: "0.0.0.0", nodeListenPort: 3100, publicApiUrl: "http://localhost:3100", appOptions: {} });
    expect(detectPort).not.toHaveBeenCalled();
    const ready = vi.fn();
    const reject = vi.fn();
    await ingress.onListening({} as RudderAppHandle, reject, ready)();
    expect(ready).toHaveBeenCalledOnce();
    expect(reject).not.toHaveBeenCalled();
  });

  it("rejects implicit Board exposure and nonnumeric topology before resource acquisition", () => {
    expect(() => assertPublicIngressExposure(config({ host: "0.0.0.0" }), false)).toThrow("implicit local Board");
    expect(() => assertPublicIngressExposure(config({ host: "localhost" }), false)).toThrow("numeric listener");
    expect(() => assertPublicIngressExposure(config({ host: "::1" }), false)).not.toThrow();
    expect(() => assertPublicIngressExposure(config({ host: "0.0.0.0", deploymentMode: "authenticated" }), false)).not.toThrow();
  });

  it("separates private ports and authorization keys while preserving an explicit actor signer", async () => {
    vi.mocked(detectPort).mockResolvedValue(3101);
    const ingress = await preparePublicIngressStartup(config({ rustFoundationActorEnvelopeKey: "existing-actor-signer", rustPublicIngressTrustedProxies: "192.0.2.1,::1" }), 3100);
    expect(ingress.nodeListenHost).toBe("127.0.0.1");
    expect(ingress.nodeListenPort).toBe(3101);
    expect(ingress.appOptions.rustPublicIngress).toMatchObject({ listenAddr: "127.0.0.1:3100", nodeUpstream: "http://127.0.0.1:3101" });
    expect(ingress.appOptions.rustFoundationActorEnvelopeKey).toBe("existing-actor-signer");
    expect(ingress.appOptions.rustPublicIngressAuthKey).toMatch(/^[a-f0-9]{64}$/);
    expect(ingress.appOptions.rustPublicIngress?.authorizationKey).toBe(ingress.appOptions.rustPublicIngressAuthKey);
    expect(ingress.appOptions.rustPublicIngressAuthKey).not.toBe(ingress.appOptions.rustFoundationActorEnvelopeKey);
    expect(ingress.appOptions.rustPublicIngress?.trustedProxies).toBe("192.0.2.1,::1");
  });

  it("fails closed if private port selection collides with the public port", async () => {
    vi.mocked(detectPort).mockResolvedValue(65535);
    await expect(preparePublicIngressStartup(config(), 65535)).rejects.toThrow("distinct ports");
  });

  it("waits for public readiness before reporting the listener and rejects missing identity", async () => {
    vi.mocked(detectPort).mockResolvedValue(3101);
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
    vi.mocked(detectPort).mockResolvedValue(3101);
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
