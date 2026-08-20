// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveRunWidget } from "./LiveRunWidget";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockState = vi.hoisted(() => ({
  cancel: vi.fn(),
  invalidateQueries: vi.fn().mockResolvedValue(undefined),
  setQueryData: vi.fn(),
  pushToast: vi.fn(),
}));

vi.mock("../api/agent-runs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/agent-runs")>();
  return {
    ...actual,
    agentRunsApi: { ...actual.agentRunsApi, cancel: mockState.cancel },
  };
});

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockState.pushToast }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "issues" && queryKey[1] === "live-runs") {
      return {
        data: [
          {
            id: "run-1",
            status: "running",
            invocationSource: "manual",
            triggerDetail: null,
            startedAt: "2026-06-17T09:00:00.000Z",
            finishedAt: null,
            createdAt: "2026-06-17T09:00:00.000Z",
            agentId: "agent-1",
            agentName: "Ada",
            agentRuntimeType: "process",
            issueId: "issue-1",
          },
        ],
      };
    }

    if (queryKey[0] === "issues" && queryKey[1] === "active-run") {
      return { data: null };
    }

    if (queryKey[0] === "agents") {
      return { data: [] };
    }

    return { data: undefined };
  },
  useQueryClient: () => ({
    invalidateQueries: mockState.invalidateQueries,
    setQueryData: mockState.setQueryData,
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: import("react").ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("./transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: () => ({
    transcriptByRun: new Map([["run-1", []]]),
    hasOutputForRun: () => false,
  }),
}));

vi.mock("./transcript/RunTranscriptView", () => ({
  RunTranscriptView: ({ streaming }: { streaming?: boolean }) => (
    <div data-testid="run-transcript-view" data-streaming={streaming ? "true" : "false"} />
  ),
}));

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  document.body.innerHTML = "";
  mockState.cancel.mockReset();
  mockState.invalidateQueries.mockClear();
  mockState.setQueryData.mockClear();
  mockState.pushToast.mockClear();
});

describe("LiveRunWidget", () => {
  it("highlights the whole live runs card while a run is active", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    cleanupFn = () => {
      act(() => root.unmount());
      container.remove();
    };

    act(() => {
      root.render(<LiveRunWidget issueId="issue-1" orgId="org-1" />);
    });

    const card = container.querySelector('[data-active-surface="live-run"]');
    expect(card).toBeTruthy();
    expect(card?.classList.contains("active-surface-ring")).toBe(true);
    expect(container.querySelector('[data-testid="run-transcript-view"]')?.getAttribute("data-streaming")).toBe("true");
  });

  it("keeps Stop pending until cancellation converges and refreshes both Issue run queries", async () => {
    let resolveCancel!: () => void;
    let resolveConvergence!: () => void;
    const convergence = new Promise<void>((resolve) => { resolveConvergence = resolve; });
    mockState.cancel.mockImplementation(() => new Promise<void>((resolve) => { resolveCancel = resolve; }));
    mockState.invalidateQueries.mockImplementation(() => convergence);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => {
      act(() => root.unmount());
      container.remove();
    };

    await act(async () => root.render(<LiveRunWidget issueId="issue-1" orgId="org-1" />));
    const stopButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Stop")!;
    await act(async () => stopButton.click());

    expect(stopButton.textContent).toContain("Stopping");
    expect(stopButton.disabled).toBe(true);

    await act(async () => resolveCancel());

    expect(mockState.setQueryData).toHaveBeenCalledTimes(2);
    expect(mockState.invalidateQueries).toHaveBeenCalledTimes(2);
    expect(stopButton.textContent).toContain("Stopping");
    expect(stopButton.disabled).toBe(true);
    expect(mockState.pushToast).not.toHaveBeenCalled();

    await act(async () => resolveConvergence());

    expect(mockState.pushToast).toHaveBeenCalledWith({ title: "Run stopped", tone: "success" });
  });

  it("restores Stop and explains a failed cancellation", async () => {
    mockState.cancel.mockRejectedValue(new Error("runtime did not acknowledge cancellation"));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => {
      act(() => root.unmount());
      container.remove();
    };

    await act(async () => root.render(<LiveRunWidget issueId="issue-1" orgId="org-1" />));
    const stopButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Stop")!;
    await act(async () => stopButton.click());

    expect(stopButton.textContent).toBe("Stop");
    expect(stopButton.disabled).toBe(false);
    expect(mockState.pushToast).toHaveBeenCalledWith({
      title: "Could not stop Run",
      body: "runtime did not acknowledge cancellation",
      tone: "error",
    });
  });
});
