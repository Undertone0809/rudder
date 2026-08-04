// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoalDetail } from "./GoalDetail";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const goal = {
  id: "goal-1",
  orgId: "org-1",
  title: "Restore goal lifecycle controls",
  description: "Goal detail should expose lifecycle operations.",
  level: "task",
  status: "active",
  parentId: null,
  ownerAgentId: "agent-1",
  lifecycle: "active",
  objectiveMode: "target",
  contractRevision: 1,
  outcomeStatement: "The linked work is verified",
  criteria: [
    { id: "outcome", label: "The linked work is verified", evaluator: "artifact" },
    { id: "safety", label: "The result stays within the safety boundary", evaluator: "policy" },
  ],
  planRevision: 1,
  plan: {
    id: "plan-1",
    orgId: "org-1",
    goalId: "goal-1",
    revision: 1,
    summary: "Verify linked work",
    hypotheses: [],
    selectedPaths: [],
    rejectedPaths: [],
    sequencing: [],
    budgetAllocations: {},
    invalidationConditions: [],
    createdByAgentId: null,
    createdAt: new Date("2026-05-04T00:05:00.000Z"),
    updatedAt: new Date("2026-05-04T00:05:00.000Z"),
  },
  activities: [{
    id: "goal-activity-1",
    orgId: "org-1",
    goalId: "goal-1",
    contractRevision: 1,
    submittedByAgentId: null,
    agentOwnerRefAtTime: "agent-1",
    commitmentRef: null,
    runRef: null,
    activityKind: "progress",
    summary: "Verified linked work",
    evidenceRefs: [],
    idempotencyKey: null,
    occurredAt: new Date("2026-05-04T00:11:00.000Z"),
    createdAt: new Date("2026-05-04T00:11:00.000Z"),
  }],
  createdAt: new Date("2026-05-04T00:00:00.000Z"),
  updatedAt: new Date("2026-05-04T00:10:00.000Z"),
};

let queryGoal = goal;

const childGoal = {
  ...goal,
  id: "goal-child",
  title: "Keep delete safety visible",
  level: "task",
  parentId: "goal-1",
};

const issue = {
  id: "issue-1",
  orgId: "org-1",
  title: "Verify linked work",
  description: null,
  status: "todo",
  priority: "medium",
  identifier: "GLC-1",
  goalId: "goal-1",
};

const dependencies = {
  goalId: "goal-1",
  orgId: "org-1",
  canDelete: false,
  blockers: ["child_goals", "linked_issues"],
  isLastRootOrganizationGoal: false,
  counts: {
    childGoals: 1,
    linkedProjects: 0,
    linkedIssues: 1,
    automations: 0,
    costEvents: 0,
    financeEvents: 0,
  },
  previews: {
    childGoals: [{ id: "goal-child", title: "Keep delete safety visible", subtitle: "active" }],
    linkedProjects: [],
    linkedIssues: [{ id: "issue-1", title: "Verify linked work", subtitle: "GLC-1" }],
    automations: [],
    calendarEvents: [{ id: "calendar-event-1", title: "Goal review", subtitle: "scheduled" }],
  },
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey, enabled }: { queryKey: readonly unknown[]; enabled?: boolean }) => {
    if (enabled === false) {
      return { data: undefined, isLoading: false, error: null };
    }
    if (queryKey[0] === "goals" && queryKey[1] === "detail" && queryKey[3] === "dependencies") {
      return { data: dependencies, isLoading: false, error: null };
    }
    if (queryKey[0] === "goals" && queryKey[1] === "detail") {
      return { data: queryGoal, isLoading: false, error: null };
    }
    if (queryKey[0] === "goals" && queryKey[1] === "org-1") {
      return { data: [goal, childGoal], isLoading: false, error: null };
    }
    if (queryKey[0] === "issues") {
      return { data: [issue], isLoading: false, error: null };
    }
    if (queryKey[0] === "projects") {
      return { data: [], isLoading: false, error: null };
    }
    if (queryKey[0] === "agents") {
      return { data: [{ id: "agent-1", name: "Goal owner" }], isLoading: false, error: null };
    }
    return { data: [], isLoading: false, error: null };
  },
  useMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    error: null,
  }),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useParams: () => ({ goalId: "goal-1" }),
}));

vi.mock("../context/OrganizationContext", () => ({
  useOrganization: () => ({
    selectedOrganizationId: "org-1",
    setSelectedOrganizationId: vi.fn(),
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    openNewGoal: vi.fn(),
    confirm: vi.fn(),
    promptText: vi.fn(),
  }),
}));

vi.mock("../context/PanelContext", () => ({
  usePanel: () => ({
    openPanel: vi.fn(),
    closePanel: vi.fn(),
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({
    pushToast: vi.fn(),
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: vi.fn(),
  }),
}));

vi.mock("../components/InlineEditor", () => ({
  InlineEditor: ({ value, as: Tag = "span" }: { value: string; as?: "h2" | "p" | "span" }) => (
    <Tag>{value}</Tag>
  ),
}));

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
  queryGoal = goal;
});

function renderPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  cleanupFn = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };

  act(() => {
    root.render(<GoalDetail />);
  });

  return container;
}

describe("GoalDetail", () => {
  it("renders the Goal Contract surface and linked work", async () => {
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Contract");
    expect(container.textContent).toContain("Plan");
    expect(container.textContent).toContain("Owner and continuation");
    expect(container.textContent).toContain("Evaluate");
    expect(container.textContent).toContain("Activity");
    expect(container.textContent).toContain("Linked work");
    expect(container.textContent).not.toContain("Deletion blockers");
    expect(container.textContent).not.toContain("Keep delete safety visible");
    expect(container.textContent).not.toContain("Goal review");
    expect(container.textContent).toContain("Goal owner");
    expect(container.textContent).toContain("The linked work is verified");
    expect(container.querySelector('[aria-label="Criterion result: The linked work is verified"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Criterion result: The result stays within the safety boundary"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Activity summary"]')).not.toBeNull();
    expect(container.textContent).toContain("Verify linked work");
    expect(container.textContent).toContain("Verified linked work");
  });

  it("renders evaluator-specific inputs for metric and human criteria", async () => {
    queryGoal = {
      ...goal,
      criteria: [
        { id: "metric", label: "The target result is measurable", evaluator: "metric" },
        { id: "human", label: "The target result is approved", evaluator: "human" },
      ],
    };
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('[aria-label="Observed result"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Human decision"]')).not.toBeNull();
  });
});
