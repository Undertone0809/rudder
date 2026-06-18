import type {
  Agent,
  AgentDetail,
  LibraryDocument,
  OrganizationWorkspaceFileDetail,
  Project,
} from "@rudderhq/shared";
import { FileText, Folder, MessageSquareText } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { organizationsApi } from "../api/orgs";
import { projectsApi } from "../api/projects";
import { useScrollbarActivityRef } from "../hooks/useScrollbarActivityRef";
import {
  __clearLibraryEntryMetadataCacheForTests,
  loadLibraryEntryMetadata,
  prefetchLibraryEntryMetadata,
  readSelectedOrganizationIdFromStorage,
} from "../lib/library-entry-cache";
import { normalizeRenderedMarkdownSource } from "../lib/markdown-normalize";
import { mentionChipNavigationPath, parseMentionChipHref, type ParsedMentionChip } from "../lib/mention-chips";
import { applyOrganizationPrefix, extractOrganizationPrefixFromPath } from "../lib/organization-routes";
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
      body: string | null;
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

const ENTITY_PREVIEW_CACHE_TTL_MS = 10 * 60 * 1000;
export const RUDDER_ENTITY_PREVIEW_HOVER_DELAY_MS = 1000;
const RUDDER_ENTITY_PREVIEW_CLOSE_DELAY_MS = 160;

type CachedPromise<T> = {
  expiresAt: number;
  promise: Promise<T>;
};

const entityPreviewCache = new Map<string, CachedPromise<EntityPreview>>();
const agentDetailCache = new Map<string, CachedPromise<AgentDetail>>();

export function __clearRudderEntityPreviewCachesForTests() {
  entityPreviewCache.clear();
  agentDetailCache.clear();
  __clearLibraryEntryMetadataCacheForTests();
}

function readSelectedOrgId() {
  return readSelectedOrganizationIdFromStorage();
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

function cachedPromise<T>(
  cache: Map<string, CachedPromise<T>>,
  key: string,
  loader: () => Promise<T>,
  ttlMs = ENTITY_PREVIEW_CACHE_TTL_MS,
) {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;

  const promise = loader().catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, { expiresAt: now + ttlMs, promise });
  return promise;
}

function getCachedAgentDetail(agentId: string, orgId: string) {
  return cachedPromise(
    agentDetailCache,
    `${orgId}:agent:${agentId}`,
    () => agentsApi.get(agentId, orgId),
  );
}

function entityPreviewCacheKey(mention: PreviewableMention, orgId: string) {
  if (mention.kind === "issue") {
    return `${orgId}:issue:${mention.issueId}:${mention.commentId ?? ""}`;
  }
  if (mention.kind === "agent") return `${orgId}:agent:${mention.agentId}`;
  if (mention.kind === "project") return `${orgId}:project:${mention.projectId}`;
  if (mention.kind === "library_doc") return `${orgId}:library_doc:${mention.documentId}`;
  if (mention.kind === "library_entry") return `${orgId}:library_entry:${mention.entryId}`;
  if (mention.kind === "library_file") return `${orgId}:library_file:${mention.filePath}`;
  return `${orgId}:library_directory:${mention.directoryPath}`;
}

async function readAgentPreviewRef(agentId: string | null | undefined, orgId: string): Promise<AgentPreviewRef | null> {
  if (!agentId) return null;
  try {
    const agent = await getCachedAgentDetail(agentId, orgId);
    return { name: agent.name, icon: agent.icon, role: agent.role };
  } catch {
    return { name: `agent ${shortId(agentId)}`, icon: null, role: null };
  }
}

async function buildIssueCommentPreview(
  mention: Extract<PreviewableMention, { kind: "issue" }>,
  orgId: string,
): Promise<EntityPreview> {
  const [comment, issue] = await Promise.all([
    issuesApi.getComment(mention.issueId, mention.commentId!),
    issuesApi.get(mention.issueId).catch(() => null),
  ]);
  const issueLabel = mention.ref ?? "Issue";
  const issueTitle = issue?.title?.trim() || issueLabel;
  const body = comment.body?.trim() || null;

  return {
    kind: "issue_comment",
    eyebrow: `${issueLabel} comment`,
    title: issueTitle,
    rows: [],
    summary: body ? null : "No comment body.",
    body,
  };
}

async function buildIssuePreview(mention: Extract<PreviewableMention, { kind: "issue" }>, orgId: string): Promise<EntityPreview> {
  if (mention.commentId) return buildIssueCommentPreview(mention, orgId);

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

function buildAgentFallbackPreview(
  mention: Extract<PreviewableMention, { kind: "agent" }>,
  label: string,
): EntityPreview {
  return {
    kind: "agent",
    eyebrow: "Agent",
    title: label.replace(/^@(?=\S)/, "") || `Agent ${shortId(mention.agentId) ?? ""}`.trim(),
    subtitle: null,
    status: "",
    icon: mention.icon,
    role: null,
    summary: null,
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
  if (file.previewKind === "pdf") return "PDF file.";
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

async function loadPreviewUncached(mention: PreviewableMention, label: string, orgId: string): Promise<EntityPreview> {
  if (mention.kind === "issue") return buildIssuePreview(mention, orgId);
  if (mention.kind === "agent") return buildAgentPreview(await getCachedAgentDetail(mention.agentId, orgId));
  if (mention.kind === "project") return buildProjectPreview(await projectsApi.get(mention.projectId, orgId));
  if (mention.kind === "library_doc") {
    return buildLibraryDocumentPreview(await organizationsApi.getLibraryDocument(orgId, mention.documentId));
  }
  if (mention.kind === "library_entry") {
    const entry = await loadLibraryEntryMetadata(orgId, mention.entryId);
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

function loadPreview(mention: PreviewableMention, label: string, orgId: string): Promise<EntityPreview> {
  return cachedPromise(
    entityPreviewCache,
    entityPreviewCacheKey(mention, orgId),
    () => loadPreviewUncached(mention, label, orgId),
  );
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
            <span className="rudder-entity-preview-row-value-text">{row.value}</span>
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

const previewMarkdownComponents: Components = {
  a: ({ node: _node, href, children, ...props }) => {
    const safeHref = previewSummaryLinkHref(href);
    if (!safeHref) return <span>{children}</span>;
    return (
      <a {...props} href={safeHref} target={safeHref.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
        {children}
      </a>
    );
  },
  img: ({ node: _node, src, alt, ...props }) => (
    <img {...props} src={src ?? ""} alt={alt ?? ""} loading="lazy" />
  ),
};

function currentOrganizationPrefixFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  return extractOrganizationPrefixFromPath(window.location.pathname);
}

function previewSummaryLinkHref(href: string | null | undefined) {
  const trimmed = href?.trim();
  if (!trimmed) return null;

  const mention = parseMentionChipHref(trimmed);
  if (mention) {
    return applyOrganizationPrefix(mentionChipNavigationPath(mention), currentOrganizationPrefixFromLocation());
  }

  if (trimmed.startsWith("/") || trimmed.startsWith("#")) return trimmed;
  if (!/^[a-z][a-z\d+.-]*:/iu.test(trimmed) && !trimmed.startsWith("//")) return trimmed;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return trimmed;
  } catch {
    return null;
  }

  return null;
}

function IssueCommentPreviewBody({ body }: { body: string }) {
  const scrollRef = useScrollbarActivityRef();
  const normalizedBody = normalizeRenderedMarkdownSource(body);
  return (
    <div
      ref={scrollRef}
      className="rudder-entity-preview-comment-body scrollbar-auto-hide"
      data-testid="issue-comment-preview-body"
    >
      <Markdown remarkPlugins={[remarkGfm]} components={previewMarkdownComponents} urlTransform={(url) => url}>
        {normalizedBody}
      </Markdown>
    </div>
  );
}

function PreviewSummary({ summary }: { summary: string }) {
  const scrollRef = useScrollbarActivityRef();
  const normalizedSummary = normalizeRenderedMarkdownSource(summary);
  return (
    <div ref={scrollRef} className="rudder-entity-preview-summary scrollbar-auto-hide">
      <Markdown remarkPlugins={[remarkGfm]} components={previewMarkdownComponents} urlTransform={(url) => url}>
        {normalizedSummary}
      </Markdown>
    </div>
  );
}

function PreviewContent({ preview }: { preview: EntityPreview }) {
  if (preview.kind === "agent") {
    return (
      <>
        <PreviewHeader preview={preview} />
        <PreviewRows rows={[{ label: "Status", value: preview.status }]} />
        {preview.summary ? <PreviewSummary summary={preview.summary} /> : null}
      </>
    );
  }

  if (preview.kind === "issue_comment") {
    return (
      <>
        <PreviewHeader preview={preview} />
        {preview.body ? <IssueCommentPreviewBody body={preview.body} /> : null}
        {preview.summary ? <PreviewSummary summary={preview.summary} /> : null}
      </>
    );
  }

  return (
    <>
      <PreviewHeader preview={preview} />
      <PreviewRows rows={preview.rows} />
      {preview.summary ? <PreviewSummary summary={preview.summary} /> : null}
    </>
  );
}

export function RudderEntityPreview({ mention, label, children }: RudderEntityPreviewProps) {
  const [activated, setActivated] = useState(false);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<PreviewState>({ status: "idle" });
  const loadStartedRef = useRef(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerWrapRef = useRef<HTMLSpanElement>(null);
  const orgId = useMemo(readSelectedOrgId, []);

  useEffect(() => {
    if (mention.kind !== "library_entry") return;
    prefetchLibraryEntryMetadata(orgId, mention.entryId);
  }, [mention, orgId]);

  const clearHoverTimer = () => {
    if (!hoverTimerRef.current) return;
    clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
  };

  const clearCloseTimer = () => {
    if (!closeTimerRef.current) return;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };

  useEffect(() => {
    if (!activated || loadStartedRef.current) return;
    loadStartedRef.current = true;
    if (!orgId) {
      setState({ status: "error", message: "Preview unavailable outside an organization." });
      return;
    }

    let cancelled = false;
    if (mention.kind === "agent") {
      setState({ status: "ready", preview: buildAgentFallbackPreview(mention, label) });
    } else {
      setState({ status: "loading" });
    }
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

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleMouseMove = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerWrapRef.current?.contains(target)) {
        clearCloseTimer();
        return;
      }
      const insidePreviewCard = Array.from(document.querySelectorAll(".rudder-entity-preview-card"))
        .some((card) => card.contains(target));
      if (insidePreviewCard) {
        clearCloseTimer();
        return;
      }
      hidePreview();
    };
    window.addEventListener("mousemove", handleMouseMove);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
    };
  }, [open]);

  const showPreview = () => {
    clearHoverTimer();
    clearCloseTimer();
    setActivated(true);
    setOpen(true);
  };

  const scheduleHoverPreview = () => {
    clearHoverTimer();
    clearCloseTimer();
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      showPreview();
    }, RUDDER_ENTITY_PREVIEW_HOVER_DELAY_MS);
  };

  const hidePreview = () => {
    clearHoverTimer();
    clearCloseTimer();
    if (!open) {
      setOpen(false);
      return;
    }
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
    }, RUDDER_ENTITY_PREVIEW_CLOSE_DELAY_MS);
  };

  const hidePreviewImmediately = () => {
    clearHoverTimer();
    clearCloseTimer();
    setOpen(false);
  };

  return (
    <TooltipProvider delayDuration={RUDDER_ENTITY_PREVIEW_HOVER_DELAY_MS} skipDelayDuration={0}>
      <Tooltip open={open} onOpenChange={(nextOpen) => {
        if (!nextOpen) clearHoverTimer();
        if (nextOpen) {
          showPreview();
        } else {
          hidePreview();
        }
      }}>
        <TooltipTrigger asChild>
          <span
            ref={triggerWrapRef}
            className="rudder-entity-preview-wrap"
            onMouseEnter={scheduleHoverPreview}
            onMouseLeave={hidePreview}
            onFocusCapture={showPreview}
            onBlurCapture={hidePreviewImmediately}
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
            onMouseEnter={showPreview}
            onMouseLeave={hidePreview}
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
