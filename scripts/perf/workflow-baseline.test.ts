import { describe, expect, it } from "vitest";
import {
  evaluateSequenceGates,
  getScenarioScale,
  summarizeTimingSamples,
  THREAD_PRESSURE_RECIPE,
  workloadManifestHash,
} from "./workflow-baseline.helpers.js";

describe("workflow performance workload", () => {
  it("defines a single-entity whale without removing broad scales", () => {
    expect(getScenarioScale("smoke").chats).toBe(40);
    expect(getScenarioScale("medium").issues).toBe(1_500);

    const scale = getScenarioScale("thread-heavy");
    expect(scale.hotChatMessages).toBe(5_000);
    expect(scale.hotIssueComments).toBe(2_000);
    expect(scale.hotIssueRuns).toBe(1_000);
    expect(scale.neighborOrgSentinels).toBeGreaterThan(0);
  });

  it("reports tail latency after warm-up samples are excluded", () => {
    const samples = Array.from({ length: 20 }, (_, index) => ({
      name: "chat.listMessages.hot",
      ms: index + 1,
    }));

    expect(summarizeTimingSamples(samples)).toEqual([{
      name: "chat.listMessages.hot",
      runs: 20,
      minMs: 1,
      p50Ms: 10,
      p95Ms: 19,
      maxMs: 20,
      avgMs: 10.5,
    }]);
  });

  it("keeps the workload manifest stable and sensitive to shape changes", () => {
    const first = workloadManifestHash("thread-heavy");
    const second = workloadManifestHash("thread-heavy");
    const broad = workloadManifestHash("medium");
    const changedRecipe = workloadManifestHash("thread-heavy", {
      ...THREAD_PRESSURE_RECIPE,
      timestampTieWidth: THREAD_PRESSURE_RECIPE.timestampTieWidth + 1,
    });

    expect(first).toMatch(/^[a-f0-9]{16}$/);
    expect(second).toBe(first);
    expect(broad).not.toBe(first);
    expect(changedRecipe).not.toBe(first);
  });

  it("fails exact-count, uniqueness, ordering, linkage, and isolation violations", () => {
    const result = evaluateSequenceGates({
      name: "hotIssue.comments",
      expectedCount: 3,
      expectedIds: ["c-1", "c-2", "c-4"],
      expectedOrgId: "org-a",
      expectedParentId: "issue-a",
      rows: [
        { id: "c-1", orgId: "org-a", parentId: "issue-a", createdAt: "2026-07-20T00:00:00.000Z" },
        { id: "c-1", orgId: "org-a", parentId: "issue-b", createdAt: "2026-07-19T00:00:00.000Z" },
        { id: "c-3", orgId: "org-b", parentId: "issue-a", createdAt: "2026-07-21T00:00:00.000Z" },
      ],
      order: "asc",
    });

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([
      "hotIssue.comments:duplicate_ids=1",
      "hotIssue.comments:missing_ids=2",
      "hotIssue.comments:unexpected_ids=1",
      "hotIssue.comments:out_of_order=1",
      "hotIssue.comments:wrong_parent=1",
      "hotIssue.comments:cross_org=1",
    ]);
  });
});
