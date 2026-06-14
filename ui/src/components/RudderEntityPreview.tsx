import type {
  Agent,
  AgentDetail,
  LibraryDocument,
  OrganizationWorkspaceFileDetail,
  Project,
} from "@rudderhq/shared";
import { FileText, Folder, MessageSquareText } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { organizationsApi } from "../api/orgs";
import { projectsApi } from "../api/projects";
import type { ParsedMentionChip } from "../lib/mention-chips";
import { formatPriorityLabel } from "../lib/priorities";
import { cn } from "../lib/utils";
import { AgentIcon } from "./AgentAvatar";
import { PriorityIcon } from "./PriorityIcon";
import { ProjectIcon } from "./ProjectIdentity";
import { StatusIcon } from "./StatusIcon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

type PreviewableMention = Exclude<ParsedMentionChip, { kind: "chat" }>;

interface RudderEntityPreviewProps {
  mention: PreviewableMention;
  label: string;
  children: ReactNode;
}

type PreviewRow = {
  label: string;
  value: string | null | undefined;
  agent?: {
    icon: string | null;
    role: Agent["role"] | null;
  };
  project?: {
    color: string | null;
    icon: string | null;
  };
  issueStatus?: string | null;
  priority?: string | null;
};

type AgentPreviewRef = {
  name: string;
  icon: string | null;
  role: Agent["role"] | null;
};

type EntityPreview =
  | {
      kind: "issue";
      eyebrow: string;
      title: string;
      status: string;
      rows: PreviewRow[];
      summary: string | null;
    }
  | {
      kind: "issue_comment";
      eyebrow: string;
      title: string;
      rows: PreviewRow[];
      summary: string | null;
    }
  | {
      kind: "agent";
      eyebrow: string;
      title: string;
      subtitle: string | null;
      status: string;
      icon: string | null;
      role: Agent["role"] | null;
      summary: string | null;
    }
  | {
      kind: "project";
      eyebrow: string;
      title: string;
      color: string | null;
      icon: string | null;
      rows: PreviewRow[];
      summary: string | null;
    }
  | {
      kind: "library";
      eyebrow: string;
      title: string;
      icon: "file" | "folder";
      rows: PreviewRow[];
      summary: string | null;
    };

type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; preview: EntityPreview }
  | { status: "error"; message: string };

const SELECTED_ORG_STORAGE_KEY = "rudder.selectedOrganizationId";

function readSelectedOrgId() {
  if (typeof window === "undefined") return null;
  if (typeof window.localStorage?.getItem !== "function") return null;
  return window.localStorage.getItem(SELECTED_ORG_STORAGE_KEY);
}

function formatHumanLabel(value: string | null | undefined) {
  if (!value) return null;
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function compactText(value: string | null | undefined, maxLength = 220) {
  const compacted = value?.replace(/\s+/g, " ").trim() ?? "";
  if (!compacted) return null;
  return compacted.length > maxLength ? `${compacted.slice(0, maxLength - 1).trimEnd()}...` : compacted;
}

function firstMarkdownParagraph(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  const blocks = trimmed.split(/\n\s*\n/u).map((part) => part.trim()).filter(Boolean);
  const paragraph = blocks.find((part) => !/^#{1,6}\s+/u.test(part)) ?? blocks[0] ?? trimmed;
  return compactText(paragraph.replace(/^#{1,6}\s+/gm, ""));
}

function commentBodyPreview(value: string | null | undefined) {
  const compacted = value
    ?.replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[`*_>#~-]+/g, "")
    .replace(/\s+/g, " ")
    .trim() ?? "";
  return compactText(compacted, 260);
}

function basename(path: string | null | undefined) {
  const parts = path?.split("/").filter(Boolean) ?? [];
  return parts.at(-1) ?? path ?? "Library item";
}

function shortId(value: string | null | undefined) {
  if (!value) return null;
  return value.length > 8 ? value.slice(0, 8) : value;
}

async function readAgentPreviewRef(agentId: string | null | undefined, orgId: string): Promise<AgentPreviewRef | null> {
  if (!agentId) return null;
  try {
    const agent = await agentsApi.get(agentId, orgId);
    return { name: agent.name, icon: agent.icon, role: agent.role };
  } catch {
    return { name: `agent ${shortId(agentId)}`, icon: null, role: null };
  }
}

async function buildIssueCommentPreview(
  mention: Extract<PreviewableMention, { kind: "issue" }>,
): Promise<EntityPreview> {
  const comment = await issuesApi.getComment(mention.issueId, mention.commentId!);
  const issueLabel = mention.ref ?? "Issue";

  return {
    kind: "issue_comment",
    eyebrow: `${issueLabel} comment`,
    title: "Comment",
    rows: [],
    summary: commentBodyPreview(comment.body) ?? "No comment body.",
  };
}

async function buildIssuePreview(mention: Extract<PreviewableMention, { kind: "issue" }>, orgId: string): Promise<EntityPreview> {
  if (mention.commentId) return buildIssueCommentPreview(mention);

  const issue = await issuesApi.get(mention.issueId);
  const embeddedProject = issue.project as (Partial<Project> & { name?: string | null }) | null | undefined;
  const [assignee, reviewer, project] = await Promise.all([
    readAgentPreviewRef(issue.assigneeAgentId, orgId),
    readAgentPreviewRef(issue.reviewerAgentId, orgId),
    embeddedProject?.color || embeddedProject?.icon
      ? Promise.resolve(embeddedProject)
      : issue.projectId && !embeddedProject?.name
      ? projectsApi.get(issue.projectId, orgId).catch(() => null)
      : Promise.resolve(null),
  ]);
  const projectName = embeddedProject?.name ?? project?.name ?? null;
  const projectIconSource = project ?? embeddedProject ?? null;

  const issueLabel = issue.identifier ?? mention.ref ?? "Issue";
  return {
    kind: "issue",
    eyebrow: issueLabel,
    title: issue.title,
    status: issue.status,
    rows: [
      { label: "Status", value: formatHumanLabel(issue.status), issueStatus: issue.status },
      { label: "Priority", value: formatPriorityLabel(issue.priority), priority: issue.priority },
      { label: "Project", value: projectName, project: projectName ? { color: projectIconSource?.color ?? null, icon: projectIconSource?.icon ?? null } : undefined },
      { label: "Assignee", value: assignee?.name, agent: assignee ? { icon: assignee.icon, role: assignee.role } : undefined },
      { label: "Reviewer", value: reviewer?.name, agent: reviewer ? { icon: reviewer.icon, role: reviewer.role } : undefined },
    ],
    summary: firstMarkdownParagraph(issue.description),
  };
}

function buildAgentPreview(agent: AgentDetail): EntityPreview {
  return {
    kind: "agent",
    eyebrow: "Agent",
    title: agent.name,
    subtitle: agent.title ?? formatHumanLabel(agent.role),
    status: formatHumanLabel(agent.status) ?? agent.status,
    icon: agent.icon,
    role: agent.role,
    summary: compactText(agent.capabilities),
  };
}

function buildProjectPreview(project: Project): EntityPreview {
  const goalSummary = project.goals.length > 0
    ? project.goals.map((goal) => goal.title).slice(0, 2).join(", ")
    : null;
  const context = project.primaryWorkspace?.cwd
    ?? project.codebase.repoName
    ?? project.codebase.repoUrl
    ?? project.codebase.effectiveLocalFolder
    ?? null;

  return {
    kind: "project",
    eyebrow: "Project",
    title: project.name,
    color: project.color,
    icon: project.icon,
    rows: [
      { label: "Status", value: formatHumanLabel(project.status) },
      { label: "Goal", value: goalSummary },
      { label: "Context", value: context },
    ],
    summary: firstMarkdownParagraph(project.description),
  };
}

function workspaceFileSummary(file: OrganizationWorkspaceFileDetail) {
  if (file.previewKind === "text") {
    return firstMarkdownParagraph(file.content) ?? (file.truncated ? "Text preview is truncated." : null);
  }
  if (file.previewKind === "image") return "Image file.";
  return file.message ?? "Preview is not available for this file type.";
}

function buildLibraryDocumentPreview(document: LibraryDocument): EntityPreview {
  return {
    kind: "library",
    eyebrow: "Library document",
    title: document.title ?? "Untitled document",
    icon: "file",
    rows: [
      { label: "Revision", value: String(document.latestRevisionNumber) },
      { label: "Format", value: formatHumanLabel(document.format) },
    ],
    summary: firstMarkdownParagraph(document.body),
  };
}

function buildWorkspaceFilePreview(file: OrganizationWorkspaceFileDetail, title?: string | null): EntityPreview {
  return {
    kind: "library",
    eyebrow: file.previewKind === "text" ? "Library file" : "Library asset",
    title: title ?? basename(file.filePath),
    icon: "file",
    rows: [
      { label: "Path", value: file.filePath },
      { label: "Type", value: file.contentType },
    ],
    summary: workspaceFileSummary(file),
  };
}

async function loadPreview(mention: PreviewableMention, label: string, orgId: string): Promise<EntityPreview> {
  if (mention.kind === "issue") return buildIssuePreview(mention, orgId);
  if (mention.kind === "agent") return buildAgentPreview(await agentsApi.get(mention.agentId, orgId));
  if (mention.kind === "project") return buildProjectPreview(await projectsApi.get(mention.projectId, orgId));
  if (mention.kind === "library_doc") {
    return buildLibraryDocumentPreview(await organizationsApi.getLibraryDocument(orgId, mention.documentId));
  }
  if (mention.kind === "library_entry") {
    const entry = await organizationsApi.getLibraryEntry(orgId, mention.entryId);
    if (entry.status !== "active" || !entry.currentPath) {
      return {
        kind: "library",
        eyebrow: "Library file",
        title: entry.title || label,
        icon: "file",
        rows: [
          { label: "Path", value: entry.currentPath ?? mention.path },
          { label: "Status", value: formatHumanLabel(entry.status) },
        ],
        summary: "This Library reference is not currently readable.",
      };
    }
    return buildWorkspaceFilePreview(await organizationsApi.readWorkspaceFile(orgId, entry.currentPath), entry.title);
  }
  if (mention.kind === "library_file") {
    return buildWorkspaceFilePreview(await organizationsApi.readWorkspaceFile(orgId, mention.filePath), mention.title);
  }
  return {
    kind: "library",
    eyebrow: "Library folder",
    title: mention.title ?? basename(mention.directoryPath),
    icon: "folder",
    rows: [{ label: "Path", value: mention.directoryPath }],
    summary: "Open the folder to inspect its files.",
  };
}

function PreviewRowIcon({ row }: { row: PreviewRow }) {
  if (row.issueStatus) {
    return (
      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
        <StatusIcon status={row.issueStatus} className="size-3.5" />
      </span>
    );
  }
  if (row.priority) {
    return (
      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
        <PriorityIcon priority={row.priority} className="h-3.5 w-4" />
      </span>
    );
  }
  if (row.agent) {
    return (
      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
        <AgentIcon
          icon={row.agent.icon}
          role={row.agent.role}
          fallbackSeed={row.value}
          className="size-4 rounded-full"
        />
      </span>
    );
  }
  if (row.project) {
    return (
      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
        <ProjectIcon color={row.project.color} icon={row.project.icon} size="xs" />
      </span>
    );
  }
  return null;
}

function PreviewRows({ rows }: { rows: PreviewRow[] }) {
  const visibleRows = rows.filter((row) => row.value);
  if (visibleRows.length === 0) return null;
  return (
    <span className="rudder-entity-preview-rows">
      {visibleRows.map((row) => (
        <span key={row.label} className="rudder-entity-preview-row">
          <span className="rudder-entity-preview-row-label">{row.label}</span>
          <span className="rudder-entity-preview-row-value">
            <PreviewRowIcon row={row} />
            <span className="min-w-0 truncate">{row.value}</span>
          </span>
        </span>
      ))}
    </span>
  );
}

function PreviewIcon({ preview }: { preview: EntityPreview }) {
  if (preview.kind === "agent") {
    return (
      <AgentIcon
        icon={preview.icon}
        role={preview.role}
        fallbackSeed={preview.title}
        className="rudder-entity-preview-main-icon rudder-entity-preview-main-icon--agent"
      />
    );
  }
  if (preview.kind === "issue") {
    return <StatusIcon status={preview.status} className="rudder-entity-preview-main-icon" />;
  }
  if (preview.kind === "issue_comment") {
    return (
      <span className="rudder-entity-preview-main-icon rudder-entity-preview-main-icon--comment" data-slot="issue-comment-preview-icon">
        <MessageSquareText className="size-4" aria-hidden="true" />
      </span>
    );
  }
  if (preview.kind === "project") {
    return (
      <ProjectIcon
        color={preview.color}
        icon={preview.icon}
        size="sm"
        className="rudder-entity-preview-main-icon--project"
      />
    );
  }
  const LibraryIcon = preview.icon === "folder" ? Folder : FileText;
  return (
    <span className="rudder-entity-preview-main-icon rudder-entity-preview-main-icon--library">
      <LibraryIcon className="size-4" aria-hidden="true" />
    </span>
  );
}

function PreviewHeader({ preview }: { preview: EntityPreview }) {
  return (
    <span className="rudder-entity-preview-head">
      <PreviewIcon preview={preview} />
      <span className="min-w-0">
        <span className="rudder-entity-preview-eyebrow">{preview.eyebrow}</span>
        <span className="rudder-entity-preview-title">{preview.title}</span>
        {preview.kind === "agent" && preview.subtitle ? (
          <span className="rudder-entity-preview-subtitle">{preview.subtitle}</span>
        ) : null}
      </span>
    </span>
  );
}

function PreviewContent({ preview }: { preview: EntityPreview }) {
  if (preview.kind === "agent") {
    return (
      <>
        <PreviewHeader preview={preview} />
        <PreviewRows rows={[{ label: "Status", value: preview.status }]} />
        {preview.summary ? <span className="rudder-entity-preview-summary">{preview.summary}</span> : null}
      </>
    );
  }

  return (
    <>
      <PreviewHeader preview={preview} />
      <PreviewRows rows={preview.rows} />
      {preview.summary ? <span className="rudder-entity-preview-summary">{preview.summary}</span> : null}
    </>
  );
}

export function RudderEntityPreview({ mention, label, children }: RudderEntityPreviewProps) {
  const [activated, setActivated] = useState(false);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<PreviewState>({ status: "idle" });
  const loadStartedRef = useRef(false);
  const orgId = useMemo(readSelectedOrgId, []);

  useEffect(() => {
    if (!activated || loadStartedRef.current) return;
    loadStartedRef.current = true;
    if (!orgId) {
      setState({ status: "error", message: "Preview unavailable outside an organization." });
      return;
    }

    let cancelled = false;
    setState({ status: "loading" });
    void loadPreview(mention, label, orgId)
      .then((preview) => {
        if (!cancelled) setState({ status: "ready", preview });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error", message: "Preview unavailable." });
      });

    return () => {
      cancelled = true;
    };
  }, [activated, label, mention, orgId]);

  const showPreview = () => {
    setActivated(true);
    setOpen(true);
  };

  return (
    <TooltipProvider delayDuration={120}>
      <Tooltip open={open} onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) setActivated(true);
      }}>
        <TooltipTrigger asChild>
          <span
            className="rudder-entity-preview-wrap"
            onMouseEnter={showPreview}
            onMouseLeave={() => setOpen(false)}
            onFocusCapture={showPreview}
            onBlurCapture={() => setOpen(false)}
          >
            {children}
          </span>
        </TooltipTrigger>
        {activated ? (
          <TooltipContent
            side="bottom"
            align="center"
            sideOffset={8}
            collisionPadding={16}
            className={cn("rudder-entity-preview-card motion-entity-preview-pop", state.status === "loading" && "rudder-entity-preview-card--loading")}
          >
            {state.status === "ready" ? (
              <PreviewContent preview={state.preview} />
            ) : state.status === "error" ? (
              <>
                <span className="rudder-entity-preview-eyebrow">{label}</span>
                <span className="rudder-entity-preview-empty">{state.message}</span>
              </>
            ) : (
              <>
                <FileText className="size-3.5" aria-hidden="true" />
                <span>Loading preview...</span>
              </>
            )}
          </TooltipContent>
        ) : null}
      </Tooltip>
    </TooltipProvider>
  );
}
