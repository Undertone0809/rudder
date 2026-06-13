// @vitest-environment jsdom

import type { Issue } from "@rudderhq/shared";
import type { MouseEventHandler, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KanbanBoard,
  applyKanbanDropOrderPreview,
  doesKanbanDropOrderPreviewMatchBase,
} from "./KanbanBoard";

vi.mock("@/lib/router", () => ({
  Link: ({
    to,
    children,
    onClick,
    ...props
  }: {
    to: string;
    children: ReactNode;
    onClick?: MouseEventHandler<HTMLAnchorElement>;
  }) => (
    <a
      href={to}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
      {...props}
    >
      {children}
    </a>
  ),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  vi.useRealTimers();
  cleanupFn?.();
  cleanupFn = null;
  document.body.innerHTML = "";
});

function render(element: ReactNode) {
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
    root.render(element);
  });
  return container;
}

const issue: Issue = {
  id: "issue-1",
  orgId: "org-1",
  projectId: null,
  projectWorkspaceId: null,
  goalId: null,
  parentId: null,
  title: "Avatar regression",
  description: null,
  status: "todo",
  priority: "medium",
  boardOrder: 1000,
  assigneeAgentId: "agent-1",
  assigneeUserId: null,
  reviewerAgentId: null,
  reviewerUserId: null,
  checkoutRunId: null,
  executionRunId: null,
  executionAgentNameKey: null,
  executionLockedAt: null,
  createdByAgentId: null,
  createdByUserId: "user-1",
  issueNumber: 1,
  identifier: "RUD-1",
  requestDepth: 0,
  billingCode: null,
  assigneeAgentRuntimeOverrides: null,
  executionWorkspaceId: null,
  executionWorkspacePreference: null,
  executionWorkspaceSettings: null,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  hiddenAt: null,
  createdAt: new Date("2026-04-19T08:00:00.000Z"),
  updatedAt: new Date("2026-04-19T08:00:00.000Z"),
};

describe("KanbanBoard", () => {
  it("projects the dropped card order before the server refetch settles", () => {
    const first = { ...issue, id: "issue-1", identifier: "RUD-1", title: "First", boardOrder: 1000 };
    const second = { ...issue, id: "issue-2", identifier: "RUD-2", title: "Second", boardOrder: 2000 };
    const third = { ...issue, id: "issue-3", identifier: "RUD-3", title: "Third", boardOrder: 3000 };
    const base = {
      backlog: [],
      todo: [first, second, third],
      in_progress: [],
      in_review: [],
      blocked: [],
      done: [],
      cancelled: [],
    };

    const projected = applyKanbanDropOrderPreview(base, [first, second, third], {
      laneIdsByStatus: {
        todo: ["issue-3", "issue-1", "issue-2"],
      },
    });

    expect(projected.todo.map((candidate) => candidate.id)).toEqual(["issue-3", "issue-1", "issue-2"]);
    expect(base.todo.map((candidate) => candidate.id)).toEqual(["issue-1", "issue-2", "issue-3"]);
    expect(doesKanbanDropOrderPreviewMatchBase(projected, {
      laneIdsByStatus: {
        todo: ["issue-3", "issue-1", "issue-2"],
      },
    })).toBe(true);
  });

  it("notifies callers when a board card opens", () => {
    const onOpenIssue = vi.fn();
    const container = render(
      <KanbanBoard
        issues={[issue]}
        agents={[{ id: "agent-1", name: "Alice Smith", icon: null, role: "engineer", title: null }]}
        onOpenIssue={onOpenIssue}
        onUpdateIssue={() => undefined}
      />,
    );

    const cardLink = container.querySelector('a[href="/issues/RUD-1"]') as HTMLAnchorElement | null;
    act(() => {
      cardLink?.click();
    });

    expect(onOpenIssue).toHaveBeenCalledWith(issue);
  });

  it("separates primary assignee and secondary reviewer project label metadata on a board card", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 19, 12, 0, 0));

    const container = render(
      <KanbanBoard
        issues={[{
          ...issue,
          projectId: "project-1",
          assigneeAgentId: null,
          assigneeUserId: "user-1",
          reviewerUserId: "user-1",
          labels: [
            {
              id: "label-1",
              orgId: "org-1",
              name: "UI",
              color: "#06b6d4",
              createdAt: new Date("2026-04-19T08:00:00.000Z"),
              updatedAt: new Date("2026-04-19T08:00:00.000Z"),
            },
          ],
          createdAt: new Date(2026, 4, 17, 9, 30),
          updatedAt: new Date(2026, 4, 18, 9, 30),
        }]}
        currentUserId="user-1"
        projects={[{ id: "project-1", name: "Rudder dev" }]}
        displayProperties={["identifier", "priority", "assignee", "reviewer", "labels", "project", "updated", "created"]}
        onUpdateIssue={() => undefined}
      />,
    );

    const card = container.querySelector('[data-testid="kanban-card-RUD-1"]');
    const primary = card?.querySelector('[data-slot="kanban-card-primary"]');
    const primaryAssignee = card?.querySelector('[data-slot="kanban-card-primary-assignee"]');
    const metadata = card?.querySelector('[data-slot="kanban-card-metadata"]');
    const rows = Array.from(card?.querySelectorAll('[data-slot="kanban-card-metadata-row"]') ?? []);
    const assignee = card?.querySelector('[data-slot="kanban-card-assignee"]');
    const reviewer = card?.querySelector('[data-slot="kanban-card-reviewer"]');

    expect(assignee).not.toBeNull();
    expect(reviewer).not.toBeNull();
    expect(primary?.textContent).toContain("RUD-1");
    expect(primaryAssignee?.contains(assignee!)).toBe(true);
    expect(metadata?.contains(reviewer!)).toBe(true);
    expect(rows.every((row) => row.className.includes("items-center"))).toBe(true);
    expect(rows.map((row) => row.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("ProjectRudder dev"),
        expect.stringContaining("ReviewerMe"),
        expect.stringContaining("LabelsUI"),
        expect.stringContaining("UpdatedYesterday"),
        expect.stringContaining("CreatedMay 17, 09:30"),
      ]),
    );
    expect(assignee?.textContent).toContain("Me");
    expect(assignee?.textContent).not.toContain("Assignee");
    expect(assignee?.getAttribute("title")).toBe("Assignee: Me");
    expect(reviewer?.textContent).toContain("Me");
    expect(reviewer?.getAttribute("title")).toBe("Reviewer: Me");
  });

});
