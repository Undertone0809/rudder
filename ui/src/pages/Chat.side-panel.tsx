import { automationsApi } from "@/api/automations";
import { chatsApi } from "@/api/chats";
import { issuesApi } from "@/api/issues";
import { organizationsApi } from "@/api/orgs";
import { PriorityIcon } from "@/components/PriorityIcon";
import { StatusBadge } from "@/components/StatusBadge";
import { StatusIcon } from "@/components/StatusIcon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useSidePanel } from "@/context/SidePanelContext";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { sidePanelFullPageHref, sidePanelTargetKey, type SidePanelTarget } from "@/lib/side-panel-targets";
import { cn } from "@/lib/utils";
import type { Automation, AutomationDetail, AutomationRunSummary, AutomationTrigger, Issue, OrganizationWorkspaceFileEntry } from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Compass,
  FileCode2,
  FileText,
  Folder,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatAutomationTimestamp, runSourceLabel, runStatusTitle, summarizeTrigger } from "./AutomationDetail.parts";
import { conversationDisplayTitle } from "./Chat.parts";

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
      target: { kind: "browser", url: "about:blank", label: "Browser" },
    },
    {
      label: "Library",
      description: "Browse workspace files with the Library tree.",
      icon: Folder,
      target: { kind: "library_directory", directoryPath: "", label: "Library" },
    },
    {
      label: "Issue",
      description: "Pin an issue workspace and edit task fields here.",
      icon: Circle,
      target: { kind: "placeholder", targetKind: "issue", label: "Issue" },
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
        { label: "Browser", target: { kind: "browser", url: "about:blank", label: "Browser" } as SidePanelTarget },
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
  commentId,
  onUpdate,
  updating,
}: {
  issue: Issue;
  commentId: string | null;
  onUpdate: (data: Record<string, unknown>) => Promise<Issue>;
  updating: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(issue.title);
  const [descriptionDraft, setDescriptionDraft] = useState(issue.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const issueRef = issue.identifier ?? issue.id.slice(0, 8);
  const projectName = issue.project?.name ?? null;
  const assigneeLabel = issue.assigneeAgentId ?? issue.assigneeUserId ?? "Unassigned";
  const reviewerLabel = issue.reviewerAgentId ?? issue.reviewerUserId ?? "No reviewer";
  const titleChanged = titleDraft.trim() !== issue.title;
  const descriptionChanged = descriptionDraft !== (issue.description ?? "");
  const canSave = titleDraft.trim().length > 0 && (titleChanged || descriptionChanged);

  useEffect(() => {
    if (editing) return;
    setTitleDraft(issue.title);
    setDescriptionDraft(issue.description ?? "");
  }, [editing, issue.description, issue.title]);

  const saveDraft = async () => {
    if (!canSave) return;
    const patch: Record<string, unknown> = {};
    if (titleChanged) patch.title = titleDraft.trim();
    if (descriptionChanged) patch.description = descriptionDraft.trim() || null;
    setError(null);
    try {
      await onUpdate(patch);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update this issue.");
    }
  };

  const cancelDraft = () => {
    setTitleDraft(issue.title);
    setDescriptionDraft(issue.description ?? "");
    setError(null);
    setEditing(false);
  };

  const updateIssueField = async (data: Record<string, unknown>) => {
    setError(null);
    try {
      await onUpdate(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update this issue.");
    }
  };

  return (
    <div className="flex min-h-full flex-col" data-testid="chat-side-panel-issue-view">
      <div className="space-y-4 border-b border-[color:var(--border-soft)] pb-4">
        <div className="flex items-start justify-between gap-3">
          {editing ? (
            <Input
              aria-label="Issue title"
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.currentTarget.value)}
              className="h-9 text-base font-semibold"
              disabled={updating}
            />
          ) : (
            <h3 className="min-w-0 flex-1 text-lg font-semibold leading-7 text-foreground">{issue.title}</h3>
          )}
          <span className="shrink-0 rounded-full border border-[color:var(--border-soft)] px-2 py-0.5 text-xs text-muted-foreground">
            {issueRef}
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={issue.status} />
            <span className="inline-flex items-center gap-1.5 rounded-[calc(var(--radius-sm)-1px)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] px-2.5 py-1 text-xs font-medium text-muted-foreground shadow-[var(--shadow-sm)]">
              <PriorityIcon priority={issue.priority} showLabel />
            </span>
            {projectName ? (
              <span className="rounded-[calc(var(--radius-sm)-1px)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] px-2.5 py-1 text-xs font-medium text-muted-foreground shadow-[var(--shadow-sm)]">{projectName}</span>
            ) : null}
          </div>
          <span className="inline-flex items-center gap-2">
            <StatusIcon status={issue.status} onChange={(status) => void updateIssueField({ status })} />
            <PriorityIcon priority={issue.priority} onChange={(priority) => void updateIssueField({ priority })} />
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={editing ? "Cancel issue edit" : "Edit issue"}
              onClick={editing ? cancelDraft : () => setEditing(true)}
              disabled={updating}
            >
              {editing ? <X className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
            </Button>
          </span>
        </div>
        {error ? (
          <div role="alert" className="rounded-[var(--radius-md)] border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}
      </div>

      <div className="space-y-2 border-b border-[color:var(--border-soft)] py-4">
        <SidePanelDetailRow label="Owner">
          <span className="truncate">{assigneeLabel}</span>
        </SidePanelDetailRow>
        <SidePanelDetailRow label="Reviewer">
          <span className="truncate">{reviewerLabel}</span>
        </SidePanelDetailRow>
        <SidePanelDetailRow label="Project">
          <span className="truncate">{projectName ?? "No project"}</span>
        </SidePanelDetailRow>
        <SidePanelDetailRow label="Updated">
          <span className="truncate">{sidePanelDate(issue.updatedAt)}</span>
        </SidePanelDetailRow>
      </div>

      <section className="space-y-2 border-b border-[color:var(--border-soft)] py-4">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-sm font-semibold text-foreground">Details</h4>
          {editing ? (
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={cancelDraft} disabled={updating}>
                Cancel
              </Button>
              <Button type="button" size="sm" onClick={() => void saveDraft()} disabled={!canSave || updating}>
                {updating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Save
              </Button>
            </div>
          ) : null}
        </div>
        {editing ? (
          <Textarea
            aria-label="Issue description"
            value={descriptionDraft}
            onChange={(event) => setDescriptionDraft(event.currentTarget.value)}
            className="min-h-36 resize-y text-sm leading-6"
            disabled={updating}
          />
        ) : issue.description ? (
          <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{issue.description}</p>
        ) : (
          <p className="text-sm text-muted-foreground">No description.</p>
        )}
      </section>

      <section className="flex min-h-[10rem] flex-1 flex-col py-4">
        <h4 className="text-sm font-semibold text-foreground">Comment</h4>
        <div className="mt-3 space-y-3 text-sm text-muted-foreground">
          {commentId ? (
            <div className="rounded-[var(--radius-md)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] px-3 py-2">
              Target comment: <span className="font-mono text-foreground">{commentId}</span>
            </div>
          ) : null}
          <p>Open the full issue to review the complete comment thread and activity.</p>
        </div>
      </section>
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
  runs,
  onUpdate,
  updating,
}: {
  automation: AutomationDetail;
  runs: AutomationRunSummary[];
  onUpdate: (data: Record<string, unknown>) => Promise<Automation | AutomationDetail>;
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
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--surface-active)] px-2 py-1">
            <Play className="h-3 w-3" />
            Run controls on full page
          </span>
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

function ChatSidePanelLibraryTree({
  entries,
  selectedOrganizationId,
  onOpenTarget,
}: {
  entries: OrganizationWorkspaceFileEntry[];
  selectedOrganizationId: string | null | undefined;
  onOpenTarget: (target: SidePanelTarget) => void;
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
        />
      ))}
    </ul>
  );
}

function ChatSidePanelLibraryTreeNode({
  entry,
  selectedOrganizationId,
  onOpenTarget,
  depth = 0,
}: {
  entry: OrganizationWorkspaceFileEntry;
  selectedOrganizationId: string | null | undefined;
  onOpenTarget: (target: SidePanelTarget) => void;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const primaryLabel = displayChatSidePanelWorkspaceEntryLabel(entry);
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
          className="group flex w-full items-center rounded-md pr-1 text-sm text-foreground transition-[background-color,color,opacity,transform] duration-150 hover:bg-accent/60"
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
            <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{primaryLabel}</div>
            </div>
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
        className="group flex w-full items-center rounded-md pr-1 text-sm text-muted-foreground transition-[background-color,color,opacity,transform] duration-150 hover:bg-accent/50 hover:text-foreground"
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
        >
          <FileIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{primaryLabel}</span>
        </button>
      </div>
    </li>
  );
}

export function ChatSidePanel({
  target,
  selectedOrganizationId,
  onClose,
}: {
  target?: SidePanelTarget | null;
  selectedOrganizationId: string | null | undefined;
  onClose?: () => void;
}) {
  const sidePanel = useSidePanel();
  const queryClient = useQueryClient();
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  useEffect(() => {
    if (!target) return;
    sidePanel.openTarget(target);
  }, [sidePanel, target]);

  const visibleTabs = sidePanel.tabs;
  const activeTarget = useMemo(() => {
    if (visibleTabs.length === 0) return null;
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
  const browserTarget = activeTarget?.kind === "browser" ? activeTarget : null;
  const placeholderTarget = activeTarget?.kind === "placeholder" ? activeTarget : null;

  const issueQuery = useQuery({
    queryKey: queryKeys.issues.detail(issueTarget?.issueId ?? "__none__"),
    queryFn: () => issuesApi.get(issueTarget!.issueId),
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
  const libraryFileQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceFile(selectedOrganizationId ?? "__none__", libraryFileTarget?.filePath ?? ""),
    queryFn: () => organizationsApi.readWorkspaceFile(selectedOrganizationId!, libraryFileTarget!.filePath),
    enabled: !!selectedOrganizationId && !!libraryFileTarget,
  });
  const libraryDirectoryQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceFiles(selectedOrganizationId ?? "__none__", libraryDirectoryTarget?.directoryPath ?? ""),
    queryFn: () => organizationsApi.listWorkspaceFiles(selectedOrganizationId!, libraryDirectoryTarget!.directoryPath),
    enabled: !!selectedOrganizationId && !!libraryDirectoryTarget,
  });

  if (!sidePanel.open) return null;

  const loading = Boolean(
    (issueTarget && issueQuery.isPending)
      || (chatTarget && (chatQuery.isPending || chatMessagesQuery.isPending))
      || (automationTarget && (automationQuery.isPending || automationRunsQuery.isPending))
      || (libraryFileTarget && libraryFileQuery.isPending)
      || (libraryDirectoryTarget && libraryDirectoryQuery.isPending),
  );
  const error = issueQuery.error ?? chatQuery.error ?? chatMessagesQuery.error ?? automationQuery.error ?? automationRunsQuery.error ?? libraryFileQuery.error ?? libraryDirectoryQuery.error;
  const fullPageHref = activeTarget ? sidePanelFullPageHref(activeTarget) : null;
  const issue = issueTarget ? issueQuery.data : null;
  const chat = chatTarget ? chatQuery.data : null;
  const chatMessages = chatTarget ? (chatMessagesQuery.data ?? []) : [];
  const automation = automationTarget ? automationQuery.data : null;
  const automationRuns = automationTarget ? (automationRunsQuery.data ?? []) : [];
  const libraryFile = libraryFileTarget ? libraryFileQuery.data : null;
  const libraryDirectory = libraryDirectoryTarget ? libraryDirectoryQuery.data : null;
  const activeTargetKey = activeTarget ? sidePanelTargetKey(activeTarget) : "empty";

  const closePanel = () => {
    sidePanel.closePanel();
    onClose?.();
  };

  const openSidePanelTarget = (nextTarget: SidePanelTarget) => sidePanel.openTarget(nextTarget);

  const closeSidePanelTab = (tab: SidePanelTarget) => sidePanel.closeTarget(sidePanelTargetKey(tab));

  const libraryDirectoryEntries = libraryDirectory?.entries ?? [];
  const libraryDirectoryFileCount = libraryDirectoryEntries.filter((entry) => !entry.isDirectory).length;
  const libraryDirectoryFolderCount = libraryDirectoryEntries.length - libraryDirectoryFileCount;
  const addTabTargets: Array<{ label: string; icon: typeof Compass; target: SidePanelTarget }> = [
    { label: "Issue", icon: Circle, target: { kind: "placeholder", targetKind: "issue", label: "Issue" } },
    { label: "Automation", icon: Bot, target: { kind: "placeholder", targetKind: "automation", label: "Automation" } },
    { label: "Library", icon: Folder, target: { kind: "library_directory", directoryPath: "", label: "Library" } },
    { label: "Chat", icon: MessageSquare, target: { kind: "placeholder", targetKind: "chat", label: "Chat" } },
    { label: "Browser", icon: Compass, target: { kind: "browser", url: "about:blank", label: "Browser" } },
  ];
  const addSidePanelTab = (nextTarget: SidePanelTarget) => {
    openSidePanelTarget(nextTarget);
    setAddMenuOpen(false);
  };

  const isMobile = typeof window !== "undefined" && window.matchMedia?.("(max-width: 767px)").matches;

  return (
    <aside
      key={activeTargetKey}
      data-testid="chat-side-panel"
      className={cn(
        "motion-chat-side-panel flex min-h-0 w-full shrink-0 flex-col gap-1.5 bg-transparent",
        isMobile
          ? "fixed inset-x-3 bottom-3 top-[4.75rem] z-40"
          : "md:w-[min(420px,36vw)]",
      )}
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
          className="scrollbar-auto-hide flex shrink-0 gap-1 overflow-x-auto px-2 py-1.5"
        >
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
          <div className="shrink-0">
            <button
              type="button"
              data-testid="chat-side-panel-add-tab"
              aria-label="Add Side Panel tab"
              aria-haspopup="menu"
              aria-expanded={addMenuOpen}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              onClick={() => setAddMenuOpen((value) => !value)}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        {addMenuOpen ? (
          <div
            role="menu"
            aria-label="Add Side Panel tab"
            data-testid="chat-side-panel-add-menu"
            className="absolute right-2 top-9 z-50 w-44 rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] bg-[color:var(--surface-panel)] p-1 shadow-[var(--shadow-lg)]"
          >
            {addTabTargets.map(({ label, icon: Icon, target }) => (
              <button
                key={label}
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-[color:var(--surface-active)]"
                onClick={() => addSidePanelTab(target)}
              >
                <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                <span>{label}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="workspace-main-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--desktop-workspace-radius)]">
        <div className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {!activeTarget ? (
            <SidePanelEmptyState onOpenTarget={openSidePanelTarget} />
          ) : loading ? (
            <LoadingPanelBody />
          ) : error ? (
            <div role="alert" className="rounded-[var(--radius-lg)] border border-destructive/30 bg-destructive/10 px-3 py-3 text-sm text-destructive">
              {error instanceof Error ? error.message : "Could not load this Side Panel target."}
            </div>
          ) : issueTarget && issue ? (
            <ChatIssueSidePanelView
              issue={issue}
              commentId={issueTarget.commentId}
              updating={updateIssueMutation.isPending}
              onUpdate={(data) => updateIssueMutation.mutateAsync({ issueId: issue.id, data })}
            />
          ) : automationTarget && automation ? (
            <ChatAutomationSidePanelView
              automation={automation}
              runs={automationRuns}
              updating={updateAutomationMutation.isPending}
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
          ) : libraryFileTarget && libraryFile ? (
            <div className="space-y-4" data-testid="chat-side-panel-library-file-view">
              <div className="rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] px-3 py-3 text-sm">
                <div className="font-mono text-xs text-muted-foreground">{libraryFile.filePath}</div>
                <div className="mt-2 text-xs text-muted-foreground">{libraryFile.contentType ?? libraryFile.previewKind}{libraryFile.truncated ? " · truncated" : ""}</div>
              </div>
              {libraryFile.previewKind === "text" && libraryFile.content !== null ? (
                <pre className="max-h-[52vh] overflow-auto rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] bg-[color:var(--code-surface)] p-3 text-xs leading-5 text-[color:var(--code-foreground)]"><code>{libraryFile.content}</code></pre>
              ) : libraryFile.previewKind === "image" && libraryFile.contentPath ? (
                <img src={libraryFile.contentPath} alt={libraryFile.filePath} className="max-h-[52vh] rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] object-contain" />
              ) : (
                <p className="text-sm text-muted-foreground">No inline preview is available for this file.</p>
              )}
            </div>
          ) : libraryDirectoryTarget ? (
            <div className="space-y-3" data-testid="chat-side-panel-library-directory-view">
              {libraryDirectory ? (
                <div className="rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] px-3 py-2 text-sm">
                  <div className="truncate font-mono text-xs text-muted-foreground">{libraryDirectory.directoryPath || "Library root"}</div>
                  <div className="mt-1 text-xs text-muted-foreground" data-testid="chat-side-panel-library-file-count">
                    {libraryDirectoryFileCount} file{libraryDirectoryFileCount === 1 ? "" : "s"} · {libraryDirectoryFolderCount} folder{libraryDirectoryFolderCount === 1 ? "" : "s"}
                  </div>
                </div>
              ) : null}
              <ChatSidePanelLibraryTree
                entries={libraryDirectoryEntries}
                selectedOrganizationId={selectedOrganizationId}
                onOpenTarget={openSidePanelTarget}
              />
            </div>
          ) : browserTarget ? (
            <div className="space-y-4" data-testid="chat-side-panel-browser-view">
              <div className="rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] px-3 py-3">
                <h3 className="text-base font-semibold text-foreground">{browserTarget.label}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Browser targets are kept as panel tabs first. A secure embedded browsing surface can attach here when the app exposes one.
                </p>
                <div className="mt-3 rounded-[var(--radius-sm)] bg-[color:var(--surface-inset)] px-2 py-1.5 font-mono text-xs text-muted-foreground">
                  {browserTarget.url}
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Open this target in the full page for details.</p>
          )}
        </div>
      </div>
      <div className="workspace-main-card flex shrink-0 items-center justify-between gap-3 rounded-[var(--desktop-workspace-radius)] px-3 py-2">
        <div className="min-w-0 text-xs text-muted-foreground">
          {activeTarget ? "Panel comments and quick actions stay here." : "Select a target to start working."}
        </div>
        {fullPageHref ? (
          <Link to={fullPageHref} className="inline-flex h-8 shrink-0 items-center rounded-[var(--radius-sm)] px-2.5 text-xs text-muted-foreground transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground">
            Full page
          </Link>
        ) : null}
      </div>
    </aside>
  );
}
