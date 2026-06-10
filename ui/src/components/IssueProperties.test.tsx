// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue, Project } from "@rudderhq/shared";
import { IssueProperties } from "./IssueProperties";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const openNewIssue = vi.hoisted(() => vi.fn());
const mockIssues = vi.hoisted(() => ({ current: [] as Issue[] }));
const mockProjects = vi.hoisted(() => ({ current: [] as Project[] }));
const longAgentName = "ZST Runtime Smoke Agent With A Very Long Operational Name";

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "auth") {
      return {
        data: { user: { id: "user-1" } },
        isLoading: false,
        error: null,
      };
    }
    if (queryKey[0] === "agents" && queryKey.length === 2) {
      return {
        data: [
          {
            id: "agent-1",
            name: longAgentName,
            role: "cto",
            title: "Chief Technology Officer",
            icon: null,
            status: "active",
          },
        ],
        isLoading: false,
        error: null,
      };
    }
    if (queryKey[0] === "issues" && queryKey.length === 2) {
      return {
        data: mockIssues.current,
        isLoading: false,
        error: null,
      };
    }
    if (queryKey[0] === "projects" && queryKey.length === 2) {
      return {
        data: mockProjects.current,
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
  useMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock("../context/OrganizationContext", () => ({
  useOrganization: () => ({
    selectedOrganizationId: "org-1",
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    openNewIssue,
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({
    pushToast: vi.fn(),
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: import("react").ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

let cleanupFn: (() => void) | null = null;

beforeEach(() => {
  document.body.innerHTML = "";
  openNewIssue.mockReset();
  mockIssues.current = [];
  mockProjects.current = [];
});

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  document.body.innerHTML = "";
});

const baseIssue: Issue = {
  id: "issue-1",
  orgId: "org-1",
  projectId: null,
  projectWorkspaceId: null,
  goalId: null,
  parentId: null,
  title: "Issue with long assignee",
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

function project(overrides: Partial<Project> = {}): Project {
  const id = overrides.id ?? "project-1";
  return {
    id,
    orgId: "org-1",
    urlKey: id,
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Target project",
    description: null,
    status: "in_progress",
    leadAgentId: null,
    targetDate: null,
    color: "#22c55e",
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: {
      configured: true,
      scope: "project",
      workspaceId: "workspace-1",
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
      repoName: null,
      localFolder: null,
      managedFolder: "",
      effectiveLocalFolder: "",
      origin: "local_folder",
    },
    resources: [],
    workspaces: [
      {
        id: "workspace-1",
        orgId: "org-1",
        projectId: id,
        name: "Primary workspace",
        sourceType: "local_path",
        cwd: "/tmp/target-project",
        repoUrl: null,
        repoRef: null,
        defaultRef: null,
        visibility: "default",
        setupCommand: null,
        cleanupCommand: null,
        remoteProvider: null,
        remoteWorkspaceRef: null,
        sharedWorkspaceKey: null,
        metadata: null,
        isPrimary: true,
        createdAt: new Date("2026-04-19T08:00:00.000Z"),
        updatedAt: new Date("2026-04-19T08:00:00.000Z"),
      },
    ],
    primaryWorkspace: null,
    archivedAt: null,
    createdAt: new Date("2026-04-19T08:00:00.000Z"),
    updatedAt: new Date("2026-04-19T08:00:00.000Z"),
    ...overrides,
  };
}

describe("IssueProperties", () => {
  it("allows long assignee labels to shrink inside the properties panel", () => {
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
      root.render(<IssueProperties issue={baseIssue} onUpdate={vi.fn()} />);
    });

    const label = container.querySelector('[data-slot="assignee-label"][data-kind="agent"]');
    const trigger = label?.closest("button");
    const row = label?.closest('[data-slot="issue-property-row"]');

    const labelText = label?.querySelector('[data-slot="assignee-label-text"]');

    expect(label?.textContent).toContain(longAgentName);
    expect(label?.textContent).toContain("Chief Technology Officer");
    expect(label?.textContent).not.toContain(`${longAgentName} (Chief Technology Officer)`);
    expect(trigger?.classList.contains("min-w-0")).toBe(true);
    expect(trigger?.classList.contains("w-full")).toBe(true);
    expect(trigger?.classList.contains("max-w-full")).toBe(true);
    expect(trigger?.classList.contains("justify-start")).toBe(true);
    expect(row?.getAttribute("data-align")).toBe("start");
    expect(row?.classList.contains("items-start")).toBe(true);
    expect(label?.getAttribute("data-layout")).toBe("stacked");
    expect(label?.classList.contains("min-w-0")).toBe(true);
    expect(label?.classList.contains("w-full")).toBe(true);
    expect(label?.classList.contains("items-center")).toBe(true);
    expect(label?.classList.contains("items-start")).toBe(false);
    expect(labelText?.classList.contains("truncate")).toBe(true);
    expect(labelText?.classList.contains("max-w-full")).toBe(true);
    expect(labelText?.getAttribute("title")).toBe(longAgentName);
    expect(label?.querySelector('[data-slot="agent-title-badge"]')).toBeTruthy();
    expect(label?.querySelector('[data-slot="agent-title-badge"]')?.classList.contains("max-w-full")).toBe(true);
    expect(label?.querySelector('[data-slot="agent-title-badge"]')?.classList.contains("w-full")).toBe(false);
    expect(label?.querySelector('[data-slot="agent-title-badge"] span')?.classList.contains("truncate")).toBe(false);
    expect(label?.querySelector('[data-slot="agent-title-badge"] span')?.classList.contains("break-words")).toBe(true);
  });

  it("clears stale run workspace state when selecting a project", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onUpdate = vi.fn();
    mockProjects.current = [project()];

    cleanupFn = () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    };

    act(() => {
      root.render(
        <IssueProperties
          issue={{
            ...baseIssue,
            executionWorkspaceId: "old-execution-workspace",
          }}
          onUpdate={onUpdate}
          inline
        />,
      );
    });

    act(() => {
      container
        .querySelectorAll<HTMLButtonElement>("button")
        .forEach((button) => {
          if (button.textContent?.trim() === "No project") {
            button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          }
        });
    });

    act(() => {
      container
        .querySelectorAll<HTMLButtonElement>("button")
        .forEach((button) => {
          if (button.textContent?.trim() === "Target project") {
            button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          }
        });
    });

    expect(onUpdate).toHaveBeenCalledWith({
      projectId: "project-1",
      projectWorkspaceId: "workspace-1",
      executionWorkspaceId: null,
    });
  });

  it("does not render a workspace property row", () => {
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
      root.render(<IssueProperties issue={baseIssue} onUpdate={vi.fn()} />);
    });

    expect(container.textContent).not.toContain("Workspace");
    expect(container.textContent).not.toContain("Run workspace");
  });

  it("renders parent issue as an editable property when no parent is set", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onUpdate = vi.fn();
    mockIssues.current = [
      baseIssue,
      {
        ...baseIssue,
        id: "candidate-parent",
        identifier: "RUD-9",
        issueNumber: 9,
        title: "Candidate parent issue",
      },
    ];

    cleanupFn = () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    };

    act(() => {
      root.render(<IssueProperties issue={baseIssue} onUpdate={onUpdate} inline />);
    });

    expect(container.textContent).toContain("Parent issue");
    expect(container.textContent).toContain("No parent");

    act(() => {
      Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent?.includes("No parent"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Candidate parent issue");

    act(() => {
      Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent?.includes("Candidate parent issue"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({ parentId: "candidate-parent" });
  });

  it("renders assignee picker agents as two-line menu rows", () => {
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
      root.render(<IssueProperties issue={baseIssue} onUpdate={vi.fn()} inline />);
    });

    const label = container.querySelector('[data-slot="assignee-label"][data-kind="agent"]');
    const trigger = label?.closest("button");

    act(() => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const menuLabel = container.querySelector('[data-slot="agent-menu-label"]');
    const supportingLabel = container.querySelector('[data-slot="agent-menu-supporting-label"]');
    const scrollRegion = container.querySelector('[data-testid="issue-properties-assignee-scroll"]');

    expect(menuLabel?.textContent).toContain(longAgentName);
    expect(supportingLabel?.textContent).toBe("Chief Technology Officer");
    expect(menuLabel?.querySelector('[data-slot="agent-title-badge"]')).toBeNull();
    expect(supportingLabel?.classList.contains("truncate")).toBe(true);
    expect(scrollRegion?.classList.contains("scrollbar-auto-hide")).toBe(true);
  });

  it("renders reviewer self assignment as an explicit action row", () => {
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
      root.render(<IssueProperties issue={baseIssue} onUpdate={vi.fn()} inline />);
    });

    const reviewerTrigger = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("No reviewer"));

    act(() => {
      reviewerTrigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const selfAction = container.querySelector('[data-slot="assignee-self-action-label"]');
    const reviewerScrollRegion = container.querySelector('[data-testid="issue-properties-reviewer-scroll"]');

    expect(selfAction?.textContent).toBe("Assign to me");
    expect(reviewerScrollRegion?.textContent).toContain("Assign to me");
    expect(reviewerScrollRegion?.textContent).not.toContain("Me");
  });

  it("renders parent and sub-issues in the properties hierarchy section", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const childIssue: Issue = {
      ...baseIssue,
      id: "child-1",
      parentId: "issue-1",
      title: "Follow-up implementation",
      identifier: "RUD-2",
      issueNumber: 2,
    };
    const parentedIssue: Issue = {
      ...baseIssue,
      parentId: "parent-1",
      ancestors: [
        {
          id: "parent-1",
          identifier: "RUD-0",
          title: "Parent task",
          description: null,
          status: "todo",
          priority: "medium",
          assigneeAgentId: null,
          assigneeUserId: null,
          reviewerAgentId: null,
          reviewerUserId: null,
          projectId: null,
          goalId: null,
          project: null,
          goal: null,
        },
      ],
    };

    cleanupFn = () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    };

    act(() => {
      root.render(
        <IssueProperties
          issue={parentedIssue}
          onUpdate={vi.fn()}
          childIssues={[childIssue]}
        />,
      );
    });

    expect(container.textContent).toContain("Parent");
    expect(container.textContent).toContain("Parent task");
    expect(container.querySelector('a[href="/issues/RUD-0"]')).toBeTruthy();
    expect(container.textContent).toContain("Sub-issues");
    expect(container.textContent).toContain("Follow-up implementation");
    expect(container.textContent).toContain("RUD-2");
    expect(container.querySelector('a[href="/issues/RUD-2"]')).toBeTruthy();
  });

  it("opens parent issues by full id when the parent has no identifier", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const parentedIssue: Issue = {
      ...baseIssue,
      parentId: "legacy-parent-full-id",
      ancestors: [
        {
          id: "legacy-parent-full-id",
          identifier: null,
          title: "Legacy parent task",
          description: null,
          status: "todo",
          priority: "medium",
          assigneeAgentId: null,
          assigneeUserId: null,
          reviewerAgentId: null,
          reviewerUserId: null,
          projectId: null,
          goalId: null,
          project: null,
          goal: null,
        },
      ],
    };

    cleanupFn = () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    };

    act(() => {
      root.render(
        <IssueProperties
          issue={parentedIssue}
          onUpdate={vi.fn()}
          childIssues={[]}
        />,
      );
    });

    expect(container.querySelector('a[href="/issues/legacy-parent-full-id"]')).toBeTruthy();
    expect(container.textContent).toContain("legacy-");
    expect(container.textContent).toContain("Legacy parent task");
  });

  it("opens the shared new issue dialog with parent defaults from the properties row", () => {
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
        <IssueProperties
          issue={{ ...baseIssue, projectId: "project-1", goalId: "goal-1" }}
          onUpdate={vi.fn()}
          childIssues={[]}
        />,
      );
    });

    act(() => {
      container
        .querySelectorAll<HTMLButtonElement>("button")
        .forEach((button) => {
          if (button.textContent?.trim() === "Add") {
            button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          }
        });
    });

    act(() => {
      document.body
        .querySelectorAll<HTMLButtonElement>("button")
        .forEach((button) => {
          if (button.textContent?.trim() === "Create new sub-issue") {
            button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          }
        });
    });

    expect(openNewIssue).toHaveBeenCalledWith({
      parentId: "issue-1",
      parentIssue: {
        id: "issue-1",
        identifier: "RUD-1",
        title: "Issue with long assignee",
      },
      projectId: "project-1",
      goalId: "goal-1",
    });
  });
});
