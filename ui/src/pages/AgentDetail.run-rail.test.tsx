// @vitest-environment jsdom

import type { HeartbeatRun } from "@rudderhq/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidePanelProvider, useSidePanel } from "../context/SidePanelContext";
import { sidePanelTargetKey, type SidePanelTarget } from "../lib/side-panel-targets";
import {
  RunConversationListItem,
  RunListItem,
  RunRailList,
  RunsTab,
  runDebugTargetForRun,
  runFeedbackTargetForContext,
  type RunDebugTarget,
  type RunFeedbackTarget,
  type RunRailEntry,
} from "./AgentDetail.runs";

const testState = vi.hoisted(() => ({
  navigate: vi.fn(),
  isMobile: false,
  searchParams: new URLSearchParams("runScene=chat&panel=discarded"),
}));

vi.mock("@/lib/router", () => ({
  Link: "a",
  useNavigate: () => testState.navigate,
  useSearchParams: () => [testState.searchParams, vi.fn()],
}));

vi.mock("../context/I18nContext", () => ({
  useI18n: () => ({
    locale: "en",
    t: (key: string, params?: Record<string, string | number>) => {
      const values: Record<string, string> = {
        "agentRuns.conversation": "Conversation",
        "agentRuns.runCount.one": `${params?.count} run`,
        "agentRuns.runCount.many": `${params?.count} runs`,
        "agentRuns.openAgentRunForConversation.one": `Open agent run for conversation ${params?.shortId}, ${params?.count} run`,
        "agentRuns.openAgentRunForConversation.many": `Open agent run for conversation ${params?.shortId}, ${params?.count} runs`,
      };
      return values[key] ?? key;
    },
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: testState.isMobile }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ confirm: vi.fn() }),
}));

vi.mock("./AgentDetail.chat-context", () => ({
  RunChatContextCard: () => null,
}));

vi.mock("./AgentDetail.run-log", () => ({
  LogViewer: () => null,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function run(overrides: Partial<HeartbeatRun>): HeartbeatRun {
  return {
    id: "run-1",
    orgId: "org-1",
    agentId: "agent-1",
    invocationSource: "chat",
    triggerDetail: "chat_assistant_reply_stream",
    status: "succeeded",
    startedAt: null,
    finishedAt: null,
    error: null,
    wakeupRequestId: null,
    exitCode: null,
    signal: null,
    usageJson: null,
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    sessionReuseScope: "none",
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    errorCode: null,
    externalRunId: null,
    processPid: null,
    processStartedAt: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    contextSnapshot: null,
    chatConversationId: "abcdefgh-conversation",
    goalId: null,
    createdAt: new Date("2026-07-21T10:00:00.000Z"),
    updatedAt: new Date("2026-07-21T10:00:00.000Z"),
    ...overrides,
  };
}

function conversationEntry(overrides: Partial<Extract<RunRailEntry, { kind: "conversation" }>> = {}) {
  const representativeRun = run({
    id: "selected-older-run",
    resultJson: { summary: "Older selected answer" },
    usageJson: { inputTokens: 1200, outputTokens: 300 },
  });
  const runs = [
    run({ id: "newest-run" }),
    representativeRun,
    run({ id: "oldest-run" }),
  ];
  return {
    kind: "conversation" as const,
    conversationId: "abcdefgh-conversation",
    runs,
    matchingRunCount: runs.length,
    representativeRun,
    isSelected: true,
    ...overrides,
  };
}

let container: HTMLDivElement;
let queryClient: QueryClient;
let root: Root;
let sidePanelControls: ReturnType<typeof useSidePanel> | null = null;

beforeEach(() => {
  testState.navigate.mockReset();
  testState.isMobile = false;
  testState.searchParams = new URLSearchParams("runScene=chat&panel=discarded");
  container = document.createElement("div");
  document.body.appendChild(container);
  queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        enabled: false,
        retry: false,
        staleTime: Infinity,
      },
    },
  });
  root = createRoot(container);
  sidePanelControls = null;
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  localStorage.removeItem("rudder.run-feedback-draft:org-1:agent-1");
  container.remove();
});

function expectRoundedClipPane(pane: HTMLElement | null) {
  expect(pane).not.toBeNull();
  expect(pane?.classList.contains("rounded-lg")).toBe(true);
  expect(pane?.classList.contains("overflow-clip")).toBe(true);
  expect(pane?.classList.contains("overflow-x-hidden")).toBe(false);
  expect(pane?.classList.contains("overflow-hidden")).toBe(false);
  expect(pane?.classList.contains("overflow-y-auto")).toBe(false);
}

function SidePanelStateProbe() {
  const sidePanel = useSidePanel();
  sidePanelControls = sidePanel;
  return (
    <output
      data-testid="side-panel-state"
      data-open={String(sidePanel.open)}
      data-tab-count={String(sidePanel.tabs.length)}
    />
  );
}

describe("runFeedbackTargetForContext", () => {
  const agentATarget: RunFeedbackTarget = {
    kind: "run_feedback_chat",
    agentId: "agent-a",
    preferredAgentId: "reviewer-a",
    organizationId: "org-1",
    conversationId: null,
    clientMutationId: "mutation-a",
    projectId: null,
    body: "Agent A draft",
    inlineAnnotations: [],
    label: "Run feedback",
  };

  it("does not reuse a cached feedback draft after switching agents", () => {
    expect(runFeedbackTargetForContext(agentATarget, [], "org-1", "agent-b")).toBeNull();
  });

  it("selects the current agent tab instead of a stale cached target", () => {
    const agentBTarget = {
      ...agentATarget,
      agentId: "agent-b",
      clientMutationId: "mutation-b",
      body: "Agent B draft",
    };

    expect(runFeedbackTargetForContext(
      agentATarget,
      [agentATarget, agentBTarget],
      "org-1",
      "agent-b",
    )).toBe(agentBTarget);
  });

  it("prefers the latest same-agent tab over the cached draft", () => {
    const latestAgentATarget = {
      ...agentATarget,
      conversationId: "conversation-a",
      body: "",
    };

    expect(runFeedbackTargetForContext(
      agentATarget,
      [latestAgentATarget],
      "org-1",
      "agent-a",
    )).toBe(latestAgentATarget);
  });
});

describe("runDebugTargetForRun", () => {
  const debugTarget: RunDebugTarget = {
    kind: "run_debug_chat",
    organizationId: "org-1",
    runId: "run-1",
    agentId: "agent-a",
    preferredAgentId: "agent-a",
    conversationId: null,
    clientMutationId: "run-debug:org-1:run-1",
    projectId: null,
    body: "Investigate",
    autoSend: false,
    errorMessage: null,
    inlineAnnotations: [],
    label: "Debug Run",
  };

  it("does not share a Debug Chat between Runs", () => {
    expect(runDebugTargetForRun(debugTarget, [], "org-1", "run-2")).toBeNull();
  });

  it("prefers the current Run tab over a stale cached target", () => {
    const establishedTarget = {
      ...debugTarget,
      conversationId: "conversation-1",
      body: "",
    };
    expect(runDebugTargetForRun(
      debugTarget,
      [establishedTarget],
      "org-1",
      "run-1",
    )).toBe(establishedTarget);
  });
});

describe("RunConversationListItem", () => {
  it("renders one accessible group row with representative run semantics and matching count", () => {
    act(() => {
      root.render(<RunConversationListItem entry={conversationEntry()} agentId="agent-route" />);
    });

    const row = container.querySelector<HTMLElement>("[data-testid='agent-run-conversation-group-row']");
    expect(row).not.toBeNull();
    expect(row?.getAttribute("aria-label")).toBe("Open agent run for conversation abcdefgh, 3 runs");
    expect(row?.getAttribute("aria-current")).toBe("page");
    expect(row?.textContent).toContain("Conversation");
    expect(row?.textContent).toContain("abcdefgh");
    expect(row?.textContent).toContain("3 runs");
    expect(row?.textContent).toContain("Older selected answer");
    expect(row?.textContent).toContain("1.5k tokens");
  });

  it("announces only matching members when the representative is outside the filters", () => {
    const matchingRun = run({ id: "matching-run" });
    const selectedOutsideRun = run({ id: "selected-outside-run", resultJson: { summary: "Selected outside" } });

    act(() => {
      root.render(<RunConversationListItem
        entry={conversationEntry({
          runs: [selectedOutsideRun, matchingRun],
          matchingRunCount: 1,
          representativeRun: selectedOutsideRun,
        })}
        agentId="agent-route"
      />);
    });

    const row = container.querySelector<HTMLElement>("[data-testid='agent-run-conversation-group-row']");
    expect(row?.getAttribute("aria-label")).toBe("Open agent run for conversation abcdefgh, 1 run");
    expect(row?.textContent).toContain("1 run");
    expect(row?.textContent).not.toContain("2 runs");
    expect(row?.textContent).toContain("Selected outside");
  });

  it.each(["Enter", " "])("opens the selected representative with preserved filters on %s", (key) => {
    act(() => {
      root.render(<RunConversationListItem entry={conversationEntry()} agentId="agent-route" />);
    });

    const row = container.querySelector<HTMLElement>("[data-testid='agent-run-conversation-group-row']")!;
    act(() => {
      row.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });

    expect(testState.navigate).toHaveBeenCalledWith(
      "/agents/agent-route/runs/selected-older-run?runScene=chat",
    );
  });

  it("opens the selected representative on click instead of swapping to the first member", () => {
    act(() => {
      root.render(<RunConversationListItem entry={conversationEntry()} agentId="agent-route" />);
    });

    const row = container.querySelector<HTMLElement>("[data-testid='agent-run-conversation-group-row']")!;
    act(() => {
      row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(testState.navigate).toHaveBeenCalledWith(
      "/agents/agent-route/runs/selected-older-run?runScene=chat",
    );
  });
});

describe("RunRailList", () => {
  it("wraps long run reasons inside the left rail column", () => {
    act(() => {
      root.render(
        <RunListItem
          run={run({
            id: "changes-requested-run",
            contextSnapshot: { wakeReason: "issue_changes_requested" },
          })}
          isSelected={false}
          agentId="agent-route"
        />,
      );
    });

    const topRow = container.querySelector<HTMLElement>("[data-testid='run-list-top-row']");
    expect(topRow?.classList.contains("items-start")).toBe(true);
    expect(topRow?.firstElementChild?.classList.contains("flex-wrap")).toBe(true);
    expect(container.querySelector("[data-testid='run-list-reason']")?.textContent).toBe("Changes requested");
  });

  it("renders a conversation once while keeping unlinked runs standalone", () => {
    const group = conversationEntry({ isSelected: false });
    const standalone = run({ id: "standalone-run", chatConversationId: null });
    const entries: RunRailEntry[] = [
      group,
      { kind: "run", run: standalone, isSelected: false },
    ];

    act(() => {
      root.render(<RunRailList entries={entries} agentId="agent-route" />);
    });

    expect(container.querySelectorAll("[data-testid='agent-run-conversation-group-row']")).toHaveLength(1);
    expect(container.querySelectorAll("[role='link']")).toHaveLength(2);
    expect(container.textContent).toContain("standalo");
  });
});

describe("RunsTab shared rail branches", () => {
  const groupedRuns = [
    run({ id: "grouped-run-2", createdAt: new Date("2026-07-21T11:00:00.000Z") }),
    run({ id: "grouped-run-1", createdAt: new Date("2026-07-21T10:00:00.000Z") }),
  ];

  it("does not reopen a recovered feedback draft when the panel was closed", async () => {
    localStorage.setItem("rudder.run-feedback-draft:org-1:agent-1", JSON.stringify({
      agentId: "agent-1",
      organizationId: "org-1",
      conversationId: null,
      projectLocked: false,
      clientMutationId: "mutation-1",
      projectId: null,
      body: "Draft feedback",
      inlineAnnotations: [],
    }));

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidePanelProvider>
            <SidePanelStateProbe />
            <RunsTab
              runs={groupedRuns}
              orgId="org-1"
              agentId="agent-1"
              agentRouteId="agent-route"
              selectedRunId={null}
              agentRuntimeType="codex_local"
            />
          </SidePanelProvider>
        </QueryClientProvider>,
      );
    });

    const probe = container.querySelector<HTMLOutputElement>("[data-testid='side-panel-state']");
    expect(probe?.dataset.open).toBe("false");
    expect(probe?.dataset.tabCount).toBe("0");
  });

  it("restores recovered feedback after the user opens the panel", async () => {
    const feedbackTarget: RunFeedbackTarget = {
      kind: "run_feedback_chat",
      agentId: "agent-1",
      organizationId: "org-1",
      conversationId: "conversation-1",
      projectLocked: true,
      clientMutationId: "mutation-1",
      projectId: "project-1",
      preferredAgentId: "agent-1",
      body: "",
      inlineAnnotations: [{
        id: "annotation-1",
        selectedText: "Persisted reasoning",
        comment: "Review persisted reasoning.",
        sourceHash: "hash-1",
        surface: "agent_run_transcript",
        sourceRunId: "run-1",
        sourceAgentId: "agent-1",
        anchorKind: "text",
        sourceEntryId: "entry-1",
        sourceMemberIds: ["entry-1"],
        attachmentIds: [],
        attachmentFileIndexes: [],
      }],
      label: "Run feedback",
    };
    localStorage.setItem("rudder.run-feedback-draft:org-1:agent-1", JSON.stringify(feedbackTarget));

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidePanelProvider>
            <SidePanelStateProbe />
            <RunsTab
              runs={groupedRuns}
              orgId="org-1"
              agentId="agent-1"
              agentRouteId="agent-route"
              selectedRunId={null}
              agentRuntimeType="codex_local"
            />
          </SidePanelProvider>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await vi.waitFor(() => expect(sidePanelControls?.contextKey).toBe("agent-runs:agent-route"));
    });

    expect(sidePanelControls?.open).toBe(false);
    expect(sidePanelControls?.tabs).toHaveLength(0);
    act(() => {
      sidePanelControls?.showPanel();
    });
    await act(async () => {
      await vi.waitFor(() => expect(sidePanelControls?.tabs).toHaveLength(1));
    });
    expect(sidePanelControls?.open).toBe(true);
    expect(sidePanelControls?.tabs[0]).toMatchObject({
      kind: "run_feedback_chat",
      conversationId: "conversation-1",
      inlineAnnotations: [expect.objectContaining({ id: "annotation-1" })],
    });
  });

  it("does not restore a feedback tab after the user closes it while another tab remains open", async () => {
    const feedbackTarget: RunFeedbackTarget = {
      kind: "run_feedback_chat",
      agentId: "agent-1",
      organizationId: "org-1",
      conversationId: null,
      projectLocked: false,
      clientMutationId: "mutation-1",
      projectId: null,
      preferredAgentId: "agent-1",
      body: "Draft feedback",
      inlineAnnotations: [],
      label: "Run feedback",
    };
    localStorage.setItem("rudder.run-feedback-draft:org-1:agent-1", JSON.stringify(feedbackTarget));

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidePanelProvider>
            <SidePanelStateProbe />
            <RunsTab
              runs={groupedRuns}
              orgId="org-1"
              agentId="agent-1"
              agentRouteId="agent-route"
              selectedRunId={null}
              agentRuntimeType="codex_local"
            />
          </SidePanelProvider>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await vi.waitFor(() => expect(sidePanelControls?.contextKey).toBe("agent-runs:agent-route"));
    });

    const issueTarget: SidePanelTarget = {
      kind: "issue",
      issueId: "issue-1",
      ref: "R6Z-1",
      commentId: null,
      label: "R6Z-1",
    };
    act(() => {
      sidePanelControls?.openTargetForContext("agent-runs:agent-route", issueTarget);
      sidePanelControls?.openTargetForContext("agent-runs:agent-route", feedbackTarget);
    });
    expect(sidePanelControls?.tabs.map((target) => target.kind)).toEqual(["issue", "run_feedback_chat"]);

    await act(async () => {
      sidePanelControls?.closeTarget(sidePanelTargetKey(feedbackTarget));
      await Promise.resolve();
    });

    expect(sidePanelControls?.open).toBe(true);
    expect(sidePanelControls?.tabs.map((target) => target.kind)).toEqual(["issue"]);
  });

  it("keeps the current run primary on mobile and reveals grouped history on demand", async () => {
    testState.isMobile = true;

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidePanelProvider>
            <RunsTab
              runs={groupedRuns}
              orgId="org-1"
              agentId="agent-1"
              agentRouteId="agent-route"
              selectedRunId={null}
              agentRuntimeType="codex_local"
            />
          </SidePanelProvider>
        </QueryClientProvider>,
      );
    });

    expect(container.querySelector("[data-testid='agent-runs-detail-pane']")).not.toBeNull();
    const trigger = container.querySelector<HTMLButtonElement>("[data-testid='agent-runs-history-trigger']");
    expect(trigger).not.toBeNull();
    await act(async () => trigger?.click());
    expect(document.body.querySelector("[data-testid='agent-runs-history-popover']")).not.toBeNull();
    expect(document.body.querySelectorAll("[data-testid='agent-run-conversation-group-row']").length).toBeGreaterThan(0);
  });

  it("uses the first member produced by the active oldest-first sort as the mobile detail", async () => {
    testState.isMobile = true;
    testState.searchParams = new URLSearchParams("runSort=oldest");
    const newest = run({
      id: "newest-run",
      resultJson: { summary: "Newest sorted result" },
      createdAt: new Date("2026-07-21T11:00:00.000Z"),
    });
    const oldest = run({
      id: "oldest-run",
      resultJson: { summary: "Oldest sorted result" },
      createdAt: new Date("2026-07-21T10:00:00.000Z"),
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidePanelProvider>
            <RunsTab
              runs={[newest, oldest]}
              orgId="org-1"
              agentId="agent-1"
              agentRouteId="agent-route"
              selectedRunId={null}
              agentRuntimeType="codex_local"
            />
          </SidePanelProvider>
        </QueryClientProvider>,
      );
    });

    expect(container.querySelector("[data-testid='agent-runs-detail-pane']")).not.toBeNull();
    const trigger = container.querySelector<HTMLButtonElement>("[data-testid='agent-runs-history-trigger']");
    await act(async () => trigger?.click());
    const selectedRow = document.body.querySelector<HTMLElement>("[data-testid='agent-run-conversation-group-row'][aria-current='page']");
    expect(selectedRow?.textContent).toContain("Oldest sorted result");
    expect(selectedRow?.textContent).not.toContain("Newest sorted result");
  });

  it("renders grouped rows through the desktop no-selection branch", () => {
    act(() => {
      root.render(
        <SidePanelProvider>
          <RunsTab
            runs={groupedRuns}
            orgId="org-1"
            agentId="agent-1"
            agentRouteId="agent-route"
            selectedRunId="missing-run"
            agentRuntimeType="codex_local"
          />
        </SidePanelProvider>,
      );
    });

    expectRoundedClipPane(container.querySelector<HTMLElement>("[data-testid='agent-runs-list-pane']"));
    expect(container.querySelector("[data-testid='agent-runs-detail-pane']")).toBeNull();
    expect(container.querySelectorAll("[data-testid='agent-run-conversation-group-row']")).toHaveLength(1);
    expect(container.textContent).toContain("2 runs");
  });

  it("clips the desktop selected-run rail while preserving its sticky inner scroller", () => {
    queryClient.setQueryData(["agent-run", groupedRuns[0].id], groupedRuns[0]);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidePanelProvider>
            <RunsTab
              runs={groupedRuns}
              orgId="org-1"
              agentId="agent-1"
              agentRouteId="agent-route"
              selectedRunId={groupedRuns[0].id}
              agentRuntimeType="codex_local"
            />
          </SidePanelProvider>
        </QueryClientProvider>,
      );
    });

    const pane = container.querySelector<HTMLElement>("[data-testid='agent-runs-list-pane']");
    expectRoundedClipPane(pane);
    expect(container.querySelector("[data-testid='agent-runs-detail-pane']")).not.toBeNull();

    const scroller = pane?.firstElementChild as HTMLElement | null;
    expect(scroller?.classList.contains("sticky")).toBe(true);
    expect(scroller?.classList.contains("top-4")).toBe(true);
    expect(scroller?.classList.contains("overflow-y-auto")).toBe(true);
    expect(scroller?.style.maxHeight).toBe("calc(100vh - 2rem)");
  });
});
