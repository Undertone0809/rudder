import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OrganizationWorkspaceFileEntry, WorkspaceBackupSummary } from "@rudderhq/shared";
import { Button } from "@/components/ui/button";
import { organizationsApi } from "../api/orgs";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { useViewedOrganization } from "../hooks/useViewedOrganization";
import { queryKeys } from "../lib/queryKeys";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  HardDrive,
  Loader2,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";

function parentDirectories(filePath: string) {
  const segments = filePath.split("/").filter(Boolean);
  const parents: string[] = [];
  for (let index = 0; index < segments.length - 1; index += 1) {
    parents.push(segments.slice(0, index + 1).join("/"));
  }
  return new Set(parents);
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
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

function formatBackupCount(value: number) {
  return `${value} ${value === 1 ? "backup" : "backups"}`;
}

function formatFileCount(value: number) {
  return `${value} ${value === 1 ? "file" : "files"}`;
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
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-accent/60"
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
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
          selected ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        }`}
        style={{ paddingLeft: `${depth * 14 + 23}px` }}
        onClick={() => onSelectFile(entry.path)}
      >
        <FileCode2 className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{entry.name}</span>
      </button>
    </li>
  );
}

function BackupVersionButton({
  backup,
  selected,
  onSelect,
}: {
  backup: WorkspaceBackupSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
        selected
          ? "border-primary/50 bg-primary/10 text-foreground"
          : "border-border bg-card hover:bg-accent/40"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="truncate text-sm font-medium">{formatBackupTime(backup.finishedAt ?? backup.createdAt)}</div>
        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] uppercase text-muted-foreground">
          {backup.status}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
        <span>{backup.triggerSource.replace("_", " ")}</span>
        <span>{formatFileCount(backup.fileCount)}</span>
        <span>{formatBytes(backup.byteSize)}</span>
      </div>
    </button>
  );
}

export function OrganizationWorkspaceBackups() {
  const { viewedOrganization, viewedOrganizationId } = useViewedOrganization();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [selectedBackupId, setSelectedBackupId] = useState<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Workspace backups" }]);
  }, [setBreadcrumbs]);

  const backupsQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceBackups(viewedOrganizationId ?? "__none__"),
    queryFn: () => organizationsApi.listWorkspaceBackups(viewedOrganizationId!),
    enabled: !!viewedOrganizationId,
    refetchOnWindowFocus: false,
  });

  const backups = backupsQuery.data?.backups ?? [];
  const selectedBackup = backups.find((backup) => backup.id === selectedBackupId) ?? backups[0] ?? null;

  useEffect(() => {
    if (!selectedBackup) {
      setSelectedBackupId(null);
      setSelectedFilePath(null);
      return;
    }
    if (selectedBackup.id !== selectedBackupId) {
      setSelectedBackupId(selectedBackup.id);
      setSelectedFilePath(null);
    }
  }, [selectedBackup, selectedBackupId]);

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

  useEffect(() => {
    if (selectedFilePath) return;
    const preferredFile = rootQuery.data?.entries.find((entry) => !entry.isDirectory);
    if (preferredFile) setSelectedFilePath(preferredFile.path);
  }, [rootQuery.data?.entries, selectedFilePath]);

  const fileQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceBackupFile(
      viewedOrganizationId ?? "__none__",
      selectedBackup?.id ?? "__none__",
      selectedFilePath ?? "",
    ),
    queryFn: () => organizationsApi.readWorkspaceBackupFile(viewedOrganizationId!, selectedBackup!.id, selectedFilePath!),
    enabled: !!viewedOrganizationId && !!selectedBackup && !!selectedFilePath,
    refetchOnWindowFocus: false,
  });

  const expandedDirectories = useMemo(
    () => (selectedFilePath ? parentDirectories(selectedFilePath) : new Set<string>()),
    [selectedFilePath],
  );

  const createBackup = useMutation({
    mutationFn: () => organizationsApi.createWorkspaceBackup(viewedOrganizationId!, { triggerSource: "manual" }),
    onSuccess: (backup) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.workspaceBackups(viewedOrganizationId!) });
      setSelectedBackupId(backup.id);
      setSelectedFilePath(null);
      pushToast({ title: "Workspace backup created", body: formatFileCount(backup.fileCount) });
    },
    onError: (error) => {
      pushToast({
        title: "Backup failed",
        body: error instanceof Error ? error.message : "Could not create workspace backup.",
        tone: "error",
      });
    },
  });

  const restoreBackup = useMutation({
    mutationFn: (backupId: string) => organizationsApi.restoreWorkspaceBackup(viewedOrganizationId!, backupId, { confirm: true }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.workspaceBackups(viewedOrganizationId!) });
      queryClient.invalidateQueries({ queryKey: ["organizations", viewedOrganizationId, "workspace-files"] });
      queryClient.invalidateQueries({ queryKey: ["organizations", viewedOrganizationId, "workspace-file"] });
      pushToast({ title: "Workspace restored" });
    },
    onError: (error) => {
      pushToast({
        title: "Restore failed",
        body: error instanceof Error ? error.message : "Could not restore workspace backup.",
        tone: "error",
      });
    },
  });

  const deleteBackup = useMutation({
    mutationFn: (backupId: string) => organizationsApi.deleteWorkspaceBackup(viewedOrganizationId!, backupId),
    onSuccess: (_, backupId) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.workspaceBackups(viewedOrganizationId!) });
      if (selectedBackupId === backupId) {
        setSelectedBackupId(null);
        setSelectedFilePath(null);
      }
      pushToast({ title: "Workspace backup deleted" });
    },
    onError: (error) => {
      pushToast({
        title: "Delete failed",
        body: error instanceof Error ? error.message : "Could not delete workspace backup.",
        tone: "error",
      });
    },
  });

  if (!viewedOrganizationId || !viewedOrganization) {
    return <EmptyState icon={HardDrive} message="Select an organization to manage workspace backups." />;
  }

  if (backupsQuery.isLoading) {
    return <PageSkeleton variant="detail" />;
  }

  if (backupsQuery.error) {
    return <p className="text-sm text-destructive">{backupsQuery.error.message}</p>;
  }

  const selectedLanguage = inferLanguageFromPath(selectedFilePath);
  const selectedFileDetail = fileQuery.data;
  const canRestore = Boolean(
    selectedBackup &&
      (selectedBackup.status === "succeeded" || selectedBackup.status === "restored") &&
      restoreBackup.variables !== selectedBackup.id,
  );
  const canDelete = Boolean(selectedBackup && selectedBackup.status !== "running" && deleteBackup.variables !== selectedBackup.id);

  function handleRestore() {
    if (!selectedBackup) return;
    const confirmed = window.confirm(`Restore workspace backup from ${formatBackupTime(selectedBackup.finishedAt ?? selectedBackup.createdAt)}?`);
    if (!confirmed) return;
    restoreBackup.mutate(selectedBackup.id);
  }

  function handleDelete() {
    if (!selectedBackup) return;
    const confirmed = window.confirm(`Delete workspace backup from ${formatBackupTime(selectedBackup.finishedAt ?? selectedBackup.createdAt)}?`);
    if (!confirmed) return;
    deleteBackup.mutate(selectedBackup.id);
  }

  return (
    <div className="flex min-h-full flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">Workspace backups</h1>
          <div className="truncate text-xs text-muted-foreground">{viewedOrganization.name}</div>
        </div>
      </div>

      <div className="grid min-h-[620px] flex-1 grid-cols-1 gap-3 xl:grid-cols-[240px_minmax(0,1fr)_280px]">
        <section className="flex min-h-[320px] flex-col rounded-[var(--radius-lg)] border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <div className="text-sm font-medium">Files</div>
            <div className="text-xs text-muted-foreground">
              {selectedBackup
                ? `${formatFileCount(selectedBackup.fileCount)} · ${formatBackupTime(selectedBackup.finishedAt ?? selectedBackup.createdAt)}`
                : "No backup selected"}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
            {!selectedBackup ? (
              <div className="px-2 py-3 text-sm text-muted-foreground">No backup selected.</div>
            ) : rootQuery.isLoading ? (
              <div className="px-2 py-3 text-sm text-muted-foreground">Loading files…</div>
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
                    orgId={viewedOrganizationId}
                    backupId={selectedBackup.id}
                    entry={entry}
                    selectedFilePath={selectedFilePath}
                    onSelectFile={setSelectedFilePath}
                    expandedDirectories={expandedDirectories}
                  />
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="flex min-h-[420px] min-w-0 flex-col rounded-[var(--radius-lg)] border border-border bg-card">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">Content</div>
              <div className="truncate text-xs text-muted-foreground">
                {selectedFilePath ?? "Select a file"}
              </div>
            </div>
            {selectedFilePath ? (
              <span className="rounded-full border border-border px-2 py-0.5 text-xs font-mono text-muted-foreground">
                {selectedLanguage}
              </span>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {!selectedBackup ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">Select a backup version.</div>
            ) : !selectedFilePath ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">Select a file.</div>
            ) : fileQuery.isLoading ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">Loading file…</div>
            ) : fileQuery.error ? (
              <div className="px-4 py-6 text-sm text-destructive">{fileQuery.error.message}</div>
            ) : selectedFileDetail?.content !== null && selectedFileDetail?.content !== undefined ? (
              <div className="h-full min-h-0 overflow-auto">
                {selectedFileDetail.message ? (
                  <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
                    {selectedFileDetail.message}
                  </div>
                ) : null}
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

        <aside className="flex min-h-[420px] flex-col rounded-[var(--radius-lg)] border border-border bg-card">
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
            <div>
              <div className="text-sm font-medium">Versions</div>
              <div className="text-xs text-muted-foreground">{formatBackupCount(backups.length)}</div>
            </div>
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="h-8 w-8"
              aria-label="Back up now"
              onClick={() => createBackup.mutate()}
              disabled={createBackup.isPending}
            >
              {createBackup.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
            {backups.length === 0 ? (
              <EmptyState icon={Archive} message="No workspace backups yet." />
            ) : (
              <div className="space-y-2">
                {backups.map((backup) => (
                  <BackupVersionButton
                    key={backup.id}
                    backup={backup}
                    selected={backup.id === selectedBackup?.id}
                    onSelect={() => {
                      setSelectedBackupId(backup.id);
                      setSelectedFilePath(null);
                    }}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="space-y-3 border-t border-border px-4 py-3">
            {selectedBackup ? (
              <div className="space-y-1 text-xs text-muted-foreground">
                <div className="flex justify-between gap-3"><span>Status</span><span>{selectedBackup.status}</span></div>
                <div className="flex justify-between gap-3"><span>Files</span><span>{selectedBackup.fileCount}</span></div>
                <div className="flex justify-between gap-3"><span>Size</span><span>{formatBytes(selectedBackup.byteSize)}</span></div>
                <div className="flex justify-between gap-3"><span>Source</span><span>{selectedBackup.triggerSource.replace("_", " ")}</span></div>
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleRestore}
                disabled={!canRestore || restoreBackup.isPending}
              >
                {restoreBackup.isPending ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                )}
                Restore
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleDelete}
                disabled={!canDelete || deleteBackup.isPending}
              >
                {deleteBackup.isPending ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                )}
                Delete
              </Button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
