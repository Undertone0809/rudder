// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@rudderhq/shared";
import { IssuesList } from "./IssuesList";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const openNewIssueMock = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "auth") {
      return {
        data: { user: { id: "user-1" } },
        isLoading: false,
        error: null,
      };
    }
    if (queryKey[0] === "issues" && queryKey[2] === "labels") {
      return {
        data: [label],
        isLoading: false,
        error: null,
      };
    }
    return {
      data: [],
      isLoading: false,
      error: null,
    };
  },
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    openNewIssue: openNewIssueMock,
  }),
}));

vi.mock("../context/OrganizationContext", () => ({
  useOrganization: () => ({
    selectedOrganizationId: "org-1",
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: import("react").ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("./StatusIcon", () => ({
  StatusIcon: () => <span>Status</span>,
}));

let cleanupFn: (() => void) | null = null;
const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  Object.defineProperty(window, "localStorage", {
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => {
        storage.clear();
      },
    },
    configurable: true,
  });
});

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  openNewIssueMock.mockReset();
  window.localStorage.clear();
  document.body.innerHTML = "";
});

const baseIssue: Issue = {
  id: "issue-1",
  orgId: "org-1",
  projectId: null,
  projectWorkspaceId: null,
  goalId: null,
  parentId: null,
  title: "Unassigned issue",
  description: null,
  status: "todo",
  priority: "medium",
  boardOrder: 1000,
  assigneeAgentId: null,
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

const secondIssue: Issue = {
  ...baseIssue,
  id: "issue-2",
  projectId: "project-2",
  title: "Project grouped issue",
  identifier: "RUD-2",
};

function issueFixture(overrides: Partial<Issue>): Issue {
  return {
    ...baseIssue,
    ...overrides,
  };
}

const label = {
  id: "label-1",
  orgId: "org-1",
  name: "Backend",
  color: "#2563eb",
  createdAt: new Date("2026-04-19T08:00:00.000Z"),
  updatedAt: new Date("2026-04-19T08:00:00.000Z"),
};

function renderIssuesList(
  onUpdateIssue: (id: string, data: Record<string, unknown>) => void,
  options: { liveIssueIds?: Set<string> } = {},
) {
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
    root.render(
        <IssuesList
          issues={[baseIssue]}
          agents={[
          { id: "agent-1", name: "Alice", role: "engineer", title: null },
          { id: "agent-2", name: "Bob", role: "engineer", title: null },
        ]}
          liveIssueIds={options.liveIssueIds}
          viewStateKey="test:issues"
          toolbarMode="hidden"
          onUpdateIssue={onUpdateIssue}
      />,
    );
  });

  return container;
}

describe("IssuesList", () => {
  it("defaults to board mode when no saved issue view preference exists", () => {
    const onUpdateIssue = vi.fn();
    const container = renderIssuesList(onUpdateIssue);

    expect(container.querySelector('[data-testid="kanban-column-todo"]')).toBeTruthy();
    expect(container.textContent).toContain("Hidden columns");
  });

  it("opens the assignee picker for an unassigned issue and applies the selected assignee", () => {
    window.localStorage.setItem(
      "test:issues:org-1",
      JSON.stringify({ viewMode: "list" }),
    );

    const onUpdateIssue = vi.fn();
    const container = renderIssuesList(onUpdateIssue);

    const assigneeTrigger = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Assignee",
    );

    expect(assigneeTrigger).toBeTruthy();

    act(() => {
      assigneeTrigger?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(document.body.querySelector('input[placeholder="Search assignees..."]')).toBeTruthy();
    expect(document.body.textContent).toContain("Alice");
    expect(document.body.querySelector('[data-slot="assignee-label"][data-kind="unassigned"]')).toBeTruthy();
    expect(document.body.querySelector('[data-slot="assignee-label"][data-kind="user"]')).toBeTruthy();
    expect(document.body.querySelector('[data-slot="assignee-label"][data-kind="agent"]')).toBeTruthy();

    const aliceOption = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Alice"),
    );

    expect(aliceOption).toBeTruthy();

    act(() => {
      aliceOption?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(onUpdateIssue).toHaveBeenCalledWith("issue-1", {
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
    });
  });

  it("uses auto-hiding scrollbars in issue filter and assignee popovers", () => {
    window.localStorage.setItem(
      "test:issues:org-1",
      JSON.stringify({ viewMode: "list" }),
    );

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
      root.render(
        <IssuesList
          issues={[baseIssue]}
          agents={[
            { id: "agent-1", name: "Alice", role: "engineer", title: null },
            { id: "agent-2", name: "Bob", role: "engineer", title: null },
          ]}
          projects={[
            { id: "project-1", name: "Rudder dev" },
            { id: "project-2", name: "Rudder Release" },
          ]}
          viewStateKey="test:issues"
          onUpdateIssue={vi.fn()}
        />,
      );
    });

    const filterButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Filter"),
    );
    expect(filterButton).toBeTruthy();

    act(() => {
      filterButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    for (const testId of [
      "issues-filter-assignee-scroll",
      "issues-filter-labels-scroll",
      "issues-filter-projects-scroll",
    ]) {
      expect(document.body.querySelector(`[data-testid="${testId}"]`)?.classList.contains("scrollbar-auto-hide")).toBe(true);
    }

    const assigneeTrigger = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Assignee",
    );
    expect(assigneeTrigger).toBeTruthy();

    act(() => {
      assigneeTrigger?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(document.body.querySelector('[data-testid="issue-row-assignee-picker-scroll"]')?.classList.contains("scrollbar-auto-hide")).toBe(true);
  });

  it("opens issue search scope options from the search input and keeps one scope selected", () => {
    window.localStorage.setItem(
      "test:issues:org-1",
      JSON.stringify({ viewMode: "list" }),
    );

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
      root.render(
        <IssuesList
          issues={[baseIssue]}
          viewStateKey="test:issues"
          onUpdateIssue={vi.fn()}
        />,
      );
    });

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search issues"]');
    expect(input).toBeTruthy();

    act(() => {
      input?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(document.body.textContent).toContain("Search in");
    expect(document.body.textContent).toContain("Title");
    expect(document.body.textContent).toContain("Description");
    expect(document.body.textContent).toContain("Comments");

    const checkboxFor = (labelText: string) => {
      const label = Array.from(document.body.querySelectorAll("label")).find(
        (entry) => entry.textContent?.trim() === labelText,
      );
      return label?.querySelector<HTMLElement>('[data-slot="checkbox"]') ?? null;
    };

    const titleCheckbox = checkboxFor("Title");
    const descriptionCheckbox = checkboxFor("Description");

    expect(titleCheckbox?.getAttribute("data-state")).toBe("checked");
    expect(descriptionCheckbox?.getAttribute("data-state")).toBe("unchecked");

    act(() => {
      descriptionCheckbox?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(descriptionCheckbox?.getAttribute("data-state")).toBe("checked");

    act(() => {
      titleCheckbox?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(titleCheckbox?.getAttribute("data-state")).toBe("unchecked");

    act(() => {
      descriptionCheckbox?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(descriptionCheckbox?.getAttribute("data-state")).toBe("checked");
  });

  it("renders project groups when the saved view groups issues by project", () => {
    window.localStorage.setItem(
      "test:issues:org-1",
      JSON.stringify({ groupBy: "project", viewMode: "list" }),
    );

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
      root.render(
        <IssuesList
          issues={[
            { ...baseIssue, projectId: "project-1" },
            secondIssue,
          ]}
          projects={[
            { id: "project-1", name: "public-beta-launch" },
            { id: "project-2", name: "enterprise-readiness" },
          ]}
          viewStateKey="test:issues"
          toolbarMode="hidden"
          onUpdateIssue={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain("public-beta-launch");
    expect(container.textContent).toContain("enterprise-readiness");
    expect(container.textContent).toContain("Unassigned issue");
    expect(container.textContent).toContain("Project grouped issue");
  });

  it("moves zero-issue statuses into a hidden rail while keeping lane creation available", () => {
    window.localStorage.setItem(
      "test:issues:org-1",
      JSON.stringify({ viewMode: "board" }),
    );

    const onUpdateIssue = vi.fn();
    const container = renderIssuesList(onUpdateIssue);

    expect(container.querySelector('[data-testid="kanban-column-todo"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="kanban-column-in_progress"]')).toBeFalsy();
    expect(container.querySelector('[data-testid="kanban-hidden-columns"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="kanban-hidden-column-in_progress"]')).toBeTruthy();

    const createInProgressButton = document.body.querySelector('[data-testid="kanban-column-add-in_progress"]');
    expect(createInProgressButton).toBeTruthy();

    act(() => {
      createInProgressButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(openNewIssueMock).toHaveBeenCalledWith({
      status: "in_progress",
    });
  });

  it("orders board cards by manual board order when the saved sort is manual", () => {
    window.localStorage.setItem(
      "test:issues:org-1",
      JSON.stringify({ viewMode: "board", sortField: "manual", sortDir: "asc" }),
    );

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
      root.render(
        <IssuesList
          issues={[
            { ...baseIssue, boardOrder: 2000 },
            { ...secondIssue, projectId: null, boardOrder: 1000 },
          ]}
          viewStateKey="test:issues"
          toolbarMode="hidden"
          onUpdateIssue={vi.fn()}
        />,
      );
    });

    const text = container.textContent ?? "";
    expect(text.indexOf("Project grouped issue")).toBeLessThan(text.indexOf("Unassigned issue"));
  });

  it("marks live board cards with the Motion V1 hooks", () => {
    window.localStorage.setItem(
      "test:issues:org-1",
      JSON.stringify({ viewMode: "board" }),
    );

    const onUpdateIssue = vi.fn();
    const container = renderIssuesList(onUpdateIssue, {
      liveIssueIds: new Set(["issue-1"]),
    });

    const card = container.querySelector('[data-testid="kanban-card-RUD-1"]');
    expect(card).toBeTruthy();
    expect(card?.classList.contains("motion-kanban-card")).toBe(true);
    expect(card?.getAttribute("data-live")).toBe("true");
    expect(card?.querySelector(".motion-live-dot")).toBeTruthy();

    const lane = container.querySelector('[data-testid="kanban-column-todo"]');
    expect(lane?.classList.contains("motion-kanban-lane")).toBe(true);
    expect(lane?.getAttribute("data-over")).toBe("false");
  });

  it("constrains long board card assignee labels to the card width", () => {
    window.localStorage.setItem(
      "test:issues:org-1",
      JSON.stringify({ viewMode: "board" }),
    );

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
      root.render(
        <IssuesList
          issues={[{ ...baseIssue, assigneeAgentId: "agent-1" }]}
          agents={[{ id: "agent-1", name: "Ella", role: "cto", title: "Chief Technology Officer" }]}
          viewStateKey="test:issues"
          toolbarMode="hidden"
          onUpdateIssue={vi.fn()}
        />,
      );
    });

    const card = container.querySelector('[data-testid="kanban-card-RUD-1"]');
    const primaryAssignee = card?.querySelector('[data-slot="kanban-card-primary-assignee"]');
    const assignee = primaryAssignee?.querySelector('[data-slot="kanban-card-assignee"]');

    expect(card?.classList.contains("overflow-hidden")).toBe(true);
    expect(primaryAssignee?.classList.contains("min-w-0")).toBe(true);
    expect(primaryAssignee?.classList.contains("overflow-hidden")).toBe(true);
    expect(assignee?.textContent).toContain("Ella");
    expect(assignee?.classList.contains("min-w-0")).toBe(true);
    expect(assignee?.classList.contains("overflow-hidden")).toBe(true);
  });

  it("opens the new issue dialog from an empty board lane with scoped project and status defaults", () => {
    window.localStorage.setItem(
      "test:issues:org-1",
      JSON.stringify({ viewMode: "board" }),
    );

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
      root.render(
        <IssuesList
          issues={[]}
          agents={[{ id: "agent-1", name: "Alice", role: "engineer", title: null }]}
          projectId="project-1"
          viewStateKey="test:issues"
          toolbarMode="hidden"
          onUpdateIssue={vi.fn()}
        />,
      );
    });

    const createTodoButton = document.body.querySelector('[data-testid="kanban-column-add-todo"]');
    expect(createTodoButton).toBeTruthy();

    act(() => {
      createTodoButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(openNewIssueMock).toHaveBeenCalledWith({
      projectId: "project-1",
      status: "todo",
    });
  });

  it("carries selected board filters into lane creation defaults when they are unambiguous", () => {
    window.localStorage.setItem(
      "test:issues:org-1",
      JSON.stringify({
        viewMode: "board",
        projects: ["project-2"],
        priorities: ["high"],
        assignees: ["agent-1"],
        labels: ["label-1"],
      }),
    );

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
      root.render(
        <IssuesList
          issues={[]}
          agents={[{ id: "agent-1", name: "Alice", role: "engineer", title: null }]}
          viewStateKey="test:issues"
          toolbarMode="hidden"
          onUpdateIssue={vi.fn()}
        />,
      );
    });

    const createTodoButton = document.body.querySelector('[data-testid="kanban-column-add-todo"]');
    expect(createTodoButton).toBeTruthy();

    act(() => {
      createTodoButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(openNewIssueMock).toHaveBeenCalledWith({
      projectId: "project-2",
      priority: "high",
      assigneeAgentId: "agent-1",
      labelIds: ["label-1"],
      status: "todo",
    });
  });

  it("renders board cards from saved display properties", () => {
    window.localStorage.setItem(
      "test:issues:org-1",
      JSON.stringify({
        viewMode: "board",
        displayProperties: ["labels", "project", "updated"],
      }),
    );

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
      root.render(
        <IssuesList
          issues={[{
            ...baseIssue,
            reviewerAgentId: "agent-1",
            labels: [label],
            labelIds: [label.id],
            projectId: "project-1",
          }]}
          agents={[{ id: "agent-1", name: "Alice", role: "engineer", title: null }]}
          projects={[{ id: "project-1", name: "Operator console" }]}
          viewStateKey="test:issues"
          toolbarMode="hidden"
          onUpdateIssue={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain("Backend");
    expect(container.textContent).toContain("Operator console");
    expect(container.textContent).toContain("Updated");
    expect(container.textContent).not.toContain("Alice");
    expect(container.textContent).not.toContain("RUD-1");
  });

  it("shows the default board card metadata for new views", () => {
    window.localStorage.setItem(
      "test:issues:org-1",
      JSON.stringify({ viewMode: "board" }),
    );

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
      root.render(
        <IssuesList
          issues={[{
            ...baseIssue,
            reviewerAgentId: "agent-2",
            labels: [label],
            labelIds: [label.id],
            projectId: "project-1",
          }]}
          agents={[
            { id: "agent-1", name: "Alice", role: "engineer", title: null },
            { id: "agent-2", name: "Review Bot", role: "qa", title: null },
          ]}
          projects={[{ id: "project-1", name: "Operator console" }]}
          viewStateKey="test:issues"
          toolbarMode="hidden"
          onUpdateIssue={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain("RUD-1");
    expect(container.textContent).toContain("Review Bot");
    expect(container.textContent).toContain("Backend");
    expect(container.textContent).toContain("Operator console");
    expect(container.textContent).toContain("Created");
    expect(container.textContent).not.toContain("Updated");
  });

  it("toggles board display properties from the toolbar and persists them", () => {
    window.localStorage.setItem(
      "test:issues:org-1",
      JSON.stringify({
        viewMode: "board",
        displayProperties: ["identifier"],
      }),
    );

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
      root.render(
        <IssuesList
          issues={[{ ...baseIssue, projectId: "project-1", reviewerAgentId: "agent-1" }]}
          agents={[{ id: "agent-1", name: "Alice", role: "engineer", title: null }]}
          projects={[{ id: "project-1", name: "Operator console" }]}
          viewStateKey="test:issues"
          toolbarMode="controls-only"
          onUpdateIssue={vi.fn()}
        />,
      );
    });

    expect(container.textContent).not.toContain("Operator console");
    expect(container.textContent).not.toContain("Alice");

    const displayButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Display"),
    );
    expect(displayButton).toBeTruthy();

    act(() => {
      displayButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    const projectLabel = Array.from(document.body.querySelectorAll("label")).find(
      (entry) => entry.textContent?.trim() === "Project",
    );
    expect(projectLabel).toBeTruthy();

    const reviewerLabel = Array.from(document.body.querySelectorAll("label")).find(
      (entry) => entry.textContent?.trim() === "Reviewer",
    );
    expect(reviewerLabel).toBeTruthy();

    act(() => {
      reviewerLabel?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain("Alice");

    act(() => {
      projectLabel?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain("Operator console");
    expect(JSON.parse(window.localStorage.getItem("test:issues:org-1") ?? "{}")).toMatchObject({
      displayProperties: ["identifier", "reviewer", "project"],
    });
  });

  it("shows the count of currently working issues in the board toolbar", () => {
    window.localStorage.setItem(
      "test:issues:org-1",
      JSON.stringify({
        viewMode: "board",
        statuses: ["in_progress"],
      }),
    );

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
      root.render(
        <IssuesList
          issues={[
            issueFixture({ id: "issue-live-visible", title: "Live visible", status: "in_progress" }),
            issueFixture({ id: "issue-live-filtered", title: "Live filtered", status: "done" }),
            issueFixture({ id: "issue-idle-visible", title: "Idle visible", status: "in_progress" }),
          ]}
          liveIssueIds={new Set(["issue-live-visible", "issue-live-filtered"])}
          viewStateKey="test:issues"
          toolbarMode="controls-only"
          onUpdateIssue={vi.fn()}
        />,
      );
    });

    expect(container.querySelector('[data-testid="issues-working-count"]')?.textContent).toBe("1 working");
    expect(container.textContent).toContain("Live visible");
    expect(container.textContent).not.toContain("Live filtered");
  });

  it("sorts each board status lane using the saved sort order", () => {
    window.localStorage.setItem(
      "test:issues:org-1",
      JSON.stringify({
        viewMode: "board",
        sortField: "priority",
        sortDir: "asc",
      }),
    );

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
      root.render(
        <IssuesList
          issues={[
            issueFixture({ id: "todo-low", identifier: "RUD-10", title: "Todo low", status: "todo", priority: "low" }),
            issueFixture({ id: "todo-critical", identifier: "RUD-11", title: "Todo critical", status: "todo", priority: "critical" }),
            issueFixture({ id: "todo-high", identifier: "RUD-12", title: "Todo high", status: "todo", priority: "high" }),
            issueFixture({ id: "done-low", identifier: "RUD-13", title: "Done low", status: "done", priority: "low" }),
            issueFixture({ id: "done-high", identifier: "RUD-14", title: "Done high", status: "done", priority: "high" }),
          ]}
          viewStateKey="test:issues"
          toolbarMode="hidden"
          onUpdateIssue={vi.fn()}
        />,
      );
    });

    const todoCards = Array.from(
      container.querySelectorAll('[data-testid="kanban-column-todo"] [data-testid^="kanban-card-"]'),
    ).map((card) => card.textContent);
    const doneCards = Array.from(
      container.querySelectorAll('[data-testid="kanban-column-done"] [data-testid^="kanban-card-"]'),
    ).map((card) => card.textContent);

    expect(todoCards[0]).toContain("Todo critical");
    expect(todoCards[1]).toContain("Todo high");
    expect(todoCards[2]).toContain("Todo low");
    expect(doneCards[0]).toContain("Done high");
    expect(doneCards[1]).toContain("Done low");
  });

  it("shows the sort control in board mode and persists board card sorting", () => {
    window.localStorage.setItem(
      "test:issues:org-1",
      JSON.stringify({
        viewMode: "board",
        sortField: "updated",
        sortDir: "desc",
      }),
    );

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
      root.render(
        <IssuesList
          issues={[baseIssue]}
          viewStateKey="test:issues"
          toolbarMode="controls-only"
          onUpdateIssue={vi.fn()}
        />,
      );
    });

    const sortButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Sort"),
    );
    expect(sortButton).toBeTruthy();

    act(() => {
      sortButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    const priorityButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Priority"),
    );
    expect(priorityButton).toBeTruthy();

    act(() => {
      priorityButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(JSON.parse(window.localStorage.getItem("test:issues:org-1") ?? "{}")).toMatchObject({
      viewMode: "board",
      sortField: "priority",
      sortDir: "asc",
    });
  });
});
