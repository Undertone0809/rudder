import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { chatsApi } from "@/api/chats";
import { ApiError } from "@/api/client";
import { issuesApi } from "@/api/issues";
import { organizationSkillsApi } from "@/api/organizationSkills";
import { organizationsApi } from "@/api/orgs";
import { AgentIcon } from "@/components/AgentIconPicker";
import {
  FileAnnotationSelectionToolbar,
  type FileTextSelection,
} from "@/components/chat/FileAnnotationSelectionToolbar";
import { CommentThread } from "@/components/CommentThread";
import { isAgentWakeEligible } from "@/components/CommentThread.submit";
import { InlineEditor } from "@/components/InlineEditor";
import { IssueProperties } from "@/components/IssueProperties";
import { LocalAppIdentityIcon } from "@/components/LocalAppIdentityIcon";
import { MarkdownBody } from "@/components/MarkdownBody";
import { MarkdownEditor, type MarkdownEditorRef } from "@/components/MarkdownEditor";
import { KeepSidePanelViewButton } from "@/components/messenger/KeepSidePanelViewButton";
import { PriorityIcon } from "@/components/PriorityIcon";
import { GoalChatPanel } from "@/components/side-panel/GoalChatPanel";
import { LocalAppPanelView } from "@/components/side-panel/LocalAppPanelView";
import { LocalAppsPanel } from "@/components/side-panel/LocalAppsPanel";
import { RunFeedbackChatPanel } from "@/components/side-panel/RunFeedbackChatPanel";
import { SideChatPanelView } from "@/components/side-panel/SideChatPanelView";
import { SubagentPanelView } from "@/components/side-panel/SubagentPanelView";
import { SubagentsPanelView } from "@/components/side-panel/SubagentsPanelView";
import { TerminalPanelView } from "@/components/side-panel/TerminalPanelView";
import { StatusBadge } from "@/components/StatusBadge";
import { StatusIcon } from "@/components/StatusIcon";
import { TranscriptLocalFilePreview } from "@/components/transcript/TranscriptLocalFilePreview";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { BrowserLiveSurface } from "@/components/workbench/BrowserLiveSurface";
import { WorkspaceCodeEditor } from "@/components/WorkspaceCodeEditor";
import {
  isWorkspaceCsvPreviewFile,
  isWorkspaceHtmlPreviewFile,
  isWorkspaceMarkdownPreviewFile,
  WorkspaceFilePreview,
  type WorkspaceFilePreviewMode,
} from "@/components/WorkspaceFilePreview";
import { WorkspaceHtmlPreviewToolbar } from "@/components/WorkspaceHtmlPreview";
import { WorkspaceLaunchTargetIcon } from "@/components/workspaces/WorkspaceLaunchControls";
import { useI18n } from "@/context/I18nContext";
import {
  createLiveSurfaceRuntimeId,
  LiveSurfaceAnchor,
  useOptionalLiveSurfaceRuntime,
  type LiveSurfaceTarget,
} from "@/context/LiveSurfaceRuntimeContext";
import { useOrganization } from "@/context/OrganizationContext";
import { useOptionalSavedViewPromotion } from "@/context/SavedViewPromotionContext";
import { MAX_BROWSER_TABS_PER_CONTEXT, useSidePanel } from "@/context/SidePanelContext";
import { useToast } from "@/context/ToastContext";
import { useBrowserSavedViewMetadataPersister } from "@/hooks/useBrowserSavedViewMetadataPersister";
import { useCurrentUserAvatar } from "@/hooks/useCurrentUserAvatar";
import { useOperatorDisplayName } from "@/hooks/useOperatorDisplayName";
import { createBrowserSidePanelTarget as createChatSidePanelBrowserTarget } from "@/lib/browser-side-panel";
import { requestChatFileAnnotationLocation } from "@/lib/chat-file-annotation-events";
import { createChatResponseAnnotationNavigationState } from "@/lib/chat-response-annotation-navigation";
import { hashChatAnnotationSource } from "@/lib/chat-response-annotation-selection";
import { readDesktopShell, type DesktopFileLaunchTargetId, type DesktopWorkspaceLaunchTarget } from "@/lib/desktop-shell";
import { IssueProposalSidePanelContent } from "@/lib/issue-proposal-side-panel-registry";
import { MAIN_WORKBENCH_BROWSER_CAPACITY } from "@/lib/main-workbench-state";
import { applyOrganizationPrefix, extractOrganizationPrefixFromPath, getOrganizationRouteKey } from "@/lib/organization-routes";
import { queryKeys } from "@/lib/queryKeys";
import { useLocation, useNavigate } from "@/lib/router";
import {
  buildSettingsOverlayState,
  rememberSettingsOverlayBackgroundPath,
} from "@/lib/settings-overlay-state";
import {
  sideChatGenerationScopeKey,
  sidePanelTargetKey,
  sidePanelTargetSupportsSavedView,
  type SidePanelTarget,
} from "@/lib/side-panel-targets";
import { cn } from "@/lib/utils";
import { isWorkspaceHtmlFilePath } from "@/lib/workspace-html-preview";
import {
  MAX_BROWSER_FAVICON_LENGTH,
  resolveBrowserShortcutInput,
  resolveKnownWebsiteIcon,
  type Agent,
  type BrowserShortcutAction,
  type ChatInlineAnnotation,
  type Issue,
  type IssueComment,
  type OrganizationSkillFileDetail,
  type OrganizationWorkspaceFileDetail,
  type OrganizationWorkspaceFileEntry,
} from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AppWindow,
  Bot,
  Box,
  Boxes,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  CirclePlus,
  Code2,
  Compass,
  ExternalLink,
  Eye,
  FileAudio2,
  FileCode2,
  FileText,
  FileVideo2,
  Folder,
  Globe2,
  Image as ImageIcon,
  LibraryBig,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  Minimize2,
  PackageOpen,
  PanelRight,
  Plus,
  Redo2,
  Table2,
  TerminalSquare,
  Undo2,
  UserRound,
  Workflow,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AutomationDetail } from "./AutomationDetail";
import { conversationDisplayTitle } from "./Chat.parts";
import { ChatSidePanelTabContextMenu, type SideChatTarget } from "./Chat.side-panel-tab-menu";
import {
  clearChatSidePanelMarkdownDraft,
  countChatSidePanelMarkdownWords,
  joinChatSidePanelYamlFrontmatter,
  restoreChatSidePanelMarkdownDraft,
  splitChatSidePanelYamlFrontmatter,
  storeChatSidePanelMarkdownDraft,
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

function acceptedChatSidePanelBrowserFavicon(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_BROWSER_FAVICON_LENGTH) return null;
  if (/^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}

function ChatSidePanelBrowserTabIcon({ favicon, url }: { favicon?: string; url: string }) {
  const acceptedFavicon = acceptedChatSidePanelBrowserFavicon(favicon);
  const darkMode = resolveKnownWebsiteIcon(url)?.darkMode;
  const [faviconFailed, setFaviconFailed] = useState(false);

  useEffect(() => {
    setFaviconFailed(false);
  }, [acceptedFavicon]);

  if (acceptedFavicon && !faviconFailed) {
    return (
      <img
        alt=""
        className={cn(
          "size-3.5 shrink-0 rounded-[3px] object-contain",
          darkMode === "invert" && "dark:invert",
        )}
        data-dark-mode={darkMode}
        data-testid="chat-side-panel-tab-browser-favicon"
        referrerPolicy="no-referrer"
        src={acceptedFavicon}
        onError={() => setFaviconFailed(true)}
      />
    );
  }

  return (
    <Globe2
      aria-hidden
      className="size-3.5 shrink-0"
      data-testid="chat-side-panel-tab-browser-fallback-icon"
    />
  );
}

function ChatSidePanelIssueTabIcon({
  enabled,
  issueId,
}: {
  enabled: boolean;
  issueId: string;
}) {
  const issueQuery = useQuery({
    queryKey: queryKeys.issues.detail(issueId),
    queryFn: () => issuesApi.get(issueId),
    enabled,
  });

  if (issueQuery.isPending) {
    return (
      <LoaderCircle
        aria-hidden
        className="size-3.5 shrink-0 animate-spin text-muted-foreground"
        data-testid="chat-side-panel-tab-issue-loading-icon"
      />
    );
  }
  if (issueQuery.isError || !issueQuery.data) {
    return (
      <CircleAlert
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground"
        data-testid="chat-side-panel-tab-issue-fallback-icon"
      />
    );
  }

  return (
    <StatusIcon
      className="size-3.5"
      dataSlot="side-panel-tab-issue-status-icon"
      status={issueQuery.data.status}
    />
  );
}

function ChatSidePanelTabIcon({
  enabled,
  tab,
}: {
  enabled: boolean;
  tab: SidePanelTarget;
}) {
  const iconClassName = "size-3.5 shrink-0";

  if (tab.kind === "issue") {
    return <ChatSidePanelIssueTabIcon enabled={enabled} issueId={tab.issueId} />;
  }
  if (tab.kind === "issue_proposal") return <CirclePlus aria-hidden className={iconClassName} />;
  if (tab.kind === "automation") return <Workflow aria-hidden className={iconClassName} />;
  if (tab.kind === "chat" || tab.kind === "side_chat" || tab.kind === "goal_chat") {
    return <MessageSquare aria-hidden className={iconClassName} />;
  }
  if (tab.kind === "subagents" || tab.kind === "subagent") return <Bot aria-hidden className={iconClassName} />;
  if (tab.kind === "library_directory") return <Folder aria-hidden className={iconClassName} />;
  if (tab.kind === "library_document") return <FileText aria-hidden className={iconClassName} />;
  if (tab.kind === "library_entry") {
    return tab.path
      ? <FileText aria-hidden className={iconClassName} />
      : <LibraryBig aria-hidden className={iconClassName} />;
  }
  if (tab.kind === "library_file" || tab.kind === "local_file") {
    return <FileText aria-hidden className={iconClassName} />;
  }
  if (tab.kind === "organization_skill_file") return <FileText aria-hidden className={iconClassName} />;
  if (tab.kind === "local_apps") return <AppWindow aria-hidden className={iconClassName} />;
  if (tab.kind === "terminal") return <TerminalSquare aria-hidden className={iconClassName} />;
  if (tab.kind === "local_app") {
    return (
      <LocalAppIdentityIcon
        className={iconClassName}
        identity={tab}
        testId="chat-side-panel-tab-local-app-icon"
      />
    );
  }
  if (tab.kind === "browser") return <ChatSidePanelBrowserTabIcon favicon={tab.favicon} url={tab.url} />;
  if (tab.kind === "placeholder" && tab.targetKind === "issue") return <Circle aria-hidden className={iconClassName} />;
  if (tab.kind === "placeholder" && tab.targetKind === "automation") return <Workflow aria-hidden className={iconClassName} />;
  return <MessageSquare aria-hidden className={iconClassName} />;
}

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
  localAppsAvailable,
  terminalAvailable,
  organizationId,
  agentId,
  sourceConversationId,
  onOpenTarget,
}: {
  browserAvailable: boolean;
  localAppsAvailable: boolean;
  terminalAvailable: boolean;
  organizationId: string | null;
  agentId: string | null;
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
    ...(localAppsAvailable ? [{
      label: "Local apps",
      description: "Run a reviewed project service beside this workspace.",
      icon: AppWindow,
      target: { kind: "local_apps" as const, label: "Local apps" },
    }] : []),
    ...(terminalAvailable && organizationId && sourceConversationId ? [{
      label: "Terminal",
      description: "Open a shell in this Agent's workspace.",
      icon: TerminalSquare,
      target: {
        kind: "terminal" as const,
        organizationId,
        agentId,
        sessionId: crypto.randomUUID(),
        label: "Terminal",
      },
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
            data-testid={`chat-side-panel-empty-${label.toLowerCase().replaceAll(" ", "-")}-target`}
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
  currentUserAvatarUrl,
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
  currentUserAvatarUrl: string | null;
  agentMap: Map<string, Agent>;
  operatorDisplayName: string | null;
  expanded?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const { locale } = useI18n();
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
              locale={locale}
              reopenWillWakeAgent={Boolean(
                issue.assigneeAgentId
                && isAgentWakeEligible(agentMap.get(issue.assigneeAgentId)?.status),
              )}
              agentMap={agentMap}
              currentUserId={currentUserId}
              currentUserAvatarUrl={currentUserAvatarUrl}
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

function ChatSidePanelTextFileEditor({
  libraryFile,
  organizationId,
  sourceConversationId,
  markdown,
  sourceToolbar,
}: {
  libraryFile: OrganizationWorkspaceFileDetail;
  organizationId: string;
  sourceConversationId: string | null;
  markdown: boolean;
  sourceToolbar?: ReactNode;
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
  const annotationContainerRef = useRef<HTMLDivElement | null>(null);
  const [codeSelection, setCodeSelection] = useState<FileTextSelection | null>(null);
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

  const markdownParts = markdown
    ? splitChatSidePanelYamlFrontmatter(draftContent)
    : { frontmatter: null, separator: "", body: draftContent };
  const wordCount = countChatSidePanelMarkdownWords(markdownParts.body);
  const canUndo = editorRef.current?.canUndo?.() ?? false;
  const canRedo = editorRef.current?.canRedo?.() ?? false;

  return (
    <div
      className="relative flex h-full min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden"
      data-testid={markdown
        ? "chat-side-panel-library-markdown-editor"
        : "chat-side-panel-library-text-editor"}
    >
      {sourceToolbar}
      {markdown ? (
        <div ref={annotationContainerRef} className="scrollbar-auto-hide min-h-0 min-w-0 flex-1 overflow-y-auto px-5 pb-20 pt-5">
          <div className="rudder-readable-document mx-auto w-full max-w-[880px]">
            {markdownParts.frontmatter !== null ? (
              <details
                className="group mb-6 rounded-md border border-[color:var(--border-soft)] bg-[color:var(--surface-page)]"
                data-chat-annotation-ignore
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
              engine="codemirror"
              documentIdentity={`library-file:${filePath}`}
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
        </div>
      ) : (
        <div ref={annotationContainerRef} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pb-14">
          <WorkspaceCodeEditor
            data-testid="chat-side-panel-library-text-source-editor"
            annotationSource={{
              surface: "workspace_file",
              sourceFilePath: filePath,
            }}
            ariaLabel={`${filePath || "Library file"} source editor`}
            filePath={filePath}
            value={draftContent}
            onChange={handleDraftChange}
            onSelectionChange={setCodeSelection}
          />
        </div>
      )}
      <FileAnnotationSelectionToolbar
        containerRef={annotationContainerRef}
        conversationId={sourceConversationId}
        explicitSelection={markdown ? undefined : codeSelection}
        saved={
          saveStatus === "saved"
          && !saveConflict
          && draftContent === syncedContentRef.current
        }
        source={draftContent}
        sourceIdentity={{
          surface: "workspace_file",
          sourceFilePath: filePath,
          sourceLibraryEntryId: libraryFile.libraryEntryId,
        }}
        sourceRenderMode={markdown ? "markdown" : "text"}
        renderedSource={markdown ? markdownParts.body : draftContent}
        renderedSourceOffset={markdown ? draftContent.length - markdownParts.body.length : 0}
      />

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

        {markdown ? <TooltipProvider delayDuration={120}>
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
        </TooltipProvider> : null}
      </div>
    </div>
  );
}

function ChatSidePanelLibraryFileView({
  libraryFile,
  organizationId,
  sourceConversationId,
}: {
  libraryFile: OrganizationWorkspaceFileDetail;
  organizationId: string;
  sourceConversationId: string | null;
}) {
  const { pushToast } = useToast();
  const { selectedOrganization } = useOrganization();
  const location = useLocation();
  const navigate = useNavigate();
  const html = isWorkspaceHtmlPreviewFile(libraryFile); const media = libraryFile.previewKind === "video" || libraryFile.previewKind === "audio";
  const csv = isWorkspaceCsvPreviewFile(libraryFile);
  const markdown = isWorkspaceMarkdownPreviewFile(libraryFile);
  const editableText = libraryFile.previewKind === "text"
    && libraryFile.content !== null
    && !libraryFile.truncated;
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
  const LibraryFileIcon = html ? Globe2 : libraryFile.previewKind === "video" ? FileVideo2 : libraryFile.previewKind === "audio" ? FileAudio2 : FileText;

  return (
    <div
      className="flex h-full min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden"
      data-testid="chat-side-panel-library-file-view"
    >
      <div
        className="flex h-11 shrink-0 items-center gap-3 border-b border-[color:var(--border-soft)] px-4"
        data-testid="chat-side-panel-library-file-toolbar"
      >
        <LibraryFileIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
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
        {!html && !media ? (
          <div className="shrink-0" data-testid="chat-side-panel-library-open-in">
            {openInMenu}
          </div>
        ) : null}
      </div>
      {editableText && (
        markdown
        || (!html && !csv)
        || previewMode === "source"
      ) ? (
        <ChatSidePanelTextFileEditor
          key={`${organizationId}:${libraryFile.filePath}`}
          libraryFile={libraryFile}
          organizationId={organizationId}
          sourceConversationId={sourceConversationId}
          markdown={markdown}
          sourceToolbar={html ? (
            <WorkspaceHtmlPreviewToolbar
              viewMode="source"
              onViewModeChange={setPreviewMode}
              openAction={(
                <div className="shrink-0" data-testid="chat-side-panel-library-open-in">
                  {openInMenu}
                </div>
              )}
              testIdPrefix="chat-side-panel-library"
            />
          ) : undefined}
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
            mediaOpenAction={media ? <div className="shrink-0" data-testid="chat-side-panel-library-media-open-in">{openInMenu}</div> : undefined}
            testIdPrefix="chat-side-panel-library"
          />
        </>
      )}
    </div>
  );
}

export function ChatSidePanelSkillFileView({
  file,
  label,
}: {
  file: OrganizationSkillFileDetail;
  label: string;
}) {
  const [viewMode, setViewMode] = useState<"preview" | "source">("preview");
  const markdownParts = splitChatSidePanelYamlFrontmatter(file.content);
  const previewAvailable = file.markdown;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="chat-side-panel-skill-file-view">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-[color:var(--border-soft)] px-4">
        <Boxes className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{label}</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">{file.path}</div>
        </div>
        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          Read only
        </span>
        {previewAvailable ? (
          <div
            className="flex shrink-0 items-center rounded-md border border-[color:var(--border-soft)] p-0.5"
            data-testid="chat-side-panel-skill-view-toggle"
          >
            <button
              type="button"
              className={cn(
                "inline-flex h-7 w-7 items-center justify-center rounded-[4px] transition-colors",
                viewMode === "preview"
                  ? "bg-[color:var(--surface-active)] text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              aria-label="Preview skill Markdown"
              aria-pressed={viewMode === "preview"}
              onClick={() => setViewMode("preview")}
            >
              <Eye className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              className={cn(
                "inline-flex h-7 w-7 items-center justify-center rounded-[4px] transition-colors",
                viewMode === "source"
                  ? "bg-[color:var(--surface-active)] text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              aria-label="View skill Markdown source"
              aria-pressed={viewMode === "source"}
              onClick={() => setViewMode("source")}
            >
              <Code2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </div>
      <div className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto px-5 py-5">
        {previewAvailable && viewMode === "preview" ? (
          <MarkdownBody className="rudder-readable-document mx-auto w-full max-w-[880px] text-sm leading-7 text-foreground">
            {markdownParts.body}
          </MarkdownBody>
        ) : (
          <pre
            className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-6 text-foreground/85"
            data-testid="chat-side-panel-skill-source"
          >
            <code>{file.content}</code>
          </pre>
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
  const liveSurfaceRuntime = useOptionalLiveSurfaceRuntime();
  const savedViewPromotion = useOptionalSavedViewPromotion();
  const { pushToast } = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  const [draggedTabKey, setDraggedTabKey] = useState<string | null>(null);
  const [tabDropTarget, setTabDropTarget] = useState<{ key: string; position: "before" | "after" } | null>(null);
  const [closingSideChatKeys, setClosingSideChatKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [movingSideChatKey, setMovingSideChatKey] = useState<string | null>(null);
  const [desktopExitComplete, setDesktopExitComplete] = useState(!sidePanel.open);
  const panelRef = useRef<HTMLElement>(null);
  const activeTabElementRef = useRef<HTMLDivElement>(null);
  const tabScrollerElementRef = useRef<HTMLDivElement>(null);
  const browserShortcutControllersRef = useRef(new Map<string, (action: BrowserShortcutAction) => void>());
  const sideChatCloseHandlersRef = useRef(new Map<string, () => Promise<string | null>>());
  const closingSideChatKeysRef = useRef(new Set<string>());
  const movingSideChatKeyRef = useRef<string | null>(null);
  const lastOpenDesktopPanelRef = useRef<ReactElement | null>(null);
  const mobileFocusRestoreRef = useRef<HTMLElement | null>(null);
  const mobileFocusTrapActiveRef = useRef(false);
  const queryClient = useQueryClient();
  const operatorDisplayName = useOperatorDisplayName();
  const isMobile = useChatSidePanelMobileLayout();
  const { openTarget } = sidePanel;
  useEffect(() => {
    if (!isMobile || !contextReady) return undefined;
    const panel = panelRef.current;
    if (!panel) return undefined;

    if (!sidePanel.open) {
      if (mobileFocusTrapActiveRef.current) {
        mobileFocusTrapActiveRef.current = false;
        const restoreTarget = mobileFocusRestoreRef.current;
        mobileFocusRestoreRef.current = null;
        if (restoreTarget?.isConnected) {
          window.requestAnimationFrame(() => restoreTarget.focus());
        }
      }
      return undefined;
    }

    if (mobileFocusTrapActiveRef.current) return undefined;
    mobileFocusTrapActiveRef.current = true;
    const activeElement = document.activeElement;
    mobileFocusRestoreRef.current = activeElement instanceof HTMLElement ? activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => {
      if (document.querySelector('[data-slot="dialog-content"][data-state="open"]')) return;
      panel.querySelector<HTMLElement>('[data-testid="chat-side-panel-collapse"]')?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !sidePanel.open) return;
      if (document.querySelector('[data-slot="dialog-content"][data-state="open"]')) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.getClientRects().length > 0);
      if (focusable.length === 0) return;
      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.shiftKey
        ? currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1
        : currentIndex === focusable.length - 1 ? 0 : currentIndex + 1;
      event.preventDefault();
      focusable[nextIndex]?.focus();
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [contextReady, isMobile, sidePanel.open]);
  const registerBrowserShortcutController = useCallback((
    key: string,
    controller: ((action: BrowserShortcutAction) => void) | null,
  ) => {
    if (controller) browserShortcutControllersRef.current.set(key, controller);
    else browserShortcutControllersRef.current.delete(key);
  }, []);
  const openBrowserSettings = useCallback(() => {
    const currentPath = `${location.pathname}${location.search}${location.hash}`;
    const overlayState = buildSettingsOverlayState(location);
    rememberSettingsOverlayBackgroundPath(currentPath);
    navigate(
      "/instance/settings/browser",
      overlayState ? { state: overlayState } : undefined,
    );
  }, [location, navigate]);
  const registerSideChatCloseHandler = useCallback((
    clientMutationId: string,
    handler: (() => Promise<string | null>) | null,
  ) => {
    if (handler) sideChatCloseHandlersRef.current.set(clientMutationId, handler);
    else sideChatCloseHandlersRef.current.delete(clientMutationId);
  }, []);
  const selectSideChatResponseAnnotation = useCallback((
    annotation: ChatInlineAnnotation,
    ordinal: number,
  ) => {
    if (annotation.surface === "agent_run_transcript") {
      sidePanel.hidePanel();
      navigate(`/agents/${encodeURIComponent(annotation.sourceAgentId)}/runs/${encodeURIComponent(annotation.sourceRunId)}`);
      return;
    }
    if (annotation.surface === "workspace_file" || annotation.surface === "local_file") {
      void (async () => {
        try {
          let resolvedPath = annotation.sourceFilePath;
          let source: string | null;
          if (annotation.surface === "workspace_file") {
            if (!selectedOrganizationId) throw new Error("No organization selected");
            if (annotation.sourceLibraryEntryId) {
              const entry = await organizationsApi.getLibraryEntry(
                selectedOrganizationId,
                annotation.sourceLibraryEntryId,
              );
              if (entry.status !== "active" || !entry.currentPath) {
                throw new Error("Library source is unavailable");
              }
              resolvedPath = entry.currentPath;
            }
            source = (
              await organizationsApi.readWorkspaceFile(
                selectedOrganizationId,
                resolvedPath,
              )
            ).content;
          } else {
            const desktopShell = readDesktopShell();
            if (!desktopShell) throw new Error("Desktop file access is unavailable");
            source = (await desktopShell.previewLocalFile(resolvedPath)).content;
          }
          if (
            source === null
            || await hashChatAnnotationSource(source) !== annotation.sourceHash
            || source.slice(
              Math.max(0, annotation.start - annotation.prefix.length),
              annotation.start,
            ) !== annotation.prefix
            || source.slice(
              annotation.end,
              annotation.end + annotation.suffix.length,
            ) !== annotation.suffix
          ) {
            throw new Error("Annotation source changed");
          }
          const label = resolvedPath.split(/[\\/]/u).filter(Boolean).at(-1)
            ?? resolvedPath;
          requestChatFileAnnotationLocation({
            surface: annotation.surface,
            sourceFilePath: resolvedPath,
            sourceHash: annotation.sourceHash,
            sourceRenderMode: annotation.sourceRenderMode,
            start: annotation.start,
            end: annotation.end,
          });
          sidePanel.openTarget(
            annotation.surface === "workspace_file"
              ? annotation.sourceLibraryEntryId
                ? {
                    kind: "library_entry",
                    entryId: annotation.sourceLibraryEntryId,
                    path: resolvedPath,
                    label,
                  }
                : { kind: "library_file", filePath: resolvedPath, label }
              : { kind: "local_file", filePath: resolvedPath, label },
          );
        } catch {
          pushToast({
            title: "Source is no longer available",
            body: "The file was changed, moved without a Library identity, or deleted.",
            tone: "error",
          });
        }
      })();
      return;
    }
    sidePanel.hidePanel();
    navigate(
      {
        pathname: `/messenger/chat/${annotation.sourceConversationId}`,
        search: `?messageId=${encodeURIComponent(annotation.sourceMessageId)}`,
      },
      {
        state: createChatResponseAnnotationNavigationState(annotation, ordinal),
      },
    );
  }, [navigate, pushToast, selectedOrganizationId, sidePanel]);

  const visibleTabs = sidePanel.tabs;
  const sideChatTargets = useMemo(
    () => visibleTabs.filter((candidate): candidate is Extract<SidePanelTarget, { kind: "side_chat" }> => candidate.kind === "side_chat"),
    [visibleTabs],
  );
  const browserTargets = useMemo(
    () => visibleTabs.filter((candidate): candidate is Extract<SidePanelTarget, { kind: "browser" }> => candidate.kind === "browser"),
    [visibleTabs],
  );
  const localAppTargets = useMemo(
    () => visibleTabs.filter((candidate): candidate is Extract<SidePanelTarget, { kind: "local_app" }> => candidate.kind === "local_app"),
    [visibleTabs],
  );
  const terminalTargets = useMemo(
    () => visibleTabs.filter((candidate): candidate is Extract<SidePanelTarget, { kind: "terminal" }> => candidate.kind === "terminal"),
    [visibleTabs],
  );
  const liveSurfaceTargets = useMemo(() => {
    if (!liveSurfaceRuntime || !selectedOrganizationId) return [];
    return visibleTabs.flatMap((candidate) => {
      if (!sidePanelTargetSupportsSavedView(candidate)) return [];
      const viewInstanceId = candidate.kind === "browser"
        ? candidate.viewInstanceId ?? candidate.tabId
        : candidate.viewInstanceId;
      return viewInstanceId
        ? [{ ...candidate, viewInstanceId } as LiveSurfaceTarget]
        : [];
    });
  }, [liveSurfaceRuntime, selectedOrganizationId, visibleTabs]);
  const browserSavedViewMetadata = useBrowserSavedViewMetadataPersister({
    browserTargets,
    organizationId: selectedOrganizationId,
  });
  const liveBrowserCount = liveSurfaceRuntime && selectedOrganizationId
    ? liveSurfaceRuntime.getLiveBrowserCount(selectedOrganizationId)
    : browserTargets.length;
  const canOpenNewBrowserGuest = (
    browserTargets.length < MAX_BROWSER_TABS_PER_CONTEXT
    && liveBrowserCount < MAIN_WORKBENCH_BROWSER_CAPACITY
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
  const localAppsAvailable = Boolean(readDesktopShell()?.localApps?.supported);
  const terminalAvailable = Boolean(readDesktopShell()?.terminal?.supported);
  useEffect(() => {
    if (!contextReady
      || !target
      || (target.kind === "browser" && !browserAvailable)
      || (target.kind === "local_apps" && !localAppsAvailable)) return;
    openTarget(target);
  }, [browserAvailable, contextReady, localAppsAvailable, openTarget, target]);

  useEffect(() => {
    if (desktopBrowserAvailable) return;
    for (const browserTarget of browserTargets) {
      sidePanel.closeTarget(sidePanelTargetKey(browserTarget));
    }
  }, [browserTargets, desktopBrowserAvailable, sidePanel]);
  useEffect(() => {
    if (localAppsAvailable) return;
    for (const localAppTarget of localAppTargets) {
      sidePanel.closeTarget(sidePanelTargetKey(localAppTarget));
    }
  }, [localAppTargets, localAppsAvailable, sidePanel]);
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
  const issueProposalTarget = activeTarget?.kind === "issue_proposal" ? activeTarget : null;
  const chatTarget = activeTarget?.kind === "chat" ? activeTarget : null;
  const sideChatTarget = activeTarget?.kind === "side_chat" ? activeTarget : null;
  const runFeedbackTarget = activeTarget?.kind === "run_feedback_chat" ? activeTarget : null;
  const goalChatTarget = activeTarget?.kind === "goal_chat" ? activeTarget : null;
  const subagentsTarget = activeTarget?.kind === "subagents" ? activeTarget : null;
  const subagentTarget = activeTarget?.kind === "subagent" ? activeTarget : null;
  const automationTarget = activeTarget?.kind === "automation" ? activeTarget : null;
  const libraryFileTarget = activeTarget?.kind === "library_file" ? activeTarget : null;
  const localFileTarget = activeTarget?.kind === "local_file" ? activeTarget : null;
  const organizationSkillFileTarget = activeTarget?.kind === "organization_skill_file" ? activeTarget : null;
  const libraryDirectoryTarget = activeTarget?.kind === "library_directory" ? activeTarget : null;
  const libraryEntryTarget = activeTarget?.kind === "library_entry" ? activeTarget : null;
  const libraryDirectoryPath = libraryDirectoryTarget?.directoryPath ?? "";
  const browserTarget = activeTarget?.kind === "browser" ? activeTarget : null;
  const localAppsTarget = activeTarget?.kind === "local_apps" ? activeTarget : null;
  const localAppTarget = activeTarget?.kind === "local_app" ? activeTarget : null;
  const terminalTarget = activeTarget?.kind === "terminal" ? activeTarget : null;
  const activeLiveSurfaceTarget = activeTarget
    && liveSurfaceRuntime
    && sidePanelTargetSupportsSavedView(activeTarget)
    && (activeTarget.kind === "browser" || Boolean(activeTarget.viewInstanceId))
    ? activeTarget as LiveSurfaceTarget
    : null;
  const activeBrowserTargetKey = browserTarget ? sidePanelTargetKey(browserTarget) : null;
  const placeholderTarget = activeTarget?.kind === "placeholder" ? activeTarget : null;
  const targetQueriesEnabled = sidePanel.open || exiting;
  const sourceConversationId = sidePanel.contextKey.startsWith("chat:")
    ? sidePanel.contextKey.slice("chat:".length) || null
    : null;

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
      void queryClient.invalidateQueries({ queryKey: ["messenger"] }); if (selectedOrganizationId) void queryClient.invalidateQueries({ queryKey: queryKeys.chats.workManifests(selectedOrganizationId) });
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
  const sourceConversationQuery = useQuery({
    queryKey: queryKeys.chats.detail(selectedOrganizationId ?? "__none__", sourceConversationId ?? "__none__"),
    queryFn: () => chatsApi.get(sourceConversationId!),
    enabled: targetQueriesEnabled && !!selectedOrganizationId && !!sourceConversationId,
  });
  const chatMessagesQuery = useQuery({
    queryKey: queryKeys.chats.messages(selectedOrganizationId ?? "__none__", chatTarget?.conversationId ?? "__none__"),
    queryFn: () => chatsApi.listMessages(selectedOrganizationId!, chatTarget!.conversationId),
    enabled: targetQueriesEnabled && !!selectedOrganizationId && !!chatTarget,
  });
  const libraryFileQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceFile(selectedOrganizationId ?? "__none__", libraryFilePreviewPath ?? ""),
    queryFn: () => organizationsApi.readWorkspaceFile(selectedOrganizationId!, libraryFilePreviewPath!),
    enabled: targetQueriesEnabled && !!selectedOrganizationId && !!libraryFilePreviewPath,
  });
  const organizationSkillFileQuery = useQuery({
    queryKey: queryKeys.organizationSkills.file(
      selectedOrganizationId ?? "__none__",
      organizationSkillFileTarget?.skillId ?? "__none__",
      organizationSkillFileTarget?.filePath ?? "SKILL.md",
    ),
    queryFn: () => organizationSkillsApi.file(
      selectedOrganizationId!,
      organizationSkillFileTarget!.skillId,
      organizationSkillFileTarget!.filePath,
    ),
    enabled: targetQueriesEnabled && !!selectedOrganizationId && !!organizationSkillFileTarget,
  });
  const libraryDirectoryQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceFiles(selectedOrganizationId ?? "__none__", libraryDirectoryPath),
    queryFn: () => {
      if (!selectedOrganizationId) throw new Error("No organization selected");
      return organizationsApi.listWorkspaceFiles(selectedOrganizationId, libraryDirectoryPath);
    },
    enabled: targetQueriesEnabled && !!selectedOrganizationId && !!libraryDirectoryTarget,
  });

  const loading = Boolean(
    (issueTarget && issueQuery.isPending)
      || (chatTarget && (chatQuery.isPending || chatMessagesQuery.isPending))
      || (libraryFilePreviewPath && libraryFileQuery.isPending)
      || (organizationSkillFileTarget && organizationSkillFileQuery.isPending)
      || (libraryDirectoryTarget && libraryDirectoryQuery.isPending),
  );
  const error = issueTarget
    ? issueQuery.error ?? issueCommentsQuery.error ?? agentsQuery.error ?? sessionQuery.error
    : chatTarget
      ? chatQuery.error ?? chatMessagesQuery.error
      : libraryFilePreviewPath
        ? libraryFileQuery.error
        : organizationSkillFileTarget
          ? organizationSkillFileQuery.error
          : libraryDirectoryTarget
            ? libraryDirectoryQuery.error
            : null;
  const issue = issueTarget ? issueQuery.data : null;
  const issueComments = issueTarget ? (issueCommentsQuery.data ?? []) : [];
  const currentUserId = sessionQuery.data?.user?.id ?? sessionQuery.data?.session?.userId ?? null;
  const currentUserAvatarUrl = useCurrentUserAvatar();
  const agentMap = new Map((agentsQuery.data ?? []).map((agent) => [agent.id, agent]));
  const chat = chatTarget ? chatQuery.data : null;
  const sourceConversation = sourceConversationId ? sourceConversationQuery.data : null;
  const chatMessages = chatTarget ? (chatMessagesQuery.data ?? []) : [];
  const libraryFile = libraryFilePreviewPath ? libraryFileQuery.data : null;
  const organizationSkillFile = organizationSkillFileTarget ? organizationSkillFileQuery.data : null;
  const libraryDirectory = libraryDirectoryTarget ? libraryDirectoryQuery.data : null;
  const activeTargetKey = activeTarget ? sidePanelTargetKey(activeTarget) : "empty";
  const visibleTabOrderKey = visibleTabs.map(sidePanelTargetKey).join("\n");

  useLayoutEffect(() => {
    if (!sidePanel.open) return;
    const frameId = window.requestAnimationFrame(() => {
      const scroller = tabScrollerElementRef.current;
      const activeTabElement = activeTabElementRef.current;
      if (!scroller || !activeTabElement) return;
      const scrollerRect = scroller.getBoundingClientRect();
      const tabRect = activeTabElement.getBoundingClientRect();
      const leftOverflow = tabRect.left - scrollerRect.left;
      const rightOverflow = tabRect.right - scrollerRect.right;
      if (leftOverflow < 0) {
        scroller.scrollLeft += leftOverflow;
      } else if (rightOverflow > 0) {
        scroller.scrollLeft += rightOverflow;
      }
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [activeTargetKey, expanded, isMobile, sidePanel.open, visibleTabOrderKey]);

  useEffect(() => {
    const scroller = tabScrollerElementRef.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const activeTabElement = activeTabElementRef.current;
      if (!activeTabElement) return;
      const scrollerRect = scroller.getBoundingClientRect();
      const tabRect = activeTabElement.getBoundingClientRect();
      const leftOverflow = tabRect.left - scrollerRect.left;
      const rightOverflow = tabRect.right - scrollerRect.right;
      if (leftOverflow < 0) {
        scroller.scrollLeft += leftOverflow;
      } else if (rightOverflow > 0) {
        scroller.scrollLeft += rightOverflow;
      }
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [sidePanel.open, visibleTabOrderKey]);

  const openSidePanelTarget = (nextTarget: SidePanelTarget) => {
    if (nextTarget.kind === "browser" && !browserAvailable) return;
    if (nextTarget.kind === "local_apps" && !localAppsAvailable) return;
    const result = sidePanel.openTarget(nextTarget, {
      allowNewBrowserGuest: nextTarget.kind !== "browser"
        || canOpenNewBrowserGuest,
    });
    if (!result.admitted && result.reason === "browser_capacity") {
      pushToast({
        title: "Browser tab limit reached",
        body: `Close a Browser tab to open another. Side Panel and Main share ${MAIN_WORKBENCH_BROWSER_CAPACITY} live tabs.`,
        tone: "error",
      });
    }
  };
  const replaceSidePanelTarget = (key: string, nextTarget: SidePanelTarget) => sidePanel.replaceTarget(key, nextTarget);
  const cycleSidePanelTab = useCallback((direction: -1 | 1) => {
    if (visibleTabs.length < 2) return;
    const activeIndex = activeTarget
      ? visibleTabs.findIndex((candidate) => (
        sidePanelTargetKey(candidate) === sidePanelTargetKey(activeTarget)
      ))
      : -1;
    const nextIndex = (
      (activeIndex < 0 ? 0 : activeIndex) + direction + visibleTabs.length
    ) % visibleTabs.length;
    const nextTarget = visibleTabs[nextIndex];
    if (nextTarget) sidePanel.setActiveKey(sidePanelTargetKey(nextTarget));
  }, [activeTarget, sidePanel, visibleTabs]);

  const disposeLiveSurfaceTarget = useCallback((tab: SidePanelTarget) => {
    if (!liveSurfaceRuntime || !selectedOrganizationId || !sidePanelTargetSupportsSavedView(tab)) return;
    const viewInstanceId = tab.kind === "browser"
      ? tab.viewInstanceId ?? tab.tabId
      : tab.viewInstanceId;
    if (!viewInstanceId) return;
    liveSurfaceRuntime.disposeSurface(createLiveSurfaceRuntimeId(
      selectedOrganizationId,
      { ...tab, viewInstanceId } as LiveSurfaceTarget,
    ));
  }, [liveSurfaceRuntime, selectedOrganizationId]);

  const closeSidePanelTab = async (tab: SidePanelTarget) => {
    if (
      selectedOrganizationId
      && savedViewPromotion?.isMoving(
        selectedOrganizationId,
        sidePanel.contextKey,
        tab,
      )
    ) return;
    if (selectedOrganizationId) {
      savedViewPromotion?.discard(
        selectedOrganizationId,
        sidePanel.contextKey,
        tab,
      );
    }
    const tabKey = sidePanelTargetKey(tab);
    if (tab.kind === "terminal") {
      try {
        const terminal = readDesktopShell()?.terminal;
        if (!terminal?.supported) throw new Error("Desktop Terminal is unavailable.");
        await terminal.close(tab.sessionId);
        sidePanel.closeTarget(tabKey);
      } catch (cause) {
        pushToast({
          title: "Terminal could not be closed",
          body: cause instanceof Error ? cause.message : "Rudder could not confirm that the shell stopped.",
          tone: "error",
        });
      }
      return;
    }
    if (tab.kind === "browser") {
      await browserSavedViewMetadata.flushTarget(tab);
      sidePanel.closeTarget(tabKey);
      disposeLiveSurfaceTarget(tab);
      return;
    }
    if (tab.kind !== "side_chat") {
      sidePanel.closeTarget(tabKey);
      disposeLiveSurfaceTarget(tab);
      return;
    }
    if (movingSideChatKeyRef.current === tabKey) return;
    if (closingSideChatKeysRef.current.has(tabKey)) return;
    closingSideChatKeysRef.current.add(tabKey);
    setClosingSideChatKeys(new Set(closingSideChatKeysRef.current));
    try {
      const registeredClose = sideChatCloseHandlersRef.current.get(
        sideChatGenerationScopeKey(selectedOrganizationId ?? "__none__", tab),
      );
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
      if (error instanceof Error && error.name === "ChatGenerationCloseSupersededError") return;
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
    <>
      {isMobile && contextReady && (sidePanel.open || exiting) ? (
        <button
          type="button"
          data-testid="chat-side-panel-backdrop"
          aria-label="Close Side Panel"
          className="fixed inset-0 z-40 bg-[rgb(23_17_11/0.18)] backdrop-blur-[1px]"
          onClick={onClose ?? sidePanel.hidePanel}
        />
      ) : null}
      <aside
        ref={panelRef}
        onKeyDownCapture={handleSidePanelKeyDown}
        data-testid="chat-side-panel"
        className={cn(
          "flex min-h-0 shrink-0 flex-col gap-1.5 bg-transparent",
          isMobile
            ? "motion-chat-side-panel motion-panel-reveal fixed inset-x-3 bottom-3 top-[4.75rem] z-[45] w-auto"
            : "h-full w-full",
          isMobile && exiting && "translate-x-4 scale-[0.985] opacity-0",
          !contextReady && "hidden",
          isMobile && !sidePanel.open && !exiting && "hidden",
        )}
        role={isMobile ? "dialog" : undefined}
        aria-modal={isMobile ? true : undefined}
        aria-label="Side Panel"
        aria-hidden={!contextReady || undefined}
      >
      <div className={cn(
        "workspace-tab-header-card workspace-main-card relative z-10 flex shrink-0 flex-col overflow-visible rounded-[var(--desktop-workspace-radius)]",
        isMobile && "!bg-[color:var(--surface-page)] shadow-[0_24px_90px_-36px_rgb(0_0_0/0.75)]",
      )}>
        <div
          role="tablist"
          aria-label="Side Panel targets"
          data-testid="chat-side-panel-tabs"
          className="workspace-tab-strip flex shrink-0 items-center gap-1 overflow-hidden px-2 py-1.5"
        >
          <div
            ref={tabScrollerElementRef}
            data-testid="chat-side-panel-tab-scroller"
            className="scrollbar-auto-hide flex min-w-0 flex-1 gap-1 overflow-x-auto"
          >
            {visibleTabs.map((tab) => {
              const tabKey = sidePanelTargetKey(tab);
              const selected = tabKey === activeTargetKey;
              const dragging = draggedTabKey === tabKey;
              const sideChatClosing = closingSideChatKeys.has(tabKey);
              const promotionMoving = Boolean(
                selectedOrganizationId
                && savedViewPromotion?.isMoving(
                  selectedOrganizationId,
                  sidePanel.contextKey,
                  tab,
                ),
              );
              const closeDisabled = promotionMoving || (
                tab.kind === "side_chat"
                && (movingSideChatKey === tabKey || sideChatClosing)
              );
              return (
                <ChatSidePanelTabContextMenu
                  key={tabKey}
                  closeDisabled={closeDisabled}
                  isMobile={isMobile}
                  moveInProgress={
                    promotionMoving
                    || movingSideChatKey !== null
                    || sideChatClosing
                  }
                  organizationId={selectedOrganizationId}
                  tab={tab}
                  onClose={(target) => void closeSidePanelTab(target)}
                  onOpenInNewTab={(target) => {
                    sidePanel.openTargetInNewTab(target.kind === "browser"
                      ? createChatSidePanelBrowserTarget(target.url)
                      : target);
                  }}
                  onMoveSideChat={moveSideChatToMessenger}
                >
                  <div
                    ref={selected ? activeTabElementRef : undefined}
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
                      "workspace-tab-pill group relative flex h-7 max-w-[12.5rem] shrink-0 items-center rounded-full border pr-1 transition-[color,background-color,border-color,box-shadow,opacity]",
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
                      draggable={!promotionMoving && !isMobile && visibleTabs.length > 1}
                      aria-selected={selected}
                      data-testid="chat-side-panel-tab"
                      data-view-instance-id={sidePanelTargetSupportsSavedView(tab)
                        ? tab.kind === "browser"
                          ? tab.viewInstanceId ?? tab.tabId
                          : tab.viewInstanceId
                        : undefined}
                      data-browser-favicon={tab.kind === "browser" ? tab.favicon : undefined}
                      data-side-panel-tab-kind={tab.kind}
                      className="flex min-w-0 flex-1 cursor-grab items-center gap-1.5 rounded-l-full px-2.5 py-1 text-left text-xs active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                      onClick={() => {
                        if (!promotionMoving) sidePanel.setActiveKey(tabKey);
                      }}
                    >
                      <ChatSidePanelTabIcon enabled={targetQueriesEnabled} tab={tab} />
                      <span className="min-w-0 truncate">
                        {promotionMoving ? `${tab.label} · Moving…` : tab.label}
                      </span>
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
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              data-testid="chat-side-panel-add-tab"
              aria-label="Add Side Panel tab"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              onClick={sidePanel.openEmpty}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
            <KeepSidePanelViewButton
              contextKey={sidePanel.contextKey}
              organizationId={selectedOrganizationId}
              target={activeTarget}
            />
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
        "workspace-tab-content-card workspace-main-card flex min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-hidden rounded-[var(--desktop-workspace-radius)]",
        isMobile && "!bg-[color:var(--surface-page)]",
      )}>
        <div className={cn(
          "scrollbar-auto-hide min-h-0 min-w-0 max-w-full flex-1",
          activeLiveSurfaceTarget || localAppsTarget || terminalTarget || issueTarget || issueProposalTarget || localFileTarget || organizationSkillFileTarget || sideChatTarget || runFeedbackTarget || goalChatTarget || subagentsTarget || subagentTarget
            ? "flex h-full flex-col overflow-hidden"
            : "overflow-y-auto px-4 py-4",
          issueTarget && !browserTarget && "px-4 py-4",
        )} data-testid="chat-side-panel-scroll-body">
          {liveSurfaceTargets.map((target) => {
            const targetKey = sidePanelTargetKey(target);
            const active = targetKey === activeTargetKey;
            const runtimeId = createLiveSurfaceRuntimeId(
              selectedOrganizationId!,
              target,
            );
            const ownerId = `side:${sidePanel.contextKey}:${runtimeId}`;
            return (
              <LiveSurfaceAnchor
                key={runtimeId}
                active={active}
                callbacks={{
                  annotationConversationId: sourceConversationId,
                  canOpenNewTab: canOpenNewBrowserGuest,
                  onCloseTarget: (nextTarget) => {
                    void closeSidePanelTab(nextTarget);
                  },
                  onCycleTab: cycleSidePanelTab,
                  onOpenBrowserSettings: openBrowserSettings,
                  onOpenTarget: openSidePanelTarget,
                  onRegisterShortcutController: registerBrowserShortcutController,
                  onReplaceTarget: (nextTarget) => (
                    replaceSidePanelTarget(targetKey, nextTarget)
                  ),
                }}
                className={cn("h-full min-h-0 min-w-0 max-w-full", active ? "block" : "hidden")}
                hostId={ownerId}
                ownerId={ownerId}
                runtimeId={runtimeId}
                target={target}
                aria-hidden={!active}
              />
            );
          })}
          {!liveSurfaceRuntime ? browserTargets.map((target) => {
            const targetKey = sidePanelTargetKey(target);
            const active = targetKey === activeTargetKey;
            return (
              <div key={targetKey} className={cn("h-full min-h-0", active ? "block" : "hidden")} aria-hidden={!active}>
                <BrowserLiveSurface
                  active={active}
                  canOpenNewTab={canOpenNewBrowserGuest}
                  surface="side_panel"
                  target={target}
                  targetKey={targetKey}
                  onOpenBrowserSettings={openBrowserSettings}
                  onOpenTarget={openSidePanelTarget}
                  onReplaceTarget={replaceSidePanelTarget}
                  onCloseTarget={closeSidePanelTab}
                  onCycleTab={cycleSidePanelTab}
                  onRegisterShortcutController={registerBrowserShortcutController}
                />
              </div>
            );
          }) : null}
          {!liveSurfaceRuntime && localAppsAvailable ? localAppTargets.map((target) => {
            const targetKey = sidePanelTargetKey(target);
            const active = targetKey === activeTargetKey;
            return (
              <div key={targetKey} className={cn("h-full min-h-0", active ? "block" : "hidden")} aria-hidden={!active}>
                <LocalAppPanelView active={active} target={target} />
              </div>
            );
          }) : null}
          {terminalAvailable ? terminalTargets.map((target) => {
            const active = sidePanelTargetKey(target) === activeTargetKey;
            return (
              <div key={sidePanelTargetKey(target)} className={cn("h-full min-h-0 min-w-0 w-full", active ? "block" : "hidden")} aria-hidden={!active}>
                <TerminalPanelView active={active} target={target} />
              </div>
            );
          }) : null}
          {selectedOrganizationId ? sideChatTargets.map((target) => {
            const active = sidePanelTargetKey(target) === activeTargetKey;
            return (
              <div
                key={`side-chat-view:${selectedOrganizationId}:${target.sourceConversationId}:${target.clientMutationId}`}
                className={cn("h-full min-h-0", active ? "block" : "hidden")}
                aria-hidden={!active}
              >
                <SideChatPanelView
                  active={active}
                  organizationId={selectedOrganizationId}
                  target={target}
                  onRegisterCloseHandler={registerSideChatCloseHandler}
                  onReplaceTarget={replaceSidePanelTarget}
                  onSelectResponseAnnotation={selectSideChatResponseAnnotation}
                />
              </div>
            );
          }) : null}
          {activeLiveSurfaceTarget ? null : !activeTarget ? (
            <SidePanelEmptyState
              browserAvailable={browserAvailable}
              localAppsAvailable={localAppsAvailable}
              terminalAvailable={terminalAvailable}
              organizationId={selectedOrganizationId ?? null}
              agentId={sourceConversation?.preferredAgentId ?? null}
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
                currentUserAvatarUrl={currentUserAvatarUrl}
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
          ) : issueProposalTarget ? (
            <div
              className="h-full min-h-0"
              data-testid="chat-side-panel-issue-proposal-view"
            >
              <IssueProposalSidePanelContent targetKey={sidePanelTargetKey(issueProposalTarget)} />
            </div>
          ) : automationTarget ? (
            <div className="h-full min-h-0" data-testid="chat-side-panel-automation-view">
              <AutomationDetail
                key={automationTarget.automationId}
                automationId={automationTarget.automationId}
                embedded
                onClose={() => closeSidePanelTab(automationTarget)}
              />
            </div>
          ) : localAppsTarget ? (
            <LocalAppsPanel onOpenTarget={openSidePanelTarget} />
          ) : terminalTarget ? null : placeholderTarget ? (
            <SidePanelPlaceholderView browserAvailable={browserAvailable} target={placeholderTarget} onOpenTarget={openSidePanelTarget} />
          ) : sideChatTarget ? null : runFeedbackTarget && selectedOrganizationId ? (
            <RunFeedbackChatPanel
              organizationId={selectedOrganizationId}
              target={runFeedbackTarget}
              onReplaceTarget={replaceSidePanelTarget}
            />
          ) : goalChatTarget ? (
            <GoalChatPanel
              target={goalChatTarget}
              onReplaceTarget={replaceSidePanelTarget}
            />
          ) : subagentsTarget && selectedOrganizationId ? (
            <SubagentsPanelView organizationId={selectedOrganizationId} target={subagentsTarget} />
          ) : subagentTarget ? (
            <SubagentPanelView target={subagentTarget} />
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
              sourceConversationId={sourceConversationId}
            />
          ) : localFileTarget ? (
            <TranscriptLocalFilePreview
              key={localFileTarget.filePath}
              targetPath={localFileTarget.filePath}
              label={localFileTarget.label}
              sourceConversationId={sourceConversationId}
            />
          ) : organizationSkillFileTarget && organizationSkillFile ? (
            <ChatSidePanelSkillFileView
              key={`${organizationSkillFileTarget.skillId}:${organizationSkillFileTarget.filePath}`}
              file={organizationSkillFile}
              label={organizationSkillFileTarget.label}
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
    </>
  );

  if (isMobile) {
    if (!sidePanel.open && !exiting && sideChatTargets.length === 0) return null;
    return typeof document !== "undefined" ? createPortal(panel, document.body) : panel;
  }
  if (sidePanel.open) {
    lastOpenDesktopPanelRef.current = panel;
    return panel;
  }
  if (sideChatTargets.length > 0) return panel;
  if (
    !desktopExitComplete
    || liveSurfaceTargets.length > 0
    || browserTargets.length > 0
    || localAppTargets.length > 0
  ) return lastOpenDesktopPanelRef.current;
  return null;
}
