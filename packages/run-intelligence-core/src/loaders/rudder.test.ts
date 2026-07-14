import type { HeartbeatRun, HeartbeatRunEvent } from "@rudderhq/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findObservedRunByPrefix,
  getRunEvents,
  getRunLog,
  listObservedRunSummaries,
  observedRunFromFilesystem,
} from "./rudder.js";

function makeRun(overrides: Partial<HeartbeatRun> = {}): HeartbeatRun {
  return {
    id: "run-chat-1",
    orgId: "org-1",
    agentId: "agent-1",
    invocationSource: "chat",
    triggerDetail: "chat_assistant_reply_stream",
    status: "succeeded",
    startedAt: new Date("2026-06-17T09:00:00.000Z"),
    finishedAt: new Date("2026-06-17T09:01:00.000Z"),
    error: null,
    wakeupRequestId: null,
    exitCode: 0,
    signal: null,
    usageJson: null,
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    errorCode: null,
    externalRunId: null,
    chatConversationId: "chat-1",
    processPid: null,
    processStartedAt: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    contextSnapshot: {
      userMessageId: "msg-user-1",
      assistantMessageId: "msg-assistant-1",
    },
    createdAt: new Date("2026-06-17T09:00:00.000Z"),
    updatedAt: new Date("2026-06-17T09:01:00.000Z"),
    ...overrides,
  };
}

function makeTranscriptEvent(
  seq: number,
  payload: Record<string, unknown>,
  overrides: Partial<HeartbeatRunEvent> = {},
): HeartbeatRunEvent {
  return {
    id: seq,
    orgId: "org-1",
    runId: "run-chat-1",
    agentId: "agent-1",
    seq,
    eventType: "transcript.entry",
    stream: "system",
    level: "info",
    color: null,
    message: "chat transcript entry",
    payload,
    createdAt: new Date(`2026-06-17T09:00:${String(seq).padStart(2, "0")}.000Z`),
    ...overrides,
  };
}

const bundle = {
  agentRuntimeType: "codex_local",
  agentConfigRevisionId: null,
  agentConfigRevisionCreatedAt: null,
  agentConfigFingerprint: null,
  runtimeConfigFingerprint: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Rudder summary loaders", () => {
  it("requests the summary projection without mutating caller params", async () => {
    const params = new URLSearchParams({ status: "failed", limit: "20" });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      items: [],
      page: { limit: 20, hasMore: false, nextCursor: null },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listObservedRunSummaries("http://localhost:3100/api", "org-1", params)).resolves.toEqual({
      items: [],
      page: { limit: 20, hasMore: false, nextCursor: null },
    });

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    const requestedUrl = new URL(url);
    expect(requestedUrl.pathname).toBe("/api/run-intelligence/orgs/org-1/runs");
    expect(requestedUrl.searchParams.get("projection")).toBe("summary");
    expect(requestedUrl.searchParams.get("status")).toBe("failed");
    expect(params.has("projection")).toBe(false);
  });

  it("uses summaries for prefix lookup and fetches full detail only for the match", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/orgs") {
        return new Response(JSON.stringify([{ id: "org-1", name: "Rudder" }]), { status: 200 });
      }
      if (url.pathname === "/api/run-intelligence/orgs/org-1/runs") {
        return new Response(JSON.stringify({
          items: [{ id: "run-abcdef", agentId: "agent-1" }],
          page: { limit: 100, hasMore: false, nextCursor: null },
        }), { status: 200 });
      }
      if (url.pathname === "/api/run-intelligence/runs/run-abcdef") {
        return new Response(JSON.stringify({ run: { id: "run-abcdef" } }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(findObservedRunByPrefix("http://localhost:3100/api", "run-abc")).resolves.toMatchObject({
      run: { id: "run-abcdef" },
    });

    const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input)));
    expect(urls[1]?.searchParams.get("projection")).toBe("summary");
    expect(urls[1]?.searchParams.get("runIdPrefix")).toBe("run-abc");
    expect(urls[2]?.pathname).toBe("/api/run-intelligence/runs/run-abcdef");
  });

  it("walks bounded event and log pages when hydrating one explicit run", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/events")) {
        const afterSeq = url.searchParams.get("afterSeq");
        return new Response(JSON.stringify(afterSeq === "0"
          ? { items: [makeTranscriptEvent(1, { kind: "assistant", text: "one" })], page: { hasMore: true, nextAfterSeq: 1 } }
          : { items: [makeTranscriptEvent(2, { kind: "assistant", text: "two" })], page: { hasMore: false, nextAfterSeq: null } }), { status: 200 });
      }
      const offset = url.searchParams.get("offset");
      return new Response(JSON.stringify(offset === "0"
        ? { content: "first", page: { eof: false, nextOffset: 5 } }
        : { content: "second", page: { eof: true, nextOffset: null } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getRunEvents("http://localhost:3100/api", "run-1")).resolves.toHaveLength(2);
    await expect(getRunLog("http://localhost:3100/api", "run-1")).resolves.toEqual({ content: "firstsecond" });

    const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input)));
    expect(urls.filter((url) => url.pathname.endsWith("/events")).map((url) => url.searchParams.get("afterSeq")))
      .toEqual(["0", "1"]);
    expect(urls.filter((url) => url.pathname.endsWith("/log")).map((url) => url.searchParams.get("offset")))
      .toEqual(["0", "5"]);
  });
});

describe("observedRunFromFilesystem", () => {
  it("hydrates chat run transcripts from transcript.entry events when no run log exists", () => {
    const detail = observedRunFromFilesystem({
      run: makeRun(),
      agentName: "Chat Agent",
      bundle,
      events: [
        makeTranscriptEvent(1, {
          kind: "assistant",
          ts: "2026-06-17T09:00:01.000Z",
          text: "I will inspect this.",
        }),
        makeTranscriptEvent(2, {
          kind: "tool_call",
          ts: "2026-06-17T09:00:02.000Z",
          name: "exec_command",
          input: { cmd: "pnpm test" },
          toolUseId: "tool-1",
        }),
        makeTranscriptEvent(3, {
          kind: "tool_result",
          ts: "2026-06-17T09:00:03.000Z",
          toolUseId: "tool-1",
          toolName: "exec_command",
          content: "passed",
          isError: false,
        }),
      ],
      logContent: "",
    });

    expect(detail.logChunks).toEqual([]);
    expect(detail.transcript).toEqual([
      { kind: "assistant", ts: "2026-06-17T09:00:01.000Z", text: "I will inspect this." },
      {
        kind: "tool_call",
        ts: "2026-06-17T09:00:02.000Z",
        name: "exec_command",
        input: { cmd: "pnpm test" },
        toolUseId: "tool-1",
      },
      {
        kind: "tool_result",
        ts: "2026-06-17T09:00:03.000Z",
        toolUseId: "tool-1",
        toolName: "exec_command",
        content: "passed",
        isError: false,
      },
    ]);
  });

  it("keeps log-derived transcripts as the source of truth when run logs are present", () => {
    const detail = observedRunFromFilesystem({
      run: makeRun({ invocationSource: "on_demand", triggerDetail: "manual" }),
      agentName: "Run Agent",
      bundle: { ...bundle, agentRuntimeType: "process" },
      events: [
        makeTranscriptEvent(1, {
          kind: "assistant",
          ts: "2026-06-17T09:00:01.000Z",
          text: "event transcript",
        }),
      ],
      logContent: JSON.stringify({
        ts: "2026-06-17T09:00:01.000Z",
        stream: "system",
        chunk: "log transcript",
      }),
    });

    expect(detail.transcript).toEqual([
      { kind: "system", ts: "2026-06-17T09:00:01.000Z", text: "log transcript" },
    ]);
  });
});
