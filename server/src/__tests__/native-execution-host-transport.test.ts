import { afterEach, describe, expect, it, vi } from "vitest";
import { createFoundationChildEnvironment } from "../services/rust-public-ingress-config.js";
import { createRustLiveEventTransportEnvelope } from "../services/rust-actor-envelope.js";
import {
  publishGlobalLiveEvent, publishLiveEvent, subscribeCompanyLiveEvents,
  subscribeGlobalLiveEvents, subscribeLiveEventTransport,
} from "../services/live-events.js";

afterEach(() => vi.unstubAllEnvs());

describe("native execution transport facts", () => {
  it("hands existing operator variables to generic execution separately from Chat ambient env", () => {
    vi.stubEnv("SYNTHETIC_PROVIDER_TOKEN", "fixture-only");
    vi.stubEnv("RUDDER_API_URL", "http://stale.invalid:9999");
    const env = createFoundationChildEnvironment({
      databaseUrl: "postgres://fixture/db", actorEnvelopeKey: "fixture-key",
      secretsMasterKeyFile: "/fixture/master.key",
      publicIngress: {
        listenAddr: "127.0.0.1:3100", nodeUpstream: "http://127.0.0.1:3101", authorizationKey: "fixture-key",
        publicApiUrl: "http://127.0.0.1:3100", authPublicBaseUrl: "https://fixture.example/base",
        identityAuth: { assertionKey: "fixture-assertion", agentJwtSecret: "fixture-jwt", agentJwtIssuer: "fixture", agentJwtAudience: "fixture", localImplicitEnabled: false },
      },
    });
    expect(env).not.toHaveProperty("SYNTHETIC_PROVIDER_TOKEN");
    expect(JSON.parse(env.RUDDER_NATIVE_HOST_RUNTIME_ENVIRONMENT)).toMatchObject({ SYNTHETIC_PROVIDER_TOKEN: "fixture-only" });
    expect(env.RUDDER_NATIVE_HOST_API_URL).toBe("http://127.0.0.1:3100");
    expect(env.RUDDER_NATIVE_HOST_AUTH_PUBLIC_BASE_URL).toBe("https://fixture.example/base");
    expect(JSON.parse(env.RUDDER_NATIVE_HOST_BUNDLED_SKILL_ROOTS)).toHaveLength(2);
  });

  it("forwards each already-created frame once and preserves existing org/global subscriptions", () => {
    const frames: unknown[] = [], org: unknown[] = [], global: unknown[] = [];
    const stop = [subscribeLiveEventTransport(event => frames.push(event)),
      subscribeCompanyLiveEvents("native-transport-fixture", event => org.push(event)),
      subscribeGlobalLiveEvents(event => global.push(event))];
    try {
      const local = publishLiveEvent({ orgId: "native-transport-fixture", type: "activity.logged", payload: { nested: { value: "unchanged" } }, dedupeKey: "fixture-local" });
      const broadcast = publishGlobalLiveEvent({ type: "activity.logged", dedupeKey: "fixture-global" });
      expect(frames).toEqual([local, broadcast]);
      expect(frames[0]).toBe(local);
      expect(org).toEqual([local]);
      expect(global).toEqual([broadcast]);
    } finally { stop.forEach(unsubscribe => unsubscribe()); }
  });

  it("binds the fixed private live transport identity to frame bytes and organization", () => {
    const input = { organizationId: "fixture-org", body: Buffer.from('{"orgId":"fixture-org"}'), secret: "fixture-secret", nonce: "fixture-nonce", requestId: "fixture-request", nowSeconds: 1000 };
    const signed = createRustLiveEventTransportEnvelope(input);
    // Same fixed envelope is checked by Rust's ActorEnvelope signing test.
    expect(signed.signature).toBe("d66e58e1091fc31e3aa6b91e9c50f38a2b90edee0645b8f5952473cb2707c649");
    expect(signed).toMatchObject({ actor: { kind: "system", id: "node-live-events-transport" }, action: "live.events.forward", method: "POST", path: "/internal/live-events/forward", organizationId: "fixture-org" });
    expect(createRustLiveEventTransportEnvelope(input)).toEqual(signed);
    expect(createRustLiveEventTransportEnvelope({ ...input, body: Buffer.from('{}') }).signature).not.toBe(signed.signature);
    expect(createRustLiveEventTransportEnvelope({ ...input, organizationId: "foreign" }).signature).not.toBe(signed.signature);
  });
});
