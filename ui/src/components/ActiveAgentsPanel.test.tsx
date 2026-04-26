// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveAgentsPanel } from "./ActiveAgentsPanel";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "live-runs") {
      return {
        data: [
          {
            id: "run-1",
            status: "running",
            invocationSource: "manual",
            triggerDetail: null,
            startedAt: "2026-04-25T08:00:00.000Z",
            finishedAt: null,
            createdAt: "2026-04-25T08:00:00.000Z",
            agentId: "agent-1",
            agentName: "Ada",
            agentRuntimeType: "process",
            issueId: "issue-1",
          },
        ],
      };
    }

    if (queryKey[0] === "issues") {
      return {
        data: [
          {
            id: "issue-1",
            identifier: "RUD-1",
            title: "Ship motion feedback",
          },
        ],
      };
    }

    return { data: [] };
  },
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

describe("ActiveAgentsPanel", () => {
  it("renders active runs with Motion V1 live hooks", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    cleanupFn = () => {
      act(() => root.unmount());
      container.remove();
    };

    act(() => {
      root.render(<ActiveAgentsPanel orgId="org-1" />);
    });

    const liveCard = container.querySelector(".motion-live-surface");
    expect(liveCard).toBeTruthy();
    expect(liveCard?.classList.contains("motion-list-enter")).toBe(true);
    expect(liveCard?.querySelector(".motion-live-dot")).toBeTruthy();

    const transcript = container.querySelector('[data-testid="run-transcript-view"]');
    expect(transcript?.getAttribute("data-streaming")).toBe("true");
  });
});
