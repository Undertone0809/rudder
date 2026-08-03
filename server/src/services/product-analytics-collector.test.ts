import { describe, expect, it } from "vitest";
import {
  createProductAnalyticsCollector,
  InMemoryProductAnalyticsCollectorStore,
  type ProductAnalyticsCollectorAuthorization,
} from "./product-analytics-collector.js";

const installationId = "11111111-1111-4111-8111-111111111111";
const eventId = "22222222-2222-4222-8222-222222222222";

const authorization: ProductAnalyticsCollectorAuthorization = {
  installationId,
  mode: "anonymous",
  consentVersion: "v1",
  consentEpoch: 1,
};

function event(overrides: Record<string, unknown> = {}) {
  return {
    eventId,
    eventName: "work_loop_completed",
    schemaVersion: 1,
    occurredAt: "2026-08-03T00:00:00.000Z",
    environment: "production",
    appVersion: "0.6.6",
    releaseChannel: "stable",
    deploymentMode: "desktop_local",
    actorKind: "user",
    origin: "human",
    pseudonymousInstallationId: "installation-hash",
    pseudonymousOrgId: "org-hash",
    pseudonymousWorkId: "work-hash",
    pseudonymousWorkCycleId: "cycle-hash",
    pseudonymousRootRunId: "root-hash",
    pseudonymousRunId: null,
    completionRevision: 1,
    properties: { work_surface: "issue", is_first_loop: true },
    confidence: "exact",
    isBackfill: false,
    ...overrides,
  };
}

function createCollector() {
  const store = new InMemoryProductAnalyticsCollectorStore();
  store.setInstallationState(installationId, { consentVersion: "v1", consentEpoch: 1, revoked: false });
  return createProductAnalyticsCollector(store);
}

describe("product analytics collector", () => {
  it("accepts a valid event and treats the same payload as a duplicate", () => {
    const collector = createCollector();
    const first = collector.ingestBatch({ authorization, events: [event()] });
    const second = collector.ingestBatch({ authorization, events: [event()] });

    expect(first.accepted).toBe(1);
    expect(first.rejected).toEqual([]);
    expect(second.duplicate).toBe(1);
    expect(collector.store.listEvents()).toHaveLength(1);
  });

  it("rejects a conflicting event id instead of overwriting the first payload", () => {
    const collector = createCollector();
    collector.ingestBatch({ authorization, events: [event()] });
    const result = collector.ingestBatch({ authorization, events: [event({ properties: { work_surface: "chat" } })] });

    expect(result.rejected).toEqual([{ eventId, status: "rejected", errorCode: "conflict", late: false }]);
    expect(collector.store.listEvents()[0]?.properties).toEqual({ work_surface: "issue", is_first_loop: true });
  });

  it("rejects raw content-bearing properties and future events", () => {
    const collector = createCollector();
    const result = collector.ingestBatch({
      authorization,
      now: new Date("2026-08-03T00:00:00.000Z"),
      events: [event({ properties: { prompt: "never upload" } }), event({ eventId: "33333333-3333-4333-8333-333333333333", occurredAt: "2026-08-05T01:00:00.000Z" })],
    });

    expect(result.rejected.map((ack) => ack.errorCode)).toEqual(["invalid_event", "future_event"]);
    expect(collector.store.listEvents()).toHaveLength(0);
  });

  it("rejects old consent epochs after revocation", () => {
    const collector = createCollector();
    collector.advanceConsent({ installationId, consentVersion: "v1", consentEpoch: 2, revoked: true });
    const result = collector.ingestBatch({ authorization, events: [event()] });

    expect(result.rejected).toEqual([{ eventId, status: "rejected", errorCode: "revoked", late: false }]);
  });

  it("does not let an equal-epoch replay undo revocation", () => {
    const collector = createCollector();
    collector.advanceConsent({ installationId, consentVersion: "v1", consentEpoch: 2, revoked: true });
    const replay = collector.advanceConsent({ installationId, consentVersion: "v1", consentEpoch: 2, revoked: false });

    expect(replay).toEqual({ consentVersion: "v1", consentEpoch: 2, revoked: true });
  });
});
