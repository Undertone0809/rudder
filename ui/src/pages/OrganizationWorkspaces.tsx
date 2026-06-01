import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  buildAgentMentionHref,
  parseAgentMentionHref,
  type OrganizationWorkspaceFileDetail,
  type OrganizationWorkspaceFileEntry,
} from "@rudderhq/shared";
import { useSearchParams } from "@/lib/router";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { organizationsApi } from "../api/orgs";
import { AgentIcon } from "../components/AgentIconPicker";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { useScrollbarActivityRef } from "../hooks/useScrollbarActivityRef";
import { useViewedOrganization } from "../hooks/useViewedOrganization";
import { MarkdownEditor, type MentionOption } from "../components/MarkdownEditor";
import { readDesktopShell, type DesktopIdeTarget, type DesktopWorkspaceLaunchTarget } from "../lib/desktop-shell";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import {
  ChevronDown,
  ChevronRight,
  Bot,
  Code2,
  Copy,
  ExternalLink,
  HardDrive,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FileCode2,
  Image as ImageIcon,
  MoreHorizontal,
  Pencil,
  Loader2,
  Terminal,
  Trash2,
  X,
} from "lucide-react";

const WORKSPACE_LAUNCH_TARGET_STORAGE_KEY = "rudder.workspace.launchTargetId";
const MOBILE_BREAKPOINT = 768;
const WORKSPACE_FLUSH_DRAFT_EVENT = "rudder:workspace-flush-draft";
const WORKSPACE_TREE_ENTRY_SELECTOR = "[data-workspace-entry-path]";
const WORKSPACE_LAUNCH_TARGET_IDS = [
  "cursor",
  "vscode",
  "windsurf",
  "zed",
  "webstorm",
  "intellij",
  "xcode",
  "terminal",
  "warp",
  "finder",
] as const satisfies readonly DesktopWorkspaceLaunchTarget["id"][];
const WORKSPACE_IMAGE_FILE_EXTENSIONS = new Set([".avif", ".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const WORKSPACE_TAB_CONTEXT_MENU_WIDTH = 220;
const WORKSPACE_TAB_CONTEXT_MENU_MAX_HEIGHT = 256;
const WORKSPACE_MARKDOWN_FILE_EXTENSIONS = new Set([".md", ".markdown", ".mdown"]);
const WORKSPACE_TEXT_DOCUMENT_FILE_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mdx", ".txt", ".text"]);
const AGENT_MENTION_MARKDOWN_LINK_RE = /\[([^\]]*)]\((agent:\/\/[^)\s]+)\)/g;
const WORKSPACE_ENTRY_DND_MIME = "application/x-rudder-workspace-entry";
const WORKSPACE_TAB_DND_MIME = "application/x-rudder-workspace-tab";
const WORKSPACE_LAUNCH_TARGET_FALLBACKS: Partial<Record<DesktopWorkspaceLaunchTarget["id"], {
  label: string;
  className: string;
}>> = {
  cursor: { label: "C", className: "bg-[#111827] text-white" },
  vscode: { label: "VS", className: "bg-[#0078d4] text-white" },
  windsurf: { label: "W", className: "bg-[#14b8a6] text-white" },
  zed: { label: "Z", className: "bg-[#171717] text-white" },
  webstorm: { label: "WS", className: "bg-[#ec4899] text-white" },
  intellij: { label: "IJ", className: "bg-[#f97316] text-white" },
  xcode: { label: "XC", className: "bg-[#147efb] text-white" },
};

function isWorkspaceLaunchTargetId(value: string | null): value is DesktopWorkspaceLaunchTarget["id"] {
  return WORKSPACE_LAUNCH_TARGET_IDS.includes(value as DesktopWorkspaceLaunchTarget["id"]);
}

function readStoredWorkspaceLaunchTargetId() {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(WORKSPACE_LAUNCH_TARGET_STORAGE_KEY);
  return isWorkspaceLaunchTargetId(value) ? value : null;
}

function writeStoredWorkspaceLaunchTargetId(targetId: DesktopWorkspaceLaunchTarget["id"]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(WORKSPACE_LAUNCH_TARGET_STORAGE_KEY, targetId);
}

function clampWorkspaceTabContextMenuPosition(left: number, top: number) {
  if (typeof window === "undefined") return { left, top };
  return {
    left: Math.min(left, Math.max(8, window.innerWidth - WORKSPACE_TAB_CONTEXT_MENU_WIDTH - 8)),
    top: Math.min(top, Math.max(8, window.innerHeight - WORKSPACE_TAB_CONTEXT_MENU_MAX_HEIGHT - 8)),
  };
}

function requestWorkspaceDraftFlush() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(WORKSPACE_FLUSH_DRAFT_EVENT));
}

export function WorkspaceLaunchTargetIcon({
  target,
  className,
}: {
  target: DesktopWorkspaceLaunchTarget;
  className?: string;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const slotClassName = cn(
    "inline-flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded-[4px] border border-[color:var(--border-soft)] bg-white shadow-[0_0_0_1px_color-mix(in_oklab,var(--surface-page)_70%,transparent)] dark:bg-white",
    className,
  );

  if (target.iconDataUrl && !imageFailed) {
    return (
      <span
        aria-hidden="true"
        className={slotClassName}
        data-workspace-launch-target-icon={target.id}
      >
        <img
          src={target.iconDataUrl}
          alt=""
          className="h-full w-full object-contain drop-shadow-[0_0_1px_rgba(0,0,0,0.35)]"
          onError={() => setImageFailed(true)}
        />
      </span>
    );
  }

  const appSpecificFallback = WORKSPACE_LAUNCH_TARGET_FALLBACKS[target.id];
  if (appSpecificFallback) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border border-[color:var(--border-base)] text-[8px] font-semibold leading-none",
          appSpecificFallback.className,
          className,
        )}
        data-workspace-launch-target-icon={target.id}
        data-fallback-icon="true"
        data-app-specific-fallback="true"
      >
        {appSpecificFallback.label}
      </span>
    );
  }

  const Icon = target.kind === "terminal" ? Terminal : target.kind === "folder" ? FolderOpen : Code2;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border border-[color:var(--border-base)] bg-[color:var(--surface-page)] text-foreground",
        className,
      )}
      data-workspace-launch-target-icon={target.id}
      data-fallback-icon="true"
    >
      <Icon className="h-[72%] w-[72%]" />
    </span>
  );
}

function parentDirectories(filePath: string) {
  const segments = filePath.split("/").filter(Boolean);
  const parents: string[] = [];
  for (let index = 0; index < segments.length - 1; index += 1) {
    parents.push(segments.slice(0, index + 1).join("/"));
  }
  return new Set(parents);
}

function normalizeRequestedPath(value: string | null) {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function getWorkspaceFileExtension(filePath: string | null) {
  if (!filePath) return null;
  const basename = filePath.split("/").at(-1) ?? filePath;
  const extensionIndex = basename.lastIndexOf(".");
  return extensionIndex === -1 ? null : basename.slice(extensionIndex).toLowerCase();
}

function isWorkspaceImageFilePath(filePath: string | null) {
  const extension = getWorkspaceFileExtension(filePath);
  return extension !== null && WORKSPACE_IMAGE_FILE_EXTENSIONS.has(extension);
}

function isWorkspaceMarkdownFilePath(filePath: string | null) {
  const extension = getWorkspaceFileExtension(filePath);
  return extension !== null && WORKSPACE_MARKDOWN_FILE_EXTENSIONS.has(extension);
}

function isWorkspaceTextDocumentFilePath(filePath: string | null) {
  const extension = getWorkspaceFileExtension(filePath);
  return extension !== null && WORKSPACE_TEXT_DOCUMENT_FILE_EXTENSIONS.has(extension);
}

function splitYamlFrontmatter(content: string) {
  const match = content.match(/^(---\r?\n[\s\S]*?\r?\n---)(\r?\n|$)/);
  if (!match) {
    return {
      frontmatter: null,
      frontmatterSeparator: "",
      body: content,
    };
  }

  return {
    frontmatter: match[1] ?? "",
    frontmatterSeparator: match[2] ?? "\n",
    body: content.slice(match[0].length),
  };
}

function joinYamlFrontmatter(
  frontmatter: string | null,
  frontmatterSeparator: string,
  body: string,
) {
  return frontmatter === null ? body : `${frontmatter}${frontmatterSeparator || "\n"}${body}`;
}

function displayWorkspaceEntryLabel(entry: OrganizationWorkspaceFileEntry) {
  return entry.displayLabel?.trim() || entry.name;
}

function isProtectedAgentWorkspaceContainerPath(filePath: string) {
  if (filePath === "agents") return true;
  const segments = filePath.split("/").filter(Boolean);
  return segments.length === 2 && segments[0] === "agents";
}

function canCreateInsideWorkspaceDirectory(directoryPath: string) {
  return !isProtectedAgentWorkspaceContainerPath(directoryPath);
}

function canMoveWorkspaceEntry(entry: Pick<OrganizationWorkspaceFileEntry, "path">) {
  return !isProtectedAgentWorkspaceContainerPath(entry.path);
}

function parentWorkspaceDirectoryPath(entryPath: string) {
  const segments = entryPath.split("/").filter(Boolean);
  segments.pop();
  return segments.join("/");
}

function applyMovedWorkspacePath(currentPath: string, previousPath: string, nextPath: string) {
  if (currentPath === previousPath) return nextPath;
  if (currentPath.startsWith(`${previousPath}/`)) {
    return `${nextPath}${currentPath.slice(previousPath.length)}`;
  }
  return currentPath;
}

function canDropWorkspaceEntryIntoDirectory(
  source: Pick<OrganizationWorkspaceFileEntry, "path" | "isDirectory">,
  destinationDirectoryPath: string,
) {
  if (!canMoveWorkspaceEntry(source)) return false;
  if (!canCreateInsideWorkspaceDirectory(destinationDirectoryPath)) return false;
  if (source.path === destinationDirectoryPath) return false;
  if (source.isDirectory && destinationDirectoryPath.startsWith(`${source.path}/`)) return false;
  return parentWorkspaceDirectoryPath(source.path) !== destinationDirectoryPath;
}

function hasWorkspaceDragPayload(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.types).includes(WORKSPACE_ENTRY_DND_MIME);
}

function isDraggingOverWorkspaceTreeEntry(event: DragEvent<HTMLElement>) {
  return event.target instanceof HTMLElement && Boolean(event.target.closest(WORKSPACE_TREE_ENTRY_SELECTOR));
}

function enrichAgentMentionMarkdown(markdown: string, mentionOptions: MentionOption[]) {
  if (!markdown || mentionOptions.length === 0) return markdown;
  const iconByAgentId = new Map(
    mentionOptions
      .filter((option) => option.kind === "agent" && option.agentId && option.agentIcon)
      .map((option) => [option.agentId!, option.agentIcon!] as const),
  );
  if (iconByAgentId.size === 0) return markdown;

  return markdown.replace(AGENT_MENTION_MARKDOWN_LINK_RE, (match, label: string, href: string) => {
    const parsed = parseAgentMentionHref(href);
    if (!parsed) return match;
    const icon = iconByAgentId.get(parsed.agentId);
    if (!icon || parsed.icon === icon) return match;
    return `[${label}](${buildAgentMentionHref(parsed.agentId, icon)})`;
  });
}

function serializeWorkspaceDragEntry(entry: OrganizationWorkspaceFileEntry) {
  return JSON.stringify({
    path: entry.path,
    isDirectory: entry.isDirectory,
  });
}

function parseWorkspaceDragEntry(event: DragEvent<HTMLElement>) {
  const payload = event.dataTransfer.getData(WORKSPACE_ENTRY_DND_MIME);
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as Partial<Pick<OrganizationWorkspaceFileEntry, "path" | "isDirectory">>;
    if (typeof parsed.path !== "string" || typeof parsed.isDirectory !== "boolean") return null;
    return {
      path: parsed.path,
      isDirectory: parsed.isDirectory,
    };
  } catch {
    return null;
  }
}

function didDragLeaveCurrentTarget(event: DragEvent<HTMLElement>) {
  const relatedTarget = event.relatedTarget;
  return !(relatedTarget instanceof Node) || !event.currentTarget.contains(relatedTarget);
}

function isValidWorkspaceEntryName(name: string) {
  const trimmed = name.trim();
  return Boolean(trimmed)
    && trimmed !== "."
    && trimmed !== ".."
    && !trimmed.includes("/")
    && !trimmed.includes("\\");
}

function joinWorkspaceEntryPath(parentPath: string, name: string) {
  return parentPath ? `${parentPath}/${name}` : name;
}

function joinWorkspacePath(rootPath: string | null, entryPath: string) {
  if (!rootPath) return entryPath;
  return `${rootPath.replace(/\/+$/, "")}/${entryPath}`;
}

function displayWorkspaceFileTabLabel(filePath: string) {
  return filePath.split("/").filter(Boolean).at(-1) ?? filePath;
}

interface WorkspacePathBreadcrumbPart {
  label: string;
  path: string;
  isFile: boolean;
  kind: "folder" | "file" | "agents_root" | "agent_workspace";
  agentIcon?: string | null;
  agentRole?: OrganizationWorkspaceFileEntry["agentRole"];
}

function workspacePathBreadcrumb(
  filePath: string,
  agentWorkspaceEntryByName: Map<string, OrganizationWorkspaceFileEntry>,
): WorkspacePathBreadcrumbPart[] {
  const segments = filePath.split("/").filter(Boolean);
  return segments.map((segment, index) => {
    const path = segments.slice(0, index + 1).join("/");
    const isFile = index === segments.length - 1;
    if (segments[0] === "agents" && index === 1) {
      const agentWorkspaceEntry = agentWorkspaceEntryByName.get(segment);
      return {
        label: agentWorkspaceEntry ? displayWorkspaceEntryLabel(agentWorkspaceEntry) : segment,
        path,
        isFile,
        kind: "agent_workspace",
        agentIcon: agentWorkspaceEntry?.agentIcon ?? null,
        agentRole: agentWorkspaceEntry?.agentRole ?? null,
      };
    }
    return {
      label: segment,
      path,
      isFile,
      kind: segment === "agents" && index === 0 ? "agents_root" : isFile ? "file" : "folder",
    };
  });
}

function focusWorkspaceTreeEntry(entryPath: string | null) {
  if (typeof document === "undefined") return;
  const entry = Array.from(document.querySelectorAll<HTMLElement>(WORKSPACE_TREE_ENTRY_SELECTOR))
    .find((node) => node.dataset.workspaceEntryPath === entryPath);
  if (!entry) return;
  entry.scrollIntoView({ block: "center" });
  const button = entry.querySelector<HTMLButtonElement>("button");
  button?.focus({ preventScroll: true });
}

function visibleWorkspaceTreeEntries() {
  if (typeof document === "undefined") return [];
  return Array.from(document.querySelectorAll<HTMLElement>(WORKSPACE_TREE_ENTRY_SELECTOR));
}

function focusWorkspaceTreeEntryByOffset(
  currentPath: string,
  offset: -1 | 1,
  onFocusEntry: (entryPath: string) => void,
) {
  const entries = visibleWorkspaceTreeEntries();
  const currentIndex = entries.findIndex((node) => node.dataset.workspaceEntryPath === currentPath);
  if (currentIndex < 0) return;
  const next = entries[currentIndex + offset];
  const nextPath = next?.dataset.workspaceEntryPath;
  if (!nextPath) return;
  onFocusEntry(nextPath);
  focusWorkspaceTreeEntry(nextPath);
}

function focusWorkspaceParentEntry(
  currentPath: string,
  onFocusEntry: (entryPath: string) => void,
) {
  const parentPath = parentWorkspaceDirectoryPath(currentPath);
  if (!parentPath) return;
  onFocusEntry(parentPath);
  focusWorkspaceTreeEntry(parentPath);
}

function updateSelectedPath(
  searchParams: URLSearchParams,
  setSearchParams: ReturnType<typeof useSearchParams>[1],
  filePath: string | null,
) {
  const next = new URLSearchParams(searchParams);
  if (filePath) next.set("path", filePath);
  else next.delete("path");
  setSearchParams(next, { replace: true });
}

function DirectoryChildren({
  orgId,
  directoryPath,
  selectedFilePath,
  activeEntryPath,
  onSelectFile,
  onFocusEntry,
  onCopyPath,
  onOpenEntry,
  onStartCreateEntry,
  onStartRename,
  onStartDelete,
  onMoveEntry,
  expandedDirectories,
  depth,
}: {
  orgId: string;
  directoryPath: string;
  selectedFilePath: string | null;
  activeEntryPath: string | null;
  onSelectFile: (filePath: string) => void;
  onFocusEntry: (entryPath: string) => void;
  onCopyPath: (entry: OrganizationWorkspaceFileEntry) => void;
  onOpenEntry?: (entry: OrganizationWorkspaceFileEntry) => void;
  onStartCreateEntry: (entry: OrganizationWorkspaceFileEntry, kind: "file" | "folder") => void;
  onStartRename: (entry: OrganizationWorkspaceFileEntry) => void;
  onStartDelete: (entry: OrganizationWorkspaceFileEntry) => void;
  onMoveEntry: (entry: Pick<OrganizationWorkspaceFileEntry, "path" | "isDirectory">, destinationDirectoryPath: string) => void;
  expandedDirectories: Set<string>;
  depth: number;
}) {
  const { data } = useQuery({
    queryKey: queryKeys.organizations.workspaceFiles(orgId, directoryPath),
    queryFn: () => organizationsApi.listWorkspaceFiles(orgId, directoryPath),
    enabled: !!orgId,
    refetchOnWindowFocus: false,
  });

  const entries = data?.entries ?? [];
  if (entries.length === 0) return null;

  return (
    <ul className="space-y-0.5">
      {entries.map((entry) => (
        <WorkspaceTreeNode
          key={entry.path}
          orgId={orgId}
          entry={entry}
          selectedFilePath={selectedFilePath}
          activeEntryPath={activeEntryPath}
          onSelectFile={onSelectFile}
          onFocusEntry={onFocusEntry}
          onCopyPath={onCopyPath}
          onOpenEntry={onOpenEntry}
          onStartCreateEntry={onStartCreateEntry}
          onStartRename={onStartRename}
          onStartDelete={onStartDelete}
          onMoveEntry={onMoveEntry}
          expandedDirectories={expandedDirectories}
          depth={depth}
        />
      ))}
    </ul>
  );
}

function WorkspaceTreeNode({
  orgId,
  entry,
  selectedFilePath,
  activeEntryPath,
  onSelectFile,
  onFocusEntry,
  onCopyPath,
  onOpenEntry,
  onStartCreateEntry,
  onStartRename,
  onStartDelete,
  onMoveEntry,
  expandedDirectories,
  depth = 0,
}: {
  orgId: string;
  entry: OrganizationWorkspaceFileEntry;
  selectedFilePath: string | null;
  activeEntryPath: string | null;
  onSelectFile: (filePath: string) => void;
  onFocusEntry: (entryPath: string) => void;
  onCopyPath: (entry: OrganizationWorkspaceFileEntry) => void;
  onOpenEntry?: (entry: OrganizationWorkspaceFileEntry) => void;
  onStartCreateEntry: (entry: OrganizationWorkspaceFileEntry, kind: "file" | "folder") => void;
  onStartRename: (entry: OrganizationWorkspaceFileEntry) => void;
  onStartDelete: (entry: OrganizationWorkspaceFileEntry) => void;
  onMoveEntry: (entry: Pick<OrganizationWorkspaceFileEntry, "path" | "isDirectory">, destinationDirectoryPath: string) => void;
  expandedDirectories: Set<string>;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(expandedDirectories.has(entry.path));
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const primaryLabel = displayWorkspaceEntryLabel(entry);
  const isAgentWorkspace = entry.entityType === "agent_workspace";
  const isAgentsRoot = entry.path === "agents";
  const isProtectedContainer = isProtectedAgentWorkspaceContainerPath(entry.path);
  const canCreateInsideDirectory = entry.isDirectory && canCreateInsideWorkspaceDirectory(entry.path);
  const canMoveEntry = canMoveWorkspaceEntry(entry);
  const canDropIntoDirectory = entry.isDirectory && canCreateInsideWorkspaceDirectory(entry.path);
  const isActive = activeEntryPath === entry.path || (!activeEntryPath && selectedFilePath === entry.path);
  const handleOpenActionMenu = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onFocusEntry(entry.path);
    setActionMenuOpen(true);
  };
  const handleDragStart = (event: DragEvent<HTMLElement>) => {
    if (!canMoveEntry) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(WORKSPACE_ENTRY_DND_MIME, serializeWorkspaceDragEntry(entry));
    event.dataTransfer.setData("text/plain", entry.path);
  };
  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    if (!canDropIntoDirectory || !hasWorkspaceDragPayload(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropActive(true);
  };
  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    if (didDragLeaveCurrentTarget(event)) {
      setDropActive(false);
    }
  };
  const handleDrop = (event: DragEvent<HTMLElement>) => {
    if (!canDropIntoDirectory) return;
    event.preventDefault();
    event.stopPropagation();
    setDropActive(false);
    const source = parseWorkspaceDragEntry(event);
    if (!source) return;
    if (!canDropWorkspaceEntryIntoDirectory(source, entry.path)) return;
    onMoveEntry(source, entry.path);
    setExpanded(true);
  };
  const handleKeyboardNavigation = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusWorkspaceTreeEntryByOffset(entry.path, 1, onFocusEntry);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusWorkspaceTreeEntryByOffset(entry.path, -1, onFocusEntry);
      return;
    }
    if (event.key === "ArrowRight" && entry.isDirectory) {
      event.preventDefault();
      onFocusEntry(entry.path);
      if (!expanded) {
        setExpanded(true);
      } else {
        window.requestAnimationFrame(() => focusWorkspaceTreeEntryByOffset(entry.path, 1, onFocusEntry));
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onFocusEntry(entry.path);
      if (entry.isDirectory && expanded) {
        setExpanded(false);
      } else {
        focusWorkspaceParentEntry(entry.path, onFocusEntry);
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      onFocusEntry(entry.path);
      if (entry.isDirectory) {
        setExpanded((value) => !value);
      } else {
        onSelectFile(entry.path);
      }
    }
  };

  const actionMenu = (
    <DropdownMenu open={actionMenuOpen} onOpenChange={setActionMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="h-6 w-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100 focus-visible:opacity-100"
          aria-label={`More actions for ${primaryLabel}`}
          data-testid={`org-workspaces-entry-more-${entry.path}`}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="w-44 will-change-[opacity,transform] data-[state=open]:duration-150 data-[state=open]:ease-out data-[state=closed]:duration-100 data-[state=closed]:ease-in"
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <DropdownMenuItem onSelect={() => onCopyPath(entry)}>
          <Copy className="h-3.5 w-3.5" />
          Copy file path
        </DropdownMenuItem>
        {!isProtectedContainer ? (
          <>
            {onOpenEntry || canCreateInsideDirectory ? <DropdownMenuSeparator /> : null}
            {onOpenEntry ? (
              <DropdownMenuItem onSelect={() => onOpenEntry(entry)}>
                <ExternalLink className="h-3.5 w-3.5" />
                {entry.isDirectory ? "Open folder" : "Open in editor"}
              </DropdownMenuItem>
            ) : null}
            {canCreateInsideDirectory ? (
              <>
                {onOpenEntry ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem onSelect={() => onStartCreateEntry(entry, "file")}>
                  <FilePlus2 className="h-3.5 w-3.5" />
                  New file
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onStartCreateEntry(entry, "folder")}>
                  <FolderPlus className="h-3.5 w-3.5" />
                  New folder
                </DropdownMenuItem>
              </>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onStartRename(entry)}>
              <Pencil className="h-3.5 w-3.5" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => onStartDelete(entry)}>
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  useEffect(() => {
    if (expandedDirectories.has(entry.path)) {
      setExpanded(true);
    }
  }, [entry.path, expandedDirectories]);

  if (entry.isDirectory) {
    return (
      <li>
        <div
          className={cn(
            "group flex w-full items-center rounded-md pr-1 text-sm text-foreground transition-colors hover:bg-accent/60",
            isActive && "bg-accent text-foreground",
            dropActive && "bg-[#2f80ed]/10 ring-1 ring-[#2f80ed]/30",
          )}
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
          data-workspace-entry-path={entry.path}
          draggable={canMoveEntry}
          onDragStart={handleDragStart}
          onDragEnd={() => setDropActive(false)}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onContextMenu={handleOpenActionMenu}
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-0 pr-2 text-left"
            onClick={() => {
              onFocusEntry(entry.path);
              setExpanded((value) => !value);
            }}
            onFocus={() => onFocusEntry(entry.path)}
            onKeyDown={handleKeyboardNavigation}
            aria-expanded={expanded}
            aria-selected={isActive}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </span>
            {isAgentWorkspace ? (
              <span
                data-testid="org-workspaces-agent-icon"
                className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted-foreground"
              >
                <AgentIcon icon={entry.agentIcon} role={entry.agentRole} className="h-3.5 w-3.5 text-[12px]" />
              </span>
            ) : isAgentsRoot ? (
              <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{primaryLabel}</div>
            </div>
            {isAgentWorkspace ? (
              <span
                aria-hidden="true"
                data-testid="org-workspaces-agent-badge"
                className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
              >
                Agent
              </span>
            ) : null}
          </button>
          {actionMenu}
        </div>
        {expanded ? (
          <DirectoryChildren
            orgId={orgId}
            directoryPath={entry.path}
            selectedFilePath={selectedFilePath}
            activeEntryPath={activeEntryPath}
            onSelectFile={onSelectFile}
            onFocusEntry={onFocusEntry}
            onCopyPath={onCopyPath}
            onOpenEntry={onOpenEntry}
            onStartCreateEntry={onStartCreateEntry}
            onStartRename={onStartRename}
            onStartDelete={onStartDelete}
            onMoveEntry={onMoveEntry}
            expandedDirectories={expandedDirectories}
            depth={depth + 1}
          />
        ) : null}
      </li>
    );
  }

  const isSelected = selectedFilePath === entry.path;
  const FileIcon = isWorkspaceImageFilePath(entry.path)
    ? ImageIcon
    : isWorkspaceTextDocumentFilePath(entry.path)
      ? FileText
      : FileCode2;
  return (
    <li>
      <div
        className={`group flex w-full items-center rounded-md pr-1 text-sm transition-colors ${
          isSelected || isActive ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        }`}
        style={{ paddingLeft: `${depth * 14 + 23}px` }}
        data-workspace-entry-path={entry.path}
        draggable={canMoveEntry}
        onDragStart={handleDragStart}
        onDragEnd={() => setDropActive(false)}
        onContextMenu={handleOpenActionMenu}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-0 pr-2 text-left"
          onClick={() => {
            onFocusEntry(entry.path);
            onSelectFile(entry.path);
          }}
          onFocus={() => onFocusEntry(entry.path)}
          onKeyDown={handleKeyboardNavigation}
          aria-selected={isActive || isSelected}
        >
          <FileIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{primaryLabel}</span>
        </button>
        {actionMenu}
      </div>
    </li>
  );
}

export function OrganizationWorkspaceFilesSidebar() {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { viewedOrganizationId } = useViewedOrganization();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedFilePath = normalizeRequestedPath(searchParams.get("path"));
  const filesScrollRef = useScrollbarActivityRef("org-workspaces:files-sidebar");
  const [createTarget, setCreateTarget] = useState<{
    parent: OrganizationWorkspaceFileEntry;
    kind: "file" | "folder";
  } | null>(null);
  const [createDraft, setCreateDraft] = useState("");
  const [renameTarget, setRenameTarget] = useState<OrganizationWorkspaceFileEntry | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<OrganizationWorkspaceFileEntry | null>(null);
  const [rootDropActive, setRootDropActive] = useState(false);
  const [activeEntryPath, setActiveEntryPath] = useState<string | null>(selectedFilePath);
  const [workspaceLaunchTargets, setWorkspaceLaunchTargets] = useState<DesktopWorkspaceLaunchTarget[]>([]);
  const [lastWorkspaceLaunchTargetId, setLastWorkspaceLaunchTargetId] = useState<DesktopWorkspaceLaunchTarget["id"] | null>(
    () => readStoredWorkspaceLaunchTargetId(),
  );
  const [openingWorkspaceTargetId, setOpeningWorkspaceTargetId] = useState<DesktopWorkspaceLaunchTarget["id"] | null>(null);

  const rootQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceFiles(viewedOrganizationId ?? "__none__", ""),
    queryFn: () => organizationsApi.listWorkspaceFiles(viewedOrganizationId!, ""),
    enabled: !!viewedOrganizationId,
    refetchOnWindowFocus: false,
  });

  const workspaceRootPath = rootQuery.data?.rootExists ? rootQuery.data.rootPath : null;
  const selectedWorkspaceLaunchTarget = (
    lastWorkspaceLaunchTargetId
      ? workspaceLaunchTargets.find((target) => target.id === lastWorkspaceLaunchTargetId)
      : null
  ) ?? workspaceLaunchTargets[0] ?? null;
  const workspaceRootEntry = useMemo<OrganizationWorkspaceFileEntry>(
    () => ({ name: "", path: "", isDirectory: true, displayLabel: "Library" }),
    [],
  );
  const expandedDirectories = useMemo(
    () => (selectedFilePath ? parentDirectories(selectedFilePath) : new Set<string>()),
    [selectedFilePath],
  );

  useEffect(() => {
    if (selectedFilePath) setActiveEntryPath(selectedFilePath);
  }, [selectedFilePath]);

  useEffect(() => {
    const clearRootDropState = () => setRootDropActive(false);
    window.addEventListener("dragend", clearRootDropState);
    window.addEventListener("drop", clearRootDropState, true);
    return () => {
      window.removeEventListener("dragend", clearRootDropState);
      window.removeEventListener("drop", clearRootDropState, true);
    };
  }, []);

  const invalidateWorkspaceBrowser = useCallback(async () => {
    if (!viewedOrganizationId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["organizations", viewedOrganizationId, "workspace-files"] }),
      queryClient.invalidateQueries({ queryKey: ["organizations", viewedOrganizationId, "workspace-file"] }),
    ]);
  }, [queryClient, viewedOrganizationId]);

  useEffect(() => {
    const desktopShell = readDesktopShell();
    if (!desktopShell || typeof desktopShell.listWorkspaceLaunchTargets !== "function") {
      setWorkspaceLaunchTargets([]);
      return;
    }

    let cancelled = false;
    desktopShell.listWorkspaceLaunchTargets()
      .then((targets) => {
        if (!cancelled) setWorkspaceLaunchTargets(targets);
      })
      .catch(() => {
        if (!cancelled) setWorkspaceLaunchTargets([]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const createWorkspaceEntry = useMutation({
    mutationFn: async (payload: {
      parent: OrganizationWorkspaceFileEntry;
      kind: "file" | "folder";
      name: string;
    }) => {
      requestWorkspaceDraftFlush();
      const entryPath = joinWorkspaceEntryPath(payload.parent.path, payload.name.trim());
      if (payload.kind === "folder") {
        return {
          kind: payload.kind,
          result: await organizationsApi.createWorkspaceDirectory(viewedOrganizationId!, {
            directoryPath: entryPath,
          }),
        };
      }
      return {
        kind: payload.kind,
        result: await organizationsApi.createWorkspaceFile(viewedOrganizationId!, {
          filePath: entryPath,
          content: "",
        }),
      };
    },
    onSuccess: ({ kind, result }) => {
      if (!viewedOrganizationId) return;
      void invalidateWorkspaceBrowser();
      setCreateTarget(null);
      setCreateDraft("");
      if (kind === "file" && "filePath" in result) {
        queryClient.setQueryData(
          queryKeys.organizations.workspaceFile(viewedOrganizationId, result.filePath),
          result,
        );
        setActiveEntryPath(result.filePath);
        updateSelectedPath(searchParams, setSearchParams, result.filePath);
      }
      const createdPath = "filePath" in result ? result.filePath : result.path;
      pushToast({
        title: kind === "file" ? "File created" : "Folder created",
        body: createdPath,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to create workspace entry",
        tone: "error",
      });
    },
  });

  const renameWorkspaceEntry = useMutation({
    mutationFn: (payload: { entry: OrganizationWorkspaceFileEntry; name: string }) =>
      organizationsApi.renameWorkspaceEntry(viewedOrganizationId!, payload.entry.path, {
        name: payload.name,
      }),
    onSuccess: (result) => {
      void invalidateWorkspaceBrowser();
      setRenameTarget(null);
      setRenameDraft("");
      if (result.previousPath && selectedFilePath) {
        const nextSelectedPath = selectedFilePath === result.previousPath
          ? result.path
          : selectedFilePath.startsWith(`${result.previousPath}/`)
            ? `${result.path}${selectedFilePath.slice(result.previousPath.length)}`
            : selectedFilePath;
        if (nextSelectedPath !== selectedFilePath) {
          updateSelectedPath(searchParams, setSearchParams, nextSelectedPath);
        }
      }
      if (result.previousPath && activeEntryPath) {
        setActiveEntryPath(applyMovedWorkspacePath(activeEntryPath, result.previousPath, result.path));
      }
      pushToast({
        title: "Workspace entry renamed",
        body: result.previousPath ? `${result.previousPath} -> ${result.path}` : result.path,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to rename workspace entry",
        tone: "error",
      });
    },
  });

  const moveWorkspaceEntry = useMutation({
    mutationFn: (payload: {
      entry: Pick<OrganizationWorkspaceFileEntry, "path" | "isDirectory">;
      destinationDirectoryPath: string;
    }) =>
      organizationsApi.moveWorkspaceEntry(viewedOrganizationId!, payload.entry.path, {
        destinationDirectoryPath: payload.destinationDirectoryPath,
      }),
    onSuccess: (result) => {
      void invalidateWorkspaceBrowser();
      if (result.previousPath && selectedFilePath) {
        const nextSelectedPath = applyMovedWorkspacePath(selectedFilePath, result.previousPath, result.path);
        if (nextSelectedPath !== selectedFilePath) {
          updateSelectedPath(searchParams, setSearchParams, nextSelectedPath);
        }
      }
      if (result.previousPath && activeEntryPath) {
        setActiveEntryPath(applyMovedWorkspacePath(activeEntryPath, result.previousPath, result.path));
      }
      pushToast({
        title: "Workspace entry moved",
        body: result.previousPath ? `${result.previousPath} -> ${result.path}` : result.path,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to move workspace entry",
        tone: "error",
      });
    },
  });

  const deleteWorkspaceEntry = useMutation({
    mutationFn: (entry: OrganizationWorkspaceFileEntry) =>
      organizationsApi.deleteWorkspaceEntry(viewedOrganizationId!, entry.path),
    onSuccess: (result) => {
      void invalidateWorkspaceBrowser();
      setDeleteTarget(null);
      if (selectedFilePath && (selectedFilePath === result.path || selectedFilePath.startsWith(`${result.path}/`))) {
        updateSelectedPath(searchParams, setSearchParams, null);
      }
      if (activeEntryPath && (activeEntryPath === result.path || activeEntryPath.startsWith(`${result.path}/`))) {
        setActiveEntryPath(parentWorkspaceDirectoryPath(result.path) || null);
      }
      pushToast({
        title: "Workspace entry deleted",
        body: result.path,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to delete workspace entry",
        tone: "error",
      });
    },
  });

  const handleOpenWorkspace = useCallback(async (target: DesktopWorkspaceLaunchTarget) => {
    if (!workspaceRootPath) return;
    const desktopShell = readDesktopShell();
    if (!desktopShell?.openWorkspace) return;

    setOpeningWorkspaceTargetId(target.id);
    try {
      await desktopShell.openWorkspace(workspaceRootPath, target.id);
      setLastWorkspaceLaunchTargetId(target.id);
      writeStoredWorkspaceLaunchTargetId(target.id);
      pushToast({
        title: `Opened workspace in ${target.label}`,
        tone: "info",
      });
    } catch (error) {
      pushToast({
        title: "Failed to open workspace",
        body: error instanceof Error ? error.message : `Could not open the workspace in ${target.label}.`,
        tone: "error",
      });
    } finally {
      setOpeningWorkspaceTargetId(null);
    }
  }, [pushToast, workspaceRootPath]);

  async function handleCopyEntryPath(entry: OrganizationWorkspaceFileEntry) {
    const copyValue = joinWorkspacePath(workspaceRootPath, entry.path);
    const desktopShell = readDesktopShell();
    try {
      if (desktopShell?.copyText) {
        await desktopShell.copyText(copyValue);
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(copyValue);
      } else {
        throw new Error("Clipboard is not available in this environment.");
      }
      pushToast({
        title: "File path copied",
        body: copyValue,
        tone: "info",
      });
    } catch (error) {
      pushToast({
        title: "Failed to copy file path",
        body: error instanceof Error ? error.message : copyValue,
        tone: "error",
      });
    }
  }

  async function handleOpenEntryDefault(entry: OrganizationWorkspaceFileEntry) {
    const targetPath = joinWorkspacePath(workspaceRootPath, entry.path);
    const desktopShell = readDesktopShell();
    if (!desktopShell?.openPath) {
      return;
    }

    try {
      await desktopShell.openPath(targetPath);
      pushToast({
        title: entry.isDirectory ? "Opened folder" : "Opened in editor",
        body: targetPath,
        tone: "info",
      });
    } catch (error) {
      pushToast({
        title: entry.isDirectory ? "Failed to open folder" : "Failed to open in editor",
        body: error instanceof Error ? error.message : targetPath,
        tone: "error",
      });
    }
  }

  function handleSelectFile(filePath: string) {
    updateSelectedPath(searchParams, setSearchParams, filePath);
  }

  function handleStartCreateEntry(entry: OrganizationWorkspaceFileEntry, kind: "file" | "folder") {
    if (!entry.isDirectory || !canCreateInsideWorkspaceDirectory(entry.path)) return;
    setCreateTarget({ parent: entry, kind });
    setCreateDraft(kind === "file" ? "untitled.md" : "new-folder");
  }

  function handleStartCreateRootEntry(kind: "file" | "folder") {
    handleStartCreateEntry(workspaceRootEntry, kind);
  }

  function handleStartRename(entry: OrganizationWorkspaceFileEntry) {
    if (isProtectedAgentWorkspaceContainerPath(entry.path)) return;
    setRenameTarget(entry);
    setRenameDraft(entry.name);
  }

  function handleStartDelete(entry: OrganizationWorkspaceFileEntry) {
    if (isProtectedAgentWorkspaceContainerPath(entry.path)) return;
    setDeleteTarget(entry);
  }

  function handleMoveEntry(
    entry: Pick<OrganizationWorkspaceFileEntry, "path" | "isDirectory">,
    destinationDirectoryPath: string,
  ) {
    setRootDropActive(false);
    if (!canDropWorkspaceEntryIntoDirectory(entry, destinationDirectoryPath)) return;
    moveWorkspaceEntry.mutate({ entry, destinationDirectoryPath });
  }

  function handleRootDragOver(event: DragEvent<HTMLElement>) {
    if (!hasWorkspaceDragPayload(event.dataTransfer)) return;
    if (isDraggingOverWorkspaceTreeEntry(event)) {
      setRootDropActive(false);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setRootDropActive(true);
  }

  function handleRootDragLeave(event: DragEvent<HTMLElement>) {
    if (didDragLeaveCurrentTarget(event)) {
      setRootDropActive(false);
    }
  }

  function handleRootDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setRootDropActive(false);
    const source = parseWorkspaceDragEntry(event);
    if (!source || !canDropWorkspaceEntryIntoDirectory(source, "")) return;
    handleMoveEntry(source, "");
  }

  return (
    <>
      <aside
        data-testid="workspace-sidebar"
        className="workspace-context-sidebar flex min-h-0 w-full min-w-0 shrink-0 flex-col"
      >
        <header
          data-testid="workspace-context-header"
          className="workspace-card-header workspace-context-header desktop-chrome flex shrink-0 items-center justify-between gap-3 px-4 py-3"
        >
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">Library</h2>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => handleStartCreateRootEntry("file")}
                  disabled={!workspaceRootPath}
                  aria-label="New file"
                  data-testid="org-workspaces-new-file-button"
                >
                  <FilePlus2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>New file</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => handleStartCreateRootEntry("folder")}
                  disabled={!workspaceRootPath}
                  aria-label="New folder"
                  data-testid="org-workspaces-new-folder-button"
                >
                  <FolderPlus className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>New folder</TooltipContent>
            </Tooltip>
            {workspaceRootPath && selectedWorkspaceLaunchTarget ? (
              <div
                className="inline-flex h-8 items-stretch overflow-hidden rounded-md border border-[color:var(--border-base)] bg-[color:var(--surface-elevated)] shadow-none"
                data-testid="org-workspaces-launcher"
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-full rounded-none border-0 px-2 text-sm text-foreground shadow-none hover:border-0 hover:bg-[color:var(--surface-active)]"
                  aria-label={`Open workspace in ${selectedWorkspaceLaunchTarget.label}`}
                  onClick={() => void handleOpenWorkspace(selectedWorkspaceLaunchTarget)}
                  disabled={openingWorkspaceTargetId !== null}
                >
                  {openingWorkspaceTargetId === selectedWorkspaceLaunchTarget.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <WorkspaceLaunchTargetIcon
                      target={selectedWorkspaceLaunchTarget}
                      className="h-3.5 w-3.5"
                    />
                  )}
                  <span className="ml-1.5 max-w-16 truncate">{selectedWorkspaceLaunchTarget.label}</span>
                </Button>
                <div className="my-1 w-px bg-[color:var(--border-soft)]" aria-hidden="true" />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-full w-8 rounded-none border-0 text-muted-foreground shadow-none hover:border-0 hover:bg-[color:var(--surface-active)] hover:text-foreground"
                      aria-label="Open workspace menu"
                      disabled={openingWorkspaceTargetId !== null}
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuRadioGroup
                      value={selectedWorkspaceLaunchTarget.id}
                      onValueChange={(targetId) => {
                        const target = workspaceLaunchTargets.find((candidate) => candidate.id === targetId);
                        if (!target) return;
                        setLastWorkspaceLaunchTargetId(target.id);
                        writeStoredWorkspaceLaunchTargetId(target.id);
                      }}
                    >
                      {workspaceLaunchTargets.map((target) => (
                        <DropdownMenuRadioItem
                          key={target.id}
                          value={target.id}
                          data-testid={`org-workspaces-launch-target-${target.id}`}
                        >
                          <WorkspaceLaunchTargetIcon target={target} className="h-4 w-4" />
                          <span>{target.label}</span>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : null}
          </div>
        </header>

        <section
          data-testid="org-workspaces-files-card"
          className={cn(
            "flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border transition-colors",
            rootDropActive && "bg-[#2f80ed]/5 ring-1 ring-inset ring-[#2f80ed]/25",
          )}
          onDragOver={handleRootDragOver}
          onDragLeave={handleRootDragLeave}
          onDrop={handleRootDrop}
        >
          <div
            ref={filesScrollRef}
            data-testid="org-workspaces-files-scroll"
            className="scrollbar-auto-hide min-h-0 flex-1 overflow-auto"
          >
            <div className="px-2 py-2">
              {!viewedOrganizationId ? (
                <div className="px-2 py-3 text-sm text-muted-foreground">Select an organization.</div>
              ) : rootQuery.isLoading ? (
                <div className="px-2 py-3 text-sm text-muted-foreground">Loading files...</div>
              ) : rootQuery.error ? (
                <div className="px-2 py-3 text-sm text-destructive">{rootQuery.error.message}</div>
              ) : !rootQuery.data?.rootExists ? (
                <div className="px-2 py-3 text-sm text-muted-foreground">
                  {rootQuery.data?.message ?? "The shared workspace root is not available on this machine yet."}
                </div>
              ) : rootQuery.data.entries.length === 0 ? (
                <div className="px-2 py-3 text-sm text-muted-foreground">
                  {rootQuery.data.message ?? "This folder is empty."}
                </div>
              ) : (
                <ul className="space-y-0.5">
                  {rootQuery.data.entries.map((entry) => (
                    <WorkspaceTreeNode
                      key={entry.path}
                      orgId={viewedOrganizationId}
                      entry={entry}
                      selectedFilePath={selectedFilePath}
                      activeEntryPath={activeEntryPath}
                      onSelectFile={handleSelectFile}
                      onFocusEntry={setActiveEntryPath}
                      onCopyPath={(entryToCopy) => void handleCopyEntryPath(entryToCopy)}
                      onOpenEntry={readDesktopShell()?.openPath
                        ? (entryToOpen) => void handleOpenEntryDefault(entryToOpen)
                        : undefined}
                      onStartCreateEntry={handleStartCreateEntry}
                      onStartRename={handleStartRename}
                      onStartDelete={handleStartDelete}
                      onMoveEntry={handleMoveEntry}
                      expandedDirectories={expandedDirectories}
                    />
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      </aside>

      <Dialog open={createTarget !== null} onOpenChange={(open) => {
        if (!open && !createWorkspaceEntry.isPending) {
          setCreateTarget(null);
          setCreateDraft("");
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{createTarget?.kind === "folder" ? "New folder" : "New file"}</DialogTitle>
            <DialogDescription>
              Create inside {createTarget?.parent.path ?? "this folder"}.
            </DialogDescription>
          </DialogHeader>
          <label className="space-y-1.5">
            <span className="text-xs text-muted-foreground">Name</span>
            <Input
              value={createDraft}
              onChange={(event) => setCreateDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !createTarget || !isValidWorkspaceEntryName(createDraft)) return;
                event.preventDefault();
                createWorkspaceEntry.mutate({
                  parent: createTarget.parent,
                  kind: createTarget.kind,
                  name: createDraft,
                });
              }}
              autoFocus
            />
          </label>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setCreateTarget(null);
                setCreateDraft("");
              }}
              disabled={createWorkspaceEntry.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (!createTarget) return;
                createWorkspaceEntry.mutate({
                  parent: createTarget.parent,
                  kind: createTarget.kind,
                  name: createDraft,
                });
              }}
              disabled={!createTarget || !isValidWorkspaceEntryName(createDraft) || createWorkspaceEntry.isPending}
            >
              {createWorkspaceEntry.isPending
                ? "Creating..."
                : createTarget?.kind === "folder"
                  ? "Create folder"
                  : "Create file"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameTarget !== null} onOpenChange={(open) => {
        if (!open && !renameWorkspaceEntry.isPending) {
          setRenameTarget(null);
          setRenameDraft("");
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename entry</DialogTitle>
            <DialogDescription>
              Rename this workspace file or folder without changing its parent folder.
            </DialogDescription>
          </DialogHeader>
          <label className="space-y-1.5">
            <span className="text-xs text-muted-foreground">Name</span>
            <Input
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !renameTarget) return;
                event.preventDefault();
                renameWorkspaceEntry.mutate({ entry: renameTarget, name: renameDraft });
              }}
              autoFocus
            />
          </label>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setRenameTarget(null);
                setRenameDraft("");
              }}
              disabled={renameWorkspaceEntry.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (!renameTarget) return;
                renameWorkspaceEntry.mutate({ entry: renameTarget, name: renameDraft });
              }}
              disabled={
                !renameTarget
                || renameDraft.trim().length === 0
                || renameDraft.trim() === renameTarget.name
                || renameWorkspaceEntry.isPending
              }
            >
              {renameWorkspaceEntry.isPending ? "Renaming..." : "Rename"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => {
        if (!open && !deleteWorkspaceEntry.isPending) setDeleteTarget(null);
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete entry</DialogTitle>
            <DialogDescription>
              This will permanently delete {deleteTarget?.path ?? "this entry"} from the organization workspace.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleteWorkspaceEntry.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (!deleteTarget) return;
                deleteWorkspaceEntry.mutate(deleteTarget);
              }}
              disabled={!deleteTarget || deleteWorkspaceEntry.isPending}
            >
              {deleteWorkspaceEntry.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function OrganizationWorkspaceBrowser({
  breadcrumbLabel = "Workspaces",
  emptyMessage = "Select an organization to browse its shared workspace.",
  editorTitle = "Editor",
  noSelectionMessage = (
    <>
      Choose a file from the workspace tree to edit it. Agent and organization skill cards can jump here
      directly into the target <span className="font-mono">SKILL.md</span>, and any shared file already in
      this workspace can be edited here.
    </>
  ),
}: {
  breadcrumbLabel?: string;
  emptyMessage?: string;
  editorTitle?: string;
  noSelectionMessage?: ReactNode;
}) {
  const { setBreadcrumbs, setHeaderActions } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const { viewedOrganization, viewedOrganizationId } = useViewedOrganization();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedFilePath = normalizeRequestedPath(searchParams.get("path"));
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(requestedFilePath);
  const [openFilePaths, setOpenFilePaths] = useState<string[]>(() => requestedFilePath ? [requestedFilePath] : []);
  const [tabContextMenu, setTabContextMenu] = useState<{
    filePath: string;
    left: number;
    top: number;
  } | null>(null);
  const [draggedTabPath, setDraggedTabPath] = useState<string | null>(null);
  const [tabDropPreview, setTabDropPreview] = useState<{
    targetPath: string;
    position: "before" | "after";
  } | null>(null);
  const [draftContent, setDraftContent] = useState("");
  const [draftFilePath, setDraftFilePath] = useState<string | null>(null);
  const selectedFilePathRef = useRef<string | null>(selectedFilePath);
  const [availableIdes, setAvailableIdes] = useState<DesktopIdeTarget[]>([]);
  const [workspaceLaunchTargets, setWorkspaceLaunchTargets] = useState<DesktopWorkspaceLaunchTarget[]>([]);
  const [lastWorkspaceLaunchTargetId, setLastWorkspaceLaunchTargetId] = useState<
    DesktopWorkspaceLaunchTarget["id"] | null
  >(() => readStoredWorkspaceLaunchTargetId());
  const [openingWorkspaceTargetId, setOpeningWorkspaceTargetId] = useState<
    DesktopWorkspaceLaunchTarget["id"] | null
  >(null);
  const [isMobileViewport, setIsMobileViewport] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < MOBILE_BREAKPOINT : false,
  );
  const [renameTarget, setRenameTarget] = useState<OrganizationWorkspaceFileEntry | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<OrganizationWorkspaceFileEntry | null>(null);
  const [rootDropActive, setRootDropActive] = useState(false);
  const [activeEntryPath, setActiveEntryPath] = useState<string | null>(requestedFilePath);
  const [createTarget, setCreateTarget] = useState<{
    parent: OrganizationWorkspaceFileEntry;
    kind: "file" | "folder";
  } | null>(null);
  const [createDraft, setCreateDraft] = useState("");
  const draftStateRef = useRef<{
    draftContent: string;
    draftFilePath: string | null;
  }>({ draftContent: "", draftFilePath: null });
  const syncedFileRef = useRef<{ filePath: string | null; content: string }>({ filePath: null, content: "" });
  const saveWorkspaceFileMutateRef = useRef<((payload: { filePath: string; content: string }) => void) | null>(null);
  const filesScrollRef = useScrollbarActivityRef("org-workspaces:files");
  const editorScrollRef = useScrollbarActivityRef(
    selectedFilePath ? `org-workspaces:editor:${selectedFilePath}` : "org-workspaces:editor",
  );
  selectedFilePathRef.current = selectedFilePath;

  useEffect(() => {
    if (selectedFilePath) setActiveEntryPath(selectedFilePath);
  }, [selectedFilePath]);

  useEffect(() => {
    const clearRootDropState = () => setRootDropActive(false);
    window.addEventListener("dragend", clearRootDropState);
    window.addEventListener("drop", clearRootDropState, true);
    return () => {
      window.removeEventListener("dragend", clearRootDropState);
      window.removeEventListener("drop", clearRootDropState, true);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (typeof window.matchMedia !== "function") return;
    const mediaQuery = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const handleChange = (event: MediaQueryListEvent) => setIsMobileViewport(event.matches);
    setIsMobileViewport(mediaQuery.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  const flushCurrentDraft = useCallback(() => {
    const { draftContent: currentDraftContent, draftFilePath: currentDraftFilePath } = draftStateRef.current;
    if (!currentDraftFilePath) return;
    const syncedFile = syncedFileRef.current;
    if (syncedFile.filePath === currentDraftFilePath && syncedFile.content === currentDraftContent) return;
    saveWorkspaceFileMutateRef.current?.({ filePath: currentDraftFilePath, content: currentDraftContent });
  }, []);

  const openWorkspaceFileTab = useCallback((filePath: string) => {
    setOpenFilePaths((current) => current.includes(filePath) ? current : [...current, filePath]);
  }, []);

  useEffect(() => {
    setBreadcrumbs([{ label: breadcrumbLabel }]);
  }, [breadcrumbLabel, setBreadcrumbs]);

  useEffect(() => {
    const desktopShell = readDesktopShell();
    if (!desktopShell) {
      setAvailableIdes([]);
      setWorkspaceLaunchTargets([]);
      return;
    }

    let cancelled = false;
    if (typeof desktopShell.listAvailableIdes === "function") {
      desktopShell.listAvailableIdes()
        .then((targets) => {
          if (!cancelled) setAvailableIdes(targets);
        })
        .catch(() => {
          if (!cancelled) setAvailableIdes([]);
        });
    } else {
      setAvailableIdes([]);
    }
    if (typeof desktopShell.listWorkspaceLaunchTargets === "function") {
      desktopShell.listWorkspaceLaunchTargets()
        .then((targets) => {
          if (!cancelled) setWorkspaceLaunchTargets(targets);
        })
        .catch(() => {
          if (!cancelled) setWorkspaceLaunchTargets([]);
        });
    } else {
      setWorkspaceLaunchTargets([]);
    }

    return () => {
      cancelled = true;
    };
  }, []);

  const rootQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceFiles(viewedOrganizationId ?? "__none__", ""),
    queryFn: () => organizationsApi.listWorkspaceFiles(viewedOrganizationId!, ""),
    enabled: !!viewedOrganizationId,
    refetchOnWindowFocus: false,
  });
  const agentWorkspaceEntriesQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceFiles(viewedOrganizationId ?? "__none__", "agents"),
    queryFn: () => organizationsApi.listWorkspaceFiles(viewedOrganizationId!, "agents"),
    enabled: !!viewedOrganizationId,
    refetchOnWindowFocus: false,
  });
  const agentWorkspaceEntryByName = useMemo(() => new Map(
    (agentWorkspaceEntriesQuery.data?.entries ?? [])
      .filter((entry) => entry.entityType === "agent_workspace")
      .map((entry) => [entry.name, entry] as const),
  ), [agentWorkspaceEntriesQuery.data?.entries]);
  const agentWorkspaceMentionOptions = useMemo<MentionOption[]>(
    () => (agentWorkspaceEntriesQuery.data?.entries ?? [])
      .filter((entry) => entry.entityType === "agent_workspace" && entry.agentId)
      .map((entry) => ({
        id: `agent:${entry.agentId}`,
        name: entry.displayLabel ?? entry.name,
        kind: "agent",
        agentId: entry.agentId!,
        agentIcon: entry.agentIcon ?? null,
        agentRole: entry.agentRole ?? null,
      })),
    [agentWorkspaceEntriesQuery.data?.entries],
  );

  const fileQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceFile(viewedOrganizationId ?? "__none__", selectedFilePath ?? ""),
    queryFn: () => organizationsApi.readWorkspaceFile(viewedOrganizationId!, selectedFilePath!),
    enabled: !!viewedOrganizationId && !!selectedFilePath,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    draftStateRef.current = { draftContent, draftFilePath };
  }, [draftContent, draftFilePath]);

  useEffect(() => {
    flushCurrentDraft();
    setSelectedFilePath(requestedFilePath);
    if (requestedFilePath) openWorkspaceFileTab(requestedFilePath);
  }, [flushCurrentDraft, openWorkspaceFileTab, requestedFilePath, viewedOrganizationId]);

  useEffect(() => {
    if (selectedFilePath) return;
    const preferredFile = rootQuery.data?.entries.find((entry) => !entry.isDirectory);
    if (preferredFile) {
      setSelectedFilePath(preferredFile.path);
      openWorkspaceFileTab(preferredFile.path);
      updateSelectedPath(searchParams, setSearchParams, preferredFile.path);
    }
  }, [openWorkspaceFileTab, rootQuery.data?.entries, searchParams, selectedFilePath, setSearchParams]);

  useEffect(() => {
    if (!selectedFilePath) {
      setDraftContent("");
      setDraftFilePath(null);
      return;
    }
    if (!fileQuery.data || fileQuery.data.filePath !== selectedFilePath) return;
    const nextContent = fileQuery.data.content ?? "";
    const syncedFile = syncedFileRef.current;
    const hasLocalDirtyDraft =
      draftFilePath === selectedFilePath
      && syncedFile.filePath === selectedFilePath
      && draftContent !== syncedFile.content;
    if (hasLocalDirtyDraft) return;
    syncedFileRef.current = { filePath: selectedFilePath, content: nextContent };
    setDraftContent(nextContent);
    setDraftFilePath(selectedFilePath);
  }, [draftContent, draftFilePath, fileQuery.data, selectedFilePath]);

  const expandedDirectories = useMemo(
    () => (selectedFilePath ? parentDirectories(selectedFilePath) : new Set<string>()),
    [selectedFilePath],
  );

  const saveWorkspaceFile = useMutation({
    mutationFn: (payload: { filePath: string; content: string }) =>
      organizationsApi.updateWorkspaceFile(viewedOrganizationId!, payload.filePath, {
        content: payload.content,
      }),
    onSuccess: (detail) => {
      if (!viewedOrganizationId) return;
      syncedFileRef.current = { filePath: detail.filePath, content: detail.content ?? "" };
      queryClient.setQueryData(
        queryKeys.organizations.workspaceFile(viewedOrganizationId, detail.filePath),
        detail,
      );
    },
  });
  const saveWorkspaceFileMutate = saveWorkspaceFile.mutate;
  useEffect(() => {
    saveWorkspaceFileMutateRef.current = saveWorkspaceFileMutate;
  }, [saveWorkspaceFileMutate]);

  useEffect(() => () => {
    flushCurrentDraft();
  }, [flushCurrentDraft]);

  useEffect(() => {
    if (!tabContextMenu) return;

    const closeMenu = () => setTabContextMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };

    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [tabContextMenu]);

  useEffect(() => {
    window.addEventListener(WORKSPACE_FLUSH_DRAFT_EVENT, flushCurrentDraft);
    return () => window.removeEventListener(WORKSPACE_FLUSH_DRAFT_EVENT, flushCurrentDraft);
  }, [flushCurrentDraft]);

  const invalidateWorkspaceBrowser = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["organizations", viewedOrganizationId, "workspace-files"] }),
      queryClient.invalidateQueries({ queryKey: ["organizations", viewedOrganizationId, "workspace-file"] }),
    ]);
  }, [queryClient, viewedOrganizationId]);

  useEffect(() => {
    if (!viewedOrganizationId) return;
    const refreshFromDisk = () => {
      flushCurrentDraft();
      void invalidateWorkspaceBrowser();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshFromDisk();
    };
    window.addEventListener("focus", refreshFromDisk);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", refreshFromDisk);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [flushCurrentDraft, invalidateWorkspaceBrowser, viewedOrganizationId]);

  const renameWorkspaceEntry = useMutation({
    mutationFn: (payload: { entry: OrganizationWorkspaceFileEntry; name: string }) =>
      organizationsApi.renameWorkspaceEntry(viewedOrganizationId!, payload.entry.path, {
        name: payload.name,
      }),
    onSuccess: (result) => {
      if (!viewedOrganizationId) return;
      void invalidateWorkspaceBrowser();
      setRenameTarget(null);
      setRenameDraft("");

      const previousPath = result.previousPath;
      if (previousPath && selectedFilePath) {
        setOpenFilePaths((current) => current.map((filePath) => {
          if (filePath === previousPath) return result.path;
          if (filePath.startsWith(`${previousPath}/`)) {
            return `${result.path}${filePath.slice(previousPath.length)}`;
          }
          return filePath;
        }));
        const nextSelectedPath = selectedFilePath === previousPath
          ? result.path
          : selectedFilePath.startsWith(`${previousPath}/`)
            ? `${result.path}${selectedFilePath.slice(previousPath.length)}`
            : selectedFilePath;
        if (nextSelectedPath !== selectedFilePath) {
          setSelectedFilePath(nextSelectedPath);
          setDraftFilePath(nextSelectedPath);
          if (syncedFileRef.current.filePath === previousPath) {
            syncedFileRef.current = { ...syncedFileRef.current, filePath: nextSelectedPath };
          }
          updateSelectedPath(searchParams, setSearchParams, nextSelectedPath);
        }
      }
      if (previousPath && activeEntryPath) {
        setActiveEntryPath(applyMovedWorkspacePath(activeEntryPath, previousPath, result.path));
      }
      pushToast({
        title: "Workspace entry renamed",
        body: result.previousPath ? `${result.previousPath} -> ${result.path}` : result.path,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to rename workspace entry",
        tone: "error",
      });
    },
  });

  const moveWorkspaceEntry = useMutation({
    mutationFn: (payload: {
      entry: Pick<OrganizationWorkspaceFileEntry, "path" | "isDirectory">;
      destinationDirectoryPath: string;
    }) =>
      organizationsApi.moveWorkspaceEntry(viewedOrganizationId!, payload.entry.path, {
        destinationDirectoryPath: payload.destinationDirectoryPath,
      }),
    onSuccess: (result) => {
      if (!viewedOrganizationId) return;
      void invalidateWorkspaceBrowser();
      const previousPath = result.previousPath;
      if (previousPath) {
        setOpenFilePaths((current) =>
          current.map((filePath) => applyMovedWorkspacePath(filePath, previousPath, result.path)),
        );
        if (selectedFilePath) {
          const nextSelectedPath = applyMovedWorkspacePath(selectedFilePath, previousPath, result.path);
          if (nextSelectedPath !== selectedFilePath) {
            setSelectedFilePath(nextSelectedPath);
            setDraftFilePath(nextSelectedPath);
            if (syncedFileRef.current.filePath === previousPath) {
              syncedFileRef.current = { ...syncedFileRef.current, filePath: nextSelectedPath };
            }
            updateSelectedPath(searchParams, setSearchParams, nextSelectedPath);
          }
        }
        if (activeEntryPath) {
          setActiveEntryPath(applyMovedWorkspacePath(activeEntryPath, previousPath, result.path));
        }
      }
      pushToast({
        title: "Workspace entry moved",
        body: result.previousPath ? `${result.previousPath} -> ${result.path}` : result.path,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to move workspace entry",
        tone: "error",
      });
    },
  });

  const createWorkspaceEntry = useMutation({
    mutationFn: async (payload: {
      parent: OrganizationWorkspaceFileEntry;
      kind: "file" | "folder";
      name: string;
    }) => {
      requestWorkspaceDraftFlush();
      const entryPath = joinWorkspaceEntryPath(payload.parent.path, payload.name.trim());
      if (payload.kind === "folder") {
        return {
          kind: payload.kind,
          result: await organizationsApi.createWorkspaceDirectory(viewedOrganizationId!, {
            directoryPath: entryPath,
          }),
        };
      }
      return {
        kind: payload.kind,
        result: await organizationsApi.createWorkspaceFile(viewedOrganizationId!, {
          filePath: entryPath,
          content: "",
        }),
      };
    },
    onSuccess: ({ kind, result }) => {
      if (!viewedOrganizationId) return;
      void invalidateWorkspaceBrowser();
      setCreateTarget(null);
      setCreateDraft("");
      if (kind === "file" && "filePath" in result) {
        queryClient.setQueryData(
          queryKeys.organizations.workspaceFile(viewedOrganizationId, result.filePath),
          result,
        );
        setSelectedFilePath(result.filePath);
        openWorkspaceFileTab(result.filePath);
        setDraftFilePath(result.filePath);
        syncedFileRef.current = { filePath: result.filePath, content: result.content ?? "" };
        updateSelectedPath(searchParams, setSearchParams, result.filePath);
        setDraftContent(result.content ?? "");
      }
      const createdPath = "filePath" in result ? result.filePath : result.path;
      pushToast({
        title: kind === "file" ? "File created" : "Folder created",
        body: createdPath,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to create workspace entry",
        tone: "error",
      });
    },
  });

  const deleteWorkspaceEntry = useMutation({
    mutationFn: (entry: OrganizationWorkspaceFileEntry) =>
      organizationsApi.deleteWorkspaceEntry(viewedOrganizationId!, entry.path),
    onSuccess: (result) => {
      if (!viewedOrganizationId) return;
      void invalidateWorkspaceBrowser();
      setDeleteTarget(null);
      setOpenFilePaths((current) =>
        current.filter((filePath) => filePath !== result.path && !filePath.startsWith(`${result.path}/`)),
      );
      if (selectedFilePath && (selectedFilePath === result.path || selectedFilePath.startsWith(`${result.path}/`))) {
        setSelectedFilePath(null);
        setDraftFilePath(null);
        syncedFileRef.current = { filePath: null, content: "" };
        updateSelectedPath(searchParams, setSearchParams, null);
      }
      if (activeEntryPath && (activeEntryPath === result.path || activeEntryPath.startsWith(`${result.path}/`))) {
        setActiveEntryPath(parentWorkspaceDirectoryPath(result.path) || null);
      }
      pushToast({
        title: "Workspace entry deleted",
        body: result.path,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to delete workspace entry",
        tone: "error",
      });
    },
  });

  useEffect(() => {
    if (!selectedFilePath) return;
    if (draftFilePath !== selectedFilePath) return;
    const detail = fileQuery.data;
    if (!detail || detail.filePath !== selectedFilePath) return;
    if (detail.content === null || detail.truncated) return;
    if (draftContent === detail.content) return;

    const timeout = window.setTimeout(() => {
      saveWorkspaceFileMutate({ filePath: selectedFilePath, content: draftContent });
    }, 700);

    return () => window.clearTimeout(timeout);
  }, [
    draftContent,
    draftFilePath,
    fileQuery.data,
    saveWorkspaceFileMutate,
    selectedFilePath,
  ]);

  const workspaceRootPath = rootQuery.data?.rootExists ? rootQuery.data.rootPath : null;
  const selectedWorkspaceLaunchTarget = (
    lastWorkspaceLaunchTargetId
      ? workspaceLaunchTargets.find((target) => target.id === lastWorkspaceLaunchTargetId)
      : null
  ) ?? workspaceLaunchTargets[0] ?? null;
  const workspaceRootEntry = useMemo<OrganizationWorkspaceFileEntry>(
    () => ({ name: "", path: "", isDirectory: true, displayLabel: "Library" }),
    [],
  );
  const handleStartCreateRootEntry = useCallback((kind: "file" | "folder") => {
    flushCurrentDraft();
    setCreateTarget({ parent: workspaceRootEntry, kind });
    setCreateDraft(kind === "file" ? "untitled.md" : "new-folder");
  }, [flushCurrentDraft, workspaceRootEntry]);

  const handleOpenWorkspace = useCallback(async (
    target: DesktopWorkspaceLaunchTarget,
  ) => {
    if (!workspaceRootPath) return;
    const desktopShell = readDesktopShell();
    if (!desktopShell?.openWorkspace) return;

    setOpeningWorkspaceTargetId(target.id);
    try {
      await desktopShell.openWorkspace(workspaceRootPath, target.id);
      setLastWorkspaceLaunchTargetId(target.id);
      writeStoredWorkspaceLaunchTargetId(target.id);
      pushToast({
        title: `Opened workspace in ${target.label}`,
        tone: "info",
      });
    } catch (error) {
      pushToast({
        title: "Failed to open workspace",
        body: error instanceof Error ? error.message : `Could not open the workspace in ${target.label}.`,
        tone: "error",
      });
    } finally {
      setOpeningWorkspaceTargetId(null);
    }
  }, [pushToast, workspaceRootPath]);

  const handleSelectWorkspaceLaunchTarget = useCallback((target: DesktopWorkspaceLaunchTarget) => {
    setLastWorkspaceLaunchTargetId(target.id);
    writeStoredWorkspaceLaunchTargetId(target.id);
  }, []);

  useEffect(() => {
    if (!isMobileViewport) {
      setHeaderActions(null);
      return () => setHeaderActions(null);
    }

    setHeaderActions(
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => handleStartCreateRootEntry("file")}
          disabled={!workspaceRootPath}
          aria-label="New file"
          data-testid="org-workspaces-new-file-button"
        >
          <FilePlus2 className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => handleStartCreateRootEntry("folder")}
          disabled={!workspaceRootPath}
          aria-label="New folder"
          data-testid="org-workspaces-new-folder-button"
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </Button>
        {workspaceRootPath && selectedWorkspaceLaunchTarget ? (
          <div
            className="inline-flex h-8 items-stretch overflow-hidden rounded-md border border-[color:var(--border-base)] bg-[color:var(--surface-elevated)] shadow-none"
            data-testid="org-workspaces-launcher"
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-full rounded-none border-0 px-2.5 text-sm text-foreground shadow-none hover:border-0 hover:bg-[color:var(--surface-active)]"
              aria-label={`Open workspace in ${selectedWorkspaceLaunchTarget.label}`}
              onClick={() => void handleOpenWorkspace(selectedWorkspaceLaunchTarget)}
              disabled={openingWorkspaceTargetId !== null}
            >
              {openingWorkspaceTargetId === selectedWorkspaceLaunchTarget.id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <WorkspaceLaunchTargetIcon
                  target={selectedWorkspaceLaunchTarget}
                  className="h-3.5 w-3.5"
                />
              )}
              {selectedWorkspaceLaunchTarget.label}
            </Button>
            <div className="my-1 w-px bg-[color:var(--border-soft)]" aria-hidden="true" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-full w-8 rounded-none border-0 text-muted-foreground shadow-none hover:border-0 hover:bg-[color:var(--surface-active)] hover:text-foreground"
                  aria-label="Open workspace menu"
                  disabled={openingWorkspaceTargetId !== null}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuRadioGroup
                  value={selectedWorkspaceLaunchTarget.id}
                  onValueChange={(targetId) => {
                    const target = workspaceLaunchTargets.find((candidate) => candidate.id === targetId);
                    if (target) handleSelectWorkspaceLaunchTarget(target);
                  }}
                >
                  {workspaceLaunchTargets.map((target) => (
                    <DropdownMenuRadioItem
                      key={target.id}
                      value={target.id}
                      data-testid={`org-workspaces-launch-target-${target.id}`}
                    >
                      <WorkspaceLaunchTargetIcon target={target} className="h-4 w-4" />
                      <span>{target.label}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}
      </div>,
    );

    return () => setHeaderActions(null);
  }, [
    handleOpenWorkspace,
    handleSelectWorkspaceLaunchTarget,
    handleStartCreateRootEntry,
    isMobileViewport,
    openingWorkspaceTargetId,
    selectedWorkspaceLaunchTarget,
    setHeaderActions,
    workspaceLaunchTargets,
    workspaceRootPath,
  ]);

  if (!viewedOrganizationId || !viewedOrganization) {
    return <EmptyState icon={HardDrive} message={emptyMessage} />;
  }

  if (rootQuery.isLoading) {
    return <PageSkeleton variant="detail" />;
  }

  if (rootQuery.error) {
    return <p className="text-sm text-destructive">{rootQuery.error.message}</p>;
  }

  const workspace = rootQuery.data;
  if (!workspace) return null;

  const handleSelectFile = (filePath: string) => {
    setTabContextMenu(null);
    flushCurrentDraft();
    openWorkspaceFileTab(filePath);
    setActiveEntryPath(filePath);
    setSelectedFilePath(filePath);
    updateSelectedPath(searchParams, setSearchParams, filePath);
  };

  function handleCloseFileTab(filePath: string) {
    flushCurrentDraft();
    setOpenFilePaths((current) => {
      const next = current.filter((candidate) => candidate !== filePath);
      if (selectedFilePath === filePath) {
        const closedIndex = current.indexOf(filePath);
        const nextSelectedPath = next[Math.max(0, closedIndex - 1)] ?? next[0] ?? null;
        setSelectedFilePath(nextSelectedPath);
        setDraftFilePath(nextSelectedPath);
        updateSelectedPath(searchParams, setSearchParams, nextSelectedPath);
      }
      return next;
    });
  }

  function handleCloseOtherFileTabs(filePath: string) {
    flushCurrentDraft();
    setOpenFilePaths([filePath]);
    setSelectedFilePath(filePath);
    updateSelectedPath(searchParams, setSearchParams, filePath);
    setTabContextMenu(null);
  }

  function handleCloseTabsToRight(filePath: string) {
    flushCurrentDraft();
    setOpenFilePaths((current) => {
      const tabIndex = current.indexOf(filePath);
      if (tabIndex === -1) return current;
      const next = current.slice(0, tabIndex + 1);
      if (selectedFilePath && !next.includes(selectedFilePath)) {
        setSelectedFilePath(filePath);
        updateSelectedPath(searchParams, setSearchParams, filePath);
      }
      return next;
    });
    setTabContextMenu(null);
  }

  function handleCloseAllFileTabs() {
    flushCurrentDraft();
    setOpenFilePaths([]);
    setSelectedFilePath(null);
    setDraftFilePath(null);
    updateSelectedPath(searchParams, setSearchParams, null);
    setTabContextMenu(null);
  }

  const selectedFileDetail = fileQuery.data;
  const selectedEditorContent = draftFilePath === selectedFilePath
    ? draftContent
    : selectedFileDetail?.content ?? "";
  const selectedMarkdownParts = splitYamlFrontmatter(selectedEditorContent);
  const selectedMarkdownBodyForEditor = enrichAgentMentionMarkdown(
    selectedMarkdownParts.body,
    agentWorkspaceMentionOptions,
  );
  const selectedFileUsesMarkdownEditor = isWorkspaceMarkdownFilePath(selectedFilePath);
  const canEditSelectedFile = Boolean(
    selectedFilePath
    && selectedFileDetail
    && selectedFileDetail.content !== null
    && !selectedFileDetail.truncated,
  );
  const primaryIde = availableIdes[0] ?? null;
  const tabContextMenuIndex = tabContextMenu ? openFilePaths.indexOf(tabContextMenu.filePath) : -1;
  const canCloseOtherTabs = Boolean(tabContextMenu && openFilePaths.length > 1);
  const canCloseTabsToRight = tabContextMenuIndex >= 0 && tabContextMenuIndex < openFilePaths.length - 1;

  async function handleOpenFileInIde(filePath: string) {
    if (!primaryIde || !workspaceRootPath) return;
    const desktopShell = readDesktopShell();
    if (!desktopShell) return;
    if (typeof desktopShell.openWorkspaceFileInIde !== "function") return;

    try {
      await desktopShell.openWorkspaceFileInIde(workspaceRootPath, filePath, primaryIde.id);
      pushToast({
        title: "Opened in IDE",
        body: `Opened ${filePath} in ${primaryIde.label}.`,
        tone: "info",
      });
    } catch (error) {
      pushToast({
        title: "Failed to open in IDE",
        body: error instanceof Error ? error.message : "Could not open the selected workspace file in a local IDE.",
        tone: "error",
      });
    }
  }

  async function handleCopyWorkspacePath(entryPath: string) {
    const copyValue = joinWorkspacePath(workspaceRootPath, entryPath);
    const desktopShell = readDesktopShell();
    try {
      if (desktopShell?.copyText) {
        await desktopShell.copyText(copyValue);
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(copyValue);
      } else {
        throw new Error("Clipboard is not available in this environment.");
      }
      pushToast({
        title: "File path copied",
        body: copyValue,
        tone: "info",
      });
    } catch (error) {
      pushToast({
        title: "Failed to copy file path",
        body: error instanceof Error ? error.message : copyValue,
        tone: "error",
      });
    }
  }

  async function handleCopyEntryPath(entry: OrganizationWorkspaceFileEntry) {
    await handleCopyWorkspacePath(entry.path);
  }

  async function handleOpenEntryDefault(entry: OrganizationWorkspaceFileEntry) {
    const targetPath = joinWorkspacePath(workspaceRootPath, entry.path);
    const desktopShell = readDesktopShell();
    if (!desktopShell?.openPath) {
      return;
    }

    try {
      await desktopShell.openPath(targetPath);
      pushToast({
        title: entry.isDirectory ? "Opened folder" : "Opened in editor",
        body: targetPath,
        tone: "info",
      });
    } catch (error) {
      pushToast({
        title: entry.isDirectory ? "Failed to open folder" : "Failed to open in editor",
        body: error instanceof Error ? error.message : targetPath,
        tone: "error",
      });
    }
  }

  function handleOpenTabContextMenu(event: MouseEvent<HTMLElement>, filePath: string) {
    event.preventDefault();
    event.stopPropagation();
    handleSelectFile(filePath);
    setTabContextMenu({
      filePath,
      ...clampWorkspaceTabContextMenuPosition(event.clientX, event.clientY),
    });
  }

  function handleOpenFileTabDragStart(event: DragEvent<HTMLElement>, filePath: string) {
    if (openFilePaths.length < 2) {
      event.preventDefault();
      return;
    }
    setDraggedTabPath(filePath);
    setTabContextMenu(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(WORKSPACE_TAB_DND_MIME, filePath);
    event.dataTransfer.setData("text/plain", filePath);
  }

  function handleOpenFileTabDragOver(event: DragEvent<HTMLElement>, targetFilePath: string) {
    const sourceFilePath = draggedTabPath || event.dataTransfer.getData(WORKSPACE_TAB_DND_MIME);
    if (!sourceFilePath || sourceFilePath === targetFilePath) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const targetRect = event.currentTarget.getBoundingClientRect();
    const insertBeforeTarget = event.clientX < targetRect.left + targetRect.width / 2;
    setTabDropPreview({
      targetPath: targetFilePath,
      position: insertBeforeTarget ? "before" : "after",
    });
  }

  function handleOpenFileTabDragLeave(event: DragEvent<HTMLElement>, targetFilePath: string) {
    if (!didDragLeaveCurrentTarget(event)) return;
    setTabDropPreview((current) => current?.targetPath === targetFilePath ? null : current);
  }

  function handleOpenFileTabDrop(event: DragEvent<HTMLElement>, targetFilePath: string) {
    event.preventDefault();
    const sourceFilePath = draggedTabPath || event.dataTransfer.getData(WORKSPACE_TAB_DND_MIME);
    if (!sourceFilePath || sourceFilePath === targetFilePath) {
      setDraggedTabPath(null);
      setTabDropPreview(null);
      return;
    }
    const targetRect = event.currentTarget.getBoundingClientRect();
    const insertBeforeTarget = event.clientX < targetRect.left + targetRect.width / 2;
    setOpenFilePaths((current) => {
      const sourceIndex = current.indexOf(sourceFilePath);
      const targetIndex = current.indexOf(targetFilePath);
      if (sourceIndex === -1 || targetIndex === -1) return current;
      const withoutSource = current.filter((candidate) => candidate !== sourceFilePath);
      const targetIndexAfterRemoval = withoutSource.indexOf(targetFilePath);
      const insertIndex = targetIndexAfterRemoval + (insertBeforeTarget ? 0 : 1);
      const next = [...withoutSource];
      next.splice(insertIndex, 0, sourceFilePath);
      return next.join("\u0000") === current.join("\u0000") ? current : next;
    });
    setDraggedTabPath(null);
    setTabDropPreview(null);
  }

  function handleOpenFileTabDragEnd() {
    setDraggedTabPath(null);
    setTabDropPreview(null);
  }

  function handleMarkdownDraftChange(filePath: string | null, nextContent: string) {
    if (!filePath || selectedFilePathRef.current !== filePath) return;
    setDraftFilePath(filePath);
    setDraftContent(nextContent);
  }

  function handleMarkdownBodyDraftChange(filePath: string | null, nextBody: string) {
    if (!filePath || selectedFilePathRef.current !== filePath) return;
    handleMarkdownDraftChange(
      filePath,
      joinYamlFrontmatter(
        selectedMarkdownParts.frontmatter,
        selectedMarkdownParts.frontmatterSeparator,
        nextBody,
      ),
    );
  }

  function handleFrontmatterDraftChange(filePath: string | null, nextFrontmatter: string) {
    if (!filePath || selectedFilePathRef.current !== filePath) return;
    handleMarkdownDraftChange(
      filePath,
      joinYamlFrontmatter(
        nextFrontmatter,
        selectedMarkdownParts.frontmatterSeparator,
        selectedMarkdownParts.body,
      ),
    );
  }

  function handleStartRename(entry: OrganizationWorkspaceFileEntry) {
    if (isProtectedAgentWorkspaceContainerPath(entry.path)) return;
    setRenameTarget(entry);
    setRenameDraft(entry.name);
  }

  function handleStartDelete(entry: OrganizationWorkspaceFileEntry) {
    if (isProtectedAgentWorkspaceContainerPath(entry.path)) return;
    setDeleteTarget(entry);
  }

  function handleStartCreateEntry(entry: OrganizationWorkspaceFileEntry, kind: "file" | "folder") {
    if (!entry.isDirectory || !canCreateInsideWorkspaceDirectory(entry.path)) return;
    setCreateTarget({ parent: entry, kind });
    setCreateDraft(kind === "file" ? "untitled.md" : "new-folder");
  }

  function handleMoveEntry(
    entry: Pick<OrganizationWorkspaceFileEntry, "path" | "isDirectory">,
    destinationDirectoryPath: string,
  ) {
    setRootDropActive(false);
    if (!canDropWorkspaceEntryIntoDirectory(entry, destinationDirectoryPath)) return;
    flushCurrentDraft();
    moveWorkspaceEntry.mutate({ entry, destinationDirectoryPath });
  }

  function handleRootDragOver(event: DragEvent<HTMLElement>) {
    if (!hasWorkspaceDragPayload(event.dataTransfer)) return;
    if (isDraggingOverWorkspaceTreeEntry(event)) {
      setRootDropActive(false);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setRootDropActive(true);
  }

  function handleRootDragLeave(event: DragEvent<HTMLElement>) {
    if (didDragLeaveCurrentTarget(event)) {
      setRootDropActive(false);
    }
  }

  function handleRootDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setRootDropActive(false);
    const source = parseWorkspaceDragEntry(event);
    if (!source || !canDropWorkspaceEntryIntoDirectory(source, "")) return;
    handleMoveEntry(source, "");
  }

  const showInlineFiles = isMobileViewport;

  return (
    <>
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {!workspace.rootExists ? (
        <EmptyState
          icon={HardDrive}
          message={workspace.message ?? "The shared workspace root is not available on this machine yet."}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col lg:h-full lg:overflow-hidden lg:flex-row">
          {showInlineFiles ? (
            <section
              data-testid="org-workspaces-files-card"
              className={cn(
                "flex min-h-[320px] flex-col rounded-[var(--radius-lg)] border border-border bg-card transition-colors lg:min-h-0 lg:w-[320px] lg:flex-none",
                rootDropActive && "bg-[#2f80ed]/5 ring-1 ring-inset ring-[#2f80ed]/25",
              )}
              onDragOver={handleRootDragOver}
              onDragLeave={handleRootDragLeave}
              onDrop={handleRootDrop}
            >
              <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">Library</div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => handleStartCreateRootEntry("file")}
                        disabled={!workspaceRootPath}
                        aria-label="New file"
                        data-testid="org-workspaces-inline-new-file-button"
                      >
                        <FilePlus2 className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>New file</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => handleStartCreateRootEntry("folder")}
                        disabled={!workspaceRootPath}
                        aria-label="New folder"
                        data-testid="org-workspaces-inline-new-folder-button"
                      >
                        <FolderPlus className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>New folder</TooltipContent>
                  </Tooltip>
                </div>
              </div>
              <div
                ref={filesScrollRef}
                data-testid="org-workspaces-files-scroll"
                className="scrollbar-auto-hide min-h-0 flex-1 overflow-auto"
              >
                <div className="px-2 py-2">
                  {workspace.entries.length === 0 ? (
                    <div className="px-2 py-3 text-sm text-muted-foreground">
                      {workspace.message ?? "This folder is empty."}
                    </div>
                  ) : (
                    <ul className="space-y-0.5">
                      {workspace.entries.map((entry) => (
                        <WorkspaceTreeNode
                          key={entry.path}
                          orgId={viewedOrganizationId}
                          entry={entry}
                          selectedFilePath={selectedFilePath}
                          activeEntryPath={activeEntryPath}
                          onSelectFile={handleSelectFile}
                          onFocusEntry={setActiveEntryPath}
                          onCopyPath={(entryToCopy) => void handleCopyEntryPath(entryToCopy)}
                          onOpenEntry={readDesktopShell()?.openPath
                            ? (entryToOpen) => void handleOpenEntryDefault(entryToOpen)
                            : undefined}
                          onStartCreateEntry={handleStartCreateEntry}
                          onStartRename={handleStartRename}
                          onStartDelete={handleStartDelete}
                          onMoveEntry={handleMoveEntry}
                          expandedDirectories={expandedDirectories}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </section>
          ) : null}

          <section
            data-testid="org-workspaces-editor-card"
            className="flex min-h-[420px] min-w-0 flex-col bg-card lg:min-h-0 lg:flex-1"
          >
            <div
              data-testid="org-workspaces-editor-tabs"
              role="tablist"
              aria-label="Open files"
              className="rudder-doc-editor-tab-strip flex h-11 shrink-0 items-stretch justify-between bg-[color:var(--surface-page)]"
            >
              <div className="rudder-doc-editor-tab-scroller scrollbar-auto-hide flex min-w-0 flex-1 items-end gap-1 overflow-x-auto pl-0 pr-2 pt-1">
                {openFilePaths.length > 0 ? (
                  openFilePaths.map((filePath, index) => {
                    const active = selectedFilePath === filePath;
                    const first = index === 0;
                    const dragging = draggedTabPath === filePath;
                    const dropBefore = tabDropPreview?.targetPath === filePath && tabDropPreview.position === "before";
                    const dropAfter = tabDropPreview?.targetPath === filePath && tabDropPreview.position === "after";
                    return (
                      <div
                        key={filePath}
                        data-testid={`org-workspaces-editor-tab-${filePath}`}
                        draggable={openFilePaths.length > 1}
                        onDragStart={(event) => handleOpenFileTabDragStart(event, filePath)}
                        onDragOver={(event) => handleOpenFileTabDragOver(event, filePath)}
                        onDragLeave={(event) => handleOpenFileTabDragLeave(event, filePath)}
                        onDrop={(event) => handleOpenFileTabDrop(event, filePath)}
                        onDragEnd={handleOpenFileTabDragEnd}
                        onContextMenu={(event) => handleOpenTabContextMenu(event, filePath)}
                        className={cn(
                          "rudder-doc-editor-tab group relative flex min-w-[132px] max-w-[248px] shrink-0 cursor-default items-center border px-1 transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]",
                          active
                            ? "rudder-doc-editor-tab--active mb-[-1px] h-10 overflow-visible rounded-t-[24px] border-[color:var(--border-base)] border-b-[color:var(--surface-elevated)] bg-[color:var(--surface-elevated)] text-foreground shadow-[0_-1px_0_color-mix(in_oklab,var(--foreground)_6%,transparent)]"
                            : "mb-1 h-9 translate-y-px overflow-hidden rounded-[18px] border-transparent text-muted-foreground hover:translate-y-0 hover:bg-[color:var(--surface-active)] hover:text-foreground hover:shadow-[0_1px_2px_color-mix(in_oklab,var(--foreground)_8%,transparent)]",
                          active && first && "rudder-doc-editor-tab--first-active",
                          dragging && "opacity-55",
                          dropBefore && !dragging && "rudder-doc-editor-tab--drop-before",
                          dropAfter && !dragging && "rudder-doc-editor-tab--drop-after",
                        )}
                      >
                        <button
                          type="button"
                          role="tab"
                          aria-selected={active}
                          draggable={false}
                          className="min-w-0 flex-1 truncate rounded-[10px] px-2 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                          title={filePath}
                          onClick={() => handleSelectFile(filePath)}
                          onContextMenu={(event) => handleOpenTabContextMenu(event, filePath)}
                        >
                          {displayWorkspaceFileTabLabel(filePath)}
                        </button>
                        <button
                          type="button"
                          draggable={false}
                          className={cn(
                            "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground",
                            active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                          )}
                          aria-label={`Close ${filePath}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            handleCloseFileTab(filePath);
                          }}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    );
                  })
                ) : (
                  <div className="mb-1 flex h-9 items-center px-2 text-sm text-muted-foreground">No file open</div>
                )}
              </div>
              {workspaceRootPath && selectedWorkspaceLaunchTarget ? (
                <div className="flex shrink-0 items-center border-l border-border px-2 text-xs text-muted-foreground">
                  <div
                    className="inline-flex h-8 items-stretch overflow-hidden rounded-[18px] border border-[color:var(--border-base)] bg-[color:var(--surface-elevated)] shadow-none"
                    data-testid="org-workspaces-editor-launcher"
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-full rounded-none border-0 px-2 text-sm text-foreground shadow-none hover:border-0 hover:bg-[color:var(--surface-active)]"
                      aria-label={`Open workspace in ${selectedWorkspaceLaunchTarget.label}`}
                      onClick={() => void handleOpenWorkspace(selectedWorkspaceLaunchTarget)}
                      disabled={openingWorkspaceTargetId !== null}
                    >
                      {openingWorkspaceTargetId === selectedWorkspaceLaunchTarget.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <WorkspaceLaunchTargetIcon
                          target={selectedWorkspaceLaunchTarget}
                          className="h-3.5 w-3.5"
                        />
                      )}
                      <span className="ml-1.5 max-w-20 truncate">{selectedWorkspaceLaunchTarget.label}</span>
                    </Button>
                    <div className="my-1 w-px bg-[color:var(--border-soft)]" aria-hidden="true" />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-full w-8 rounded-none border-0 text-muted-foreground shadow-none hover:border-0 hover:bg-[color:var(--surface-active)] hover:text-foreground"
                        aria-label="Open workspace menu"
                        disabled={openingWorkspaceTargetId !== null}
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuRadioGroup
                          value={selectedWorkspaceLaunchTarget.id}
                          onValueChange={(targetId) => {
                            const target = workspaceLaunchTargets.find((candidate) => candidate.id === targetId);
                            if (target) handleSelectWorkspaceLaunchTarget(target);
                          }}
                        >
                          {workspaceLaunchTargets.map((target) => (
                            <DropdownMenuRadioItem
                              key={target.id}
                              value={target.id}
                              data-testid={`org-workspaces-editor-launch-target-${target.id}`}
                            >
                              <WorkspaceLaunchTargetIcon target={target} className="h-4 w-4" />
                              <span>{target.label}</span>
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              ) : null}
            </div>
            {selectedFilePath ? (
              <div
                data-testid="org-workspaces-path-breadcrumb"
                className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-[color:var(--surface-elevated)] px-3 text-xs text-muted-foreground"
                aria-label="File path"
              >
                {workspacePathBreadcrumb(selectedFilePath, agentWorkspaceEntryByName).map((part, index, parts) => {
                  const isLast = index === parts.length - 1;
                  return (
                    <div key={part.path} className="flex min-w-0 items-center gap-1">
                      {index > 0 ? <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/70" /> : null}
                      <button
                        type="button"
                        className={cn(
                          "inline-flex min-w-0 items-center gap-1 rounded-[4px] px-1.5 py-1 text-left transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                          isLast && "font-medium text-foreground",
                        )}
                        title={part.path}
                        onClick={() => {
                          if (part.isFile) {
                            handleSelectFile(part.path);
                          } else {
                            focusWorkspaceTreeEntry(part.path);
                          }
                        }}
                      >
                        {part.kind === "agent_workspace" ? (
                          <span
                            data-testid="org-workspaces-path-breadcrumb-agent-icon"
                            className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center"
                          >
                            <AgentIcon icon={part.agentIcon} role={part.agentRole} className="h-3.5 w-3.5 text-[12px]" />
                          </span>
                        ) : part.kind === "agents_root" ? (
                          <Bot className="h-3.5 w-3.5 shrink-0" />
                        ) : part.isFile ? (
                          <FileCode2 className="h-3.5 w-3.5 shrink-0" />
                        ) : (
                          <Folder className="h-3.5 w-3.5 shrink-0" />
                        )}
                        <span className="truncate">{part.label}</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-hidden">
              {!selectedFilePath ? (
                <div className="px-4 py-6 text-sm text-muted-foreground">
                  {noSelectionMessage}
                </div>
              ) : fileQuery.isLoading ? (
                <div className="px-4 py-6 text-sm text-muted-foreground">Loading file…</div>
              ) : fileQuery.error ? (
                <div className="px-4 py-6 text-sm text-destructive">{fileQuery.error.message}</div>
              ) : canEditSelectedFile ? (
                <div className="flex h-full min-h-0 flex-col">
                  {selectedFileDetail?.message ? (
                    <div className="shrink-0 border-b border-border px-4 py-2 text-xs text-muted-foreground">
                      {selectedFileDetail.message}
                    </div>
                  ) : null}
                  {saveWorkspaceFile.isError ? (
                    <div className="shrink-0 border-b border-border px-4 py-2 text-xs text-destructive">
                      {saveWorkspaceFile.error instanceof Error
                        ? saveWorkspaceFile.error.message
                        : "Failed to save workspace file."}
                    </div>
                  ) : null}
                  {selectedFileUsesMarkdownEditor ? (
                    <div
                      ref={editorScrollRef}
                      data-testid="org-workspaces-markdown-editor"
                      className="scrollbar-auto-hide min-h-[280px] flex-1 overflow-auto bg-[color:var(--surface-elevated)]"
                    >
                      <div className="mx-auto min-h-full w-full max-w-[880px] px-8 py-8">
                        {selectedMarkdownParts.frontmatter !== null ? (
                          <details
                            className="group mb-6 rounded-md border border-[color:var(--border-soft)] bg-[color:var(--surface-page)]"
                            data-testid="org-workspaces-frontmatter-editor"
                          >
                            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                              <span>Frontmatter</span>
                              <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
                            </summary>
                            <textarea
                              value={selectedMarkdownParts.frontmatter}
                              onChange={(event) => handleFrontmatterDraftChange(selectedFilePath, event.target.value)}
                              spellCheck={false}
                              className="block min-h-28 w-full resize-y border-t border-[color:var(--border-soft)] bg-transparent px-3 py-2 font-mono text-xs leading-5 text-foreground outline-none"
                              aria-label="Frontmatter"
                            />
                          </details>
                        ) : null}
                        <MarkdownEditor
                          key={selectedFilePath}
                          engine="milkdown"
                          value={selectedMarkdownBodyForEditor}
                          onChange={(nextContent) => handleMarkdownBodyDraftChange(selectedFilePath, nextContent)}
                          mentions={agentWorkspaceMentionOptions}
                          bordered={false}
                          placeholder="Write in Markdown..."
                          contentClassName="rudder-library-document-editor min-h-[420px] text-[15px] leading-7 text-foreground"
                        />
                      </div>
                    </div>
                  ) : (
                    <textarea
                      data-testid="org-workspaces-editor-textarea"
                      value={selectedEditorContent}
                      onChange={(event) => handleMarkdownDraftChange(selectedFilePath, event.target.value)}
                      spellCheck={false}
                      ref={editorScrollRef}
                      className="scrollbar-auto-hide block min-h-[280px] flex-1 overflow-auto border-0 bg-transparent px-4 py-4 font-mono text-sm leading-6 text-foreground outline-none"
                    />
                  )}
                </div>
              ) : selectedFileDetail?.previewKind === "image" && selectedFileDetail.contentPath ? (
                <div
                  ref={editorScrollRef}
                  data-testid="org-workspaces-image-preview-scroll"
                  className="scrollbar-auto-hide flex h-full min-h-[420px] items-center justify-center overflow-auto bg-accent/10 p-4"
                >
                  <img
                    data-testid="org-workspaces-image-preview"
                    src={selectedFileDetail.contentPath}
                    alt={selectedFilePath ?? "Workspace image preview"}
                    className="max-h-full max-w-full rounded-md object-contain shadow-sm"
                  />
                </div>
              ) : selectedFileDetail?.content ? (
                <div
                  ref={editorScrollRef}
                  data-testid="org-workspaces-readonly-preview-scroll"
                  className="scrollbar-auto-hide h-full min-h-0 overflow-auto"
                >
                  <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
                    {selectedFileDetail.message ?? "This file is rendered read-only in Library."}
                  </div>
                  <pre className="overflow-x-auto px-4 py-4 text-xs leading-6 text-foreground">
                    <code>{selectedFileDetail.content}</code>
                  </pre>
                </div>
              ) : (
                <div className="px-4 py-6 text-sm text-muted-foreground">
                  {selectedFileDetail?.message ?? "This file cannot be rendered in Library."}
                </div>
              )}
            </div>
          </section>

        </div>
      )}
      </div>

      {tabContextMenu && typeof document !== "undefined" ? createPortal(
        <div
          role="menu"
          data-testid="org-workspaces-tab-context-menu"
          className="motion-chat-composer-menu-pop surface-overlay fixed z-50 w-[220px] overflow-hidden rounded-md border border-border p-1 text-sm text-foreground shadow-lg"
          style={{ left: tabContextMenu.left, top: tabContextMenu.top }}
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            role="menuitem"
            data-chat-composer-menu-item
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
            onClick={() => {
              void handleCopyWorkspacePath(tabContextMenu.filePath);
              setTabContextMenu(null);
            }}
          >
            <Copy className="h-4 w-4 text-muted-foreground" />
            Copy file path
          </button>
          <button
            type="button"
            role="menuitem"
            data-chat-composer-menu-item
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
            disabled={!primaryIde || !workspaceRootPath}
            onClick={() => {
              void handleOpenFileInIde(tabContextMenu.filePath);
              setTabContextMenu(null);
            }}
          >
            <ExternalLink className="h-4 w-4 text-muted-foreground" />
            Open in {primaryIde?.label ?? "IDE"}
          </button>
          <div className="-mx-1 my-1 h-px bg-border" />
          <button
            type="button"
            role="menuitem"
            data-chat-composer-menu-item
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
            onClick={() => {
              handleCloseFileTab(tabContextMenu.filePath);
              setTabContextMenu(null);
            }}
          >
            <X className="h-4 w-4 text-muted-foreground" />
            Close
          </button>
          <button
            type="button"
            role="menuitem"
            data-chat-composer-menu-item
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
            disabled={!canCloseOtherTabs}
            onClick={() => handleCloseOtherFileTabs(tabContextMenu.filePath)}
          >
            Close others
          </button>
          <button
            type="button"
            role="menuitem"
            data-chat-composer-menu-item
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
            disabled={!canCloseTabsToRight}
            onClick={() => handleCloseTabsToRight(tabContextMenu.filePath)}
          >
            Close tabs to the right
          </button>
          <button
            type="button"
            role="menuitem"
            data-chat-composer-menu-item
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
            onClick={handleCloseAllFileTabs}
          >
            Close all
          </button>
        </div>,
        document.body,
      ) : null}

      <Dialog open={createTarget !== null} onOpenChange={(open) => {
        if (!open && !createWorkspaceEntry.isPending) {
          setCreateTarget(null);
          setCreateDraft("");
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{createTarget?.kind === "folder" ? "New folder" : "New file"}</DialogTitle>
            <DialogDescription>
              Create inside {createTarget?.parent.path ?? "this folder"}.
            </DialogDescription>
          </DialogHeader>
          <label className="space-y-1.5">
            <span className="text-xs text-muted-foreground">Name</span>
            <Input
              value={createDraft}
              onChange={(event) => setCreateDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !createTarget || !isValidWorkspaceEntryName(createDraft)) return;
                event.preventDefault();
                createWorkspaceEntry.mutate({
                  parent: createTarget.parent,
                  kind: createTarget.kind,
                  name: createDraft,
                });
              }}
              autoFocus
            />
          </label>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setCreateTarget(null);
                setCreateDraft("");
              }}
              disabled={createWorkspaceEntry.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (!createTarget) return;
                createWorkspaceEntry.mutate({
                  parent: createTarget.parent,
                  kind: createTarget.kind,
                  name: createDraft,
                });
              }}
              disabled={!createTarget || !isValidWorkspaceEntryName(createDraft) || createWorkspaceEntry.isPending}
            >
              {createWorkspaceEntry.isPending
                ? "Creating..."
                : createTarget?.kind === "folder"
                  ? "Create folder"
                  : "Create file"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameTarget !== null} onOpenChange={(open) => {
        if (!open && !renameWorkspaceEntry.isPending) {
          setRenameTarget(null);
          setRenameDraft("");
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename entry</DialogTitle>
            <DialogDescription>
              Rename this workspace file or folder without changing its parent folder.
            </DialogDescription>
          </DialogHeader>
          <label className="space-y-1.5">
            <span className="text-xs text-muted-foreground">Name</span>
            <Input
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !renameTarget) return;
                event.preventDefault();
                renameWorkspaceEntry.mutate({ entry: renameTarget, name: renameDraft });
              }}
              autoFocus
            />
          </label>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setRenameTarget(null);
                setRenameDraft("");
              }}
              disabled={renameWorkspaceEntry.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (!renameTarget) return;
                renameWorkspaceEntry.mutate({ entry: renameTarget, name: renameDraft });
              }}
              disabled={
                !renameTarget
                || renameDraft.trim().length === 0
                || renameDraft.trim() === renameTarget.name
                || renameWorkspaceEntry.isPending
              }
            >
              {renameWorkspaceEntry.isPending ? "Renaming..." : "Rename"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => {
        if (!open && !deleteWorkspaceEntry.isPending) setDeleteTarget(null);
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete entry</DialogTitle>
            <DialogDescription>
              This will permanently delete {deleteTarget?.path ?? "this entry"} from the organization workspace.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleteWorkspaceEntry.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (!deleteTarget) return;
                deleteWorkspaceEntry.mutate(deleteTarget);
              }}
              disabled={!deleteTarget || deleteWorkspaceEntry.isPending}
            >
              {deleteWorkspaceEntry.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function OrganizationWorkspaces() {
  return <OrganizationWorkspaceBrowser />;
}
