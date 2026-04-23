import { describe, expect, it } from "vitest";
import type { AutomationTrigger } from "@rudder/shared";
import { buildAutomationTriggerPatch } from "./automation-trigger-patch";

function makeScheduleTrigger(overrides: Partial<AutomationTrigger> = {}): AutomationTrigger {
  return {
    id: "trigger-1",
    orgId: "organization-1",
    automationId: "automation-1",
    kind: "schedule",
    label: "Daily",
    enabled: true,
    cronExpression: "0 10 * * *",
    timezone: "UTC",
    nextRunAt: null,
    lastFiredAt: null,
    publicId: null,
    secretId: null,
    signingMode: null,
    replayWindowSec: null,
    lastRotatedAt: null,
    lastResult: null,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    createdAt: new Date("2026-03-20T00:00:00.000Z"),
    updatedAt: new Date("2026-03-20T00:00:00.000Z"),
    ...overrides,
  };
}

describe("buildAutomationTriggerPatch", () => {
  it("preserves an existing schedule trigger timezone when saving edits", () => {
    const patch = buildAutomationTriggerPatch(
      makeScheduleTrigger({ timezone: "UTC" }),
      {
        label: "Daily label edit",
        cronExpression: "0 10 * * *",
        signingMode: "bearer",
        replayWindowSec: "300",
      },
      "America/Chicago",
    );

    expect(patch).toEqual({
      label: "Daily label edit",
      cronExpression: "0 10 * * *",
      timezone: "UTC",
    });
  });

  it("falls back to the local timezone when a schedule trigger has none", () => {
    const patch = buildAutomationTriggerPatch(
      makeScheduleTrigger({ timezone: null }),
      {
        label: "",
        cronExpression: "15 9 * * 1-5",
        signingMode: "bearer",
        replayWindowSec: "300",
      },
      "America/Chicago",
    );

    expect(patch).toEqual({
      label: null,
      cronExpression: "15 9 * * 1-5",
      timezone: "America/Chicago",
    });
  });
});
