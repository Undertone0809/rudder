import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Request } from "express";
import { describe, expect, it, vi } from "vitest";
import { createLocalAccountSessionRevocation } from "../services/local-account-session-revocation.js";
import {
  ACTOR_ENVELOPE_BRIDGE_AUTHORITY,
  canonicalActorEnvelopeV2SigningBytes,
  createPrivateActorEnvelopeBridge,
  actorEnvelopeBodySha256,
  type ActorEnvelopeV2UnsignedClaims,
} from "../auth/actor-envelope-bridge.js";

const SIGNING_KEY = "bridge-test-key-do-not-log";
const BODY = Buffer.from('{"message":"hello"}', "utf8");

type Fixture = {
  bridge: ReturnType<typeof createPrivateActorEnvelopeBridge>;
  request: Request;
  resolveSessionFromHeaders: ReturnType<typeof vi.fn>;
  sessionRevocation: ReturnType<typeof createLocalAccountSessionRevocation>;
  setSession: (sessionId: string, userId?: string) => void;
  setNow: (now: number) => void;
};

function session(sessionId = "session-1", userId = "user-1") {
  return {
    session: { id: sessionId, userId },
    user: { id: userId, email: "operator@example.com", name: "Operator" },
  };
}

function createRequest(overrides: Record<string, unknown> = {}): Request {
  return {
    method: "POST",
    originalUrl: "/api/agent-actions?view=full",
    url: "/api/agent-actions?view=full",
    headers: { cookie: "better-auth.session_token=opaque-session" },
    rawBody: BODY,
    actor: {
      type: "board",
      source: "session",
      userId: "user-1",
      orgIds: ["org-1"],
      isInstanceAdmin: false,
    },
    ...overrides,
  } as unknown as Request;
}

function fixture(): Fixture {
  let currentSession = session();
  let now = 1_000;
  const sessionRevocation = createLocalAccountSessionRevocation();
  const resolveSessionFromHeaders = vi.fn(async () => currentSession);
  const bridge = createPrivateActorEnvelopeBridge({
    signingKey: SIGNING_KEY,
    audience: "rudder-node",
    resolveSessionFromHeaders,
    sessionRevocation,
    now: () => now,
    envelopeLifetimeSeconds: 10,
    requestIdFactory: () => "request-1",
    nonceFactory: () => `nonce-${now}`,
  });
  return {
    bridge,
    request: createRequest(),
    resolveSessionFromHeaders,
    sessionRevocation,
    setSession(sessionId, userId = "user-1") {
      currentSession = session(sessionId, userId);
    },
    setNow(value) {
      now = value;
    },
  };
}

function unsignedClaims(
  envelope: Awaited<ReturnType<Fixture["bridge"]["issue"]>>,
): ActorEnvelopeV2UnsignedClaims {
  return {
    protocolVersion: envelope.protocolVersion,
    actor: envelope.actor,
    organizationId: envelope.organizationId,
    sessionId: envelope.sessionId,
    authEpoch: envelope.authEpoch,
    audience: envelope.audience,
    method: envelope.method,
    path: envelope.path,
    action: envelope.action,
    bodySha256: envelope.bodySha256,
    requestId: envelope.requestId,
    nonce: envelope.nonce,
    issuedAt: envelope.issuedAt,
    expiresAt: envelope.expiresAt,
  };
}

function signatureFor(claims: ActorEnvelopeV2UnsignedClaims): Buffer {
  return createHmac("sha256", Buffer.from(SIGNING_KEY, "utf8"))
    .update(canonicalActorEnvelopeV2SigningBytes(claims))
    .digest();
}

describe("private actor-envelope v2 bridge", () => {
  it("issues every Rust v2 claim from the active server-owned session", async () => {
    const { bridge, request } = fixture();
    const envelope = await bridge.issue(request, {
      organizationId: "org-1",
      action: "agent.execute",
    });

    expect(envelope).toMatchObject({
      protocolVersion: 2,
      actor: { kind: "user", id: "user-1" },
      organizationId: "org-1",
      sessionId: "session-1",
      authEpoch: 1,
      audience: "rudder-node",
      method: "POST",
      path: "/api/agent-actions",
      action: "agent.execute",
      bodySha256: createHash("sha256").update(BODY).digest("hex"),
      requestId: "request-1",
      nonce: "nonce-1000",
      issuedAt: 1_000,
      expiresAt: 1_010,
    });
    expect(envelope.signature).toMatch(/^[0-9a-f]{64}$/u);
    expect(signatureFor(unsignedClaims(envelope)).toString("hex")).toBe(envelope.signature);
    expect(envelope).not.toHaveProperty("signingKey");
    expect(JSON.stringify(envelope)).not.toContain(SIGNING_KEY);
    expect(JSON.stringify(bridge)).not.toContain(SIGNING_KEY);
    expect(bridge.authority).toBe(ACTOR_ENVELOPE_BRIDGE_AUTHORITY);
  });

  it("advances the wire auth epoch after server logout and binds a new session to it", async () => {
    const fixtureState = fixture();
    const first = await fixtureState.bridge.issue(fixtureState.request, {
      organizationId: "org-1",
      action: "agent.execute",
    });

    fixtureState.sessionRevocation.publish("user-1");
    fixtureState.setSession("session-2");
    fixtureState.setNow(1_001);
    const second = await fixtureState.bridge.issue(fixtureState.request, {
      organizationId: "org-1",
      action: "agent.execute",
    });

    expect(first.authEpoch).toBe(1);
    expect(second.authEpoch).toBe(2);
    expect(second.sessionId).toBe("session-2");
    expect(fixtureState.bridge.currentAuthEpoch()).toBe(2);
  });

  it("rejects an unauthorized organization and an actor that disagrees with the resolved session", async () => {
    const organizationFixture = fixture();
    await expect(organizationFixture.bridge.issue(organizationFixture.request, {
      organizationId: "org-2",
      action: "agent.execute",
    })).rejects.toMatchObject({ code: "organization_not_authorized" });

    const actorFixture = fixture();
    const mismatchedRequest = createRequest({
      actor: {
        ...(actorFixture.request as unknown as { actor: Record<string, unknown> }).actor,
        userId: "user-2",
      },
    });
    await expect(actorFixture.bridge.issue(mismatchedRequest, {
      organizationId: "org-1",
      action: "agent.execute",
    })).rejects.toMatchObject({ code: "actor_context_mismatch" });
  });

  it("takes audience and actor only from bridge configuration and the resolved session", async () => {
    const { bridge, request } = fixture();
    const untrustedExtras = {
      organizationId: "org-1",
      action: "agent.execute",
      audience: "attacker-audience",
      actor: { kind: "agent", id: "attacker" },
      sessionId: "attacker-session",
      authEpoch: 999,
    } as unknown as Parameters<typeof bridge.issue>[1];
    const envelope = await bridge.issue(request, untrustedExtras);

    expect(envelope.audience).toBe("rudder-node");
    expect(envelope.actor).toEqual({ kind: "user", id: "user-1" });
    expect(envelope.sessionId).toBe("session-1");
    expect(envelope.authEpoch).toBe(1);
  });

  it("bounds expiry and rejects a repeated nonce before issuing a replayable envelope", async () => {
    const state = fixture();
    const first = await state.bridge.issue(state.request, {
      organizationId: "org-1",
      action: "agent.execute",
    });
    expect(first.expiresAt - first.issuedAt).toBe(10);

    await expect(state.bridge.issue(state.request, {
      organizationId: "org-1",
      action: "agent.execute",
    })).rejects.toMatchObject({ code: "nonce_replay" });

    state.setNow(1_010);
    const afterExpiry = await state.bridge.issue(state.request, {
      organizationId: "org-1",
      action: "agent.execute",
    });
    expect(afterExpiry.issuedAt).toBe(1_010);
    expect(afterExpiry.nonce).toBe("nonce-1010");
  });

  it("fails closed for a missing key, missing session, and revocation race", async () => {
    const state = fixture();
    expect(() => createPrivateActorEnvelopeBridge({
      signingKey: "",
      audience: "rudder-node",
      resolveSessionFromHeaders: state.resolveSessionFromHeaders,
      sessionRevocation: state.sessionRevocation,
    })).toThrow(/signing key/u);

    state.resolveSessionFromHeaders.mockResolvedValueOnce(null);
    await expect(state.bridge.issue(state.request, {
      organizationId: "org-1",
      action: "agent.execute",
    })).rejects.toMatchObject({ code: "session_required" });

    const racing = fixture();
    racing.resolveSessionFromHeaders.mockImplementationOnce(async () => {
      racing.sessionRevocation.publish("user-1");
      return session();
    });
    await expect(racing.bridge.issue(racing.request, {
      organizationId: "org-1",
      action: "agent.execute",
    })).rejects.toMatchObject({ code: "session_changed" });
  });

  it("binds the exact request path, method, and raw body bytes", async () => {
    const state = fixture();
    const envelope = await state.bridge.issue(state.request, {
      organizationId: "org-1",
      action: "agent.execute",
    });
    const original = signatureFor(unsignedClaims(envelope));

    const changedBody = {
      ...unsignedClaims(envelope),
      bodySha256: createHash("sha256").update(Buffer.from('{"message":"changed"}', "utf8")).digest("hex"),
    };
    const changedPath = { ...unsignedClaims(envelope), path: "/api/other-action" };
    expect(timingSafeEqual(original, signatureFor(changedBody))).toBe(false);
    expect(timingSafeEqual(original, signatureFor(changedPath))).toBe(false);
    expect(envelope.path).toBe("/api/agent-actions");
    expect(envelope.bodySha256).toBe(createHash("sha256").update(BODY).digest("hex"));
  });

  it("matches the machine-readable Rust canonicalization vector", () => {
    const vector = JSON.parse(readFileSync(new URL(
      "../../../native/crates/auth-core/test-vectors/actor-envelope-v2.json",
      import.meta.url,
    ), "utf8")) as {
      claims: Omit<ActorEnvelopeV2UnsignedClaims, "bodySha256"> & { body: string };
      bodySha256: string;
      signingBytesHex: string;
    };
    const claims: ActorEnvelopeV2UnsignedClaims = {
      ...vector.claims,
      bodySha256: vector.bodySha256,
    };
    expect(actorEnvelopeBodySha256(Buffer.from(vector.claims.body, "utf8"))).toBe(
      vector.bodySha256,
    );
    expect(canonicalActorEnvelopeV2SigningBytes(claims).toString("hex")).toBe(vector.signingBytesHex);
  });
});
