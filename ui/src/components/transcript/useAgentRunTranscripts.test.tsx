// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatTranscriptEntriesForMessage,
  isAgentRunTranscriptActiveStatus,
  readLegacyChatTranscript,
  useAgentRunTranscripts,
  type AgentRunTranscriptTarget,
} from "./useAgentRunTranscripts";

const transcriptMock = vi.hoisted(() => vi.fn());
const legacyTranscriptMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/agent-runs", () => ({
  agentRunsApi: {
    transcript: transcriptMock,
  },
}));

vi.mock("@/api/chats", () => ({
  chatsApi: {
    getMessageTranscript: legacyTranscriptMock,
  },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function ReaderProbe({ targets }: { targets: readonly AgentRunTranscriptTarget[] }) {
  const { transcriptByRun, transcriptStateByRun } = useAgentRunTranscripts(targets);
  const nativeEntry = transcriptByRun.get("run-native")?.[0];
  const emptyState = transcriptStateByRun.get("run-empty");
  return (
    <div data-testid="reader-state">
      {nativeEntry?.kind === "assistant" ? nativeEntry.text : "pending"}
      {emptyState?.hasData ? "|empty-loaded" : "|empty-pending"}
    </div>
  );
}

function NavigationProbe({ runId, raw = false, active = false }: { runId: string; raw?: boolean; active?: boolean }) {
  const { transcriptByRun, transcriptStateByRun, transcriptNavigationByRun } = useAgentRunTranscripts([{ runId, active }], { raw });
  const navigation = transcriptNavigationByRun.get(runId);
  const state = transcriptStateByRun.get(runId);
  const entries = transcriptByRun.get(runId) ?? [];
  return (
    <div data-testid="navigation-probe">
      <div data-testid="navigation-entries">{entries.map((entry) => "text" in entry ? entry.text : entry.kind).join("|")}</div>
      <div data-testid="navigation-state">
        {state?.availability ?? "none"}|{state?.completeness ?? "none"}|{state?.hasData ? "loaded" : "pending"}
      </div>
      <div data-testid="navigation-page">{navigation?.pageNumber ?? "pending"}</div>
      <div data-testid="navigation-previous-count">{navigation?.previousPageCount ?? "pending"}</div>
      <button
        type="button"
        data-testid="navigation-previous"
        disabled={!navigation?.canPrevious}
        onClick={() => navigation?.onPrevious()}
      >
        Previous
      </button>
      <button
        type="button"
        data-testid="navigation-next"
        disabled={!navigation?.canNext}
        onClick={() => navigation?.onNext()}
      >
        Next
      </button>
    </div>
  );
}

function renderProbe(targets: readonly AgentRunTranscriptTarget[], existingQueryClient?: QueryClient) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const queryClient = existingQueryClient ?? new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ReaderProbe targets={targets} />
      </QueryClientProvider>,
    );
  });
  const rerender = (nextTargets: readonly AgentRunTranscriptTarget[]) => act(() => {
    root.render(<QueryClientProvider client={queryClient}><ReaderProbe targets={nextTargets} /></QueryClientProvider>);
  });
  return { host, root, queryClient, rerender };
}

function renderNavigationProbe(runId: string, raw = false, active = false) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <NavigationProbe runId={runId} raw={raw} active={active} />
      </QueryClientProvider>,
    );
  });
  const rerender = (nextActive: boolean) => act(() => {
    root.render(<QueryClientProvider client={queryClient}>
      <NavigationProbe runId={runId} raw={raw} active={nextActive} />
    </QueryClientProvider>);
  });
  return { host, root, queryClient, rerender };
}

function transitionPage(text: string, revision = text, cursor: string | null = null, nextCursor: string | null = null) {
  return {
    entries: [{ id: text, entry: { kind: "assistant", ts: "2026-10-02T00:00:00.000Z", text } }],
    source: "native", revision, availability: "available", completeness: nextCursor ? "partial" : "complete",
    page: { cursor, hasMore: Boolean(nextCursor), nextCursor, order: "oldest" },
  };
}

beforeEach(() => {
  transcriptMock.mockReset();
  legacyTranscriptMock.mockReset();
  legacyTranscriptMock.mockResolvedValue({
    transcript: [{ kind: "assistant", ts: "2026-09-22T00:00:00.000Z", text: "Legacy output" }],
  });
  transcriptMock.mockImplementation(async (runId: string) => ({
    entries: runId === "run-empty"
      ? []
      : [{ id: "entry-1", entry: { kind: "assistant", ts: "2026-09-22T00:00:00.000Z", text: "Reader output" } }],
    source: "native",
    revision: "revision-1",
    availability: "available",
    completeness: "complete",
    page: { cursor: null, hasMore: false, nextCursor: null, order: "oldest" },
  }));
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("useAgentRunTranscripts", () => {
  it("reads final native history exactly once when an active target becomes terminal", async () => {
    transcriptMock.mockResolvedValueOnce({
      entries: [], source: "native", revision: "pending-r1", availability: "pending", completeness: "unknown",
      page: { cursor: null, hasMore: false, nextCursor: null, order: "oldest" },
    });
    const rendered = renderProbe([{ runId: "run-native", active: true }]);
    try {
      await act(async () => { await vi.waitFor(() => expect(transcriptMock).toHaveBeenCalledTimes(1)); });
      await act(async () => { await vi.waitFor(() => expect(rendered.queryClient.isFetching()).toBe(0)); });
      rendered.rerender([{ runId: "run-native", active: false }]);
      await act(async () => { await vi.waitFor(() => expect(rendered.host.textContent).toContain("Reader output")); });
      rendered.rerender([{ runId: "run-native", active: false }]);
      await act(async () => { await Promise.resolve(); });
      expect(transcriptMock).toHaveBeenCalledTimes(2);
    } finally { act(() => rendered.root.unmount()); rendered.queryClient.clear(); }
  });

  it("does not add a final fetch or polling for an initially terminal target", async () => {
    const rendered = renderProbe([{ runId: "run-native", active: false }]);
    try {
      await act(async () => { await vi.waitFor(() => expect(rendered.host.textContent).toContain("Reader output")); });
      vi.useFakeTimers();
      rendered.rerender([{ runId: "run-native", active: false }]);
      await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
      expect(transcriptMock).toHaveBeenCalledTimes(1);
    } finally { act(() => rendered.root.unmount()); rendered.queryClient.clear(); }
  });

  it("refreshes only the transitioned Run among multiple targets and does not loop", async () => {
    vi.useFakeTimers();
    const stillActive = { runId: "run-still-active", active: true };
    const rendered = renderProbe([{ runId: "run-native", active: true }, { runId: "run-empty", active: false }, stillActive]);
    try {
      await act(async () => { await vi.waitFor(() => expect(rendered.host.textContent).toContain("Reader output|empty-loaded")); });
      rendered.rerender([stillActive, { runId: "run-empty", active: false }, { runId: "run-native", active: false }]);
      await act(async () => { await vi.waitFor(() => expect(transcriptMock).toHaveBeenCalledTimes(4)); });
      await act(async () => { await vi.waitFor(() => expect(rendered.queryClient.isFetching()).toBe(0)); });
      rendered.rerender([{ runId: "run-native", active: false }, stillActive, { runId: "run-empty", active: false }]);
      await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
      expect(transcriptMock.mock.calls.filter(([id]) => id === "run-native")).toHaveLength(2);
      expect(transcriptMock.mock.calls.filter(([id]) => id === "run-empty")).toHaveLength(1);
      expect(transcriptMock.mock.calls.filter(([id]) => id === "run-still-active").length).toBeGreaterThan(1);
    } finally { act(() => rendered.root.unmount()); rendered.queryClient.clear(); }
  });

  it("aborts an in-flight live read and ignores its late result after terminal publication", async () => {
    let finishLive!: (page: ReturnType<typeof transitionPage>) => void;
    let liveSignal!: AbortSignal;
    transcriptMock.mockImplementationOnce((_id, _request, { signal }) => {
      liveSignal = signal;
      return new Promise((resolve) => { finishLive = resolve; });
    }).mockResolvedValueOnce(transitionPage("final-history"));
    const rendered = renderProbe([{ runId: "run-native", active: true }]);
    try {
      await act(async () => { await vi.waitFor(() => expect(transcriptMock).toHaveBeenCalledTimes(1)); });
      rendered.rerender([{ runId: "run-native", active: false }]);
      await act(async () => { await vi.waitFor(() => expect(rendered.host.textContent).toContain("final-history")); });
      expect(liveSignal.aborted).toBe(true);
      await act(async () => { finishLive(transitionPage("stale-live")); await Promise.resolve(); });
      expect(rendered.host.textContent).toContain("final-history");
      expect(rendered.host.textContent).not.toContain("stale-live");
      expect(transcriptMock).toHaveBeenCalledTimes(2);
    } finally { act(() => rendered.root.unmount()); rendered.queryClient.clear(); }
  });

  it("restarts terminal reading at page one rather than reusing a live pagination cursor", async () => {
    let terminal = false;
    transcriptMock.mockImplementation(async (_id, { cursor }) => terminal
      ? transitionPage("terminal-first", "terminal-r2")
      : cursor ? transitionPage("live-second", "live-r1", cursor)
        : transitionPage("live-first", "live-r1", null, "live-next"));
    const rendered = renderNavigationProbe("run-native", true, true);
    try {
      await act(async () => { await vi.waitFor(() => expect(rendered.host.textContent).toContain("live-first")); });
      act(() => rendered.host.querySelector<HTMLButtonElement>("[data-testid='navigation-next']")?.click());
      await act(async () => { await vi.waitFor(() => expect(rendered.host.textContent).toContain("live-second")); });
      terminal = true;
      rendered.rerender(false);
      await act(async () => { await vi.waitFor(() => expect(rendered.host.textContent).toContain("terminal-first")); });
      expect(transcriptMock).toHaveBeenCalledTimes(3);
      expect(transcriptMock.mock.calls[2][1].cursor).toBeNull();
      expect(rendered.host.querySelector("[data-testid='navigation-page']")?.textContent).toBe("1");
      expect(rendered.host.querySelector<HTMLButtonElement>("[data-testid='navigation-previous']")?.disabled).toBe(true);
    } finally { act(() => rendered.root.unmount()); rendered.queryClient.clear(); }
  });

  it("does not cancel a live query still needed by another mounted consumer", async () => {
    let finishLive!: (page: ReturnType<typeof transitionPage>) => void;
    let signal!: AbortSignal;
    transcriptMock.mockImplementationOnce((_id, _request, options) => {
      signal = options.signal;
      return new Promise((resolve) => { finishLive = resolve; });
    }).mockResolvedValueOnce(transitionPage("final-history"));
    const terminalConsumer = renderProbe([{ runId: "run-native", active: true }]);
    const liveConsumer = renderProbe([{ runId: "run-native", active: true }], terminalConsumer.queryClient);
    try {
      await act(async () => { await vi.waitFor(() => expect(terminalConsumer.queryClient.isFetching()).toBe(1)); });
      terminalConsumer.rerender([{ runId: "run-native", active: false }]);
      await act(async () => { await vi.waitFor(() => expect(terminalConsumer.host.textContent).toContain("final-history")); });
      expect(signal.aborted).toBe(false);
      await act(async () => { finishLive(transitionPage("live-history")); await Promise.resolve(); });
      expect(terminalConsumer.host.textContent).toContain("final-history");
      expect(transcriptMock).toHaveBeenCalledTimes(2);
    } finally {
      act(() => { terminalConsumer.root.unmount(); liveConsumer.root.unmount(); });
      terminalConsumer.queryClient.clear(); liveConsumer.queryClient.clear();
    }
  });

  it("forgets removed active targets instead of scheduling a terminal refresh on re-add", async () => {
    const rendered = renderProbe([{ runId: "run-native", active: true }]);
    try {
      await act(async () => { await vi.waitFor(() => expect(rendered.host.textContent).toContain("Reader output")); });
      rendered.rerender([]);
      rendered.rerender([{ runId: "run-native", active: false }]);
      await act(async () => { await vi.waitFor(() => expect(rendered.queryClient.isFetching()).toBe(0)); });
      expect(rendered.queryClient.getQueryCache().getAll().map((query) => query.queryKey[3])).toEqual([0]);
      expect(transcriptMock.mock.calls.length).toBeLessThanOrEqual(2); // Normal stale-on-mount read is allowed.
    } finally { act(() => rendered.root.unmount()); rendered.queryClient.clear(); }
  });

  it("presents Hermes tool-only native rows to Chat consumers while Raw retains the original row", async () => {
    const nativePage = {
      entries: [{ id: "tool-only", entry: { kind: "assistant", role: "assistant", rowId: 2,
        sessionId: "hermes-session", ts: "2026-10-02T03:11:56.000Z",
        toolCalls: [{ id: "call", function: { name: "tool_describe", arguments: "{}" } }] } },
      { id: "final", entry: { kind: "assistant", role: "assistant", rowId: 3,
        sessionId: "hermes-session", ts: "2026-10-02T03:11:57.000Z", text: "Hermes completed" } }],
      source: "native", revision: "hermes-revision", availability: "available", completeness: "complete",
      page: { cursor: null, hasMore: false, nextCursor: null, order: "oldest" },
    };
    transcriptMock.mockResolvedValue(nativePage);
    const presentation = renderNavigationProbe("hermes");
    const raw = renderNavigationProbe("hermes", true);
    await act(async () => {
      await vi.waitFor(() => {
        expect(presentation.host.querySelector("[data-testid='navigation-entries']")?.textContent)
          .toBe("tool_call|Hermes completed");
        expect(raw.host.querySelector("[data-testid='navigation-entries']")?.textContent)
          .toBe("assistant|Hermes completed");
      });
    });
    expect(nativePage.entries[0]?.entry).not.toHaveProperty("text");
    act(() => { presentation.root.unmount(); raw.root.unmount(); });
  });

  it.each(["queued", "running", "starting", "streaming", "tool_busy", "finalizing", "stopping", "stop_requested", "closing"])(
    "keeps %s message states polling the Reader",
    (status) => {
      expect(isAgentRunTranscriptActiveStatus(status)).toBe(true);
    },
  );

  it.each(["completed", "stopped", "failed", "waiting_for_network", null, undefined])(
    "does not poll the Reader for terminal or paused state %s",
    (status) => {
      expect(isAgentRunTranscriptActiveStatus(status)).toBe(false);
    },
  );

  it("deduplicates Run IDs, reads through the unified Reader, and preserves empty results", async () => {
    const targets = [
      { runId: "run-native", active: true },
      { runId: "run-native", active: false },
      { runId: "run-empty", active: false },
    ] as const;
    const rendered = renderProbe(targets);

    await act(async () => {
      await vi.waitFor(() => expect(rendered.host.textContent).toContain("Reader output|empty-loaded"));
    });
    expect(transcriptMock).toHaveBeenCalledTimes(2);
    expect(transcriptMock).toHaveBeenCalledWith("run-native", {
      cursor: null,
      includeOutput: false,
      turnLimit: 50,
      maxChars: 4_000,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(transcriptMock).toHaveBeenCalledWith("run-empty", {
      cursor: null,
      includeOutput: false,
      turnLimit: 50,
      maxChars: 4_000,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));

    act(() => rendered.root.unmount());
  });

  it("reads one bounded page and preserves every entry, including long Unicode content", async () => {
    const longUnicodeText = `开端 ${"🌊".repeat(2_000)} 结尾`;
    const entries = Array.from({ length: 52 }, (_, index) => ({
      id: `entry-${index}`,
      entry: {
        kind: "assistant" as const,
        ts: `2026-09-22T00:00:${String(index).padStart(2, "0")}.000Z`,
        text: index === 51 ? longUnicodeText : `entry-${index}`,
      },
    }));
    transcriptMock.mockResolvedValueOnce({
      entries,
      source: "native",
      revision: "revision-long",
      availability: "available",
      completeness: "partial",
      page: { cursor: null, hasMore: true, nextCursor: "cursor-1", order: "oldest" },
    });
    const rendered = renderNavigationProbe("run-long");
    await act(async () => {
      await vi.waitFor(() => expect(rendered.host.querySelector("[data-testid='navigation-entries']")?.textContent).toContain(longUnicodeText));
    });

    expect(transcriptMock).toHaveBeenCalledTimes(1);
    expect(transcriptMock).toHaveBeenCalledWith("run-long", {
      cursor: null,
      includeOutput: false,
      turnLimit: 50,
      maxChars: 4_000,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(rendered.host.querySelector("[data-testid='navigation-entries']")?.textContent)
      .toContain("entry-0|entry-1");
    expect(rendered.host.querySelector("[data-testid='navigation-next']"))
      ?.not.toHaveProperty("disabled", true);

    act(() => rendered.root.unmount());
  });

  it("moves between bounded pages without appending old page entries", async () => {
    transcriptMock.mockImplementation(async (_runId: string, request: { cursor?: string | null }) => request.cursor === "cursor-1"
      ? {
        entries: [{ id: "entry-2", entry: { kind: "assistant", ts: "2026-09-22T00:00:02.000Z", text: "page-two" } }],
        source: "native",
        revision: "revision-pages",
        availability: "available",
        completeness: "complete",
        page: { cursor: "cursor-1", hasMore: false, nextCursor: null, order: "oldest" },
      }
      : {
        entries: [{ id: "entry-1", entry: { kind: "assistant", ts: "2026-09-22T00:00:01.000Z", text: "page-one" } }],
        source: "native",
        revision: "revision-pages",
        availability: "available",
        completeness: "partial",
        page: { cursor: null, hasMore: true, nextCursor: "cursor-1", order: "oldest" },
      });
    const rendered = renderNavigationProbe("run-pages");
    await act(async () => {
      await vi.waitFor(() => expect(rendered.host.textContent).toContain("page-one"));
    });
    const next = rendered.host.querySelector<HTMLButtonElement>("[data-testid='navigation-next']");
    expect(next?.disabled).toBe(false);

    act(() => next?.click());
    await act(async () => {
      await vi.waitFor(() => expect(rendered.host.textContent).toContain("page-two"));
    });
    expect(rendered.host.querySelector("[data-testid='navigation-entries']")?.textContent).toBe("page-two");
    expect(rendered.host.querySelector<HTMLButtonElement>("[data-testid='navigation-previous']")?.disabled).toBe(false);
    expect(transcriptMock).toHaveBeenLastCalledWith("run-pages", {
      cursor: "cursor-1",
      includeOutput: false,
      turnLimit: 50,
      maxChars: 4_000,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));

    act(() => rendered.host.querySelector<HTMLButtonElement>("[data-testid='navigation-previous']")?.click());
    await act(async () => {
      await vi.waitFor(() => expect(rendered.host.querySelector("[data-testid='navigation-entries']")?.textContent).toBe("page-one"));
    });
    expect(transcriptMock).toHaveBeenLastCalledWith("run-pages", {
      cursor: null,
      includeOutput: false,
      turnLimit: 50,
      maxChars: 4_000,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));

    act(() => rendered.root.unmount());
  });

  it("exposes unavailable partial pages without inventing entries", async () => {
    transcriptMock.mockResolvedValueOnce({
      entries: [],
      source: "native",
      revision: "revision-offline",
      availability: "offline",
      completeness: "unknown",
      page: { cursor: null, hasMore: true, nextCursor: "offline-next", order: "oldest" },
    });
    const rendered = renderNavigationProbe("run-offline");
    await act(async () => {
      await vi.waitFor(() => expect(rendered.host.querySelector("[data-testid='navigation-state']")?.textContent).toContain("offline|unknown|loaded"));
    });
    expect(rendered.host.querySelector("[data-testid='navigation-entries']")?.textContent).toBe("");
    expect(rendered.host.querySelector("[data-testid='navigation-state']")?.textContent)
      .toBe("offline|unknown|loaded");

    act(() => rendered.root.unmount());
  });

  it("resets to the first page when a later page reports a new revision", async () => {
    let firstPageRead = 0;
    transcriptMock.mockImplementation(async (_runId: string, request: { cursor?: string | null }) => {
      if (request.cursor === "cursor-1") {
        return {
          entries: [{ id: "entry-new-page", entry: { kind: "assistant", ts: "2026-09-22T00:00:02.000Z", text: "stale-revision-page" } }],
          source: "native",
          revision: "revision-2",
          availability: "available",
          completeness: "complete",
          page: { cursor: "cursor-1", hasMore: false, nextCursor: null, order: "oldest" },
        };
      }
      firstPageRead += 1;
      return {
        entries: [{ id: `entry-first-${firstPageRead}`, entry: { kind: "assistant", ts: "2026-09-22T00:00:01.000Z", text: firstPageRead === 1 ? "revision-one" : "revision-two-first-page" } }],
        source: "native",
        revision: firstPageRead === 1 ? "revision-1" : "revision-2",
        availability: "available",
        completeness: firstPageRead === 1 ? "partial" : "complete",
        page: { cursor: null, hasMore: firstPageRead === 1, nextCursor: firstPageRead === 1 ? "cursor-1" : null, order: "oldest" },
      };
    });
    const rendered = renderNavigationProbe("run-revision");
    await act(async () => {
      await vi.waitFor(() => expect(rendered.host.textContent).toContain("revision-one"));
    });
    act(() => rendered.host.querySelector<HTMLButtonElement>("[data-testid='navigation-next']")?.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => {
      await vi.waitFor(() => expect(rendered.host.querySelector("[data-testid='navigation-entries']")?.textContent).toBe("revision-two-first-page"));
    });

    expect(firstPageRead).toBe(2);
    expect(rendered.host.querySelector("[data-testid='navigation-entries']")?.textContent)
      .not.toContain("stale-revision-page");
    expect(transcriptMock).toHaveBeenCalledWith("run-revision", {
      cursor: null,
      includeOutput: false,
      turnLimit: 50,
      maxChars: 4_000,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));

    act(() => rendered.root.unmount());
  });

  it("never uses a linked Run message transcript as a native source", () => {
    const readerEntry = { kind: "assistant" as const, ts: "2026-09-22T00:00:00.000Z", text: "Reader output" };
    const legacyEntry = { kind: "assistant" as const, ts: "2026-09-22T00:00:01.000Z", text: "Legacy output" };
    const message = {
      id: "message-native",
      runId: "run-native",
      transcript: [legacyEntry],
    };

    expect(chatTranscriptEntriesForMessage(message, {}, new Map([["run-native", [readerEntry]]]))).toEqual([readerEntry]);
    expect(chatTranscriptEntriesForMessage(message, {}, new Map())).toEqual([]);
  });

  it("keeps the legacy transcript request behind an explicit compatibility boundary", async () => {
    await expect(readLegacyChatTranscript("chat-1", "message-legacy")).resolves.toEqual([
      expect.objectContaining({ text: "Legacy output" }),
    ]);
    expect(legacyTranscriptMock).toHaveBeenCalledWith("chat-1", "message-legacy");

    await expect(readLegacyChatTranscript("chat-1", "message-native", "run-native"))
      .rejects.toThrow("must be loaded through the Transcript Reader");
    expect(legacyTranscriptMock).toHaveBeenCalledTimes(1);
  });
});
