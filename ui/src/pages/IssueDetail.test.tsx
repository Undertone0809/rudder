// @vitest-environment node

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { IssueDetail } from "./IssueDetail";

let capturedMentions: Array<Record<string, unknown>> = [];
let mockSourceBreadcrumb: { label: string; href: string } | null = null;

const parentIssue = {
  id: "issue-parent",
  orgId: "org-2",
  projectId: null,
  projectWorkspaceId: null,
  goalId: null,
  parentId: null,
  ancestors: [],
  title: "Parent issue",
  description: "Parent description",
  status: "todo",
  priority: "medium",
  assigneeAgentId: "agent-1",
  assigneeUserId: null,
  checkoutRunId: null,
  executionRunId: null,
  executionAgentNameKey: null,
  executionLockedAt: null,
  createdByAgentId: null,
  createdByUserId: null,
  issueNumber: 1,
  identifier: "ORG2-1",
  originKind: undefined,
  originId: null,
  originRunId: null,
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
  labelIds: [],
  labels: [],
  planDocument: null,
  documentSummaries: [],
  legacyPlanDocument: null,
  project: null,
  goal: null,
  currentExecutionWorkspace: null,
  workProducts: [],
  mentionedProjects: [],
  myLastTouchAt: null,
  lastExternalCommentAt: null,
  isUnreadForMe: false,
  createdAt: new Date("2026-04-20T00:00:00.000Z"),
  updatedAt: new Date("2026-04-20T00:00:00.000Z"),
};

const childIssue = {
  ...parentIssue,
  id: "issue-child",
  parentId: "issue-parent",
  issueNumber: 2,
  identifier: "ORG2-2",
  title: "Existing child issue",
  createdAt: new Date("2026-04-20T00:05:00.000Z"),
  updatedAt: new Date("2026-04-20T00:05:00.000Z"),
};

const queryData = new Map<string, unknown>([
  [JSON.stringify(["issues", "detail", "ORG2-1"]), parentIssue],
  [JSON.stringify(["issues", "comments", "ORG2-1"]), []],
  [JSON.stringify(["issues", "activity", "ORG2-1"]), []],
  [JSON.stringify(["issues", "runs", "ORG2-1"]), []],
  [JSON.stringify(["issues", "approvals", "ORG2-1"]), []],
  [JSON.stringify(["issues", "attachments", "ORG2-1"]), []],
  [JSON.stringify(["issues", "live-runs", "ORG2-1"]), []],
  [JSON.stringify(["issues", "active-run", "ORG2-1"]), null],
  [JSON.stringify(["issues", "org-2"]), []],
  [JSON.stringify(["issues", "org-2", "children", "issue-parent"]), [childIssue]],
  [JSON.stringify(["agents", "org-2"]), [{
    id: "agent-1",
    orgId: "org-2",
    name: "Builder",
    urlKey: "builder",
    role: "engineer",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    agentRuntimeType: "codex_local",
    agentRuntimeConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-04-20T00:00:00.000Z"),
    updatedAt: new Date("2026-04-20T00:00:00.000Z"),
  }]],
  [JSON.stringify(["organization-skills", "org-2"]), [{
    id: "skill-1",
    orgId: "org-2",
    key: "organization/org-2/build-advisor",
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
  }]],
  [JSON.stringify(["agents", "skills", "agent-1"]), {
    agentRuntimeType: "codex_local",
    supported: true,
    mode: "persistent",
    desiredSkills: ["org:organization/org-2/build-advisor"],
    entries: [{
      key: "build-advisor",
      selectionKey: "org:organization/org-2/build-advisor",
      runtimeName: "build-advisor",
      desired: true,
      configurable: true,
      alwaysEnabled: false,
      managed: true,
      state: "configured",
      sourceClass: "organization",
      sourcePath: "/workspace/skills/build-advisor",
    }],
    warnings: [],
  }],
  [JSON.stringify(["projects", "org-2"]), []],
  [JSON.stringify(["auth", "session"]), { user: { id: "user-1" } }],
  [JSON.stringify(["access", "current-board-access"]), { user: { id: "user-1" } }],
]);

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({
    queryKey,
    enabled,
  }: {
    queryKey: unknown[];
    enabled?: boolean;
  }) => {
    if (enabled === false) {
      return { data: undefined, isLoading: false, error: null };
    }
    return {
      data: queryData.get(JSON.stringify(queryKey)),
      isLoading: false,
      error: null,
    };
  },
  useMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    error: null,
  }),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    getQueryData: vi.fn(),
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useLocation: () => ({ pathname: "/ORG2/issues/ORG2-1", state: null }),
  useNavigate: () => vi.fn(),
  useParams: () => ({ issueId: "ORG2-1" }),
}));

vi.mock("../context/OrganizationContext", () => ({
  useOrganization: () => ({
    selectedOrganizationId: "org-1",
    selectedOrganization: { id: "org-1", urlKey: "org-one", issuePrefix: "ORG1" },
    organizations: [
      { id: "org-1", urlKey: "org-one", issuePrefix: "ORG1", status: "active" },
      { id: "org-2", urlKey: "org-two", issuePrefix: "ORG2", status: "active" },
    ],
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../lib/assignees", () => ({
  assigneeValueFromSelection: () => "unassigned",
  suggestedCommentAssigneeValue: () => "unassigned",
}));

vi.mock("../lib/issueDetailBreadcrumb", () => ({
  readIssueDetailBreadcrumb: () => mockSourceBreadcrumb,
}));

vi.mock("../lib/activity-actors", () => ({
  resolveBoardActorLabel: () => "Me",
}));

vi.mock("../hooks/useProjectOrder", () => ({
  useProjectOrder: ({ projects }: { projects: unknown[] }) => ({ orderedProjects: projects }),
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    list: vi.fn(),
    get: vi.fn(),
    listComments: vi.fn(),
    listApprovals: vi.fn(),
    listAttachments: vi.fn(),
    markRead: vi.fn(),
    update: vi.fn(),
    addComment: vi.fn(),
    uploadAttachment: vi.fn(),
    upsertDocument: vi.fn(),
    deleteAttachment: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock("../api/chats", () => ({
  chatsApi: {
    create: vi.fn(),
  },
}));

vi.mock("../api/activity", () => ({
  activityApi: {
    forIssue: vi.fn(),
    runsForIssue: vi.fn(),
  },
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: {
    liveRunsForIssue: vi.fn(),
    activeRunForIssue: vi.fn(),
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    list: vi.fn(),
  },
}));

vi.mock("../api/access", () => ({
  accessApi: {
    getCurrentBoardAccess: vi.fn(),
  },
}));

vi.mock("../api/auth", () => ({
  authApi: {
    getSession: vi.fn(),
  },
}));

vi.mock("../api/projects", () => ({
  projectsApi: {
    list: vi.fn(),
  },
}));

vi.mock("../components/InlineEditor", () => ({
  InlineEditor: ({ value, placeholder, mentions }: { value?: string; placeholder?: string; mentions?: Array<Record<string, unknown>> }) => {
    capturedMentions = mentions ?? [];
    return <div>{value ?? placeholder ?? ""}</div>;
  },
}));

vi.mock("../components/CommentThread", () => ({
  CommentThread: ({ mentions }: { mentions?: Array<Record<string, unknown>> }) => {
    capturedMentions = mentions ?? [];
    return <div>Comment thread</div>;
  },
}));

vi.mock("../components/IssueDocumentsSection", () => ({
  IssueDocumentsSection: ({ mentions }: { mentions?: Array<Record<string, unknown>> }) => {
    capturedMentions = mentions ?? [];
    return <div>Documents</div>;
  },
}));

vi.mock("../components/IssueProperties", () => ({
  IssueProperties: () => <div>Properties</div>,
}));

vi.mock("../components/LiveRunWidget", () => ({
  LiveRunWidget: () => <div>Live run</div>,
}));

vi.mock("../components/ScrollToBottom", () => ({
  ScrollToBottom: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../components/StatusIcon", () => ({
  StatusIcon: () => <span>Status</span>,
}));

vi.mock("../components/PriorityIcon", () => ({
  PriorityIcon: () => <span>Priority</span>,
}));

vi.mock("../components/StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("../components/Identity", () => ({
  Identity: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotMount: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PluginSlotOutlet: () => null,
  usePluginSlots: () => ({ slots: [] }),
}));

vi.mock("@/plugins/launchers", () => ({
  PluginLauncherOutlet: () => null,
}));

vi.mock("@/components/ui/separator", () => ({
  Separator: () => <hr />,
}));

vi.mock("@/components/ui/input", () => ({
  Input: ({ value, placeholder }: { value?: string; placeholder?: string }) => (
    <input value={value} placeholder={placeholder} readOnly />
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CollapsibleContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

vi.mock("lucide-react", () => {
  const Icon = () => <span />;
  return {
    Activity: Icon,
    Check: Icon,
    ChevronDown: Icon,
    ChevronRight: Icon,
    Copy: Icon,
    EyeOff: Icon,
    Hexagon: Icon,
    ListTree: Icon,
    MessageSquare: Icon,
    MoreHorizontal: Icon,
    Paperclip: Icon,
    Plus: Icon,
    Repeat: Icon,
    SlidersHorizontal: Icon,
    Trash2: Icon,
  };
});

describe("IssueDetail", () => {
  it("renders a clickable source breadcrumb in the issue header", () => {
    mockSourceBreadcrumb = { label: "Inbox", href: "/inbox?scope=recent" };

    const html = renderToStaticMarkup(<IssueDetail />);

    expect(html).toContain("Issue navigation");
    expect(html).toContain(">Inbox</a>");
    expect(html).toContain('href="/inbox?scope=recent"');
    expect(html).toContain("Parent issue");
    mockSourceBreadcrumb = null;
  });

  it("renders existing sub-issues from the issue org instead of the selected org cache", () => {
    const html = renderToStaticMarkup(<IssueDetail />);

    expect(html).toContain("Sub-issues");
    expect(html).toContain("Existing child issue");
    expect(html).toContain("Change status for Existing child issue");
    expect(html).toContain("Documents");
  });

  it("includes the issue assignee's enabled skills in mention suggestions", () => {
    renderToStaticMarkup(<IssueDetail />);

    expect(capturedMentions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "skill",
        name: "org/org-two/builder/build-advisor",
        skillMarkdownTarget: "/workspace/skills/build-advisor/SKILL.md",
      }),
    ]));
  });
});
