// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@rudderhq/shared";
import { KanbanBoard } from "./KanbanBoard";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
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
  it("renders the assignee's uploaded avatar on issue cards", () => {
    const container = render(
      <KanbanBoard
        issues={[issue]}
        agents={[{ id: "agent-1", name: "Alice Smith", icon: "asset:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "engineer", title: null }]}
        onUpdateIssue={() => undefined}
      />,
    );

    const img = container.querySelector('img[src="/api/assets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/content"]');
    expect(img).toBeTruthy();
    expect(container.textContent).toContain("Alice Smith");
  });
});
