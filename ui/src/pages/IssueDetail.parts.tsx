import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { organizationsApi } from "../api/orgs";
import { activityApi } from "../api/activity";
import { heartbeatsApi } from "../api/heartbeats";
import { agentsApi } from "../api/agents";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { pluginsApi } from "../api/plugins";
import { organizationSkillsApi } from "../api/organizationSkills";
import { projectsApi } from "../api/projects";
import { useNavigationBack } from "../context/NavigationBackContext";
import { useOrganization } from "../context/OrganizationContext";
import { useToast } from "../context/ToastContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { formatAssigneeUserLabel } from "../lib/assignees";
import { buildAgentSkillMentionOptions } from "../lib/agent-skill-mentions";
import { formatChatAgentLabel } from "../lib/agent-labels";
import { queryKeys } from "../lib/queryKeys";
import { readIssueDetailBreadcrumb } from "../lib/issueDetailBreadcrumb";
import {
  hasBrowserBackStackEntry,
  shouldHandleDocumentFocusEscape,
  shouldHandleIssueDetailEscape,
} from "../lib/detail-escape";
import { readRecentIssueIds, recordRecentIssue } from "../lib/recent-issues";
import { resolveBoardActorLabel } from "../lib/activity-actors";
import { useOperatorDisplayName } from "../hooks/useOperatorDisplayName";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { relativeTime, cn, formatTokens, visibleRunCostUsd } from "../lib/utils";
import { InlineEditor } from "../components/InlineEditor";
import { CommentThread, type CommentThreadActivityItem } from "../components/CommentThread";
import {
  IssueDocumentFocusPage,
  IssueDocumentsSection,
  type IssueDocumentFocusTarget,
} from "../components/IssueDocumentsSection";
import { IssueDetailFind } from "../components/IssueDetailFind";
import { IssueProperties } from "../components/IssueProperties";
import { LiveRunWidget } from "../components/LiveRunWidget";
import type { MentionOption } from "../components/MarkdownEditor";
import { ScrollToBottom } from "../components/ScrollToBottom";
import { StatusIcon } from "../components/StatusIcon";
import { PriorityIcon } from "../components/PriorityIcon";
import { formatPriorityLabel } from "../lib/priorities";
import { PluginSlotMount, PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Activity as ActivityIcon,
  Check,
  ChevronRight,
  Copy,
  EyeOff,
  ExternalLink,
  FileCode2,
  Folder,
  Hexagon,
  ListTree,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Plus,
  Repeat,
  SlidersHorizontal,
  Trash2,
  Upload,
} from "lucide-react";
import { summarizeTokenUsage, type ActivityEvent } from "@rudderhq/shared";
import type { Agent, Issue, IssueAttachment, OrganizationWorkspaceFileEntry } from "@rudderhq/shared";

export {
  hasBrowserBackStackEntry,
  shouldHandleDocumentFocusEscape,
  shouldHandleIssueDetailEscape,
};

export type DocumentFocusState = {
  target: IssueDocumentFocusTarget;
  phase: "open" | "closing";
};

export type IssueCostSummaryData = {
  input: number;
  output: number;
  cached: number;
  cost: number;
  totalTokens: number;
  hasCost: boolean;
  hasTokens: boolean;
};

export type IssueChatTarget = Pick<Issue, "id" | "identifier" | "title" | "projectId" | "assigneeAgentId">;

export function buildIssueChatHref(issue: IssueChatTarget) {
  const params = new URLSearchParams({
    issueId: issue.id,
  });
  if (issue.projectId) params.set("projectId", issue.projectId);
  if (issue.assigneeAgentId) params.set("agentId", issue.assigneeAgentId);
  return `/messenger/chat?${params.toString()}`;
}

export const ISSUE_UPDATE_METADATA_KEYS = new Set([
  "identifier",
  "issueIdentifier",
  "_previous",
  "_references",
  "source",
  "reopened",
  "reopenedFrom",
  "normalizedFromStatus",
  "normalizedReason",
]);

export const ISSUE_UPDATE_FIELD_LABELS: Record<string, string> = {
  assigneeAgentId: "assignee",
  assigneeUserId: "assignee",
  assigneeAgentRuntimeOverrides: "assignee runtime overrides",
  billingCode: "billing code",
  executionWorkspaceId: "execution workspace",
  executionWorkspacePreference: "execution workspace preference",
  executionWorkspaceSettings: "execution workspace settings",
  goalId: "goal",
  hiddenAt: "visibility",
  labelIds: "labels",
  parentId: "parent issue",
  projectId: "project",
  projectWorkspaceId: "project workspace",
  requestDepth: "request depth",
  reviewerAgentId: "reviewer",
  reviewerUserId: "reviewer",
};

export const ACTION_LABELS: Record<string, string> = {
  "issue.created": "created the issue",
  "issue.updated": "updated the issue",
  "issue.checked_out": "checked out the issue",
  "issue.released": "released the issue",
  "issue.code_committed": "committed code",
  "issue.passive_followup_queued": "queued passive follow-up",
  "issue.closure_needs_operator_review": "needs operator review for close-out",
  "issue.review_decision_recorded": "recorded a reviewer decision",
  "issue.human_intervention_required": "requested human intervention",
  "issue.attachment_added": "added an attachment",
  "issue.attachment_removed": "removed an attachment",
  "issue.approval_linked": "linked an approval",
  "issue.approval_unlinked": "unlinked an approval",
  "issue.document_created": "created a document",
  "issue.document_updated": "updated a document",
  "issue.document_deleted": "deleted a document",
  "issue.deleted": "deleted the issue",
  "agent.created": "created an agent",
  "agent.updated": "updated the agent",
  "agent.paused": "paused the agent",
  "agent.resumed": "resumed the agent",
  "agent.terminated": "terminated the agent",
  "heartbeat.invoked": "invoked a heartbeat",
  "heartbeat.cancelled": "cancelled a heartbeat",
  "approval.created": "requested approval",
  "approval.approved": "approved",
  "approval.rejected": "rejected",
};

export function humanizeValue(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "none");
  return value.replace(/_/g, " ");
}

export function humanizeIssueUpdateField(key: string): string {
  return ISSUE_UPDATE_FIELD_LABELS[key] ?? key.replace(/Id$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

export function hasIssueUpdateValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

export function describeIssueFieldChange(fieldLabel: string, next: unknown, previous: unknown): string {
  if (hasIssueUpdateValue(next) && hasIssueUpdateValue(previous)) return `changed the ${fieldLabel}`;
  if (hasIssueUpdateValue(next)) return `set the ${fieldLabel}`;
  if (hasIssueUpdateValue(previous)) return `cleared the ${fieldLabel}`;
  return `updated the ${fieldLabel}`;
}

export function formatIssueUserLabel(userId: string, currentBoardUserId?: string | null): string {
  return formatAssigneeUserLabel(userId, currentBoardUserId) ?? userId.slice(0, 8);
}

export function formatIssuePrincipalLabel(
  principal: { agentId?: unknown; userId?: unknown } | null | undefined,
  agentMap: Map<string, Agent>,
  currentBoardUserId?: string | null,
): string | null {
  if (!principal) return null;
  if (typeof principal.agentId === "string" && principal.agentId) {
    return agentMap.get(principal.agentId)?.name ?? principal.agentId.slice(0, 8);
  }
  if (typeof principal.userId === "string" && principal.userId) {
    return formatIssueUserLabel(principal.userId, currentBoardUserId);
  }
  return null;
}

export function describeIssuePrincipalChange(input: {
  toLabel: string | null;
  fromLabel: string | null;
  assignedVerb: string;
  changedVerb: string;
  clearedVerb: string;
  unassignedVerb: string;
}): string {
  if (input.toLabel) {
    return input.fromLabel
      ? `${input.changedVerb} from ${input.fromLabel} to ${input.toLabel}`
      : `${input.assignedVerb} to ${input.toLabel}`;
  }
  return input.fromLabel
    ? `${input.clearedVerb} ${input.fromLabel}`
    : input.unassignedVerb;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

type IssueActivityReference = {
  id: string;
  identifier: string | null;
  title: string | null;
};

function readIssueActivityReference(value: unknown): IssueActivityReference | null {
  const record = asRecord(value);
  if (!record || typeof record.id !== "string") return null;
  return {
    id: record.id,
    identifier: typeof record.identifier === "string" ? record.identifier : null,
    title: typeof record.title === "string" ? record.title : null,
  };
}

function issueActivityReferenceLabel(reference: IssueActivityReference): string {
  return reference.identifier || reference.title || reference.id.slice(0, 8);
}

function issueActivityReferenceLink(reference: IssueActivityReference): string {
  return `/issues/${reference.identifier ?? reference.id}`;
}

function renderIssueActivityReference(reference: IssueActivityReference): ReactNode {
  return (
    <Link to={issueActivityReferenceLink(reference)} className="underline underline-offset-4 hover:text-foreground">
      {issueActivityReferenceLabel(reference)}
    </Link>
  );
}

export function issueUpdatedChangedKeys(details: Record<string, unknown> | null | undefined): string[] {
  if (!details) return [];
  return Object.keys(details).filter((key) => !ISSUE_UPDATE_METADATA_KEYS.has(key));
}

export function isDescriptionOnlyIssueUpdate(evt: ActivityEvent): boolean {
  if (evt.action !== "issue.updated") return false;
  const changedKeys = issueUpdatedChangedKeys(asRecord(evt.details));
  return changedKeys.length === 1 && changedKeys[0] === "description";
}

export function shouldShowIssueActivityEvent(evt: ActivityEvent): boolean {
  if (evt.action === "issue.comment_added") return false;
  if (evt.action === "issue.document_updated") return false;
  if (isDescriptionOnlyIssueUpdate(evt)) return false;
  return true;
}

export function usageNumber(usage: Record<string, unknown> | null, ...keys: string[]) {
  if (!usage) return 0;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

export function usageString(usage: Record<string, unknown> | null, ...keys: string[]) {
  if (!usage) return null;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}

export const issueStatusOptions = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
  "blocked",
] as const;

export const ISSUE_ATTACHMENT_ACCEPT = "image/*,application/pdf,text/plain,text/markdown,application/json,text/csv,text/html,.md,.markdown";
export const LINEAR_PLUGIN_KEY = "rudder.linear";
export const LINEAR_ISSUE_DETAIL_SLOT_ID = "linear-issue-tab";
export const LINEAR_ISSUE_LINK_DATA_KEY = "issue-link";

export type LinearIssueActivitySlot = {
  pluginId: string;
  pluginKey: string;
  id: string;
};

export type LinearIssueLinkState = {
  externalId: string;
  linearIdentifier: string;
  linearTitle: string;
  linearUrl: string;
  orgId: string;
  rudderIssueId: string;
  rudderIssueIdentifier: string | null;
  teamId: string;
  teamName: string;
  projectId: string | null;
  projectName: string | null;
  stateId: string;
  stateName: string;
  importedAt: string;
  updatedAt: string;
};

export type LinearIssueSummary = {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url: string;
  updatedAt: string;
  createdAt: string;
  team: { id: string; key?: string; name: string };
  state: { id: string; name: string };
  project?: { id: string; name: string } | null;
  assignee?: { id: string; name: string } | null;
};

export type LinearIssueLinkData =
  | {
    linked: false;
    issueTitle: string;
    searchQuery: string;
  }
  | {
    linked: true;
    issueTitle: string;
    link: LinearIssueLinkState;
    latestIssue: LinearIssueSummary | null;
    staleReason: string | null;
  };

export function issueStatusLabel(status: string) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function isLinearIssueDetailSlot(slot: LinearIssueActivitySlot) {
  return slot.pluginKey === LINEAR_PLUGIN_KEY && slot.id === LINEAR_ISSUE_DETAIL_SLOT_ID;
}

export function isMarkdownFile(file: File) {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".md") ||
    name.endsWith(".markdown") ||
    file.type === "text/markdown"
  );
}

export function fileBaseName(filename: string) {
  return filename.replace(/\.[^.]+$/, "");
}

export function slugifyDocumentKey(input: string) {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "document";
}

export function titleizeFilename(input: string) {
  return input
    .split(/[-_ ]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function workspaceEntryLabel(entry: OrganizationWorkspaceFileEntry) {
  return entry.displayLabel?.trim() || entry.name;
}

export function parentWorkspaceDirectory(directoryPath: string) {
  const segments = directoryPath.split("/").filter(Boolean);
  segments.pop();
  return segments.join("/");
}

export function WorkspaceAttachDialog({
  orgId,
  open,
  onOpenChange,
  onAttach,
  attaching,
  error,
}: {
  orgId: string | null | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAttach: (filePath: string) => Promise<void>;
  attaching: boolean;
  error: string | null;
}) {
  const [directoryPath, setDirectoryPath] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDirectoryPath("");
    setSelectedPath(null);
  }, [open, orgId]);

  const filesQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceFiles(orgId ?? "__none__", directoryPath),
    queryFn: () => organizationsApi.listWorkspaceFiles(orgId!, directoryPath),
    enabled: open && !!orgId,
    refetchOnWindowFocus: false,
  });

  const entries = filesQuery.data?.entries ?? [];
  const canGoUp = directoryPath.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-base">Attach from Workspaces</DialogTitle>
          <DialogDescription>
            Choose a file to copy into this issue's attachments.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex min-h-8 items-center gap-2 rounded-md border border-border bg-muted/20 px-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">/</span>
            <span className="truncate">{directoryPath || "workspace"}</span>
          </div>

          <div className="h-[320px] overflow-hidden rounded-md border border-border">
            {filesQuery.isLoading ? (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading files...
              </div>
            ) : filesQuery.error ? (
              <div className="p-3 text-sm text-destructive">
                {filesQuery.error instanceof Error ? filesQuery.error.message : "Could not load workspace files"}
              </div>
            ) : entries.length === 0 && !canGoUp ? (
              <div className="p-3 text-sm text-muted-foreground">
                No workspace files available.
              </div>
            ) : (
              <ScrollArea className="h-full">
                <div className="space-y-0.5 p-1.5">
                  {canGoUp ? (
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                      onClick={() => {
                        setDirectoryPath(parentWorkspaceDirectory(directoryPath));
                        setSelectedPath(null);
                      }}
                    >
                      <ChevronRight className="h-3.5 w-3.5 rotate-180" />
                      Parent folder
                    </button>
                  ) : null}
                  {entries.map((entry) => {
                    const label = workspaceEntryLabel(entry);
                    const selected = selectedPath === entry.path;
                    if (entry.isDirectory) {
                      return (
                        <button
                          type="button"
                          key={entry.path}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent/60"
                          onClick={() => {
                            setDirectoryPath(entry.path);
                            setSelectedPath(null);
                          }}
                        >
                          <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate font-medium">{label}</span>
                        </button>
                      );
                    }
                    return (
                      <button
                        type="button"
                        key={entry.path}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                          selected ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                        )}
                        onClick={() => setSelectedPath(entry.path)}
                        onDoubleClick={() => void onAttach(entry.path)}
                      >
                        <FileCode2 className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{label}</span>
                      </button>
                    );
                  })}
                </div>
              </ScrollArea>
            )}
          </div>

          {selectedPath ? (
            <p className="truncate text-xs text-muted-foreground">Selected: {selectedPath}</p>
          ) : null}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={attaching}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => selectedPath ? void onAttach(selectedPath) : undefined}
            disabled={!selectedPath || attaching}
          >
            {attaching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />}
            Attach
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function formatAction(
  action: string,
  details: Record<string, unknown> | null | undefined,
  agentMap: Map<string, Agent>,
  currentBoardUserId?: string | null,
): string {
  if (action === "issue.code_committed" && details) {
    const shortSha = typeof details.shortSha === "string" ? details.shortSha : null;
    const subject = typeof details.subject === "string" ? details.subject : null;
    if (shortSha && subject) return `committed ${shortSha}: ${subject}`;
    if (shortSha) return `committed ${shortSha}`;
  }
  if (action === "issue.updated" && details) {
    const previous = (details._previous ?? {}) as Record<string, unknown>;
    const parts: string[] = [];

    if (details.status !== undefined) {
      const from = previous.status;
      parts.push(
        from
          ? `moved from ${issueStatusLabel(humanizeValue(from))} to ${issueStatusLabel(humanizeValue(details.status))}`
          : `moved to ${issueStatusLabel(humanizeValue(details.status))}`
      );
    }
    if (details.priority !== undefined) {
      const from = previous.priority;
      parts.push(
        from
          ? `changed the priority from ${formatPriorityLabel(humanizeValue(from))} to ${formatPriorityLabel(humanizeValue(details.priority))}`
          : `changed the priority to ${formatPriorityLabel(humanizeValue(details.priority))}`
      );
    }
    if (details.assigneeAgentId !== undefined || details.assigneeUserId !== undefined) {
      const previousAssignee = asRecord(previous.assignee);
      const fromLabel = formatIssuePrincipalLabel(
        previousAssignee ?? { agentId: previous.assigneeAgentId, userId: previous.assigneeUserId },
        agentMap,
        currentBoardUserId,
      );
      const toLabel = formatIssuePrincipalLabel(
        { agentId: details.assigneeAgentId, userId: details.assigneeUserId },
        agentMap,
        currentBoardUserId,
      );
      parts.push(describeIssuePrincipalChange({
        toLabel,
        fromLabel,
        assignedVerb: "assigned the issue",
        changedVerb: "reassigned the issue",
        clearedVerb: "unassigned the issue from",
        unassignedVerb: "unassigned the issue",
      }));
    }
    if (details.reviewerAgentId !== undefined || details.reviewerUserId !== undefined) {
      const previousReviewer = asRecord(previous.reviewer);
      const fromLabel = formatIssuePrincipalLabel(
        previousReviewer ?? { agentId: previous.reviewerAgentId, userId: previous.reviewerUserId },
        agentMap,
        currentBoardUserId,
      );
      const toLabel = formatIssuePrincipalLabel(
        { agentId: details.reviewerAgentId, userId: details.reviewerUserId },
        agentMap,
        currentBoardUserId,
      );
      parts.push(describeIssuePrincipalChange({
        toLabel,
        fromLabel,
        assignedVerb: "set the reviewer",
        changedVerb: "changed the reviewer",
        clearedVerb: "cleared the reviewer from",
        unassignedVerb: "cleared the reviewer",
      }));
    }
    if (details.title !== undefined) parts.push("updated the title");
    if (details.description !== undefined) parts.push("updated the description");
    const handledKeys = new Set([
      "assigneeAgentId",
      "assigneeUserId",
      "description",
      "priority",
      "reviewerAgentId",
      "reviewerUserId",
      "status",
      "title",
    ]);
    for (const key of issueUpdatedChangedKeys(details).filter((changedKey) => !handledKeys.has(changedKey))) {
      parts.push(describeIssueFieldChange(humanizeIssueUpdateField(key), details[key], previous[key]));
    }

    if (parts.length > 0) return parts.join(", ");
  }
  if (
    (action === "issue.document_created" || action === "issue.document_updated" || action === "issue.document_deleted") &&
    details
  ) {
    const key = typeof details.key === "string" ? details.key : "document";
    const title = typeof details.title === "string" && details.title ? ` (${details.title})` : "";
    return `${ACTION_LABELS[action] ?? action} ${key}${title}`;
  }
  if (action === "issue.passive_followup_queued" && details) {
    const attempt = typeof details.attempt === "number" ? details.attempt : null;
    const maxAttempts = typeof details.maxAttempts === "number" ? details.maxAttempts : null;
    const followupRunId = typeof details.followupRunId === "string" ? details.followupRunId : null;
    const attemptLabel = attempt && maxAttempts ? ` (${attempt}/${maxAttempts})` : "";
    return `queued passive follow-up${attemptLabel}${followupRunId ? ` as run ${followupRunId.slice(0, 8)}` : ""}`;
  }
  if (action === "issue.closure_needs_operator_review" && details) {
    const attempts = typeof details.attempts === "number" ? details.attempts : null;
    return attempts
      ? `stopped passive follow-up after ${attempts} attempts; operator review needed`
      : "stopped passive follow-up; operator review needed";
  }
  if (action === "issue.review_decision_recorded" && details) {
    const decision = typeof details.decision === "string" ? humanizeValue(details.decision) : "unknown";
    if (details.outcome === "human_handoff" || details.operatorActionRequired === true) {
      return "confirmed blocker; operator handoff needed";
    }
    return `recorded reviewer decision: ${decision}`;
  }
  return ACTION_LABELS[action] ?? action.replace(/[._]/g, " ");
}

export function issueActivityChatLabel(evt: ActivityEvent): string {
  const details = asRecord(evt.details);
  const title = typeof details?.conversationTitle === "string" ? details.conversationTitle.trim() : "";
  return title || `Chat ${evt.entityId.slice(0, 8)}`;
}

export function renderActivityDescription(
  evt: ActivityEvent,
  agentMap: Map<string, Agent>,
  currentBoardUserId?: string | null,
): ReactNode {
  const details = asRecord(evt.details);
  if (evt.action === "issue.updated" && details && Object.prototype.hasOwnProperty.call(details, "parentId")) {
    const previous = asRecord(details._previous);
    const references = asRecord(details._references);
    const parentIssue = readIssueActivityReference(references?.parentIssue);
    const previousParentIssue = readIssueActivityReference(references?.previousParentIssue);
    if (parentIssue) {
      return (
        <>
          {hasIssueUpdateValue(previous?.parentId) ? "changed the parent issue to " : "set the parent issue to "}
          {renderIssueActivityReference(parentIssue)}
        </>
      );
    }
    if (previousParentIssue) {
      return <>cleared the parent issue {renderIssueActivityReference(previousParentIssue)}</>;
    }
  }

  if (evt.entityType === "chat") {
    const chatHref = `/chat/${evt.entityId}`;
    const label = issueActivityChatLabel(evt);
    const link = (
      <Link to={chatHref} className="underline underline-offset-4 hover:text-foreground">
        {label}
      </Link>
    );

    if (evt.action === "chat.issue_converted") {
      return <>created this issue from {link}</>;
    }
    if (evt.action === "chat.context_linked") {
      return <>linked this issue in {link}</>;
    }
    if (evt.action === "chat.created") {
      return <>started {link} with this issue linked</>;
    }
  }

  if (evt.action === "issue.approval_linked" || evt.action === "issue.approval_unlinked") {
    const approvalId = typeof details?.approvalId === "string" ? details.approvalId : null;
    if (approvalId) {
      const verb = evt.action === "issue.approval_linked" ? "linked" : "unlinked";
      return (
        <>
          {verb}{" "}
          <Link to={`/messenger/approvals/${approvalId}`} className="underline underline-offset-4 hover:text-foreground">
            an approval
          </Link>
        </>
      );
    }
  }

  return formatAction(evt.action, details, agentMap, currentBoardUserId);
}

export function issueActivityActorName({
  evt,
  agentMap,
  currentBoardUserId,
  operatorDisplayName,
}: {
  evt: ActivityEvent;
  agentMap: Map<string, Agent>;
  currentBoardUserId?: string | null;
  operatorDisplayName?: string | null;
}) {
  const id = evt.actorId;
  if (evt.actorType === "agent") {
    const agent = agentMap.get(id);
    return agent?.name ?? id.slice(0, 8);
  }
  return resolveBoardActorLabel(evt.actorType, id, currentBoardUserId, operatorDisplayName);
}

export function issueActivityMarkerStatus(evt: ActivityEvent): string | null {
  const details = asRecord(evt.details);
  if (evt.action === "issue.updated" && typeof details?.status === "string") return details.status;
  if (evt.action === "issue.checked_out") return "in_progress";
  if (evt.action === "issue.released") return "done";
  return null;
}

export function IssueActivityMarker({ evt }: { evt: ActivityEvent }) {
  const status = issueActivityMarkerStatus(evt);
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
      {status ? (
        <StatusIcon status={status} className="h-4 w-4" />
      ) : (
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/45" />
      )}
    </span>
  );
}

export function IssueActivityRow({
  evt,
  agentMap,
  currentBoardUserId,
  operatorDisplayName,
}: {
  evt: ActivityEvent;
  agentMap: Map<string, Agent>;
  currentBoardUserId?: string | null;
  operatorDisplayName?: string | null;
}) {
  const actorName = issueActivityActorName({ evt, agentMap, currentBoardUserId, operatorDisplayName });
  const activityDescription = renderActivityDescription(evt, agentMap, currentBoardUserId);
  const activityTime = relativeTime(evt.createdAt);

  return (
    <div
      data-testid="issue-activity-row"
      className="grid min-h-8 grid-cols-[16px_minmax(0,1fr)] items-center gap-2 rounded-sm border border-transparent py-1 pl-3 pr-2 text-xs text-muted-foreground"
    >
      <IssueActivityMarker evt={evt} />
      <span
        data-testid="issue-activity-summary"
        className="flex min-w-0 items-center gap-1.5 whitespace-nowrap leading-5"
      >
        <span className="max-w-[9rem] shrink-0 truncate font-medium text-foreground">{actorName}</span>
        <span className="min-w-0 truncate"> {activityDescription}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground/90"> · {activityTime}</span>
      </span>
    </div>
  );
}

export function LinearIssueActivityCard({ data }: { data: Extract<LinearIssueLinkData, { linked: true }> }) {
  const latest = data.latestIssue;
  const link = data.link;
  const identifier = latest?.identifier ?? link.linearIdentifier;
  const title = latest?.title ?? link.linearTitle;
  const url = latest?.url ?? link.linearUrl;
  const description = latest?.description?.trim() ?? "";
  const teamName = latest?.team.name ?? link.teamName;
  const stateName = latest?.state.name ?? link.stateName;
  const projectName = latest?.project?.name ?? link.projectName;
  const assigneeName = latest?.assignee?.name ?? null;
  const updatedAt = latest?.updatedAt ?? link.updatedAt;

  return (
    <section
      className="rounded-lg border border-border bg-card/70 p-3 text-sm"
      data-testid="issue-activity-linear-link"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Linked Linear issue
            </span>
            <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
              {identifier}
            </span>
          </div>
          <div className="font-medium text-foreground">{title}</div>
          <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
            <span className="rounded-full border border-border bg-background/70 px-2 py-0.5">{teamName}</span>
            <span className="rounded-full border border-border bg-background/70 px-2 py-0.5">{stateName}</span>
            {projectName ? (
              <span className="rounded-full border border-border bg-background/70 px-2 py-0.5">{projectName}</span>
            ) : null}
            {assigneeName ? (
              <span className="rounded-full border border-border bg-background/70 px-2 py-0.5">{assigneeName}</span>
            ) : null}
            <span className="rounded-full border border-border bg-background/70 px-2 py-0.5">
              Updated {relativeTime(updatedAt)}
            </span>
            <span className="rounded-full border border-border bg-background/70 px-2 py-0.5">
              Imported {relativeTime(link.importedAt)}
            </span>
          </div>
        </div>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          Open in Linear
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
      {data.staleReason ? (
        <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-200">
          {data.staleReason}
        </div>
      ) : null}
      {description ? (
        <p className="mt-3 line-clamp-4 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      ) : null}
    </section>
  );
}

export function IssueCostSummaryPanel({ summary }: { summary: IssueCostSummaryData }) {
  if (!summary.hasCost && !summary.hasTokens) return null;

  return (
    <section className="rounded-lg border border-border bg-background/80 p-3">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
        Cost
      </div>
      <div className="space-y-1.5 text-xs text-muted-foreground tabular-nums">
        {summary.hasCost ? (
          <div className="flex items-center justify-between gap-3">
            <span>Spend</span>
            <span className="font-medium text-foreground">${summary.cost.toFixed(4)}</span>
          </div>
        ) : null}
        {summary.hasTokens ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <span>Total tokens</span>
              <span className="font-medium text-foreground">{formatTokens(summary.totalTokens)}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Input</span>
              <span>{formatTokens(summary.input)}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Output</span>
              <span>{formatTokens(summary.output)}</span>
            </div>
            {summary.cached > 0 ? (
              <div className="flex items-center justify-between gap-3">
                <span>Cached</span>
                <span>{formatTokens(summary.cached)}</span>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
