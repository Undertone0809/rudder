import type {
  ProductAnalyticsCollectorAuthorization,
  ProductAnalyticsCollectorDashboardEvent,
  ProductAnalyticsCollectorEvent,
} from "./product-analytics-collector.js";

export const PRODUCT_ANALYTICS_FIXTURE_NOW = "2026-08-04T00:00:00.000Z";
export const PRODUCT_ANALYTICS_FIXTURE_INSTALLATIONS = [
  "11111111-1111-4111-8111-111111111111",
  "11111111-1111-4111-8111-111111111112",
  "11111111-1111-4111-8111-111111111113",
] as const;

export const PRODUCT_ANALYTICS_FIXTURE_AUTHORIZATION: ProductAnalyticsCollectorAuthorization = {
  installationId: PRODUCT_ANALYTICS_FIXTURE_INSTALLATIONS[0],
  mode: "anonymous",
  consentVersion: "v1",
  consentEpoch: 1,
  pseudonymousInstallationId: "fixture-installation-hash",
};

const EVENT_NAMES = ["human_work_started", "run_succeeded", "output_ready", "work_loop_completed"] as const;

export function productAnalyticsFixtureEvent(
  index: number,
  overrides: Partial<ProductAnalyticsCollectorEvent> = {},
): ProductAnalyticsCollectorEvent {
  const installationIndex = index % PRODUCT_ANALYTICS_FIXTURE_INSTALLATIONS.length;
  const eventName = EVENT_NAMES[index % EVENT_NAMES.length];
  const occurredAt = new Date(Date.parse(PRODUCT_ANALYTICS_FIXTURE_NOW) - (index % 3) * 60 * 60 * 1000).toISOString();
  const properties: ProductAnalyticsCollectorEvent["properties"] = eventName === "run_succeeded"
    ? { run_kind: "agent", runtime: "local", attempt_kind: "initial" }
    : eventName === "output_ready"
      ? { output_kind: "patch" }
      : eventName === "work_loop_completed"
        ? { work_surface: "issue", origin: "human", review_required: false }
        : { work_surface: "issue", origin: "human" };
  return {
    eventId: `22222222-2222-4${String(index % 10)}22-8222-${String(index).padStart(12, "0")}`,
    eventName,
    schemaVersion: 1,
    occurredAt,
    environment: "production",
    appVersion: "0.6.6-fixture",
    releaseChannel: "stable",
    deploymentMode: "desktop_local",
    actorKind: "user",
    origin: "human",
    pseudonymousInstallationId: `fixture-installation-hash-${installationIndex}`,
    pseudonymousOrgId: "fixture-org-hash",
    pseudonymousWorkId: `fixture-work-${index}`,
    pseudonymousWorkCycleId: `fixture-cycle-${index}`,
    pseudonymousRootRunId: null,
    pseudonymousRunId: `fixture-run-${index}`,
    completionRevision: eventNameIsCompletion(index) ? 1 : null,
    properties,
    confidence: "exact",
    isBackfill: index % 11 === 0,
    ...overrides,
  };
}

function eventNameIsCompletion(index: number) {
  return EVENT_NAMES[index % EVENT_NAMES.length] === "work_loop_completed";
}

export function productAnalyticsFixtureDashboardEvents(count = 30): ProductAnalyticsCollectorDashboardEvent[] {
  return Array.from({ length: count }, (_, index) => {
    const event = productAnalyticsFixtureEvent(index);
    const installationId = PRODUCT_ANALYTICS_FIXTURE_INSTALLATIONS[index % PRODUCT_ANALYTICS_FIXTURE_INSTALLATIONS.length];
    return {
      ...event,
      installationId,
      effectiveAt: event.occurredAt,
      late: false,
    };
  });
}
