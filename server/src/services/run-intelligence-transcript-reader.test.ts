import { agentConfigRevisions, agents, heartbeatRunEvents, heartbeatRuns } from "@rudderhq/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getObservedRunDetail } from "./run-intelligence.js";

const mocks = vi.hoisted(() => ({
  assertAccess: vi.fn(),
  createLegacyTranscriptReader: vi.fn(),
  createObjectReader: vi.fn(),
  createTranscriptReader: vi.fn(),
  getRunLogStore: vi.fn(),
  legacyReadRun: vi.fn(),
  nativeReaderHook: vi.fn(),
  rawLogRead: vi.fn(),
  resolveRunId: vi.fn(),
}));

vi.mock("./run-intelligence-access.js", () => ({
  assertRunIntelligenceAccess: mocks.assertAccess,
  resolveRunIdReferenceForScope: mocks.resolveRunId,
  sideChatVisibilityCondition: vi.fn(),
}));
vi.mock("./run-log-store.js", () => ({
  getRunLogStore: mocks.getRunLogStore,
}));
vi.mock("./runtime-kernel/provider-capabilities.js", async (importOriginal) => ({
  ...await importOriginal(),
  createRuntimeNativeTranscriptReaderHook: mocks.nativeReaderHook,
}));
vi.mock("./runtime-kernel/transcript-object-store.js", () => ({
  createTranscriptObjectReader: mocks.createObjectReader,
}));
vi.mock("./runtime-kernel/transcript-reader.js", () => ({
  createLegacyTranscriptReader: mocks.createLegacyTranscriptReader,
  createTranscriptReader: mocks.createTranscriptReader,
}));
vi.mock("./heartbeat.js", () => ({
  heartbeatService: vi.fn(),
}));
vi.mock("./instance-settings.js", () => ({
  instanceSettingsService: vi.fn(),
}));

function database(rowsByTable: unknown) {
  const tableRows = rowsByTable as Map<unknown, Record<string, unknown>[]>;
  return {
    select: vi.fn(() => {
      let table: unknown;
      let rowLimit: number | undefined;
      const query = {
        from(value: unknown) { table = value; return query; },
        innerJoin() { return query; },
        where() { return query; },
        orderBy() { return query; },
        limit(value: number) { rowLimit = value; return query; },
        then(resolve: (rows: Record<string, unknown>[]) => unknown, reject?: (error: unknown) => unknown) {
          const rows = tableRows.get(table) ?? [];
          return Promise.resolve(rowLimit === undefined ? rows : rows.slice(0, rowLimit)).then(resolve, reject);
        },
      };
      return query;
    }),
  };
}

describe("run intelligence detail transcript reader", () => {
  const orgId = "org-1";
  const runId = "run-1";
  const runRow = {
    id: runId,
    orgId,
    agentId: "agent-1",
    invocationSource: "on_demand",
    triggerDetail: "manual",
    status: "succeeded",
    startedAt: new Date("2026-04-21T10:00:00.000Z"),
    finishedAt: new Date("2026-04-21T10:00:10.000Z"),
    error: null,
    wakeupRequestId: null,
    exitCode: 0,
    signal: null,
    usageJson: null,
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    sessionParamsBeforeJson: null,
    sessionParamsAfterJson: null,
    sessionReuseScope: null,
    logStore: "local_file",
    logRef: "org-1/agent-1/run-1.ndjson",
    logBytes: 64,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    errorCode: null,
    externalRunId: null,
    chatConversationId: null,
    scene: null,
    sourceRunId: null,
    goalId: null,
    processPid: null,
    processStartedAt: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    contextSnapshot: null,
    createdAt: new Date("2026-04-21T10:00:00.000Z"),
    updatedAt: new Date("2026-04-21T10:00:10.000Z"),
    agentName: "Agent",
    agentRuntimeType: "codex_local",
    agentRuntimeConfig: {},
    runtimeConfig: {},
    orgName: "Organization",
    issueId: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRunId.mockImplementation(async (_db, value: string) => value);
    mocks.assertAccess.mockResolvedValue(undefined);
    mocks.getRunLogStore.mockReturnValue({ read: mocks.rawLogRead });
    mocks.createLegacyTranscriptReader.mockReturnValue({ readRun: mocks.legacyReadRun });
    mocks.createObjectReader.mockReturnValue({ readRange: vi.fn() });
    mocks.nativeReaderHook.mockReturnValue({ readRange: vi.fn() });
    mocks.legacyReadRun.mockResolvedValue({
      entries: [{ kind: "assistant", ts: "2026-04-21T10:00:01.000Z", text: "Reader transcript" }],
    });
    mocks.createTranscriptReader.mockImplementation((_db: unknown, options: { legacyReader: { readRun: (input: unknown) => Promise<unknown> } }) => ({
      async readRun(input: { runId: string }) {
        const legacy = await options.legacyReader.readRun({
          readonly: true,
          run: { id: input.runId },
          runtimeType: "process",
        });
        const entries = (Array.isArray(legacy) ? legacy : (legacy as { entries: unknown[] }).entries) as any[];
        return {
          source: "legacy",
          revision: "legacy-revision",
          availability: "available",
          completeness: "complete",
          nextCursor: null,
          items: entries.map((entry: any, ordinal: number) => ({
            id: `entry-${ordinal}`,
            ordinal,
            runId: input.runId,
            spanId: null,
            sourceEntryId: `entry-${ordinal}`,
            sourceRef: null,
            kind: entry.kind,
            ts: entry.ts,
            payload: entry,
            visibility: "visible",
            origin: "legacy",
            entry,
          })),
        };
      },
    }));
  });

  it("uses Reader entries for legacy detail without issuing a second raw-log read", async () => {
    const db = database(new Map<unknown, any[]>([
      [heartbeatRuns, [runRow]],
      [heartbeatRunEvents, []],
      [agentConfigRevisions, []],
    ]));

    const detail = await getObservedRunDetail(db as never, runId, { orgIds: [orgId] });

    expect(detail).toMatchObject({
      run: { id: runId, orgId },
      logContent: null,
      logChunks: [],
      transcript: [{ kind: "assistant", text: "Reader transcript" }],
    });
    expect(mocks.rawLogRead).not.toHaveBeenCalled();
    expect(mocks.legacyReadRun).toHaveBeenCalledWith(expect.objectContaining({
      run: { id: runId },
      runtimeType: "codex_local",
    }));
    expect(mocks.createTranscriptReader.mock.calls[0]?.[1].legacyReader).toEqual({
      readRun: expect.any(Function),
    });
    expect(mocks.assertAccess).toHaveBeenCalledWith(db, expect.objectContaining({ orgId }), { orgIds: [orgId] });
    expect(db.select).toHaveBeenCalledWith(expect.objectContaining({
      agentWorkspaceKey: agents.workspaceKey,
      agentRuntimeConfig: agents.agentRuntimeConfig,
    }));
  });

  it.each([
    ["Cursor", "cursor", "cursor:acp:agent_message"],
    ["Hermes", "hermes_gateway", "hermes:message:assistant"],
  ] as const)("projects native %s items without requiring legacy transcript rows", async (_provider, runtimeType, kind) => {
    const payload = {
      provider: runtimeType,
      record: { content: "Native transcript text", role: "assistant" },
    };
    mocks.createTranscriptReader.mockReturnValue({
      readRun: vi.fn().mockResolvedValue({
        items: [{
          id: "reader-item-id",
          ordinal: 0,
          runId,
          spanId: "span-1",
          sourceEntryId: "provider-entry-1",
          sourceRef: "provider-session-ref",
          kind,
          ts: "2026-04-21T10:00:01.000Z",
          payload,
          text: "Native transcript text",
          visibility: "visible",
          origin: "native",
          privateToken: "must-not-be-projected",
        }],
        nextCursor: null,
      }),
    });
    const db = database(new Map<unknown, any[]>([
      [heartbeatRuns, [{ ...runRow, agentRuntimeType: runtimeType }]],
      [heartbeatRunEvents, []],
      [agentConfigRevisions, []],
    ]));

    const detail = await getObservedRunDetail(db as never, runId, { orgIds: [orgId] });

    expect(detail?.transcript).toEqual([{
      kind,
      ts: "2026-04-21T10:00:01.000Z",
      text: "Native transcript text",
      payload,
      sourceEntryId: "provider-entry-1",
    }]);
    expect((detail?.transcript?.[0] as { text: string } | undefined)?.text.trim()).toBe("Native transcript text");
    expect(mocks.legacyReadRun).not.toHaveBeenCalled();
    expect(mocks.rawLogRead).not.toHaveBeenCalled();
  });

  it("keeps returning detail when transcript reading fails", async () => {
    const db = database(new Map<unknown, any[]>([
      [heartbeatRuns, [runRow]],
      [heartbeatRunEvents, [{
        id: 1,
        runId,
        orgId,
        seq: 1,
        eventType: "transcript.entry",
        stream: "stdout",
        level: "info",
        message: "Persisted event fallback",
        payload: {
          kind: "assistant",
          ts: "2026-04-21T10:00:02.000Z",
          text: "Persisted event fallback",
        },
        createdAt: new Date("2026-04-21T10:00:02.000Z"),
      }]],
      [agentConfigRevisions, []],
    ]));
    mocks.createTranscriptReader.mockImplementation(() => ({
      readRun: vi.fn().mockRejectedValue(new Error("transcript source unavailable")),
    }));

    const detail = await getObservedRunDetail(db as never, runId, { orgIds: [orgId] });

    expect(detail).toMatchObject({
      run: { id: runId, orgId },
      transcript: [{ kind: "assistant", text: "Persisted event fallback" }],
    });
    expect(mocks.rawLogRead).not.toHaveBeenCalled();
  });
});
