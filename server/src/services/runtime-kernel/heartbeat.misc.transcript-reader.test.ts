import { heartbeatRunEvents, heartbeatRuns } from "@rudderhq/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHeartbeatMiscHandlers } from "./heartbeat.misc.js";

const mocks = vi.hoisted(() => ({
  createLegacyTranscriptReader: vi.fn(),
  createTranscriptReader: vi.fn(),
  legacyReadRun: vi.fn(),
  readRun: vi.fn(),
}));

vi.mock("./transcript-reader.js", () => ({
  createLegacyTranscriptReader: mocks.createLegacyTranscriptReader,
  createTranscriptReader: mocks.createTranscriptReader,
}));

function database(rowsByTable: unknown) {
  const tableRows = rowsByTable as Map<unknown, Record<string, unknown>[]>;
  return {
    select: vi.fn(() => {
      let table: unknown;
      const query = {
        from(value: unknown) { table = value; return query; },
        innerJoin() { return query; },
        where() { return query; },
        orderBy() { return query; },
        then(resolve: (rows: Record<string, unknown>[]) => unknown, reject?: (error: unknown) => unknown) {
          return Promise.resolve(tableRows.get(table) ?? []).then(resolve, reject);
        },
      };
      return query;
    }),
  };
}

function transcriptItem(runId: string, skill: string) {
  const entry = {
    kind: "tool_call",
    ts: "2026-04-21T10:00:05.000Z",
    name: "Skill",
    input: { skill },
  };
  return {
    id: `${runId}:${skill}`,
    ordinal: 0,
    runId,
    spanId: null,
    sourceEntryId: `${runId}:${skill}`,
    sourceRef: null,
    kind: entry.kind,
    ts: entry.ts,
    payload: entry,
    visibility: "visible" as const,
    origin: "legacy" as const,
    entry,
  };
}

describe("heartbeat skill analytics transcript reader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createLegacyTranscriptReader.mockReturnValue({ readRun: mocks.legacyReadRun });
    mocks.createTranscriptReader.mockImplementation((_db: unknown, options: { legacyReader: { readRun: (input: unknown) => Promise<unknown> } }) => ({
      async readRun(input: { runId: string; cursor?: string | null }) {
        if (input.runId === "legacy-run") {
          await options.legacyReader.readRun({
            readonly: true,
            run: { id: input.runId, logBytes: 450_000 },
            runtimeType: "process",
          });
        }
        return mocks.readRun(input);
      },
    }));
  });

  it("reads paged legacy evidence through the org-scoped Reader and keeps native evidence excluded", async () => {
    const orgId = "org-1";
    const date = new Date("2026-04-21T10:00:00.000Z");
    const db = database(new Map<unknown, Record<string, unknown>[]>([
      [heartbeatRunEvents, []],
      [heartbeatRuns, [
        {
          id: "legacy-run",
          agentRuntimeType: "codex_local",
          createdAt: date,
          logStore: "local_file",
          logRef: "legacy.ndjson",
          logBytes: 450_000,
        },
        {
          id: "native-run",
          agentRuntimeType: "codex_local",
          createdAt: date,
          logStore: "local_file",
          logRef: "stale-native.ndjson",
          logBytes: 64,
        },
      ]],
    ]));

    mocks.readRun.mockImplementation(async (input) => input.runId === "legacy-run"
      ? input.cursor === null
        ? {
          source: "legacy",
          items: [transcriptItem(input.runId, "first-skill")],
          nextCursor: "page-2",
        }
        : {
          source: "legacy",
          items: [transcriptItem(input.runId, "second-skill")],
          nextCursor: null,
        }
      : {
        source: "native",
        items: [transcriptItem(input.runId, "stale-native-skill")],
        nextCursor: null,
      });

    const handlers = createHeartbeatMiscHandlers({ db, runLogStore: {} });
    const analytics = await handlers.buildSkillAnalytics({ orgId }, {
      startDate: "2026-04-21",
      endDate: "2026-04-21",
    });

    expect(analytics.skills.map((skill: { key: string }) => skill.key)).toEqual([
      "first-skill",
      "second-skill",
    ]);
    expect(mocks.readRun).toHaveBeenCalledTimes(3);
    expect(mocks.readRun.mock.calls[0]?.[0]).toMatchObject({
      orgId,
      runId: "legacy-run",
      principal: { type: "board", orgId, authorized: true },
      cursor: null,
      limit: 200,
    });
    expect(mocks.readRun.mock.calls[2]?.[0]).toMatchObject({ runId: "native-run" });
    expect(mocks.legacyReadRun).toHaveBeenCalledWith(expect.objectContaining({
      run: { id: "legacy-run", logBytes: 450_000 },
      runtimeType: "codex_local",
    }));
    expect(mocks.createLegacyTranscriptReader).toHaveBeenCalledWith({
      logStore: {},
      maxReadBytes: 450_000,
    });
    expect(analytics.skills.some((skill: { key: string }) => skill.key === "stale-native-skill")).toBe(false);
  });
});
