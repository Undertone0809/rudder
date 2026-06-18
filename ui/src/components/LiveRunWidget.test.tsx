// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveRunWidget } from "./LiveRunWidget";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
    invalidateQueries: vi.fn(),
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
});
