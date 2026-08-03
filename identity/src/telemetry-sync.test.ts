import { describe, expect, it, vi } from "vitest";
import { syncProductAnalyticsConsent } from "./telemetry-sync.js";

describe("syncProductAnalyticsConsent", () => {
  it("posts only pseudonymous consent state to the private collector hook", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await syncProductAnalyticsConsent({
      config: {
        collectorUrl: "https://telemetry.example.test",
        syncSecret: "s".repeat(32),
      },
      consent: {
        installationId: "installation-1",
        analyticsSubject: "a".repeat(64),
        consentVersion: "v1",
        consentEpoch: 3,
        revoked: true,
      },
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://telemetry.example.test/api/analytics/v1/internal/consent/sync",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-rudder-telemetry-consent-sync-secret": "s".repeat(32),
        }),
        body: JSON.stringify({
          installationId: "installation-1",
          analyticsSubject: "a".repeat(64),
          consentVersion: "v1",
          consentEpoch: 3,
          revoked: true,
        }),
      }),
    );
  });

  it("fails closed on a non-success collector response", async () => {
    await expect(syncProductAnalyticsConsent({
      config: { collectorUrl: "https://telemetry.example.test", syncSecret: "s".repeat(32) },
      consent: {
        installationId: "installation-1",
        analyticsSubject: null,
        consentVersion: "v1",
        consentEpoch: 1,
        revoked: false,
      },
      fetchImpl: async () => new Response(null, { status: 503 }),
    })).rejects.toThrow("telemetry_consent_sync_failed");
  });
});
