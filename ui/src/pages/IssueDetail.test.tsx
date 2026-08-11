// @vitest-environment node

import type { AssistanceRequest } from "@rudderhq/shared";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  IssueDetail,
  buildIssueChatHref,
  buildIssueHeaderBreadcrumbs,
  linkedIssueRunsRefetchInterval,
  selectIssueAssistanceRequest,
} from "./IssueDetail";

let capturedMentions: Array<Record<string, unknown>> = [];
let capturedCommentThreadProps: Record<string, unknown> | null = null;
let capturedInlineEditorProps: Array<Record<string, unknown>> = [];
let mockSourceBreadcrumb: { label: string; href: string } | null = null;
let mockIssuePluginSlots: Array<Record<string, unknown>> = [];

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
  reviewerAgentId: null,
  reviewerUserId: null,
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
  [JSON.stringify(["requests", "org-2", null, "assistance"]), []],
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
    capabilities: null,
    agentRuntimeType: "codex_local",
    agentRuntimeConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false, canManageSkills: true },
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
    sourceLabel: "Organization library",
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
  Link: ({ children, to, title }: { children: ReactNode; to: string; title?: string }) => (
    <a href={to} title={title}>{children}</a>
  ),
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

vi.mock("../context/I18nContext", () => ({
  useI18n: () => ({ locale: "en", t: (key: string) => key }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ confirm: vi.fn(async () => true) }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../lib/assignees", () => ({
  formatAssigneeUserLabel: (userId: string | null | undefined, currentUserId: string | null | undefined) => {
    if (!userId) return null;
    if (currentUserId && userId === currentUserId) return "Me";
    if (userId === "local-board") return "Board";
    return userId.slice(0, 5);
  },
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
    remove: vi.fn(),
    addComment: vi.fn(),
    updateComment: vi.fn(),
    deleteComment: vi.fn(),
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

vi.mock("../api/agent-runs", () => ({
  agentRunsApi: {
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
  InlineEditor: (props: {
    value?: string;
    placeholder?: string;
    mentions?: Array<Record<string, unknown>>;
    variant?: string;
  }) => {
    const { value, placeholder, mentions } = props;
    capturedInlineEditorProps.push(props);
    capturedMentions = mentions ?? [];
    return <div>{value ?? placeholder ?? ""}</div>;
  },
}));

vi.mock("../components/CommentThread", () => ({
  CommentThread: (props: {
    mentions?: Array<Record<string, unknown>>;
    activityItems?: Array<{ id: string; createdAt: Date | string; node: ReactNode }>;
    composerReplacement?: ReactNode;
    fixedComposer?: boolean;
    fixedComposerTimelineScroll?: boolean;
  }) => {
    const { mentions, activityItems = [] } = props;
    capturedMentions = mentions ?? [];
    capturedCommentThreadProps = props;
    const sortedActivityItems = [...activityItems].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    return (
      <div>
        Comment thread
        {sortedActivityItems.map((item) => (
          <div key={item.id}>{item.node}</div>
        ))}
        {props.composerReplacement}
      </div>
    );
  },
}));

vi.mock("../components/IssueProperties", () => ({
  IssueProperties: () => <div>Properties</div>,
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: ({ value, placeholder, "aria-label": ariaLabel }: {
    value?: string;
    placeholder?: string;
    "aria-label"?: string;
  }) => (
    <textarea aria-label={ariaLabel} value={value} placeholder={placeholder} readOnly />
  ),
}));

vi.mock("../components/LiveRunWidget", () => ({
  LiveRunWidget: () => <div>Live run</div>,
}));

vi.mock("../components/ScrollToBottom", () => ({
  ScrollToBottom: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../components/StatusIcon", () => ({
  StatusIcon: ({ status }: { status: string }) => <span data-slot="issue-status-icon" data-status={status}>Status</span>,
}));

vi.mock("../components/PriorityIcon", () => ({
  PriorityIcon: () => <span>Priority</span>,
}));

vi.mock("../components/Identity", () => ({
  Identity: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotMount: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PluginSlotOutlet: () => null,
  usePluginSlots: () => ({ slots: mockIssuePluginSlots }),
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
  const icons = {
    Activity: Icon,
    Atom: Icon,
    BadgeDollarSign: Icon,
    Bot: Icon,
    BookOpen: Icon,
    Braces: Icon,
    Brain: Icon,
    BriefcaseBusiness: Icon,
    Bug: Icon,
    Calendar: Icon,
    ChartNoAxesColumnIncreasing: Icon,
    Check: Icon,
    CheckCircle2: Icon,
    ChevronDown: Icon,
    ChevronRight: Icon,
    CircuitBoard: Icon,
    Clover: Icon,
    Code: Icon,
    Cog: Icon,
    Copy: Icon,
    Cpu: Icon,
    Crown: Icon,
    Database: Icon,
    Dumbbell: Icon,
    Eye: Icon,
    EyeOff: Icon,
    ExternalLink: Icon,
    FileCode2: Icon,
    FileCode: Icon,
    FileText: Icon,
    Fingerprint: Icon,
    Flame: Icon,
    FlaskConical: Icon,
    Flower2: Icon,
    Folder: Icon,
    Gem: Icon,
    Gift: Icon,
    GitBranch: Icon,
    Globe: Icon,
    GraduationCap: Icon,
    Hammer: Icon,
    Heart: Icon,
    Hexagon: Icon,
    Home: Icon,
    Lightbulb: Icon,
    ListTree: Icon,
    Loader2: Icon,
    Lock: Icon,
    Mail: Icon,
    Megaphone: Icon,
    MessageSquare: Icon,
    Microscope: Icon,
    MoreHorizontal: Icon,
    Music: Icon,
    NotebookTabs: Icon,
    Package: Icon,
    Paperclip: Icon,
    Paintbrush: Icon,
    Palette: Icon,
    PawPrint: Icon,
    Pentagon: Icon,
    PenTool: Icon,
    Pencil: Icon,
    Pin: Icon,
    PinOff: Icon,
    Plane: Icon,
    Plus: Icon,
    Popcorn: Icon,
    Puzzle: Icon,
    Radar: Icon,
    Repeat: Icon,
    Rocket: Icon,
    Scale: Icon,
    Search: Icon,
    Settings2: Icon,
    Shield: Icon,
    ShieldAlert: Icon,
    ShieldCheck: Icon,
    SlidersHorizontal: Icon,
    Sparkles: Icon,
    SquareTerminal: Icon,
    Star: Icon,
    Stethoscope: Icon,
    Swords: Icon,
    Target: Icon,
    Telescope: Icon,
    Terminal: Icon,
    Trash2: Icon,
    TreePalm: Icon,
    Upload: Icon,
    UserPlus: Icon,
    Users: Icon,
    Wand2: Icon,
    Wrench: Icon,
    XCircle: Icon,
    XIcon: Icon,
    Zap: Icon,
  };
  return new Proxy(icons, {
    get: (target, prop: string) => {
      if (prop === "then") return undefined;
      if (prop === "__esModule") return true;
      return target[prop as keyof typeof target] ?? Icon;
    },
  });
});

describe("buildIssueChatHref", () => {
  it("opens the Messenger new-chat composer with pending issue context", () => {
    const href = buildIssueChatHref({
      id: "issue-123",
      identifier: "ORG2-123",
      title: "Clarify issue chat behavior",
      projectId: "project-1",
      assigneeAgentId: "agent-1",
    });
    const url = new URL(href, "http://rudder.test");

    expect(url.pathname).toBe("/messenger/chat");
    expect(url.searchParams.get("issueId")).toBe("issue-123");
    expect(url.searchParams.get("projectId")).toBe("project-1");
    expect(url.searchParams.get("agentId")).toBe("agent-1");
    expect(url.searchParams.has("prefill")).toBe(false);
  });
});

describe("buildIssueHeaderBreadcrumbs", () => {
  it("prefixes the current issue title with the human-readable identifier", () => {
    expect(buildIssueHeaderBreadcrumbs({
      sourceBreadcrumb: { label: "Issues", href: "/issues" },
      issue: parentIssue,
      issueId: "ORG2-1",
    })).toEqual([
      { label: "Issues", href: "/issues" },
      { label: "ORG2-1 Parent issue" },
    ]);
  });

  it("keeps parent issue links in hierarchy order", () => {
    expect(buildIssueHeaderBreadcrumbs({
      sourceBreadcrumb: { label: "Inbox", href: "/inbox?scope=recent" },
      issue: {
        ...parentIssue,
        title: "Current child",
        identifier: "ORG2-3",
        ancestors: [
          { ...parentIssue, id: "parent-2", identifier: "ORG2-2", title: "Direct parent" },
          { ...parentIssue, id: "parent-1", identifier: "ORG2-1", title: "Root parent" },
        ],
      },
      issueId: "ORG2-3",
    })).toEqual([
      { label: "Inbox", href: "/inbox?scope=recent" },
      { label: "Root parent", href: "/issues/ORG2-1" },
      { label: "Direct parent", href: "/issues/ORG2-2" },
      { label: "ORG2-3 Current child" },
    ]);
  });
});

describe("selectIssueAssistanceRequest", () => {
  const request = (overrides: Partial<AssistanceRequest>): AssistanceRequest => ({
    id: "request-a",
    orgId: "org-2",
    kind: "assistance",
    subtype: "issue_blocker",
    status: "resolved",
    issueId: "issue-parent",
    requestedByAgentId: "agent-1",
    requestedByUserId: null,
    originRunId: "run-1",
    assigneeAgentId: "agent-1",
    blockerFingerprint: "fingerprint",
    supersededByRequestId: null,
    title: "Request",
    prompt: "Prompt",
    resolution: "answered",
    response: "Done",
    resolvedByUserId: "user-1",
    resolvedAt: new Date("2026-04-20T02:00:00.000Z"),
    metadata: {},
    createdAt: new Date("2026-04-20T01:00:00.000Z"),
    updatedAt: new Date("2026-04-20T02:00:00.000Z"),
    ...overrides,
  });

  it("prefers the open replacement over a newer terminal request", () => {
    const selected = selectIssueAssistanceRequest([
      request({ id: "request-superseded", status: "superseded", updatedAt: new Date("2026-04-20T03:00:00.000Z") }),
      request({ id: "request-open", status: "open", resolution: null, response: null }),
    ], "issue-parent");

    expect(selected?.id).toBe("request-open");
  });

  it("uses updated time and id as deterministic terminal tie breakers", () => {
    const selected = selectIssueAssistanceRequest([
      request({ id: "request-a" }),
      request({ id: "request-b" }),
    ], "issue-parent");

    expect(selected?.id).toBe("request-b");
  });
});

describe("IssueDetail", () => {
  it("polls linked run summaries only while issue execution is live", () => {
    expect(linkedIssueRunsRefetchInterval(false)).toBe(false);
    expect(linkedIssueRunsRefetchInterval(true)).toBe(5000);
  });

  beforeEach(() => {
    capturedMentions = [];
    capturedCommentThreadProps = null;
    capturedInlineEditorProps = [];
    mockSourceBreadcrumb = null;
    mockIssuePluginSlots = [];
    queryData.set(JSON.stringify(["issues", "detail", "ORG2-1"]), parentIssue);
    queryData.set(JSON.stringify(["issues", "activity", "ORG2-1"]), []);
    queryData.set(JSON.stringify(["issues", "approvals", "ORG2-1"]), []);
    queryData.set(JSON.stringify(["issues", "org-2", "follows"]), []);
    queryData.set(JSON.stringify(["requests", "org-2", null, "assistance"]), []);
    queryData.set(JSON.stringify(["organizations", "org-2", "library-documents"]), []);
    queryData.set(JSON.stringify(["organizations", "org-2", "workspace-mention-files", ""]), { entries: [] });
    queryData.delete(JSON.stringify([
      "plugins",
      "rudder.linear",
      "issue-link",
      "org-2",
      "issue-parent",
      "plugin-linear",
    ]));
  });

  it("does not duplicate the header-owned issue breadcrumb in the page body", () => {
    mockSourceBreadcrumb = { label: "Inbox", href: "/inbox?scope=recent" };

    const html = renderToStaticMarkup(<IssueDetail />);

    expect(html).not.toContain("Issue navigation");
    expect(html).not.toContain(">Inbox</a>");
    expect(html).not.toContain('href="/inbox?scope=recent"');
    expect(html).toContain("Parent issue");
    mockSourceBreadcrumb = null;
  });

  it("renders existing sub-issues from the issue org instead of the selected org cache", () => {
    const html = renderToStaticMarkup(<IssueDetail />);

    expect(html).toContain("Sub-issues");
    expect(html).toContain("Existing child issue");
    expect(html).toContain("Change status for Existing child issue");
    expect(html).toContain("Activity");
    expect(html).toContain("Comment thread");
    expect(html).not.toContain("New document");
    expect(html).not.toContain(">Activity</button>");
    expect(html).not.toContain("Comments &amp; Runs");
  });

  it("renders an open Assistance Request as an inline Issue decision", () => {
    queryData.set(JSON.stringify(["requests", "org-2", null, "assistance"]), [{
      id: "request-open",
      orgId: "org-2",
      kind: "assistance",
      subtype: "issue_blocker",
      status: "open",
      issueId: "issue-parent",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      originRunId: "run-1",
      assigneeAgentId: "agent-1",
      blockerFingerprint: "fingerprint",
      supersededByRequestId: null,
      title: "GitHub confirmation required",
      prompt: "Approve the mobile confirmation before token creation can continue.",
      resolution: null,
      response: null,
      resolvedByUserId: null,
      resolvedAt: null,
      metadata: { attempt: 3 },
      createdAt: new Date("2026-04-20T01:00:00.000Z"),
      updatedAt: new Date("2026-04-20T01:00:00.000Z"),
    }]);
    queryData.set(JSON.stringify(["issues", "detail", "ORG2-1"]), {
      ...parentIssue,
      status: "blocked",
    });

    const html = renderToStaticMarkup(<IssueDetail />);

    expect(html).toContain('aria-label="Assistance request"');
    expect(html).toContain('aria-label="Answer or describe what changed"');
    expect(html).toContain("Blocked · Waiting on you");
    expect(html).toContain("Attempt 3/3");
    expect(html).toContain("Send answer");
    expect(html).toContain("Mark action complete");
    expect(html).toContain("Cannot help");
    expect(html).toContain("Cancel request");
    expect(html).toContain("Open in Requests");
    expect((capturedCommentThreadProps?.composerReplacement as ReactElement).key).toBe("request-open");
  });

  it("keeps a resolved Assistance Request visible without mutation controls", () => {
    queryData.set(JSON.stringify(["requests", "org-2", null, "assistance"]), [{
      id: "request-resolved",
      orgId: "org-2",
      kind: "assistance",
      subtype: "issue_blocker",
      status: "resolved",
      issueId: "issue-parent",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      originRunId: "run-1",
      assigneeAgentId: "agent-1",
      blockerFingerprint: "fingerprint",
      supersededByRequestId: null,
      title: "GitHub confirmation required",
      prompt: "Approve the mobile confirmation before token creation can continue.",
      resolution: "action_completed",
      response: "GitHub mobile confirmation approved.",
      resolvedByUserId: "user-1",
      resolvedAt: new Date("2026-04-20T02:00:00.000Z"),
      metadata: { attempt: 3 },
      createdAt: new Date("2026-04-20T01:00:00.000Z"),
      updatedAt: new Date("2026-04-20T02:00:00.000Z"),
    }]);

    const html = renderToStaticMarkup(<IssueDetail />);

    expect(html).toContain("Action completed");
    expect(html).toContain("GitHub mobile confirmation approved.");
    expect(html).toContain("Open in Requests");
    expect(html).not.toContain("Send answer");
    expect(html).not.toContain("Cancel request");
    const activityItems = capturedCommentThreadProps?.activityItems as Array<{ node: ReactElement }>;
    expect(activityItems[0]?.node.key).toBe("request-resolved");
  });

  it("renders a superseded Assistance Request with operator-facing copy", () => {
    queryData.set(JSON.stringify(["requests", "org-2", null, "assistance"]), [{
      id: "request-superseded",
      orgId: "org-2",
      kind: "assistance",
      subtype: "issue_blocker",
      status: "superseded",
      issueId: "issue-parent",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      originRunId: "run-1",
      assigneeAgentId: "agent-1",
      blockerFingerprint: "fingerprint",
      supersededByRequestId: "request-replacement",
      title: "GitHub confirmation required",
      prompt: "Approve the mobile confirmation before token creation can continue.",
      resolution: null,
      response: null,
      resolvedByUserId: null,
      resolvedAt: null,
      metadata: { attempt: 1, supersededReason: "blocker_changed" },
      createdAt: new Date("2026-04-20T01:00:00.000Z"),
      updatedAt: new Date("2026-04-20T02:00:00.000Z"),
    }]);

    const html = renderToStaticMarkup(<IssueDetail />);

    expect(html).toContain("Superseded because");
    expect(html).toContain("The blocking condition changed.");
    expect(html).not.toContain("blocker_changed");
  });

  it("shows parent issue context directly under the title for sub-issues", () => {
    queryData.set(JSON.stringify(["issues", "detail", "ORG2-1"]), {
      ...childIssue,
      title: "Child issue with title context",
      ancestors: [parentIssue],
    });

    const html = renderToStaticMarkup(<IssueDetail />);

    expect(html).toContain("Parent issue context");
    expect(html).toContain("Sub-issue of");
    expect(html).toContain('href="/issues/ORG2-1"');
    expect(html).toContain("ORG2-1");
    expect(html).toContain("Parent issue");
  });

  it("routes parent issue context with the full id when no identifier exists", () => {
    queryData.set(JSON.stringify(["issues", "detail", "ORG2-1"]), {
      ...childIssue,
      title: "Legacy child issue",
      ancestors: [{ ...parentIssue, identifier: null }],
    });

    const html = renderToStaticMarkup(<IssueDetail />);

    expect(html).toContain('href="/issues/issue-parent"');
    expect(html).toContain("issue-pa");
  });

  it("keeps the description in the Library-style WYSIWYG editor", () => {
    renderToStaticMarkup(<IssueDetail />);

    const descriptionEditorProps = capturedInlineEditorProps.find(
      (props) => props.placeholder === "Add a description...",
    );
    expect(descriptionEditorProps).toMatchObject({
      multiline: true,
      editorEngine: "codemirror",
      alwaysEdit: true,
      variant: "issue-description",
    });
  });

  it("renders linked Library files with a stable icon affordance", () => {
    queryData.set(JSON.stringify(["issues", "detail", "ORG2-1"]), {
      ...parentIssue,
      description: "Use [@product-brief.md](library-file://file?p=docs%2Fproduct-brief.md&t=product-brief.md).",
    });
    queryData.set(JSON.stringify(["organizations", "org-2", "workspace-mention-files", ""]), {
      entries: [{
        name: "product-brief.md",
        path: "docs/product-brief.md",
        isDirectory: false,
      }],
    });

    const html = renderToStaticMarkup(<IssueDetail />);

    expect(html).toContain('aria-label="Linked Library"');
    expect(html).toContain('data-testid="linked-library-resource-icon"');
    expect(html).toContain('data-kind="file"');
    expect(html).toContain("product-brief.md");
    expect(html).toContain("live Library file / docs/product-brief.md");
    expect(html).toContain('href="/library?path=docs%2Fproduct-brief.md"');
  });

  it("keeps one semantic responsive layout in the page-level scroll flow", () => {
    const html = renderToStaticMarkup(<IssueDetail />);
    const headingIndex = html.indexOf('data-testid="issue-detail-heading"');
    const actionsIndex = html.indexOf('data-testid="issue-detail-actions"');
    const propertiesIndex = html.indexOf('data-testid="issue-detail-sidebar"');
    const bodyIndex = html.indexOf('data-testid="issue-detail-primary-content"');
    const descriptionIndex = html.indexOf("Parent description");

    expect(html).toContain('data-testid="issue-detail-main-scroll"');
    expect(html).toContain("issue-detail-container h-full min-h-0 w-full scrollbar-auto-hide overflow-x-hidden overflow-y-auto overscroll-contain");
    expect(html).toContain('class="issue-detail-layout mx-auto min-h-full max-w-6xl"');
    expect(html).toContain('class="issue-detail-body min-w-0 space-y-6" data-testid="issue-detail-primary-content"');
    expect(html).toContain('aria-label="Activity" class="flex flex-col space-y-2"');
    expect(headingIndex).toBeGreaterThanOrEqual(0);
    expect(headingIndex).toBeLessThan(actionsIndex);
    expect(actionsIndex).toBeLessThan(propertiesIndex);
    expect(propertiesIndex).toBeLessThan(bodyIndex);
    expect(bodyIndex).toBeLessThan(descriptionIndex);
    expect(html.match(/aria-label="Issue properties"/g)).toHaveLength(1);
    expect(html.match(/>Copy ID</g)).toHaveLength(1);
    expect(html.match(/>Chat</g)).toHaveLength(1);
    expect(html.match(/>Pin Issue</g)).toHaveLength(1);
    expect(html.match(/>Delete Issue</g)).toHaveLength(1);
    expect(capturedCommentThreadProps).toMatchObject({
      fixedComposer: true,
      fixedComposerTimelineScroll: false,
    });
    expect(html).not.toContain('data-testid="issue-detail-primary-scroll"');
    expect(html).not.toContain('data-testid="comment-thread-timeline-scroll"');
    expect(html).toContain('class="issue-detail-properties min-w-0" data-testid="issue-detail-sidebar"');
    expect(html).not.toContain("xl:grid");
    expect(html).not.toContain("xl:sticky");
    expect(html).not.toContain('xl:overflow-y-auto');
  });

  it("keeps an embedded issue detail in its own scroll flow", () => {
    const html = renderToStaticMarkup(<IssueDetail embedded embeddedIssueId="ORG2-1" />);

    expect(html).toContain('data-testid="embedded-issue-detail"');
    expect(html).toContain("h-full min-h-0 w-full scrollbar-auto-hide overflow-x-hidden overflow-y-auto overscroll-contain");
    expect(html).not.toContain('data-testid="issue-detail-main-scroll"');
  });

  it("exposes issue pin and unpin actions in the detail more menu", () => {
    let html = renderToStaticMarkup(<IssueDetail />);

    expect(html).toContain("Pin Issue");
    expect(html).toContain("Delete Issue");
    expect(html).not.toContain("Hide this Issue");
    expect(html).not.toContain("Unpin Issue");

    queryData.set(JSON.stringify(["issues", "org-2", "follows"]), [{
      id: "follow-1",
      orgId: "org-2",
      issueId: "issue-parent",
      userId: "user-1",
      issue: parentIssue,
      createdAt: new Date("2026-04-20T00:10:00.000Z"),
    }]);
    html = renderToStaticMarkup(<IssueDetail />);

    expect(html).toContain("Unpin Issue");
  });

  it("keeps assignee changes out of the issue comment composer", () => {
    renderToStaticMarkup(<IssueDetail />);

    expect(capturedCommentThreadProps).not.toHaveProperty("enableReassign");
    expect(capturedCommentThreadProps).not.toHaveProperty("reassignOptions");
    expect(capturedCommentThreadProps).not.toHaveProperty("currentAssigneeValue");
    expect(capturedCommentThreadProps).not.toHaveProperty("suggestedAssigneeValue");
  });

  it("passes comment edit and delete handlers with the current board user", () => {
    renderToStaticMarkup(<IssueDetail />);

    expect(capturedCommentThreadProps).toMatchObject({
      currentUserId: "user-1",
      onUpdate: expect.any(Function),
      onDelete: expect.any(Function),
    });
  });

  it("includes the issue assignee's enabled skills in mention suggestions", () => {
    renderToStaticMarkup(<IssueDetail />);

    expect(capturedMentions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "skill",
        name: "build-advisor",
        skillRefLabel: "build-advisor",
        skillMarkdownTarget: "skill://org/skill-1?ref=build-advisor",
      }),
    ]));
  });

  it("renders detailed assignment activity and hides low-signal update rows", () => {
    queryData.set(JSON.stringify(["issues", "activity", "ORG2-1"]), [
      {
        id: "activity-assigned",
        orgId: "org-2",
        actorType: "user",
        actorId: "user-1",
        action: "issue.updated",
        entityType: "issue",
        entityId: "issue-parent",
        agentId: null,
        runId: null,
        details: { assigneeAgentId: "agent-1", _previous: { assigneeAgentId: null } },
        createdAt: new Date("2026-04-20T01:00:00.000Z"),
      },
      {
        id: "activity-reviewer",
        orgId: "org-2",
        actorType: "user",
        actorId: "user-1",
        action: "issue.updated",
        entityType: "issue",
        entityId: "issue-parent",
        agentId: null,
        runId: null,
        details: {
          reviewerAgentId: null,
          reviewerUserId: "user-1",
          _previous: { reviewerAgentId: "agent-1", reviewerUserId: null },
        },
        createdAt: new Date("2026-04-20T01:05:00.000Z"),
      },
      {
        id: "activity-description-only",
        orgId: "org-2",
        actorType: "user",
        actorId: "user-1",
        action: "issue.updated",
        entityType: "issue",
        entityId: "issue-parent",
        agentId: null,
        runId: null,
        details: { description: "New description", _previous: { description: "Old description" } },
        createdAt: new Date("2026-04-20T01:10:00.000Z"),
      },
      {
        id: "activity-title-only",
        orgId: "org-2",
        actorType: "user",
        actorId: "user-1",
        action: "issue.updated",
        entityType: "issue",
        entityId: "issue-parent",
        agentId: null,
        runId: null,
        details: { title: "New title", _previous: { title: "Old title" } },
        createdAt: new Date("2026-04-20T01:11:00.000Z"),
      },
      {
        id: "activity-title-description-only",
        orgId: "org-2",
        actorType: "user",
        actorId: "user-1",
        action: "issue.updated",
        entityType: "issue",
        entityId: "issue-parent",
        agentId: null,
        runId: null,
        details: {
          title: "Combined title",
          description: "Combined description",
          _previous: { title: "Previous title", description: "Previous description" },
        },
        createdAt: new Date("2026-04-20T01:11:30.000Z"),
      },
      {
        id: "activity-goal",
        orgId: "org-2",
        actorType: "user",
        actorId: "user-1",
        action: "issue.updated",
        entityType: "issue",
        entityId: "issue-parent",
        agentId: null,
        runId: null,
        details: { goalId: "goal-new", _previous: { goalId: "goal-old" } },
        createdAt: new Date("2026-04-20T01:12:00.000Z"),
      },
      {
        id: "activity-parent",
        orgId: "org-2",
        actorType: "user",
        actorId: "user-1",
        action: "issue.updated",
        entityType: "issue",
        entityId: "issue-parent",
        agentId: null,
        runId: null,
        details: {
          parentId: "issue-review-summary",
          _previous: { parentId: null },
          _references: {
            parentIssue: {
              id: "issue-review-summary",
              identifier: "ZST-442",
              title: "Messenger review summary",
            },
          },
        },
        createdAt: new Date("2026-04-20T01:13:00.000Z"),
      },
      {
        id: "activity-status",
        orgId: "org-2",
        actorType: "user",
        actorId: "user-1",
        action: "issue.updated",
        entityType: "issue",
        entityId: "issue-parent",
        agentId: null,
        runId: null,
        details: { status: "in_progress", _previous: { status: "todo" } },
        createdAt: new Date("2026-04-20T01:14:00.000Z"),
      },
      {
        id: "activity-document-updated",
        orgId: "org-2",
        actorType: "user",
        actorId: "user-1",
        action: "issue.document_updated",
        entityType: "issue",
        entityId: "issue-parent",
        agentId: null,
        runId: null,
        details: { key: "note", title: "Hidden document update unique" },
        createdAt: new Date("2026-04-20T01:15:00.000Z"),
      },
      {
        id: "activity-run-workspace-only",
        orgId: "org-2",
        actorType: "user",
        actorId: "user-1",
        action: "issue.updated",
        entityType: "issue",
        entityId: "issue-parent",
        agentId: null,
        runId: null,
        details: {
          executionWorkspaceId: "run-workspace-1",
          executionWorkspaceSettings: { mode: "shared_workspace" },
          _previous: { executionWorkspaceId: null },
        },
        createdAt: new Date("2026-04-20T01:15:30.000Z"),
      },
      {
        id: "activity-comment-updated",
        orgId: "org-2",
        actorType: "user",
        actorId: "user-1",
        action: "issue.comment_updated",
        entityType: "issue",
        entityId: "issue-parent",
        agentId: null,
        runId: null,
        details: { commentId: "comment-1" },
        createdAt: new Date("2026-04-20T01:16:00.000Z"),
      },
      {
        id: "activity-comment-deleted",
        orgId: "org-2",
        actorType: "user",
        actorId: "user-1",
        action: "issue.comment_deleted",
        entityType: "issue",
        entityId: "issue-parent",
        agentId: null,
        runId: null,
        details: { commentId: "comment-1" },
        createdAt: new Date("2026-04-20T01:17:00.000Z"),
      },
      {
        id: "activity-issue-deleted",
        orgId: "org-2",
        actorType: "user",
        actorId: "user-1",
        action: "issue.deleted",
        entityType: "issue",
        entityId: "issue-parent",
        agentId: null,
        runId: null,
        details: {},
        createdAt: new Date("2026-04-20T01:18:00.000Z"),
      },
      {
        id: "activity-review-handoff",
        orgId: "org-2",
        actorType: "agent",
        actorId: "agent-1",
        action: "issue.review_decision_recorded",
        entityType: "issue",
        entityId: "issue-parent",
        agentId: "agent-1",
        runId: null,
        details: { decision: "blocked", outcome: "review_closed" },
        createdAt: new Date("2026-04-20T01:20:00.000Z"),
      },
      {
        id: "activity-code-committed",
        orgId: "org-2",
        actorType: "agent",
        actorId: "agent-1",
        action: "issue.code_committed",
        entityType: "issue",
        entityId: "issue-parent",
        agentId: "agent-1",
        runId: "run-1",
        details: { shortSha: "abc1234", subject: "fix: report code commit" },
        createdAt: new Date("2026-04-20T01:22:00.000Z"),
      },
    ]);

    const html = renderToStaticMarkup(<IssueDetail />);

    expect(html).toContain("assigned the issue to Builder");
    expect(html).toContain("changed the reviewer from Builder to Me");
    expect(html).toContain("changed the goal");
    expect(html).toContain("set the parent issue to");
    expect(html).toContain("href=\"/issues/ZST-442\"");
    expect(html).toContain("ZST-442");
    expect(html).toContain("moved from Todo to In Progress");
    expect(html).toContain("recorded reviewer decision: blocked");
    expect(html).toContain("committed abc1234: fix: report code commit");
    expect(html).not.toContain("operator handoff");
    expect(html).not.toContain("requested human intervention");
    expect(html).toContain("data-testid=\"issue-activity-row\"");
    expect(html).toContain("grid-cols-[16px_minmax(0,1fr)]");
    expect(html).toContain("data-testid=\"issue-activity-summary\"");
    expect(html).toContain("whitespace-nowrap");
    expect(html).toContain("data-status=\"in_progress\"");
    expect(html).toContain("border-transparent");
    expect(html).toContain("pl-3");
    expect(html).toContain("tabular-nums");
    expect(html).not.toContain("updated the issue");
    expect(html).not.toContain("run workspace");
    expect(html).not.toContain("updated the title");
    expect(html).not.toContain("updated the description");
    expect(html).not.toContain("Hidden document update unique");
    expect(html).not.toContain("edited a comment");
    expect(html).not.toContain("deleted a comment");
    expect(html).not.toContain("deleted the issue");
  });

  it("bounds long chat activity descriptions and keeps the full label in the summary title", () => {
    const longChatTitle = "A very long chat title that should be truncated in the compact issue activity row";
    queryData.set(JSON.stringify(["issues", "activity", "ORG2-1"]), [{
      id: "activity-long-chat",
      orgId: "org-2",
      actorType: "user",
      actorId: "user-1",
      action: "chat.created",
      entityType: "chat",
      entityId: "chat-long",
      agentId: null,
      runId: null,
      details: { conversationTitle: longChatTitle },
      createdAt: new Date("2026-04-20T01:25:00.000Z"),
    }]);

    const html = renderToStaticMarkup(<IssueDetail />);

    expect(html).toContain("data-testid=\"issue-activity-summary\"");
    expect(html).toContain("min-w-0 truncate");
    expect(html).toContain("title=\"" + longChatTitle + "\"");
  });

  it("renders approval link events as ordinary activity rows", () => {
    queryData.set(JSON.stringify(["issues", "activity", "ORG2-1"]), [
      {
        id: "activity-approval-linked",
        orgId: "org-2",
        actorType: "user",
        actorId: "user-1",
        action: "issue.approval_linked",
        entityType: "issue",
        entityId: "issue-parent",
        agentId: null,
        runId: null,
        details: {
          approvalId: "approval-chat-123",
          linkCreatedAt: "2026-04-20T01:31:00.000Z",
        },
        createdAt: new Date("2026-04-20T01:31:00.000Z"),
      },
    ]);

    const html = renderToStaticMarkup(<IssueDetail />);

    expect(html).toContain('href="/messenger/approvals/approval-chat-123"');
    expect(html).toContain("linked");
    expect(html).toContain("an approval");
    expect(html).not.toContain("Linked Approvals");
    expect(html).not.toContain("Issue proposed from chat");
  });

  it("orders existing approvals by the later issue link time", () => {
    queryData.set(JSON.stringify(["issues", "activity", "ORG2-1"]), [
      {
        id: "activity-created",
        orgId: "org-2",
        actorType: "user",
        actorId: "user-1",
        action: "issue.created",
        entityType: "issue",
        entityId: "issue-parent",
        agentId: null,
        runId: null,
        details: {},
        createdAt: new Date("2026-04-20T00:00:00.000Z"),
      },
      {
        id: "activity-approval-linked",
        orgId: "org-2",
        actorType: "user",
        actorId: "user-1",
        action: "issue.approval_linked",
        entityType: "issue",
        entityId: "issue-parent",
        agentId: null,
        runId: null,
        details: {
          approvalId: "approval-created-first",
          linkCreatedAt: "2026-04-20T00:01:00.000Z",
        },
        createdAt: new Date("2026-04-20T00:01:00.000Z"),
      },
    ]);

    const html = renderToStaticMarkup(<IssueDetail />);

    expect(html.indexOf("created the issue")).toBeLessThan(
      html.indexOf('href="/messenger/approvals/approval-created-first"'),
    );
    expect(html).toContain('href="/messenger/approvals/approval-created-first"');
  });

  it("keeps repeated approval link activity events visible", () => {
    queryData.set(JSON.stringify(["issues", "activity", "ORG2-1"]), [
      {
        id: "activity-approval-linked",
        orgId: "org-2",
        actorType: "user",
        actorId: "user-1",
        action: "issue.approval_linked",
        entityType: "issue",
        entityId: "issue-parent",
        agentId: null,
        runId: null,
        details: {
          approvalId: "approval-repeat-link",
          linkCreatedAt: "2026-04-20T00:11:00.000Z",
        },
        createdAt: new Date("2026-04-20T00:11:00.000Z"),
      },
      {
        id: "activity-approval-linked-later",
        orgId: "org-2",
        actorType: "user",
        actorId: "user-1",
        action: "issue.approval_linked",
        entityType: "issue",
        entityId: "issue-parent",
        agentId: null,
        runId: null,
        details: {
          approvalId: "approval-repeat-link",
          linkCreatedAt: "2026-04-20T00:20:00.000Z",
        },
        createdAt: new Date("2026-04-20T00:20:00.000Z"),
      },
    ]);

    const html = renderToStaticMarkup(<IssueDetail />);

    expect(html.match(/href="\/messenger\/approvals\/approval-repeat-link"/g)).toHaveLength(2);
  });

  it("moves the linked Linear issue summary into activity instead of a separate tab", () => {
    mockIssuePluginSlots = [
      {
        type: "detailTab",
        id: "linear-issue-tab",
        displayName: "Linear",
        exportName: "LinearIssueTab",
        entityTypes: ["issue"],
        pluginId: "plugin-linear",
        pluginKey: "rudder.linear",
        pluginDisplayName: "Linear",
        pluginVersion: "0.1.0",
      },
      {
        type: "detailTab",
        id: "delivery-tab",
        displayName: "Delivery",
        exportName: "DeliveryTab",
        entityTypes: ["issue"],
        pluginId: "plugin-delivery",
        pluginKey: "rudder.delivery",
        pluginDisplayName: "Delivery",
        pluginVersion: "0.1.0",
      },
    ];
    queryData.set(JSON.stringify([
      "plugins",
      "rudder.linear",
      "issue-link",
      "org-2",
      "issue-parent",
      "plugin-linear",
    ]), {
      linked: true,
      issueTitle: "Parent issue",
      link: {
        externalId: "lin-1",
        linearIdentifier: "ENG-42",
        linearTitle: "Imported Linear issue",
        linearUrl: "https://linear.app/acme/issue/ENG-42/imported-linear-issue",
        orgId: "org-2",
        rudderIssueId: "issue-parent",
        rudderIssueIdentifier: "ORG2-1",
        teamId: "team-1",
        teamName: "Engineering",
        projectId: "linear-project-1",
        projectName: "Roadmap",
        stateId: "state-progress",
        stateName: "In Progress",
        importedAt: new Date("2026-04-20T00:00:00.000Z"),
        updatedAt: new Date("2026-04-20T01:00:00.000Z"),
      },
      latestIssue: {
        id: "lin-1",
        identifier: "ENG-42",
        title: "Imported Linear issue",
        description: "Fresh Linear context.",
        url: "https://linear.app/acme/issue/ENG-42/imported-linear-issue",
        updatedAt: new Date("2026-04-20T02:00:00.000Z"),
        createdAt: new Date("2026-04-19T00:00:00.000Z"),
        team: { id: "team-1", name: "Engineering" },
        state: { id: "state-progress", name: "In Progress" },
        project: { id: "linear-project-1", name: "Roadmap" },
        assignee: { id: "linear-user-1", name: "Amy Zhang" },
      },
      staleReason: null,
    });

    const html = renderToStaticMarkup(<IssueDetail />);

    expect(html).toContain("Linked Linear issue");
    expect(html).toContain("ENG-42");
    expect(html).toContain("Fresh Linear context.");
    expect(html).toContain("Open in Linear");
    expect(html).toContain(">Delivery</h3>");
    expect(html).not.toContain(">Linear</h3>");
  });
});
