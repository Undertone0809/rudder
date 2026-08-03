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
});
