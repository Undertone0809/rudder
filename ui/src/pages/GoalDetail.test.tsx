// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentsApi } from "../api/agents";
import { goalsApi } from "../api/goals";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { GoalDetail } from "./GoalDetail";

const navigate = vi.fn();
const randomUUID = vi.fn();
let search = "";
let dispose: (() => void) | null = null;

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  useNavigate: () => navigate,
  useParams: () => ({ goalId: "goal-1" }),
  useLocation: () => ({ pathname: "/goals/goal-1", search }),
}));

vi.mock("../context/OrganizationContext", () => ({
  useOrganization: () => ({
    selectedOrganizationId: "org-1",
    setSelectedOrganizationId: vi.fn(),
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ confirm: vi.fn(), openNewGoal: vi.fn(), promptText: vi.fn() }),
}));

vi.mock("../context/PanelContext", () => ({
  usePanel: () => ({ closePanel: vi.fn() }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../components/InlineEditor", () => ({
  InlineEditor: ({ value, as: Tag = "span", ...props }: { value: string; as?: "h1" | "p" | "span" }) => <Tag {...props}>{value}</Tag>,
}));

vi.mock("../components/StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("../components/PageSkeleton", () => ({ PageSkeleton: () => <div>Loading</div> }));

vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn() } }));
vi.mock("../api/issues", () => ({ issuesApi: { list: vi.fn() } }));
vi.mock("../api/projects", () => ({ projectsApi: { list: vi.fn() } }));
vi.mock("../api/goals", () => ({
  goalsApi: {
    getWorkspace: vi.fn(),
    dependencies: vi.fn(),
    update: vi.fn(),
    setFocus: vi.fn(),
    remove: vi.fn(),
    feedback: vi.fn(),
    decideChangeProposal: vi.fn(),
    acceptResultProposal: vi.fn(),
    rejectResultProposal: vi.fn(),
  },
}));

const longProgress = "The verified external release now survives restart with a stable runtime identity, complete operator evidence, and a deliberately long explanation that must wrap cleanly on constrained mobile screens.";

const goal = {
  id: "goal-1",
  orgId: "org-1",
  title: "Ship the Goal Workspace",
  description: "Keep the work grounded in the operator journey.",
  level: "organization",
  status: "active",
  parentId: null,
  ownerAgentId: "agent-1",
  lifecycle: "active",
  objectiveMode: "target",
  contractRevision: 2,
  outcomeStatement: "A verified Goal Workspace is available to operators.",
  criteria: [{ id: "workflow", label: "The operator workflow passes", evaluator: "artifact" }],
  actionDeadline: "2026-08-20T10:00:00.000Z",
  evaluationResult: null,
  focus: true,
  createdAt: "2026-08-05T00:00:00.000Z",
  updatedAt: "2026-08-05T01:00:00.000Z",
};

const workspace = {
  goal,
  facet: "ready_for_acceptance",
  currentGoal: { summary: goal.outcomeStatement, revision: 2, updatedFromEvidence: true },
  currentProgress: {
    summary: longProgress,
    sourceActivityId: "activity-1",
    evidenceRefs: ["artifact://goal-workspace/operator-pass"],
    uncertainty: "Public rollout is still outside the agreed boundary.",
  },
  attention: {
    kind: "accept",
    reason: "Review the terminal result.",
    sourceId: "result-1",
    impact: "Acceptance closes this Goal record.",
    evidenceRefs: ["artifact://goal-workspace/operator-pass"],
  },
  agentAction: { summary: "Hold the immutable candidate while the operator reviews it." },
  nextStep: { summary: "Accept the result or explain the remaining gap.", wakeCondition: null },
  timeline: [{
    id: "activity-1",
    kind: "evidence",
    summary: "The real operator workflow passed.",
    createdAt: "2026-08-05T00:30:00.000Z",
    evidenceRefs: ["artifact://goal-workspace/operator-pass"],
    actorName: "Workspace owner",
  }],
  changeProposals: [{
    id: "change-1",
    status: "pending",
    beforeContract: {
      outcomeStatement: "Ship a verified Goal Workspace",
      objectiveMode: "target",
      criteria: [{ id: "workflow", label: "The operator workflow passes", evaluator: "artifact" }],
      evaluationDeadline: "2026-08-20T10:00:00.000Z",
    },
    afterContract: {
      outcomeStatement: "Ship a verified Goal Workspace with restart recovery",
      objectiveMode: "target",
      criteria: [{ id: "workflow", label: "The operator workflow passes after restart", evaluator: "artifact" }],
      evaluationDeadline: "2026-08-22T10:00:00.000Z",
    },
    rationale: "Restart evidence makes the commitment materially stronger.",
    evidenceRefs: ["artifact://goal-workspace/restart-evidence"],
  }],
  resultProposals: [{
    id: "result-1",
    status: "ready",
    candidate: { evidenceRefs: ["artifact://goal-workspace/result"] },
    preflight: {
      outcome: "achieved",
      criteria: [{ id: "workflow", status: "met", missingEvidence: [] }],
    },
    riskSummary: "No unresolved release risk remains.",
  }],
};

const dependencies = {
  goalId: "goal-1",
  orgId: "org-1",
  canDelete: true,
  blockers: [],
  isLastRootOrganizationGoal: false,
  counts: { childGoals: 0, linkedProjects: 0, linkedIssues: 1, automations: 0, calendarEvents: 0, costEvents: 0, financeEvents: 0 },
  previews: { childGoals: [], linkedProjects: [], linkedIssues: [], automations: [], calendarEvents: [] },
};

function renderPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  act(() => root.render(
    <QueryClientProvider client={queryClient}>
      <GoalDetail />
    </QueryClientProvider>,
  ));
  dispose = () => act(() => root.unmount());
  return container;
}

async function waitUntil(assertion: () => void, timeout = 2500) {
  const started = Date.now();
  while (true) {
    try { assertion(); return; } catch (error) {
      if (Date.now() - started > timeout) throw error;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
  }
}

function change(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(container: ParentNode, label: string) {
  return Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === label) ?? null;
}

beforeEach(() => {
  vi.mocked(goalsApi.getWorkspace).mockResolvedValue(workspace as never);
  vi.mocked(goalsApi.dependencies).mockResolvedValue(dependencies as never);
  vi.mocked(goalsApi.update).mockResolvedValue(goal as never);
  vi.mocked(goalsApi.setFocus).mockResolvedValue(goal as never);
  vi.mocked(goalsApi.feedback).mockResolvedValue({ id: "feedback-1" } as never);
  vi.mocked(goalsApi.decideChangeProposal).mockResolvedValue({ id: "change-1", status: "approved" } as never);
  vi.mocked(goalsApi.acceptResultProposal).mockResolvedValue({ ...goal, lifecycle: "closed", status: "achieved" } as never);
  vi.mocked(goalsApi.rejectResultProposal).mockResolvedValue({ id: "result-1", status: "rejected" } as never);
  vi.mocked(agentsApi.list).mockResolvedValue([{ id: "agent-1", name: "Workspace owner" }] as never);
  vi.mocked(projectsApi.list).mockResolvedValue([] as never);
  vi.mocked(issuesApi.list).mockResolvedValue([{
    id: "issue-1",
    orgId: "org-1",
    identifier: "GW-1",
    title: "Verify the operator workflow",
    goalId: "goal-1",
  }] as never);
  randomUUID.mockReset();
  randomUUID.mockReturnValueOnce("feedback-key-1").mockReturnValueOnce("result-key-1");
  vi.stubGlobal("crypto", { randomUUID });
  search = "";
});

afterEach(() => {
  dispose?.();
  dispose = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("GoalDetail", () => {
  it("renders the Goal Workspace in operational order without standard low-level fields", async () => {
    const container = renderPage();
    await waitUntil(() => expect(Array.from(container.querySelectorAll("h2")).some((heading) => heading.textContent === "Current Goal")).toBe(true));
    const text = container.textContent ?? "";
    const orderedSections = [
      "Current Goal",
      "Current progress",
      "Needs your attention",
      "Agent is doing",
      "Next step",
      "Progress and feedback",
      "Goal details and related work",
    ];
    for (let index = 1; index < orderedSections.length; index += 1) {
      expect(text.indexOf(orderedSections[index - 1]!)).toBeLessThan(text.indexOf(orderedSections[index]!));
    }
    for (const hiddenField of [
      "Contract activation",
      "Objective mode",
      "Evaluator",
      "Evidence references",
      "Allowed autonomy",
      "Human acceptance authority",
      "Initial Plan",
      "Evaluate from evidence",
      "Add activity",
      "Ordinary feedback",
      "Consequential change",
    ]) {
      expect(text).not.toContain(hiddenField);
    }
    const progress = Array.from(container.querySelectorAll("p")).find((element) => element.textContent === longProgress);
    expect(progress?.classList.contains("break-words")).toBe(true);
    expect(text).toContain("Verify the operator workflow");
    expect(text).toContain("Based on 1 supporting item");
    expect(text).not.toContain("artifact://");
    expect(text).not.toContain("Agreement revision");
    expect(text).not.toContain("objectiveMode");
    expect(text).not.toContain('"evaluator"');
    expect(text).toContain("Success: The operator workflow passes");
    expect(text).not.toContain("Goal diagnostics");
  });

  it("shows feedback immediately, retains its idempotency key for retry, and restores composer focus", async () => {
    vi.mocked(goalsApi.feedback)
      .mockRejectedValueOnce(new Error("Network interrupted"))
      .mockResolvedValueOnce({ id: "feedback-1" } as never);
    const container = renderPage();
    await waitUntil(() => expect(container.querySelector('[aria-label="Goal feedback"]')).not.toBeNull());
    const composer = container.querySelector<HTMLTextAreaElement>('[aria-label="Goal feedback"]')!;
    change(composer, "Keep the evidence tied to the immutable candidate.");
    act(() => button(container, "Send feedback")?.click());

    expect(container.textContent).toContain("Keep the evidence tied to the immutable candidate.");
    expect(container.textContent).toContain("Sending...");
    await waitUntil(() => expect(container.textContent).toContain("Not sent"));
    expect(container.querySelector("[role=alert]")?.textContent).toContain("Network interrupted");
    await waitUntil(() => expect(document.activeElement).toBe(composer));

    act(() => button(container, "Retry feedback")?.click());
    await waitUntil(() => expect(goalsApi.feedback).toHaveBeenCalledTimes(2));
    const firstPayload = vi.mocked(goalsApi.feedback).mock.calls[0]?.[1] as Record<string, unknown>;
    const retryPayload = vi.mocked(goalsApi.feedback).mock.calls[1]?.[1] as Record<string, unknown>;
    expect(firstPayload.idempotencyKey).toBe("feedback-key-1");
    expect(retryPayload.idempotencyKey).toBe("feedback-key-1");
    expect(firstPayload.feedbackKind).toBe("ordinary");
    await waitUntil(() => expect(document.activeElement).toBe(composer));
  });

  it("keeps change and result decisions self-contained, keyboard-operable, and requires rejection feedback", async () => {
    const container = renderPage();
    await waitUntil(() => expect(container.querySelector('[aria-label="Goal change proposal"]')).not.toBeNull());
    const changeBlock = container.querySelector<HTMLElement>('[aria-label="Goal change proposal"]')!;
    expect(changeBlock.textContent).toContain("Before");
    expect(changeBlock.textContent).toContain("After");
    expect(changeBlock.textContent).toContain("Restart evidence makes the commitment materially stronger.");
    act(() => button(changeBlock, "Approve")?.click());
    await waitUntil(() => expect(goalsApi.decideChangeProposal).toHaveBeenCalledWith("change-1", {
      decision: "approve",
      note: undefined,
    }));
    await waitUntil(() => expect(document.activeElement).toBe(changeBlock));

    const resultBlock = container.querySelector<HTMLElement>('[aria-label="Goal result proposal"]')!;
    const reject = button(resultBlock, "Result is not sufficient")!;
    expect(reject.disabled).toBe(true);
    const feedback = resultBlock.querySelector<HTMLTextAreaElement>('[aria-label="Why is this result not sufficient?"]')!;
    change(feedback, "Repeat the restart verification.");
    expect(reject.disabled).toBe(false);
    act(() => {
      reject.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      reject.click();
    });
    await waitUntil(() => expect(goalsApi.rejectResultProposal).toHaveBeenCalledWith("result-1", expect.objectContaining({
      feedback: "Repeat the restart verification.",
    })));
  });

  it("shows accepted status and exposes read-only diagnostics only with goalDebug=1", async () => {
    search = "?goalDebug=1";
    vi.mocked(goalsApi.getWorkspace).mockResolvedValue({
      ...workspace,
      goal: { ...goal, lifecycle: "closed", status: "achieved", evaluationResult: { outcome: "achieved" } },
      attention: null,
      changeProposals: [],
      resultProposals: [{ ...workspace.resultProposals[0], status: "accepted" }],
    } as never);
    const container = renderPage();
    await waitUntil(() => expect(container.textContent).toContain("Result accepted"));
    expect(container.textContent).toContain("achieved");
    expect(container.textContent).toContain("Goal diagnostics");
    expect(container.textContent).not.toContain("Evaluate from evidence");
  });

  it("shows a recoverable not-found state instead of a blank Goal page", async () => {
    vi.mocked(goalsApi.getWorkspace).mockRejectedValue(new Error("Goal not found"));
    const container = renderPage();
    await waitUntil(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.textContent).toContain("Goal not found");
    expect(container.textContent).toContain("Back to Goals");
  });
});
