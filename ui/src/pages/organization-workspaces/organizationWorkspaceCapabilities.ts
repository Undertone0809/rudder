import { useSearchParams } from "@/lib/router";
import type { OrganizationWorkspaceFileDetail, ProjectResourceAttachment } from "@rudderhq/shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { organizationsApi } from "../../api/orgs";
import { projectsApi } from "../../api/projects";
import { readDesktopShell } from "../../lib/desktop-shell";
import { queryKeys } from "../../lib/queryKeys";
import { buildProjectResourceTreeGroups, joinWorkspaceEntryPath, joinWorkspacePath } from "../../lib/workspace-tree-policy";

export const WORKSPACE_FLUSH_DRAFT_EVENT = "rudder:workspace-flush-draft";

export function requestWorkspaceDraftFlush() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(WORKSPACE_FLUSH_DRAFT_EVENT));
}

export function useProjectResourceTreeGroups(orgId: string | null | undefined) {
  const query = useQuery({
    queryKey: orgId ? queryKeys.projects.list(orgId) : queryKeys.projects.list("__none__"),
    queryFn: () => projectsApi.list(orgId!),
    enabled: !!orgId,
    refetchOnWindowFocus: false,
  });
  const groupsByLibraryPath = useMemo(
    () => buildProjectResourceTreeGroups(query.data),
    [query.data],
  );
  return {
    projects: query.data ?? [],
    groupsByLibraryPath,
    isLoading: query.isLoading,
  };
}

export async function createWorkspaceFilesFromDroppedFiles(
  orgId: string,
  destinationDirectoryPath: string,
  files: File[],
) {
  const imported: OrganizationWorkspaceFileDetail[] = [];
  const failed: Array<{ fileName: string; filePath: string; message: string }> = [];
  for (const file of files) {
    const filePath = joinWorkspaceEntryPath(destinationDirectoryPath, file.name);
    try {
      imported.push(await organizationsApi.createWorkspaceFile(orgId, {
        filePath,
        content: await file.text(),
      }));
    } catch (error) {
      failed.push({
        fileName: file.name,
        filePath,
        message: error instanceof Error ? error.message : "Failed to import file",
      });
    }
  }
  return { imported, failed };
}

export async function copyWorkspaceText(copyValue: string) {
  const desktopShell = readDesktopShell();
  if (desktopShell?.copyText) {
    await desktopShell.copyText(copyValue);
  } else if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(copyValue);
  } else {
    throw new Error("Clipboard is not available in this environment.");
  }
}

export function updateSelectedPath(
  searchParams: URLSearchParams,
  setSearchParams: ReturnType<typeof useSearchParams>[1],
  filePath: string | null,
) {
  const next = new URLSearchParams(searchParams);
  if (filePath) next.set("path", filePath);
  else next.delete("path");
  next.delete("entry");
  next.delete("doc");
  next.delete("skill");
  next.delete("skillFile");
  if (filePath) next.delete("directory");
  if (filePath) next.delete("resource");
  else next.delete("resource");
  setSearchParams(next, { replace: true });
}

export function updateSelectedResource(
  searchParams: URLSearchParams,
  setSearchParams: ReturnType<typeof useSearchParams>[1],
  attachmentId: string,
) {
  const next = new URLSearchParams(searchParams);
  next.set("resource", attachmentId);
  next.delete("doc");
  next.delete("path");
  next.delete("skill");
  next.delete("skillFile");
  next.delete("directory");
  setSearchParams(next, { replace: true });
}

export function updateSelectedSkillFile(
  searchParams: URLSearchParams,
  setSearchParams: ReturnType<typeof useSearchParams>[1],
  skillId: string,
  filePath: string,
) {
  const next = new URLSearchParams(searchParams);
  next.set("skill", skillId);
  next.set("skillFile", filePath);
  next.delete("path");
  next.delete("entry");
  next.delete("doc");
  next.delete("directory");
  next.delete("resource");
  setSearchParams(next, { replace: true });
}

export function updateSelectedDirectory(
  searchParams: URLSearchParams,
  setSearchParams: ReturnType<typeof useSearchParams>[1],
  directoryPath: string | null,
) {
  const next = new URLSearchParams(searchParams);
  if (directoryPath) next.set("directory", directoryPath);
  else next.delete("directory");
  next.delete("path");
  next.delete("entry");
  next.delete("doc");
  next.delete("skill");
  next.delete("skillFile");
  next.delete("resource");
  setSearchParams(next, { replace: true });
}

export function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(value.trim());
}

export function resolveResourceOpenPath(
  attachment: ProjectResourceAttachment,
  workspaceRootPath: string | null,
) {
  const locator = attachment.resource.locator.trim();
  if (!locator || isHttpUrl(locator)) return null;
  if (attachment.resource.sourceType === "library") {
    return joinWorkspacePath(workspaceRootPath, locator);
  }
  if (attachment.resource.kind === "file" || attachment.resource.kind === "directory") {
    return locator;
  }
  return null;
}
