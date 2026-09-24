// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveAgentsPanel, filterDashboardRunPreviewTranscript } from "./ActiveAgentsPanel";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const liveRunFixture = {
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
};

const issueFixture = {
  id: "issue-1",
  identifier: "RUD-1",
  title: "Ship motion feedback",
};

const queryMocks = vi.hoisted((): {
  liveRuns: { data?: unknown; isLoading?: boolean };
  issues: { data?: unknown; isLoading?: boolean };
  agents: { data?: unknown; isLoading?: boolean };
  transcriptByRun: Map<string, unknown[]>;
} => ({
  liveRuns: { data: [], isLoading: false },
  issues: { data: [], isLoading: false },
  agents: { data: [], isLoading: false },
  transcriptByRun: new Map([["run-1", []]]),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "live-runs") {
      return queryMocks.liveRuns;
    }

    if (queryKey[0] === "issues") {
      return queryMocks.issues;
    }

    if (queryKey[0] === "agents") {
      return queryMocks.agents;
    }

    return { data: [] };
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: import("react").ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("./transcript/useAgentRunTranscripts", () => ({
  useAgentRunTranscripts: () => ({
    transcriptByRun: queryMocks.transcriptByRun,
    hasOutputForRun: () => false,
  }),
}));

vi.mock("./transcript/RunTranscriptView", () => ({
  RunTranscriptView: ({ className, entries, streaming }: { className?: string; entries?: unknown[]; streaming?: boolean }) => (
    <div
      className={className}
      data-entry-texts={JSON.stringify((entries ?? []).map((entry) => {
        if (entry && typeof entry === "object" && "text" in entry && typeof entry.text === "string") return entry.text;
        return "";
      }))}
      data-testid="run-transcript-view"
      data-streaming={streaming ? "true" : "false"}
    />
  ),
}));

let cleanupFn: (() => void) | null = null;

beforeEach(() => {
  queryMocks.liveRuns = { data: [liveRunFixture], isLoading: false };
  queryMocks.issues = { data: [issueFixture], isLoading: false };
  queryMocks.agents = { data: [], isLoading: false };
  queryMocks.transcriptByRun = new Map([["run-1", []]]);
});

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  document.body.innerHTML = "";
});

describe("ActiveAgentsPanel", () => {
  it("filters Rudder runtime diagnostics from dashboard previews", () => {
    const entries = filterDashboardRunPreviewTranscript([
      {
        kind: "assistant",
        ts: "2026-04-25T08:00:01.000Z",
        text:
          "[rudder] Using Rudder-managed Codex home \"/Users/zeeland/.rudder/instances/dev/organizations/org/codex-home/agents/agent\".\n"
          + "[rudder] Prepared isolated Git config at /Users/zeeland/.rudder/instances/dev/organizations/org/workspaces/agents/agent/.gitconfig.\n"
          + "No change.\nNEW-13 remains blocked on reviewer input.",
      },
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("assistant");
    expect("text" in entries[0]!).toBe(true);
    expect(entries[0]).toMatchObject({
      text: "No change.\nNEW-13 remains blocked on reviewer input.",
    });
  });

  it("summarizes structured Codex event streams instead of rendering raw JSON", () => {
    const entries = filterDashboardRunPreviewTranscript([
      {
        kind: "assistant",
        ts: "2026-04-25T08:00:01.000Z",
        text: [
          JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
          JSON.stringify({
            type: "item.completed",
            item: {
              id: "item-1",
              type: "agent_message",
              text: "I'll check the current inbox state.",
            },
          }),
          JSON.stringify({
            type: "item.completed",
            item: {
              id: "item-2",
              type: "command_execution",
              command: "/bin/zsh -lc 'rudder agent inbox'",
            },
          }),
        ].join("\n"),
      },
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      text: "I'll check the current inbox state.\n\nRan 1 command.",
    });
    expect((entries[0] as { text: string }).text).not.toContain("thread.started");
    expect((entries[0] as { text: string }).text).not.toContain("command_execution");
  });

  it("caps long dashboard preview text so cards remain scannable", () => {
    const entries = filterDashboardRunPreviewTranscript([
      {
        kind: "assistant",
        ts: "2026-04-25T08:00:01.000Z",
        text: "This run produced a long operator-facing update. ".repeat(20),
      },
    ]);

    expect((entries[0] as { text: string }).text.length).toBeLessThanOrEqual(263);
    expect((entries[0] as { text: string }).text.endsWith("...")).toBe(true);
  });

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
    expect(container.textContent).toContain("Live for");
    expect(container.textContent).not.toContain("Live now");

    const transcript = container.querySelector('[data-testid="run-transcript-view"]');
    expect(transcript?.getAttribute("data-streaming")).toBe("true");
    expect(transcript?.classList.contains("dashboard-run-preview")).toBe(true);
  });

  it("passes hydrated live transcript text into dashboard run previews", () => {
    queryMocks.transcriptByRun = new Map([[
      "run-1",
      [
        {
          kind: "assistant",
          ts: "2026-06-19T11:06:22.580Z",
          text: "我先看一下附件里的错误和 paperclip 仓库本地约束。",
        },
      ],
    ]]);

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

    const transcript = container.querySelector('[data-testid="run-transcript-view"]');
    expect(transcript?.getAttribute("data-entry-texts")).toContain("我先看一下附件里的错误和 paperclip 仓库本地约束。");
    expect(transcript?.getAttribute("data-entry-texts")).not.toContain("chat transcript entry");
  });

  it("shows a skeleton instead of an empty state while recent runs are loading", () => {
    queryMocks.liveRuns = { data: undefined, isLoading: true };

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

    expect(container.querySelector('[data-testid="active-agents-panel-skeleton"]')).toBeTruthy();
    expect(container.textContent).not.toContain("No recent agent runs.");
  });
});
