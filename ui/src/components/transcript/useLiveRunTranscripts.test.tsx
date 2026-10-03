// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptEntry } from "../../agent-runtimes";
import type { LiveRunForIssue } from "../../api/agent-runs";
import { fallbackActivityCoordinator } from "../../runtime/activity-coordinator";
import { useLiveRunTranscripts } from "./useLiveRunTranscripts";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const transcriptMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { censorUsernameInLogs: false } }),
}));

vi.mock("../../api/agent-runs", () => ({
  AGENT_RUN_TRANSCRIPT_TURN_LIMIT: 50,
  agentRunsApi: {
    transcript: transcriptMock,
  },
}));

const liveRun: LiveRunForIssue = {
  id: "run-1",
  status: "running",
  invocationSource: "chat",
  triggerDetail: null,
  startedAt: "2026-06-19T11:06:00.000Z",
  finishedAt: null,
  createdAt: "2026-06-19T11:06:00.000Z",
  agentId: "agent-1",
  agentName: "Mira",
  agentRuntimeType: "process",
  issueId: null,
};

function HookProbe({ onEntries }: { onEntries: (texts: string[]) => void }) {
  const { transcriptByRun } = useLiveRunTranscripts({ runs: [liveRun], orgId: "org-1" });
  onEntries(
    (transcriptByRun.get("run-1") ?? []).map((entry) =>
      "text" in entry ? entry.text : "content" in entry ? entry.content : "",
    ),
  );
  return null;
}

function ConfigurableHookProbe({
  runs,
  onEntries,
}: {
  runs: LiveRunForIssue[];
  onEntries: (texts: string[]) => void;
}) {
  const { transcriptByRun } = useLiveRunTranscripts({ runs, orgId: "org-1" });
  onEntries(
    runs.flatMap((run) => (transcriptByRun.get(run.id) ?? []).map((entry) =>
      "text" in entry ? entry.text : "content" in entry ? entry.content : "",
    )),
  );
  return null;
}

describe("useLiveRunTranscripts", () => {
  beforeEach(() => {
    transcriptMock.mockReset();
    transcriptMock.mockResolvedValue({
      entries: [],
      source: "legacy",
      revision: "revision-1",
      availability: "available",
      completeness: "complete",
      page: { cursor: null, hasMore: false, nextCursor: null, order: "oldest" },
    });
  });

  it("hydrates live transcript.entry events from payloads instead of showing placeholder messages", async () => {
    const observed: string[][] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<HookProbe onEntries={(texts) => observed.push(texts)} />);
    });

    await act(async () => {
      fallbackActivityCoordinator.publishLiveEvent({
        id: 1,
        orgId: "org-1",
        type: "heartbeat.run.event",
        createdAt: "2026-06-19T11:06:22.580Z",
        payload: {
          runId: "run-1",
          agentId: "agent-1",
          seq: 12,
          eventType: "transcript.entry",
          stream: "system",
          level: "info",
          message: "chat transcript entry",
          payload: {
            kind: "assistant",
            ts: "2026-06-19T11:06:22.580Z",
            text: "我先看一下附件里的错误和 paperclip 仓库本地约束。",
          },
        },
      });
    });

    expect(observed.at(-1)).toEqual([
      "我先看一下附件里的错误和 paperclip 仓库本地约束。",
    ]);
    expect(observed.flat()).not.toContain("chat transcript entry");

    act(() => root.unmount());
    container.remove();
  });

  it("keeps partial stdout buffered across direct transcript.entry events", async () => {
    const observed: string[][] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<HookProbe onEntries={(texts) => observed.push(texts)} />);
    });

    await act(async () => {
      fallbackActivityCoordinator.publishLiveEvent({
        id: 2,
        orgId: "org-1",
        type: "heartbeat.run.log",
        createdAt: "2026-06-19T11:06:23.000Z",
        payload: {
          runId: "run-1",
          ts: "2026-06-19T11:06:23.000Z",
          stream: "stdout",
          chunk: "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"first ",
        },
      });
      fallbackActivityCoordinator.publishLiveEvent({
        id: 3,
        orgId: "org-1",
        type: "heartbeat.run.event",
        createdAt: "2026-06-19T11:06:24.000Z",
        payload: {
          runId: "run-1",
          agentId: "agent-1",
          seq: 13,
          eventType: "transcript.entry",
          message: "chat transcript entry",
          payload: {
            kind: "assistant",
            ts: "2026-06-19T11:06:24.000Z",
            text: "direct entry",
          },
        },
      });
      fallbackActivityCoordinator.publishLiveEvent({
        id: 4,
        orgId: "org-1",
        type: "heartbeat.run.log",
        createdAt: "2026-06-19T11:06:25.000Z",
        payload: {
          runId: "run-1",
          ts: "2026-06-19T11:06:25.000Z",
          stream: "stdout",
          chunk: "message\"}}\n",
        },
      });
    });

    expect(observed.at(-1)).toEqual([
      "direct entry",
      "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"first message\"}}",
    ]);

    act(() => root.unmount());
    container.remove();
  });

  it("rehydrates a terminal transcript through Reader after the run is removed and added again", async () => {
    const terminalRun: LiveRunForIssue = {
      ...liveRun,
      status: "succeeded",
      finishedAt: "2026-06-19T11:07:00.000Z",
    };
    const readerResult = {
      entries: [{
        kind: "assistant" as const,
        ts: "2026-06-19T11:06:30.000Z",
        text: "persisted terminal evidence",
        sourceEntryId: "terminal-entry-1",
      }],
      source: "native" as const,
      revision: "terminal-revision",
      availability: "available" as const,
      completeness: "complete" as const,
      page: { cursor: null, hasMore: false, nextCursor: null, order: "oldest" as const },
    };
    transcriptMock.mockResolvedValue(readerResult);

    const observed: string[][] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderProbe = (runs: LiveRunForIssue[]) => (
      <ConfigurableHookProbe runs={runs} onEntries={(texts) => observed.push(texts)} />
    );

    await act(async () => {
      root.render(renderProbe([terminalRun]));
    });
    expect(observed.at(-1)).toContain("persisted terminal evidence");

    await act(async () => {
      root.render(renderProbe([]));
    });
    await act(async () => {
      root.render(renderProbe([terminalRun]));
    });

    expect(transcriptMock).toHaveBeenCalledTimes(2);
    expect(transcriptMock).toHaveBeenNthCalledWith(1, terminalRun.id, { includeOutput: false, turnLimit: 50 });
    expect(transcriptMock).toHaveBeenNthCalledWith(2, terminalRun.id, { includeOutput: false, turnLimit: 50 });
    expect(observed.at(-1)).toContain("persisted terminal evidence");

    act(() => root.unmount());
    container.remove();
  });

  it("switches a visible Run from live Reader polling to terminal Reader hydration", async () => {
    const terminalRun: LiveRunForIssue = {
      ...liveRun,
      status: "succeeded",
      finishedAt: "2026-06-19T11:07:00.000Z",
    };
    transcriptMock
      .mockResolvedValueOnce({
        entries: [{
          kind: "assistant" as const,
          ts: "2026-06-19T11:06:30.000Z",
          text: "live evidence",
          sourceEntryId: "live-entry-1",
        }],
        source: "native" as const,
        revision: "live-revision",
        availability: "available" as const,
        completeness: "partial" as const,
        page: { cursor: null, hasMore: false, nextCursor: null, order: "oldest" as const },
      })
      .mockResolvedValueOnce({
        entries: [{
          kind: "assistant" as const,
          ts: "2026-06-19T11:07:00.000Z",
          text: "terminal evidence",
          sourceEntryId: "terminal-entry-2",
        }],
        source: "native" as const,
        revision: "terminal-revision",
        availability: "available" as const,
        completeness: "complete" as const,
        page: { cursor: null, hasMore: false, nextCursor: null, order: "oldest" as const },
      });

    const observed: string[][] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderProbe = (runs: LiveRunForIssue[]) => (
      <ConfigurableHookProbe runs={runs} onEntries={(texts) => observed.push(texts)} />
    );

    await act(async () => {
      root.render(renderProbe([liveRun]));
    });
    expect(observed.at(-1)).toContain("live evidence");

    await act(async () => {
      root.render(renderProbe([terminalRun]));
    });

    expect(transcriptMock).toHaveBeenCalledTimes(2);
    expect(observed.at(-1)).toContain("terminal evidence");

    act(() => root.unmount());
    container.remove();
  });

  it("shares one Reader source across concurrent consumers of the same run", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderProbes = (firstRun: LiveRunForIssue, secondRun: LiveRunForIssue) => (
      <>
        <ConfigurableHookProbe runs={[firstRun]} onEntries={() => {}} />
        <ConfigurableHookProbe runs={[secondRun]} onEntries={() => {}} />
      </>
    );

    await act(async () => {
      root.render(renderProbes(liveRun, liveRun));
    });

    expect(transcriptMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(renderProbes({ ...liveRun }, { ...liveRun }));
    });

    expect(transcriptMock).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    container.remove();
  });

  it("uses the Reader projection without reading a second legacy transcript", async () => {
    transcriptMock.mockResolvedValue({
      entries: [{
        kind: "assistant",
        ts: "2026-06-19T11:06:10.000Z",
        text: "reader transcript",
        sourceEntryId: "reader-entry-1",
      }],
      source: "native",
      revision: "revision-native",
      availability: "available",
      completeness: "complete",
      page: { cursor: null, hasMore: false, nextCursor: null, order: "oldest" },
    });
    const observed: string[][] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<HookProbe onEntries={(texts) => observed.push(texts)} />);
    });

    expect(observed.at(-1)).toEqual(["reader transcript"]);
    expect(transcriptMock).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    container.remove();
  });

  it("deduplicates a live entry against the Reader identity and keeps Reader content authoritative", async () => {
    transcriptMock.mockResolvedValue({
      entries: [{
        kind: "assistant",
        ts: "2026-06-19T11:06:22.580Z",
        text: "reader final",
        sourceEntryId: "99",
      }],
      source: "native",
      revision: "revision-native",
      availability: "available",
      completeness: "partial",
      page: { cursor: null, hasMore: false, nextCursor: null, order: "oldest" },
    });
    const observed: string[][] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<HookProbe onEntries={(texts) => observed.push(texts)} />);
    });
    await act(async () => {
      fallbackActivityCoordinator.publishLiveEvent({
        id: 99,
        orgId: "org-1",
        type: "heartbeat.run.event",
        createdAt: "2026-06-19T11:06:22.580Z",
        payload: {
          runId: "run-1",
          agentId: "agent-1",
          seq: 12,
          eventType: "transcript.entry",
          payload: {
            entry: {
              kind: "assistant",
              ts: "2026-06-19T11:06:22.580Z",
              text: "live partial",
            },
          },
        },
      });
    });

    expect(observed.at(-1)).toEqual(["reader final"]);
    act(() => root.unmount());
    container.remove();
  });

  it("replaces provisional ACP chunks and event IDs with Reader identities without doubling text", async () => {
    const cursorRun = { ...liveRun, agentRuntimeType: "cursor" };
    const cursorEntry = (kind: string, text: string, sourceEntryId?: string) => ({
      kind: `cursor:acp:${kind}`, ts: "2026-06-19T11:06:22.580Z",
      ...(sourceEntryId ? { sourceEntryId } : {}),
      text: text.trim(),
      payload: {
        provider: "cursor_agent", transport: "cursor-agent-acp-stdio",
        method: "session/update", sessionId: "cursor-session-1",
        update: { sessionUpdate: kind, content: { type: "text", text } },
      },
    });
    let resolveReader!: (value: unknown) => void;
    transcriptMock.mockReturnValue(new Promise((resolve) => { resolveReader = resolve; }));
    const observed: TranscriptEntry[][] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    function Probe() {
      const { transcriptByRun } = useLiveRunTranscripts({ runs: [cursorRun], orgId: "org-1" });
      observed.push(transcriptByRun.get(cursorRun.id) ?? []);
      return null;
    }
    await act(async () => { root.render(<Probe />); });
    await act(async () => {
      for (const [index, text] of ["Hello ", "world"].entries()) {
        fallbackActivityCoordinator.publishLiveEvent({
          id: 90 + index, orgId: "org-1", type: "heartbeat.run.log",
          createdAt: "2026-06-19T11:06:22.580Z",
          payload: { runId: cursorRun.id, stream: "stdout", ts: "2026-06-19T11:06:22.580Z",
            chunk: `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
              sessionId: "cursor-session-1", update: cursorEntry("agent_message_chunk", text).payload.update,
            } })}\n` },
        });
      }
      fallbackActivityCoordinator.publishLiveEvent({
        id: 99, orgId: "org-1", type: "heartbeat.run.event",
        createdAt: "2026-06-19T11:06:22.580Z",
        payload: { runId: cursorRun.id, seq: 13, eventType: "transcript.entry",
          payload: { entry: cursorEntry("agent_thought_chunk", "Checking ") } },
      });
      fallbackActivityCoordinator.publishLiveEvent({
        id: 100, orgId: "org-1", type: "heartbeat.run.event",
        createdAt: "2026-06-19T11:06:22.580Z",
        payload: { runId: cursorRun.id, seq: 14, eventType: "transcript.entry",
          payload: cursorEntry("agent_thought_chunk", "more") },
      });
    });
    expect(observed.at(-1)).toHaveLength(4);
    expect(observed.at(-1)?.every((entry) => !entry.sourceEntryId)).toBe(true);

    await act(async () => {
      resolveReader({
        entries: [
          { ...cursorEntry("agent_message_chunk", "Hello ", "acp:update:hello"),
            payload: { ...cursorEntry("agent_message_chunk", "Hello ").payload,
              update: { content: { text: "Hello ", type: "text" }, sessionUpdate: "agent_message_chunk" } } },
          cursorEntry("agent_message_chunk", "world", "acp:update:world"),
          cursorEntry("agent_thought_chunk", "Checking ", "acp:update:thought"),
          cursorEntry("agent_thought_chunk", "more", "acp:update:thought-more"),
        ],
        source: "native", revision: "partial-cursor", availability: "available", completeness: "partial",
        page: { cursor: null, hasMore: false, nextCursor: null, order: "oldest" },
      });
    });
    expect(observed.at(-1)).toHaveLength(4);
    expect(observed.at(-1)?.map((entry) => entry.sourceEntryId)).toEqual([
      "acp:update:hello", "acp:update:world", "acp:update:thought", "acp:update:thought-more",
    ]);
    act(() => root.unmount());
    container.remove();
  });

  it("keeps same-timestamp identical ACP notifications and replaces them with replay occurrences", async () => {
    const cursorRun = { ...liveRun, agentRuntimeType: "cursor" };
    let resolveReader!: (value: unknown) => void;
    transcriptMock.mockReturnValue(new Promise((resolve) => { resolveReader = resolve; }));
    const observed: TranscriptEntry[][] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    function Probe() {
      const { transcriptByRun } = useLiveRunTranscripts({ runs: [cursorRun], orgId: "org-1" });
      observed.push(transcriptByRun.get(cursorRun.id) ?? []);
      return null;
    }
    const ts = "2026-06-19T11:06:22.580Z";
    const update = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Again " } };
    const chunk = `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: "cursor-session-1", update,
    } })}\n`;
    await act(async () => { root.render(<Probe />); });
    await act(async () => {
      for (const id of [101, 102, 102]) fallbackActivityCoordinator.publishLiveEvent({
        id, orgId: "org-1", type: "heartbeat.run.log", createdAt: ts,
        payload: { runId: cursorRun.id, stream: "stdout", ts, chunk },
      });
    });
    expect(observed.at(-1)).toHaveLength(2);
    await act(async () => {
      resolveReader({
        entries: [0, 1].map((ordinal) => ({ kind: "cursor:acp:agent_message_chunk", ts,
          sourceEntryId: `acp:replay-window:revision:${ordinal}`,
          payload: { provider: "cursor_agent", transport: "cursor-agent-acp-stdio",
            method: "session/update", sessionId: "cursor-session-1", update }, text: "Again " })),
        source: "native", revision: "revision", availability: "available", completeness: "partial",
        page: { cursor: null, hasMore: false, nextCursor: null, order: "oldest" },
      });
    });
    expect(observed.at(-1)).toHaveLength(2);
    expect(observed.at(-1)?.map((entry) => entry.sourceEntryId)).toEqual([
      "acp:replay-window:revision:0", "acp:replay-window:revision:1",
    ]);
    act(() => root.unmount());
    container.remove();
  });

  it("keeps native plan updates after a Reader refresh", async () => {
    const cursorRun = { ...liveRun, agentRuntimeType: "cursor" };
    const observed: TranscriptEntry[][] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    function Probe() {
      const { transcriptByRun } = useLiveRunTranscripts({ runs: [cursorRun], orgId: "org-1" });
      observed.push(transcriptByRun.get(cursorRun.id) ?? []);
      return null;
    }
    const ts = "2026-06-19T11:06:22.580Z";
    const entry = { kind: "cursor:acp:plan", ts, payload: {
      provider: "cursor_agent", transport: "cursor-agent-acp-stdio", method: "session/update",
      sessionId: "cursor-session-1", update: { sessionUpdate: "plan",
        entries: [{ content: "Inspect", status: "completed" }] },
    } };
    let resolveReader!: (value: unknown) => void;
    transcriptMock.mockReturnValue(new Promise((resolve) => { resolveReader = resolve; }));
    await act(async () => { root.render(<Probe />); });
    await act(async () => {
      fallbackActivityCoordinator.publishLiveEvent({
        id: 103, orgId: "org-1", type: "heartbeat.run.log", createdAt: ts,
        payload: { runId: cursorRun.id, stream: "stdout", ts, chunk: `${JSON.stringify({
          jsonrpc: "2.0", method: "session/update", params: { sessionId: "cursor-session-1", update: entry.payload.update },
        })}\n` },
      });
    });
    expect(observed.at(-1)).toMatchObject([entry]);
    await act(async () => { resolveReader({ entries: [{ ...entry, sourceEntryId: "acp:update:plan" }],
      source: "native", revision: "revision", availability: "available", completeness: "partial",
      page: { cursor: null, hasMore: false, nextCursor: null, order: "oldest" } }); });
    expect(observed.at(-1)).toHaveLength(1);
    expect(observed.at(-1)?.[0]?.sourceEntryId).toBe("acp:update:plan");
    act(() => root.unmount());
    container.remove();
  });

  it("does not fall back to raw Run summaries when the Reader fails", async () => {
    const nativeRun: LiveRunForIssue = {
      ...liveRun,
      id: "run-native-reader-error",
      stdoutExcerpt: "legacy stdout excerpt",
      resultJson: { summary: "legacy result summary" },
    };
    transcriptMock.mockRejectedValue(new Error("Reader unavailable"));

    const observed: string[][] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<ConfigurableHookProbe runs={[nativeRun]} onEntries={(texts) => observed.push(texts)} />);
    });

    expect(transcriptMock).toHaveBeenCalledTimes(1);
    expect(observed.at(-1)).not.toContain("legacy stdout excerpt");
    expect(observed.at(-1)).not.toContain("legacy result summary");

    act(() => root.unmount());
    container.remove();
  });

  it("keeps a seq-null transcript event live-only while it is not persisted", async () => {
    const observed: string[][] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<HookProbe onEntries={(texts) => observed.push(texts)} />);
    });

    await act(async () => {
      fallbackActivityCoordinator.publishLiveEvent({
        id: 77,
        orgId: "org-1",
        type: "heartbeat.run.event",
        createdAt: "2026-06-19T11:06:22.580Z",
        payload: {
          runId: "run-1",
          agentId: "agent-1",
          seq: null,
          eventType: "transcript.entry",
          payload: {
            kind: "assistant",
            ts: "2026-06-19T11:06:22.580Z",
            text: "live-only transcript",
          },
        },
      });
    });

    expect(observed.at(-1)).toContain("live-only transcript");
    expect(transcriptMock).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    container.remove();
  });
});
