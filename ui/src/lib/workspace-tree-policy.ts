import {
  buildLibraryEntryMentionMarkdown,
  buildLibraryFileMentionMarkdown,
  type OrganizationSkillListItem,
  type OrganizationWorkspaceFileEntry,
  type Project,
  type ProjectResourceAttachment,
} from "@rudderhq/shared";
import { getWorkspaceFileExtension } from "./workspace-document-policy";
import { normalizeRequestedPath } from "./workspace-path-policy";

const WORKSPACE_TEXT_IMPORT_FILE_EXTENSIONS = new Set([
  ".md", ".markdown", ".mdown", ".mdx", ".txt", ".text", ".css", ".csv",
  ".html", ".htm", ".js", ".json", ".jsonl", ".jsx", ".log", ".py",
  ".toml", ".ts", ".tsx", ".xml", ".yaml", ".yml",
]);
const WORKSPACE_TEXT_IMPORT_CONTENT_TYPES = new Set([
  "application/json", "application/javascript", "application/typescript", "application/xml",
  "application/x-yaml", "text/csv", "text/html", "text/javascript", "text/markdown",
  "text/plain", "text/xml", "text/yaml",
]);
const PROTECTED_AGENT_INSTRUCTIONS_FILE_NAMES = new Set(["HEARTBEAT.MD", "MEMORY.MD", "SOUL.MD", "TOOLS.MD"]);
const PROTECTED_AGENT_MANAGED_DIRECTORY_NAMES = new Set(["memory", "skills"]);
export const WORKSPACE_ENTRY_DND_MIME = "application/x-rudder-workspace-entry";
const WORKSPACE_TREE_ENTRY_SELECTOR = "[data-workspace-entry-path]";

export type WorkspaceTreeEntry = OrganizationWorkspaceFileEntry & {
  virtualSkillId?: string;
  virtualSkillFilePath?: string | null;
  virtualSkillReadOnlyReason?: string | null;
  virtualSkillSourceLabel?: string | null;
};

export function displayWorkspaceEntryLabel(entry: OrganizationWorkspaceFileEntry) {
  return entry.displayLabel?.trim() || entry.name;
}

export function organizationSkillRootTreePath(skill: Pick<OrganizationSkillListItem, "slug">) {
  return `skills/${skill.slug}`;
}

export function organizationSkillFileTreePath(skill: Pick<OrganizationSkillListItem, "slug">, filePath: string) {
  return `${organizationSkillRootTreePath(skill)}/${filePath.split("/").filter(Boolean).join("/")}`;
}

export function isLibrarySkillPackageFolderPath(path: string) {
  const segments = path.split("/").filter(Boolean);
  return (segments.length === 2 && segments[0] === "skills")
    || (segments.length === 4 && segments[0] === "agents" && segments[2] === "skills");
}

export function isLibrarySkillsRootPath(path: string) {
  const segments = path.split("/").filter(Boolean);
  return path === "skills"
    || (segments.length === 3 && segments[0] === "agents" && segments[2] === "skills");
}

export function isWorkspaceBackedOrganizationSkill(skill: Pick<OrganizationSkillListItem, "workspaceEditPath" | "slug">) {
  const editPath = normalizeRequestedPath(skill.workspaceEditPath);
  return Boolean(editPath && editPath.startsWith(`${organizationSkillRootTreePath(skill)}/`));
}

export function organizationSkillInventoryPaths(skill: OrganizationSkillListItem) {
  const paths = skill.fileInventory
    .map((entry) => normalizeRequestedPath(entry.path))
    .filter((path): path is string => Boolean(path));
  return paths.length > 0 ? paths : ["SKILL.md"];
}

export function buildVirtualOrganizationSkillEntries(
  directoryPath: string,
  workspaceEntries: OrganizationWorkspaceFileEntry[],
  organizationSkills: OrganizationSkillListItem[] | undefined,
): WorkspaceTreeEntry[] {
  const safeOrganizationSkills = organizationSkills ?? [];
  const normalizedDirectoryPath = normalizeRequestedPath(directoryPath) ?? "";
  if (normalizedDirectoryPath === "skills") {
    const workspacePaths = new Set(workspaceEntries.map((entry) => entry.path));
    return safeOrganizationSkills
      .filter((skill) => !isWorkspaceBackedOrganizationSkill(skill))
      .map((skill): WorkspaceTreeEntry => ({
        name: skill.slug,
        displayLabel: skill.name?.trim() || skill.slug,
        path: organizationSkillRootTreePath(skill),
        isDirectory: true,
        virtualSkillId: skill.id,
        virtualSkillReadOnlyReason: skill.editableReason,
        virtualSkillSourceLabel: skill.sourceLabel,
      }))
      .filter((entry) => !workspacePaths.has(entry.path));
  }

  const skill = safeOrganizationSkills.find((candidate) => {
    if (isWorkspaceBackedOrganizationSkill(candidate)) return false;
    const rootPath = organizationSkillRootTreePath(candidate);
    return normalizedDirectoryPath === rootPath || normalizedDirectoryPath.startsWith(`${rootPath}/`);
  });
  if (!skill) return [];

  const rootPath = organizationSkillRootTreePath(skill);
  const currentRelativeDirectory = normalizedDirectoryPath === rootPath
    ? ""
    : normalizedDirectoryPath.slice(rootPath.length + 1);
  const entriesByPath = new Map<string, WorkspaceTreeEntry>();
  for (const filePath of organizationSkillInventoryPaths(skill)) {
    if (currentRelativeDirectory && filePath !== currentRelativeDirectory && !filePath.startsWith(`${currentRelativeDirectory}/`)) {
      continue;
    }
    const remaining = currentRelativeDirectory ? filePath.slice(currentRelativeDirectory.length + 1) : filePath;
    const [name] = remaining.split("/");
    if (!name) continue;
    const childRelativePath = currentRelativeDirectory ? `${currentRelativeDirectory}/${name}` : name;
    const isDirectory = remaining.includes("/");
    const childTreePath = `${rootPath}/${childRelativePath}`;
    entriesByPath.set(childTreePath, {
      name,
      displayLabel: name,
      path: childTreePath,
      isDirectory,
      virtualSkillId: skill.id,
      virtualSkillFilePath: isDirectory ? null : childRelativePath,
      virtualSkillReadOnlyReason: skill.editableReason,
      virtualSkillSourceLabel: skill.sourceLabel,
    });
  }
  return [...entriesByPath.values()].sort((left, right) =>
    Number(right.isDirectory) - Number(left.isDirectory)
    || displayWorkspaceEntryLabel(left).localeCompare(displayWorkspaceEntryLabel(right)),
  );
}

export function mergeWorkspaceAndVirtualSkillEntries(
  directoryPath: string,
  workspaceEntries: OrganizationWorkspaceFileEntry[],
  organizationSkills: OrganizationSkillListItem[] | undefined,
): WorkspaceTreeEntry[] {
  const normalizedDirectoryPath = normalizeRequestedPath(directoryPath) ?? "";
  if (normalizedDirectoryPath === "") {
    const hasVisibleSkill = (organizationSkills ?? []).some((skill) => !isWorkspaceBackedOrganizationSkill(skill));
    if (!hasVisibleSkill || workspaceEntries.some((entry) => entry.path === "skills")) return workspaceEntries;
    return [...workspaceEntries, {
      name: "skills",
      displayLabel: "skills",
      path: "skills",
      isDirectory: true,
    }].sort((left, right) =>
      Number(right.isDirectory) - Number(left.isDirectory)
      || displayWorkspaceEntryLabel(left).localeCompare(displayWorkspaceEntryLabel(right)),
    );
  }
  const virtualEntries = buildVirtualOrganizationSkillEntries(directoryPath, workspaceEntries, organizationSkills);
  if (virtualEntries.length === 0) return workspaceEntries;
  return [...workspaceEntries, ...virtualEntries].sort((left, right) =>
    Number(right.isDirectory) - Number(left.isDirectory)
    || displayWorkspaceEntryLabel(left).localeCompare(displayWorkspaceEntryLabel(right)),
  );
}

export function projectLibraryPath(project: Pick<Project, "urlKey" | "id">) {
  return `projects/${project.urlKey || project.id}`;
}

export function projectResourceFolderPath(project: Pick<Project, "urlKey" | "id">) {
  return `${projectLibraryPath(project)}/resources`;
}

export function projectResourceEntryPath(project: Pick<Project, "urlKey" | "id">, attachment: Pick<ProjectResourceAttachment, "id">) {
  return `${projectResourceFolderPath(project)}/${attachment.id}`;
}

export type ProjectResourceTreeGroup = {
  project: Project;
  resources: ProjectResourceAttachment[];
};

export function buildProjectResourceTreeGroups(projects: Project[] | undefined) {
  const groups = new Map<string, ProjectResourceTreeGroup>();
  for (const project of projects ?? []) {
    groups.set(projectLibraryPath(project), {
      project,
      resources: [...project.resources].sort((left, right) =>
        left.sortOrder - right.sortOrder || left.resource.name.localeCompare(right.resource.name),
      ),
    });
  }
  return groups;
}

export function findProjectResourceSelection(projects: Project[], attachmentId: string | null) {
  if (!attachmentId) return null;
  for (const project of projects) {
    const attachment = project.resources.find((candidate) => candidate.id === attachmentId);
    if (attachment) {
      return {
        project,
        attachment,
        path: projectResourceEntryPath(project, attachment),
      };
    }
  }
  return null;
}

export function isProtectedAgentWorkspaceContainerPath(filePath: string) {
  if (filePath === "agents") return true;
  const segments = filePath.split("/").filter(Boolean);
  return segments.length === 2 && segments[0] === "agents";
}

export function isProtectedAgentInstructionsEntryPath(filePath: string) {
  const segments = filePath.split("/").filter(Boolean);
  if (segments.length === 3) {
    return segments[0] === "agents" && segments[2] === "instructions";
  }
  if (segments.length === 4 && segments[0] === "agents" && segments[2] === "instructions") {
    return PROTECTED_AGENT_INSTRUCTIONS_FILE_NAMES.has(segments[3]?.toUpperCase() ?? "");
  }
  return false;
}

export function isLegacyAgentHeartbeatInstructionPath(filePath: string | null | undefined) {
  const segments = (filePath ?? "").split("/").filter(Boolean);
  return segments.length === 4
    && segments[0] === "agents"
    && segments[2] === "instructions"
    && segments[3]?.toUpperCase() === "HEARTBEAT.MD";
}

export function isProtectedAgentManagedEntryPath(filePath: string) {
  const segments = filePath.split("/").filter(Boolean);
  return segments.length >= 3
    && segments[0] === "agents"
    && PROTECTED_AGENT_MANAGED_DIRECTORY_NAMES.has(segments[2]?.toLowerCase() ?? "");
}

export function isProtectedOrganizationSkillsEntryPath(filePath: string) {
  return filePath.split("/").filter(Boolean)[0]?.toLowerCase() === "skills";
}

export function canCreateInsideWorkspaceDirectory(directoryPath: string) {
  return !isProtectedAgentWorkspaceContainerPath(directoryPath)
    && !isProtectedOrganizationSkillsEntryPath(directoryPath);
}

export function canMoveWorkspaceEntry(entry: Pick<OrganizationWorkspaceFileEntry, "path">) {
  return !isProtectedAgentWorkspaceContainerPath(entry.path)
    && !isProtectedAgentInstructionsEntryPath(entry.path)
    && !isProtectedAgentManagedEntryPath(entry.path)
    && !isProtectedOrganizationSkillsEntryPath(entry.path);
}

export function canCopyWorkspaceEntry(entry: Pick<OrganizationWorkspaceFileEntry, "path">) {
  return canMoveWorkspaceEntry(entry);
}

export function canRenameWorkspaceEntry(entry: Pick<OrganizationWorkspaceFileEntry, "path">) {
  return !isProtectedAgentWorkspaceContainerPath(entry.path)
    && !isProtectedAgentInstructionsEntryPath(entry.path)
    && !isProtectedAgentManagedEntryPath(entry.path)
    && !isProtectedOrganizationSkillsEntryPath(entry.path);
}

export function canDeleteWorkspaceEntry(entry: Pick<OrganizationWorkspaceFileEntry, "path">) {
  return !isProtectedAgentWorkspaceContainerPath(entry.path)
    && !isProtectedAgentInstructionsEntryPath(entry.path)
    && !isProtectedAgentManagedEntryPath(entry.path)
    && !isProtectedOrganizationSkillsEntryPath(entry.path)
    && !isProjectLibraryFolderPath(entry.path);
}

export function isProjectLibraryFolderPath(filePath: string) {
  const segments = filePath.split("/").filter(Boolean);
  return segments.length === 2 && segments[0] === "projects";
}

export function parentWorkspaceDirectoryPath(entryPath: string) {
  const segments = entryPath.split("/").filter(Boolean);
  segments.pop();
  return segments.join("/");
}

export function applyMovedWorkspacePath(currentPath: string, previousPath: string, nextPath: string) {
  if (currentPath === previousPath) return nextPath;
  if (currentPath.startsWith(`${previousPath}/`)) {
    return `${nextPath}${currentPath.slice(previousPath.length)}`;
  }
  return currentPath;
}

export function canDropWorkspaceEntryIntoDirectory(
  source: Pick<OrganizationWorkspaceFileEntry, "path" | "isDirectory">,
  destinationDirectoryPath: string,
) {
  if (!canMoveWorkspaceEntry(source)) return false;
  if (!canCreateInsideWorkspaceDirectory(destinationDirectoryPath)) return false;
  if (source.path === destinationDirectoryPath) return false;
  if (source.isDirectory && destinationDirectoryPath.startsWith(`${source.path}/`)) return false;
  return parentWorkspaceDirectoryPath(source.path) !== destinationDirectoryPath;
}

export function hasWorkspaceDragPayload(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.types).includes(WORKSPACE_ENTRY_DND_MIME);
}

export function hasExternalFileDragPayload(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.types).includes("Files") || dataTransfer.files.length > 0;
}

export function isWorkspaceTextImportFile(file: File) {
  const contentType = file.type.toLowerCase().split(";")[0]?.trim() ?? "";
  if (contentType.startsWith("text/") || WORKSPACE_TEXT_IMPORT_CONTENT_TYPES.has(contentType)) return true;
  const extension = getWorkspaceFileExtension(file.name);
  return extension !== null && WORKSPACE_TEXT_IMPORT_FILE_EXTENSIONS.has(extension);
}

export function getWorkspaceImportDropFiles(dataTransfer: DataTransfer) {
  const files = Array.from(dataTransfer.files);
  const supported = files.filter((file) => isValidWorkspaceEntryName(file.name) && isWorkspaceTextImportFile(file));
  return {
    supported,
    unsupportedCount: files.length - supported.length,
  };
}

export function isDraggingOverWorkspaceTreeEntry(event: { target: EventTarget | null }) {
  return event.target instanceof HTMLElement && Boolean(event.target.closest(WORKSPACE_TREE_ENTRY_SELECTOR));
}

export function isValidWorkspaceEntryName(name: string) {
  const trimmed = name.trim();
  return Boolean(trimmed)
    && trimmed !== "."
    && trimmed !== ".."
    && !trimmed.includes("/")
    && !trimmed.includes("\\");
}

export function joinWorkspaceEntryPath(parentPath: string, name: string) {
  return parentPath ? `${parentPath}/${name}` : name;
}

export function joinWorkspacePath(rootPath: string | null, entryPath: string) {
  if (!rootPath) return entryPath;
  return `${rootPath.replace(/\/+$/, "")}/${entryPath}`;
}

export function buildWorkspaceFileLinkMarkdown(filePath: string, label: string, libraryEntryId?: string | null) {
  return libraryEntryId
    ? buildLibraryEntryMentionMarkdown(libraryEntryId, label, filePath)
    : buildLibraryFileMentionMarkdown(filePath, label);
}

export function buildWorkspaceDirectoryLinkMarkdown(directoryPath: string, label: string) {
  return `[${label.replace(/([\\[\]])/g, "\\$1")}](/library?directory=${encodeURIComponent(directoryPath)})`;
}

export function buildWorkspaceEntryLinkMarkdown(entry: OrganizationWorkspaceFileEntry) {
  const label = displayWorkspaceEntryLabel(entry);
  return entry.isDirectory
    ? buildWorkspaceDirectoryLinkMarkdown(entry.path, label)
    : buildWorkspaceFileLinkMarkdown(entry.path, label, entry.libraryEntryId);
}

export function displayWorkspaceFileTabLabel(filePath: string) {
  return filePath.split("/").filter(Boolean).at(-1) ?? filePath;
}

export interface WorkspacePathBreadcrumbPart {
  label: string;
  path: string;
  isFile: boolean;
  kind: "folder" | "file" | "agents_root" | "agent_workspace";
  agentIcon?: string | null;
  agentRole?: OrganizationWorkspaceFileEntry["agentRole"];
}

export function workspacePathBreadcrumb(
  entryPath: string,
  agentWorkspaceEntryByName: Map<string, OrganizationWorkspaceFileEntry>,
  entryKind: "file" | "directory",
  rootLabel: string,
): WorkspacePathBreadcrumbPart[] {
  const segments = entryPath.split("/").filter(Boolean);
  const rootPart: WorkspacePathBreadcrumbPart = {
    label: rootLabel,
    path: "",
    isFile: false,
    kind: "folder",
  };
  if (segments.length === 0) return [rootPart];
  return [rootPart, ...segments.map((segment, index): WorkspacePathBreadcrumbPart => {
    const path = segments.slice(0, index + 1).join("/");
    const isFile = entryKind === "file" && index === segments.length - 1;
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
  })];
}

export function applyOrganizationSkillBreadcrumbLabels(
  parts: WorkspacePathBreadcrumbPart[],
  skill: OrganizationSkillListItem | null,
) {
  if (!skill) return parts;
  const skillRootPath = organizationSkillRootTreePath(skill);
  return parts.map((part) => (
    part.path === skillRootPath
      ? { ...part, label: skill.name?.trim() || skill.slug }
      : part
  ));
}
