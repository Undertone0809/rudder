import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatShortRunId,
  isShortRunIdReference,
  resolveHeartbeatRunIdReference,
} from "../services/heartbeat-run-reference.ts";
import {
  extractSkillEvidenceMatch,
  getObservedRunEvents,
  getObservedRunLog,
} from "../services/run-intelligence.ts";

const mockHeartbeatReadLog = vi.hoisted(() => vi.fn());
const mockGetGeneralSettings = vi.hoisted(() => vi.fn());

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => ({
    readLog: mockHeartbeatReadLog,
  }),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: mockGetGeneralSettings,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockGetGeneralSettings.mockResolvedValue({ censorUsernameInLogs: false });
});

function mockRunIdLookup(rows: Array<{ id: string }>) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { db: { select }, select, from, where, orderBy, limit };
}

function mockRunOrgLookup(orgId: string) {
  const limit = vi.fn().mockResolvedValue([{ orgId }]);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select };
}

function mockRunEventsLookup(orgId: string, events: Array<Record<string, unknown>>) {
  let selectCount = 0;
  const select = vi.fn(() => {
    selectCount += 1;
    if (selectCount === 1) {
      const limit = vi.fn().mockResolvedValue([{ orgId }]);
      const where = vi.fn(() => ({ limit }));
      return { from: vi.fn(() => ({ where })) };
    }
    const limit = vi.fn().mockResolvedValue(events);
    const orderBy = vi.fn(() => ({ limit }));
    const where = vi.fn(() => ({ orderBy }));
    return { from: vi.fn(() => ({ where })) };
  });
  return { select };
}

describe("agent run references", () => {
  it("formats UUID run IDs as short CLI run IDs", () => {
    expect(formatShortRunId("609695f1-f90a-4b17-be61-4f0c6fe37c42")).toBe("run_609695f1");
    expect(formatShortRunId("run-1")).toBe("run-1");
  });

  it("recognizes short run ID references without treating full UUIDs as prefixes", () => {
    expect(isShortRunIdReference("609695f1")).toBe(true);
    expect(isShortRunIdReference("609695f1f90a")).toBe(true);
    expect(isShortRunIdReference("run_609695f1")).toBe(true);
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

  it("resolves typed short run references while keeping full UUID compatibility", async () => {
    const lookup = mockRunIdLookup([{ id: "609695f1-f90a-4b17-be61-4f0c6fe37c42" }]);

    await expect(resolveHeartbeatRunIdReference(lookup.db as never, "run_609695f1")).resolves.toBe(
      "609695f1-f90a-4b17-be61-4f0c6fe37c42",
    );
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
      message: "Agent run not found",
    });
  });

  it("rejects empty org scopes before global short run ID lookup", async () => {
    const lookup = mockRunIdLookup([{ id: "609695f1-f90a-4b17-be61-4f0c6fe37c42" }]);

    await expect(resolveHeartbeatRunIdReference(lookup.db as never, "609695f1", { orgIds: [] }))
      .rejects.toMatchObject({
        status: 404,
        message: "Agent run not found",
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
        matches: ["run_609695f1f90a", "run_609695f11111"],
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

describe("run intelligence bounded evidence", () => {
  it("returns an event page after the requested sequence", async () => {
    const db = mockRunEventsLookup("org-1", [
      { id: 11, seq: 11, stream: "system", level: "info" },
      { id: 12, seq: 12, stream: "stdout", level: "info" },
      { id: 13, seq: 13, stream: "stderr", level: "error" },
    ]);

    const result = await getObservedRunEvents(
      db as never,
      "609695f1-f90a-4b17-be61-4f0c6fe37c42",
      { orgIds: ["org-1"] },
      { afterSeq: 10, limit: 2 },
    );

    expect(result).toMatchObject({
      orgId: "org-1",
      response: {
        items: [{ seq: 11 }, { seq: 12 }],
        page: { afterSeq: 10, limit: 2, hasMore: true, nextAfterSeq: 12 },
      },
    });
  });

  it("redacts event secrets and current-user paths before returning evidence", async () => {
    mockGetGeneralSettings.mockResolvedValue({ censorUsernameInLogs: true });
    const homePath = `${process.env.HOME ?? "/Users/test-user"}/private-project`;
    const db = mockRunEventsLookup("org-1", [{
      id: 11,
      seq: 11,
      stream: "system",
      level: "info",
      message: `read ${homePath}`,
      payload: { apiKey: "secret-token", path: homePath },
    }]);

    const result = await getObservedRunEvents(
      db as never,
      "609695f1-f90a-4b17-be61-4f0c6fe37c42",
      { orgIds: ["org-1"] },
      { limit: 10 },
    );
    const serialized = JSON.stringify(result.response.items[0]);

    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain(homePath);
    expect(result.response.items[0]?.payload).toBeNull();
    expect(result.response.items[0]?.payloadPreview?.text).toContain("***REDACTED***");
  });

  it("returns a bounded log range and pagination metadata", async () => {
    mockHeartbeatReadLog.mockResolvedValue({
      runId: "609695f1-f90a-4b17-be61-4f0c6fe37c42",
      store: "local_file",
      logRef: "run.ndjson",
      content: "bytes",
      endOffset: 105,
      eof: false,
      nextOffset: 105,
    });

    const result = await getObservedRunLog(
      mockRunOrgLookup("org-1") as never,
      "609695f1-f90a-4b17-be61-4f0c6fe37c42",
      { orgIds: ["org-1"] },
      { offset: 100, limitBytes: 5 },
    );

    expect(mockHeartbeatReadLog).toHaveBeenCalledWith(
      "609695f1-f90a-4b17-be61-4f0c6fe37c42",
      { offset: 100, limitBytes: 5 },
    );
    expect(result.response.page).toEqual({
      offset: 100,
      limitBytes: 5,
      endOffset: 105,
      eof: false,
      nextOffset: 105,
    });
  });
});
