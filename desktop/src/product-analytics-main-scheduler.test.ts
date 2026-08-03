import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deriveDesktopProductAnalyticsInstallationId, startDesktopProductAnalyticsScheduler } from "./product-analytics-main-scheduler.js";
import { loadOrCreateDesktopTelemetryState } from "./product-analytics-telemetry.js";

describe("desktop product analytics main scheduler", () => {
  it("uses the exporter HMAC and synchronizes anonymous settings through Identity", async () => {
    expect(deriveDesktopProductAnalyticsInstallationId("secret", "installation")).toBe(
      "8c22b33f5fc58cf412530b872b77c76601dbfcac57d7f76b3cf6aa106192591a",
    );
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-telemetry-main-scheduler-"));
    const telemetry = await loadOrCreateDesktopTelemetryState(root);
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
    let scheduler: { stop(): void } | null = null;
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recordProductAnalyticsConsent).toHaveBeenCalledWith({ mode: "anonymous", decision: "granted", consentVersion: "v1" });
    expect(issueProductAnalyticsAssertion).not.toHaveBeenCalled();
    expect(scheduler).not.toBeNull();
    scheduler?.stop();
  });
});
