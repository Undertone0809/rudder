import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OrganizationWorkspaceFileEntry } from "@rudder/shared";
import { useSearchParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { organizationsApi } from "../api/orgs";
import { AgentIcon } from "../components/AgentIconPicker";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { useViewedOrganization } from "../hooks/useViewedOrganization";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import {
  ChevronDown,
  ChevronRight,
  HardDrive,
  Folder,
  FileCode2,
  RefreshCw,
  Save,
  Loader2,
} from "lucide-react";

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
  expandedDirectories,
  depth,
}: {
  orgId: string;
  directoryPath: string;
  selectedFilePath: string | null;
  onSelectFile: (filePath: string) => void;
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
  expandedDirectories,
  depth = 0,
}: {
  orgId: string;
  entry: OrganizationWorkspaceFileEntry;
  selectedFilePath: string | null;
  onSelectFile: (filePath: string) => void;
  expandedDirectories: Set<string>;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(expandedDirectories.has(entry.path));
  const primaryLabel = displayWorkspaceEntryLabel(entry);
  const isAgentWorkspace = entry.entityType === "agent_workspace";

  useEffect(() => {
    if (expandedDirectories.has(entry.path)) {
      setExpanded(true);
    }
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
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{primaryLabel}</div>
            {isAgentWorkspace ? (
              <div aria-hidden="true" className="truncate text-[11px] text-muted-foreground">
                Agent workspace
              </div>
            ) : null}
          </div>
          {isAgentWorkspace ? (
            <span
              aria-hidden="true"
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
            >
              {entry.agentIcon ? (
                <AgentIcon icon={entry.agentIcon} className="h-3 w-3 shrink-0 text-[11px]" />
              ) : null}
              Agent
            </span>
          ) : null}
        </button>
        {expanded ? (
          <DirectoryChildren
            orgId={orgId}
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

  const isSelected = selectedFilePath === entry.path;
  return (
    <li>
      <button
        type="button"
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
          isSelected ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        }`}
        style={{ paddingLeft: `${depth * 14 + 23}px` }}
        onClick={() => onSelectFile(entry.path)}
      >
        <FileCode2 className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{primaryLabel}</span>
      </button>
    </li>
  );
}

export function OrganizationWorkspaces() {
  const { setBreadcrumbs, setHeaderActions } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const { viewedOrganization, viewedOrganizationId } = useViewedOrganization();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedFilePath = normalizeRequestedPath(searchParams.get("path"));
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(requestedFilePath);
  const [draftContent, setDraftContent] = useState("");
  const [refreshingWorkspace, setRefreshingWorkspace] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Workspaces" }]);
  }, [setBreadcrumbs]);

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

  const refreshWorkspace = useCallback(async () => {
    setRefreshingWorkspace(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["organizations", viewedOrganizationId, "workspace-files"] }),
        queryClient.invalidateQueries({ queryKey: ["organizations", viewedOrganizationId, "workspace-file"] }),
      ]);
    } finally {
      setRefreshingWorkspace(false);
    }
  }, [queryClient, viewedOrganizationId]);

  useEffect(() => {
    setHeaderActions(
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void refreshWorkspace()}
        disabled={refreshingWorkspace}
      >
        <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshingWorkspace ? "animate-spin" : ""}`} />
        Refresh
      </Button>,
    );

    return () => setHeaderActions(null);
  }, [refreshWorkspace, refreshingWorkspace, setHeaderActions]);

  if (!viewedOrganizationId || !viewedOrganization) {
    return <EmptyState icon={HardDrive} message="Select an organization to browse its shared workspace." />;
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
  const selectedLanguage = inferLanguageFromPath(selectedFilePath);

  return (
    <div className="flex min-h-full flex-col gap-4">
      {!workspace.rootExists ? (
        <EmptyState
          icon={HardDrive}
          message={workspace.message ?? "The shared workspace root is not available on this machine yet."}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
          <section
            data-testid="org-workspaces-files-card"
            className="flex min-h-[320px] flex-col rounded-[var(--radius-lg)] border border-border bg-card lg:min-h-0 lg:w-[300px] lg:flex-none"
          >
            <div className="border-b border-border px-4 py-3">
              <div className="text-sm font-medium">Files</div>
              <div className="text-xs text-muted-foreground">
                {workspace.directoryPath ? workspace.directoryPath : "/"}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
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
                      expandedDirectories={expandedDirectories}
                    />
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section
            data-testid="org-workspaces-editor-card"
            className="flex min-h-[420px] min-w-0 flex-col rounded-[var(--radius-lg)] border border-border bg-card lg:min-h-0 lg:flex-1"
          >
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
              <div>
                <div className="text-sm font-medium">Editor</div>
                <div className="text-xs text-muted-foreground">
                  {selectedFilePath ?? "Select a file to edit"}
                </div>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {selectedFilePath ? (
                  <span className="rounded-full border border-border px-2 py-0.5 font-mono">
                    {selectedLanguage}
                  </span>
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
                  Choose a file from the workspace tree to edit it. Agent and organization skill cards can jump here
                  directly into the target <span className="font-mono">SKILL.md</span>, and any shared file already in
                  this workspace can be edited here.
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
                    className="block min-h-[280px] flex-1 overflow-auto border-0 bg-transparent px-4 py-4 font-mono text-sm leading-6 text-foreground outline-none"
                  />
                </div>
              ) : selectedFileDetail?.content ? (
                <div className="h-full min-h-0 overflow-auto">
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
  );
}
