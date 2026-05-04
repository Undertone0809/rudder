import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { OrganizationWorkspaceFileEntry } from "@rudderhq/shared";
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  PanelLeftClose,
} from "lucide-react";
import { organizationsApi } from "@/api/orgs";
import { useSidebar } from "@/context/SidebarContext";
import { useViewedOrganization } from "@/hooks/useViewedOrganization";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useSearchParams } from "@/lib/router";

function parentDirectories(filePath: string) {
  const segments = filePath.split("/").filter(Boolean);
  const parents: string[] = [];
  for (let index = 0; index < segments.length - 1; index += 1) {
    parents.push(segments.slice(0, index + 1).join("/"));
  }
  return new Set(parents);
}

function formatBackupTime(value: string | null) {
  if (!value) return "Running";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatFileCount(value: number) {
  return `${value} ${value === 1 ? "file" : "files"}`;
}

function selectFilePath(searchParams: URLSearchParams, setSearchParams: ReturnType<typeof useSearchParams>[1], filePath: string) {
  const next = new URLSearchParams(searchParams);
  next.set("file", filePath);
  setSearchParams(next, { replace: true });
}

function BackupDirectoryChildren({
  orgId,
  backupId,
  directoryPath,
  selectedFilePath,
  onSelectFile,
  expandedDirectories,
  depth,
}: {
  orgId: string;
  backupId: string;
  directoryPath: string;
  selectedFilePath: string | null;
  onSelectFile: (filePath: string) => void;
  expandedDirectories: Set<string>;
  depth: number;
}) {
  const { data } = useQuery({
    queryKey: queryKeys.organizations.workspaceBackupFiles(orgId, backupId, directoryPath),
    queryFn: () => organizationsApi.listWorkspaceBackupFiles(orgId, backupId, directoryPath),
    enabled: !!orgId && !!backupId,
    refetchOnWindowFocus: false,
  });

  const entries = data?.entries ?? [];
  if (entries.length === 0) return null;

  return (
    <ul className="space-y-0.5">
      {entries.map((entry) => (
        <BackupTreeNode
          key={entry.path}
          orgId={orgId}
          backupId={backupId}
          entry={entry}
          selectedFilePath={selectedFilePath}
          onSelectFile={onSelectFile}
          expandedDirectories={expandedDirectories}
          depth={depth}
        />
      ))}
    </ul>
  );
}

function BackupTreeNode({
  orgId,
  backupId,
  entry,
  selectedFilePath,
  onSelectFile,
  expandedDirectories,
  depth = 0,
}: {
  orgId: string;
  backupId: string;
  entry: OrganizationWorkspaceFileEntry;
  selectedFilePath: string | null;
  onSelectFile: (filePath: string) => void;
  expandedDirectories: Set<string>;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(expandedDirectories.has(entry.path));

  useEffect(() => {
    if (expandedDirectories.has(entry.path)) setExpanded(true);
  }, [entry.path, expandedDirectories]);

  if (entry.isDirectory) {
    return (
      <li>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-[calc(var(--radius-sm)-1px)] px-2 py-1.5 text-left text-sm text-foreground/88 transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_58%,transparent)]"
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </span>
          <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-medium">{entry.name}</span>
        </button>
        {expanded ? (
          <BackupDirectoryChildren
            orgId={orgId}
            backupId={backupId}
            directoryPath={entry.path}
            selectedFilePath={selectedFilePath}
            onSelectFile={onSelectFile}
            expandedDirectories={expandedDirectories}
            depth={depth + 1}
          />
        ) : null}
      </li>
    );
  }

  const selected = selectedFilePath === entry.path;
  return (
    <li>
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-2 rounded-[calc(var(--radius-sm)-1px)] px-2 py-1.5 text-left text-sm transition-colors",
          selected
            ? "bg-[color:color-mix(in_oklab,var(--surface-active)_90%,var(--surface-elevated))] text-foreground"
            : "text-muted-foreground hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_58%,transparent)] hover:text-foreground",
        )}
        style={{ paddingLeft: `${depth * 14 + 23}px` }}
        onClick={() => onSelectFile(entry.path)}
      >
        <FileCode2 className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{entry.name}</span>
      </button>
    </li>
  );
}

export function WorkspaceBackupFilesSidebar() {
  const { isMobile, setSidebarOpen } = useSidebar();
  const { viewedOrganizationId } = useViewedOrganization();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedBackupId = searchParams.get("backup");
  const selectedFilePath = searchParams.get("file");

  const backupsQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceBackups(viewedOrganizationId ?? "__none__"),
    queryFn: () => organizationsApi.listWorkspaceBackups(viewedOrganizationId!),
    enabled: !!viewedOrganizationId,
    refetchOnWindowFocus: false,
  });

  const backups = backupsQuery.data?.backups ?? [];
  const selectedBackup = backups.find((backup) => backup.id === requestedBackupId) ?? backups[0] ?? null;
  const rootQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceBackupFiles(
      viewedOrganizationId ?? "__none__",
      selectedBackup?.id ?? "__none__",
      "",
    ),
    queryFn: () => organizationsApi.listWorkspaceBackupFiles(viewedOrganizationId!, selectedBackup!.id, ""),
    enabled: !!viewedOrganizationId && !!selectedBackup,
    refetchOnWindowFocus: false,
  });
  const expandedDirectories = useMemo(
    () => (selectedFilePath ? parentDirectories(selectedFilePath) : new Set<string>()),
    [selectedFilePath],
  );

  return (
    <aside
      data-testid="workspace-sidebar"
      className="workspace-context-sidebar flex min-h-0 w-full min-w-0 shrink-0 flex-col"
    >
      <header
        data-testid="workspace-context-header"
        className="workspace-card-header workspace-context-header desktop-chrome flex shrink-0 items-center justify-between gap-3 px-4 py-3"
      >
        <div className="min-w-0">
          <h2 className="truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground">Files</h2>
          <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
            {selectedBackup
              ? `${formatFileCount(selectedBackup.fileCount)} · ${formatBackupTime(selectedBackup.finishedAt ?? selectedBackup.createdAt)}`
              : "Select a backup version"}
          </p>
        </div>
        {!isMobile ? (
          <button
            type="button"
            aria-label="Collapse workspace sidebar"
            title="Collapse workspace sidebar"
            className="desktop-window-no-drag inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] text-muted-foreground transition-[background-color,color] hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_68%,transparent)] hover:text-foreground"
            onClick={() => setSidebarOpen(false)}
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        ) : null}
      </header>

      <div className="scrollbar-auto-hide min-h-0 flex-1 overflow-auto px-1.5 py-2">
        {backupsQuery.isLoading ? (
          <div className="px-2 py-3 text-sm text-muted-foreground">Loading backups...</div>
        ) : backupsQuery.error ? (
          <div className="px-2 py-3 text-sm text-destructive">{backupsQuery.error.message}</div>
        ) : !selectedBackup ? (
          <div className="px-2 py-3 text-sm text-muted-foreground">No workspace backups yet.</div>
        ) : rootQuery.isLoading ? (
          <div className="px-2 py-3 text-sm text-muted-foreground">Loading files...</div>
        ) : rootQuery.error ? (
          <div className="px-2 py-3 text-sm text-destructive">{rootQuery.error.message}</div>
        ) : rootQuery.data?.entries.length === 0 ? (
          <div className="px-2 py-3 text-sm text-muted-foreground">
            {rootQuery.data?.message ?? "This backup is empty."}
          </div>
        ) : (
          <ul className="space-y-0.5">
            {(rootQuery.data?.entries ?? []).map((entry) => (
              <BackupTreeNode
                key={entry.path}
                orgId={viewedOrganizationId!}
                backupId={selectedBackup.id}
                entry={entry}
                selectedFilePath={selectedFilePath}
                onSelectFile={(filePath) => selectFilePath(searchParams, setSearchParams, filePath)}
                expandedDirectories={expandedDirectories}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
