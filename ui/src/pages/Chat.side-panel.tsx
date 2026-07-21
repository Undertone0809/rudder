import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { chatsApi } from "@/api/chats";
import { ApiError } from "@/api/client";
import { issuesApi } from "@/api/issues";
import { organizationsApi } from "@/api/orgs";
import { AgentIcon } from "@/components/AgentIconPicker";
import { CommentThread } from "@/components/CommentThread";
import { InlineEditor } from "@/components/InlineEditor";
import { IssueProperties } from "@/components/IssueProperties";
import { MarkdownEditor, type MarkdownEditorRef } from "@/components/MarkdownEditor";
import { PriorityIcon } from "@/components/PriorityIcon";
import { SideChatPanelView } from "@/components/side-panel/SideChatPanelView";
import { StatusBadge } from "@/components/StatusBadge";
import { TranscriptLocalFilePreview } from "@/components/transcript/TranscriptLocalFilePreview";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  isWorkspaceCsvPreviewFile,
  isWorkspaceHtmlPreviewFile,
  isWorkspaceMarkdownPreviewFile,
  WorkspaceFilePreview,
  type WorkspaceFilePreviewMode,
} from "@/components/WorkspaceFilePreview";
import { WorkspaceLaunchTargetIcon } from "@/components/workspaces/WorkspaceLaunchControls";
import { useOrganization } from "@/context/OrganizationContext";
import { MAX_BROWSER_TABS_PER_CONTEXT, useSidePanel } from "@/context/SidePanelContext";
import { useToast } from "@/context/ToastContext";
import { useOperatorDisplayName } from "@/hooks/useOperatorDisplayName";
import {
  BROWSER_SIDE_PANEL_BLANK_URL as CHAT_SIDE_PANEL_BROWSER_BLANK_URL,
  browserSidePanelLabel as chatSidePanelBrowserLabel,
  createBrowserSidePanelTarget as createChatSidePanelBrowserTarget,
  normalizeBrowserSidePanelUrl as normalizeChatSidePanelBrowserUrl,
} from "@/lib/browser-side-panel";
import { readDesktopShell, type DesktopFileLaunchTargetId, type DesktopWorkspaceLaunchTarget } from "@/lib/desktop-shell";
import { applyOrganizationPrefix, extractOrganizationPrefixFromPath, getOrganizationRouteKey } from "@/lib/organization-routes";
import { queryKeys } from "@/lib/queryKeys";
import { useLocation, useNavigate } from "@/lib/router";
import { sidePanelTargetKey, type SidePanelTarget } from "@/lib/side-panel-targets";
import { cn } from "@/lib/utils";
import { isWorkspaceHtmlFilePath } from "@/lib/workspace-html-preview";
import {
  resolveBrowserShortcutInput,
  type Agent,
  type BrowserShortcutAction,
  type Issue,
  type IssueComment,
  type OrganizationWorkspaceFileDetail,
  type OrganizationWorkspaceFileEntry
} from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Box,
  Boxes,
  ChevronDown,
  ChevronRight,
  Circle,
  CirclePlus,
  Compass,
  ExternalLink,
  FileCode2,
  FileText,
  FileWarning,
  Folder,
  Globe2,
  Image as ImageIcon,
  LibraryBig,
  Loader2,
  Maximize2,
  MessageSquare,
  Minimize2,
  PackageOpen,
  PanelRight,
  Plus,
  Redo2,
  RotateCw,
  Table2,
  Undo2,
  UserRound,
  X
} from "lucide-react";
import {
  createElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { AutomationDetail } from "./AutomationDetail";
import { conversationDisplayTitle } from "./Chat.parts";
import { ChatSidePanelTabContextMenu, type SideChatTarget } from "./Chat.side-panel-tab-menu";
import {
  chatSidePanelBrowserErrorContent,
  clearChatSidePanelMarkdownDraft,
  countChatSidePanelMarkdownWords,
  isChatSidePanelCloseShortcutInput,
  joinChatSidePanelYamlFrontmatter,
  restoreChatSidePanelMarkdownDraft,
  splitChatSidePanelYamlFrontmatter,
  storeChatSidePanelMarkdownDraft,
  type BrowserLoadError,
  type BrowserWebviewInputEvent,
  type RestoredChatSidePanelMarkdownDraft,
} from "./Chat.side-panel.helpers";
import { IssueDetail } from "./IssueDetail";

const CHAT_SIDE_PANEL_IMAGE_FILE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
]);
const CHAT_SIDE_PANEL_TEXT_DOCUMENT_FILE_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdown",
  ".mdx",
  ".txt",
  ".text",
]);
const CHAT_SIDE_PANEL_TAB_DND_MIME = "application/x-rudder-side-panel-tab";
const CHAT_SIDE_PANEL_MARKDOWN_CONFLICT_MESSAGE = "This file changed while you were editing it.";
const CHAT_SIDE_PANEL_BROWSER_ZOOM_FACTORS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
] as const;

function useChatSidePanelMobileLayout() {
  const [isMobile, setIsMobile] = useState(() => (
    typeof window !== "undefined" && Boolean(window.matchMedia?.("(max-width: 767px)").matches)
  ));

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const mediaQuery = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(mediaQuery.matches);
    update();
    mediaQuery.addEventListener?.("change", update);
    return () => mediaQuery.removeEventListener?.("change", update);
  }, []);

  return isMobile;
}

type BrowserWebviewElement = HTMLElement & {
  canGoBack?: () => boolean;
  canGoForward?: () => boolean;
  getURL?: () => string;
  goBack?: () => void;
  goForward?: () => void;
  reload?: () => void;
  reloadIgnoringCache?: () => void;
  setZoomFactor?: (factor: number) => void;
};

function LoadingPanelBody() {
  return (
    <div className="space-y-3" data-testid="chat-side-panel-loading">
      <div className="h-4 w-2/3 animate-pulse rounded bg-[color:var(--surface-active)]" />
      <div className="h-20 animate-pulse rounded-[var(--radius-lg)] bg-[color:var(--surface-active)]" />
      <div className="h-28 animate-pulse rounded-[var(--radius-lg)] bg-[color:var(--surface-active)]" />
    </div>
  );
}

function humanizeSidePanelToken(value: string | null | undefined, fallback = "-") {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  return trimmed.replace(/_/g, " ");
}

function SidePanelEmptyState({
  browserAvailable,
  sourceConversationId,
  onOpenTarget,
}: {
  browserAvailable: boolean;
  sourceConversationId: string | null;
  onOpenTarget: (target: SidePanelTarget) => void;
}) {
  const targets: Array<{
    label: string;
    description: string;
    icon: typeof Compass;
    target: SidePanelTarget;
  }> = [
    ...(sourceConversationId ? [{
      label: "Side Chat",
      description: "Ask a focused follow-up without leaving the main chat.",
      icon: CirclePlus,
      target: {
        kind: "side_chat" as const,
        sourceConversationId,
        sourceMessageId: null,
        sourcePreview: null,
        conversationId: null,
        clientMutationId: crypto.randomUUID(),
        label: "Side Chat",
      },
    }] : []),
    ...(browserAvailable ? [{
      label: "Browser",
      description: "Keep a browser tab beside the current workspace.",
      icon: Compass,
      target: createChatSidePanelBrowserTarget(),
    }] : []),
    {
      label: "Library",
      description: "Browse workspace files with the Library tree.",
      icon: Folder,
      target: { kind: "library_directory", directoryPath: "", label: "Library" },
    },
  ];

  return (
    <div className="flex min-h-full flex-col justify-center py-6" data-testid="chat-side-panel-empty-state">
      <div className="space-y-2">
        <h3 className="text-base font-semibold text-foreground">Open a panel</h3>
        <p className="text-sm leading-6 text-muted-foreground">Choose a workspace target to keep working without leaving this page.</p>
      </div>
      <div className="mt-5 grid gap-2">
        {targets.map(({ label, description, icon: Icon, target }) => (
          <button
            key={label}
            type="button"
            data-testid={`chat-side-panel-empty-${label.toLowerCase()}-target`}
            className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] px-3 py-3 text-left text-sm transition-colors hover:bg-[color:var(--surface-active)]"
            onClick={() => onOpenTarget(target)}
          >
            <Icon className="h-4 w-4 text-muted-foreground" />
            <span className="min-w-0">
              <span className="block font-medium text-foreground">{label}</span>
              <span className="block truncate text-xs text-muted-foreground">{description}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SidePanelPlaceholderView({
  browserAvailable,
  target,
  onOpenTarget,
}: {
  browserAvailable: boolean;
  target: Extract<SidePanelTarget, { kind: "placeholder" }>;
  onOpenTarget: (target: SidePanelTarget) => void;
}) {
  const config = {
    issue: {
      icon: Circle,
      title: "Issue",
      body: "Open an issue link or use workspace search to load the editable task panel here.",
      actions: [
        { label: "Library", target: { kind: "library_directory", directoryPath: "", label: "Library" } as SidePanelTarget },
        { label: "Chat", target: { kind: "placeholder", targetKind: "chat", label: "Chat" } as SidePanelTarget },
      ],
    },
    automation: {
      icon: Bot,
      title: "Automation",
      body: "Open an automation link to inspect schedule state and pause or resume it without leaving this page.",
      actions: [
        { label: "Issue", target: { kind: "placeholder", targetKind: "issue", label: "Issue" } as SidePanelTarget },
        { label: "Library", target: { kind: "library_directory", directoryPath: "", label: "Library" } as SidePanelTarget },
      ],
    },
    chat: {
      icon: MessageSquare,
      title: "Chat",
      body: "Open a chat reference to compare messages beside the current workspace.",
      actions: [
        { label: "Issue", target: { kind: "placeholder", targetKind: "issue", label: "Issue" } as SidePanelTarget },
        { label: "Browser", target: createChatSidePanelBrowserTarget() as SidePanelTarget },
      ],
    },
  }[target.targetKind];
  const actions = config.actions.filter((action) => browserAvailable || action.target.kind !== "browser");
  const Icon = config.icon;

  return (
    <div className="flex min-h-full flex-col justify-center py-6" data-testid={`chat-side-panel-${target.targetKind}-placeholder`}>
      <div className="mx-auto flex max-w-[18rem] flex-col items-center text-center">
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-[color:var(--surface-active)] text-muted-foreground">
          <Icon className="h-4 w-4" />
        </span>
        <h3 className="mt-3 text-base font-semibold text-foreground">{config.title}</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{config.body}</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {actions.map((action) => (
            <Button key={action.label} type="button" variant="outline" size="sm" onClick={() => onOpenTarget(action.target)}>
              {action.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ChatIssueSidePanelView({
  issue,
  comments,
  commentId,
  onUpdate,
  onAddComment,
  updating,
  addingComment,
  currentUserId,
  agentMap,
  operatorDisplayName,
  expanded = false,
}: {
  issue: Issue;
  comments: IssueComment[];
  commentId: string | null;
  onUpdate: (data: Record<string, unknown>) => Promise<Issue>;
  onAddComment: (body: string, reopen?: boolean) => Promise<void>;
  updating: boolean;
  addingComment: boolean;
  currentUserId: string | null;
  agentMap: Map<string, Agent>;
  operatorDisplayName: string | null;
  expanded?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const issueRef = issue.identifier ?? issue.id.slice(0, 8);
  const projectName = issue.project?.name ?? null;

  const updateIssueField = async (data: Record<string, unknown>) => {
    setError(null);
    try {
      await onUpdate(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update this issue.");
    }
  };
  const issueProperties = (
    <IssueProperties
      issue={issue}
      onUpdate={(data) => void updateIssueField(data)}
      showAuditSeparator={false}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="chat-side-panel-issue-view">
      <div className={cn(
        "grid h-full min-h-0 flex-1 gap-6",
        expanded
          ? "xl:grid-cols-[minmax(0,1fr)_280px] xl:items-start"
          : "scrollbar-auto-hide overflow-y-auto overscroll-contain pr-1",
      )} data-testid="chat-side-panel-issue-scroll">
        <div className="flex min-h-0 min-w-0 flex-col gap-5">
          <div className="shrink-0 space-y-3 pb-1">
            <div className="flex items-start justify-between gap-3">
              <InlineEditor
                value={issue.title}
                onSave={(title) => updateIssueField({ title })}
                as="h2"
                className="min-w-0 flex-1 text-xl font-bold leading-7 text-foreground"
                placeholder="Add a title..."
              />
              <span className="mt-1 shrink-0 rounded-[calc(var(--radius-sm)-1px)] border border-[color:var(--border-soft)] px-2 py-0.5 text-xs text-muted-foreground">
                {issueRef}
              </span>
            </div>
            {expanded ? (
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={issue.status} />
                <span className="inline-flex items-center gap-1.5 rounded-[calc(var(--radius-sm)-1px)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] px-2.5 py-1 text-xs font-medium text-muted-foreground shadow-[var(--shadow-sm)]">
                  <PriorityIcon priority={issue.priority} showLabel />
                </span>
                {projectName ? (
                  <span className="rounded-[calc(var(--radius-sm)-1px)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] px-2.5 py-1 text-xs font-medium text-muted-foreground shadow-[var(--shadow-sm)]">{projectName}</span>
                ) : null}
              </div>
            ) : null}
            {!expanded ? (
              <section aria-label="Issue properties" className="py-3">
                <IssueProperties issue={issue} onUpdate={(data) => void updateIssueField(data)} showAuditFields={false} />
              </section>
            ) : null}
            <InlineEditor
              value={issue.description ?? ""}
              onSave={(description) => updateIssueField({ description: description.trim() || null })}
              as="p"
              className="text-[15px] leading-7 text-foreground"
              placeholder="Add a description..."
              multiline
              editorEngine="milkdown"
              alwaysEdit
              variant="issue-description"
            />
            {error ? (
              <div role="alert" className="rounded-[var(--radius-md)] border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            ) : null}
          </div>

          <section className="shrink-0 space-y-3 pb-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm">
                <div className="flex items-center gap-1.5 font-medium text-foreground">
                  <Boxes className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>Sub-issues</span>
                </div>
                <span className="rounded-sm border border-[color:var(--border-soft)] px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  0
                </span>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">No sub-issues.</p>
          </section>

          <section aria-label="Activity" className="space-y-2 py-1">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h4 className="text-sm font-semibold text-foreground">Activity</h4>
              <span className="text-xs text-muted-foreground">
                {addingComment ? "Posting..." : `${comments.filter((comment) => !comment.deletedAt).length}`}
              </span>
            </div>
            <div className="mb-3 space-y-3 text-sm text-muted-foreground">
              {commentId ? (
                <div className="rounded-[var(--radius-md)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] px-3 py-2">
                  Target comment: <span className="font-mono text-foreground">{commentId}</span>
                </div>
              ) : null}
            </div>
            <CommentThread
              comments={comments}
              orgId={issue.orgId}
              projectId={issue.projectId}
              issueStatus={issue.status}
              agentMap={agentMap}
              currentUserId={currentUserId}
              operatorDisplayName={operatorDisplayName}
              hideHeading
              emptyMessage="No comments yet."
              draftKey={`rudder:side-panel-issue-comment-draft:${issue.id}`}
              fixedComposer
              fixedComposerTimelineScroll={false}
              onAdd={onAddComment}
            />
          </section>
        </div>

        {expanded ? (
          <aside className="space-y-3 xl:sticky xl:top-0">
            <section aria-label="Issue properties" className="rounded-lg border border-border bg-background/80 p-3">
              <div className="mb-3 flex items-center justify-between gap-2">
                <p className="text-[11px] font-medium text-muted-foreground">Properties</p>
              </div>
              {issueProperties}
            </section>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function chatSidePanelWorkspaceFileExtension(filePath: string | null) {
  if (!filePath) return null;
  const basename = filePath.split("/").at(-1) ?? filePath;
  const extensionIndex = basename.lastIndexOf(".");
  return extensionIndex === -1 ? null : basename.slice(extensionIndex).toLowerCase();
}

function isChatSidePanelWorkspaceImageFile(filePath: string | null) {
  const extension = chatSidePanelWorkspaceFileExtension(filePath);
  return extension !== null && CHAT_SIDE_PANEL_IMAGE_FILE_EXTENSIONS.has(extension);
}

function isChatSidePanelWorkspaceTextDocumentFile(filePath: string | null) {
  const extension = chatSidePanelWorkspaceFileExtension(filePath);
  return extension !== null && CHAT_SIDE_PANEL_TEXT_DOCUMENT_FILE_EXTENSIONS.has(extension);
}

function displayChatSidePanelWorkspaceEntryLabel(entry: Pick<OrganizationWorkspaceFileEntry, "displayLabel" | "name">) {
  return entry.displayLabel?.trim() || entry.name;
}

function isChatSidePanelLibrarySkillsRootPath(path: string) {
  const segments = path.split("/").filter(Boolean);
  return path === "skills"
    || (segments.length === 3 && segments[0] === "agents" && segments[2] === "skills");
}

function isChatSidePanelLibrarySkillPackageFolderPath(path: string) {
  const segments = path.split("/").filter(Boolean);
  return (segments.length === 2 && segments[0] === "skills")
    || (segments.length === 4 && segments[0] === "agents" && segments[2] === "skills");
}

function isChatSidePanelProjectLibraryFolderPath(path: string) {
  const segments = path.split("/").filter(Boolean);
  return segments.length === 2 && segments[0] === "projects";
}

function ChatSidePanelLibraryDirectoryIcon({ entry }: { entry: OrganizationWorkspaceFileEntry }) {
  const isAgentWorkspace = entry.entityType === "agent_workspace";
  if (isAgentWorkspace) {
    return (
      <span
        data-testid="chat-side-panel-library-agent-icon"
        className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted-foreground"
      >
        <AgentIcon icon={entry.agentIcon} role={entry.agentRole} className="h-3.5 w-3.5 text-[12px]" />
      </span>
    );
  }

  if (entry.path === "agents") {
    return (
      <UserRound
        data-testid="chat-side-panel-library-agents-root-icon"
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
      />
    );
  }

  if (isChatSidePanelLibrarySkillsRootPath(entry.path)) {
    return (
      <Boxes
        data-testid="chat-side-panel-library-skills-root-icon"
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
      />
    );
  }

  if (isChatSidePanelLibrarySkillPackageFolderPath(entry.path)) {
    return (
      <Box
        data-testid="chat-side-panel-library-skill-folder-icon"
        className="h-3.5 w-3.5 shrink-0 text-[#2f80ed]"
      />
    );
  }

  if (isChatSidePanelProjectLibraryFolderPath(entry.path)) {
    return (
      <PackageOpen
        data-testid="chat-side-panel-library-project-icon"
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
      />
    );
  }

  return <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

function ChatSidePanelLibraryTree({
  entries,
  selectedOrganizationId,
  onOpenTarget,
  selectedPath,
}: {
  entries: OrganizationWorkspaceFileEntry[];
  selectedOrganizationId: string | null | undefined;
  onOpenTarget: (target: SidePanelTarget) => void;
  selectedPath: string | null;
}) {
  if (entries.length === 0) {
    return <div className="px-2 py-3 text-sm text-muted-foreground">This folder is empty or unavailable.</div>;
  }

  return (
    <ul className="space-y-0.5">
      {entries.map((entry) => (
        <ChatSidePanelLibraryTreeNode
          key={entry.path}
          entry={entry}
          selectedOrganizationId={selectedOrganizationId}
          onOpenTarget={onOpenTarget}
          selectedPath={selectedPath}
        />
      ))}
    </ul>
  );
}

function ChatSidePanelLibraryTreeNode({
  entry,
  selectedOrganizationId,
  onOpenTarget,
  selectedPath,
  depth = 0,
}: {
  entry: OrganizationWorkspaceFileEntry;
  selectedOrganizationId: string | null | undefined;
  onOpenTarget: (target: SidePanelTarget) => void;
  selectedPath: string | null;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const primaryLabel = displayChatSidePanelWorkspaceEntryLabel(entry);
  const isSelected = selectedPath === entry.path;
  const childrenQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceFiles(selectedOrganizationId ?? "__none__", entry.path),
    queryFn: () => organizationsApi.listWorkspaceFiles(selectedOrganizationId!, entry.path),
    enabled: Boolean(selectedOrganizationId && entry.isDirectory && expanded),
    refetchOnWindowFocus: false,
  });
  const childEntries = childrenQuery.data?.entries ?? [];

  if (entry.isDirectory) {
    return (
      <li>
        <div
          className={cn(
            "group flex w-full items-center rounded-md pr-1 text-sm text-foreground transition-[background-color,color,opacity,transform] duration-150",
            isSelected ? "bg-accent text-foreground" : "hover:bg-accent/60",
          )}
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
          data-workspace-entry-path={entry.path}
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-0 pr-2 text-left"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </span>
            <ChatSidePanelLibraryDirectoryIcon entry={entry} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{primaryLabel}</div>
            </div>
            {entry.entityType === "agent_workspace" ? (
              <span
                aria-hidden="true"
                data-testid="chat-side-panel-library-agent-badge"
                className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
              >
                Agent
              </span>
            ) : null}
          </button>
        </div>
        {expanded ? (
          childrenQuery.isPending ? (
            <div
              className="px-2 py-1.5 text-sm text-muted-foreground"
              style={{ paddingLeft: `${(depth + 1) * 14 + 23}px` }}
            >
              Loading files...
            </div>
          ) : childEntries.length > 0 ? (
            <ul className="space-y-0.5">
              {childEntries.map((childEntry) => (
                <ChatSidePanelLibraryTreeNode
                  key={childEntry.path}
                  entry={childEntry}
                  selectedOrganizationId={selectedOrganizationId}
                  onOpenTarget={onOpenTarget}
                  selectedPath={selectedPath}
                  depth={depth + 1}
                />
              ))}
            </ul>
          ) : null
        ) : null}
      </li>
    );
  }

  const FileIcon = isChatSidePanelWorkspaceImageFile(entry.path)
    ? ImageIcon
    : isWorkspaceHtmlFilePath(entry.path)
      ? Globe2
      : isChatSidePanelWorkspaceTextDocumentFile(entry.path)
        ? FileText
        : FileCode2;

  return (
    <li>
      <div
        className={cn(
          "group flex w-full items-center rounded-md pr-1 text-sm transition-[background-color,color,opacity,transform] duration-150",
          isSelected
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        )}
        style={{ paddingLeft: `${depth * 14 + 23}px` }}
        data-workspace-entry-path={entry.path}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-0 pr-2 text-left"
          onClick={() => onOpenTarget({
            kind: "library_file",
            filePath: entry.path,
            label: primaryLabel,
          })}
          aria-selected={isSelected}
        >
          <FileIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{primaryLabel}</span>
        </button>
      </div>
    </li>
  );
}

function ChatSidePanelMarkdownFileEditor({
  libraryFile,
  organizationId,
}: {
  libraryFile: OrganizationWorkspaceFileDetail;
  organizationId: string;
}) {
  const queryClient = useQueryClient();
  const filePath = libraryFile.filePath;
  const serverContent = libraryFile.content ?? "";
  const restoredDraftRef = useRef<RestoredChatSidePanelMarkdownDraft | null>(null);
  if (restoredDraftRef.current === null) {
    restoredDraftRef.current = restoreChatSidePanelMarkdownDraft(organizationId, filePath, serverContent);
  }
  const restoredDraft = restoredDraftRef.current;
  const editorRef = useRef<MarkdownEditorRef>(null);
  const syncedContentRef = useRef(restoredDraft.baseContent);
  const latestServerContentRef = useRef(serverContent);
  const draftContentRef = useRef(restoredDraft.content);
  const queuedSaveRef = useRef<string | null>(null);
  const saveInFlightRef = useRef(false);
  const saveConflictRef = useRef(restoredDraft.conflicted);
  const saveResolutionVersionRef = useRef(0);
  const mountedRef = useRef(true);
  const [draftContent, setDraftContent] = useState(restoredDraft.content);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "error">(
    restoredDraft.conflicted ? "error" : draftContent === serverContent ? "saved" : "saving",
  );
  const [saveError, setSaveError] = useState<string | null>(
    restoredDraft.conflicted ? CHAT_SIDE_PANEL_MARKDOWN_CONFLICT_MESSAGE : null,
  );
  const [saveConflict, setSaveConflict] = useState(restoredDraft.conflicted);
  const [, setHistoryVersion] = useState(0);

  draftContentRef.current = draftContent;
  latestServerContentRef.current = serverContent;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      storeChatSidePanelMarkdownDraft(
        organizationId,
        filePath,
        syncedContentRef.current,
        draftContentRef.current,
      );
    };
  }, [filePath, organizationId]);

  useEffect(() => {
    if (serverContent === syncedContentRef.current) return;
    if (serverContent === draftContentRef.current) {
      syncedContentRef.current = serverContent;
      saveConflictRef.current = false;
      setSaveConflict(false);
      setSaveStatus("saved");
      setSaveError(null);
      clearChatSidePanelMarkdownDraft(organizationId, filePath);
      return;
    }
    const wasClean = draftContentRef.current === syncedContentRef.current;
    if (wasClean) {
      syncedContentRef.current = serverContent;
      draftContentRef.current = serverContent;
      setDraftContent(serverContent);
      saveConflictRef.current = false;
      setSaveConflict(false);
      setSaveStatus("saved");
      setSaveError(null);
      clearChatSidePanelMarkdownDraft(organizationId, filePath);
      return;
    }
    queuedSaveRef.current = null;
    saveConflictRef.current = true;
    saveResolutionVersionRef.current += 1;
    setSaveConflict(true);
    setSaveStatus("error");
    setSaveError(CHAT_SIDE_PANEL_MARKDOWN_CONFLICT_MESSAGE);
    storeChatSidePanelMarkdownDraft(
      organizationId,
      filePath,
      syncedContentRef.current,
      draftContentRef.current,
    );
  }, [filePath, organizationId, serverContent]);

  const acceptSavedDetail = useCallback((
    detail: OrganizationWorkspaceFileDetail,
    attemptedContent: string,
  ) => {
    const savedContent = detail.content ?? attemptedContent;
    syncedContentRef.current = savedContent;
    latestServerContentRef.current = savedContent;
    saveConflictRef.current = false;
    if (mountedRef.current) {
      setSaveConflict(false);
      setSaveError(null);
    }
    queryClient.setQueryData(
      queryKeys.organizations.workspaceFile(organizationId, filePath),
      detail,
    );
    storeChatSidePanelMarkdownDraft(
      organizationId,
      filePath,
      savedContent,
      draftContentRef.current,
    );
    if (draftContentRef.current !== savedContent) {
      queuedSaveRef.current = draftContentRef.current;
    }
  }, [filePath, organizationId, queryClient]);

  const drainSaveQueue = useCallback(async () => {
    if (saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    try {
      while (queuedSaveRef.current !== null) {
        const content = queuedSaveRef.current;
        const resolutionVersion = saveResolutionVersionRef.current;
        queuedSaveRef.current = null;
        if (saveConflictRef.current) return;
        if (content === syncedContentRef.current) continue;
        if (mountedRef.current) {
          setSaveStatus("saving");
          setSaveError(null);
        }
        try {
          const detail = await organizationsApi.updateWorkspaceFile(organizationId, filePath, {
            content,
            expectedContent: syncedContentRef.current,
          });
          if (resolutionVersion !== saveResolutionVersionRef.current) continue;
          acceptSavedDetail(detail, content);
        } catch (error) {
          if (resolutionVersion !== saveResolutionVersionRef.current) continue;
          let latestDetail: OrganizationWorkspaceFileDetail | null = null;
          try {
            latestDetail = await organizationsApi.readWorkspaceFile(organizationId, filePath);
          } catch {
            // Preserve the original save error when the verification read also fails.
          }
          if (resolutionVersion !== saveResolutionVersionRef.current) continue;
          if (latestDetail) {
            latestServerContentRef.current = latestDetail.content ?? "";
            queryClient.setQueryData(
              queryKeys.organizations.workspaceFile(organizationId, filePath),
              latestDetail,
            );
          }
          if (latestDetail?.content === content) {
            acceptSavedDetail(latestDetail, content);
            continue;
          }
          if (latestDetail && latestDetail.content !== syncedContentRef.current) {
            queuedSaveRef.current = null;
            saveConflictRef.current = true;
            storeChatSidePanelMarkdownDraft(
              organizationId,
              filePath,
              syncedContentRef.current,
              draftContentRef.current,
            );
          }
          if (mountedRef.current) {
            setSaveStatus("error");
            const conflicted = saveConflictRef.current;
            setSaveConflict(conflicted);
            setSaveError(
              conflicted
                ? CHAT_SIDE_PANEL_MARKDOWN_CONFLICT_MESSAGE
                : error instanceof Error ? error.message : "Could not save this file.",
            );
          }
          return;
        }
      }
      if (mountedRef.current) {
        setSaveStatus(
          queuedSaveRef.current === null && draftContentRef.current === syncedContentRef.current
            ? "saved"
            : "saving",
        );
      }
    } finally {
      saveInFlightRef.current = false;
      if (queuedSaveRef.current !== null && !saveConflictRef.current) {
        void drainSaveQueue();
      }
    }
  }, [acceptSavedDetail, filePath, organizationId, queryClient]);

  const enqueueSave = useCallback((content: string) => {
    queuedSaveRef.current = content;
    void drainSaveQueue();
  }, [drainSaveQueue]);

  useEffect(() => {
    storeChatSidePanelMarkdownDraft(
      organizationId,
      filePath,
      syncedContentRef.current,
      draftContent,
    );
    if (saveConflictRef.current) return undefined;
    if (draftContent === syncedContentRef.current) {
      setSaveStatus(saveInFlightRef.current || queuedSaveRef.current !== null ? "saving" : "saved");
      setSaveError(null);
      return undefined;
    }
    const timeout = window.setTimeout(() => enqueueSave(draftContent), 700);
    return () => window.clearTimeout(timeout);
  }, [draftContent, enqueueSave, filePath, organizationId]);

  const handleDraftChange = (content: string) => {
    draftContentRef.current = content;
    setDraftContent(content);
    setSaveStatus(saveConflictRef.current ? "error" : "saving");
    if (!saveConflictRef.current) setSaveError(null);
    setHistoryVersion((current) => current + 1);
  };

  const useLatestServerContent = () => {
    const content = latestServerContentRef.current;
    saveResolutionVersionRef.current += 1;
    syncedContentRef.current = content;
    draftContentRef.current = content;
    queuedSaveRef.current = null;
    saveConflictRef.current = false;
    setDraftContent(content);
    setSaveConflict(false);
    setSaveStatus("saved");
    setSaveError(null);
    clearChatSidePanelMarkdownDraft(organizationId, filePath);
  };

  const keepLocalDraft = () => {
    saveResolutionVersionRef.current += 1;
    syncedContentRef.current = latestServerContentRef.current;
    saveConflictRef.current = false;
    setSaveConflict(false);
    setSaveStatus("saving");
    setSaveError(null);
    enqueueSave(draftContentRef.current);
  };

  const markdownParts = splitChatSidePanelYamlFrontmatter(draftContent);
  const wordCount = countChatSidePanelMarkdownWords(markdownParts.body);
  const canUndo = editorRef.current?.canUndo?.() ?? false;
  const canRedo = editorRef.current?.canRedo?.() ?? false;

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      data-testid="chat-side-panel-library-markdown-editor"
    >
      <div className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto px-5 pb-20 pt-5">
        {markdownParts.frontmatter !== null ? (
          <details
            className="group mb-6 rounded-md border border-[color:var(--border-soft)] bg-[color:var(--surface-page)]"
            data-testid="chat-side-panel-library-frontmatter-editor"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
              <span>Frontmatter</span>
              <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
            </summary>
            <textarea
              value={markdownParts.frontmatter}
              onChange={(event) => handleDraftChange(joinChatSidePanelYamlFrontmatter(
                event.currentTarget.value,
                markdownParts.separator,
                markdownParts.body,
              ))}
              spellCheck={false}
              className="block min-h-28 w-full resize-y border-t border-[color:var(--border-soft)] bg-transparent px-3 py-2 font-mono text-xs leading-5 text-foreground outline-none"
              aria-label="Frontmatter"
            />
          </details>
        ) : null}
        <MarkdownEditor
          ref={editorRef}
          key={filePath}
          engine="milkdown"
          value={markdownParts.body}
          onChange={(body) => handleDraftChange(joinChatSidePanelYamlFrontmatter(
            markdownParts.frontmatter,
            markdownParts.separator,
            body,
          ))}
          bordered={false}
          placeholder="Write in Markdown..."
          contentClassName="rudder-library-document-editor rudder-side-panel-library-document min-h-[420px] text-[15px] leading-7 text-foreground"
        />
      </div>

      <div className="pointer-events-none absolute inset-x-3 bottom-3 flex min-w-0 items-end justify-between gap-3">
        <div
          className={cn(
            "pointer-events-auto flex min-h-8 min-w-0 items-center gap-2 rounded-md border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] px-2.5 text-xs shadow-sm",
            saveStatus === "error" ? "text-destructive" : "text-muted-foreground",
          )}
          role={saveStatus === "error" ? "alert" : "status"}
          title={saveError ?? undefined}
        >
          <span className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            saveStatus === "error" ? "bg-destructive" : saveStatus === "saving" ? "bg-[color:var(--accent-strong)]" : "bg-emerald-500",
          )} />
          <span className="truncate">
            {saveConflict ? "Conflict" : saveStatus === "error" ? "Save failed" : saveStatus === "saving" ? "Saving" : "Saved"}
            {` · ${wordCount.toLocaleString()} ${wordCount === 1 ? "word" : "words"}`}
          </span>
          {saveConflict ? (
            <>
              <button
                type="button"
                className="shrink-0 font-medium text-foreground underline underline-offset-2"
                onClick={keepLocalDraft}
              >
                Keep mine
              </button>
              <button
                type="button"
                className="shrink-0 font-medium text-foreground underline underline-offset-2"
                onClick={useLatestServerContent}
              >
                Use latest
              </button>
            </>
          ) : saveStatus === "error" ? (
            <button
              type="button"
              className="shrink-0 font-medium text-foreground underline underline-offset-2"
              onClick={() => enqueueSave(draftContentRef.current)}
            >
              Retry
            </button>
          ) : null}
        </div>

        <TooltipProvider delayDuration={120}>
          <div
            className="pointer-events-auto flex shrink-0 items-center rounded-md border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] p-0.5 shadow-sm"
            data-testid="chat-side-panel-library-history-controls"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-[4px] text-muted-foreground transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
                  aria-label="Undo Markdown edit"
                  disabled={!canUndo}
                  onClick={() => {
                    editorRef.current?.undo?.();
                    setHistoryVersion((current) => current + 1);
                  }}
                >
                  <Undo2 className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">Undo</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-[4px] text-muted-foreground transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
                  aria-label="Redo Markdown edit"
                  disabled={!canRedo}
                  onClick={() => {
                    editorRef.current?.redo?.();
                    setHistoryVersion((current) => current + 1);
                  }}
                >
                  <Redo2 className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">Redo</TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      </div>
    </div>
  );
}

function ChatSidePanelLibraryFileView({
  libraryFile,
  organizationId,
}: {
  libraryFile: OrganizationWorkspaceFileDetail;
  organizationId: string;
}) {
  const { pushToast } = useToast();
  const { selectedOrganization } = useOrganization();
  const location = useLocation();
  const navigate = useNavigate();
  const html = isWorkspaceHtmlPreviewFile(libraryFile);
  const csv = isWorkspaceCsvPreviewFile(libraryFile);
  const markdown = isWorkspaceMarkdownPreviewFile(libraryFile);
  const [previewMode, setPreviewMode] = useState<WorkspaceFilePreviewMode>("preview");
  const pathSegments = libraryFile.filePath.split("/").filter(Boolean);
  const visiblePathSegments = pathSegments.length > 3
    ? ["…", ...pathSegments.slice(-2)]
    : pathSegments;
  const [launchTargets, setLaunchTargets] = useState<DesktopWorkspaceLaunchTarget[]>([]);
  const [openMenuOpen, setOpenMenuOpen] = useState(false);
  const [openingTargetId, setOpeningTargetId] = useState<string | null>(null);
  const [pathTooltipOpen, setPathTooltipOpen] = useState(false);
  const desktopShell = readDesktopShell();
  const canOpenFile = Boolean(libraryFile.rootPath && desktopShell?.openWorkspaceFileInIde);

  useEffect(() => {
    let cancelled = false;
    if (!canOpenFile || !desktopShell?.listWorkspaceLaunchTargets) {
      setLaunchTargets([]);
      return undefined;
    }
    void desktopShell.listWorkspaceLaunchTargets()
      .then((targets) => {
        if (!cancelled) setLaunchTargets(targets);
      })
      .catch(() => {
        if (!cancelled) setLaunchTargets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [canOpenFile, desktopShell]);

  const visibleTargets = launchTargets.filter((target) => (
    (target.kind === "ide" && target.id !== "xcode")
    || ((target.kind === "terminal" || target.kind === "folder") && Boolean(desktopShell?.openWorkspaceFileLocation))
  ));
  const libraryPath = applyOrganizationPrefix(
    `/library?path=${encodeURIComponent(libraryFile.filePath)}`,
    selectedOrganization
      ? getOrganizationRouteKey(selectedOrganization)
      : extractOrganizationPrefixFromPath(location.pathname),
  );

  const openTarget = async (target: { id: DesktopFileLaunchTargetId | DesktopWorkspaceLaunchTarget["id"]; label: string; kind: "app" | DesktopWorkspaceLaunchTarget["kind"] }) => {
    if (!libraryFile.rootPath || !desktopShell) return;
    setOpeningTargetId(target.id);
    try {
      if (target.kind === "app" || target.kind === "ide") {
        await desktopShell.openWorkspaceFileInIde(
          libraryFile.rootPath,
          libraryFile.filePath,
          target.id as DesktopFileLaunchTargetId,
        );
      } else {
        await desktopShell.openWorkspaceFileLocation?.(
          libraryFile.rootPath,
          libraryFile.filePath,
          target.id as DesktopWorkspaceLaunchTarget["id"],
        );
      }
      pushToast({ title: `Opened in ${target.label}`, tone: "success" });
    } catch (error) {
      pushToast({
        title: `Could not open in ${target.label}`,
        body: error instanceof Error ? error.message : "Try another app.",
        tone: "error",
      });
    } finally {
      setOpeningTargetId(null);
    }
  };

  const openInMenu = (
    <DropdownMenu
      open={openMenuOpen}
      onOpenChange={(nextOpen) => {
        setOpenMenuOpen(nextOpen);
        if (nextOpen) setPathTooltipOpen(false);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1 px-2"
          aria-label="Open file options"
          title="Open file options"
        >
          <span>Open</span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={() => navigate(libraryPath)}>
          <LibraryBig className="h-4 w-4" />
          <span>Open in Library</span>
        </DropdownMenuItem>
        {canOpenFile ? (
          <DropdownMenuItem
            disabled={openingTargetId !== null}
            onSelect={() => void openTarget({ id: "defaultApp", label: "Default app", kind: "app" })}
          >
            <ExternalLink className="h-4 w-4" />
            <span>Default app</span>
          </DropdownMenuItem>
        ) : null}
        {visibleTargets.map((target) => (
          <DropdownMenuItem
            key={target.id}
            disabled={openingTargetId !== null}
            onSelect={() => void openTarget(target)}
          >
            <WorkspaceLaunchTargetIcon target={target} className="h-4 w-4" />
            <span>{target.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const showSourceAction = previewMode === "preview";
  const fileModeToggleLabel = showSourceAction ? "Show source" : "Show table";
  const FileModeToggleIcon = showSourceAction ? FileCode2 : Table2;
  const fileModeToggle = csv ? (
    <TooltipProvider delayDuration={120}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            aria-label={fileModeToggleLabel}
            data-testid="chat-side-panel-library-file-mode-toggle"
            onClick={() => setPreviewMode(showSourceAction ? "source" : "preview")}
          >
            <FileModeToggleIcon className="h-4 w-4" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={8}>{fileModeToggleLabel}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ) : null;

  return (
    <div className="flex h-full min-h-[420px] flex-col" data-testid="chat-side-panel-library-file-view">
      <div
        className="flex h-11 shrink-0 items-center gap-3 border-b border-[color:var(--border-soft)] px-4"
        data-testid="chat-side-panel-library-file-toolbar"
      >
        {html ? (
          <Globe2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : (
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <TooltipProvider delayDuration={120}>
          <Tooltip
            open={pathTooltipOpen && !openMenuOpen}
            onOpenChange={setPathTooltipOpen}
          >
            <TooltipTrigger asChild>
              <nav
                aria-label="Library file path"
                className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-sm"
                tabIndex={0}
              >
                {visiblePathSegments.map((segment, index) => {
                  const isFileName = index === visiblePathSegments.length - 1;
                  return (
                    <span key={`${segment}-${index}`} className="contents">
                      {index > 0 ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" /> : null}
                      <span className={cn(
                        "truncate",
                        isFileName
                          ? "max-w-[60%] shrink-0 font-medium text-foreground"
                          : "min-w-0 text-muted-foreground",
                      )}>
                        {segment}
                      </span>
                    </span>
                  );
                })}
              </nav>
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              sideOffset={8}
              className="max-w-[min(36rem,calc(100vw-2rem))] break-all text-left leading-5"
              data-testid="chat-side-panel-library-full-path"
            >
              {libraryFile.filePath}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {fileModeToggle}
        {!html ? (
          <div className="shrink-0" data-testid="chat-side-panel-library-open-in">
            {openInMenu}
          </div>
        ) : null}
      </div>
      {markdown && !libraryFile.truncated ? (
        <ChatSidePanelMarkdownFileEditor
          key={`${organizationId}:${libraryFile.filePath}`}
          libraryFile={libraryFile}
          organizationId={organizationId}
        />
      ) : (
        <>
          {markdown && libraryFile.truncated ? (
            <div
              className="shrink-0 border-b border-[color:var(--border-soft)] px-4 py-2 text-xs text-muted-foreground"
              data-testid="chat-side-panel-library-readonly-notice"
              role="status"
            >
              {libraryFile.message ?? "This file is too large to edit in the Side Panel."}
            </div>
          ) : null}
          <WorkspaceFilePreview
            file={libraryFile}
            organizationId={organizationId}
            mode={previewMode}
            onModeChange={setPreviewMode}
            htmlOpenAction={html ? (
              <div className="shrink-0" data-testid="chat-side-panel-library-open-in">
                {openInMenu}
              </div>
            ) : undefined}
            testIdPrefix="chat-side-panel-library"
          />
        </>
      )}
    </div>
  );
}

function ChatSidePanelBrowserView({
  active,
  canOpenNewTab,
  target,
  targetKey,
  onOpenTarget,
  onReplaceTarget,
  onCloseTarget,
  onRegisterShortcutController,
}: {
  active: boolean;
  canOpenNewTab: boolean;
  target: Extract<SidePanelTarget, { kind: "browser" }>;
  targetKey: string;
  onOpenTarget: (target: SidePanelTarget) => void;
  onReplaceTarget: (key: string, target: SidePanelTarget) => void;
  onCloseTarget: (target: SidePanelTarget) => void;
  onRegisterShortcutController: (key: string, controller: ((action: BrowserShortcutAction) => void) | null) => void;
}) {
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const webviewRef = useRef<BrowserWebviewElement | null>(null);
  const webviewReadyRef = useRef(false);
  const targetUrlRef = useRef(target.url);
  const currentUrlRef = useRef(target.url);
  const targetRef = useRef(target);
  const onReplaceTargetRef = useRef(onReplaceTarget);
  const onCloseTargetRef = useRef(onCloseTarget);
  const activeRef = useRef(active);
  const executeBrowserShortcutRef = useRef<((action: BrowserShortcutAction) => void) | null>(null);
  const [webviewNode, setWebviewNode] = useState<BrowserWebviewElement | null>(null);
  const zoomFactorRef = useRef(1);
  const [addressValue, setAddressValue] = useState(target.url === CHAT_SIDE_PANEL_BROWSER_BLANK_URL ? "" : target.url);
  const [currentUrl, setCurrentUrl] = useState(target.url);
  const [webviewSrc, setWebviewSrc] = useState(target.url);
  const [title, setTitle] = useState(target.label);
  const [loading, setLoading] = useState(false);
  const [navigationState, setNavigationState] = useState({ canGoBack: false, canGoForward: false });
  const [loadError, setLoadError] = useState<BrowserLoadError | null>(null);
  const [loadErrorDetailsOpen, setLoadErrorDetailsOpen] = useState(false);
  const [zoomFactor, setZoomFactor] = useState(1);
  const isBlank = currentUrl === CHAT_SIDE_PANEL_BROWSER_BLANK_URL;
  const loadErrorContent = loadError ? chatSidePanelBrowserErrorContent(loadError) : null;
  currentUrlRef.current = currentUrl;
  targetRef.current = target;
  onReplaceTargetRef.current = onReplaceTarget;
  onCloseTargetRef.current = onCloseTarget;
  activeRef.current = active;

  const safeWebviewCall = useCallback(<T,>(callback: (webview: BrowserWebviewElement) => T, fallback: T): T => {
    const webview = webviewRef.current;
    if (!webviewReadyRef.current || !webview || webview.tagName.toLowerCase() !== "webview") return fallback;
    try {
      return callback(webview);
    } catch {
      return fallback;
    }
  }, []);

  const safeCurrentWebviewUrl = useCallback((fallback: string) => (
    safeWebviewCall((webview) => webview.getURL?.() ?? fallback, fallback)
  ), [safeWebviewCall]);

  const updateNavigationState = useCallback(() => {
    setNavigationState({
      canGoBack: safeWebviewCall((webview) => Boolean(webview.canGoBack?.()), false),
      canGoForward: safeWebviewCall((webview) => Boolean(webview.canGoForward?.()), false),
    });
  }, [safeWebviewCall]);

  const applyZoomFactor = useCallback((factor: number) => {
    const applied = safeWebviewCall((webview) => {
      if (!webview.setZoomFactor) return false;
      webview.setZoomFactor(factor);
      return true;
    }, false);
    if (!applied) return;
    zoomFactorRef.current = factor;
    setZoomFactor(factor);
  }, [safeWebviewCall]);

  const stepZoomFactor = useCallback((direction: -1 | 1) => {
    const current = zoomFactorRef.current;
    let currentIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    CHAT_SIDE_PANEL_BROWSER_ZOOM_FACTORS.forEach((factor, index) => {
      const distance = Math.abs(factor - current);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        currentIndex = index;
      }
    });
    const nextIndex = Math.max(
      0,
      Math.min(CHAT_SIDE_PANEL_BROWSER_ZOOM_FACTORS.length - 1, currentIndex + direction),
    );
    applyZoomFactor(CHAT_SIDE_PANEL_BROWSER_ZOOM_FACTORS[nextIndex] ?? 1);
  }, [applyZoomFactor]);

  const executeBrowserShortcut = useCallback((action: BrowserShortcutAction) => {
    if (!active) return;
    switch (action) {
      case "new_tab":
        if (canOpenNewTab) onOpenTarget(createChatSidePanelBrowserTarget());
        return;
      case "focus_location":
        addressInputRef.current?.focus();
        addressInputRef.current?.select();
        return;
      case "reload":
        if (!isBlank) safeWebviewCall((webview) => webview.reload?.(), undefined);
        return;
      case "reload_ignoring_cache":
        if (!isBlank) safeWebviewCall((webview) => webview.reloadIgnoringCache?.(), undefined);
        return;
      case "go_back":
        if (!isBlank) safeWebviewCall((webview) => {
          if (webview.canGoBack?.()) webview.goBack?.();
        }, undefined);
        return;
      case "go_forward":
        if (!isBlank) safeWebviewCall((webview) => {
          if (webview.canGoForward?.()) webview.goForward?.();
        }, undefined);
        return;
      case "zoom_in":
        if (!isBlank) stepZoomFactor(1);
        return;
      case "zoom_out":
        if (!isBlank) stepZoomFactor(-1);
        return;
      case "zoom_reset":
        if (!isBlank) applyZoomFactor(1);
    }
  }, [active, applyZoomFactor, canOpenNewTab, isBlank, onOpenTarget, safeWebviewCall, stepZoomFactor]);
  executeBrowserShortcutRef.current = executeBrowserShortcut;

  useEffect(() => {
    onRegisterShortcutController(targetKey, executeBrowserShortcut);
    return () => onRegisterShortcutController(targetKey, null);
  }, [executeBrowserShortcut, onRegisterShortcutController, targetKey]);

  const replaceBrowserTarget = useCallback((nextUrl: string, nextTitle = chatSidePanelBrowserLabel(nextUrl)) => {
    const nextTarget: Extract<SidePanelTarget, { kind: "browser" }> = {
      ...targetRef.current,
      url: nextUrl,
      label: nextTitle,
    };
    currentUrlRef.current = nextUrl;
    targetRef.current = nextTarget;
    setCurrentUrl(nextUrl);
    setTitle(nextTitle);
    setAddressValue(nextUrl === CHAT_SIDE_PANEL_BROWSER_BLANK_URL ? "" : nextUrl);
    targetUrlRef.current = nextUrl;
    onReplaceTargetRef.current(targetKey, nextTarget);
  }, [targetKey]);

  useEffect(() => {
    const externallyChangedUrl = targetUrlRef.current !== target.url;
    targetUrlRef.current = target.url;
    currentUrlRef.current = target.url;
    targetRef.current = target;
    setCurrentUrl(target.url);
    setTitle(target.label);
    setAddressValue(target.url === CHAT_SIDE_PANEL_BROWSER_BLANK_URL ? "" : target.url);
    if (externallyChangedUrl) {
      setWebviewSrc(target.url);
      setLoadError(null);
      setLoadErrorDetailsOpen(false);
    }
    if (webviewReadyRef.current) updateNavigationState();
    else setNavigationState({ canGoBack: false, canGoForward: false });
  }, [target.label, target.url, updateNavigationState]);

  useEffect(() => {
    const webview = webviewNode;
    if (!webview || webview.tagName.toLowerCase() !== "webview") return undefined;

    const handleStart = () => {
      setLoading(true);
      setLoadError(null);
      setLoadErrorDetailsOpen(false);
    };
    const handleStartNavigation = (event: Event) => {
      const isMainFrame = !("isMainFrame" in event) || event.isMainFrame !== false;
      const nextUrl = "url" in event && typeof event.url === "string" ? event.url : "";
      if (isMainFrame && nextUrl && nextUrl !== currentUrlRef.current) {
        replaceBrowserTarget(nextUrl, chatSidePanelBrowserLabel(nextUrl));
      }
    };
    const handleStop = () => {
      setLoading(false);
      const nextUrl = safeCurrentWebviewUrl("");
      if (nextUrl && nextUrl !== currentUrlRef.current) {
        replaceBrowserTarget(nextUrl, chatSidePanelBrowserLabel(nextUrl));
      }
      updateNavigationState();
    };
    const handleNavigate = (event: Event) => {
      const nextUrl = "url" in event && typeof event.url === "string" ? event.url : safeCurrentWebviewUrl("");
      if (nextUrl) {
        replaceBrowserTarget(nextUrl, chatSidePanelBrowserLabel(nextUrl));
      }
      updateNavigationState();
    };
    const handleTitle = (event: Event) => {
      const nextUrl = safeCurrentWebviewUrl(currentUrlRef.current);
      const nextTitle = "title" in event && typeof event.title === "string" && event.title.trim()
        ? event.title.trim()
        : chatSidePanelBrowserLabel(nextUrl);
      setTitle(nextTitle);
      const nextTarget = { ...targetRef.current, url: nextUrl, label: nextTitle };
      targetRef.current = nextTarget;
      onReplaceTargetRef.current(targetKey, nextTarget);
    };
    const handleFail = (event: Event) => {
      const errorDescription = "errorDescription" in event && typeof event.errorDescription === "string"
        ? event.errorDescription
        : "Could not load this page.";
      const failedUrl = "validatedURL" in event && typeof event.validatedURL === "string" && event.validatedURL
        ? event.validatedURL
        : currentUrlRef.current;
      const isMainFrame = !("isMainFrame" in event) || event.isMainFrame !== false;
      if (isMainFrame && errorDescription !== "ERR_ABORTED") {
        setLoading(false);
        setLoadError({ code: errorDescription, url: failedUrl });
        setLoadErrorDetailsOpen(false);
      }
      updateNavigationState();
    };
    const handleDomReady = () => {
      webviewReadyRef.current = true;
      if (zoomFactorRef.current !== 1) {
        safeWebviewCall((readyWebview) => readyWebview.setZoomFactor?.(zoomFactorRef.current), undefined);
      }
      updateNavigationState();
    };
    const handleBeforeInput = (event: Event) => {
      const inputEvent = event as BrowserWebviewInputEvent;
      if (isChatSidePanelCloseShortcutInput(inputEvent.input)) {
        event.preventDefault();
        onCloseTargetRef.current(targetRef.current);
        return;
      }
      if (readDesktopShell()?.onBrowserShortcut || !inputEvent.input || !activeRef.current) return;
      const action = resolveBrowserShortcutInput(inputEvent.input, {
        isMac: navigator.platform.toLowerCase().includes("mac"),
      });
      if (!action) return;
      event.preventDefault();
      executeBrowserShortcutRef.current?.(action);
    };

    webview.addEventListener("dom-ready", handleDomReady);
    webview.addEventListener("before-input-event", handleBeforeInput);
    webview.addEventListener("did-start-loading", handleStart);
    webview.addEventListener("did-start-navigation", handleStartNavigation);
    webview.addEventListener("did-stop-loading", handleStop);
    webview.addEventListener("did-navigate", handleNavigate);
    webview.addEventListener("did-navigate-in-page", handleNavigate);
    webview.addEventListener("page-title-updated", handleTitle);
    webview.addEventListener("did-fail-load", handleFail);
    updateNavigationState();

    return () => {
      webview.removeEventListener("dom-ready", handleDomReady);
      webview.removeEventListener("before-input-event", handleBeforeInput);
      webview.removeEventListener("did-start-loading", handleStart);
      webview.removeEventListener("did-start-navigation", handleStartNavigation);
      webview.removeEventListener("did-stop-loading", handleStop);
      webview.removeEventListener("did-navigate", handleNavigate);
      webview.removeEventListener("did-navigate-in-page", handleNavigate);
      webview.removeEventListener("page-title-updated", handleTitle);
      webview.removeEventListener("did-fail-load", handleFail);
    };
  }, [replaceBrowserTarget, safeCurrentWebviewUrl, safeWebviewCall, targetKey, updateNavigationState, webviewNode]);

  const handleWebviewRef = useCallback((node: BrowserWebviewElement | null) => {
    webviewRef.current = node;
    webviewReadyRef.current = false;
    setWebviewNode(node);
    if (!node) setNavigationState({ canGoBack: false, canGoForward: false });
  }, []);

  const navigateTo = useCallback((nextValue: string) => {
    const nextUrl = normalizeChatSidePanelBrowserUrl(nextValue);
    setLoadError(null);
    setLoadErrorDetailsOpen(false);
    setWebviewSrc(nextUrl);
    replaceBrowserTarget(nextUrl, chatSidePanelBrowserLabel(nextUrl));
  }, [replaceBrowserTarget]);

  const reloadCurrentPage = useCallback(() => {
    setLoadErrorDetailsOpen(false);
    safeWebviewCall((webview) => {
      webview.reload?.();
    }, undefined);
  }, [safeWebviewCall]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const submittedAddress = formData.get("browser-url");
    navigateTo(typeof submittedAddress === "string" ? submittedAddress : addressValue);
  };

  const openExternal = () => {
    if (isBlank) return;
    const desktopShell = readDesktopShell();
    if (desktopShell) {
      void (desktopShell.forceOpenExternal?.(currentUrl) ?? desktopShell.openExternal(currentUrl));
      return;
    }
    window.open(currentUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <div
      className="flex min-h-full flex-col"
      data-testid={active ? "chat-side-panel-browser-view" : "chat-side-panel-browser-view-hidden"}
      data-browser-tab-id={target.tabId}
      data-active={active ? "true" : "false"}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-[color:var(--border-soft)] bg-[color:var(--surface-panel)] px-2 py-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Back"
          disabled={!navigationState.canGoBack}
          onClick={() => safeWebviewCall((webview) => {
            webview.goBack?.();
          }, undefined)}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Forward"
          disabled={!navigationState.canGoForward}
          onClick={() => safeWebviewCall((webview) => {
            webview.goForward?.();
          }, undefined)}
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Reload"
          disabled={isBlank}
          onClick={reloadCurrentPage}
        >
          <RotateCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
        <form className="min-w-0 flex-1" onSubmit={handleSubmit}>
          <Input
            ref={addressInputRef}
            aria-label="Browser URL"
            name="browser-url"
            value={addressValue}
            onChange={(event) => setAddressValue(event.currentTarget.value)}
            placeholder="Enter a URL"
            className="h-8 rounded-[var(--radius-md)] bg-[color:var(--surface-inset)] font-mono text-xs"
          />
        </form>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Open new browser tab"
          title={canOpenNewTab ? "Open new browser tab" : "Browser tab limit reached"}
          disabled={!canOpenNewTab}
          onClick={() => onOpenTarget(createChatSidePanelBrowserTarget())}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Open browser page externally"
          disabled={isBlank}
          onClick={openExternal}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col bg-[color:var(--surface-inset)]">
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[color:var(--border-soft)] px-3 text-xs text-muted-foreground">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Globe2 className="h-3.5 w-3.5" />}
          <span className="min-w-0 flex-1 truncate">{isBlank ? "New tab" : title}</span>
          {zoomFactor !== 1 ? (
            <span className="shrink-0 tabular-nums" data-testid="chat-side-panel-browser-zoom">
              {Math.round(zoomFactor * 100)}%
            </span>
          ) : null}
        </div>
        {isBlank ? (
          <div className="flex min-h-[44vh] flex-1 items-center justify-center px-6 text-center" data-testid="chat-side-panel-browser-start">
            <div className="max-w-[18rem]">
              <Globe2 className="mx-auto h-12 w-12 text-muted-foreground" />
              <h3 className="mt-4 text-base font-semibold text-foreground">Start browsing</h3>
              <p className="mt-2 text-sm text-muted-foreground">Enter a URL to open a page.</p>
            </div>
          </div>
        ) : (
          <div className="relative flex min-h-[52vh] flex-1">
            {createElement("webview", {
              ref: handleWebviewRef,
              src: webviewSrc,
              className: cn(
                "min-h-[52vh] flex-1 bg-[color:var(--surface-panel)]",
                loadError && "invisible",
              ),
              "data-testid": active ? "chat-side-panel-browser-webview" : "chat-side-panel-browser-webview-hidden",
              "data-browser-tab-id": target.tabId,
              "data-active": active ? "true" : "false",
              // Lets Electron surface requests to the main-process handler, which
              // always denies native windows before routing approved URLs.
              allowpopups: "true",
            })}
            {loadError ? (
              <div
                role="alert"
                data-testid="chat-side-panel-browser-error"
                className="absolute inset-0 flex overflow-y-auto bg-[color:var(--surface-panel)] px-8 py-10"
              >
                <div className="m-auto w-full max-w-[32rem]">
                  <FileWarning className="h-12 w-12 text-muted-foreground" aria-hidden="true" />
                  <h3 className="mt-6 text-xl font-semibold text-foreground">This site can&apos;t be reached</h3>
                  <p className="mt-4 text-sm text-muted-foreground">{loadErrorContent?.summary}</p>
                  <div className="mt-5 text-sm text-muted-foreground">
                    <p>Try:</p>
                    <ul className="mt-2 list-disc space-y-1 pl-6">
                      {loadErrorContent?.suggestions.map((suggestion) => (
                        <li key={suggestion}>{suggestion}</li>
                      ))}
                    </ul>
                  </div>
                  <p className="mt-5 font-mono text-xs text-muted-foreground">{loadError.code}</p>
                  {loadErrorDetailsOpen ? (
                    <p className="mt-4 break-all rounded-[var(--radius-md)] border border-[color:var(--border-soft)] bg-[color:var(--surface-inset)] px-3 py-2 font-mono text-xs text-muted-foreground">
                      {loadError.url}
                    </p>
                  ) : null}
                  <div className="mt-7 flex items-center justify-between gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-expanded={loadErrorDetailsOpen}
                      onClick={() => setLoadErrorDetailsOpen((open) => !open)}
                    >
                      Details
                    </Button>
                    <Button type="button" size="sm" onClick={reloadCurrentPage}>
                      <RotateCw className="h-3.5 w-3.5" />
                      Reload
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

export function ChatSidePanel({
  contextReady = true,
  expanded = false,
  exiting = false,
  onClose,
  onToggleExpanded,
  target,
  selectedOrganizationId,
}: {
  contextReady?: boolean;
  expanded?: boolean;
  exiting?: boolean;
  onClose?: () => void;
  onToggleExpanded?: () => void;
  target?: SidePanelTarget | null;
  selectedOrganizationId: string | null | undefined;
}) {
  const sidePanel = useSidePanel();
  const { pushToast } = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  const [draggedTabKey, setDraggedTabKey] = useState<string | null>(null);
  const [tabDropTarget, setTabDropTarget] = useState<{ key: string; position: "before" | "after" } | null>(null);
  const [closingSideChatKeys, setClosingSideChatKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [movingSideChatKey, setMovingSideChatKey] = useState<string | null>(null);
  const [desktopExitComplete, setDesktopExitComplete] = useState(!sidePanel.open);
  const panelRef = useRef<HTMLElement>(null);
  const browserShortcutControllersRef = useRef(new Map<string, (action: BrowserShortcutAction) => void>());
  const sideChatCloseHandlersRef = useRef(new Map<string, () => Promise<string | null>>());
  const closingSideChatKeysRef = useRef(new Set<string>());
  const movingSideChatKeyRef = useRef<string | null>(null);
  const browserShortcutScopeActiveRef = useRef(false);
  const lastOpenDesktopPanelRef = useRef<ReactElement | null>(null);
  const queryClient = useQueryClient();
  const operatorDisplayName = useOperatorDisplayName();
  const isMobile = useChatSidePanelMobileLayout();
  const { openTarget } = sidePanel;
  const registerBrowserShortcutController = useCallback((
    key: string,
    controller: ((action: BrowserShortcutAction) => void) | null,
  ) => {
    if (controller) browserShortcutControllersRef.current.set(key, controller);
    else browserShortcutControllersRef.current.delete(key);
  }, []);
  const registerSideChatCloseHandler = useCallback((
    clientMutationId: string,
    handler: (() => Promise<string | null>) | null,
  ) => {
    if (handler) sideChatCloseHandlersRef.current.set(clientMutationId, handler);
    else sideChatCloseHandlersRef.current.delete(clientMutationId);
  }, []);

  const visibleTabs = sidePanel.tabs;
  const browserTargets = useMemo(
    () => visibleTabs.filter((candidate): candidate is Extract<SidePanelTarget, { kind: "browser" }> => candidate.kind === "browser"),
    [visibleTabs],
  );
  useLayoutEffect(() => {
    if (isMobile) return undefined;
    if (sidePanel.open) {
      setDesktopExitComplete(false);
      return undefined;
    }

    const host = panelRef.current?.parentElement;
    if (!host || !lastOpenDesktopPanelRef.current) {
      setDesktopExitComplete(true);
      return undefined;
    }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || host.getBoundingClientRect().width <= 0.5) {
      setDesktopExitComplete(true);
      return undefined;
    }

    const handleTransitionEnd = (event: TransitionEvent) => {
      if (event.target !== host || event.propertyName !== "width") return;
      setDesktopExitComplete(true);
    };
    host.addEventListener("transitionend", handleTransitionEnd);
    return () => host.removeEventListener("transitionend", handleTransitionEnd);
  }, [isMobile, sidePanel.open]);
  const desktopBrowserAvailable = Boolean(readDesktopShell()?.getBrowserPartition);
  const browserAvailable = desktopBrowserAvailable;
  useEffect(() => {
    if (!contextReady || !target || (target.kind === "browser" && !browserAvailable)) return;
    openTarget(target);
  }, [browserAvailable, contextReady, openTarget, target]);

  useEffect(() => {
    if (desktopBrowserAvailable) return;
    for (const browserTarget of browserTargets) {
      sidePanel.closeTarget(sidePanelTargetKey(browserTarget));
    }
  }, [browserTargets, desktopBrowserAvailable, sidePanel]);
  const activeTarget = useMemo(() => {
    if (!contextReady) return null;
    if (visibleTabs.length === 0) return null;
    if (sidePanel.activeKey === null) return null;
    if (sidePanel.activeKey) {
      const matchingTab = visibleTabs.find((candidate) => sidePanelTargetKey(candidate) === sidePanel.activeKey);
      if (matchingTab) return matchingTab;
    }
    return visibleTabs.at(-1) ?? null;
  }, [contextReady, sidePanel.activeKey, visibleTabs]);

  const issueTarget = activeTarget?.kind === "issue" ? activeTarget : null;
  const chatTarget = activeTarget?.kind === "chat" ? activeTarget : null;
  const sideChatTarget = activeTarget?.kind === "side_chat" ? activeTarget : null;
  const automationTarget = activeTarget?.kind === "automation" ? activeTarget : null;
  const libraryFileTarget = activeTarget?.kind === "library_file" ? activeTarget : null;
  const localFileTarget = activeTarget?.kind === "local_file" ? activeTarget : null;
  const libraryDirectoryTarget = activeTarget?.kind === "library_directory" ? activeTarget : null;
  const libraryEntryTarget = activeTarget?.kind === "library_entry" ? activeTarget : null;
  const browserTarget = activeTarget?.kind === "browser" ? activeTarget : null;
  const activeBrowserTargetKey = browserTarget ? sidePanelTargetKey(browserTarget) : null;
  const placeholderTarget = activeTarget?.kind === "placeholder" ? activeTarget : null;
  const targetQueriesEnabled = sidePanel.open || exiting;
  const sourceConversationId = sidePanel.contextKey.startsWith("chat:")
    ? sidePanel.contextKey.slice("chat:".length) || null
    : null;

  useEffect(() => {
    const desktopShell = readDesktopShell();
    const setBrowserSurfaceShortcutActive = desktopShell?.setBrowserSurfaceShortcutActive;
    if (!setBrowserSurfaceShortcutActive) return undefined;
    let disposed = false;
    const syncScope = () => {
      if (disposed) return;
      const activeElement = document.activeElement;
      const nextActive = Boolean(
        sidePanel.open
        && activeBrowserTargetKey
        && activeElement
        && panelRef.current?.contains(activeElement),
      );
      if (browserShortcutScopeActiveRef.current === nextActive) return;
      browserShortcutScopeActiveRef.current = nextActive;
      void setBrowserSurfaceShortcutActive(nextActive).catch(() => undefined);
    };
    const queueScopeSync = () => queueMicrotask(syncScope);
    document.addEventListener("focusin", queueScopeSync, true);
    document.addEventListener("focusout", queueScopeSync, true);
    syncScope();
    return () => {
      disposed = true;
      document.removeEventListener("focusin", queueScopeSync, true);
      document.removeEventListener("focusout", queueScopeSync, true);
      if (!browserShortcutScopeActiveRef.current) return;
      browserShortcutScopeActiveRef.current = false;
      void setBrowserSurfaceShortcutActive(false).catch(() => undefined);
    };
  }, [activeBrowserTargetKey, sidePanel.open]);

  useEffect(() => {
    const desktopShell = readDesktopShell();
    if (!desktopShell?.onBrowserShortcut) return undefined;
    return desktopShell.onBrowserShortcut((action) => {
      const activeElement = document.activeElement;
      if (
        !sidePanel.open
        || !activeBrowserTargetKey
        || !activeElement
        || !panelRef.current?.contains(activeElement)
      ) return;
      browserShortcutControllersRef.current.get(activeBrowserTargetKey)?.(action);
    });
  }, [activeBrowserTargetKey, sidePanel.open]);

  const handleSidePanelKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (readDesktopShell()?.onBrowserShortcut || !activeBrowserTargetKey) return;
    const action = resolveBrowserShortcutInput({
      type: event.type,
      key: event.key,
      code: event.code,
      meta: event.metaKey,
      control: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
    }, {
      isMac: navigator.platform.toLowerCase().includes("mac"),
    });
    if (!action) return;
    event.preventDefault();
    browserShortcutControllersRef.current.get(activeBrowserTargetKey)?.(action);
  }, [activeBrowserTargetKey]);

  const libraryFilePreviewPath = libraryFileTarget?.filePath ?? libraryEntryTarget?.path ?? null;
  const issueQuery = useQuery({
    queryKey: queryKeys.issues.detail(issueTarget?.issueId ?? "__none__"),
    queryFn: () => issuesApi.get(issueTarget!.issueId),
    enabled: targetQueriesEnabled && !!issueTarget,
  });
  const issueCommentsQuery = useQuery({
    queryKey: queryKeys.issues.comments(issueTarget?.issueId ?? "__none__"),
    queryFn: () => issuesApi.listComments(issueTarget!.issueId),
    enabled: targetQueriesEnabled && !!issueTarget,
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedOrganizationId ?? "__none__"),
    queryFn: () => agentsApi.list(selectedOrganizationId!),
    enabled: targetQueriesEnabled && !!selectedOrganizationId && !!issueTarget,
  });
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: targetQueriesEnabled && !!issueTarget,
  });
  const updateIssueMutation = useMutation({
    mutationFn: ({ issueId, data }: { issueId: string; data: Record<string, unknown> }) =>
      issuesApi.update(issueId, data),
    onSuccess: (updatedIssue) => {
      queryClient.setQueryData(queryKeys.issues.detail(updatedIssue.id), updatedIssue);
      void queryClient.invalidateQueries({ queryKey: ["issues"] });
      void queryClient.invalidateQueries({ queryKey: ["messenger"] });
    },
  });
  const addIssueCommentMutation = useMutation({
    mutationFn: ({ issueId, body, reopen }: { issueId: string; body: string; reopen?: boolean }) =>
      issuesApi.addComment(issueId, body, reopen),
    onSuccess: (comment, variables) => {
      queryClient.setQueryData(queryKeys.issues.comment(variables.issueId, comment.id), comment);
      queryClient.setQueryData(queryKeys.issues.comments(variables.issueId), (current: IssueComment[] | undefined) =>
        current ? [...current, comment] : [comment],
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(variables.issueId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(variables.issueId) });
      void queryClient.invalidateQueries({ queryKey: ["messenger"] });
    },
  });
  const chatQuery = useQuery({
    queryKey: queryKeys.chats.detail(selectedOrganizationId ?? "__none__", chatTarget?.conversationId ?? "__none__"),
    queryFn: () => chatsApi.get(chatTarget!.conversationId),
    enabled: targetQueriesEnabled && !!selectedOrganizationId && !!chatTarget,
  });
  const chatMessagesQuery = useQuery({
    queryKey: queryKeys.chats.messages(selectedOrganizationId ?? "__none__", chatTarget?.conversationId ?? "__none__"),
    queryFn: () => chatsApi.listMessages(chatTarget!.conversationId),
    enabled: targetQueriesEnabled && !!selectedOrganizationId && !!chatTarget,
  });
  const libraryFileQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceFile(selectedOrganizationId ?? "__none__", libraryFilePreviewPath ?? ""),
    queryFn: () => organizationsApi.readWorkspaceFile(selectedOrganizationId!, libraryFilePreviewPath!),
    enabled: targetQueriesEnabled && !!selectedOrganizationId && !!libraryFilePreviewPath,
  });
  const libraryDirectoryQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceFiles(selectedOrganizationId ?? "__none__", libraryDirectoryTarget?.directoryPath ?? ""),
    queryFn: () => organizationsApi.listWorkspaceFiles(selectedOrganizationId!, libraryDirectoryTarget!.directoryPath),
    enabled: targetQueriesEnabled && !!selectedOrganizationId && !!libraryDirectoryTarget,
  });

  const loading = Boolean(
    (issueTarget && issueQuery.isPending)
      || (chatTarget && (chatQuery.isPending || chatMessagesQuery.isPending))
      || (libraryFilePreviewPath && libraryFileQuery.isPending)
      || (libraryDirectoryTarget && libraryDirectoryQuery.isPending),
  );
  const error = issueQuery.error ?? issueCommentsQuery.error ?? agentsQuery.error ?? sessionQuery.error ?? chatQuery.error ?? chatMessagesQuery.error ?? libraryFileQuery.error ?? libraryDirectoryQuery.error;
  const issue = issueTarget ? issueQuery.data : null;
  const issueComments = issueTarget ? (issueCommentsQuery.data ?? []) : [];
  const currentUserId = sessionQuery.data?.user?.id ?? sessionQuery.data?.session?.userId ?? null;
  const agentMap = new Map((agentsQuery.data ?? []).map((agent) => [agent.id, agent]));
  const chat = chatTarget ? chatQuery.data : null;
  const chatMessages = chatTarget ? (chatMessagesQuery.data ?? []) : [];
  const libraryFile = libraryFilePreviewPath ? libraryFileQuery.data : null;
  const libraryDirectory = libraryDirectoryTarget ? libraryDirectoryQuery.data : null;
  const activeTargetKey = activeTarget ? sidePanelTargetKey(activeTarget) : "empty";

  const openSidePanelTarget = (nextTarget: SidePanelTarget) => {
    if (nextTarget.kind === "browser" && !browserAvailable) return;
    sidePanel.openTarget(nextTarget);
  };
  const replaceSidePanelTarget = (key: string, nextTarget: SidePanelTarget) => sidePanel.replaceTarget(key, nextTarget);

  const closeSidePanelTab = async (tab: SidePanelTarget) => {
    const tabKey = sidePanelTargetKey(tab);
    if (tab.kind !== "side_chat") {
      sidePanel.closeTarget(tabKey);
      return;
    }
    if (movingSideChatKeyRef.current === tabKey) return;
    if (closingSideChatKeysRef.current.has(tabKey)) return;
    closingSideChatKeysRef.current.add(tabKey);
    setClosingSideChatKeys(new Set(closingSideChatKeysRef.current));
    try {
      const registeredClose = sideChatCloseHandlersRef.current.get(tab.clientMutationId);
      const destroyedConversationId = registeredClose
        ? await registeredClose()
        : tab.conversationId
          ? await chatsApi.destroySideChat(tab.conversationId).then(() => tab.conversationId)
          : null;
      if (destroyedConversationId) {
        queryClient.removeQueries({ queryKey: queryKeys.chats.detail(selectedOrganizationId ?? "__none__", destroyedConversationId) });
        queryClient.removeQueries({ queryKey: queryKeys.chats.messages(selectedOrganizationId ?? "__none__", destroyedConversationId) });
      }
      sidePanel.closeTarget(tabKey);
      if (destroyedConversationId && destroyedConversationId !== tab.conversationId) {
        sidePanel.closeTarget(sidePanelTargetKey({ ...tab, conversationId: destroyedConversationId }));
      }
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
        if (tab.conversationId) {
          const detailQueryKey = queryKeys.chats.detail(
            selectedOrganizationId ?? "__none__",
            tab.conversationId,
          );
          if (error.status === 404) {
            queryClient.removeQueries({ queryKey: detailQueryKey });
            queryClient.removeQueries({
              queryKey: queryKeys.chats.messages(
                selectedOrganizationId ?? "__none__",
                tab.conversationId,
              ),
            });
          } else {
            void queryClient.invalidateQueries({ queryKey: detailQueryKey });
            void queryClient.invalidateQueries({
              queryKey: ["messenger", selectedOrganizationId],
            });
          }
        }
        sidePanel.closeTarget(tabKey);
        return;
      }
      pushToast({
        title: "Could not close Side Chat",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      });
    } finally {
      closingSideChatKeysRef.current.delete(tabKey);
      setClosingSideChatKeys(new Set(closingSideChatKeysRef.current));
    }
  };

  useEffect(() => sidePanel.registerCloseRequestHandler(closeSidePanelTab), [closeSidePanelTab, sidePanel]);

  const moveSideChatMutation = useMutation({
    mutationFn: (tab: SideChatTarget) => chatsApi.keepSideChat(tab.conversationId!),
    onSuccess: (updated, tab) => {
      queryClient.setQueryData(
        queryKeys.chats.detail(selectedOrganizationId ?? "__none__", updated.id),
        updated,
      );
      void queryClient.invalidateQueries({ queryKey: ["messenger", selectedOrganizationId] });
      sidePanel.closeTarget(sidePanelTargetKey(tab));
      pushToast({
        title: "Moved to Messenger",
        body: "This is now a normal Messenger chat.",
        tone: "success",
      });
      const prefix = extractOrganizationPrefixFromPath(location.pathname);
      navigate(applyOrganizationPrefix(`/messenger/chat/${updated.id}`, prefix));
    },
    onError: (error, tab) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.chats.detail(
          selectedOrganizationId ?? "__none__",
          tab.conversationId ?? "__side-chat-draft__",
        ),
      });
      pushToast({
        title: "Could not move Side Chat",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      });
    },
  });
  const moveSideChatToMessenger = (tab: SideChatTarget) => {
    const tabKey = sidePanelTargetKey(tab);
    if (movingSideChatKeyRef.current || closingSideChatKeysRef.current.has(tabKey)) return;
    movingSideChatKeyRef.current = tabKey;
    setMovingSideChatKey(tabKey);
    void moveSideChatMutation.mutateAsync(tab)
      .catch(() => undefined)
      .finally(() => {
        if (movingSideChatKeyRef.current !== tabKey) return;
        movingSideChatKeyRef.current = null;
        setMovingSideChatKey(null);
      });
  };

  const libraryDirectoryEntries = libraryDirectory?.entries ?? [];
  const libraryDirectoryFileCount = libraryDirectoryEntries.filter((entry) => !entry.isDirectory).length;
  const libraryDirectoryFolderCount = libraryDirectoryEntries.length - libraryDirectoryFileCount;
  const panel = (
    <aside
      ref={panelRef}
      onKeyDownCapture={handleSidePanelKeyDown}
      data-testid="chat-side-panel"
      className={cn(
        "flex min-h-0 shrink-0 flex-col gap-1.5 bg-transparent",
        isMobile
          ? "motion-chat-side-panel motion-panel-reveal fixed inset-x-3 bottom-3 top-[4.75rem] z-[60] w-auto"
          : "h-full w-full",
        isMobile && exiting && "translate-x-4 scale-[0.985] opacity-0",
        !contextReady && "hidden",
        isMobile && !sidePanel.open && !exiting && "hidden",
      )}
      aria-label="Side Panel"
      aria-hidden={!contextReady || undefined}
    >
      <div className={cn(
        "workspace-main-card relative z-10 flex shrink-0 flex-col overflow-visible rounded-[var(--desktop-workspace-radius)]",
        isMobile && "!bg-[color:var(--surface-page)] shadow-[0_24px_90px_-36px_rgb(0_0_0/0.75)]",
      )}>
        <div
          role="tablist"
          aria-label="Side Panel targets"
          data-testid="chat-side-panel-tabs"
          className="scrollbar-auto-hide flex shrink-0 items-center gap-1 overflow-x-auto px-2 py-1.5"
        >
          <div className="scrollbar-auto-hide flex min-w-0 flex-1 gap-1 overflow-x-auto">
            {visibleTabs.map((tab) => {
              const tabKey = sidePanelTargetKey(tab);
              const selected = tabKey === activeTargetKey;
              const dragging = draggedTabKey === tabKey;
              const sideChatClosing = closingSideChatKeys.has(tabKey);
              const closeDisabled = tab.kind === "side_chat"
                && (movingSideChatKey === tabKey || sideChatClosing);
              return (
                <ChatSidePanelTabContextMenu
                  key={tabKey}
                  closeDisabled={closeDisabled}
                  isMobile={isMobile}
                  moveInProgress={movingSideChatKey !== null || sideChatClosing}
                  organizationId={selectedOrganizationId}
                  tab={tab}
                  onClose={(target) => void closeSidePanelTab(target)}
                  onMoveSideChat={moveSideChatToMessenger}
                >
                  <div
                    role="presentation"
                    data-side-panel-tab-key={tabKey}
                    data-dragging={dragging ? "true" : undefined}
                    data-drop-position={tabDropTarget?.key === tabKey ? tabDropTarget.position : undefined}
                    onDragStart={(event) => {
                      setDraggedTabKey(tabKey);
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData(CHAT_SIDE_PANEL_TAB_DND_MIME, tabKey);
                    }}
                    onDragOver={(event) => {
                      const sourceKey = draggedTabKey ?? event.dataTransfer.getData(CHAT_SIDE_PANEL_TAB_DND_MIME);
                      if (!sourceKey || sourceKey === tabKey) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      const bounds = event.currentTarget.getBoundingClientRect();
                      const position = event.clientX < bounds.left + bounds.width / 2 ? "before" : "after";
                      setTabDropTarget({ key: tabKey, position });
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      const sourceKey = draggedTabKey ?? event.dataTransfer.getData(CHAT_SIDE_PANEL_TAB_DND_MIME);
                      if (sourceKey && sourceKey !== tabKey) {
                        const bounds = event.currentTarget.getBoundingClientRect();
                        const position = event.clientX < bounds.left + bounds.width / 2 ? "before" : "after";
                        sidePanel.reorderTarget(sourceKey, tabKey, position);
                      }
                      setDraggedTabKey(null);
                      setTabDropTarget(null);
                    }}
                    onDragEnd={() => {
                      setDraggedTabKey(null);
                      setTabDropTarget(null);
                    }}
                    className={cn(
                      "group relative flex h-7 max-w-[12.5rem] shrink-0 items-center rounded-full border pr-1 transition-[color,background-color,border-color,box-shadow,opacity]",
                      tab.kind === "browser" && "w-[12.5rem]",
                      selected
                        ? "border-[color:var(--border-strong)] bg-[color:var(--surface-active)] text-foreground"
                        : "border-transparent text-muted-foreground hover:bg-[color:var(--surface-active)] hover:text-foreground",
                      dragging && "opacity-50",
                      tabDropTarget?.key === tabKey && tabDropTarget.position === "before" && "shadow-[-3px_0_0_0_var(--accent)]",
                      tabDropTarget?.key === tabKey && tabDropTarget.position === "after" && "shadow-[3px_0_0_0_var(--accent)]",
                    )}
                  >
                    <button
                      type="button"
                      role="tab"
                      draggable={!isMobile && visibleTabs.length > 1}
                      aria-selected={selected}
                      data-testid="chat-side-panel-tab"
                      className="min-w-0 flex-1 cursor-grab truncate rounded-l-full px-2.5 py-1 text-left text-xs active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                      onClick={() => sidePanel.setActiveKey(tabKey)}
                    >
                      {tab.label}
                    </button>
                    <button
                      type="button"
                      draggable={false}
                      data-testid="chat-side-panel-tab-close"
                      aria-label={`Close ${tab.label} tab`}
                      disabled={closeDisabled}
                      className="pointer-events-none inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-[color,background-color,opacity] group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 hover:bg-[color:var(--surface-panel)] hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-40"
                      onClick={(event) => {
                        event.stopPropagation();
                        if (closeDisabled) return;
                        void closeSidePanelTab(tab);
                      }}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                </ChatSidePanelTabContextMenu>
              );
            })}
            <button
              type="button"
              data-testid="chat-side-panel-add-tab"
              aria-label="Add Side Panel tab"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              onClick={sidePanel.openEmpty}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {onToggleExpanded ? (
              <button
                type="button"
                data-testid="chat-side-panel-expand-toggle"
                aria-label={expanded ? "Restore Side Panel width" : "Expand Side Panel"}
                title={expanded ? "Restore Side Panel width" : "Expand Side Panel"}
                className="inline-flex h-7 w-7 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] text-muted-foreground transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                onClick={onToggleExpanded}
              >
                {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
              </button>
            ) : null}
            <button
              type="button"
              data-testid="chat-side-panel-collapse"
              aria-label="Close Side Panel"
              title="Close Side Panel"
              className="inline-flex h-7 w-7 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] text-muted-foreground transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              onClick={onClose ?? sidePanel.hidePanel}
            >
              <PanelRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
      <div className={cn(
        "workspace-main-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--desktop-workspace-radius)]",
        isMobile && "!bg-[color:var(--surface-page)]",
      )}>
        <div className={cn(
          "scrollbar-auto-hide min-h-0 flex-1",
          browserTarget || issueTarget || automationTarget || libraryFilePreviewPath || sideChatTarget ? "overflow-hidden" : "overflow-y-auto px-4 py-4",
          issueTarget && !browserTarget && "px-4 py-4",
        )} data-testid="chat-side-panel-scroll-body">
          {browserTargets.map((target) => {
            const targetKey = sidePanelTargetKey(target);
            const active = targetKey === activeTargetKey;
            return (
              <div key={targetKey} className={cn("h-full min-h-0", active ? "block" : "hidden")} aria-hidden={!active}>
                <ChatSidePanelBrowserView
                  active={active}
                  canOpenNewTab={browserTargets.length < MAX_BROWSER_TABS_PER_CONTEXT}
                  target={target}
                  targetKey={targetKey}
                  onOpenTarget={openSidePanelTarget}
                  onReplaceTarget={replaceSidePanelTarget}
                  onCloseTarget={closeSidePanelTab}
                  onRegisterShortcutController={registerBrowserShortcutController}
                />
              </div>
            );
          })}
          {browserTarget ? null : !activeTarget ? (
            <SidePanelEmptyState
              browserAvailable={browserAvailable}
              sourceConversationId={sourceConversationId}
              onOpenTarget={openSidePanelTarget}
            />
          ) : loading ? (
            <div className={cn(libraryFilePreviewPath && "px-4 py-4")}>
              <LoadingPanelBody />
            </div>
          ) : error ? (
            <div className={cn(libraryFilePreviewPath && "px-4 py-4")}>
              <div role="alert" className="rounded-[var(--radius-lg)] border border-destructive/30 bg-destructive/10 px-3 py-3 text-sm text-destructive">
                {error instanceof Error ? error.message : "Could not load this Side Panel target."}
              </div>
            </div>
          ) : issueTarget && issue ? (
            expanded ? (
              <IssueDetail embedded embeddedIssueId={issue.id} />
            ) : (
              <ChatIssueSidePanelView
                issue={issue}
                comments={issueComments}
                commentId={issueTarget.commentId}
                updating={updateIssueMutation.isPending}
                addingComment={addIssueCommentMutation.isPending}
                currentUserId={currentUserId}
                agentMap={agentMap}
                operatorDisplayName={operatorDisplayName}
                expanded={expanded}
                onUpdate={(data) => updateIssueMutation.mutateAsync({ issueId: issue.id, data })}
                onAddComment={async (body, reopen) => {
                  await addIssueCommentMutation.mutateAsync({
                    issueId: issue.id,
                    body,
                    ...(reopen === undefined ? {} : { reopen }),
                  });
                }}
              />
            )
          ) : automationTarget ? (
            <div className="h-full min-h-0" data-testid="chat-side-panel-automation-view">
              <AutomationDetail
                key={automationTarget.automationId}
                automationId={automationTarget.automationId}
                embedded
                onClose={() => closeSidePanelTab(automationTarget)}
              />
            </div>
          ) : placeholderTarget ? (
            <SidePanelPlaceholderView browserAvailable={browserAvailable} target={placeholderTarget} onOpenTarget={openSidePanelTarget} />
          ) : sideChatTarget && selectedOrganizationId ? (
            <SideChatPanelView
              organizationId={selectedOrganizationId}
              target={sideChatTarget}
              onRegisterCloseHandler={registerSideChatCloseHandler}
              onReplaceTarget={replaceSidePanelTarget}
            />
          ) : chatTarget ? (
            <div className="space-y-4" data-testid="chat-side-panel-chat-view">
              <div className="rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] px-3 py-3">
                <h3 className="text-base font-semibold text-foreground">{chat ? conversationDisplayTitle(chat) : activeTarget.label}</h3>
                {chat?.summary ? <p className="mt-2 text-sm leading-6 text-muted-foreground">{chat.summary}</p> : null}
                <p className="mt-2 text-xs text-muted-foreground">{chatMessages.length} message{chatMessages.length === 1 ? "" : "s"}</p>
              </div>
              <div className="space-y-2">
                {chatMessages.slice(-3).map((message) => (
                  <div key={message.id} className={cn("rounded-[var(--radius-md)] border border-[color:var(--border-soft)] px-3 py-2 text-sm", message.id === chatTarget.messageId && "border-[color:var(--accent-base)] bg-[color:color-mix(in_oklab,var(--accent-base)_10%,transparent)]")}>
                    <div className="mb-1 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{message.role}</div>
                    <p className="line-clamp-4 whitespace-pre-wrap text-muted-foreground">{message.body || message.kind}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : libraryFilePreviewPath && libraryFile && selectedOrganizationId ? (
            <ChatSidePanelLibraryFileView
              key={libraryFile.filePath}
              libraryFile={libraryFile}
              organizationId={selectedOrganizationId}
            />
          ) : localFileTarget ? (
            <TranscriptLocalFilePreview
              key={localFileTarget.filePath}
              targetPath={localFileTarget.filePath}
              label={localFileTarget.label}
            />
          ) : libraryDirectoryTarget ? (
            <div className="flex min-h-full flex-col" data-testid="chat-side-panel-library-directory-view">
              {libraryDirectory ? (
                <div className="shrink-0 px-2 pb-3 text-sm">
                  <div className="truncate font-medium text-foreground">{libraryDirectory.directoryPath || "Library root"}</div>
                  <div className="mt-1 text-xs text-muted-foreground" data-testid="chat-side-panel-library-file-count">
                    {libraryDirectoryFileCount} file{libraryDirectoryFileCount === 1 ? "" : "s"} · {libraryDirectoryFolderCount} folder{libraryDirectoryFolderCount === 1 ? "" : "s"}
                  </div>
                </div>
              ) : null}
              <div className="-mx-2 min-h-0 flex-1 border-t border-border px-2 py-2">
                <ChatSidePanelLibraryTree
                  entries={libraryDirectoryEntries}
                  selectedOrganizationId={selectedOrganizationId}
                  onOpenTarget={openSidePanelTarget}
                  selectedPath={libraryDirectoryTarget.directoryPath}
                />
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Open this target in the full page for details.</p>
          )}
        </div>
      </div>
    </aside>
  );

  if (isMobile) {
    if (!sidePanel.open && !exiting) return null;
    return typeof document !== "undefined" ? createPortal(panel, document.body) : panel;
  }
  if (sidePanel.open) {
    lastOpenDesktopPanelRef.current = panel;
    return panel;
  }
  if (!desktopExitComplete || browserTargets.length > 0) return lastOpenDesktopPanelRef.current;
  return null;
}
