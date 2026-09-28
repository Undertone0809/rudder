import {
  chatConversations,
  chatMessages,
  heartbeatRunEvents,
  heartbeatRuns,
  nativeSegments,
  runRuntimeSpans,
  runtimeBindings,
} from "@rudderhq/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { vi } from "vitest";

export function mockDatabase(input: {
  run?: Record<string, unknown>;
  runs?: Record<string, unknown>[];
  conversations?: Record<string, unknown>[];
  messages?: Record<string, unknown>[];
  spans?: Record<string, unknown>[];
  bindings?: Record<string, unknown>[];
  segments?: Record<string, unknown>[];
  events?: Record<string, unknown>[];
  pageEvents?: boolean;
  nativeEventScope?: { orgId: string; runId: string; spanId: string; attemptId: string | null };
}) {
  const rowsByTable = new Map<unknown, Record<string, unknown>[]>([
    [chatConversations, input.conversations ?? []],
    [chatMessages, input.messages ?? []],
    [heartbeatRuns, input.runs ?? (input.run ? [input.run] : [])],
    [runRuntimeSpans, input.spans ?? []],
    [runtimeBindings, input.bindings ?? []],
    [nativeSegments, input.segments ?? []],
    [heartbeatRunEvents, input.events ?? []],
  ]);
  const limitCalls: number[] = [];
  const eventPages: Record<string, unknown>[][] = [];
  const eventWhereParameters: unknown[][] = [];
  const pgDialect = new PgDialect();
  let eventAfter: { seq: number; id: number } | null = null;
  let selectedEventRows: Record<string, unknown>[] = [];
  let maxEventRowsRead = 0;
  const select = vi.fn((selection?: Record<string, unknown>) => {
    let table: unknown;
    let rowLimit: number | undefined;
    const query: Record<string, unknown> & {
      then?: (resolve: (value: Record<string, unknown>[]) => unknown, reject?: (reason: unknown) => unknown) => Promise<unknown>;
    } = {};
    query.from = vi.fn((value: unknown) => {
      table = value;
      return query;
    });
    query.innerJoin = vi.fn(() => query);
    query.where = vi.fn((condition?: unknown) => {
      if (table === heartbeatRunEvents && condition) {
        eventWhereParameters.push(pgDialect.sqlToQuery(condition as SQL).params);
      }
      return query;
    });
    query.orderBy = vi.fn(() => query);
    query.groupBy = vi.fn(() => query);
    query.limit = vi.fn((value: number) => {
      limitCalls.push(value);
      rowLimit = value;
      return query;
    });
    query.then = (resolve, reject) => {
      const storedRows = rowsByTable.get(table) ?? [];
      const rows = table === heartbeatRunEvents && input.nativeEventScope
        ? storedRows.filter((row) => {
          const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
            ? row.payload as Record<string, unknown>
            : {};
          const nested = [payload.entry, payload.transcriptEntry, payload.transcript]
            .find((value) => value && typeof value === "object" && !Array.isArray(value)) as Record<string, unknown> | undefined;
          const spanId = payload.spanId ?? payload.span_id ?? nested?.spanId ?? nested?.span_id;
          const attemptId = payload.attemptId ?? payload.attempt_id ?? nested?.attemptId ?? nested?.attempt_id ?? null;
          return row.orgId === input.nativeEventScope!.orgId
            && row.runId === input.nativeEventScope!.runId
            && spanId === input.nativeEventScope!.spanId
            && attemptId === input.nativeEventScope!.attemptId;
        })
        : storedRows;
      let selectedRows: Record<string, unknown>[];
      if (input.pageEvents && table === heartbeatRunEvents) {
        const fields = selection ? Object.keys(selection) : [];
        if (fields.length === 1 && fields[0] === "id") {
          selectedRows = [...rows].sort((left, right) => Number(right.id) - Number(left.id)).slice(0, 1)
            .map((row) => ({ id: row.id }));
        } else if (fields.includes("byteLength")) {
          const ordered = [...rows]
            .filter((row) => row.eventType === "transcript.entry" && row.seq !== null)
            .filter((row) => !eventAfter
              || Number(row.seq) > eventAfter.seq
              || (Number(row.seq) === eventAfter.seq && Number(row.id) > eventAfter.id))
            .sort((left, right) => Number(left.seq) - Number(right.seq) || Number(left.id) - Number(right.id));
          const metadata = ordered.slice(0, rowLimit).map((row) => ({
            id: row.id,
            seq: row.seq,
            byteLength: Buffer.byteLength(JSON.stringify(row.payload) ?? "null", "utf8")
              + Buffer.byteLength(typeof row.stream === "string" ? row.stream : "", "utf8")
              + Buffer.byteLength(typeof row.level === "string" ? row.level : "", "utf8")
              + Buffer.byteLength(typeof row.color === "string" ? row.color : "", "utf8")
              + Buffer.byteLength(typeof row.message === "string" ? row.message : "", "utf8")
              + Buffer.byteLength(typeof row.idempotencyKey === "string" ? row.idempotencyKey : "", "utf8") + 128,
          }));
          selectedEventRows = ordered.slice(0, Math.min(metadata.length, Math.max(0, (rowLimit ?? metadata.length) - 1)));
          eventPages.push(selectedEventRows);
          selectedRows = metadata;
        } else {
          const page = selectedEventRows;
          maxEventRowsRead = Math.max(maxEventRowsRead, page.length);
          selectedRows = page;
          const last = page.at(-1);
          if (last) eventAfter = { seq: Number(last.seq), id: Number(last.id) };
          selectedEventRows = [];
        }
      } else {
        selectedRows = rows.slice(0, rowLimit);
      }
      return Promise.resolve(selectedRows).then(resolve, reject);
    };
    return query;
  });
  return {
    select,
    limitCalls,
    eventPages,
    eventWhereParameters,
    get maxEventRowsRead() { return maxEventRowsRead; },
  };
}

export function databaseRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "run-1",
    orgId: "org-1",
    chatConversationId: null,
    logStore: null,
    logRef: null,
    logCompressed: false,
    logSha256: null,
    logBytes: null,
    startedAt: new Date("2026-09-22T00:00:00.000Z"),
    createdAt: new Date("2026-09-22T00:00:00.000Z"),
    updatedAt: new Date("2026-09-22T00:00:01.000Z"),
    resultJson: null,
    contextSnapshot: null,
    ...overrides,
  };
}

export function databaseSpan(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    runId: "run-1",
    bindingId: `binding-${id}`,
    segmentId: `segment-${id}`,
    ordinal: 0,
    selectorJson: { kind: "native_execution" },
    completeness: "complete",
    visibilityCutoffRef: null,
    supplementalObjectRef: null,
    updatedAt: new Date("2026-09-22T00:00:01.000Z"),
    ...overrides,
  };
}

export function databaseBinding(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `binding-${id}`,
    orgId: "org-1",
    conversationId: null,
    principalScopeRef: "user:user-1",
    runtimeType: "process",
    ...overrides,
  };
}

export function databaseSegment(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `segment-${id}`,
    orgId: "org-1",
    bindingId: `binding-${id}`,
    runtimeType: "process",
    nativeSessionId: `session-${id}`,
    ...overrides,
  };
}

export function legacyTranscriptEvent(input: {
  id: number;
  orgId?: string;
  runId?: string;
  spanId: string;
  attemptId: string | null;
  text: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    orgId: input.orgId ?? "org-1",
    runId: input.runId ?? "run-1",
    seq: input.id,
    eventType: "transcript.entry",
    payload: {
      spanId: input.spanId,
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      entry: {
        kind: "assistant",
        ts: "2026-09-22T00:00:01.000Z",
        text: input.text,
      },
    },
    createdAt: new Date("2026-09-22T00:00:01.000Z"),
  };
}

export function nativeBoundTranscriptDatabase(events: Record<string, unknown>[]) {
  return mockDatabase({
    run: databaseRun({ contextSnapshot: { transcriptSource: "native" } }),
    spans: [databaseSpan("span-1", { attemptId: "attempt-1" })],
    bindings: [databaseBinding("span-1", { continuity: "native" })],
    segments: [databaseSegment("span-1")],
    events,
    pageEvents: true,
    nativeEventScope: { orgId: "org-1", runId: "run-1", spanId: "span-1", attemptId: "attempt-1" },
  });
}
