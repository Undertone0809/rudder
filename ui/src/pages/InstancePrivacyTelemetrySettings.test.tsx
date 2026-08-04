// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InstancePrivacyTelemetrySettings } from "./InstancePrivacyTelemetrySettings";

const invalidateQueries = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      mode: "anonymous",
      consentVersion: "v1",
      consentEpoch: 2,
      maskedInstallationId: "****abc123",
      pendingCount: 3,
      lastAttemptedAt: "2026-08-04T09:00:00.000Z",
      lastSucceededAt: "2026-08-04T08:59:00.000Z",
      lastErrorCode: null,
      coverageGap: false,
      lastPayloadAt: "2026-08-04T08:59:00.000Z",
      lastPayload: [{ eventId: "event-1", eventName: "work_loop_completed", properties: { work_surface: "chat" } }],
      disclosure: {
        collected: ["event names", "pseudonymous ids"],
        excluded: ["prompts", "transcripts"],
      },
    },
    isLoading: false,
    error: null,
  }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => params?.mode ? `${key}: ${params.mode}` : key,
  }),
}));

describe("InstancePrivacyTelemetrySettings", () => {
  it("renders the consent boundary, masked installation id, delivery status, and payload preview", () => {
    const html = renderToStaticMarkup(<InstancePrivacyTelemetrySettings />);

    expect(html).toContain("privacyTelemetry.anonymous.title");
    expect(html).toContain("privacyTelemetry.accountLinked.title");
    expect(html).toContain("****abc123");
    expect(html).not.toContain("work_loop_completed");
    expect(html).toContain("privacyTelemetry.delivery.viewPayload");
  });
});
