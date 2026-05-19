import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OrganizationWorkspaceFileDetail, OrganizationWorkspaceFileEntry } from "@rudderhq/shared";
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
  Folder,
  FolderOpen,
  FileCode2,
  Image as ImageIcon,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Loader2,
  Terminal,
  Trash2,
} from "lucide-react";

const WORKSPACE_LAUNCH_TARGET_STORAGE_KEY = "rudder.workspace.launchTargetId";
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

function inferLanguageFromPath(filePath: string | null) {
  if (!filePath) return "text";
  const normalized = filePath.toLowerCase();
  if (normalized.endsWith(".md")) return "markdown";
  if (normalized.endsWith(".ts")) return "typescript";
  if (normalized.endsWith(".tsx")) return "tsx";
  if (normalized.endsWith(".js")) return "javascript";
  if (normalized.endsWith(".jsx")) return "jsx";
  if (normalized.endsWith(".json")) return "json";
  if (normalized.endsWith(".yml") || normalized.endsWith(".yaml")) return "yaml";
  if (normalized.endsWith(".sh")) return "bash";
  if (normalized.endsWith(".py")) return "python";
  if (normalized.endsWith(".html")) return "html";
  if (normalized.endsWith(".css")) return "css";
  return "text";
}

function displayWorkspaceEntryLabel(entry: OrganizationWorkspaceFileEntry) {
  return entry.displayLabel?.trim() || entry.name;
}

function isProtectedAgentWorkspacePath(filePath: string) {
  return filePath === "agents" || filePath.startsWith("agents/");
}

function joinWorkspacePath(rootPath: string | null, entryPath: string) {
  if (!rootPath) return entryPath;
  return `${rootPath.replace(/\/+$/, "")}/${entryPath}`;
}

function createUntitledDocumentPath() {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")
    .toLowerCase();
  return `docs/untitled-${stamp}.md`;
}

function displayWorkspaceFileFormat(filePath: string | null, detail: OrganizationWorkspaceFileDetail | undefined) {
  if (detail?.previewKind === "image" && detail.contentType) {
    const subtype = detail.contentType.split("/").at(-1) ?? "image";
    if (subtype === "svg+xml") return "svg";
    if (subtype === "x-icon") return "ico";
    return subtype;
  }

  const extension = getWorkspaceFileExtension(filePath);
  if (extension && WORKSPACE_IMAGE_FILE_EXTENSIONS.has(extension)) return extension.slice(1);
  if (detail?.contentType === "application/pdf") return "pdf";
  return inferLanguageFromPath(filePath);
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
  onSelectFile,
  onCopyPath,
  onStartRename,
  onStartDelete,
  expandedDirectories,
  depth,
}: {
  orgId: string;
  directoryPath: string;
  selectedFilePath: string | null;
  onSelectFile: (filePath: string) => void;
  onCopyPath: (entry: OrganizationWorkspaceFileEntry) => void;
  onStartRename: (entry: OrganizationWorkspaceFileEntry) => void;
  onStartDelete: (entry: OrganizationWorkspaceFileEntry) => void;
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
          onSelectFile={onSelectFile}
          onCopyPath={onCopyPath}
          onStartRename={onStartRename}
          onStartDelete={onStartDelete}
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
  onSelectFile,
  onCopyPath,
  onStartRename,
  onStartDelete,
  expandedDirectories,
  depth = 0,
}: {
  orgId: string;
  entry: OrganizationWorkspaceFileEntry;
  selectedFilePath: string | null;
  onSelectFile: (filePath: string) => void;
  onCopyPath: (entry: OrganizationWorkspaceFileEntry) => void;
  onStartRename: (entry: OrganizationWorkspaceFileEntry) => void;
  onStartDelete: (entry: OrganizationWorkspaceFileEntry) => void;
  expandedDirectories: Set<string>;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(expandedDirectories.has(entry.path));
  const primaryLabel = displayWorkspaceEntryLabel(entry);
  const isAgentWorkspace = entry.entityType === "agent_workspace";
  const isAgentsRoot = entry.path === "agents";
  const isProtectedPath = isProtectedAgentWorkspacePath(entry.path);

  const actionMenu = (
    <DropdownMenu>
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
      <DropdownMenuContent align="end" className="w-44" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuItem onSelect={() => onCopyPath(entry)}>
          <Copy className="h-3.5 w-3.5" />
          Copy file path
        </DropdownMenuItem>
        {!isProtectedPath ? (
          <>
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
          className="group flex w-full items-center rounded-md pr-1 text-sm text-foreground hover:bg-accent/60"
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
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
            onSelectFile={onSelectFile}
            onCopyPath={onCopyPath}
            onStartRename={onStartRename}
            onStartDelete={onStartDelete}
            expandedDirectories={expandedDirectories}
            depth={depth + 1}
          />
        ) : null}
      </li>
    );
  }

  const isSelected = selectedFilePath === entry.path;
  const FileIcon = isWorkspaceImageFilePath(entry.path) ? ImageIcon : FileCode2;
  return (
    <li>
      <div
        className={`group flex w-full items-center rounded-md pr-1 text-sm transition-colors ${
          isSelected ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        }`}
        style={{ paddingLeft: `${depth * 14 + 23}px` }}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-0 pr-2 text-left"
          onClick={() => onSelectFile(entry.path)}
        >
          <FileIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{primaryLabel}</span>
        </button>
        {actionMenu}
      </div>
    </li>
  );
}

export function OrganizationWorkspaceBrowser({
  breadcrumbLabel = "Workspaces",
  emptyMessage = "Select an organization to browse its shared workspace.",
  filesTitle = "Files",
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
  filesTitle?: string;
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
  const [draftContent, setDraftContent] = useState("");
  const [refreshingWorkspace, setRefreshingWorkspace] = useState(false);
  const [availableIdes, setAvailableIdes] = useState<DesktopIdeTarget[]>([]);
  const [openingInIde, setOpeningInIde] = useState(false);
  const [workspaceLaunchTargets, setWorkspaceLaunchTargets] = useState<DesktopWorkspaceLaunchTarget[]>([]);
  const [lastWorkspaceLaunchTargetId, setLastWorkspaceLaunchTargetId] = useState<
    DesktopWorkspaceLaunchTarget["id"] | null
  >(() => readStoredWorkspaceLaunchTargetId());
  const [openingWorkspaceTargetId, setOpeningWorkspaceTargetId] = useState<
    DesktopWorkspaceLaunchTarget["id"] | null
  >(null);
  const [renameTarget, setRenameTarget] = useState<OrganizationWorkspaceFileEntry | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<OrganizationWorkspaceFileEntry | null>(null);
  const filesScrollRef = useScrollbarActivityRef("org-workspaces:files");
  const editorScrollRef = useScrollbarActivityRef(
    selectedFilePath ? `org-workspaces:editor:${selectedFilePath}` : "org-workspaces:editor",
  );

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

  const fileQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceFile(viewedOrganizationId ?? "__none__", selectedFilePath ?? ""),
    queryFn: () => organizationsApi.readWorkspaceFile(viewedOrganizationId!, selectedFilePath!),
    enabled: !!viewedOrganizationId && !!selectedFilePath,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    setSelectedFilePath(requestedFilePath);
  }, [requestedFilePath, viewedOrganizationId]);

  useEffect(() => {
    if (selectedFilePath) return;
    const preferredFile = rootQuery.data?.entries.find((entry) => !entry.isDirectory);
    if (preferredFile) {
      setSelectedFilePath(preferredFile.path);
      updateSelectedPath(searchParams, setSearchParams, preferredFile.path);
    }
  }, [rootQuery.data?.entries, searchParams, selectedFilePath, setSearchParams]);

  useEffect(() => {
    if (!selectedFilePath) {
      setDraftContent("");
      return;
    }
    if (!fileQuery.data || fileQuery.data.filePath !== selectedFilePath) return;
    setDraftContent(fileQuery.data.content ?? "");
  }, [fileQuery.data, selectedFilePath]);

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
      queryClient.setQueryData(
        queryKeys.organizations.workspaceFile(viewedOrganizationId, detail.filePath),
        detail,
      );
      setDraftContent(detail.content ?? "");
      pushToast({
        title: "Workspace file saved",
        body: detail.filePath,
      });
    },
  });

  const invalidateWorkspaceBrowser = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["organizations", viewedOrganizationId, "workspace-files"] }),
      queryClient.invalidateQueries({ queryKey: ["organizations", viewedOrganizationId, "workspace-file"] }),
    ]);
  }, [queryClient, viewedOrganizationId]);

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
        const nextSelectedPath = selectedFilePath === previousPath
          ? result.path
          : selectedFilePath.startsWith(`${previousPath}/`)
            ? `${result.path}${selectedFilePath.slice(previousPath.length)}`
            : selectedFilePath;
        if (nextSelectedPath !== selectedFilePath) {
          setSelectedFilePath(nextSelectedPath);
          updateSelectedPath(searchParams, setSearchParams, nextSelectedPath);
        }
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

  const createWorkspaceDocument = useMutation({
    mutationFn: () => {
      const filePath = createUntitledDocumentPath();
      return organizationsApi.createWorkspaceFile(viewedOrganizationId!, {
        filePath,
        content: "# Untitled document\n\n",
      });
    },
    onSuccess: (detail) => {
      if (!viewedOrganizationId) return;
      queryClient.setQueryData(
        queryKeys.organizations.workspaceFile(viewedOrganizationId, detail.filePath),
        detail,
      );
      void invalidateWorkspaceBrowser();
      setSelectedFilePath(detail.filePath);
      updateSelectedPath(searchParams, setSearchParams, detail.filePath);
      setDraftContent(detail.content ?? "");
      pushToast({
        title: "Library doc created",
        body: detail.filePath,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to create Library doc",
        tone: "error",
      });
    },
  });
  const createWorkspaceDocumentMutate = createWorkspaceDocument.mutate;
  const isCreatingWorkspaceDocument = createWorkspaceDocument.isPending;

  const deleteWorkspaceEntry = useMutation({
    mutationFn: (entry: OrganizationWorkspaceFileEntry) =>
      organizationsApi.deleteWorkspaceEntry(viewedOrganizationId!, entry.path),
    onSuccess: (result) => {
      if (!viewedOrganizationId) return;
      void invalidateWorkspaceBrowser();
      setDeleteTarget(null);
      if (selectedFilePath && (selectedFilePath === result.path || selectedFilePath.startsWith(`${result.path}/`))) {
        setSelectedFilePath(null);
        updateSelectedPath(searchParams, setSearchParams, null);
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

  const refreshWorkspace = useCallback(async () => {
    setRefreshingWorkspace(true);
    try {
      await invalidateWorkspaceBrowser();
    } finally {
      setRefreshingWorkspace(false);
    }
  }, [invalidateWorkspaceBrowser]);

  const workspaceRootPath = rootQuery.data?.rootExists ? rootQuery.data.rootPath : null;
  const selectedWorkspaceLaunchTarget = (
    lastWorkspaceLaunchTargetId
      ? workspaceLaunchTargets.find((target) => target.id === lastWorkspaceLaunchTargetId)
      : null
  ) ?? workspaceLaunchTargets[0] ?? null;

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
    setHeaderActions(
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => createWorkspaceDocumentMutate()}
          disabled={!workspaceRootPath || isCreatingWorkspaceDocument}
          aria-label="New Library doc"
        >
          {isCreatingWorkspaceDocument ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="mr-1.5 h-3.5 w-3.5" />
          )}
          New doc
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
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void refreshWorkspace()}
          disabled={refreshingWorkspace}
        >
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshingWorkspace ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>,
    );

    return () => setHeaderActions(null);
  }, [
    handleOpenWorkspace,
    handleSelectWorkspaceLaunchTarget,
    createWorkspaceDocumentMutate,
    isCreatingWorkspaceDocument,
    openingWorkspaceTargetId,
    refreshWorkspace,
    refreshingWorkspace,
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
    setSelectedFilePath(filePath);
    updateSelectedPath(searchParams, setSearchParams, filePath);
  };

  const selectedFileDetail = fileQuery.data;
  const canEditSelectedFile = Boolean(
    selectedFilePath
    && selectedFileDetail
    && selectedFileDetail.content !== null
    && !selectedFileDetail.truncated,
  );
  const hasUnsavedChanges = canEditSelectedFile && draftContent !== (selectedFileDetail?.content ?? "");
  const selectedFormatLabel = displayWorkspaceFileFormat(selectedFilePath, selectedFileDetail);
  const primaryIde = availableIdes[0] ?? null;
  const hasLoadedSelectedFile = Boolean(
    selectedFilePath
    && selectedFileDetail
    && selectedFileDetail.filePath === selectedFilePath,
  );
  const canOpenInIde = Boolean(
    primaryIde
    && workspaceRootPath
    && hasLoadedSelectedFile,
  );

  async function handleOpenInIde() {
    if (!primaryIde || !selectedFilePath || !workspaceRootPath || !hasLoadedSelectedFile) return;
    const desktopShell = readDesktopShell();
    if (!desktopShell) return;
    if (typeof desktopShell.openWorkspaceFileInIde !== "function") return;

    setOpeningInIde(true);
    try {
      await desktopShell.openWorkspaceFileInIde(workspaceRootPath, selectedFilePath, primaryIde.id);
      pushToast({
        title: "Opened in IDE",
        body: `Opened ${selectedFilePath} in ${primaryIde.label}.`,
        tone: "info",
      });
    } catch (error) {
      pushToast({
        title: "Failed to open in IDE",
        body: error instanceof Error ? error.message : "Could not open the selected workspace file in a local IDE.",
        tone: "error",
      });
    } finally {
      setOpeningInIde(false);
    }
  }

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

  function handleStartRename(entry: OrganizationWorkspaceFileEntry) {
    if (isProtectedAgentWorkspacePath(entry.path)) return;
    setRenameTarget(entry);
    setRenameDraft(entry.name);
  }

  function handleStartDelete(entry: OrganizationWorkspaceFileEntry) {
    if (isProtectedAgentWorkspacePath(entry.path)) return;
    setDeleteTarget(entry);
  }

  return (
    <>
      <div className="flex min-h-full flex-col gap-4 lg:h-full lg:min-h-0 lg:overflow-hidden">
      {!workspace.rootExists ? (
        <EmptyState
          icon={HardDrive}
          message={workspace.message ?? "The shared workspace root is not available on this machine yet."}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 lg:h-full lg:overflow-hidden lg:flex-row">
          <section
            data-testid="org-workspaces-files-card"
            className="flex min-h-[320px] flex-col rounded-[var(--radius-lg)] border border-border bg-card lg:min-h-0 lg:w-[320px] lg:flex-none"
          >
            <div className="border-b border-border px-4 py-3">
              <div className="text-sm font-medium">{filesTitle}</div>
              <div className="text-xs text-muted-foreground">
                {workspace.directoryPath ? workspace.directoryPath : "/"}
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
                        onSelectFile={handleSelectFile}
                        onCopyPath={(entryToCopy) => void handleCopyEntryPath(entryToCopy)}
                        onStartRename={handleStartRename}
                        onStartDelete={handleStartDelete}
                        expandedDirectories={expandedDirectories}
                      />
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </section>

          <section
            data-testid="org-workspaces-editor-card"
            className="flex min-h-[420px] min-w-0 flex-col rounded-[var(--radius-lg)] border border-border bg-card lg:min-h-0 lg:flex-1"
          >
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
              <div>
                <div className="text-sm font-medium">{editorTitle}</div>
                <div className="text-xs text-muted-foreground">
                  {selectedFilePath ?? "Select a file to edit"}
                </div>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {selectedFilePath ? (
                  <span className="rounded-full border border-border px-2 py-0.5 font-mono">
                    {selectedFormatLabel}
                  </span>
                ) : null}
                {canOpenInIde && primaryIde ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        aria-label={`Open in ${primaryIde.label}`}
                        data-testid="org-workspaces-open-in-ide-button"
                        onClick={() => void handleOpenInIde()}
                        disabled={openingInIde}
                      >
                        {openingInIde ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <ExternalLink className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{`Open in ${primaryIde.label}`}</TooltipContent>
                  </Tooltip>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    if (!selectedFilePath) return;
                    saveWorkspaceFile.mutate({ filePath: selectedFilePath, content: draftContent });
                  }}
                  disabled={!selectedFilePath || !hasUnsavedChanges || saveWorkspaceFile.isPending}
                >
                  {saveWorkspaceFile.isPending ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Save
                </Button>
              </div>
            </div>
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
                  <textarea
                    data-testid="org-workspaces-editor-textarea"
                    value={draftContent}
                    onChange={(event) => setDraftContent(event.target.value)}
                    spellCheck={false}
                    ref={editorScrollRef}
                    className="scrollbar-auto-hide block min-h-[280px] flex-1 overflow-auto border-0 bg-transparent px-4 py-4 font-mono text-sm leading-6 text-foreground outline-none"
                  />
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
                    {selectedFileDetail.message ?? "This file is shown read-only here."}
                  </div>
                  <pre className="overflow-x-auto px-4 py-4 text-xs leading-6 text-foreground">
                    <code>{selectedFileDetail.content}</code>
                  </pre>
                </div>
              ) : (
                <div className="px-4 py-6 text-sm text-muted-foreground">
                  {selectedFileDetail?.message ?? "This file cannot be previewed."}
                </div>
              )}
            </div>
          </section>

        </div>
      )}
      </div>

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
