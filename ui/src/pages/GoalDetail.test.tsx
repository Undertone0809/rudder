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
  level: "team",
  status: "active",
  parentId: null,
  ownerAgentId: null,
  createdAt: new Date("2026-05-04T00:00:00.000Z"),
  updatedAt: new Date("2026-05-04T00:10:00.000Z"),
};

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
    childGoals: [],
    linkedProjects: [],
    linkedIssues: [],
    automations: [],
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
    if (queryKey[0] === "goals" && queryKey[1] === "detail" && queryKey[3] === "activity") {
      return {
        data: [{
          id: "activity-1",
          orgId: "org-1",
          actorType: "user",
          actorId: "user-1",
          agentId: null,
          action: "goal.updated",
          entityType: "goal",
          entityId: "goal-1",
          details: {},
          createdAt: new Date("2026-05-04T00:11:00.000Z"),
        }],
        isLoading: false,
        error: null,
      };
    }
    if (queryKey[0] === "goals" && queryKey[1] === "detail") {
      return { data: goal, isLoading: false, error: null };
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
      return { data: [], isLoading: false, error: null };
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
  it("renders lifecycle actions and restored detail tabs", async () => {
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Edit");
    expect(container.textContent).toContain("Delete");
    expect(container.textContent).toContain("Work (1)");
    expect(container.textContent).toContain("Sub-Goals (1)");
    expect(container.textContent).toContain("Activity (1)");
    expect(container.textContent).toContain("Issues (1)");
    expect(container.textContent).toContain("Verify linked work");
  });
});
