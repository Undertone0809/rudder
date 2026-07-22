// @vitest-environment jsdom

import type { HeartbeatRun } from "@rudderhq/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunsTab, RunConversationListItem, RunRailList, type RunRailEntry } from "./AgentDetail.runs";

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
let root: Root;

beforeEach(() => {
  testState.navigate.mockReset();
  testState.isMobile = false;
  testState.searchParams = new URLSearchParams("runScene=chat&panel=discarded");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
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

  it("renders grouped rows through the mobile list branch", () => {
    testState.isMobile = true;

    act(() => {
      root.render(<RunsTab
        runs={groupedRuns}
        orgId="org-1"
        agentId="agent-1"
        agentRouteId="agent-route"
        selectedRunId={null}
        agentRuntimeType="codex_local"
      />);
    });

    expect(container.querySelectorAll("[data-testid='agent-run-conversation-group-row']")).toHaveLength(1);
    expect(container.textContent).toContain("2 runs");
  });

  it("uses the first member produced by the active oldest-first sort", () => {
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

    act(() => {
      root.render(<RunsTab
        runs={[newest, oldest]}
        orgId="org-1"
        agentId="agent-1"
        agentRouteId="agent-route"
        selectedRunId={null}
        agentRuntimeType="codex_local"
      />);
    });

    const row = container.querySelector<HTMLElement>("[data-testid='agent-run-conversation-group-row']");
    expect(row?.textContent).toContain("Oldest sorted result");
    expect(row?.textContent).not.toContain("Newest sorted result");
  });

  it("renders grouped rows through the desktop no-selection branch", () => {
    act(() => {
      root.render(<RunsTab
        runs={groupedRuns}
        orgId="org-1"
        agentId="agent-1"
        agentRouteId="agent-route"
        selectedRunId="missing-run"
        agentRuntimeType="codex_local"
      />);
    });

    expect(container.querySelector("[data-testid='agent-runs-detail-pane']")).toBeNull();
    expect(container.querySelectorAll("[data-testid='agent-run-conversation-group-row']")).toHaveLength(1);
    expect(container.textContent).toContain("2 runs");
  });
});
