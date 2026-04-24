import { useEffect, useMemo, useState, type MouseEvent, type SVGProps } from "react";
import { Link, useNavigate, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  OrganizationSkill,
  OrganizationSkillCreateRequest,
  OrganizationSkillLocalScanResult,
  OrganizationSkillDetail,
  OrganizationSkillFileDetail,
  OrganizationSkillListItem,
  OrganizationSkillSourceBadge,
  OrganizationSkillUpdateStatus,
} from "@rudderhq/shared";
import { organizationSkillsApi } from "../api/organizationSkills";
import { useOrganization } from "../context/OrganizationContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { MarkdownBody } from "../components/MarkdownBody";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { PackageFileTree, buildFileTree } from "../components/PackageFileTree";
import { PageSkeleton } from "../components/PageSkeleton";
import { RudderLogo } from "../components/RudderLogo";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "../lib/utils";
import { readDesktopShell } from "../lib/desktop-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Boxes,
  ChevronRight,
  Code2,
  Eye,
  Folder,
  Github,
  Link2,
  ExternalLink,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";

const OFFICE_HOURS_SKILL_PATH = "/Users/zeeland/.codex/skills/office-hours/SKILL.md";

type SkillImportBatchResult = {
  imported: OrganizationSkill[];
  warnings: string[];
  errors: string[];
  sourceCount: number;
};

function VercelMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 4 21 19H3z" />
    </svg>
  );
}

function stripFrontmatter(markdown: string) {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized.trim();
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) return normalized.trim();
  return normalized.slice(closing + 5).trim();
}

function splitFrontmatter(markdown: string): { frontmatter: string | null; body: string } {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: null, body: normalized };
  }
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) {
    return { frontmatter: null, body: normalized };
  }
  return {
    frontmatter: normalized.slice(4, closing).trim(),
    body: normalized.slice(closing + 5).trimStart(),
  };
}

function mergeFrontmatter(markdown: string, body: string) {
  const parsed = splitFrontmatter(markdown);
  if (!parsed.frontmatter) return body;
  return ["---", parsed.frontmatter, "---", "", body].join("\n");
}

function sourceMeta(sourceBadge: OrganizationSkillSourceBadge, sourceLabel: string | null) {
  const normalizedLabel = sourceLabel?.toLowerCase() ?? "";
  const isSkillsShManaged =
    normalizedLabel.includes("skills.sh") || normalizedLabel.includes("vercel-labs/skills");

  switch (sourceBadge) {
    case "skills_sh":
      return { icon: VercelMark, label: sourceLabel ?? "skills.sh", managedLabel: "skills.sh managed" };
    case "community":
      return { icon: Sparkles, label: sourceLabel ?? "Community preset", managedLabel: "Community preset" };
    case "github":
      return isSkillsShManaged
        ? { icon: VercelMark, label: sourceLabel ?? "skills.sh", managedLabel: "skills.sh managed" }
        : { icon: Github, label: sourceLabel ?? "GitHub", managedLabel: "GitHub managed" };
    case "url":
      return { icon: Link2, label: sourceLabel ?? "URL", managedLabel: "URL managed" };
    case "local":
      return { icon: Folder, label: sourceLabel ?? "Folder", managedLabel: "Folder managed" };
    case "rudder":
      return { icon: RudderLogo, label: sourceLabel ?? "Bundled by Rudder", managedLabel: "Bundled by Rudder" };
    default:
      return { icon: Boxes, label: sourceLabel ?? "Catalog", managedLabel: "Catalog managed" };
  }
}

function shortRef(ref: string | null | undefined) {
  if (!ref) return null;
  return ref.slice(0, 7);
}

function formatLocalScanSummary(result: OrganizationSkillLocalScanResult) {
  const parts = [
    `${result.discovered} found`,
    `${result.imported.length} imported`,
    `${result.updated.length} updated`,
  ];
  if (result.conflicts.length > 0) parts.push(`${result.conflicts.length} conflicts`);
  if (result.skipped.length > 0) parts.push(`${result.skipped.length} skipped`);
  return `${parts.join(", ")} across ${result.scannedRoots} local root${result.scannedRoots === 1 ? "" : "s"}.`;
}

function parseSkillImportSources(value: string) {
  return Array.from(
    new Set(
      value
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

function openDesktopExternalLink(event: MouseEvent<HTMLAnchorElement>, target: string) {
  const desktopShell = readDesktopShell();
  if (!desktopShell) return;
  event.preventDefault();
  void desktopShell.openExternal(target);
}

function encodeSkillFilePath(filePath: string) {
  return filePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function decodeSkillFilePath(filePath: string | undefined) {
  if (!filePath) return "SKILL.md";
  return filePath
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

function parseSkillRoute(routePath: string | undefined) {
  const segments = (routePath ?? "").split("/").filter(Boolean);
  if (segments.length === 0) {
    return { skillId: null, filePath: "SKILL.md" };
  }

  const [rawSkillId, rawMode, ...rest] = segments;
  const skillId = rawSkillId ? decodeURIComponent(rawSkillId) : null;
  if (!skillId) {
    return { skillId: null, filePath: "SKILL.md" };
  }

  if (rawMode === "files") {
    return {
      skillId,
      filePath: decodeSkillFilePath(rest.join("/")),
    };
  }

  return { skillId, filePath: "SKILL.md" };
}

function skillRoute(skillId: string, filePath?: string | null) {
  return filePath ? `/skills/${skillId}/files/${encodeSkillFilePath(filePath)}` : `/skills/${skillId}`;
}

function parentDirectoryPaths(filePath: string) {
  const segments = filePath.split("/").filter(Boolean);
  const parents: string[] = [];
  for (let index = 0; index < segments.length - 1; index += 1) {
    parents.push(segments.slice(0, index + 1).join("/"));
  }
  return parents;
}

function AddSkillDialog({
  open,
  onOpenChange,
  onCreate,
  chatHref,
  source,
  sourceCount,
  onSourceChange,
  onAddSource,
  onResetSource,
  importPending,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (payload: OrganizationSkillCreateRequest) => void;
  chatHref: string;
  source: string;
  sourceCount: number;
  onSourceChange: (value: string) => void;
  onAddSource: () => void;
  onResetSource: () => void;
  importPending: boolean;
  isPending: boolean;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (!open) {
      setName("");
      setSlug("");
      setDescription("");
      onResetSource();
    }
  }, [onResetSource, open]);

  function handleCreate() {
    onCreate({ name, slug: slug || null, description: description || null });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add skill</DialogTitle>
          <DialogDescription>
            Create a local skill, import one or many existing skills, or jump into chat with a prefilled skill-design brief.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
            <div className="space-y-3 rounded-[var(--radius-lg)] border border-border/70 bg-muted/10 p-4">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-border/70 bg-background">
                  <Sparkles className="h-4 w-4 text-foreground" />
                </div>
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium text-foreground">Create with chat</p>
                  <p className="text-sm leading-6 text-muted-foreground">
                    Open Chat with a prefilled prompt that references `[$office-hours]` and asks for a complete `SKILL.md`.
                  </p>
                </div>
              </div>
              <Button asChild variant="outline" size="sm" className="gap-2">
                <Link to={chatHref}>
                  <Sparkles className="h-4 w-4" />
                  <span>Open chat</span>
                </Link>
              </Button>
            </div>

            <div className="space-y-3 rounded-[var(--radius-lg)] border border-border/70 bg-muted/10 p-4">
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">Import existing skills</p>
                <p className="text-sm leading-6 text-muted-foreground">
                  Paste one source per line. Rudder will import every local path, GitHub URL, or `skills.sh` command you provide.
                </p>
              </div>

              <Textarea
                value={source}
                onChange={(event) => onSourceChange(event.target.value)}
                placeholder={[
                  "/Users/you/project/.agents/skills/design-review",
                  "https://github.com/example/repo/tree/main/.agents/skills/release",
                  "uvx --from https://skills.sh paperclipai/office-hours",
                ].join("\n")}
                className="min-h-28 resize-none"
              />

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
                  <a
                    href="https://skills.sh"
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => openDesktopExternalLink(event, "https://skills.sh")}
                    className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
                  >
                    <span>Browse skills.sh</span>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                  <a
                    href="https://github.com/search?q=SKILL.md&type=code"
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => openDesktopExternalLink(event, "https://github.com/search?q=SKILL.md&type=code")}
                    className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
                  >
                    <span>Search GitHub</span>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>

                <Button
                  size="sm"
                  onClick={onAddSource}
                  disabled={importPending || sourceCount === 0}
                >
                  {importPending ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : sourceCount > 1 ? (
                    `Import ${sourceCount} sources`
                  ) : (
                    "Import skill"
                  )}
                </Button>
              </div>
            </div>
          </div>

          <div className="space-y-4 border-t border-border/70 pt-5">
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">Create local skill</p>
              <p className="text-sm leading-6 text-muted-foreground">
                Add a local skill to this Rudder organization, then edit its `SKILL.md` directly in the detail pane.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label htmlFor="create-skill-name" className="text-sm font-medium text-foreground">
                  Name
                </label>
                <Input
                  id="create-skill-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Skill name"
                  autoFocus
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="create-skill-slug" className="text-sm font-medium text-foreground">
                  Short name
                </label>
                <Input
                  id="create-skill-slug"
                  value={slug}
                  onChange={(event) => setSlug(event.target.value)}
                  placeholder="optional-shortname"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="create-skill-description" className="text-sm font-medium text-foreground">
                Description
              </label>
              <Textarea
                id="create-skill-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Short description"
                className="min-h-24"
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={isPending || name.trim().length === 0}
          >
            {isPending ? "Creating..." : "Create skill"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SkillList({
  skills,
  selectedSkillId,
  skillFilter,
  onSelectSkill,
}: {
  skills: OrganizationSkillListItem[];
  selectedSkillId: string | null;
  skillFilter: string;
  onSelectSkill: (skillId: string) => void;
}) {
  const filteredSkills = skills.filter((skill) => {
    const haystack = `${skill.name} ${skill.description ?? ""} ${skill.key} ${skill.slug} ${skill.sourceLabel ?? ""}`.toLowerCase();
    return haystack.includes(skillFilter.toLowerCase());
  });

  if (filteredSkills.length === 0) {
    return (
      <div className="px-4 py-6 text-sm text-muted-foreground">
        No skills match this filter.
      </div>
    );
  }

  return (
    <div className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto">
      {filteredSkills.map((skill) => {
        const source = sourceMeta(skill.sourceBadge, skill.sourceLabel);
        const SourceIcon = source.icon;
        const summary = stripFrontmatter(skill.description ?? "").replace(/\s+/g, " ").trim();

        return (
          <Link
            key={skill.id}
            to={skillRoute(skill.id)}
            onClick={() => onSelectSkill(skill.id)}
            className={cn(
              "block border-b border-border px-3 py-2.5 no-underline transition-colors hover:bg-accent/30",
              skill.id === selectedSkillId && "bg-accent/20",
            )}
          >
            <div
              className={cn(
                "flex items-start gap-3",
              )}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40 text-muted-foreground">
                    <SourceIcon className="h-3.5 w-3.5" />
                    <span className="sr-only">{source.managedLabel}</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">{source.managedLabel}</TooltipContent>
              </Tooltip>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 truncate text-sm font-medium text-foreground">{skill.name}</span>
                  <span className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {skill.sourceLabel ?? source.label}
                  </span>
                </div>
                {summary ? (
                  <p className="mt-1 line-clamp-1 text-xs leading-5 text-muted-foreground">{summary}</p>
                ) : null}
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <span>{skill.fileInventory.length} files</span>
                  <span>·</span>
                  <span>{skill.attachedAgentCount} attached</span>
                </div>
              </div>
              <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            </div>
          </Link>
        );
      })}
    </div>
  );
}

function SkillPane({
  loading,
  detail,
  file,
  treeNodes,
  selectedPath,
  expandedDirs,
  fileLoading,
  updateStatus,
  updateStatusLoading,
  viewMode,
  editMode,
  draft,
  setViewMode,
  setEditMode,
  setDraft,
  onCheckUpdates,
  checkUpdatesPending,
  onInstallUpdate,
  installUpdatePending,
  onRequestDelete,
  deletePending,
  onSave,
  savePending,
  onToggleDir,
  onSelectPath,
}: {
  loading: boolean;
  detail: OrganizationSkillDetail | null | undefined;
  file: OrganizationSkillFileDetail | null | undefined;
  treeNodes: ReturnType<typeof buildFileTree>;
  selectedPath: string;
  expandedDirs: Set<string>;
  fileLoading: boolean;
  updateStatus: OrganizationSkillUpdateStatus | null | undefined;
  updateStatusLoading: boolean;
  viewMode: "preview" | "code";
  editMode: boolean;
  draft: string;
  setViewMode: (mode: "preview" | "code") => void;
  setEditMode: (value: boolean) => void;
  setDraft: (value: string) => void;
  onCheckUpdates: () => void;
  checkUpdatesPending: boolean;
  onInstallUpdate: () => void;
  installUpdatePending: boolean;
  onRequestDelete: () => void;
  deletePending: boolean;
  onSave: () => void;
  savePending: boolean;
  onToggleDir: (path: string) => void;
  onSelectPath: (path: string) => void;
}) {
  const { pushToast } = useToast();

  if (!detail) {
    if (loading) {
      return <PageSkeleton variant="detail" />;
    }
    return (
      <EmptyState
        icon={Boxes}
        message="Select a skill to inspect its files."
      />
    );
  }

  const source = sourceMeta(detail.sourceBadge, detail.sourceLabel);
  const SourceIcon = source.icon;
  const usedBy = detail.usedByAgents;
  const body = file?.markdown ? stripFrontmatter(file.content) : file?.content ?? "";
  const currentPin = shortRef(detail.sourceRef);
  const latestPin = shortRef(updateStatus?.latestRef);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 truncate text-2xl font-semibold">
              <SourceIcon className="h-5 w-5 shrink-0 text-muted-foreground" />
              {detail.name}
            </h1>
            {detail.description && (
              <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{detail.description}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {detail.editable ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={onRequestDelete}
                  disabled={deletePending}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {deletePending ? "Deleting..." : "Delete"}
                </Button>
                <button
                  className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
                  onClick={() => setEditMode(!editMode)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  {editMode ? "Stop editing" : "Edit"}
                </button>
              </>
            ) : (
              <div className="text-sm text-muted-foreground">{detail.editableReason}</div>
            )}
          </div>
        </div>

        <div className="mt-4 space-y-3 border-t border-border pt-4 text-sm">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Source</span>
              <span className="flex items-center gap-2">
                <SourceIcon className="h-3.5 w-3.5 text-muted-foreground" />
                {detail.sourcePath ? (
                  <button
                    className="truncate hover:text-foreground text-muted-foreground transition-colors cursor-pointer"
                    onClick={() => {
                      navigator.clipboard.writeText(detail.sourcePath!);
                      pushToast({ title: "Copied path to organization" });
                    }}
                  >
                    {source.label}
                  </button>
                ) : (
                  <span className="truncate">{source.label}</span>
                )}
              </span>
            </div>
            {detail.sourceType === "github" && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Pin</span>
                <span className="font-mono text-xs">{currentPin ?? "untracked"}</span>
                {updateStatus?.trackingRef && (
                  <span className="text-xs text-muted-foreground">tracking {updateStatus.trackingRef}</span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onCheckUpdates}
                  disabled={checkUpdatesPending || updateStatusLoading}
                >
                  <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", (checkUpdatesPending || updateStatusLoading) && "animate-spin")} />
                  Check for updates
                </Button>
                {updateStatus?.supported && updateStatus.hasUpdate && (
                  <Button
                    size="sm"
                    onClick={onInstallUpdate}
                    disabled={installUpdatePending}
                  >
                    <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", installUpdatePending && "animate-spin")} />
                    Install update{latestPin ? ` ${latestPin}` : ""}
                  </Button>
                )}
                {updateStatus?.supported && !updateStatus.hasUpdate && !updateStatusLoading && (
                  <span className="text-xs text-muted-foreground">Up to date</span>
                )}
                {!updateStatus?.supported && updateStatus?.reason && (
                  <span className="text-xs text-muted-foreground">{updateStatus.reason}</span>
                )}
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Key</span>
              <span className="font-mono text-xs">{detail.key}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Mode</span>
              <span>{detail.editable ? "Editable" : "Read only"}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
            <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Used by</span>
            {usedBy.length === 0 ? (
              <span className="text-muted-foreground">No agents attached</span>
            ) : (
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {usedBy.map((agent) => (
                  <Link
                    key={agent.id}
                    to={`/agents/${agent.urlKey}/skills`}
                    className="text-foreground no-underline hover:underline"
                  >
                    {agent.name}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="shrink-0 border-b border-border px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate font-mono text-sm">{file?.path ?? "SKILL.md"}</div>
          </div>
          <div className="flex items-center gap-2">
            {file?.markdown && !editMode && (
              <div className="flex items-center border border-border">
                <button
                  className={cn("px-3 py-1.5 text-sm", viewMode === "preview" && "text-foreground", viewMode !== "preview" && "text-muted-foreground")}
                  onClick={() => setViewMode("preview")}
                >
                  <span className="flex items-center gap-1.5">
                    <Eye className="h-3.5 w-3.5" />
                    View
                  </span>
                </button>
                <button
                  className={cn("border-l border-border px-3 py-1.5 text-sm", viewMode === "code" && "text-foreground", viewMode !== "code" && "text-muted-foreground")}
                  onClick={() => setViewMode("code")}
                >
                  <span className="flex items-center gap-1.5">
                    <Code2 className="h-3.5 w-3.5" />
                    Code
                  </span>
                </button>
              </div>
            )}
            {editMode && file?.editable && (
              <>
                <Button variant="ghost" size="sm" onClick={() => setEditMode(false)} disabled={savePending}>
                  Cancel
                </Button>
                <Button size="sm" onClick={onSave} disabled={savePending}>
                  <Save className="mr-1.5 h-3.5 w-3.5" />
                  {savePending ? "Saving..." : "Save"}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-b border-border px-2 py-3 lg:border-b-0 lg:border-r">
          <div className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Files
          </div>
          <div className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto">
            {treeNodes.length === 0 ? (
              <div className="px-3 py-3 text-sm text-muted-foreground">No files available.</div>
            ) : (
              <PackageFileTree
                nodes={treeNodes}
                selectedFile={selectedPath}
                expandedDirs={expandedDirs}
                onToggleDir={onToggleDir}
                onSelectFile={onSelectPath}
                showCheckboxes={false}
              />
            )}
          </div>
        </aside>

        <div className="scrollbar-auto-hide min-h-0 min-w-0 overflow-y-auto px-5 py-5">
          {fileLoading ? (
            <PageSkeleton variant="detail" />
          ) : !file ? (
            <div className="text-sm text-muted-foreground">Select a file to inspect.</div>
          ) : editMode && file.editable ? (
            file.markdown ? (
              <MarkdownEditor
                value={draft}
                onChange={setDraft}
                bordered={false}
                className="min-h-[520px]"
              />
            ) : (
              <Textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="min-h-[520px] rounded-none border-0 bg-transparent px-0 py-0 font-mono text-sm shadow-none focus-visible:ring-0"
              />
            )
          ) : file.markdown && viewMode === "preview" ? (
            <MarkdownBody>{body}</MarkdownBody>
          ) : (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words border-0 bg-transparent p-0 font-mono text-sm text-foreground">
              <code>{file.content}</code>
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

export function OrganizationSkills() {
  const { t } = useI18n();
  const { "*": routePath } = useParams<{ "*": string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedOrganizationId } = useOrganization();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const [skillFilter, setSkillFilter] = useState("");
  const [source, setSource] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDeleteSkill, setPendingDeleteSkill] = useState<OrganizationSkillDetail | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, Set<string>>>({});
  const [viewMode, setViewMode] = useState<"preview" | "code">("preview");
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState("");
  const [displayedDetail, setDisplayedDetail] = useState<OrganizationSkillDetail | null>(null);
  const [displayedFile, setDisplayedFile] = useState<OrganizationSkillFileDetail | null>(null);
  const [scanStatusMessage, setScanStatusMessage] = useState<string | null>(null);
  const parsedRoute = useMemo(() => parseSkillRoute(routePath), [routePath]);
  const routeSkillId = parsedRoute.skillId;
  const selectedPath = parsedRoute.filePath;

  useEffect(() => {
    setBreadcrumbs([
      { label: "Skills", href: "/skills" },
      ...(routeSkillId ? [{ label: "Detail" }] : []),
    ]);
  }, [routeSkillId, setBreadcrumbs]);

  const skillsQuery = useQuery({
    queryKey: queryKeys.organizationSkills.list(selectedOrganizationId ?? ""),
    queryFn: () => organizationSkillsApi.list(selectedOrganizationId!),
    enabled: Boolean(selectedOrganizationId),
  });

  const selectedSkillId = useMemo(() => {
    if (!routeSkillId) return skillsQuery.data?.[0]?.id ?? null;
    return routeSkillId;
  }, [routeSkillId, skillsQuery.data]);

  useEffect(() => {
    if (routeSkillId || !selectedSkillId) return;
    navigate(skillRoute(selectedSkillId), { replace: true });
  }, [navigate, routeSkillId, selectedSkillId]);

  const detailQuery = useQuery({
    queryKey: queryKeys.organizationSkills.detail(selectedOrganizationId ?? "", selectedSkillId ?? ""),
    queryFn: () => organizationSkillsApi.detail(selectedOrganizationId!, selectedSkillId!),
    enabled: Boolean(selectedOrganizationId && selectedSkillId),
  });

  const fileQuery = useQuery({
    queryKey: queryKeys.organizationSkills.file(selectedOrganizationId ?? "", selectedSkillId ?? "", selectedPath),
    queryFn: () => organizationSkillsApi.file(selectedOrganizationId!, selectedSkillId!, selectedPath),
    enabled: Boolean(selectedOrganizationId && selectedSkillId && selectedPath),
  });

  const updateStatusQuery = useQuery({
    queryKey: queryKeys.organizationSkills.updateStatus(selectedOrganizationId ?? "", selectedSkillId ?? ""),
    queryFn: () => organizationSkillsApi.updateStatus(selectedOrganizationId!, selectedSkillId!),
    enabled: Boolean(
      selectedOrganizationId
      && selectedSkillId
      && (detailQuery.data?.sourceType === "github" || displayedDetail?.sourceType === "github"),
    ),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!selectedSkillId || selectedPath === "SKILL.md") return;
    const parents = parentDirectoryPaths(selectedPath);
    if (parents.length === 0) return;
    setExpandedDirs((current) => {
      const next = new Set(current[selectedSkillId] ?? []);
      let changed = false;
      for (const parent of parents) {
        if (!next.has(parent)) {
          next.add(parent);
          changed = true;
        }
      }
      return changed ? { ...current, [selectedSkillId]: next } : current;
    });
  }, [selectedPath, selectedSkillId]);

  useEffect(() => {
    setEditMode(false);
  }, [selectedSkillId, selectedPath]);

  useEffect(() => {
    setDisplayedDetail(null);
  }, [selectedSkillId]);

  useEffect(() => {
    setDisplayedFile(null);
  }, [selectedSkillId, selectedPath]);

  useEffect(() => {
    if (detailQuery.data) {
      setDisplayedDetail(detailQuery.data);
    }
  }, [detailQuery.data]);

  useEffect(() => {
    if (fileQuery.data) {
      setDisplayedFile(fileQuery.data);
      setDraft(fileQuery.data.markdown ? splitFrontmatter(fileQuery.data.content).body : fileQuery.data.content);
    }
  }, [fileQuery.data]);

  useEffect(() => {
    if (selectedSkillId) return;
    setDisplayedDetail(null);
    setDisplayedFile(null);
  }, [selectedSkillId]);

  const activeDetail = detailQuery.data ?? displayedDetail;
  const activeFile = fileQuery.data ?? displayedFile;
  const detailTreeNodes = useMemo(
    () =>
      activeDetail
        ? buildFileTree(Object.fromEntries(activeDetail.fileInventory.map((entry) => [entry.path, true])))
        : [],
    [activeDetail],
  );
  const sourceCount = useMemo(() => parseSkillImportSources(source).length, [source]);
  const createWithChatHref = useMemo(
    () =>
      `/chat?prefill=${encodeURIComponent(
        t("organizationSkills.createSkillChatPrompt", { officeHoursPath: OFFICE_HOURS_SKILL_PATH }),
      )}`,
    [t],
  );

  const importSkill = useMutation({
    mutationFn: async (rawSource: string): Promise<SkillImportBatchResult> => {
      const importSources = parseSkillImportSources(rawSource);
      if (importSources.length === 0) {
        throw new Error("Paste at least one skill source.");
      }

      const imported: OrganizationSkill[] = [];
      const warnings: string[] = [];
      const errors: string[] = [];

      for (const importSource of importSources) {
        try {
          const result = await organizationSkillsApi.importFromSource(selectedOrganizationId!, importSource);
          imported.push(...result.imported);
          warnings.push(...result.warnings);
        } catch (error) {
          errors.push(
            error instanceof Error
              ? `${importSource}: ${error.message}`
              : `${importSource}: Failed to import skill source.`,
          );
        }
      }

      if (imported.length === 0 && errors.length > 0) {
        throw new Error(errors[0]);
      }

      return {
        imported,
        warnings,
        errors,
        sourceCount: importSources.length,
      };
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.organizationSkills.list(selectedOrganizationId!) });
      if (result.imported[0]) navigate(skillRoute(result.imported[0].id));
      setCreateOpen(false);
      pushToast({
        tone: "success",
        title: "Skills imported",
        body:
          result.sourceCount > 1
            ? `${result.imported.length} skill${result.imported.length === 1 ? "" : "s"} added from ${result.sourceCount} sources.`
            : `${result.imported.length} skill${result.imported.length === 1 ? "" : "s"} added.`,
      });
      if (result.warnings[0]) {
        pushToast({ tone: "warn", title: "Import warnings", body: result.warnings[0] });
      }
      if (result.errors[0]) {
        pushToast({ tone: "warn", title: "Some imports failed", body: result.errors[0] });
      }
      setSource("");
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Skill import failed",
        body: error instanceof Error ? error.message : "Failed to import skill source.",
      });
    },
  });

  const deleteSkill = useMutation({
    mutationFn: (skill: OrganizationSkillDetail) => organizationSkillsApi.delete(selectedOrganizationId!, skill.id),
    onSuccess: (skill, deletedSkill) => {
      const organizationId = selectedOrganizationId!;
      const deletedSkillQueryKey = queryKeys.organizationSkills.detail(organizationId, deletedSkill.id);

      setPendingDeleteSkill(null);
      setEditMode(false);

      queryClient.removeQueries({ queryKey: deletedSkillQueryKey });
      navigate("/skills");
      void queryClient.invalidateQueries({ queryKey: queryKeys.organizationSkills.list(organizationId) });
      pushToast({
        tone: "success",
        title: "Skill deleted",
        body: `${skill.name} was removed from this organization.`,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Delete failed",
        body: error instanceof Error ? error.message : "Failed to delete skill.",
      });
    },
  });

  const createSkill = useMutation({
    mutationFn: (payload: OrganizationSkillCreateRequest) => organizationSkillsApi.create(selectedOrganizationId!, payload),
    onSuccess: async (skill) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.organizationSkills.list(selectedOrganizationId!) });
      navigate(skillRoute(skill.id));
      setCreateOpen(false);
      pushToast({
        tone: "success",
        title: "Skill created",
        body: `${skill.name} is now editable in the Rudder organization.`,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Skill creation failed",
        body: error instanceof Error ? error.message : "Failed to create skill.",
      });
    },
  });

  const scanLocal = useMutation({
    mutationFn: () => organizationSkillsApi.scanLocal(selectedOrganizationId!),
    onMutate: () => {
      setScanStatusMessage("Scanning local skills for this organization...");
    },
    onSuccess: async (result) => {
      setScanStatusMessage("Refreshing skills list...");
      await queryClient.invalidateQueries({ queryKey: queryKeys.organizationSkills.list(selectedOrganizationId!) });
      const summary = formatLocalScanSummary(result);
      setScanStatusMessage(summary);
      pushToast({
        tone: "success",
        title: "Local skill scan complete",
        body: summary,
      });
      if (result.conflicts[0]) {
        pushToast({
          tone: "warn",
          title: "Skill conflicts found",
          body: result.conflicts[0].reason,
        });
      } else if (result.warnings[0]) {
        pushToast({
          tone: "warn",
          title: "Scan warnings",
          body: result.warnings[0],
        });
      }
    },
    onError: (error) => {
      setScanStatusMessage(null);
      pushToast({
        tone: "error",
        title: "Local skill scan failed",
        body: error instanceof Error ? error.message : "Failed to scan local skills.",
      });
    },
  });

  const saveFile = useMutation({
    mutationFn: () => organizationSkillsApi.updateFile(
      selectedOrganizationId!,
      selectedSkillId!,
      selectedPath,
      activeFile?.markdown ? mergeFrontmatter(activeFile.content, draft) : draft,
    ),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.organizationSkills.list(selectedOrganizationId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.organizationSkills.detail(selectedOrganizationId!, selectedSkillId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.organizationSkills.file(selectedOrganizationId!, selectedSkillId!, selectedPath) }),
      ]);
      setDraft(result.markdown ? splitFrontmatter(result.content).body : result.content);
      setEditMode(false);
      pushToast({
        tone: "success",
        title: "Skill saved",
        body: result.path,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Save failed",
        body: error instanceof Error ? error.message : "Failed to save skill file.",
      });
    },
  });

  const installUpdate = useMutation({
    mutationFn: () => organizationSkillsApi.installUpdate(selectedOrganizationId!, selectedSkillId!),
    onSuccess: async (skill) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.organizationSkills.list(selectedOrganizationId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.organizationSkills.detail(selectedOrganizationId!, selectedSkillId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.organizationSkills.updateStatus(selectedOrganizationId!, selectedSkillId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.organizationSkills.file(selectedOrganizationId!, selectedSkillId!, selectedPath) }),
      ]);
      navigate(skillRoute(skill.id, selectedPath));
      pushToast({
        tone: "success",
        title: "Skill updated",
        body: skill.sourceRef ? `Pinned to ${shortRef(skill.sourceRef)}` : skill.name,
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Update failed",
        body: error instanceof Error ? error.message : "Failed to install skill update.",
      });
    },
  });

  if (!selectedOrganizationId) {
    return <EmptyState icon={Boxes} message="Select an organization to manage skills." />;
  }

  function handleAddSkillSource() {
    if (sourceCount === 0) return;
    importSkill.mutate(source);
  }

  return (
    <>
      <AddSkillDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={(payload) => createSkill.mutate(payload)}
        chatHref={createWithChatHref}
        source={source}
        sourceCount={sourceCount}
        onSourceChange={setSource}
        onAddSource={handleAddSkillSource}
        onResetSource={() => setSource("")}
        importPending={importSkill.isPending}
        isPending={createSkill.isPending}
      />
      <Dialog open={pendingDeleteSkill !== null} onOpenChange={(open) => {
        if (!open) setPendingDeleteSkill(null);
      }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete skill</DialogTitle>
            <DialogDescription>
              Remove this skill from the organization and detach it from any agents that reference it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              {pendingDeleteSkill
                ? <><span className="font-medium text-foreground">{pendingDeleteSkill.name}</span> will be removed from Rudder. Source files on disk are not deleted.</>
                : "This skill will be removed from Rudder. Source files on disk are not deleted."}
            </p>
            {pendingDeleteSkill && pendingDeleteSkill.usedByAgents.length > 0 ? (
              <p>
                {pendingDeleteSkill.usedByAgents.length} attached agent{pendingDeleteSkill.usedByAgents.length === 1 ? "" : "s"} will lose this skill assignment.
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingDeleteSkill(null)} disabled={deleteSkill.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => pendingDeleteSkill && deleteSkill.mutate(pendingDeleteSkill)}
              disabled={deleteSkill.isPending || pendingDeleteSkill === null}
            >
              {deleteSkill.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="grid min-h-0 flex-1 gap-0 overflow-hidden xl:grid-cols-[19rem_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col border-r border-border overflow-hidden">
            <div className="shrink-0 border-b border-border px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h1 className="text-base font-semibold">Skills</h1>
                  <p className="text-xs text-muted-foreground">
                    {skillsQuery.data?.length ?? 0} available
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Bundled, community preset, and imported skills for this organization.
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => scanLocal.mutate()}
                    disabled={scanLocal.isPending}
                    title="Scan local skills"
                    aria-label="Scan local skills"
                  >
                    <RefreshCw className={cn("h-4 w-4", scanLocal.isPending && "animate-spin")} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setCreateOpen(true)}
                    title="Add skill"
                    aria-label="Add skill"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div className="mt-3 flex items-center gap-2 border-b border-border pb-2">
                <Search className="h-4 w-4 text-muted-foreground" />
                <input
                  value={skillFilter}
                  onChange={(event) => setSkillFilter(event.target.value)}
                  placeholder="Filter skills"
                  aria-label="Filter skills"
                  className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
              </div>

              {scanStatusMessage && (
                <p className="mt-3 text-xs text-muted-foreground">
                  {scanStatusMessage}
                </p>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
              {skillsQuery.isLoading ? (
                <div className="scrollbar-auto-hide h-full overflow-y-auto">
                  <PageSkeleton variant="list" />
                </div>
              ) : skillsQuery.error ? (
                <div className="scrollbar-auto-hide h-full overflow-y-auto px-4 py-6 text-sm text-destructive">
                  {skillsQuery.error.message}
                </div>
              ) : (
                <SkillList
                  skills={skillsQuery.data ?? []}
                  selectedSkillId={selectedSkillId}
                  skillFilter={skillFilter}
                  onSelectSkill={(currentSkillId) => navigate(skillRoute(currentSkillId))}
                />
              )}
            </div>
          </aside>

          <div className="min-h-0 min-w-0 overflow-hidden pl-6">
            <SkillPane
              loading={skillsQuery.isLoading || detailQuery.isLoading}
              detail={activeDetail}
              file={activeFile}
              treeNodes={detailTreeNodes}
              selectedPath={selectedPath}
              expandedDirs={selectedSkillId ? (expandedDirs[selectedSkillId] ?? new Set<string>()) : new Set<string>()}
              fileLoading={fileQuery.isLoading && !activeFile}
              updateStatus={updateStatusQuery.data}
              updateStatusLoading={updateStatusQuery.isLoading}
              viewMode={viewMode}
              editMode={editMode}
              draft={draft}
              setViewMode={setViewMode}
              setEditMode={setEditMode}
              setDraft={setDraft}
              onCheckUpdates={() => {
                void updateStatusQuery.refetch();
              }}
              checkUpdatesPending={updateStatusQuery.isFetching}
              onInstallUpdate={() => installUpdate.mutate()}
              installUpdatePending={installUpdate.isPending}
              onRequestDelete={() => {
                if (activeDetail) setPendingDeleteSkill(activeDetail);
              }}
              deletePending={deleteSkill.isPending}
              onSave={() => saveFile.mutate()}
              savePending={saveFile.isPending}
              onToggleDir={(path) => {
                if (!selectedSkillId) return;
                setExpandedDirs((current) => {
                  const next = new Set(current[selectedSkillId] ?? []);
                  if (next.has(path)) next.delete(path);
                  else next.add(path);
                  return { ...current, [selectedSkillId]: next };
                });
              }}
              onSelectPath={(path) => {
                if (!selectedSkillId) return;
                navigate(skillRoute(selectedSkillId, path));
              }}
            />
          </div>
        </div>
      </div>
    </>
  );
}
