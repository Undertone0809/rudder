import { describe, expect, it } from "vitest";
import {
  buildProductAnalyticsCollectorDashboard,
  createProductAnalyticsCollector,
  InMemoryProductAnalyticsCollectorStore,
  validateProductAnalyticsCollectorEvent,
} from "./product-analytics-collector.js";
import {
  PRODUCT_ANALYTICS_FIXTURE_AUTHORIZATION,
  PRODUCT_ANALYTICS_FIXTURE_INSTALLATIONS,
  PRODUCT_ANALYTICS_FIXTURE_NOW,
  productAnalyticsFixtureDashboardEvents,
  productAnalyticsFixtureEvent,
} from "./product-analytics-fixture.js";

const SENSITIVE_TOKEN = /(prompt|transcript|title|description|body|content|url|token|secret|password|credential|email|hostname|username)/i;

describe("product analytics PRD gates", () => {
  it("uses a deterministic fixture and keeps every accepted seed privacy-safe", () => {
    const first = productAnalyticsFixtureEvent(0);
    const second = productAnalyticsFixtureEvent(0);
    expect(first).toEqual(second);
    expect(first.occurredAt).toBe(PRODUCT_ANALYTICS_FIXTURE_NOW);

    const seeds = Array.from({ length: 20 }, (_, index) => productAnalyticsFixtureEvent(index));
    for (const seed of seeds) {
      const serialized = JSON.stringify(seed);
      expect(serialized).not.toMatch(SENSITIVE_TOKEN);
      const result = validateProductAnalyticsCollectorEvent(seed);
      expect(result).not.toHaveProperty("status", "rejected");
    }
  });

  it("proves idempotency, offline-safe retry, revoke races, and shared-user isolation", async () => {
    const store = new InMemoryProductAnalyticsCollectorStore();
    store.setInstallationState(PRODUCT_ANALYTICS_FIXTURE_AUTHORIZATION.installationId, {
      consentVersion: "v1",
      consentEpoch: 1,
      revoked: false,
    });
    const collector = createProductAnalyticsCollector(store);
    const payload = productAnalyticsFixtureEvent(1, { pseudonymousInstallationId: "fixture-installation-hash" });
    const first = collector.ingestBatch({
      authorization: PRODUCT_ANALYTICS_FIXTURE_AUTHORIZATION,
      events: [payload],
      now: new Date(PRODUCT_ANALYTICS_FIXTURE_NOW),
    });
    const duplicate = collector.ingestBatch({
      authorization: PRODUCT_ANALYTICS_FIXTURE_AUTHORIZATION,
      events: [payload],
      now: new Date(PRODUCT_ANALYTICS_FIXTURE_NOW),
    });
    expect(first.accepted).toBe(1);
    expect(duplicate.duplicate).toBe(1);

    const revoked = collector.advanceConsent({
      installationId: PRODUCT_ANALYTICS_FIXTURE_AUTHORIZATION.installationId,
      consentVersion: "v1",
      consentEpoch: 2,
      revoked: true,
    });
    const stale = collector.ingestBatch({
      authorization: PRODUCT_ANALYTICS_FIXTURE_AUTHORIZATION,
      events: [productAnalyticsFixtureEvent(2)],
      now: new Date(PRODUCT_ANALYTICS_FIXTURE_NOW),
    });
    expect(revoked.revoked).toBe(true);
    expect(stale.rejected[0]?.errorCode).toBe("revoked");

    const sharedUserStore = new InMemoryProductAnalyticsCollectorStore();
    const sharedUserCollector = createProductAnalyticsCollector(sharedUserStore);
    const sharedAuthorization = (installationId: string) => ({
      ...PRODUCT_ANALYTICS_FIXTURE_AUTHORIZATION,
      installationId,
      analyticsSubject: "shared-user-subject",
      pseudonymousInstallationId: null,
      mode: "account_linked" as const,
    });
    for (const installationId of PRODUCT_ANALYTICS_FIXTURE_INSTALLATIONS.slice(0, 2)) {
      sharedUserStore.setSubjectState(installationId, "shared-user-subject", { consentVersion: "v1", consentEpoch: 1, revoked: false });
    }
    const sharedFirst = sharedUserCollector.ingestBatch({
      authorization: sharedAuthorization(PRODUCT_ANALYTICS_FIXTURE_INSTALLATIONS[0]),
      events: [productAnalyticsFixtureEvent(10, { eventId: "33333333-3333-4333-8333-333333333333" })],
      now: new Date(PRODUCT_ANALYTICS_FIXTURE_NOW),
    });
    const sharedSecond = sharedUserCollector.ingestBatch({
      authorization: sharedAuthorization(PRODUCT_ANALYTICS_FIXTURE_INSTALLATIONS[1]),
      events: [productAnalyticsFixtureEvent(11, { eventId: "33333333-3333-4333-8333-333333333334" })],
      now: new Date(PRODUCT_ANALYTICS_FIXTURE_NOW),
    });
    expect(sharedFirst.accepted).toBe(1);
    expect(sharedSecond.accepted).toBe(1);
    expect(sharedUserCollector.store.listEvents().map((event) => event.installationId).sort()).toEqual([...PRODUCT_ANALYTICS_FIXTURE_INSTALLATIONS.slice(0, 2)].sort());
    expect(sharedUserCollector.store.listEvents().every((event) => event.analyticsSubject === "shared-user-subject")).toBe(true);
  });

  it("builds thresholded rollups, installation cohorts, and quality counters", () => {
    const events = productAnalyticsFixtureDashboardEvents(30);
    const dashboard = buildProductAnalyticsCollectorDashboard(events, { privacyThreshold: 2 });
    expect(dashboard.rollups.length).toBeGreaterThan(0);
    expect(dashboard.rollups.every((rollup) => rollup.contributingInstallations >= 2 || rollup.eventCount === null)).toBe(true);
    expect(dashboard.cohorts).toEqual([
      { firstSeenDay: "2026-08-03", installationCount: 2, suppressed: false },
      { firstSeenDay: "2026-08-04", installationCount: null, suppressed: true },
    ]);
    expect(dashboard.quality).toMatchObject({
      acceptedEventCount: 30,
      backfillEventCount: 3,
      lateEventCount: 0,
      missingPseudonymousInstallationCount: 0,
      privacyThreshold: 2,
    });

    const singleton = {
      ...events[0],
      installationId: "44444444-4444-4444-8444-444444444444",
      eventName: "human_work_started",
      occurredAt: "2026-08-05T00:00:00.000Z",
      effectiveAt: "2026-08-04T00:00:00.000Z",
      late: true,
    } as const;
    const recomputed = buildProductAnalyticsCollectorDashboard([...events, singleton], { privacyThreshold: 2 });
    const suppressed = recomputed.rollups.find((rollup) => rollup.day === "2026-08-04" && rollup.eventName === "human_work_started");
    expect(suppressed).toMatchObject({ contributingInstallations: 1, eventCount: null, suppressed: true });
    expect(recomputed.quality.lateEventCount).toBe(1);
    expect(recomputed).toEqual(buildProductAnalyticsCollectorDashboard([singleton, ...events], { privacyThreshold: 2 }));
    const dashboardJson = JSON.stringify(recomputed);
    for (const installationId of PRODUCT_ANALYTICS_FIXTURE_INSTALLATIONS) {
      expect(dashboardJson).not.toContain(installationId);
    }
  });

  it("keeps the deterministic ingest benchmark bounded", () => {
    const store = new InMemoryProductAnalyticsCollectorStore();
    store.setInstallationState(PRODUCT_ANALYTICS_FIXTURE_AUTHORIZATION.installationId, { consentVersion: "v1", consentEpoch: 1, revoked: false });
    const collector = createProductAnalyticsCollector(store);
    const events = Array.from({ length: 100 }, (_, index) => productAnalyticsFixtureEvent(index));
    const benchmarkAuthorization = { ...PRODUCT_ANALYTICS_FIXTURE_AUTHORIZATION, pseudonymousInstallationId: null };
    const startedAt = performance.now();
    let accepted = 0;
    for (let offset = 0; offset < events.length; offset += 25) {
      accepted += collector.ingestBatch({
        authorization: benchmarkAuthorization,
        events: events.slice(offset, offset + 25),
        now: new Date(PRODUCT_ANALYTICS_FIXTURE_NOW),
      }).accepted;
    }
    const elapsedMs = performance.now() - startedAt;
    console.info(`[product-analytics-benchmark] events=${events.length} accepted=${accepted} elapsed_ms=${elapsedMs.toFixed(2)}`);
    expect(accepted).toBe(100);
    expect(elapsedMs).toBeLessThan(500);
  });
});
