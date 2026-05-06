// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { NewIssueDialog } from "./NewIssueDialog";

let capturedMentions: Array<Record<string, unknown>> = [];

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
    if (queryKey[0] === "issues" && queryKey[2] === "labels") {
      return {
        data: [
          { id: "label-1", orgId: "org-1", name: "backend", color: "#2563eb", createdAt: "", updatedAt: "" },
        ],
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
  }),
}));

vi.mock("@/context/DialogContext", () => ({
  useDialog: () => ({
    newIssueOpen: true,
    newIssueDefaults: { assigneeAgentId: "agent-1" },
    closeNewIssue: vi.fn(),
  }),
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({
    pathname: "/issues",
    search: "",
  }),
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
  InlineEntitySelector: ({ placeholder, variant }: { placeholder?: string; variant?: string }) => (
    <button type="button" data-variant={variant}>{placeholder ?? "selector"}</button>
  ),
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

  it("renders primary metadata controls as field selectors", () => {
    const html = renderToStaticMarkup(<NewIssueDialog />);

    expect(html).toContain('data-variant="field"');
    expect((html.match(/data-variant="field"/g) ?? []).length).toBeGreaterThanOrEqual(3);
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
});
