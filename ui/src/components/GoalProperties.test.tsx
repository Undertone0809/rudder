// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Goal, GoalDependencies } from "@rudderhq/shared";
import { GoalProperties } from "./GoalProperties";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const baseGoal: Goal = {
  id: "goal-1",
  orgId: "org-1",
  title: "Goal Center",
  description: null,
  level: "organization",
  status: "active",
  parentId: null,
  ownerAgentId: null,
  createdAt: new Date("2026-04-30T08:00:00.000Z"),
  updatedAt: new Date("2026-04-30T08:00:00.000Z"),
};

const blockedDependencies: GoalDependencies = {
  goalId: "goal-1",
  orgId: "org-1",
  canDelete: false,
  blockers: ["child_goals", "linked_projects", "linked_issues", "last_root_organization_goal"],
  isLastRootOrganizationGoal: true,
  counts: {
    childGoals: 1,
    linkedProjects: 1,
    linkedIssues: 2,
    automations: 0,
    costEvents: 0,
    financeEvents: 0,
  },
  previews: {
    childGoals: [
      { id: "child-1", title: "Child Goal", subtitle: "active" },
    ],
    linkedProjects: [
      { id: "project-1", title: "Launch Rollout", subtitle: "in_progress" },
    ],
    linkedIssues: [
      { id: "issue-1", title: "Confirm delete blocker copy", subtitle: "RAA-7" },
      { id: "issue-2", title: "Follow-up regression check", subtitle: "RAA-8" },
    ],
    automations: [],
  },
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

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "agents") {
      return {
        data: [
          {
            id: "agent-1",
            name: "Ada",
            role: "engineer",
            title: "Engineer",
            status: "active",
          },
        ],
        isLoading: false,
        error: null,
      };
    }
    if (queryKey[0] === "goals") {
      return {
        data: [
          baseGoal,
          { ...baseGoal, id: "child-1", title: "Child Goal", parentId: "goal-1" },
          { ...baseGoal, id: "goal-2", title: "Other Goal", parentId: null },
        ],
        isLoading: false,
        error: null,
      };
    }
    return { data: [], isLoading: false, error: null };
  },
}));

vi.mock("../context/OrganizationContext", () => ({
  useOrganization: () => ({
    selectedOrganizationId: "org-1",
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

let cleanupFn: (() => void) | null = null;

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  document.body.innerHTML = "";
});

function renderGoalProperties(props: Partial<ComponentProps<typeof GoalProperties>> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onUpdate = vi.fn();

  cleanupFn = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };

  act(() => {
    root.render(<GoalProperties goal={baseGoal} onUpdate={onUpdate} {...props} />);
  });

  return { container, onUpdate };
}

describe("GoalProperties", () => {
  it("confirms hard delete for a safe unused goal", () => {
    const onDelete = vi.fn();
    const { container } = renderGoalProperties({
      dependencies: safeDependencies,
      onDelete,
    });

    const deleteButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Delete goal"));
    expect(deleteButton).toBeTruthy();

    act(() => {
      deleteButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onDelete).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Confirm delete");

    const confirmButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Confirm delete"));
    expect(confirmButton).toBeTruthy();

    act(() => {
      confirmButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("offers cancellation instead of hard delete when dependencies block deletion", () => {
    const onDelete = vi.fn();
    const { container, onUpdate } = renderGoalProperties({
      dependencies: blockedDependencies,
      onDelete,
    });

    expect(container.textContent).toContain("Delete blocked by");
    expect(container.textContent).toContain("Child goals");
    expect(container.textContent).toContain("Child Goal");
    expect(container.textContent).toContain("Linked projects");
    expect(container.textContent).toContain("Launch Rollout");
    expect(container.textContent).toContain("Linked issues");
    expect(container.textContent).toContain("Confirm delete blocker copy");
    expect(container.textContent).toContain("Last root organization goal");
    expect(container.textContent).toContain("Cancel goal");
    expect(container.textContent).not.toContain("Delete goal");

    const cancelButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Cancel goal"));
    expect(cancelButton).toBeTruthy();

    act(() => {
      cancelButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({ status: "cancelled" });
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("excludes the current goal and descendants from the parent picker", () => {
    const { container } = renderGoalProperties();
    const parentTrigger = Array.from(container.querySelectorAll("button"))
      .filter((button) => button.textContent === "None")[1];
    expect(parentTrigger).toBeTruthy();

    act(() => {
      parentTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.body.textContent).toContain("Other Goal");
    expect(document.body.textContent).not.toContain("Child Goal");
  });
});
