// @vitest-environment jsdom

import { act } from "react";
import type { MouseEventHandler, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@rudderhq/shared";
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

});
