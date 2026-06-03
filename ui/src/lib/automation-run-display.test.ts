import { describe, expect, it } from "vitest";
import { getAutomationRunDisplay, summarizeAutomationCiPayload } from "./automation-run-display";
import type { AutomationRunSummary } from "@rudderhq/shared";

const baseRun: AutomationRunSummary = {
  id: "run-1",
  orgId: "org-1",
  automationId: "automation-1",
  triggerId: null,
  source: "manual",
  status: "issue_created",
  triggeredAt: new Date("2026-06-03T08:00:00.000Z"),
  idempotencyKey: null,
  triggerPayload: null,
  linkedIssueId: null,
  linkedChatConversationId: null,
  startedChatMessageId: null,
  terminalChatMessageId: null,
  lastChatMessageId: null,
  coalescedIntoRunId: null,
  failureReason: null,
  completedAt: null,
  createdAt: new Date("2026-06-03T08:00:00.000Z"),
  updatedAt: new Date("2026-06-03T08:00:00.000Z"),
  linkedIssue: null,
  linkedChatConversation: null,
  trigger: null,
};

function run(patch: Partial<AutomationRunSummary>): AutomationRunSummary {
  return { ...baseRun, ...patch };
}

describe("automation run display", () => {
  it("summarizes GitHub Actions webhook payloads with allowed CI fields", () => {
    const payload = {
      action: "completed",
      repository: { full_name: "rudderhq/rudder" },
      workflow_run: {
        name: "E2E",
        head_branch: "main",
        head_sha: "1234567890abcdef1234567890abcdef12345678",
      },
      secret: "do-not-render",
    };

    expect(summarizeAutomationCiPayload(payload)).toEqual([
      "rudderhq/rudder",
      "E2E",
      "main",
      "1234567",
      "completed",
    ]);

    const display = getAutomationRunDisplay(run({
      source: "webhook",
      triggerId: "trigger-1",
      trigger: { id: "trigger-1", kind: "webhook", label: "ci" },
      triggerPayload: payload,
      linkedIssue: {
        id: "issue-1",
        identifier: "RUD-12",
        title: "Run E2E",
        status: "todo",
        priority: "medium",
        updatedAt: new Date("2026-06-03T08:00:00.000Z"),
      },
    }));

    expect(display.sourceLabel).toBe("CI webhook");
    expect(display.context).toContain("rudderhq/rudder");
    expect(display.context).toContain("E2E");
    expect(display.context).not.toContain("do-not-render");
    expect(display.destinationLabel).toBe("Issue RUD-12");
  });

  it("keeps generic webhook runs readable when payload shape is unknown", () => {
    const display = getAutomationRunDisplay(run({
      source: "webhook",
      triggerId: "trigger-1",
      trigger: { id: "trigger-1", kind: "webhook", label: "customer-escalation" },
      triggerPayload: { arbitrary: { nested: "value" } },
    }));

    expect(display.sourceLabel).toBe("Webhook: customer-escalation");
    expect(display.context).toBeNull();
    expect(display.title).toBe("Opened issue · Webhook: customer-escalation");
    expect(display.title).not.toContain("arbitrary");
  });

  it("shows deleted trigger and failure context without raw payload fallback", () => {
    const display = getAutomationRunDisplay(run({
      source: "webhook",
      status: "failed",
      triggerId: "deleted-trigger",
      trigger: null,
      triggerPayload: { token: "secret" },
      failureReason: "Signature verification failed",
    }));

    expect(display.statusLabel).toBe("Failed");
    expect(display.context).toBe("Trigger removed");
    expect(display.destinationLabel).toBe("Signature verification failed");
    expect(display.title).not.toContain("secret");
  });

  it("labels coalesced schedule runs by existing run", () => {
    const display = getAutomationRunDisplay(run({
      source: "schedule",
      status: "coalesced",
      triggerId: "trigger-1",
      trigger: { id: "trigger-1", kind: "schedule", label: "daily-check" },
      coalescedIntoRunId: "12345678-aaaa-bbbb-cccc-123456789abc",
    }));

    expect(display.sourceLabel).toBe("Schedule: daily-check");
    expect(display.statusLabel).toBe("Coalesced");
    expect(display.destinationLabel).toBe("Existing run 12345678");
  });
});
