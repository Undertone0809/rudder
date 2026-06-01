// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NewIssueDefaults } from "@/context/DialogContext";
import { NewIssueDialog } from "./NewIssueDialog";

let capturedMentions: Array<Record<string, unknown>> = [];
const dialogState = vi.hoisted(() => ({
  newIssueDefaults: { assigneeAgentId: "agent-1" } as NewIssueDefaults,
  labels: [
    { id: "label-1", orgId: "org-1", name: "backend", color: "#2563eb", createdAt: "", updatedAt: "" },
  ],
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    if (queryKey[0] === "agents" && queryKey[1] === "skills") {
      return {
        data: {
          agentRuntimeType: "codex_local",
          supported: true,
          mode: "persistent",
          desiredSkills: ["org:organization/org-1/build-advisor"],
          entries: [
            {
              key: "build-advisor",
              selectionKey: "org:organization/org-1/build-advisor",
              runtimeName: "build-advisor",
              desired: true,
              configurable: true,
              alwaysEnabled: false,
              managed: true,
              state: "configured",
              sourceClass: "organization",
              sourcePath: "/workspace/skills/build-advisor",
            },
          ],
          warnings: [],
        },
      };
    }
    if (queryKey[0] === "agents" && queryKey[2] === "adapter-models") {
      return { data: [] };
    }
    if (queryKey[0] === "agents") {
      return {
        data: [
          {
            id: "agent-1",
            name: "Ella",
            urlKey: "ella",
            icon: null,
            role: "cto",
            title: "Chief Technology Officer",
            status: "active",
            agentRuntimeType: "codex_local",
          },
        ],
      };
    }
    if (queryKey[0] === "organization-skills") {
      return {
        data: [
          {
            id: "skill-1",
            orgId: "org-1",
            key: "organization/org-1/build-advisor",
            slug: "build-advisor",
            name: "Build Advisor",
            description: "Diagnose what feels wrong before another blind iteration.",
            sourceType: "local_path",
            sourceLocator: "/workspace/skills/build-advisor",
            sourceRef: null,
            trustLevel: "markdown_only",
            compatibility: "compatible",
            fileInventory: [{ path: "SKILL.md", kind: "skill" }],
            createdAt: "",
            updatedAt: "",
            attachedAgentCount: 1,
            editable: true,
            editableReason: null,
            sourceBadge: "local",
            sourceLabel: "Rudder workspace",
            sourcePath: "/workspace/skills/build-advisor/SKILL.md",
            workspaceEditPath: null,
          },
        ],
      };
    }
    if (queryKey[0] === "projects") return { data: [] };
    if (queryKey[0] === "goals") {
      return {
        data: [
          {
            id: "goal-1",
            orgId: "org-1",
            title: "Improve issue routing",
            description: null,
            level: "team",
            status: "active",
            parentId: null,
            ownerAgentId: null,
            createdAt: "",
            updatedAt: "",
          },
        ],
      };
    }
    if (queryKey[0] === "issues" && queryKey[2] === "labels") {
      return {
        data: dialogState.labels,
      };
    }
    if (queryKey[0] === "auth") return { data: { user: { id: "user-1" } } };
    return { data: undefined };
  },
  useMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    setQueryData: vi.fn(),
  }),
}));

vi.mock("@/context/DialogContext", () => ({
  useDialog: () => ({
    newIssueOpen: true,
    newIssueDefaults: dialogState.newIssueDefaults,
    closeNewIssue: vi.fn(),
  }),
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({
    pathname: "/issues",
    search: "",
  }),
  useNavigate: () => vi.fn(),
}));

vi.mock("@/context/OrganizationContext", () => ({
  useOrganization: () => ({
    selectedOrganizationId: "org-1",
    selectedOrganization: { id: "org-1", name: "Rudder", urlKey: "rudder", issuePrefix: "RUD", brandColor: "#111827" },
    organizations: [{ id: "org-1", name: "Rudder", urlKey: "rudder", issuePrefix: "RUD", brandColor: "#111827", status: "active" }],
  }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({
    pushToast: vi.fn(),
  }),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children, disablePortal }: { children: ReactNode; disablePortal?: boolean }) => (
    <div data-disable-portal={disablePortal ? "true" : undefined}>{children}</div>
  ),
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({
    mentions,
    contentClassName,
  }: {
    mentions?: Array<Record<string, unknown>>;
    contentClassName?: string;
  }) => {
    capturedMentions = mentions ?? [];
    return <textarea aria-label="Description" className={contentClassName} />;
  },
}));

vi.mock("./InlineEntitySelector", () => ({
  InlineEntitySelector: ({
    value,
    options,
    placeholder,
    renderTriggerValue,
    renderOption,
    variant,
    className,
  }: {
    value?: string;
    options?: Array<{ id: string; label: string }>;
    placeholder?: string;
    renderTriggerValue?: (option: { id: string; label: string } | null) => ReactNode;
    renderOption?: (option: { id: string; label: string }, isSelected: boolean) => ReactNode;
    variant?: string;
    className?: string;
  }) => {
    const selectedOption = options?.find((option) => option.id === value) ?? null;
    return (
      <div data-selector-placeholder={placeholder} data-variant={variant} className={className}>
        <button type="button">
          {renderTriggerValue ? renderTriggerValue(selectedOption) : (selectedOption?.label ?? placeholder ?? "selector")}
        </button>
        <div>
          {(options ?? []).map((option) => (
            <div key={option.id || "__none__"} data-option-id={option.id}>
              {renderOption ? renderOption(option, option.id === value) : option.label}
            </div>
          ))}
        </div>
      </div>
    );
  },
}));

vi.mock("./AgentIconPicker", () => ({
  AgentIcon: () => null,
}));

vi.mock("../hooks/useProjectOrder", () => ({
  useProjectOrder: ({ projects }: { projects: unknown[] }) => ({ orderedProjects: projects }),
}));

vi.mock("../lib/recent-assignees", () => ({
  getRecentAssigneeIds: () => [],
  sortAgentsByRecency: (agents: unknown[]) => agents,
  trackRecentAssignee: vi.fn(),
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    list: vi.fn(),
    adapterModels: vi.fn(),
  },
}));

vi.mock("../api/projects", () => ({
  projectsApi: {
    list: vi.fn(),
  },
}));

vi.mock("../api/goals", () => ({
  goalsApi: {
    list: vi.fn(),
  },
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    listLabels: vi.fn(),
    create: vi.fn(),
    createLabel: vi.fn(),
    upsertDocument: vi.fn(),
    uploadAttachment: vi.fn(),
  },
}));

vi.mock("../api/auth", () => ({
  authApi: {
    getSession: vi.fn(),
  },
}));

vi.mock("../api/assets", () => ({
  assetsApi: {
    uploadImage: vi.fn(),
  },
}));

describe("NewIssueDialog", () => {
  beforeEach(() => {
    dialogState.newIssueDefaults = { assigneeAgentId: "agent-1" };
    dialogState.labels = [
      { id: "label-1", orgId: "org-1", name: "backend", color: "#2563eb", createdAt: "", updatedAt: "" },
    ];
  });

  it("renders the label picker content in the new issue dialog", () => {
    const html = renderToStaticMarkup(<NewIssueDialog />);

    expect(html).toContain("Search labels...");
    expect(html).toContain("backend");
    expect(html).toContain("Labels");
  });

  it("keeps the label picker inside the dialog tree so its scroll area can receive wheel and touch events", () => {
    const html = renderToStaticMarkup(<NewIssueDialog />);

    expect(html).toContain('data-disable-portal="true"');
    expect(html).toContain("max-h-44 overflow-y-auto overscroll-contain");
  });

  it("keeps the save draft control visible when nothing can be saved", () => {
    const html = renderToStaticMarkup(<NewIssueDialog />);

    expect(html).toContain("Save Draft");
    expect(html).toContain("disabled:opacity-100");
    expect(html).toContain("disabled:bg-muted/20");
  });

  it("renders primary metadata controls as field selectors and keeps goal in the footer toolbar", () => {
    const html = renderToStaticMarkup(<NewIssueDialog />);

    expect(html).toContain('data-variant="field"');
    expect((html.match(/data-variant="field"/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect((html.match(/h-auto min-h-12 w-full py-2/g) ?? []).length).toBe(3);
    expect(html).toContain("Goal");
    expect(html).toContain("Improve issue routing");
    expect(html.indexOf("Labels")).toBeLessThan(html.indexOf("Goal"));
    expect(html.indexOf("Goal")).toBeLessThan(html.indexOf("Upload"));
  });

  it("keeps labels in the property chip when the organization has five labels", () => {
    dialogState.labels = Array.from({ length: 5 }, (_, index) => ({
      id: `label-${index + 1}`,
      orgId: "org-1",
      name: `label-${index + 1}`,
      color: "#2563eb",
      createdAt: "",
      updatedAt: "",
    }));

    const html = renderToStaticMarkup(<NewIssueDialog />);

    expect(html).toContain("sm:grid-cols-3");
    expect(html).not.toContain(">Labels</div>");
    expect((html.match(/data-variant="field"/g) ?? []).length).toBe(3);
    expect(html).toContain("Search labels...");
  });

  it("renders agent selector titles on a second line instead of parenthesized label text", () => {
    const html = renderToStaticMarkup(<NewIssueDialog />);

    expect(html).toContain('data-slot="agent-menu-label"');
    expect(html).toContain('data-slot="agent-menu-supporting-label"');
    expect(html).toContain("flex-col text-left");
    expect(html).toContain("Chief Technology Officer");
    expect(html).not.toContain("Ella (Chief Technology Officer)");
  });

  it("uses a wider dialog with a compact description editor", () => {
    const html = renderToStaticMarkup(<NewIssueDialog />);

    expect(html).toContain("sm:max-w-[920px]");
    expect(html).toContain("min-h-[88px]");
    expect(html).not.toContain("min-h-[120px]");
  });

  it("does not render the execution workspace controls", () => {
    const html = renderToStaticMarkup(<NewIssueDialog />);

    expect(html).not.toContain("Execution workspace");
    expect(html).not.toContain("Reuse existing workspace");
  });

  it("labels the shared dialog as a sub-issue composer when parent defaults are present", () => {
    dialogState.newIssueDefaults = { parentId: "issue-1", projectId: "project-1" };

    const html = renderToStaticMarkup(<NewIssueDialog />);

    expect(html).toContain("New sub-issue");
    expect(html).toContain("Create sub-issue");
    expect(html).not.toContain(">New issue<");
  });

  it("renders parent issue context when parent defaults include an issue snapshot", () => {
    dialogState.newIssueDefaults = {
      parentId: "issue-1",
      parentIssue: {
        id: "issue-1",
        identifier: "ZST-123",
        title: "Implement issue hierarchy",
      },
    };

    const html = renderToStaticMarkup(<NewIssueDialog />);

    expect(html).toContain("Parent");
    expect(html).toContain("ZST-123");
    expect(html).toContain("Implement issue hierarchy");
    expect(html).toContain('data-slot="new-issue-parent-context"');
  });

  it("falls back to the parent id prefix when only parentId is provided", () => {
    dialogState.newIssueDefaults = { parentId: "12345678-90ab-cdef-1234-567890abcdef" };

    const html = renderToStaticMarkup(<NewIssueDialog />);

    expect(html).toContain("Parent");
    expect(html).toContain("12345678");
  });
});
