import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { automationsApi } from "@/api/automations";
import { chatsApi } from "@/api/chats";
import { issuesApi } from "@/api/issues";
import { organizationsApi } from "@/api/orgs";
import { AgentIcon } from "@/components/AgentIconPicker";
import { CommentThread } from "@/components/CommentThread";
import { InlineEditor } from "@/components/InlineEditor";
import { IssueProperties } from "@/components/IssueProperties";
import { MarkdownBody } from "@/components/MarkdownBody";
import { PriorityIcon } from "@/components/PriorityIcon";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSidePanel } from "@/context/SidePanelContext";
import { useOperatorDisplayName } from "@/hooks/useOperatorDisplayName";
import { queryKeys } from "@/lib/queryKeys";
import { sidePanelTargetKey, type SidePanelTarget } from "@/lib/side-panel-targets";
import { cn } from "@/lib/utils";
import type { Agent, Automation, AutomationDetail, AutomationRunSummary, AutomationTrigger, Issue, IssueComment, OrganizationWorkspaceFileDetail, OrganizationWorkspaceFileEntry } from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Box,
  Boxes,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Compass,
  ExternalLink,
  FileCode2,
  FileText,
  Folder,
  Globe2,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  MessageSquare,
  Minimize2,
  PackageOpen,
  PanelRightClose,
  Play,
  Plus,
  RotateCw,
  UserRound,
  X
} from "lucide-react";
import { createElement, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { formatAutomationTimestamp, runSourceLabel, runStatusTitle, summarizeTrigger } from "./AutomationDetail.parts";
import { conversationDisplayTitle } from "./Chat.parts";
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
const CHAT_SIDE_PANEL_BROWSER_BLANK_URL = "about:blank";

type BrowserWebviewElement = HTMLElement & {
  canGoBack?: () => boolean;
  canGoForward?: () => boolean;
  getURL?: () => string;
  goBack?: () => void;
  goForward?: () => void;
  reload?: () => void;
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

function createChatSidePanelBrowserTarget(url = CHAT_SIDE_PANEL_BROWSER_BLANK_URL): Extract<SidePanelTarget, { kind: "browser" }> {
  return {
    kind: "browser",
    url,
    label: chatSidePanelBrowserLabel(url),
    tabId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

function chatSidePanelBrowserLabel(url: string) {
  const trimmed = url.trim();
  if (!trimmed || trimmed === CHAT_SIDE_PANEL_BROWSER_BLANK_URL) return "New tab";
  if (trimmed.startsWith("data:")) return "Data URL";
  try {
    const parsed = new URL(trimmed);
    return parsed.hostname || parsed.protocol.replace(":", "") || "Browser";
  } catch {
    return trimmed;
  }
}

function normalizeChatSidePanelBrowserUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return CHAT_SIDE_PANEL_BROWSER_BLANK_URL;
  if (/^(about|data|file|https?):/i.test(trimmed)) return trimmed;
  if (/\s/.test(trimmed)) return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
  if (/^(localhost|\d{1,3}(?:\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  if (trimmed.includes(".")) {
    return `https://${trimmed}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

function sidePanelDate(value: Date | string | null | undefined, fallback = "-") {
  if (!value) return fallback;
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return fallback;
  }
}

function SidePanelDetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[76px_minmax(0,1fr)] items-center gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className="min-w-0 text-right text-foreground">{children}</div>
    </div>
  );
}

function SidePanelEmptyState({
  onOpenTarget,
}: {
  onOpenTarget: (target: SidePanelTarget) => void;
}) {
  const targets: Array<{
    label: string;
    description: string;
    icon: typeof Compass;
    target: SidePanelTarget;
  }> = [
    {
      label: "Browser",
      description: "Keep a browser tab beside the current workspace.",
      icon: Compass,
      target: createChatSidePanelBrowserTarget(),
    },
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
  target,
  onOpenTarget,
}: {
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
          {config.actions.map((action) => (
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

function automationNextTrigger(automation: AutomationDetail): AutomationTrigger | null {
  return [...automation.triggers]
    .filter((trigger) => trigger.enabled)
    .sort((a, b) => {
      const aTime = a.nextRunAt ? new Date(a.nextRunAt).getTime() : Number.POSITIVE_INFINITY;
      const bTime = b.nextRunAt ? new Date(b.nextRunAt).getTime() : Number.POSITIVE_INFINITY;
      return aTime - bTime;
    })[0] ?? automation.triggers[0] ?? null;
}

function ChatAutomationSidePanelView({
  automation,
  onRun,
  runs,
  onUpdate,
  running,
  updating,
}: {
  automation: AutomationDetail;
  onRun: () => Promise<unknown>;
  runs: AutomationRunSummary[];
  onUpdate: (data: Record<string, unknown>) => Promise<Automation | AutomationDetail>;
  running: boolean;
  updating: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const nextTrigger = automationNextTrigger(automation);
  const latestRun = runs[0] ?? automation.recentRuns[0] ?? null;
  const active = automation.status === "active";
  const projectLabel = automation.project?.name ?? "No project";
  const modelLabel = automation.assignee ? `${automation.assignee.name}` : "No assignee";
  const visibleRuns = runs.length > 0 ? runs : automation.recentRuns;
  const toggleStatus = async () => {
    setError(null);
    try {
      await onUpdate({ status: active ? "paused" : "active" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update this automation.");
    }
  };
  const runNow = async () => {
    setError(null);
    try {
      await onRun();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not run this automation.");
    }
  };

  return (
    <div className="flex min-h-full flex-col" data-testid="chat-side-panel-automation-view">
      <div className="space-y-4 border-b border-[color:var(--border-soft)] pb-4">
        <div className="flex items-start gap-3">
          <h3 className="min-w-0 flex-1 text-lg font-semibold leading-7 text-foreground">{automation.title}</h3>
          <span className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-xs",
            active ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" : "bg-[color:var(--surface-active)] text-muted-foreground",
          )}>
            <span className={cn("h-1.5 w-1.5 rounded-full", active ? "bg-emerald-500" : "bg-muted-foreground/60")} />
            {active ? "Active" : "Paused"}
          </span>
        </div>
        {automation.description ? (
          <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{automation.description}</p>
        ) : null}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Button type="button" variant="outline" size="xs" onClick={() => void toggleStatus()} disabled={updating}>
            {updating ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
            {active ? "Pause" : "Resume"}
          </Button>
          <Button type="button" variant="outline" size="xs" onClick={() => void runNow()} disabled={running}>
            {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            {running ? "Starting..." : "Run now"}
          </Button>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--surface-active)] px-2 py-1">
            <Bot className="h-3 w-3" />
            {automation.outputMode === "chat_output" ? "Sends to chat" : "Tracks issue"}
          </span>
        </div>
        {error ? (
          <div role="alert" className="rounded-[var(--radius-md)] border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}
      </div>

      <section className="space-y-2 border-b border-[color:var(--border-soft)] py-4">
        <h4 className="text-sm font-semibold text-foreground">Status</h4>
        <SidePanelDetailRow label="Status">
          <span className="truncate">{active ? "Active" : "Paused"}</span>
        </SidePanelDetailRow>
        <SidePanelDetailRow label="Next run">
          <span className="truncate">{formatAutomationTimestamp(nextTrigger?.nextRunAt, "-")}</span>
        </SidePanelDetailRow>
        <SidePanelDetailRow label="Last ran">
          <span className="truncate">{formatAutomationTimestamp(latestRun?.triggeredAt, "-")}</span>
        </SidePanelDetailRow>
      </section>

      <section className="space-y-2 border-b border-[color:var(--border-soft)] py-4">
        <h4 className="text-sm font-semibold text-foreground">Details</h4>
        <SidePanelDetailRow label="Runs in">
          <span className="truncate">{automation.outputMode === "chat_output" ? "Chat" : "Issue"}</span>
        </SidePanelDetailRow>
        <SidePanelDetailRow label="Project">
          <span className="truncate">{projectLabel}</span>
        </SidePanelDetailRow>
        <SidePanelDetailRow label="Repeats">
          <span className="truncate">{summarizeTrigger(nextTrigger)}</span>
        </SidePanelDetailRow>
        <SidePanelDetailRow label="Model">
          <span className="truncate">{modelLabel}</span>
        </SidePanelDetailRow>
      </section>

      <section className="flex min-h-[12rem] flex-1 flex-col py-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h4 className="text-sm font-semibold text-foreground">Previous runs</h4>
          <span className="text-xs text-muted-foreground">{visibleRuns.length}</span>
        </div>
        {visibleRuns.length === 0 ? (
          <p className="text-sm text-muted-foreground">No runs yet.</p>
        ) : (
          <div className="space-y-2">
            {visibleRuns.slice(0, 12).map((run) => (
              <div key={run.id} className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2 text-sm">
                {run.status === "running" ? (
                  <CalendarClock className="h-3.5 w-3.5 text-blue-500" />
                ) : (
                  <Circle className={cn("h-2.5 w-2.5 fill-current", run.status === "failed" ? "text-red-500" : "text-muted-foreground")} />
                )}
                <div className="min-w-0">
                  <div className="truncate text-foreground">{runStatusTitle(run.status)}</div>
                  <div className="truncate text-xs text-muted-foreground">{runSourceLabel(run.source)}</div>
                </div>
                <span className="text-xs text-muted-foreground">{sidePanelDate(run.triggeredAt)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
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

function isChatSidePanelWorkspaceMarkdownFile(filePath: string | null | undefined, contentType: string | null | undefined) {
  const normalized = filePath?.toLowerCase() ?? "";
  return [".md", ".markdown", ".mdown", ".mdx"].some((extension) => normalized.endsWith(extension))
    || contentType === "text/markdown";
}

function ChatSidePanelLibraryFileView({
  libraryFile,
}: {
  libraryFile: OrganizationWorkspaceFileDetail;
}) {
  const markdown = isChatSidePanelWorkspaceMarkdownFile(libraryFile.filePath, libraryFile.contentType);

  return (
    <div className="flex min-h-full flex-col" data-testid="chat-side-panel-library-file-view">
      <div className="shrink-0 rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] px-3 py-3 text-sm">
        <div className="font-mono text-xs text-muted-foreground">{libraryFile.filePath}</div>
        <div className="mt-2 text-xs text-muted-foreground">
          {libraryFile.contentType ?? libraryFile.previewKind}
          {libraryFile.truncated ? " · truncated" : ""}
        </div>
      </div>
      {libraryFile.previewKind === "text" && libraryFile.content !== null ? (
        markdown ? (
          <article className="min-w-0 flex-1 px-1 py-5" data-testid="chat-side-panel-library-markdown-preview">
            <MarkdownBody
              className="rudder-library-document-editor rudder-side-panel-library-document text-[15px] leading-7 text-foreground"
              enableCodeBlockCopy
            >
              {libraryFile.content}
            </MarkdownBody>
          </article>
        ) : (
          <pre className="mt-4 max-h-[52vh] overflow-auto rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] bg-[color:var(--code-surface)] p-3 text-xs leading-5 text-[color:var(--code-foreground)]"><code>{libraryFile.content}</code></pre>
        )
      ) : libraryFile.previewKind === "image" && libraryFile.contentPath ? (
        <img src={libraryFile.contentPath} alt={libraryFile.filePath} className="mt-4 max-h-[52vh] rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] object-contain" />
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">No inline preview is available for this file.</p>
      )}
    </div>
  );
}

function ChatSidePanelBrowserView({
  target,
  targetKey,
  onOpenTarget,
  onReplaceTarget,
}: {
  target: Extract<SidePanelTarget, { kind: "browser" }>;
  targetKey: string;
  onOpenTarget: (target: SidePanelTarget) => void;
  onReplaceTarget: (key: string, target: SidePanelTarget) => void;
}) {
  const webviewRef = useRef<BrowserWebviewElement | null>(null);
  const webviewReadyRef = useRef(false);
  const [addressValue, setAddressValue] = useState(target.url === CHAT_SIDE_PANEL_BROWSER_BLANK_URL ? "" : target.url);
  const [currentUrl, setCurrentUrl] = useState(target.url);
  const [title, setTitle] = useState(target.label);
  const [loading, setLoading] = useState(false);
  const [navigationState, setNavigationState] = useState({ canGoBack: false, canGoForward: false });
  const [loadError, setLoadError] = useState<string | null>(null);
  const isBlank = currentUrl === CHAT_SIDE_PANEL_BROWSER_BLANK_URL;

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

  const replaceBrowserTarget = useCallback((nextUrl: string, nextTitle = chatSidePanelBrowserLabel(nextUrl)) => {
    const nextTarget: Extract<SidePanelTarget, { kind: "browser" }> = {
      ...target,
      url: nextUrl,
      label: nextTitle,
    };
    setCurrentUrl(nextUrl);
    setTitle(nextTitle);
    setAddressValue(nextUrl === CHAT_SIDE_PANEL_BROWSER_BLANK_URL ? "" : nextUrl);
    onReplaceTarget(targetKey, nextTarget);
  }, [onReplaceTarget, target, targetKey]);

  useEffect(() => {
    setCurrentUrl(target.url);
    setTitle(target.label);
    setAddressValue(target.url === CHAT_SIDE_PANEL_BROWSER_BLANK_URL ? "" : target.url);
    setLoadError(null);
    webviewReadyRef.current = false;
    setNavigationState({ canGoBack: false, canGoForward: false });
  }, [target.label, target.url]);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview || webview.tagName.toLowerCase() !== "webview") return undefined;

    const handleStart = () => {
      setLoading(true);
      setLoadError(null);
    };
    const handleStop = () => {
      setLoading(false);
      const nextUrl = safeCurrentWebviewUrl("");
      if (nextUrl && nextUrl !== currentUrl) {
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
      const nextUrl = safeCurrentWebviewUrl(currentUrl);
      const nextTitle = "title" in event && typeof event.title === "string" && event.title.trim()
        ? event.title.trim()
        : chatSidePanelBrowserLabel(nextUrl);
      setTitle(nextTitle);
      onReplaceTarget(targetKey, { ...target, url: nextUrl, label: nextTitle });
    };
    const handleFail = (event: Event) => {
      const errorDescription = "errorDescription" in event && typeof event.errorDescription === "string"
        ? event.errorDescription
        : "Could not load this page.";
      setLoading(false);
      if (errorDescription !== "ERR_ABORTED") setLoadError(errorDescription);
      updateNavigationState();
    };
    const handleDomReady = () => {
      webviewReadyRef.current = true;
      updateNavigationState();
    };

    webview.addEventListener("dom-ready", handleDomReady);
    webview.addEventListener("did-start-loading", handleStart);
    webview.addEventListener("did-stop-loading", handleStop);
    webview.addEventListener("did-navigate", handleNavigate);
    webview.addEventListener("did-navigate-in-page", handleNavigate);
    webview.addEventListener("page-title-updated", handleTitle);
    webview.addEventListener("did-fail-load", handleFail);
    updateNavigationState();

    return () => {
      webview.removeEventListener("dom-ready", handleDomReady);
      webview.removeEventListener("did-start-loading", handleStart);
      webview.removeEventListener("did-stop-loading", handleStop);
      webview.removeEventListener("did-navigate", handleNavigate);
      webview.removeEventListener("did-navigate-in-page", handleNavigate);
      webview.removeEventListener("page-title-updated", handleTitle);
      webview.removeEventListener("did-fail-load", handleFail);
    };
  }, [currentUrl, onReplaceTarget, replaceBrowserTarget, safeCurrentWebviewUrl, target, targetKey, updateNavigationState]);

  const handleWebviewRef = useCallback((node: BrowserWebviewElement | null) => {
    webviewRef.current = node;
    webviewReadyRef.current = false;
    if (!node) setNavigationState({ canGoBack: false, canGoForward: false });
  }, []);

  const navigateTo = useCallback((nextValue: string) => {
    const nextUrl = normalizeChatSidePanelBrowserUrl(nextValue);
    setLoadError(null);
    replaceBrowserTarget(nextUrl, chatSidePanelBrowserLabel(nextUrl));
  }, [replaceBrowserTarget]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const submittedAddress = formData.get("browser-url");
    navigateTo(typeof submittedAddress === "string" ? submittedAddress : addressValue);
  };

  const openExternal = () => {
    if (isBlank) return;
    window.open(currentUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="flex min-h-full flex-col" data-testid="chat-side-panel-browser-view">
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
          onClick={() => safeWebviewCall((webview) => {
            webview.reload?.();
          }, undefined)}
        >
          <RotateCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
        <form className="min-w-0 flex-1" onSubmit={handleSubmit}>
          <Input
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
          <span className="min-w-0 truncate">{isBlank ? "New tab" : title}</span>
        </div>
        {loadError ? (
          <div role="alert" className="border-b border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {loadError}
          </div>
        ) : null}
        {isBlank ? (
          <div className="flex min-h-[44vh] flex-1 items-center justify-center px-6 text-center" data-testid="chat-side-panel-browser-start">
            <div className="max-w-[18rem]">
              <Globe2 className="mx-auto h-12 w-12 text-muted-foreground" />
              <h3 className="mt-4 text-base font-semibold text-foreground">Start browsing</h3>
              <p className="mt-2 text-sm text-muted-foreground">Enter a URL to open a page.</p>
            </div>
          </div>
        ) : createElement("webview", {
          ref: handleWebviewRef,
          src: currentUrl,
          className: "min-h-[52vh] flex-1 bg-[color:var(--surface-panel)]",
          "data-testid": "chat-side-panel-browser-webview",
          allowpopups: "true",
        })}
      </div>
    </div>
  );
}

export function ChatSidePanel({
  desktopWidth,
  expanded = false,
  exiting = false,
  onClose,
  onToggleExpanded,
  resizing = false,
  target,
  selectedOrganizationId,
}: {
  desktopWidth?: number;
  expanded?: boolean;
  exiting?: boolean;
  onClose?: () => void;
  onToggleExpanded?: () => void;
  resizing?: boolean;
  target?: SidePanelTarget | null;
  selectedOrganizationId: string | null | undefined;
}) {
  const sidePanel = useSidePanel();
  const queryClient = useQueryClient();
  const operatorDisplayName = useOperatorDisplayName();
  const { openTarget } = sidePanel;

  useEffect(() => {
    if (!target) return;
    openTarget(target);
  }, [openTarget, target]);

  const visibleTabs = sidePanel.tabs;
  const activeTarget = useMemo(() => {
    if (visibleTabs.length === 0) return null;
    if (sidePanel.activeKey === null) return null;
    if (sidePanel.activeKey) {
      const matchingTab = visibleTabs.find((candidate) => sidePanelTargetKey(candidate) === sidePanel.activeKey);
      if (matchingTab) return matchingTab;
    }
    return visibleTabs.at(-1) ?? null;
  }, [sidePanel.activeKey, visibleTabs]);

  const issueTarget = activeTarget?.kind === "issue" ? activeTarget : null;
  const chatTarget = activeTarget?.kind === "chat" ? activeTarget : null;
  const automationTarget = activeTarget?.kind === "automation" ? activeTarget : null;
  const libraryFileTarget = activeTarget?.kind === "library_file" ? activeTarget : null;
  const libraryDirectoryTarget = activeTarget?.kind === "library_directory" ? activeTarget : null;
  const libraryEntryTarget = activeTarget?.kind === "library_entry" ? activeTarget : null;
  const browserTarget = activeTarget?.kind === "browser" ? activeTarget : null;
  const placeholderTarget = activeTarget?.kind === "placeholder" ? activeTarget : null;

  const libraryFilePreviewPath = libraryFileTarget?.filePath ?? libraryEntryTarget?.path ?? null;
  const issueQuery = useQuery({
    queryKey: queryKeys.issues.detail(issueTarget?.issueId ?? "__none__"),
    queryFn: () => issuesApi.get(issueTarget!.issueId),
    enabled: !!issueTarget,
  });
  const issueCommentsQuery = useQuery({
    queryKey: queryKeys.issues.comments(issueTarget?.issueId ?? "__none__"),
    queryFn: () => issuesApi.listComments(issueTarget!.issueId),
    enabled: !!issueTarget,
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedOrganizationId ?? "__none__"),
    queryFn: () => agentsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId && !!issueTarget,
  });
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: !!issueTarget,
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
    enabled: !!selectedOrganizationId && !!chatTarget,
  });
  const chatMessagesQuery = useQuery({
    queryKey: queryKeys.chats.messages(selectedOrganizationId ?? "__none__", chatTarget?.conversationId ?? "__none__"),
    queryFn: () => chatsApi.listMessages(chatTarget!.conversationId),
    enabled: !!selectedOrganizationId && !!chatTarget,
  });
  const automationQuery = useQuery({
    queryKey: queryKeys.automations.detail(automationTarget?.automationId ?? "__none__"),
    queryFn: () => automationsApi.get(automationTarget!.automationId),
    enabled: !!automationTarget,
  });
  const automationRunsQuery = useQuery({
    queryKey: queryKeys.automations.runs(automationTarget?.automationId ?? "__none__"),
    queryFn: () => automationsApi.listRuns(automationTarget!.automationId),
    enabled: !!automationTarget,
  });
  const updateAutomationMutation = useMutation({
    mutationFn: ({ automationId, data }: { automationId: string; data: Record<string, unknown> }) =>
      automationsApi.update(automationId, data),
    onSuccess: (updatedAutomation) => {
      queryClient.setQueryData(queryKeys.automations.detail(updatedAutomation.id), (current: AutomationDetail | undefined) =>
        current ? { ...current, ...updatedAutomation } : updatedAutomation,
      );
      void queryClient.invalidateQueries({ queryKey: ["automations"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.runs(updatedAutomation.id) });
      void queryClient.invalidateQueries({ queryKey: ["messenger"] });
    },
  });
  const runAutomationMutation = useMutation({
    mutationFn: (automationId: string) => automationsApi.run(automationId),
    onSuccess: (run, automationId) => {
      queryClient.setQueryData(queryKeys.automations.runs(automationId), (current: AutomationRunSummary[] | undefined) =>
        current ? [run, ...current] : [run],
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.detail(automationId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.automations.runs(automationId) });
      void queryClient.invalidateQueries({ queryKey: ["automations"] });
      void queryClient.invalidateQueries({ queryKey: ["messenger"] });
    },
  });
  const libraryFileQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceFile(selectedOrganizationId ?? "__none__", libraryFilePreviewPath ?? ""),
    queryFn: () => organizationsApi.readWorkspaceFile(selectedOrganizationId!, libraryFilePreviewPath!),
    enabled: !!selectedOrganizationId && !!libraryFilePreviewPath,
  });
  const libraryDirectoryQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceFiles(selectedOrganizationId ?? "__none__", libraryDirectoryTarget?.directoryPath ?? ""),
    queryFn: () => organizationsApi.listWorkspaceFiles(selectedOrganizationId!, libraryDirectoryTarget!.directoryPath),
    enabled: !!selectedOrganizationId && !!libraryDirectoryTarget,
  });

  if (!sidePanel.open && !exiting) return null;

  const loading = Boolean(
    (issueTarget && issueQuery.isPending)
      || (chatTarget && (chatQuery.isPending || chatMessagesQuery.isPending))
      || (automationTarget && (automationQuery.isPending || automationRunsQuery.isPending))
      || (libraryFilePreviewPath && libraryFileQuery.isPending)
      || (libraryDirectoryTarget && libraryDirectoryQuery.isPending),
  );
  const error = issueQuery.error ?? issueCommentsQuery.error ?? agentsQuery.error ?? sessionQuery.error ?? chatQuery.error ?? chatMessagesQuery.error ?? automationQuery.error ?? automationRunsQuery.error ?? libraryFileQuery.error ?? libraryDirectoryQuery.error;
  const issue = issueTarget ? issueQuery.data : null;
  const issueComments = issueTarget ? (issueCommentsQuery.data ?? []) : [];
  const currentUserId = sessionQuery.data?.user?.id ?? sessionQuery.data?.session?.userId ?? null;
  const agentMap = new Map((agentsQuery.data ?? []).map((agent) => [agent.id, agent]));
  const chat = chatTarget ? chatQuery.data : null;
  const chatMessages = chatTarget ? (chatMessagesQuery.data ?? []) : [];
  const automation = automationTarget ? automationQuery.data : null;
  const automationRuns = automationTarget ? (automationRunsQuery.data ?? []) : [];
  const libraryFile = libraryFilePreviewPath ? libraryFileQuery.data : null;
  const libraryDirectory = libraryDirectoryTarget ? libraryDirectoryQuery.data : null;
  const activeTargetKey = activeTarget ? sidePanelTargetKey(activeTarget) : "empty";

  const openSidePanelTarget = (nextTarget: SidePanelTarget) => sidePanel.openTarget(nextTarget);
  const replaceSidePanelTarget = (key: string, nextTarget: SidePanelTarget) => sidePanel.replaceTarget(key, nextTarget);

  const closeSidePanelTab = (tab: SidePanelTarget) => sidePanel.closeTarget(sidePanelTargetKey(tab));

  const libraryDirectoryEntries = libraryDirectory?.entries ?? [];
  const libraryDirectoryFileCount = libraryDirectoryEntries.filter((entry) => !entry.isDirectory).length;
  const libraryDirectoryFolderCount = libraryDirectoryEntries.length - libraryDirectoryFileCount;
  const isMobile = typeof window !== "undefined" && window.matchMedia?.("(max-width: 767px)").matches;
  const desktopPanelStyle = !isMobile && desktopWidth && !expanded ? { width: desktopWidth } : undefined;

  return (
    <aside
      key={activeTargetKey}
      data-testid="chat-side-panel"
      className={cn(
        "motion-chat-side-panel flex min-h-0 w-full shrink-0 flex-col gap-1.5 bg-transparent",
        isMobile
          ? "fixed inset-x-3 bottom-3 top-[4.75rem] z-40"
          : expanded
            ? "md:w-full transition-[width,opacity,transform] duration-300 ease-out motion-reduce:transition-none"
            : "md:w-[min(420px,36vw)] transition-[width,opacity,transform] duration-300 ease-out motion-reduce:transition-none",
        exiting && "translate-x-4 scale-[0.985] opacity-0",
        resizing && "transition-none",
      )}
      style={desktopPanelStyle}
      aria-label="Side Panel"
    >
      <div className={cn(
        "workspace-main-card relative z-10 flex shrink-0 flex-col overflow-visible rounded-[var(--desktop-workspace-radius)]",
        isMobile && "shadow-[0_24px_90px_-36px_rgb(0_0_0/0.75)]",
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
              return (
                <div
                  key={tabKey}
                  role="presentation"
                  className={cn(
                    "group flex h-7 max-w-[12.5rem] shrink-0 items-center rounded-full border pr-1 transition-colors",
                    selected
                      ? "border-[color:var(--border-strong)] bg-[color:var(--surface-active)] text-foreground"
                      : "border-transparent text-muted-foreground hover:bg-[color:var(--surface-active)] hover:text-foreground",
                  )}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    data-testid="chat-side-panel-tab"
                    className="min-w-0 flex-1 truncate rounded-l-full px-2.5 py-1 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    onClick={() => sidePanel.setActiveKey(tabKey)}
                  >
                    {tab.label}
                  </button>
                  <button
                    type="button"
                    data-testid="chat-side-panel-tab-close"
                    aria-label={`Close ${tab.label} tab`}
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[color:var(--surface-panel)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeSidePanelTab(tab);
                    }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
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
              <PanelRightClose className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
      <div className="workspace-main-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--desktop-workspace-radius)]">
        <div className={cn(
          "scrollbar-auto-hide min-h-0 flex-1",
          browserTarget || issueTarget ? "overflow-hidden" : "overflow-y-auto px-4 py-4",
          issueTarget && !browserTarget && "px-4 py-4",
        )} data-testid="chat-side-panel-scroll-body">
          {!activeTarget ? (
            <SidePanelEmptyState onOpenTarget={openSidePanelTarget} />
          ) : loading ? (
            <LoadingPanelBody />
          ) : error ? (
            <div role="alert" className="rounded-[var(--radius-lg)] border border-destructive/30 bg-destructive/10 px-3 py-3 text-sm text-destructive">
              {error instanceof Error ? error.message : "Could not load this Side Panel target."}
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
          ) : automationTarget && automation ? (
            <ChatAutomationSidePanelView
              automation={automation}
              runs={automationRuns}
              running={runAutomationMutation.isPending}
              updating={updateAutomationMutation.isPending}
              onRun={() => runAutomationMutation.mutateAsync(automation.id)}
              onUpdate={(data) => updateAutomationMutation.mutateAsync({ automationId: automation.id, data })}
            />
          ) : placeholderTarget ? (
            <SidePanelPlaceholderView target={placeholderTarget} onOpenTarget={openSidePanelTarget} />
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
          ) : libraryFilePreviewPath && libraryFile ? (
            <ChatSidePanelLibraryFileView libraryFile={libraryFile} />
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
          ) : browserTarget ? (
            <ChatSidePanelBrowserView
              target={browserTarget}
              targetKey={activeTargetKey}
              onOpenTarget={openSidePanelTarget}
              onReplaceTarget={replaceSidePanelTarget}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Open this target in the full page for details.</p>
          )}
        </div>
      </div>
    </aside>
  );
}
