import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNavigate, useSearchParams } from "@/lib/router";
import { cn } from "@/lib/utils";
import type { OrganizationWorkspaceFileEntry, Project, ProjectResourceAttachment } from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FilePlus2, FolderPlus, PanelLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import { organizationSkillsApi } from "../../api/organizationSkills";
import { organizationsApi } from "../../api/orgs";
import { projectsApi } from "../../api/projects";
import { WorkspaceLaunchMenu } from "../../components/workspaces/WorkspaceLaunchControls";
import { useI18n } from "../../context/I18nContext";
import { useToast } from "../../context/ToastContext";
import { useScrollbarActivityRef } from "../../hooks/useScrollbarActivityRef";
import { useViewedOrganization } from "../../hooks/useViewedOrganization";
import { readDesktopShell, type DesktopWorkspaceLaunchTarget } from "../../lib/desktop-shell";
import { libraryCopy } from "../../lib/library-copy";
import { queryKeys } from "../../lib/queryKeys";
import { directoryAndParentDirectories, normalizeRequestedPath, parentDirectories } from "../../lib/workspace-path-policy";
import {
  isWorkspaceFileOpenTarget,
  readStoredWorkspaceOpenFileTabState,
  workspaceFileOpenTargets,
  workspaceLaunchMenuOpeningId,
  writeStoredWorkspaceLaunchTargetId,
  type WorkspaceFileOpenTarget,
  type WorkspaceOpenTargetId,
} from "../../lib/workspace-preferences";
import {
  applyMovedWorkspacePath,
  buildWorkspaceEntryLinkMarkdown,
  canCopyWorkspaceEntry,
  canCreateInsideWorkspaceDirectory,
  canDeleteWorkspaceEntry,
  canDropWorkspaceEntryIntoDirectory,
  canRenameWorkspaceEntry,
  findProjectResourceSelection,
  getWorkspaceImportDropFiles,
  hasExternalFileDragPayload,
  hasWorkspaceDragPayload,
  isDraggingOverWorkspaceTreeEntry,
  isValidWorkspaceEntryName,
  isWorkspaceBackedOrganizationSkill,
  joinWorkspaceEntryPath,
  joinWorkspacePath,
  mergeWorkspaceAndVirtualSkillEntries,
  organizationSkillFileTreePath,
  parentWorkspaceDirectoryPath,
  projectResourceFolderPath,
} from "../../lib/workspace-tree-policy";
import { WorkspaceTreeNode, didDragLeaveCurrentTarget, parseWorkspaceDragEntry } from "./WorkspaceFileTree";
import {
  copyWorkspaceText,
  createWorkspaceFilesFromDroppedFiles,
  isHttpUrl,
  requestWorkspaceDraftFlush,
  resolveResourceOpenPath,
  updateSelectedPath,
  updateSelectedResource,
  updateSelectedSkillFile,
  useProjectResourceTreeGroups,
} from "./organizationWorkspaceCapabilities";

export function OrganizationWorkspaceFilesSidebar({ onCollapseSidebar }: { onCollapseSidebar?: () => void } = {}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const { locale } = useI18n();
  const { viewedOrganizationId } = useViewedOrganization();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedEntryId = normalizeRequestedPath(searchParams.get("entry"));
  const requestedSkillId = requestedEntryId ? null : normalizeRequestedPath(searchParams.get("skill"));
  const requestedSkillFilePath = requestedSkillId ? (normalizeRequestedPath(searchParams.get("skillFile")) ?? "SKILL.md") : null;
  const selectedFilePath = requestedEntryId || requestedSkillId ? null : normalizeRequestedPath(searchParams.get("path"));
  const selectedResourceAttachmentId = requestedEntryId || requestedSkillId ? null : normalizeRequestedPath(searchParams.get("resource"));
  const requestedDirectoryPath = requestedEntryId || requestedSkillId ? null : normalizeRequestedPath(searchParams.get("directory"));
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
  const [draggedEntryPath, setDraggedEntryPath] = useState<string | null>(null);
  const [activeEntryPath, setActiveEntryPath] = useState<string | null>(selectedFilePath ?? requestedDirectoryPath);

  const rootQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceFiles(viewedOrganizationId ?? "__none__", ""),
    queryFn: () => organizationsApi.listWorkspaceFiles(viewedOrganizationId!, ""),
    enabled: !!viewedOrganizationId,
    refetchOnWindowFocus: false,
  });
  const libraryEntryQuery = useQuery({
    queryKey: queryKeys.organizations.libraryEntry(viewedOrganizationId ?? "__none__", requestedEntryId ?? ""),
    queryFn: () => organizationsApi.getLibraryEntry(viewedOrganizationId!, requestedEntryId!),
    enabled: !!viewedOrganizationId && !!requestedEntryId,
    refetchOnWindowFocus: false,
  });
  const organizationSkillsQuery = useQuery({
    queryKey: queryKeys.organizationSkills.list(viewedOrganizationId ?? "__none__"),
    queryFn: () => organizationSkillsApi.list(viewedOrganizationId!),
    enabled: !!viewedOrganizationId,
    refetchOnWindowFocus: false,
  });
  const organizationSkills = organizationSkillsQuery.data ?? [];
  const rootTreeEntries = useMemo(
    () => mergeWorkspaceAndVirtualSkillEntries("", rootQuery.data?.entries ?? [], organizationSkills),
    [organizationSkills, rootQuery.data?.entries],
  );
  const selectedOrganizationSkill = organizationSkills.find((skill) => skill.id === requestedSkillId) ?? null;
  const selectedVirtualOrganizationSkill = selectedOrganizationSkill && !isWorkspaceBackedOrganizationSkill(selectedOrganizationSkill)
    ? selectedOrganizationSkill
    : null;
  const selectedSkillTreePath = selectedVirtualOrganizationSkill && requestedSkillFilePath
    ? organizationSkillFileTreePath(selectedVirtualOrganizationSkill, requestedSkillFilePath)
    : null;
  const projectResourceTree = useProjectResourceTreeGroups(viewedOrganizationId);
  const selectedProjectResource = useMemo(
    () => findProjectResourceSelection(projectResourceTree.projects, selectedResourceAttachmentId),
    [projectResourceTree.projects, selectedResourceAttachmentId],
  );
  const selectedResourcePath = selectedProjectResource?.path ?? null;
  const storedOpenFileTabState = readStoredWorkspaceOpenFileTabState(viewedOrganizationId);
  const sidebarHasTabStrip = Boolean(selectedFilePath || storedOpenFileTabState.openFilePaths.length > 0);
  const sidebarHasBreadcrumb = Boolean(selectedFilePath || selectedSkillTreePath || requestedDirectoryPath);

  const workspaceRootPath = rootQuery.data?.rootExists ? rootQuery.data.rootPath : null;
  const workspaceRootEntry = useMemo<OrganizationWorkspaceFileEntry>(
    () => ({ name: "", path: "", isDirectory: true, displayLabel: libraryCopy("library", locale) }),
    [locale],
  );
  const [workspaceLaunchTargets, setWorkspaceLaunchTargets] = useState<DesktopWorkspaceLaunchTarget[]>([]);
  const [openingWorkspaceTargetId, setOpeningWorkspaceTargetId] = useState<
    WorkspaceOpenTargetId | null
  >(null);
  const expandedDirectories = useMemo(
    () => {
      if (selectedFilePath) return parentDirectories(selectedFilePath);
      if (selectedSkillTreePath) return parentDirectories(selectedSkillTreePath);
      if (selectedResourcePath) return parentDirectories(selectedResourcePath);
      if (requestedDirectoryPath) return directoryAndParentDirectories(requestedDirectoryPath);
      return new Set<string>();
    },
    [requestedDirectoryPath, selectedFilePath, selectedResourcePath, selectedSkillTreePath],
  );

  useEffect(() => {
    if (requestedSkillId && selectedOrganizationSkill && isWorkspaceBackedOrganizationSkill(selectedOrganizationSkill)) {
      const editablePath = normalizeRequestedPath(selectedOrganizationSkill.workspaceEditPath);
      if (editablePath) {
        updateSelectedPath(searchParams, setSearchParams, editablePath);
      }
      return;
    }
    if (requestedEntryId) {
      if (libraryEntryQuery.data?.status === "active" && libraryEntryQuery.data.currentPath) {
        updateSelectedPath(searchParams, setSearchParams, libraryEntryQuery.data.currentPath);
      } else {
        setActiveEntryPath(null);
      }
      return;
    }
    if (selectedFilePath) setActiveEntryPath(selectedFilePath);
    else if (selectedSkillTreePath) setActiveEntryPath(selectedSkillTreePath);
    else if (selectedResourcePath) setActiveEntryPath(selectedResourcePath);
    else if (requestedDirectoryPath) setActiveEntryPath(requestedDirectoryPath);
  }, [libraryEntryQuery.data?.currentPath, requestedDirectoryPath, requestedEntryId, requestedSkillId, searchParams, selectedFilePath, selectedOrganizationSkill, selectedResourcePath, selectedSkillTreePath, setSearchParams]);

  useEffect(() => {
    const clearRootDropState = () => {
      setRootDropActive(false);
      setDraggedEntryPath(null);
    };
    window.addEventListener("dragend", clearRootDropState);
    window.addEventListener("drop", clearRootDropState, true);
    return () => {
      window.removeEventListener("dragend", clearRootDropState);
      window.removeEventListener("drop", clearRootDropState, true);
    };
  }, []);

  useEffect(() => {
    const desktopShell = readDesktopShell();
    let cancelled = false;

    if (typeof desktopShell?.listWorkspaceLaunchTargets === "function") {
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

  const invalidateWorkspaceBrowser = useCallback(async () => {
    if (!viewedOrganizationId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["organizations", viewedOrganizationId, "workspace-files"] }),
      queryClient.invalidateQueries({ queryKey: ["organizations", viewedOrganizationId, "workspace-file"] }),
    ]);
  }, [queryClient, viewedOrganizationId]);

  const removeProjectResourceAttachment = useMutation({
    mutationFn: (payload: { project: Project; attachment: ProjectResourceAttachment }) =>
      projectsApi.removeResourceAttachment(payload.project.id, payload.attachment.id, payload.project.orgId),
    onSuccess: (removed, payload) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(payload.project.orgId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.resources(payload.project.id) });
      if (selectedResourceAttachmentId === payload.attachment.id) {
        updateSelectedPath(searchParams, setSearchParams, null);
        setActiveEntryPath(projectResourceFolderPath(payload.project));
      }
      pushToast({
        title: "Resource unlinked",
        body: removed.resource.name,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to unlink resource",
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

  const importWorkspaceFiles = useMutation({
    mutationFn: async (payload: { files: File[]; destinationDirectoryPath: string; unsupportedCount?: number }) => {
      requestWorkspaceDraftFlush();
      const result = await createWorkspaceFilesFromDroppedFiles(
        viewedOrganizationId!,
        payload.destinationDirectoryPath,
        payload.files,
      );
      return { ...result, unsupportedCount: payload.unsupportedCount ?? 0 };
    },
    onSuccess: ({ imported, failed, unsupportedCount }) => {
      if (!viewedOrganizationId) return;
      if (imported.length > 0) {
        void invalidateWorkspaceBrowser();
        for (const result of imported) {
          queryClient.setQueryData(
            queryKeys.organizations.workspaceFile(viewedOrganizationId, result.filePath),
            result,
          );
        }
      }
      const lastResult = imported.at(-1);
      if (lastResult) {
        setActiveEntryPath(lastResult.filePath);
        updateSelectedPath(searchParams, setSearchParams, lastResult.filePath);
      }
      const failedSummary = [
        ...failed.map((failure) => `${failure.fileName}: ${failure.message}`),
        ...(unsupportedCount > 0 ? [`${unsupportedCount} unsupported file${unsupportedCount === 1 ? "" : "s"}`] : []),
      ].join(", ");
      if (imported.length === 0) {
        pushToast({
          title: "No files imported",
          body: failedSummary || "Only text, Markdown, and code files can be imported.",
          tone: failed.length > 0 ? "error" : "warn",
        });
        return;
      }
      pushToast({
        title: failed.length > 0 || unsupportedCount > 0
          ? `Imported ${imported.length} of ${imported.length + failed.length + unsupportedCount} files`
          : imported.length === 1 ? "File imported" : `${imported.length} files imported`,
        body: failedSummary
          ? `${imported.map((result) => result.filePath).join(", ")}. Failed: ${failedSummary}`
          : imported.map((result) => result.filePath).join(", "),
        tone: failed.length > 0 || unsupportedCount > 0 ? "warn" : "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to import files",
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

  const copyWorkspaceEntry = useMutation({
    mutationFn: (entry: OrganizationWorkspaceFileEntry) =>
      organizationsApi.copyWorkspaceEntry(viewedOrganizationId!, entry.path),
    onSuccess: (result) => {
      void invalidateWorkspaceBrowser();
      if (!result.isDirectory) {
        setActiveEntryPath(result.path);
        updateSelectedPath(searchParams, setSearchParams, result.path);
      } else {
        setActiveEntryPath(result.path);
      }
      pushToast({
        title: "Workspace entry copied",
        body: result.previousPath ? `${result.previousPath} -> ${result.path}` : result.path,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to copy workspace entry",
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

  async function handleCopyEntryLink(entry: OrganizationWorkspaceFileEntry) {
    const copyValue = buildWorkspaceEntryLinkMarkdown(entry);
    try {
      await copyWorkspaceText(copyValue);
      pushToast({
        title: "Library link copied",
        tone: "info",
      });
    } catch (error) {
      pushToast({
        title: "Failed to copy Library link",
        body: error instanceof Error ? error.message : copyValue,
        tone: "error",
      });
    }
  }

  async function handleCopyEntryAbsolutePath(entry: OrganizationWorkspaceFileEntry) {
    const copyValue = joinWorkspacePath(workspaceRootPath, entry.path);
    try {
      await copyWorkspaceText(copyValue);
      pushToast({
        title: "Absolute path copied",
        body: copyValue,
        tone: "info",
      });
    } catch (error) {
      pushToast({
        title: "Failed to copy absolute path",
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

  function handleAddProjectResources(project: Project) {
    navigate(`/projects/${project.urlKey ?? project.id}/resources`);
  }

  async function handleCopyResourceLocator(attachment: ProjectResourceAttachment) {
    const copyValue = attachment.resource.locator;
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
        title: "Resource locator copied",
        body: copyValue,
        tone: "info",
      });
    } catch (error) {
      pushToast({
        title: "Failed to copy resource locator",
        body: error instanceof Error ? error.message : copyValue,
        tone: "error",
      });
    }
  }

  async function handleOpenResourceDefault(attachment: ProjectResourceAttachment) {
    const locator = attachment.resource.locator.trim();
    const desktopShell = readDesktopShell();
    try {
      if (attachment.resource.kind === "url" || isHttpUrl(locator)) {
        if (desktopShell?.openExternal) {
          await desktopShell.openExternal(locator);
        } else {
          window.open(locator, "_blank", "noopener,noreferrer");
        }
        pushToast({ title: "Opened resource link", body: locator, tone: "info" });
        return;
      }

      const targetPath = resolveResourceOpenPath(attachment, workspaceRootPath);
      if (!targetPath || !desktopShell?.openPath) {
        throw new Error("This resource cannot be opened from the current shell.");
      }
      await desktopShell.openPath(targetPath);
      pushToast({ title: "Opened resource", body: targetPath, tone: "info" });
    } catch (error) {
      pushToast({
        title: "Failed to open resource",
        body: error instanceof Error ? error.message : locator,
        tone: "error",
      });
    }
  }

  async function handleOpenWorkspaceTarget(
    rootPath: string,
    target: DesktopWorkspaceLaunchTarget,
    toastLabel = "workspace",
  ) {
    const desktopShell = readDesktopShell();
    if (!desktopShell?.openWorkspace) return;

    setOpeningWorkspaceTargetId(target.id);
    try {
      await desktopShell.openWorkspace(rootPath, target.id);
      writeStoredWorkspaceLaunchTargetId(target.id);
      pushToast({
        title: `Opened ${toastLabel} in ${target.label}`,
        tone: "info",
      });
    } catch (error) {
      pushToast({
        title: `Failed to open ${toastLabel}`,
        body: error instanceof Error ? error.message : `Could not open the ${toastLabel} in ${target.label}.`,
        tone: "error",
      });
    } finally {
      setOpeningWorkspaceTargetId(null);
    }
  }

  async function handleOpenEntryTarget(entry: OrganizationWorkspaceFileEntry, target: DesktopWorkspaceLaunchTarget | WorkspaceFileOpenTarget) {
    if (entry.isDirectory) {
      if (isWorkspaceFileOpenTarget(target)) return;
      await handleOpenWorkspaceTarget(joinWorkspacePath(workspaceRootPath, entry.path), target, "folder");
      return;
    }

    if (!workspaceRootPath) return;
    const desktopShell = readDesktopShell();
    if (typeof desktopShell?.openWorkspaceFileInIde !== "function") return;

    const fileTarget = isWorkspaceFileOpenTarget(target)
      ? target
      : workspaceFileOpenTargets([target]).find((candidate) => candidate.id === target.id);
    if (!fileTarget) return;

    setOpeningWorkspaceTargetId(fileTarget.id);
    try {
      await desktopShell.openWorkspaceFileInIde(workspaceRootPath, entry.path, fileTarget.id);
      if (fileTarget.workspaceTarget) {
        writeStoredWorkspaceLaunchTargetId(fileTarget.workspaceTarget.id);
      }
      pushToast({
        title: fileTarget.id === "defaultApp" ? "Opened file" : `Opened file in ${fileTarget.label}`,
        body: entry.path,
        tone: "info",
      });
    } catch (error) {
      pushToast({
        title: "Failed to open file",
        body: error instanceof Error ? error.message : `Could not open ${entry.path} in ${fileTarget.label}.`,
        tone: "error",
      });
    } finally {
      setOpeningWorkspaceTargetId(null);
    }
  }

  function handleSelectFile(filePath: string) {
    updateSelectedPath(searchParams, setSearchParams, filePath);
  }

  function handleSelectSkillFile(skillId: string, filePath: string, treePath: string) {
    setActiveEntryPath(treePath);
    updateSelectedSkillFile(searchParams, setSearchParams, skillId, filePath);
  }

  function handleSelectResource(attachmentId: string) {
    updateSelectedResource(searchParams, setSearchParams, attachmentId);
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
    if (!canRenameWorkspaceEntry(entry)) return;
    setRenameTarget(entry);
    setRenameDraft(entry.name);
  }

  function handleStartDelete(entry: OrganizationWorkspaceFileEntry) {
    if (!canDeleteWorkspaceEntry(entry)) return;
    setDeleteTarget(entry);
  }

  function handleCopyEntry(entry: OrganizationWorkspaceFileEntry) {
    if (!canCopyWorkspaceEntry(entry)) return;
    copyWorkspaceEntry.mutate(entry);
  }

  function handleMoveEntry(
    entry: Pick<OrganizationWorkspaceFileEntry, "path" | "isDirectory">,
    destinationDirectoryPath: string,
  ) {
    setRootDropActive(false);
    if (!canDropWorkspaceEntryIntoDirectory(entry, destinationDirectoryPath)) return;
    moveWorkspaceEntry.mutate({ entry, destinationDirectoryPath });
  }

  function handleImportFiles(files: File[], destinationDirectoryPath: string, unsupportedCount = 0) {
    setRootDropActive(false);
    if (files.length === 0) {
      if (unsupportedCount > 0) {
        pushToast({
          title: "No files imported",
          body: "Only text, Markdown, and code files can be imported.",
          tone: "warn",
        });
      }
      return;
    }
    importWorkspaceFiles.mutate({ files, destinationDirectoryPath, unsupportedCount });
  }

  function handleRootDragOver(event: DragEvent<HTMLElement>) {
    if (!hasWorkspaceDragPayload(event.dataTransfer) && !hasExternalFileDragPayload(event.dataTransfer)) return;
    if (isDraggingOverWorkspaceTreeEntry(event)) {
      setRootDropActive(false);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = hasExternalFileDragPayload(event.dataTransfer) ? "copy" : "move";
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
    if (hasExternalFileDragPayload(event.dataTransfer)) {
      const { supported, unsupportedCount } = getWorkspaceImportDropFiles(event.dataTransfer);
      handleImportFiles(supported, "", unsupportedCount);
      return;
    }
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
          aria-label={libraryCopy("library", locale)}
          className={cn(
            "workspace-context-header rudder-doc-editor-sidebar-header desktop-chrome flex shrink-0 items-center justify-between gap-3 px-4",
            sidebarHasTabStrip && !sidebarHasBreadcrumb && "rudder-doc-editor-sidebar-header--tabs-only",
            !sidebarHasTabStrip && sidebarHasBreadcrumb && "rudder-doc-editor-sidebar-header--breadcrumb-only",
            sidebarHasTabStrip && sidebarHasBreadcrumb && "rudder-doc-editor-sidebar-header--tabs-and-breadcrumb",
          )}
        >
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {workspaceRootPath ? (
              <WorkspaceLaunchMenu
                rootPath={workspaceRootPath}
                targets={workspaceLaunchTargets}
                openingTargetId={workspaceLaunchMenuOpeningId(openingWorkspaceTargetId)}
                onOpenTarget={(rootPath, target, toastLabel) => {
                  void handleOpenWorkspaceTarget(rootPath, target, toastLabel);
                }}
                contentAlign="start"
                testId="org-workspaces-sidebar-launcher"
                targetTestIdPrefix="org-workspaces-sidebar-launch-target"
              />
            ) : null}
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
            {onCollapseSidebar ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={onCollapseSidebar}
                    aria-label="Hide Library sidebar"
                    data-testid="org-workspaces-hide-sidebar-button"
                  >
                    <PanelLeft className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Hide Library sidebar</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </header>

        <section
          data-testid="org-workspaces-files-card"
          data-active-surface={importWorkspaceFiles.isPending ? "workspace-import" : undefined}
          className={cn(
            "flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border transition-colors",
            rootDropActive && "bg-[#2f80ed]/5 ring-1 ring-inset ring-[#2f80ed]/25",
            importWorkspaceFiles.isPending && "active-surface-ring",
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
                  {rootQuery.data?.message ?? "The shared Library root is not available on this machine yet."}
                </div>
              ) : rootTreeEntries.length === 0 ? (
                <div className="px-2 py-3 text-sm text-muted-foreground">
                  {rootQuery.data.message ?? "This folder is empty."}
                </div>
              ) : (
                <ul className="space-y-0.5">
                  {rootTreeEntries.map((entry) => (
                    <WorkspaceTreeNode
                      key={entry.path}
                      orgId={viewedOrganizationId}
                      entry={entry}
                      organizationSkills={organizationSkills}
                      selectedFilePath={selectedFilePath}
                      selectedSkillTreePath={selectedSkillTreePath}
                      selectedResourcePath={selectedResourcePath}
                      activeEntryPath={activeEntryPath}
                      draggedEntryPath={draggedEntryPath}
                      onSelectFile={handleSelectFile}
                      onSelectSkillFile={handleSelectSkillFile}
                      onSelectResource={handleSelectResource}
                      onFocusEntry={setActiveEntryPath}
                      onDragStartEntry={setDraggedEntryPath}
                      onDragEndEntry={() => setDraggedEntryPath(null)}
                      onCopyLink={(entryToCopy) => void handleCopyEntryLink(entryToCopy)}
                      onCopyAbsolutePath={(entryToCopy) => void handleCopyEntryAbsolutePath(entryToCopy)}
                      onOpenEntry={readDesktopShell()?.openPath
                        ? (entryToOpen) => void handleOpenEntryDefault(entryToOpen)
                        : undefined}
                      onOpenEntryTarget={(entryToOpen, target) => {
                        void handleOpenEntryTarget(entryToOpen, target);
                      }}
                      onStartCreateEntry={handleStartCreateEntry}
                      onCopyEntry={handleCopyEntry}
                      onStartRename={handleStartRename}
                      onStartDelete={handleStartDelete}
                      onMoveEntry={handleMoveEntry}
                      onImportFiles={handleImportFiles}
                      onAddResources={handleAddProjectResources}
                      onCopyResourceLocator={(attachment) => void handleCopyResourceLocator(attachment)}
                      onOpenResource={(attachment) => void handleOpenResourceDefault(attachment)}
                      onUnlinkResource={(project, attachment) => removeProjectResourceAttachment.mutate({ project, attachment })}
                      onOpenSkillAddDialog={() => navigate("/hub?tab=skills")}
                      unlinkingResourceId={removeProjectResourceAttachment.variables?.attachment.id ?? null}
                      expandedDirectories={expandedDirectories}
                      workspaceLaunchTargets={workspaceLaunchTargets}
                      openingWorkspaceTargetId={openingWorkspaceTargetId}
                      projectResourceGroupsByLibraryPath={projectResourceTree.groupsByLibraryPath}
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
            <DialogTitle>
              {deleteTarget?.entityType === "orphaned_agent_workspace"
                ? "Delete deleted agent folder?"
                : "Delete entry"}
            </DialogTitle>
            <DialogDescription>
              {deleteTarget?.entityType === "orphaned_agent_workspace"
                ? `This folder is no longer linked to an active agent. This will permanently delete ${deleteTarget.path} and everything inside it from the organization Library.`
                : `This will permanently delete ${deleteTarget?.path ?? "this entry"} from the organization Library.`}
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
