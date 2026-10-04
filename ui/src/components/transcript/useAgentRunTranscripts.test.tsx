// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptContinuationControls } from "./TranscriptContinuationControls";
import {
  agentRunTranscriptQueryKey,
  chatTranscriptEntriesForMessage,
  isAgentRunTranscriptActiveStatus,
  readLegacyChatTranscript,
  useAgentRunTranscripts,
  type AgentRunTranscriptTarget,
} from "./useAgentRunTranscripts";

const transcriptMock = vi.hoisted(() => vi.fn());
const legacyTranscriptMock = vi.hoisted(() => vi.fn());
const organizationContextMock = vi.hoisted(() => ({ selectedOrganizationId: null as string | null }));

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

vi.mock("@/context/OrganizationContext", () => ({
  useOptionalOrganization: () => organizationContextMock,
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
  const { transcriptByRun, transcriptStateByRun, transcriptNavigationByRun, refetchRun } = useAgentRunTranscripts([{ runId, active }], { raw });
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
      <TranscriptContinuationControls navigation={navigation} state={state} />
      <button data-testid="lazy-refetch" onClick={() => void refetchRun(runId)}>Load details</button>
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

function renderNavigationProbe(runId: string, raw = false, active = false, existingQueryClient?: QueryClient) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const queryClient = existingQueryClient ?? new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <NavigationProbe runId={runId} raw={raw} active={active} />
      </QueryClientProvider>,
    );
  });
  const rerender = (nextActive: boolean, nextRunId = runId, nextRaw = raw) => act(() => {
    root.render(<QueryClientProvider client={queryClient}>
      <NavigationProbe runId={nextRunId} raw={nextRaw} active={nextActive} />
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
  organizationContextMock.selectedOrganizationId = null;
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
  it("manual refresh always reads once with production staleTime across shared consumers and remount", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    let reads = 0;
    transcriptMock.mockImplementation(async id => id === "run-empty"
      ? transitionPage("other-run") : transitionPage(`fresh-${++reads}`));
    const other = renderProbe([{ runId: "run-empty", active: false }], queryClient);
    const first = renderNavigationProbe("run-native", false, false, queryClient);
    let second = renderNavigationProbe("run-native", false, false, queryClient);
    try {
      await act(async () => { await vi.waitFor(() => expect(first.host.textContent).toContain("fresh-1")); });
      expect(reads).toBe(1);
      queryClient.setQueryData(
        agentRunTranscriptQueryKey("run-native", null, 1),
        queryClient.getQueryData(agentRunTranscriptQueryKey("run-native")),
      );
      act(() => first.host.querySelector<HTMLButtonElement>("[aria-label='Refresh transcript']")?.click());
      await act(async () => { await vi.waitFor(() => expect(first.host.textContent).toContain("fresh-2")); });
      // A second hook's local generation 1 must not consume the first hook's
      // still-fresh generation 1 page instead of performing the user's read.
      act(() => second.host.querySelector<HTMLButtonElement>("[aria-label='Refresh transcript']")?.click());
      await act(async () => { await vi.waitFor(() => expect(reads).toBe(3)); });
      await act(async () => { await vi.waitFor(() => expect(second.host.textContent).toContain("fresh-3")); });
      expect(first.host.textContent).toContain("fresh-2");
      act(() => second.root.unmount());
      second = renderNavigationProbe("run-native", false, false, queryClient);
      await act(async () => { await vi.waitFor(() => expect(second.host.textContent).toContain("fresh-1")); });
      act(() => second.host.querySelector<HTMLButtonElement>("[aria-label='Refresh transcript']")?.click());
      await act(async () => { await vi.waitFor(() => expect(reads).toBe(4)); });
      await act(async () => { await vi.waitFor(() => expect(second.host.textContent).toContain("fresh-4")); });
      expect(transcriptMock.mock.calls.filter(([id]) => id === "run-empty")).toHaveLength(1);
      expect(transcriptMock.mock.calls.filter(([id]) => id === "run-native").every(([, request]) => request.cursor === null)).toBe(true);
    } finally { act(() => { first.root.unmount(); second.root.unmount(); other.root.unmount(); }); queryClient.clear(); }
  });

  it("manual refresh never joins another consumer's old generation in-flight request", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    let finishOld!: (page: ReturnType<typeof transitionPage>) => void;
    let oldSignal!: AbortSignal;
    let firstPageReads = 0;
    transcriptMock.mockImplementation(async (_id, { cursor }, { signal }) => {
      if (cursor) return transitionPage("old-second", "old-r", cursor);
      if (++firstPageReads === 1) return transitionPage("old-first", "old-r", null, "old-next");
      if (firstPageReads === 2) {
        oldSignal = signal;
        return new Promise(resolve => { finishOld = resolve; });
      }
      return transitionPage("fresh-reset", "new-r");
    });
    const first = renderNavigationProbe("run-native", false, false, queryClient);
    const second = renderNavigationProbe("run-native", false, false, queryClient);
    try {
      await act(async () => { await vi.waitFor(() => expect(second.host.textContent).toContain("old-first")); });
      act(() => first.host.querySelector<HTMLButtonElement>("[aria-label='Refresh transcript']")?.click());
      await act(async () => { await vi.waitFor(() => expect(firstPageReads).toBe(2)); });
      act(() => second.host.querySelector<HTMLButtonElement>("[data-testid='navigation-next']")?.click());
      await act(async () => { await vi.waitFor(() => expect(second.host.textContent).toContain("old-second")); });
      act(() => second.host.querySelector<HTMLButtonElement>("[aria-label='Refresh transcript']")?.click());
      await act(async () => { await vi.waitFor(() => expect(firstPageReads).toBe(3)); });
      await act(async () => { await vi.waitFor(() => expect(second.host.textContent).toContain("fresh-reset")); });
      expect(second.host.querySelector("[data-testid='navigation-page']")?.textContent).toBe("1");
      expect(second.host.querySelector("[data-testid='navigation-previous-count']")?.textContent).toBe("0");
      expect(oldSignal.aborted).toBe(false);
      await act(async () => { finishOld(transitionPage("late-first-consumer", "old-r")); });
      await act(async () => { await vi.waitFor(() => expect(first.host.textContent).toContain("late-first-consumer")); });
      expect(second.host.textContent).toContain("fresh-reset");
      expect(second.host.textContent).not.toContain("late-first-consumer");
      expect(second.host.textContent).not.toContain("old-second");
      expect(firstPageReads).toBe(3);
      expect(transcriptMock).toHaveBeenCalledTimes(4);
    } finally { act(() => { first.root.unmount(); second.root.unmount(); }); queryClient.clear(); }
  });

  it("explicit refresh replaces a deep page with one fresh first page and leaves lazy refetch scoped", async () => {
    let firstPages = 0;
    transcriptMock.mockImplementation(async (_id, { cursor }) => cursor
      ? transitionPage(`old-${cursor}`, "old-r", cursor, cursor === "page-10" ? null : `page-${Number(cursor.slice(5)) + 1}`)
      : transitionPage(++firstPages === 1 ? "old-first" : "fresh-first", firstPages === 1 ? "old-r" : "fresh-r", null, firstPages === 1 ? "page-1" : null));
    const rendered = renderNavigationProbe("run-native");
    try {
      await act(async () => { await vi.waitFor(() => expect(rendered.host.textContent).toContain("old-first")); });
      for (let page = 1; page <= 10; page += 1) {
        act(() => rendered.host.querySelector<HTMLButtonElement>("[data-testid='navigation-next']")?.click());
        await act(async () => { await vi.waitFor(() => expect(rendered.host.querySelector("[data-testid='navigation-entries']")?.textContent).toBe(`old-page-${page}`)); });
      }
      act(() => rendered.host.querySelector<HTMLButtonElement>("[data-testid='lazy-refetch']")?.click());
      await act(async () => { await vi.waitFor(() => expect(transcriptMock).toHaveBeenCalledTimes(12)); });
      expect(transcriptMock.mock.calls[11][1].cursor).toBe("page-10");
      const refresh = rendered.host.querySelector<HTMLButtonElement>("[aria-label='Refresh transcript']");
      expect(refresh).not.toBeNull();
      act(() => refresh?.click());
      await act(async () => { await vi.waitFor(() => expect(rendered.host.querySelector("[data-testid='navigation-entries']")?.textContent).toBe("fresh-first")); });
      expect(transcriptMock).toHaveBeenCalledTimes(13);
      expect(transcriptMock.mock.calls[12][1].cursor).toBeNull();
      expect(rendered.host.querySelector("[data-testid='navigation-page']")?.textContent).toBe("1");
      expect(rendered.host.querySelector("[data-testid='navigation-previous-count']")?.textContent).toBe("0");
      expect(rendered.host.textContent).not.toContain("Earlier pages");
      expect(rendered.host.textContent).not.toContain("old-page");
    } finally { act(() => rendered.root.unmount()); rendered.queryClient.clear(); }
  });

  it("keeps the last partial page and its completeness visible when Refresh fails", async () => {
    let reads = 0;
    transcriptMock.mockImplementation(async () => {
      if (++reads === 1) return transitionPage("retained partial history", "partial-r1", null, "next-page");
      throw new Error("503 Service Unavailable");
    });
    const rendered = renderNavigationProbe("run-refresh-failure");
    try {
      await act(async () => {
        await vi.waitFor(() => expect(rendered.host.querySelector("[data-testid='navigation-entries']")?.textContent)
          .toBe("retained partial history"));
      });
      act(() => rendered.host.querySelector<HTMLButtonElement>("[aria-label='Refresh transcript']")?.click());
      await act(async () => {
        await vi.waitFor(() => expect(rendered.host.querySelector("[role='alert']")?.textContent)
          .toContain("Transcript unavailable: 503 Service Unavailable"));
      });
      expect(rendered.host.querySelector("[data-testid='navigation-entries']")?.textContent)
        .toBe("retained partial history");
      expect(rendered.host.querySelector("[data-testid='navigation-state']")?.textContent)
        .toBe("available|partial|loaded");
      await act(async () => {
        await vi.waitFor(() => expect(rendered.host.querySelector<HTMLButtonElement>("[aria-label='Refresh transcript']")?.disabled)
          .toBe(false));
      });
      expect(reads).toBe(2);
    } finally { act(() => rendered.root.unmount()); rendered.queryClient.clear(); }
  });

  it("replaces retained entries after a failed Refresh recovers successfully", async () => {
    let reads = 0;
    transcriptMock.mockImplementation(async () => {
      if (++reads === 1) return transitionPage("stale retained history", "old-r", null, "old-next");
      if (reads === 2) throw new Error("503 Service Unavailable");
      return transitionPage("recovered replacement history", "new-r");
    });
    const rendered = renderNavigationProbe("run-refresh-recovery");
    try {
      await act(async () => {
        await vi.waitFor(() => expect(rendered.host.querySelector("[data-testid='navigation-entries']")?.textContent)
          .toBe("stale retained history"));
      });
      act(() => rendered.host.querySelector<HTMLButtonElement>("[aria-label='Refresh transcript']")?.click());
      await act(async () => {
        await vi.waitFor(() => expect(rendered.host.querySelector("[role='alert']")?.textContent)
          .toContain("Transcript unavailable: 503 Service Unavailable"));
      });
      expect(rendered.host.querySelector("[data-testid='navigation-entries']")?.textContent)
        .toBe("stale retained history");
      await act(async () => {
        await vi.waitFor(() => expect(rendered.host.querySelector<HTMLButtonElement>("[aria-label='Refresh transcript']")?.disabled)
          .toBe(false));
      });

      act(() => rendered.host.querySelector<HTMLButtonElement>("[aria-label='Refresh transcript']")?.click());
      await act(async () => {
        await vi.waitFor(() => expect(rendered.host.querySelector("[data-testid='navigation-entries']")?.textContent)
          .toBe("recovered replacement history"));
      });
      expect(rendered.host.textContent).not.toContain("stale retained history");
      expect(rendered.host.querySelector("[data-testid='navigation-state']")?.textContent)
        .toBe("available|complete|loaded");
      expect(rendered.host.querySelector("[role='alert']")).toBeNull();
      expect(reads).toBe(3);
    } finally { act(() => rendered.root.unmount()); rendered.queryClient.clear(); }
  });

  it("does not reuse retained pages across organization, Run, or Raw view changes", async () => {
    organizationContextMock.selectedOrganizationId = "org-a";
    const toolOnlyPage = {
      entries: [{ id: "tool-only", entry: { kind: "assistant", role: "assistant", rowId: 2,
        sessionId: "scope-session", ts: "2026-10-02T03:11:56.000Z",
        toolCalls: [{ id: "call", function: { name: "tool_describe", arguments: "{}" } }] } }],
      source: "native", revision: "scope-r1", availability: "available", completeness: "partial",
      page: { cursor: null, hasMore: true, nextCursor: "scope-next", order: "oldest" },
    };
    let reads = 0;
    transcriptMock.mockImplementation(async () => {
      if (++reads === 1) return toolOnlyPage;
      throw new Error("503 Service Unavailable");
    });
    const rendered = renderNavigationProbe("run-scoped", false);
    try {
      await act(async () => {
        await vi.waitFor(() => expect(rendered.host.querySelector("[data-testid='navigation-entries']")?.textContent)
          .toBe("tool_call"));
      });
      act(() => rendered.host.querySelector<HTMLButtonElement>("[aria-label='Refresh transcript']")?.click());
      await act(async () => {
        await vi.waitFor(() => expect(rendered.host.querySelector("[role='alert']")?.textContent)
          .toContain("Transcript unavailable: 503 Service Unavailable"));
      });
      expect(rendered.host.querySelector("[data-testid='navigation-entries']")?.textContent).toBe("tool_call");
      await act(async () => {
        await vi.waitFor(() => expect(rendered.host.querySelector<HTMLButtonElement>("[aria-label='Refresh transcript']")?.disabled)
          .toBe(false));
      });

      rendered.rerender(false, "run-scoped", true);
      expect(rendered.host.querySelector("[data-testid='navigation-entries']")?.textContent).toBe("");
      act(() => rendered.host.querySelector<HTMLButtonElement>("[aria-label='Refresh transcript']")?.click());
      await act(async () => {
        await vi.waitFor(() => expect(reads).toBe(3));
        await vi.waitFor(() => expect(rendered.host.querySelector("[role='alert']")?.textContent)
          .toContain("Transcript unavailable: 503 Service Unavailable"));
      });
      expect(rendered.host.querySelector("[data-testid='navigation-entries']")?.textContent).toBe("");

      organizationContextMock.selectedOrganizationId = "org-b";
      rendered.rerender(false, "run-scoped", true);
      await act(async () => {
        await vi.waitFor(() => expect(reads).toBe(4));
        await vi.waitFor(() => expect(rendered.host.querySelector("[role='alert']")?.textContent)
          .toContain("Transcript unavailable: 503 Service Unavailable"));
      });
      expect(rendered.host.querySelector("[data-testid='navigation-entries']")?.textContent).toBe("");

      rendered.rerender(false, "run-changed", true);
      await act(async () => {
        await vi.waitFor(() => expect(reads).toBe(5));
        await vi.waitFor(() => expect(rendered.host.querySelector("[role='alert']")?.textContent)
          .toContain("Transcript unavailable: 503 Service Unavailable"));
      });
      expect(rendered.host.querySelector("[data-testid='navigation-entries']")?.textContent).toBe("");
      expect(rendered.host.textContent).not.toContain("tool_call");
      expect(agentRunTranscriptQueryKey("same-run", null, 0, null, "org-a"))
        .not.toEqual(agentRunTranscriptQueryKey("same-run", null, 0, null, "org-b"));
    } finally {
      act(() => rendered.root.unmount());
      rendered.queryClient.clear();
      organizationContextMock.selectedOrganizationId = null;
    }
  });

  it("manual reset isolates an in-flight old page and does not refresh another Run", async () => {
    let finishOld!: (page: ReturnType<typeof transitionPage>) => void;
    let oldSignal!: AbortSignal;
    let targetReads = 0;
    transcriptMock.mockImplementation(async (id, _request, { signal }) => {
      if (id === "run-empty") return transitionPage("other-run");
      if (++targetReads > 1) return transitionPage("manual-first");
      oldSignal = signal;
      return new Promise(resolve => { finishOld = resolve; });
    });
    const other = renderProbe([{ runId: "run-empty", active: false }]);
    const rendered = renderNavigationProbe("run-native", false, false, other.queryClient);
    try {
      await act(async () => { await vi.waitFor(() => expect(transcriptMock).toHaveBeenCalledTimes(2)); });
      const refresh = rendered.host.querySelector<HTMLButtonElement>("[aria-label='Refresh transcript']");
      expect(refresh).not.toBeNull();
      act(() => { refresh?.click(); refresh?.click(); });
      expect(rendered.host.querySelector<HTMLButtonElement>("[aria-label='Refresh transcript']")?.disabled).toBe(true);
      await act(async () => { await vi.waitFor(() => expect(rendered.host.textContent).toContain("manual-first")); });
      expect(oldSignal.aborted).toBe(true);
      await act(async () => { finishOld(transitionPage("late-old")); await Promise.resolve(); });
      expect(rendered.host.textContent).not.toContain("late-old");
      expect(transcriptMock.mock.calls.filter(([id]) => id === "run-empty")).toHaveLength(1);
      expect(transcriptMock.mock.calls.filter(([id]) => id === "run-native")).toHaveLength(2);
    } finally { act(() => { rendered.root.unmount(); other.root.unmount(); }); rendered.queryClient.clear(); other.queryClient.clear(); }
  });

  it.each(["offline", "scope error"])("does not automatically retry %s before or after an explicit reset", async (failure) => {
    vi.useFakeTimers();
    transcriptMock.mockImplementation(async () => {
      if (failure === "scope error") throw new Error("Transcript cursor does not belong to this scope");
      return { ...transitionPage(""), entries: [], availability: "offline", completeness: "unknown" };
    });
    const rendered = renderNavigationProbe("run-native");
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
      expect(transcriptMock).toHaveBeenCalledTimes(1);
      const refresh = rendered.host.querySelector<HTMLButtonElement>("[aria-label='Refresh transcript']");
      expect(refresh).not.toBeNull();
      act(() => refresh?.click());
      await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
      expect(transcriptMock).toHaveBeenCalledTimes(2);
      expect(transcriptMock.mock.calls[1][1].cursor).toBeNull();
    } finally { act(() => rendered.root.unmount()); rendered.queryClient.clear(); vi.useRealTimers(); }
  });

  it("manual reset does not cancel an old read still observed by another consumer", async () => {
    let finishOld!: (page: ReturnType<typeof transitionPage>) => void;
    let oldSignal!: AbortSignal;
    transcriptMock.mockImplementationOnce((_id, _request, { signal }) => {
      oldSignal = signal;
      return new Promise(resolve => { finishOld = resolve; });
    }).mockResolvedValueOnce(transitionPage("fresh-manual"));
    const observer = renderProbe([{ runId: "run-native", active: false }]);
    const rendered = renderNavigationProbe("run-native", false, false, observer.queryClient);
    try {
      await act(async () => { await vi.waitFor(() => expect(transcriptMock).toHaveBeenCalledTimes(1)); });
      act(() => rendered.host.querySelector<HTMLButtonElement>("[aria-label='Refresh transcript']")?.click());
      await act(async () => { await vi.waitFor(() => expect(rendered.host.textContent).toContain("fresh-manual")); });
      expect(oldSignal.aborted).toBe(false);
      await act(async () => { finishOld(transitionPage("old-observer-page")); await Promise.resolve(); });
      await act(async () => { await vi.waitFor(() => expect(observer.host.textContent).toContain("old-observer-page")); });
      expect(rendered.host.textContent).toContain("fresh-manual");
      expect(rendered.host.textContent).not.toContain("old-observer-page");
      expect(transcriptMock).toHaveBeenCalledTimes(2);
    } finally { act(() => { rendered.root.unmount(); observer.root.unmount(); }); observer.queryClient.clear(); }
  });
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
