// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { goalsApi } from "../api/goals";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import { GoalDetail } from "./GoalDetail";

const navigate = vi.fn();
const openNewGoal = vi.fn();
const randomUUID = vi.fn();
let search = "";
let routeGoalId = "goal-1";
let routeOrgPrefix = "rudder";
let contextOrganizations = [
  { id: "org-1", name: "Rudder", issuePrefix: "RUD", urlKey: "rudder" },
];
let dispose: (() => void) | null = null;

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  Navigate: ({ to, replace }: { to: string; replace?: boolean }) => (
    <div data-testid="navigate" data-to={to} data-replace={String(Boolean(replace))} />
  ),
  useNavigate: () => navigate,
  useParams: () => ({ goalId: routeGoalId, orgPrefix: routeOrgPrefix }),
  useLocation: () => ({ pathname: `/${routeOrgPrefix}/goals/${routeGoalId}`, search, hash: "" }),
}));

vi.mock("../context/OrganizationContext", () => ({
  useOrganization: () => ({
    organizations: contextOrganizations,
    selectedOrganizationId: "org-1",
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ confirm: vi.fn(), openNewGoal, promptText: vi.fn() }),
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

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children, className }: { children: string; className?: string }) => {
    const match = children.match(/^(.*?)\*\*(.+?)\*\*(.*?)$/);
    return (
      <div data-testid="markdown-body" className={className}>
        {match ? <>{match[1]}<strong>{match[2]}</strong>{match[3]}</> : children}
      </div>
    );
  },
}));

vi.mock("../components/StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("../components/PageSkeleton", () => ({ PageSkeleton: () => <div>Loading</div> }));

vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn(), resume: vi.fn() } }));
vi.mock("../api/auth", () => ({ authApi: { getSession: vi.fn() } }));
vi.mock("../api/issues", () => ({ issuesApi: { list: vi.fn() } }));
vi.mock("../api/projects", () => ({ projectsApi: { list: vi.fn() } }));
vi.mock("../api/goals", () => ({
  goalsApi: {
    getWorkspace: vi.fn(),
    getHistory: vi.fn(),
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
  criteria: [
    { id: "workflow", label: "The operator workflow passes", evaluator: "artifact" },
    { id: "restart", label: "Restart recovery remains reliable", evaluator: "artifact" },
  ],
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
    proposedByAgentId: "agent-1",
    candidateHash: "private-candidate-hash",
    candidate: {
      evidenceRefs: ["artifact://goal-workspace/result", "run://goal-workspace/verifier"],
      resultPayload: { internalProofKey: "private-proof-value" },
    },
    preflight: {
      mode: "target",
      outcome: "achieved",
      criteria: [
        { id: "workflow", evaluator: "artifact", status: "met", evidenceSatisfied: true, missingEvidence: [] },
        { id: "restart", evaluator: "artifact", status: "met", evidenceSatisfied: true, missingEvidence: [] },
      ],
      evidenceRefs: ["artifact://goal-workspace/result", "run://goal-workspace/verifier"],
      decision: null,
      evaluatedAt: "2026-08-05T00:45:00.000Z",
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

function renderPageWithClient() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const render = () => (
    <QueryClientProvider client={queryClient}>
      <GoalDetail />
    </QueryClientProvider>
  );
  act(() => root.render(render()));
  dispose = () => act(() => root.unmount());
  return { container, queryClient, rerender: () => act(() => root.render(render())) };
}

function renderPage() {
  return renderPageWithClient().container;
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
  vi.mocked(goalsApi.getHistory).mockResolvedValue({ items: [], nextCursor: null } as never);
  vi.mocked(authApi.getSession).mockResolvedValue({
    session: { id: "session-1", userId: "user-1" },
    user: { id: "user-1", email: "operator@example.com", name: "Operator" },
  });
  vi.mocked(goalsApi.dependencies).mockResolvedValue(dependencies as never);
  vi.mocked(goalsApi.update).mockResolvedValue(goal as never);
  vi.mocked(goalsApi.setFocus).mockResolvedValue(goal as never);
  vi.mocked(goalsApi.feedback).mockResolvedValue({ id: "feedback-1" } as never);
  vi.mocked(goalsApi.decideChangeProposal).mockResolvedValue({ id: "change-1", status: "approved" } as never);
  vi.mocked(goalsApi.acceptResultProposal).mockResolvedValue({ ...goal, lifecycle: "closed", status: "achieved" } as never);
  vi.mocked(goalsApi.rejectResultProposal).mockResolvedValue({ id: "result-1", status: "rejected" } as never);
  vi.mocked(agentsApi.list).mockResolvedValue([{ id: "agent-1", name: "Workspace owner" }] as never);
  vi.mocked(agentsApi.resume).mockResolvedValue({ id: "agent-1", name: "Workspace owner", status: "idle" } as never);
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
  routeGoalId = "goal-1";
  routeOrgPrefix = "rudder";
  contextOrganizations = [
    { id: "org-1", name: "Rudder", issuePrefix: "RUD", urlKey: "rudder" },
  ];
});

afterEach(() => {
  dispose?.();
  dispose = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("GoalDetail", () => {
  it("canonicalizes a Goal URL to the Goal organization before rendering its workspace", async () => {
    contextOrganizations = [
      ...contextOrganizations,
      { id: "org-2", name: "Other", issuePrefix: "OTH", urlKey: "other" },
    ];
    vi.mocked(goalsApi.getWorkspace).mockResolvedValue({
      ...workspace,
      goal: { ...goal, orgId: "org-2" },
    } as never);

    const container = renderPage();
    await waitUntil(() => expect(container.querySelector('[data-testid="navigate"]')).not.toBeNull());
    const redirect = container.querySelector<HTMLElement>('[data-testid="navigate"]')!;
    expect(redirect.dataset.to).toBe("/other/goals/goal-1");
    expect(redirect.dataset.replace).toBe("true");
    expect(container.textContent).not.toContain("Current Goal");
  });

  it("does not present a closed Goal as still advancing", async () => {
    vi.mocked(goalsApi.getWorkspace).mockResolvedValue({
      ...workspace,
      goal: {
        ...goal,
        lifecycle: "closed",
        status: "achieved",
        focus: false,
        evaluationResult: { outcome: "achieved" },
      },
      facet: "closed",
      attention: workspace.attention,
      changeProposals: workspace.changeProposals,
      resultProposals: [
        { ...workspace.resultProposals[0], status: "accepted" },
        { ...workspace.resultProposals[0], id: "stale-result", status: "ready" },
      ],
    } as never);

    const container = renderPage();
    await waitUntil(() => expect(container.textContent).toContain("Result accepted"));
    expect(container.textContent).toContain("History");
    expect(container.textContent).toContain("Goal achieved");
    expect(container.textContent).toContain("The operator workflow passes");
    expect(container.textContent).toContain("No unresolved release risk remains.");
    expect(container.textContent).toContain("Evidence check");
    expect(container.textContent).not.toContain("Agent advancing");
    expect(container.textContent).not.toContain("Agent is doing");
    expect(container.textContent).not.toContain("Next step");
    expect(container.textContent).not.toContain("Needs your attention");
    expect(container.querySelector('[aria-label="Goal change proposal"]')).toBeNull();
    expect(container.querySelector('[aria-label="Goal result proposal"]')).toBeNull();
    expect(container.querySelector('[aria-label="Goal feedback"]')).toBeNull();
    expect(button(container, "Rename")).toBeNull();
  });

  it("renders the Goal Workspace in operational order without standard low-level fields", async () => {
    const container = renderPage();
    await waitUntil(() => expect(Array.from(container.querySelectorAll("h2")).some((heading) => heading.textContent === "Outcome")).toBe(true));
    const text = container.textContent ?? "";
    const orderedSections = [
      "Outcome",
      "Current progress",
      "Needs your attention",
      "Next step",
      "Progress and feedback",
      "Goal details and related work",
    ];
    if (text.includes("Agent is doing")) {
      orderedSections.splice(3, 0, "Agent is doing");
    }
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
    expect(text).toContain("Artifact evidence 1");
    expect(text).toContain("Unavailable");
    expect(text).not.toContain("artifact://");
    expect(text).not.toContain("Agreement revision");
    expect(text).not.toContain("objectiveMode");
    expect(text).not.toContain('"evaluator"');
    expect(text).toContain("Success: The operator workflow passes");
    expect(text).not.toContain("Goal diagnostics");

    const resultBlock = container.querySelector<HTMLElement>('[aria-label="Goal result proposal"]')!;
    expect(resultBlock.textContent).toContain("Goal achieved");
    expect(resultBlock.textContent).toContain("The operator workflow passes");
    expect(resultBlock.textContent).toContain("Restart recovery remains reliable");
    expect(resultBlock.textContent).toContain("Met");
    expect(resultBlock.textContent).toContain("No unresolved release risk remains.");
    expect(resultBlock.textContent).toContain("Evidence check");
    expect(resultBlock.textContent).toContain("The submitted evidence supports every success criterion.");
    expect(resultBlock.textContent).toContain("Artifact evidence 1");
    expect(resultBlock.textContent).toContain("Supporting work 2");
    expect(resultBlock.textContent).not.toContain("Agent run evidence");
    for (const privateValue of [
      "artifact://goal-workspace/result",
      "run://goal-workspace/verifier",
      "private-candidate-hash",
      "private-proof-value",
      "candidateHash",
      "resultPayload",
      "internalProofKey",
      "evaluator",
      "evidenceSatisfied",
      "evaluatedAt",
    ]) {
      expect(resultBlock.innerHTML).not.toContain(privateValue);
    }
  });

  it("uses plain-language History labels instead of internal timeline kinds", async () => {
    vi.mocked(goalsApi.getWorkspace).mockResolvedValue({
      ...workspace,
      timeline: [
        { id: "activity", kind: "activity", summary: "Goal updated after approval.", createdAt: "2026-08-05T00:30:00.000Z" },
        { id: "feedback", kind: "feedback", summary: "Keep the scope bounded.", createdAt: "2026-08-05T00:29:00.000Z" },
        { id: "change", kind: "change_proposal", summary: "Add restart recovery.", createdAt: "2026-08-05T00:28:00.000Z" },
        { id: "result-ready", kind: "result_proposal", status: "ready", summary: "The result is ready.", createdAt: "2026-08-05T00:27:00.000Z" },
        { id: "result-rejected", kind: "result_proposal", status: "rejected", summary: "Goal achieved.", createdAt: "2026-08-05T00:26:30.000Z" },
        { id: "result-accepted", kind: "result_proposal", status: "accepted", summary: "Goal achieved.", createdAt: "2026-08-05T00:26:15.000Z" },
        { id: "result-superseded", kind: "result_proposal", status: "superseded", summary: "An older result.", createdAt: "2026-08-05T00:26:10.000Z" },
        { id: "result-inconclusive", kind: "result_proposal", status: "inconclusive", summary: "More evidence is required.", createdAt: "2026-08-05T00:26:05.000Z" },
        { id: "work", kind: "work_status", summary: "Issue GW-1 is done.", createdAt: "2026-08-05T00:26:00.000Z" },
        { id: "unknown", kind: "internal_future_kind", summary: "A future update.", createdAt: "2026-08-05T00:25:00.000Z" },
      ],
    } as never);

    const container = renderPage();
    await waitUntil(() => expect(container.textContent).toContain("Goal updated after approval."));
    const text = container.textContent ?? "";
    for (const label of ["Progress update", "Feedback", "Proposed Goal update", "Proposed result", "Related work", "Goal update"]) {
      expect(text).toContain(label);
    }
    for (const state of [
      "Result ready for review",
      "Result proposal rejected",
      "Accepted result",
      "Result proposal superseded",
      "Result needs more evidence",
    ]) {
      expect(text).toContain(state);
    }
    for (const internalKind of ["change_proposal", "result_proposal", "work_status", "internal_future_kind"]) {
      expect(text).not.toContain(internalKind);
    }
  });

  it("uses human action labels for attention and boundary-only Goal updates", async () => {
    vi.mocked(goalsApi.getWorkspace).mockResolvedValue({
      ...workspace,
      attention: {
        kind: "result_proposal",
        reason: "Review the proposed Goal result and decide whether it is sufficient.",
        sourceId: "result-1",
      },
      changeProposals: [{
        id: "boundary-change",
        status: "pending",
        beforeContract: {
          autonomyEnvelope: { allowed: ["bounded_reversible_work"] },
          humanAuthorities: { acceptance: "board_human" },
        },
        afterContract: {
          autonomyEnvelope: {
            allowed: ["bounded_reversible_work", "external_publication"],
            requiresHumanApproval: ["external_publication"],
          },
          humanAuthorities: { acceptance: "board_human", externalPublication: "board_human" },
        },
        rationale: "The autonomy envelope and evaluator changed; see artifact://internal.",
        evidenceRefs: [],
      }],
    } as never);

    const container = renderPage();
    await waitUntil(() => expect(container.textContent).toContain("Result ready for review"));
    const text = container.textContent ?? "";
    expect(text).not.toContain("result_proposal");
    expect(text).not.toContain("The Goal direction would change");
    expect(text).not.toContain("Agent working boundaries");
    expect(text).not.toContain("autonomy envelope");
    expect(text).not.toContain("evaluator");
    expect(text).not.toContain("artifact://");
    expect(text).toContain("Scope:");
    expect(text).toContain("publishing externally");
    expect(text).toContain("Your call:");
  });

  it("lets the user resume a paused Owner from the Goal Workspace", async () => {
    vi.mocked(agentsApi.list).mockResolvedValue([{ id: "agent-1", name: "Workspace owner", status: "paused" }] as never);
    vi.mocked(goalsApi.getWorkspace).mockResolvedValue({
      ...workspace,
      attention: {
        kind: "owner_blocked",
        reason: "The Agent is paused. Resume it to continue this Goal.",
        sourceId: "deferred_agent_paused",
      },
      changeProposals: [],
      resultProposals: [],
    } as never);

    const container = renderPage();
    await waitUntil(() => expect(button(container, "Resume Agent")).not.toBeNull());
    act(() => button(container, "Resume Agent")?.click());
    await waitUntil(() => expect(agentsApi.resume).toHaveBeenCalledWith("agent-1", "org-1"));
  });

  it("keeps an active Goal agreement read-only and renders its Markdown context", async () => {
    vi.mocked(goalsApi.getWorkspace).mockResolvedValue({
      ...workspace,
      goal: { ...goal, description: "Context with **verified evidence**." },
    } as never);

    const container = renderPage();
    await waitUntil(() => expect(container.textContent).toContain("verified evidence"));
    expect(button(container, "Rename")).toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("verified evidence");
  });

  it("keeps keyboard focus on the focus control after toggling", async () => {
    vi.mocked(goalsApi.getWorkspace)
      .mockResolvedValueOnce({ ...workspace, goal: { ...goal, focus: false } } as never)
      .mockResolvedValue({ ...workspace, goal: { ...goal, focus: true } } as never);
    vi.mocked(goalsApi.setFocus).mockResolvedValue({ ...goal, focus: true } as never);
    const container = renderPage();
    await waitUntil(() => expect(button(container, "Set focus")).not.toBeNull());

    act(() => button(container, "Set focus")?.click());

    await waitUntil(() => expect(button(container, "Unfocus")).not.toBeNull());
    await waitUntil(() => expect(document.activeElement).toBe(button(container, "Unfocus")));
    expect(goalsApi.setFocus).toHaveBeenCalledWith("goal-1", true);
  });

  it("restores focus after a live Goal update outruns the focus response", async () => {
    let resolveFocus!: (value: unknown) => void;
    const deferredFocus = new Promise((resolve) => {
      resolveFocus = resolve;
    });
    const unfocusedWorkspace = { ...workspace, goal: { ...goal, focus: false } };
    const focusedWorkspace = { ...workspace, goal: { ...goal, focus: true } };
    vi.mocked(goalsApi.getWorkspace)
      .mockResolvedValueOnce(unfocusedWorkspace as never)
      .mockResolvedValue(focusedWorkspace as never);
    vi.mocked(goalsApi.setFocus).mockReturnValueOnce(deferredFocus as never);
    const { container, queryClient } = renderPageWithClient();
    await waitUntil(() => expect(button(container, "Set focus")).not.toBeNull());

    act(() => button(container, "Set focus")?.click());
    await waitUntil(() => expect(goalsApi.setFocus).toHaveBeenCalledWith("goal-1", true));
    await act(async () => {
      queryClient.setQueryData(["goals", "detail", "goal-1", "workspace"], focusedWorkspace);
    });

    await waitUntil(() => expect(button(container, "Unfocus")).not.toBeNull());
    expect(document.activeElement).not.toBe(button(container, "Unfocus"));
    await act(async () => resolveFocus({ ...goal, focus: true }));
    await waitUntil(() => expect(document.activeElement).toBe(button(container, "Unfocus")));
  });

  it("renders inspectable internal, HTTPS, and Library evidence while marking opaque references unavailable", async () => {
    vi.mocked(projectsApi.list).mockResolvedValue([{
      id: "project-1",
      orgId: "org-1",
      name: "Goal Workspace release",
      urlKey: "goal-workspace-release",
      goalId: "goal-1",
      goalIds: ["goal-1"],
    }] as never);
    vi.mocked(goalsApi.getWorkspace).mockResolvedValue({
      ...workspace,
      resultProposals: [{
        ...workspace.resultProposals[0],
        proposedByAgentId: "agent-1",
        candidate: {
          evidenceRefs: [
            "issue://issue-1?comment=private-comment",
            "project://project-1?view=private-view",
            "approval://approval-1?token=private-token",
            "run://run-1?trace=private-trace",
            "https://evidence.example/release-check?receipt=public-receipt",
            "library-file://file?p=docs%2Frelease-check.md",
            "library-entry://entry-1?p=reports%2Fverification.md",
            "artifact://artifact-1?token=private-artifact-token",
            "file:///tmp/private-result.json",
            "measurement://release-latency?sample=private-sample",
          ],
          resultPayload: { internalEvidenceIndex: "private-index" },
        },
        preflight: {
          ...workspace.resultProposals[0].preflight,
          evidenceRefs: [
            "issue://issue-1?comment=private-comment",
            "project://project-1?view=private-view",
            "approval://approval-1?token=private-token",
            "run://run-1?trace=private-trace",
            "https://evidence.example/release-check?receipt=public-receipt",
            "library-file://file?p=docs%2Frelease-check.md",
            "library-entry://entry-1?p=reports%2Fverification.md",
            "artifact://artifact-1?token=private-artifact-token",
            "file:///tmp/private-result.json",
            "measurement://release-latency?sample=private-sample",
          ],
        },
      }],
    } as never);

    const container = renderPage();
    await waitUntil(() => expect(container.querySelector('[aria-label="Result evidence"]')?.querySelectorAll("a")).toHaveLength(7));
    const evidence = container.querySelector<HTMLElement>('[aria-label="Result evidence"]')!;
    expect(evidence.textContent).toContain("Issue GW-1: Verify the operator workflow");
    expect(evidence.textContent).toContain("Project: Goal Workspace release");
    expect(evidence.textContent).toContain("Approval evidence 3");
    expect(evidence.textContent).toContain("Supporting work 4");
    expect(evidence.textContent).not.toContain("Agent run evidence");
    expect(evidence.textContent).toContain("External link evidence 5");
    expect(evidence.textContent).toContain("Library file: release-check.md");
    expect(evidence.textContent).toContain("Library entry: verification.md");
    expect(evidence.textContent).toContain("Artifact evidence 8");
    expect(evidence.textContent).toContain("File evidence 9");
    expect(evidence.textContent).toContain("Measurement evidence 10");
    expect(evidence.textContent?.match(/Unavailable/g)).toHaveLength(3);
    expect(evidence.querySelectorAll("a")).toHaveLength(7);
    expect(evidence.querySelector('a[href="/issues/GW-1"]')).not.toBeNull();
    expect(evidence.querySelector('a[href="/projects/goal-workspace-release"]')).not.toBeNull();
    expect(evidence.querySelector('a[href="/messenger/approvals/approval-1"]')).not.toBeNull();
    expect(evidence.querySelector('a[href="/agents/agent-1/runs/run-1"]')).not.toBeNull();
    const externalLink = evidence.querySelector<HTMLAnchorElement>('a[href="https://evidence.example/release-check?receipt=public-receipt"]');
    expect(externalLink?.target).toBe("_blank");
    expect(externalLink?.rel).toBe("noopener noreferrer");
    const evidenceHrefs = Array.from(evidence.querySelectorAll("a")).map((link) => link.getAttribute("href"));
    expect(evidenceHrefs).toContain("/library?path=docs%2Frelease-check.md");
    expect(evidenceHrefs).toContain("/library?entry=entry-1&path=reports%2Fverification.md");
    expect(evidence.querySelectorAll("a")[0]?.textContent).toContain("Open");
    expect(evidence.textContent).not.toContain("https://");
    for (const privateValue of [
      "issue://",
      "project://",
      "approval://",
      "run://",
      "library-file://",
      "library-entry://",
      "artifact://",
      "file://",
      "measurement://",
      "private-comment",
      "private-view",
      "private-token",
      "private-trace",
      "private-artifact-token",
      "private-result.json",
      "private-sample",
      "internalEvidenceIndex",
      "private-index",
      "resultPayload",
    ]) {
      expect(evidence.innerHTML).not.toContain(privateValue);
    }
  });

  it("keeps a supported negative result inspectable without leaking evidence references or contract keys", async () => {
    vi.mocked(goalsApi.getWorkspace).mockResolvedValue({
      ...workspace,
      resultProposals: [{
        ...workspace.resultProposals[0],
        candidateHash: "negative-private-hash",
        candidate: {
          evidenceRefs: ["run://goal-workspace/failed-restart", "https://evidence.example/verification"],
          resultPayload: { internalVerdict: "do-not-render" },
        },
        preflight: {
          mode: "target",
          outcome: "not_achieved",
          criteria: [
            { id: "workflow", evaluator: "artifact", status: "unmet", evidenceSatisfied: true, missingEvidence: [] },
            {
              id: "restart",
              evaluator: "artifact",
              status: "unknown",
              evidenceSatisfied: false,
              missingEvidence: ["artifact://goal-workspace/private-restart-proof"],
            },
          ],
          evidenceRefs: ["run://goal-workspace/failed-restart", "https://evidence.example/verification"],
          decision: null,
          evaluatedAt: "2026-08-05T00:50:00.000Z",
        },
        riskSummary: "Restart recovery still fails under load.",
      }],
    } as never);

    const container = renderPage();
    await waitUntil(() => expect(container.querySelector('[aria-label="Goal result proposal"]')).not.toBeNull());
    const resultBlock = container.querySelector<HTMLElement>('[aria-label="Goal result proposal"]')!;
    expect(resultBlock.textContent).toContain("Goal not achieved");
    expect(resultBlock.textContent).toContain("The operator workflow passes");
    expect(resultBlock.textContent).toContain("Not met");
    expect(resultBlock.textContent).toContain("Restart recovery remains reliable");
    expect(resultBlock.textContent).toContain("Not verified");
    expect(resultBlock.textContent).toContain("Restart recovery still fails under load.");
    expect(resultBlock.textContent).toContain("Restart recovery remains reliable still needs artifact evidence.");
    expect(resultBlock.textContent).toContain("The submitted evidence supports closing this Goal as not achieved.");
    expect(resultBlock.textContent).toContain("1 criterion remains unverified.");
    expect(resultBlock.textContent).toContain("Supporting work 1");
    expect(resultBlock.textContent).not.toContain("Agent run evidence");
    expect(resultBlock.textContent).toContain("External link evidence 2");
    expect(resultBlock.textContent).toContain("Unavailable");
    const externalLink = resultBlock.querySelector<HTMLAnchorElement>('a[href="https://evidence.example/verification"]');
    expect(externalLink?.target).toBe("_blank");
    expect(externalLink?.rel).toBe("noopener noreferrer");
    expect(resultBlock.textContent).not.toContain("https://");
    for (const privateValue of [
      "run://goal-workspace/failed-restart",
      "artifact://goal-workspace/private-restart-proof",
      "negative-private-hash",
      "do-not-render",
      "candidateHash",
      "resultPayload",
      "internalVerdict",
      "evaluator",
      "evidenceSatisfied",
      "missingEvidence",
    ]) {
      expect(resultBlock.innerHTML).not.toContain(privateValue);
    }
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

  it("removes failed feedback actions when the Goal closes during recovery", async () => {
    vi.mocked(goalsApi.feedback).mockRejectedValueOnce(new Error("Network interrupted"));
    vi.mocked(goalsApi.getWorkspace)
      .mockResolvedValueOnce(workspace as never)
      .mockResolvedValue({
        ...workspace,
        goal: {
          ...goal,
          lifecycle: "closed",
          status: "achieved",
          focus: false,
          evaluationResult: { outcome: "achieved" },
        },
        facet: "closed",
        attention: null,
        changeProposals: [],
        resultProposals: [{ ...workspace.resultProposals[0], status: "accepted" }],
      } as never);
    const container = renderPage();
    await waitUntil(() => expect(container.querySelector('[aria-label="Goal feedback"]')).not.toBeNull());
    change(container.querySelector<HTMLTextAreaElement>('[aria-label="Goal feedback"]')!, "This feedback may race with acceptance.");
    act(() => button(container, "Send feedback")?.click());
    await waitUntil(() => expect(button(container, "Retry feedback")).not.toBeNull());

    act(() => button(container, "Accept result")?.click());

    await waitUntil(() => expect(container.textContent).toContain("Result accepted"));
    expect(button(container, "Retry feedback")).toBeNull();
    expect(container.textContent).not.toContain("This feedback may race with acceptance.");
    expect(container.querySelector('[aria-label="Goal feedback"]')).toBeNull();
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
    await waitUntil(() => expect(document.activeElement?.textContent).toContain("Needs your attention"));

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

  it.each([
    { name: "change approval", proposal: "change", action: "Approve" },
    { name: "change rejection", proposal: "change", action: "Reject" },
    { name: "result acceptance", proposal: "result", action: "Accept result" },
    { name: "result rejection", proposal: "result", action: "Result is not sufficient" },
  ])("restores focus to the Goal workspace after $name removes the proposal", async ({ proposal, action }) => {
    vi.mocked(goalsApi.getWorkspace)
      .mockResolvedValueOnce(workspace as never)
      .mockResolvedValue({
        ...workspace,
        attention: null,
        changeProposals: [],
        resultProposals: [],
      } as never);
    const container = renderPage();
    await waitUntil(() => expect(container.querySelector(`[aria-label="Goal ${proposal} proposal"]`)).not.toBeNull());
    if (proposal === "result" && action === "Result is not sufficient") {
      const feedback = container.querySelector<HTMLTextAreaElement>('[aria-label="Why is this result not sufficient?"]')!;
      change(feedback, "The result needs another verification pass.");
    }
    act(() => button(container, action)?.click());

    await waitUntil(() => expect(container.querySelector(`[aria-label="Goal ${proposal} proposal"]`)).toBeNull());
    await waitUntil(() => expect(document.activeElement?.textContent).toBe("Outcome"));
  });

  it.each([
    { decision: "accept", action: "Accept result", settledStatus: "accepted" },
    { decision: "reject", action: "Result is not sufficient", settledStatus: "rejected" },
  ] as const)("waits for a stale result proposal to become $settledStatus before restoring focus", async ({ decision, action, settledStatus }) => {
    const staleWorkspace = {
      ...workspace,
      attention: workspace.attention ? { ...workspace.attention } : null,
      changeProposals: workspace.changeProposals.map((proposal) => ({ ...proposal })),
      resultProposals: workspace.resultProposals.map((proposal) => ({ ...proposal })),
    };
    const settledWorkspace = {
      ...workspace,
      goal: decision === "accept"
        ? { ...goal, lifecycle: "closed", status: "achieved", focus: false, evaluationResult: { outcome: "achieved" } }
        : goal,
      attention: null,
      changeProposals: [],
      resultProposals: [{ ...workspace.resultProposals[0], status: settledStatus }],
    };
    vi.mocked(goalsApi.getWorkspace)
      .mockResolvedValueOnce(workspace as never)
      .mockResolvedValueOnce(staleWorkspace as never)
      .mockResolvedValueOnce(settledWorkspace as never);
    const { container, queryClient } = renderPageWithClient();
    await waitUntil(() => expect(container.querySelector('[aria-label="Goal result proposal"]')).not.toBeNull());
    if (decision === "reject") {
      const feedback = container.querySelector<HTMLTextAreaElement>('[aria-label="Why is this result not sufficient?"]')!;
      change(feedback, "The result needs another verification pass.");
    }
    act(() => button(container, action)?.click());

    await waitUntil(() => expect(goalsApi.getWorkspace).toHaveBeenCalledTimes(2));
    expect(container.querySelector('[aria-label="Goal result proposal"]')).not.toBeNull();
    const attentionHeading = Array.from(container.querySelectorAll("h2"))
      .find((heading) => heading.textContent === "Needs your attention");
    expect(document.activeElement).not.toBe(attentionHeading);

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.goals.detail("goal-1") });
    });
    await waitUntil(() => expect(container.querySelector('[aria-label="Goal result proposal"]')).toBeNull());
    await waitUntil(() => expect(document.activeElement?.textContent).toBe("Outcome"));
  });

  it.each([
    { decision: "accept", action: "Accept result", settledStatus: "accepted" },
    { decision: "reject", action: "Result is not sufficient", settledStatus: "rejected" },
  ] as const)("restores final focus after a live update outruns the $decision response", async ({ decision, action, settledStatus }) => {
    let resolveDecision!: (value: unknown) => void;
    const deferredDecision = new Promise((resolve) => {
      resolveDecision = resolve;
    });
    if (decision === "accept") {
      vi.mocked(goalsApi.acceptResultProposal).mockReturnValueOnce(deferredDecision as never);
    } else {
      vi.mocked(goalsApi.rejectResultProposal).mockReturnValueOnce(deferredDecision as never);
    }
    const settledWorkspace = {
      ...workspace,
      goal: decision === "accept"
        ? { ...goal, lifecycle: "closed", status: "achieved", focus: false, evaluationResult: { outcome: "achieved" } }
        : goal,
      attention: null,
      changeProposals: [],
      resultProposals: [{ ...workspace.resultProposals[0], status: settledStatus }],
    };
    vi.mocked(goalsApi.getWorkspace)
      .mockResolvedValueOnce(workspace as never)
      .mockResolvedValue(settledWorkspace as never);
    const { container, queryClient } = renderPageWithClient();
    await waitUntil(() => expect(container.querySelector('[aria-label="Goal result proposal"]')).not.toBeNull());
    if (decision === "reject") {
      const feedback = container.querySelector<HTMLTextAreaElement>('[aria-label="Why is this result not sufficient?"]')!;
      change(feedback, "The live update arrived before the HTTP response.");
    }
    act(() => button(container, action)?.click());
    await waitUntil(() => expect(
      decision === "accept" ? goalsApi.acceptResultProposal : goalsApi.rejectResultProposal,
    ).toHaveBeenCalledTimes(1));

    await act(async () => {
      queryClient.setQueryData(["goals", "detail", "goal-1", "workspace"], settledWorkspace);
    });

    await waitUntil(() => expect(container.querySelector('[aria-label="Goal result proposal"]')).toBeNull());
    expect(document.activeElement?.textContent).not.toBe("Outcome");
    await act(async () => resolveDecision({ id: "result-1", status: settledStatus }));
    await waitUntil(() => expect(goalsApi.getWorkspace).toHaveBeenCalledTimes(2));
    await waitUntil(() => expect(document.activeElement?.textContent).toBe("Outcome"));
  });

  it("does not carry a pending decision focus request into another Goal", async () => {
    let releaseFirstGoalRefetch!: () => void;
    const firstGoalRefetch = new Promise<never>((resolve) => {
      releaseFirstGoalRefetch = () => resolve({ ...workspace, resultProposals: [] } as never);
    });
    const secondGoalWorkspace = {
      ...workspace,
      goal: { ...goal, id: "goal-2", title: "A different Goal" },
      attention: null,
      changeProposals: [],
      resultProposals: [],
    };
    vi.mocked(goalsApi.getWorkspace)
      .mockResolvedValueOnce(workspace as never)
      .mockImplementationOnce(() => firstGoalRefetch)
      .mockResolvedValueOnce(secondGoalWorkspace as never);
    const { container, rerender } = renderPageWithClient();
    await waitUntil(() => expect(container.querySelector('[aria-label="Goal result proposal"]')).not.toBeNull());
    act(() => button(container, "Accept result")?.click());
    await waitUntil(() => expect(goalsApi.getWorkspace).toHaveBeenCalledTimes(2));

    routeGoalId = "goal-2";
    rerender();
    await waitUntil(() => expect(container.textContent).toContain("A different Goal"));
    await act(async () => releaseFirstGoalRefetch());

    const secondGoalHeading = Array.from(container.querySelectorAll("h2"))
      .find((heading) => heading.textContent === "Outcome");
    expect(document.activeElement).not.toBe(secondGoalHeading);
  });

  it("preserves decision input and offers explicit retries after mutation errors", async () => {
    vi.mocked(goalsApi.decideChangeProposal)
      .mockRejectedValueOnce(new Error("Change decision could not be saved"))
      .mockResolvedValueOnce({ id: "change-1", status: "rejected" } as never);
    vi.mocked(goalsApi.rejectResultProposal)
      .mockRejectedValueOnce(new Error("Result feedback could not be saved"))
      .mockResolvedValueOnce({ id: "result-1", status: "rejected" } as never);
    const container = renderPage();
    await waitUntil(() => expect(container.querySelector('[aria-label="Goal change proposal"]')).not.toBeNull());

    const changeBlock = container.querySelector<HTMLElement>('[aria-label="Goal change proposal"]')!;
    const decisionNote = changeBlock.querySelector<HTMLInputElement>("input")!;
    change(decisionNote, "Keep the current outcome boundary.");
    act(() => button(changeBlock, "Reject")?.click());
    await waitUntil(() => expect(changeBlock.querySelector('[role="alert"]')?.textContent).toContain("Change decision could not be saved"));
    expect(decisionNote.value).toBe("Keep the current outcome boundary.");
    expect(button(changeBlock, "Retry reject")?.hasAttribute("disabled")).toBe(false);
    act(() => button(changeBlock, "Retry reject")?.click());
    await waitUntil(() => expect(goalsApi.decideChangeProposal).toHaveBeenCalledTimes(2));
    expect(vi.mocked(goalsApi.decideChangeProposal).mock.calls[0]?.[1]).toEqual({
      decision: "reject",
      note: "Keep the current outcome boundary.",
    });
    expect(vi.mocked(goalsApi.decideChangeProposal).mock.calls[1]?.[1]).toEqual({
      decision: "reject",
      note: "Keep the current outcome boundary.",
    });

    const resultBlock = container.querySelector<HTMLElement>('[aria-label="Goal result proposal"]')!;
    const resultFeedback = resultBlock.querySelector<HTMLTextAreaElement>('[aria-label="Why is this result not sufficient?"]')!;
    change(resultFeedback, "Repeat the restart verification.");
    act(() => button(resultBlock, "Result is not sufficient")?.click());
    await waitUntil(() => expect(resultBlock.querySelector('[role="alert"]')?.textContent).toContain("Result feedback could not be saved"));
    expect(resultFeedback.value).toBe("Repeat the restart verification.");
    expect(button(resultBlock, "Retry rejection")?.hasAttribute("disabled")).toBe(false);
    act(() => button(resultBlock, "Retry rejection")?.click());
    await waitUntil(() => expect(goalsApi.rejectResultProposal).toHaveBeenCalledTimes(2));
    const firstResultPayload = vi.mocked(goalsApi.rejectResultProposal).mock.calls[0]?.[1] as Record<string, unknown>;
    const retriedResultPayload = vi.mocked(goalsApi.rejectResultProposal).mock.calls[1]?.[1] as Record<string, unknown>;
    expect(firstResultPayload.feedback).toBe("Repeat the restart verification.");
    expect(retriedResultPayload.feedback).toBe("Repeat the restart verification.");
    expect(retriedResultPayload.idempotencyKey).toBe(firstResultPayload.idempotencyKey);
  });

  it("loads earlier history without duplicates, preserves actor identity, and keeps attachment links safe", async () => {
    vi.mocked(goalsApi.getWorkspace).mockResolvedValue({
      ...workspace,
      timelineNextCursor: "history-cursor-1",
      timeline: [
        {
          ...workspace.timeline[0],
          kind: "activity",
          actorType: "agent",
          actorId: "agent-1",
          attachments: [],
        },
        {
          id: "current-user-feedback",
          kind: "feedback",
          summary: "Keep the customer-visible outcome explicit.",
          createdAt: "2026-08-05T00:25:00.000Z",
          evidenceRefs: [],
          actorType: "user",
          actorId: "user-1",
          actorName: "Operator",
          attachments: [],
        },
      ],
    } as never);
    vi.mocked(goalsApi.getHistory)
      .mockRejectedValueOnce(new Error("Earlier records are temporarily unavailable"))
      .mockResolvedValueOnce({
        items: [
          {
            id: "shared-id",
            kind: "feedback",
            summary: "A collaborator clarified the acceptance boundary.",
            createdAt: "2026-08-04T23:59:00.000Z",
            evidenceRefs: [],
            actorType: "user",
            actorId: "user-2",
            actorName: "Collaborator",
            attachments: [
              {
                name: "acceptance.txt",
                mimeType: "text/plain",
                size: 128,
                contentPath: "/api/assets/00000000-0000-4000-8000-000000000001/content",
                uri: "https://must-not-render.example/private",
              },
              {
                name: "legacy-note.txt",
                mimeType: "text/plain",
                size: 64,
                contentPath: null,
                uri: "https://must-not-render.example/legacy",
              },
            ],
          },
          {
            id: "shared-id",
            kind: "activity",
            summary: "A former owner recorded a durable checkpoint.",
            createdAt: "2026-08-04T23:58:00.000Z",
            evidenceRefs: [],
            actorType: "agent",
            actorId: "removed-agent",
            actorName: "Former agent",
            attachments: [],
          },
          {
            ...workspace.timeline[0],
            kind: "activity",
            actorType: "agent",
            actorId: "agent-1",
            attachments: [],
          },
        ],
        nextCursor: null,
      } as never);
    const container = renderPage();
    await waitUntil(() => expect(button(container, "Load earlier records")).not.toBeNull());
    expect(container.textContent).toContain("You");

    const load = button(container, "Load earlier records")!;
    act(() => {
      load.focus();
      load.click();
    });
    await waitUntil(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("Earlier records are temporarily unavailable"));
    expect(document.activeElement).toBe(button(container, "Retry earlier records"));

    act(() => button(container, "Retry earlier records")?.click());
    await waitUntil(() => expect(container.textContent).toContain("A collaborator clarified the acceptance boundary."));
    expect(goalsApi.getHistory).toHaveBeenNthCalledWith(1, "goal-1", "history-cursor-1");
    expect(goalsApi.getHistory).toHaveBeenNthCalledWith(2, "goal-1", "history-cursor-1");
    expect(container.textContent).toContain("Collaborator");
    expect(container.textContent).toContain("Former agent");
    expect(container.textContent?.match(/The real operator workflow passed\./g)).toHaveLength(1);
    expect(container.textContent).not.toContain("must-not-render.example");
    expect(button(container, "Load earlier records")).toBeNull();
    expect(document.activeElement?.textContent).toContain("A collaborator clarified the acceptance boundary.");

    const safeAttachment = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[aria-label], a'))
      .find((anchor) => anchor.textContent?.includes("acceptance.txt"));
    expect(safeAttachment?.getAttribute("href")).toBe("/api/assets/00000000-0000-4000-8000-000000000001/content");
    expect(Array.from(container.querySelectorAll("a")).some((anchor) => anchor.textContent?.includes("legacy-note.txt"))).toBe(false);
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
