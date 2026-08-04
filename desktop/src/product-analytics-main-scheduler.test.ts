import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deriveDesktopProductAnalyticsInstallationId, startDesktopProductAnalyticsScheduler, type DesktopProductAnalyticsScheduler } from "./product-analytics-main-scheduler.js";
import { loadOrCreateDesktopTelemetryState, updateDesktopTelemetryState } from "./product-analytics-telemetry.js";

describe("desktop product analytics main scheduler", () => {
  it("uses the exporter HMAC and synchronizes anonymous settings through Identity", async () => {
    expect(deriveDesktopProductAnalyticsInstallationId("secret", "installation")).toBe(
      "8c22b33f5fc58cf412530b872b77c76601dbfcac57d7f76b3cf6aa106192591a",
    );
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-telemetry-main-scheduler-"));
    const telemetry = await loadOrCreateDesktopTelemetryState(root);
    await updateDesktopTelemetryState(telemetry.statePath, { mode: "account_linked", consentEpoch: 7 });
    const recordProductAnalyticsConsent = vi.fn(async () => ({ consentEpoch: 2 }));
    const issueProductAnalyticsAssertion = vi.fn(async () => "assertion");
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/instance/settings/product-analytics")) {
        return new Response(JSON.stringify({ mode: "anonymous", consentVersion: "v1", consentEpoch: 1 }), { status: 200 });
      }
      if (url.endsWith("/api/orgs")) return new Response(JSON.stringify([{ id: "org-1" }]), { status: 200 });
      if (url.endsWith("/outbox/claim")) return new Response(JSON.stringify({ claimToken: null, events: [] }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    });
    let scheduler: DesktopProductAnalyticsScheduler | null = null;
    await startDesktopProductAnalyticsScheduler("http://127.0.0.1:3100", {
      collectorUrl: "https://telemetry.example.test",
      identityRuntime: {
        telemetryStatePromise: Promise.resolve(telemetry),
        recordProductAnalyticsConsent,
        issueProductAnalyticsAssertion,
      },
      scheduler: null,
      setScheduler: (value) => { scheduler = value; },
      fetchImpl,
    });
    expect(recordProductAnalyticsConsent).toHaveBeenCalledWith({ mode: "anonymous", decision: "granted", consentVersion: "v1" });
    expect(scheduler).not.toBeNull();
    await scheduler?.runNow();
    expect(issueProductAnalyticsAssertion).not.toHaveBeenCalled();
    const claimCall = fetchImpl.mock.calls.find(([input]) => String(input).includes("/outbox/claim"));
    expect(claimCall?.[1]?.body).toContain('"deliveryMode":"anonymous"');
    scheduler?.stop();
  });

  it("binds account-linked delivery authorization to the claimed local user", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-telemetry-main-scheduler-linked-"));
    const telemetry = await loadOrCreateDesktopTelemetryState(root);
    await updateDesktopTelemetryState(telemetry.statePath, { mode: "account_linked", consentEpoch: 7 });
    const recordProductAnalyticsConsent = vi.fn(async () => ({ consentEpoch: 7 }));
    const issueProductAnalyticsAssertion = vi.fn(async (input: { consentedLocalUserId?: string | null }) => {
      expect(input.consentedLocalUserId).toBe("user-a");
      return "assertion";
    });
    const eventId = "22222222-2222-4222-8222-222222222222";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/instance/settings/product-analytics")) {
        return new Response(JSON.stringify({ mode: "account_linked", consentVersion: "v1", consentEpoch: 7 }), { status: 200 });
      }
      if (url.endsWith("/api/orgs")) return new Response(JSON.stringify([{ id: "org-1" }]), { status: 200 });
      if (url.endsWith("/outbox/claim")) {
        return new Response(JSON.stringify({ claimToken: "claim-1", consentedLocalUserId: "user-a", events: [{ eventId, eventName: "work_loop_completed" }] }), { status: 200 });
      }
      if (url.endsWith("/events:batch")) {
        expect(init?.headers).toMatchObject({ authorization: "assertion" });
        return new Response(JSON.stringify({ accepted: 1, duplicate: 0, rejected: [] }), { status: 200 });
      }
      if (url.endsWith("/outbox/ack")) return new Response(JSON.stringify({ state: "delivered", updatedCount: 1 }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    });
    let scheduler: DesktopProductAnalyticsScheduler | null = null;

    await startDesktopProductAnalyticsScheduler("http://127.0.0.1:3100", {
      collectorUrl: "https://telemetry.example.test",
      identityRuntime: {
        telemetryStatePromise: Promise.resolve(telemetry),
        recordProductAnalyticsConsent,
        issueProductAnalyticsAssertion,
      },
      scheduler: null,
      setScheduler: (value) => { scheduler = value; },
      fetchImpl,
    });

    await scheduler?.runNow();

    expect(issueProductAnalyticsAssertion).toHaveBeenCalledWith(expect.objectContaining({
      mode: "account_linked",
      consentedLocalUserId: "user-a",
    }));
    const ackCall = fetchImpl.mock.calls.find(([input]) => String(input).endsWith("/outbox/ack"));
    expect(JSON.parse(String(ackCall?.[1]?.body))).toMatchObject({
      deliveryMode: "account_linked",
      claimToken: "claim-1",
      eventIds: [eventId],
      delivered: true,
    });
    scheduler?.stop();
  });

  it("stops without uploading when local analytics settings cannot be read", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-telemetry-main-scheduler-settings-error-"));
    const telemetry = await loadOrCreateDesktopTelemetryState(root);
    await updateDesktopTelemetryState(telemetry.statePath, { mode: "account_linked", consentEpoch: 7 });
    const recordProductAnalyticsConsent = vi.fn(async () => ({ consentEpoch: 8 }));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/instance/settings/product-analytics")) return new Response(null, { status: 503 });
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    let scheduler: DesktopProductAnalyticsScheduler | null = null;
    await startDesktopProductAnalyticsScheduler("http://127.0.0.1:3100", {
      collectorUrl: "https://telemetry.example.test",
      identityRuntime: {
        telemetryStatePromise: Promise.resolve(telemetry),
        recordProductAnalyticsConsent,
        issueProductAnalyticsAssertion: vi.fn(async () => "assertion"),
      },
      scheduler: null,
      setScheduler: (value) => { scheduler = value; },
      fetchImpl,
    });

    expect(recordProductAnalyticsConsent).not.toHaveBeenCalled();
    expect(scheduler).toBeNull();
  });

  it("does not use anonymous fallback authorization when Identity is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-telemetry-main-scheduler-identity-error-"));
    const telemetry = await loadOrCreateDesktopTelemetryState(root);
    const identityError = Object.assign(new Error("temporary outage"), { code: "IDENTITY_UNAVAILABLE" });
    const recordProductAnalyticsConsent = vi.fn(async () => { throw identityError; });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/instance/settings/product-analytics")) {
        return new Response(JSON.stringify({ mode: "anonymous", consentVersion: "v1", consentEpoch: 1 }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    let scheduler: DesktopProductAnalyticsScheduler | null = null;
    await startDesktopProductAnalyticsScheduler("http://127.0.0.1:3100", {
      collectorUrl: "https://telemetry.example.test",
      identityRuntime: {
        telemetryStatePromise: Promise.resolve(telemetry),
        recordProductAnalyticsConsent,
        issueProductAnalyticsAssertion: vi.fn(async () => "assertion"),
      },
      scheduler: null,
      setScheduler: (value) => { scheduler = value; },
      fetchImpl,
    });

    expect(recordProductAnalyticsConsent).toHaveBeenCalledOnce();
    expect(scheduler).toBeNull();
  });

  it("registers an explicit anonymous deployment credential before uploading", async () => {
    vi.stubEnv("RUDDER_TELEMETRY_ANONYMOUS_AUTHORIZATION", "deployment-secret");
    try {
      const root = await mkdtemp(path.join(os.tmpdir(), "rudder-telemetry-main-scheduler-anonymous-deployment-"));
      const telemetry = await loadOrCreateDesktopTelemetryState(root);
      const identityError = Object.assign(new Error("not signed in"), { code: "IDENTITY_NOT_SIGNED_IN" });
      const recordProductAnalyticsConsent = vi.fn(async () => { throw identityError; });
      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/instance/settings/product-analytics")) {
          return new Response(JSON.stringify({ mode: "anonymous", consentVersion: "v1", consentEpoch: 4 }), { status: 200 });
        }
        if (url.endsWith("/api/orgs")) return new Response(JSON.stringify([{ id: "org-1" }]), { status: 200 });
        if (url.endsWith("/internal/anonymous/consent")) {
          expect(init?.headers).toMatchObject({ "x-rudder-telemetry-anonymous-authorization": "deployment-secret" });
          expect(JSON.parse(String(init?.body))).toMatchObject({ consentVersion: "v1", consentEpoch: 4, revoked: false });
          return new Response(JSON.stringify({ revoked: false }), { status: 200 });
        }
        if (url.endsWith("/outbox/claim")) return new Response(JSON.stringify({ claimToken: null, events: [] }), { status: 200 });
        return new Response(JSON.stringify({}), { status: 200 });
      });
      let scheduler: DesktopProductAnalyticsScheduler | null = null;
      await startDesktopProductAnalyticsScheduler("http://127.0.0.1:3100", {
        collectorUrl: "https://telemetry.example.test",
        identityRuntime: {
          telemetryStatePromise: Promise.resolve(telemetry),
          recordProductAnalyticsConsent,
          issueProductAnalyticsAssertion: vi.fn(async () => "assertion"),
        },
        scheduler: null,
        setScheduler: (value) => { scheduler = value; },
        fetchImpl,
      });
      expect(scheduler).not.toBeNull();
      const registration = fetchImpl.mock.calls.find(([input]) => String(input).endsWith("/internal/anonymous/consent"));
      expect(registration).toBeDefined();
      scheduler?.stop();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
