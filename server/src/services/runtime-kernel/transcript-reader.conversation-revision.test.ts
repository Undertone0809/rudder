import {
  chatConversations,
  chatMessages,
  heartbeatRunEvents,
  heartbeatRuns,
  nativeSegments,
  runRuntimeSpans,
  runtimeBindings,
} from "@rudderhq/db";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createTranscriptReader,
  decodeTranscriptCursor,
  type LegacyTranscriptReadInput,
} from "./transcript-reader.js";

function sqlParameters(value: unknown, collected: unknown[] = []): unknown[] {
  if (value === null || value === undefined) return collected;
  if (typeof value !== "object") {
    collected.push(value);
    return collected;
  }
  const node = value as { constructor?: { name?: string }; value?: unknown; queryChunks?: unknown[] };
  if (node.constructor?.name === "Param") {
    collected.push(node.value);
    return collected;
  }
  if (Array.isArray(node.queryChunks)) {
    for (const chunk of node.queryChunks) sqlParameters(chunk, collected);
  }
  return collected;
}

function mockDatabase(runs: Record<string, unknown>[]) {
  const conversation = {
    id: "conversation-1",
    orgId: "org-1",
    updatedAt: new Date("2026-09-22T00:00:10.000Z"),
  };
  const rowsByTable = new Map<unknown, Record<string, unknown>[]>([
    [chatConversations, [conversation]],
    [chatMessages, []],
    [heartbeatRuns, runs],
    [runRuntimeSpans, []],
    [runtimeBindings, []],
    [nativeSegments, []],
    [heartbeatRunEvents, []],
  ]);
  const select = vi.fn((selection?: Record<string, unknown>) => {
    let table: unknown;
    let where: unknown;
    let rowLimit: number | undefined;
    let ordered = false;
    const query: Record<string, unknown> & {
      then?: (resolve: (value: Record<string, unknown>[]) => unknown, reject?: (reason: unknown) => unknown) => Promise<unknown>;
    } = {};
    query.from = vi.fn((value: unknown) => {
      table = value;
      return query;
    });
    query.where = vi.fn((value: unknown) => {
      where = value;
      return query;
    });
    query.orderBy = vi.fn(() => {
      ordered = true;
      return query;
    });
    query.groupBy = vi.fn(() => query);
    query.innerJoin = vi.fn(() => query);
    query.limit = vi.fn((value: number) => {
      rowLimit = value;
      return query;
    });
    query.then = (resolve, reject) => {
      let rows = [...(rowsByTable.get(table) ?? [])];
      const parameters = sqlParameters(where);
      if (table === chatConversations) {
        rows = rows.filter((row) => parameters.includes(row.id));
        if (selection?.sourceRevision) {
          const revisionParameters = sqlParameters(selection.sourceRevision);
          const afterId = revisionParameters.findLast((parameter) => runs.some((run) => run.id === parameter));
          const anchor = runs.find((run) => run.id === afterId);
          if (!anchor) throw new Error("Expected a consumed-source revision anchor");
          const consumed = runs
            .filter((run) => Date.parse(String(run.createdAt)) < Date.parse(String(anchor.createdAt))
              || (Date.parse(String(run.createdAt)) === Date.parse(String(anchor.createdAt))
                && String(run.id).localeCompare(String(anchor.id)) <= 0))
            .map((run) => ({ id: run.id, createdAt: run.createdAt, updatedAt: run.updatedAt }));
          const sourceRevision = createHash("sha256").update(JSON.stringify(consumed)).digest("hex");
          rows = rows.map(() => ({ sourceRevision }));
        }
      }
      if (table === heartbeatRuns) {
        const matchingRunIds = parameters.filter((parameter) => runs.some((run) => run.id === parameter));
        if (ordered) {
          const afterId = matchingRunIds.at(-1);
          rows.sort((left, right) => Date.parse(String(left.createdAt)) - Date.parse(String(right.createdAt))
            || String(left.id).localeCompare(String(right.id)));
          if (afterId !== undefined) {
            const anchor = runs.find((run) => run.id === afterId);
            if (anchor) {
              rows = rows.filter((run) => Date.parse(String(run.createdAt)) > Date.parse(String(anchor.createdAt))
                || (Date.parse(String(run.createdAt)) === Date.parse(String(anchor.createdAt))
                  && String(run.id).localeCompare(String(anchor.id)) > 0));
            }
          }
        } else {
          const runId = matchingRunIds.at(-1);
          rows = runId === undefined ? [] : rows.filter((run) => run.id === runId);
        }
      }
      return Promise.resolve(rows.slice(0, rowLimit)).then(resolve, reject);
    };
    return query;
  });
  return { select, runs };
}

function databaseRun(id: string, createdAt: string, updatedAt: string): Record<string, unknown> {
  return {
    id,
    orgId: "org-1",
    chatConversationId: "conversation-1",
    logStore: null,
    logRef: null,
    logCompressed: false,
    logSha256: null,
    logBytes: null,
    startedAt: new Date(createdAt),
    createdAt: new Date(createdAt),
    updatedAt: new Date(updatedAt),
    resultJson: { __chatTranscript: [{ kind: "assistant", ts: createdAt, text: id }] },
    contextSnapshot: null,
  };
}

function makeReader(runs: Record<string, unknown>[], entriesPerRun = 1) {
  const database = mockDatabase(runs);
  const legacyReader = {
    readRun: vi.fn(async (input: LegacyTranscriptReadInput) => ({
      entries: Array.from({ length: entriesPerRun }, (_, index) => ({
        kind: "assistant" as const,
        ts: new Date(input.run.createdAt.getTime() + index * 1000).toISOString(),
        text: `${input.run.id}-${index}`,
      })),
      revision: `legacy-${input.run.id}`,
      availability: "available" as const,
      completeness: "complete" as const,
    })),
  };
  const reader = createTranscriptReader(database as never, { legacyReader });
  const principal = { type: "board", orgId: "org-1", authorized: true };
  return {
    database,
    legacyReader,
    async read(cursor?: string | null, range?: { start: number; end: number }) {
      return await reader.readConversation({
        orgId: "org-1",
        conversationId: "conversation-1",
        principal,
        cursor,
        limit: 1,
        range,
      });
    },
  };
}

describe("conversation transcript cursor source revisions", () => {
  it("rejects continuation when a consumed run changes without updating the conversation", async () => {
    const reader = makeReader([
      databaseRun("run-a", "2026-09-22T00:00:01.000Z", "2026-09-22T00:00:02.000Z"),
      databaseRun("run-b", "2026-09-22T00:00:03.000Z", "2026-09-22T00:00:04.000Z"),
    ]);
    const first = await reader.read();

    expect(first.items.map((item) => item.runId)).toEqual(["run-a"]);
    const cursor = decodeTranscriptCursor(first.nextCursor!);
    expect(cursor?.conversationAfter).toMatchObject({
      kind: "run",
      id: "run-a",
      updatedAt: "2026-09-22T00:00:02.000Z",
    });

    reader.database.runs[0]!.updatedAt = new Date("2026-09-22T00:00:05.000Z");

    await expect(reader.read(first.nextCursor)).rejects.toThrow("source revision");
    expect(reader.legacyReader.readRun).toHaveBeenCalledOnce();
  });

  it("continues pagination when consumed and pending source revisions are unchanged", async () => {
    const reader = makeReader([
      databaseRun("run-a", "2026-09-22T00:00:01.000Z", "2026-09-22T00:00:02.000Z"),
      databaseRun("run-b", "2026-09-22T00:00:03.000Z", "2026-09-22T00:00:04.000Z"),
    ]);
    const first = await reader.read();

    const second = await reader.read(first.nextCursor);

    expect(second.items.map((item) => item.runId)).toEqual(["run-b"]);
    expect(second.nextCursor).toBeNull();
    expect(reader.legacyReader.readRun).toHaveBeenCalledTimes(2);
  });

  it("rejects an earlier consumed run revision after the cursor has advanced past another run", async () => {
    const reader = makeReader([
      databaseRun("run-a", "2026-09-22T00:00:01.000Z", "2026-09-22T00:00:02.000Z"),
      databaseRun("run-b", "2026-09-22T00:00:03.000Z", "2026-09-22T00:00:04.000Z"),
      databaseRun("run-c", "2026-09-22T00:00:05.000Z", "2026-09-22T00:00:06.000Z"),
    ]);
    const first = await reader.read();
    const second = await reader.read(first.nextCursor);

    expect(first.items.map((item) => item.runId)).toEqual(["run-a"]);
    expect(second.items.map((item) => item.runId)).toEqual(["run-b"]);
    expect(decodeTranscriptCursor(second.nextCursor!)?.conversationAfter).toMatchObject({ id: "run-b" });
    expect(decodeTranscriptCursor(second.nextCursor!)?.revision)
      .not.toBe(decodeTranscriptCursor(first.nextCursor!)?.revision);

    reader.database.runs[0]!.updatedAt = new Date("2026-09-22T00:00:07.000Z");

    await expect(reader.read(second.nextCursor)).rejects.toThrow("cursor revision");
    expect(reader.legacyReader.readRun).toHaveBeenCalledTimes(2);
  });

  it("applies numeric bounds once across two Runs and terminates at the global end", async () => {
    const reader = makeReader([
      databaseRun("run-a", "2026-09-22T00:00:01.000Z", "2026-09-22T00:00:02.000Z"),
      databaseRun("run-b", "2026-09-22T00:00:03.000Z", "2026-09-22T00:00:04.000Z"),
    ], 2);
    const range = { start: 1, end: 2 };

    const first = await reader.read(null, range);
    expect(first.items.map((item) => item.payload)).toEqual([expect.objectContaining({ text: "run-a-1" })]);
    expect(decodeTranscriptCursor(first.nextCursor!)?.position).toBe(2);

    const second = await reader.read(first.nextCursor, range);
    expect(second.items.map((item) => item.payload)).toEqual([expect.objectContaining({ text: "run-b-0" })]);
    expect(second.nextCursor).toBeNull();
    expect(reader.legacyReader.readRun).toHaveBeenCalledTimes(3);
  });
});
