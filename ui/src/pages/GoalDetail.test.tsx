// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Goal, GoalDependencies } from "@rudderhq/shared";
import { queryKeys } from "../lib/queryKeys";
import { GoalDetail } from "./GoalDetail";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const goal: Goal = {
  id: "goal-1",
  orgId: "org-1",
  title: "Lifecycle controls hardening",
  description: "Verify hard delete and cancel paths.",
  level: "task",
  status: "active",
  parentId: "parent-goal",
  ownerAgentId: null,
  createdAt: new Date("2026-04-30T08:00:00.000Z"),
  updatedAt: new Date("2026-04-30T08:00:00.000Z"),
};

const parentGoal: Goal = {
  id: "parent-goal",
  orgId: "org-1",
  title: "Goal Center rollout",
  description: "Ship the Goal Center operating surface.",
  level: "team",
  status: "active",
  parentId: null,
  ownerAgentId: null,
  createdAt: new Date("2026-04-30T07:00:00.000Z"),
  updatedAt: new Date("2026-04-30T07:00:00.000Z"),
};

const safeDependencies: GoalDependencies = {
  goalId: "goal-1",
  orgId: "org-1",
  canDelete: true,
  blockers: [],
  isLastRootOrganizationGoal: false,
  counts: {
    childGoals: 0,
    linkedProjects: 0,
    linkedIssues: 0,
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

const blockedDependencies: GoalDependencies = {
  goalId: "goal-1",
  orgId: "org-1",
  canDelete: false,
  blockers: ["linked_issues"],
  isLastRootOrganizationGoal: false,
  counts: {
    childGoals: 0,
    linkedProjects: 0,
    linkedIssues: 1,
    automations: 0,
    costEvents: 0,
    financeEvents: 0,
  },
  previews: {
    childGoals: [],
    linkedProjects: [],
    linkedIssues: [
      { id: "issue-1", title: "Keep history on cancel", subtitle: "RAA-10" },
    ],
    automations: [],
  },
};

const mockState = vi.hoisted(() => ({
  activity: [
    {
      id: "evt-1",
      action: "goal.updated",
      createdAt: new Date("2026-04-30T08:00:00.000Z"),
    },
  ],
  dependencies: null as GoalDependencies | null,
  panelNode: null as ReactNode | null,
  setBreadcrumbs: vi.fn(),
  setSelectedOrganizationId: vi.fn(),
}));

const invalidateQueries = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());
const mockGoalsApi = vi.hoisted(() => ({
  remove: vi.fn(async () => goal),
  update: vi.fn(async (_id: string, data: Record<string, unknown>) => ({ ...goal, ...data })),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey, enabled }: { queryKey: readonly unknown[]; enabled?: boolean }) => {
    if (enabled === false) return { data: undefined, isLoading: false, error: null };
    if (queryKey[0] === "goals" && queryKey[1] === "detail" && queryKey[3] === "dependencies") {
      return { data: mockState.dependencies, isLoading: false, error: null };
    }
    if (queryKey[0] === "goals" && queryKey[1] === "detail") {
      return { data: goal, isLoading: false, error: null };
    }
    if (queryKey[0] === "goals" && queryKey.length === 2) {
      return { data: [parentGoal, goal], isLoading: false, error: null };
    }
    if (queryKey[0] === "goals" && queryKey[1] === "activity") {
      return { data: mockState.activity, isLoading: false, error: null };
    }
    if (queryKey[0] === "projects") return { data: [], isLoading: false, error: null };
    if (queryKey[0] === "issues") return { data: [], isLoading: false, error: null };
    if (queryKey[0] === "agents") return { data: [], isLoading: false, error: null };
    return { data: undefined, isLoading: false, error: null };
  },
  useMutation: (options: {
    mutationFn: (variables?: unknown) => Promise<unknown> | unknown;
    onSuccess?: (data: unknown) => void;
    onError?: (error: unknown) => void;
  }) => ({
    mutate: (variables?: unknown) => {
      Promise.resolve(options.mutationFn(variables))
        .then((data) => {
          options.onSuccess?.(data);
        })
        .catch((error) => {
          options.onError?.(error);
        });
    },
    mutateAsync: async (variables?: unknown) => {
      try {
        const data = await options.mutationFn(variables);
        options.onSuccess?.(data);
        return data;
      } catch (error) {
        options.onError?.(error);
        throw error;
      }
    },
    isPending: false,
    error: null,
  }),
  useQueryClient: () => ({
    invalidateQueries,
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => mockNavigate,
  useParams: () => ({ goalId: "goal-1" }),
}));

vi.mock("../context/OrganizationContext", () => ({
  useOrganization: () => ({
    selectedOrganizationId: "org-1",
    setSelectedOrganizationId: mockState.setSelectedOrganizationId,
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    openNewGoal: vi.fn(),
  }),
}));

vi.mock("../context/PanelContext", () => ({
  usePanel: () => ({
    openPanel: (node: ReactNode) => {
      mockState.panelNode = node;
    },
    closePanel: vi.fn(),
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockState.setBreadcrumbs,
  }),
}));

vi.mock("../api/goals", () => ({
  goalsApi: {
    get: vi.fn(),
    list: vi.fn(),
    dependencies: vi.fn(),
    remove: mockGoalsApi.remove,
    update: mockGoalsApi.update,
  },
}));

vi.mock("../components/InlineEditor", () => ({
  InlineEditor: ({
    value,
    as = "div",
    className,
  }: {
    value: string;
    as?: keyof HTMLElementTagNameMap;
    className?: string;
  }) => {
    const Tag = as;
    return <Tag className={className}>{value}</Tag>;
  },
}));

vi.mock("../components/GoalTree", () => ({
  GoalTree: () => <div data-testid="goal-tree" />,
}));

vi.mock("../components/EntityRow", () => ({
  EntityRow: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock("../components/StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("../components/PageSkeleton", () => ({
  PageSkeleton: () => <div>Loading...</div>,
}));

let cleanupFn: (() => void) | null = null;

function renderGoalDetail() {
  const pageContainer = document.createElement("div");
  const panelContainer = document.createElement("div");
  document.body.append(pageContainer, panelContainer);
  const pageRoot = createRoot(pageContainer);
  const panelRoot = createRoot(panelContainer);

  cleanupFn = () => {
    act(() => {
      panelRoot.unmount();
      pageRoot.unmount();
    });
    pageContainer.remove();
    panelContainer.remove();
  };

  act(() => {
    pageRoot.render(<GoalDetail />);
  });

  expect(mockState.panelNode).toBeTruthy();

  act(() => {
    panelRoot.render(mockState.panelNode);
  });

  return { pageContainer, panelContainer };
}

beforeEach(() => {
  document.body.innerHTML = "";
  cleanupFn = null;
  invalidateQueries.mockReset();
  mockNavigate.mockReset();
  mockGoalsApi.remove.mockClear();
  mockGoalsApi.update.mockClear();
  mockState.panelNode = null;
  mockState.dependencies = safeDependencies;
  mockState.setBreadcrumbs.mockReset();
  mockState.setSelectedOrganizationId.mockReset();
});

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  document.body.innerHTML = "";
});

describe("GoalDetail", () => {
  it("shows ancestor breadcrumbs and returns to the parent goal on Escape", () => {
    renderGoalDetail();

    expect(mockState.setBreadcrumbs).toHaveBeenLastCalledWith([
      { label: "Goals", href: "/goals" },
      { label: parentGoal.title, href: `/goals/${parentGoal.id}` },
      { label: goal.title },
    ]);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(mockNavigate).toHaveBeenCalledWith(`/goals/${parentGoal.id}`);
  });

  it("does not use Escape navigation while editing text", () => {
    renderGoalDetail();
    const input = document.createElement("input");
    document.body.appendChild(input);

    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(mockNavigate).not.toHaveBeenCalled();
    input.remove();
  });

  it("surfaces the completion signal separately from goal status", () => {
    const { pageContainer } = renderGoalDetail();

    expect(pageContainer.textContent).toContain("Completion");
    expect(pageContainer.textContent).toContain("Needs evidence");
  });

  it("hard-deletes a safe goal from the lifecycle panel", async () => {
    mockState.dependencies = safeDependencies;
    const { panelContainer } = renderGoalDetail();

    const deleteButton = Array.from(panelContainer.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Delete goal"));
    expect(deleteButton).toBeTruthy();

    act(() => {
      deleteButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const confirmButton = Array.from(panelContainer.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Confirm delete"));
    expect(confirmButton).toBeTruthy();

    await act(async () => {
      confirmButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(mockGoalsApi.remove).toHaveBeenCalledWith("goal-1");
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.goals.list("org-1"),
    });
    expect(mockNavigate).toHaveBeenCalledWith("/goals");
  });

  it("refreshes goal activity after cancelling a blocked goal", async () => {
    mockState.dependencies = blockedDependencies;
    const { panelContainer } = renderGoalDetail();

    const cancelButton = Array.from(panelContainer.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Cancel goal"));
    expect(cancelButton).toBeTruthy();

    await act(async () => {
      cancelButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(mockGoalsApi.update).toHaveBeenCalledWith("goal-1", { status: "cancelled" });
    expect(invalidateQueries.mock.calls).toContainEqual([
      { queryKey: queryKeys.goals.activity("org-1", "goal-1") },
    ]);
  });
});
