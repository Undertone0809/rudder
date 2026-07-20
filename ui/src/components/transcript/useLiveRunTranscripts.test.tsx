// @vitest-environment jsdom

import type { LiveEvent } from "@rudderhq/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveRunForIssue } from "../../api/agent-runs";
import { useLiveRunTranscripts } from "./useLiveRunTranscripts";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const logMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { censorUsernameInLogs: false } }),
}));

vi.mock("../../api/agent-runs", () => ({
  agentRunsApi: {
    log: logMock,
  },
}));

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  close() {
    this.onclose?.();
  }

  emit(event: LiveEvent) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

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
    logMock.mockReset();
    logMock.mockResolvedValue({ runId: "run-1", store: "local", logRef: "run.log", content: "", endOffset: 0 });
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  it("hydrates live transcript.entry events from payloads instead of showing placeholder messages", async () => {
    const observed: string[][] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<HookProbe onEntries={(texts) => observed.push(texts)} />);
    });

    const socket = MockWebSocket.instances[0];
    expect(socket).toBeTruthy();

    await act(async () => {
      socket!.emit({
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

    const socket = MockWebSocket.instances[0];
    expect(socket).toBeTruthy();

    await act(async () => {
      socket!.emit({
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
      socket!.emit({
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
      socket!.emit({
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

  it("rehydrates a terminal transcript after the run is removed and added again", async () => {
    const terminalRun: LiveRunForIssue = {
      ...liveRun,
      status: "succeeded",
      finishedAt: "2026-06-19T11:07:00.000Z",
    };
    const persistedContent = `${JSON.stringify({
      ts: "2026-06-19T11:06:30.000Z",
      stream: "stdout",
      chunk: "persisted terminal evidence\n",
    })}\n`;
    logMock.mockResolvedValue({
      runId: terminalRun.id,
      store: "local",
      logRef: "run.log",
      content: persistedContent,
      endOffset: new TextEncoder().encode(persistedContent).length,
    });

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

    expect(logMock).toHaveBeenCalledTimes(2);
    expect(observed.at(-1)).toContain("persisted terminal evidence");

    act(() => root.unmount());
    container.remove();
  });
});
