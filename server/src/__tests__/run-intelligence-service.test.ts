import { describe, expect, it, vi } from "vitest";
import {
  formatShortRunId,
  isShortRunIdReference,
  resolveHeartbeatRunIdReference,
} from "../services/heartbeat-run-reference.ts";
import { extractSkillEvidenceMatch } from "../services/run-intelligence.ts";

function mockRunIdLookup(rows: Array<{ id: string }>) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { db: { select }, select, from, where, orderBy, limit };
}

describe("heartbeat run references", () => {
  it("formats UUID run IDs as short CLI run IDs", () => {
    expect(formatShortRunId("609695f1-f90a-4b17-be61-4f0c6fe37c42")).toBe("609695f1f90a");
    expect(formatShortRunId("run-1")).toBe("run-1");
  });

  it("recognizes short run ID references without treating full UUIDs as prefixes", () => {
    expect(isShortRunIdReference("609695f1")).toBe(true);
    expect(isShortRunIdReference("609695f1f90a")).toBe(true);
    expect(isShortRunIdReference("609695f1-f90a-4b17-be61-4f0c6fe37c42")).toBe(false);
    expect(isShortRunIdReference("run-1")).toBe(false);
  });

  it("resolves short run ID references to the matching full run ID", async () => {
    const lookup = mockRunIdLookup([{ id: "609695f1-f90a-4b17-be61-4f0c6fe37c42" }]);

    await expect(resolveHeartbeatRunIdReference(lookup.db as never, "609695f1")).resolves.toBe(
      "609695f1-f90a-4b17-be61-4f0c6fe37c42",
    );
    expect(lookup.select).toHaveBeenCalledTimes(1);
  });

  it("does not query when the run reference is already a full UUID", async () => {
    const lookup = mockRunIdLookup([{ id: "609695f1-f90a-4b17-be61-4f0c6fe37c42" }]);

    await expect(
      resolveHeartbeatRunIdReference(lookup.db as never, "609695f1-f90a-4b17-be61-4f0c6fe37c42"),
    ).resolves.toBe("609695f1-f90a-4b17-be61-4f0c6fe37c42");
    expect(lookup.select).not.toHaveBeenCalled();
  });

  it("rejects unmatched short run ID references before UUID lookups", async () => {
    const lookup = mockRunIdLookup([]);

    await expect(resolveHeartbeatRunIdReference(lookup.db as never, "deadbeef")).rejects.toMatchObject({
      status: 404,
      message: "Heartbeat run not found",
    });
  });

  it("rejects empty org scopes before global short run ID lookup", async () => {
    const lookup = mockRunIdLookup([{ id: "609695f1-f90a-4b17-be61-4f0c6fe37c42" }]);

    await expect(resolveHeartbeatRunIdReference(lookup.db as never, "609695f1", { orgIds: [] }))
      .rejects.toMatchObject({
        status: 404,
        message: "Heartbeat run not found",
      });
    expect(lookup.select).not.toHaveBeenCalled();
  });

  it("rejects ambiguous short run ID references without leaking full UUID matches", async () => {
    const lookup = mockRunIdLookup([
      { id: "609695f1-f90a-4b17-be61-4f0c6fe37c42" },
      { id: "609695f1-1111-4b17-be61-4f0c6fe37c42" },
    ]);

    await expect(resolveHeartbeatRunIdReference(lookup.db as never, "609695f1")).rejects.toMatchObject({
      status: 409,
      message: "Run ID prefix is ambiguous",
      details: {
        runId: "609695f1",
        matches: ["609695f1f90a", "609695f11111"],
      },
    });
  });
});

describe("run intelligence skill evidence", () => {
  it("keeps used and loaded skill evidence distinct", () => {
    const usedMatch = extractSkillEvidenceMatch({
      evidenceType: "used",
      skillQuery: "skill-optimizer",
      eventType: "adapter.skill_usage",
      eventId: 11,
      eventCreatedAt: new Date("2026-06-11T10:01:00.000Z"),
      payload: {
        source: "transcript.skill_file_read",
        usedSkillKeys: ["skill-optimizer"],
        usedSkills: [
          { key: "skill-optimizer", label: "Skill Optimizer" },
        ],
        loadedSkillKeys: ["rudder/rudder"],
        loadedSkills: [
          { key: "rudder/rudder", label: "Rudder" },
        ],
      },
    });

    expect(usedMatch).toMatchObject({
      evidenceType: "used",
      matchedSkillKey: "skill-optimizer",
      matchedSkillLabel: "Skill Optimizer",
      sourceEventType: "adapter.skill_usage",
      sourceEventId: 11,
      sourceEventCreatedAt: "2026-06-11T10:01:00.000Z",
    });

    const loadedMatch = extractSkillEvidenceMatch({
      evidenceType: "loaded",
      skillQuery: "Rudder",
      eventType: "adapter.invoke",
      eventId: 12,
      eventCreatedAt: "2026-06-10T10:00:05.000Z",
      payload: {
        usedSkillKeys: ["skill-optimizer"],
        usedSkills: [
          { key: "skill-optimizer", label: "Skill Optimizer" },
        ],
        loadedSkillKeys: ["rudder/rudder"],
        loadedSkills: [
          { key: "rudder/rudder", label: "Rudder" },
        ],
      },
    });

    expect(loadedMatch).toMatchObject({
      evidenceType: "loaded",
      matchedSkillKey: "rudder/rudder",
      matchedSkillLabel: "Rudder",
      sourceEventType: "adapter.invoke",
      sourceEventId: 12,
      sourceEventCreatedAt: "2026-06-10T10:00:05.000Z",
    });
  });

  it("prefers structured skill labels over fallback key labels", () => {
    const match = extractSkillEvidenceMatch({
      evidenceType: "used",
      skillQuery: "Skill Optimizer",
      eventType: "adapter.skill_usage",
      eventId: 13,
      eventCreatedAt: null,
      payload: {
        usedSkillKeys: ["skill-optimizer"],
        usedSkills: [
          { key: "skill-optimizer", label: "Skill Optimizer" },
        ],
      },
    });

    expect(match).toMatchObject({
      matchedSkillKey: "skill-optimizer",
      matchedSkillLabel: "Skill Optimizer",
      sourceEventCreatedAt: null,
    });
  });
});
