import type { AgentRole, OrganizationStatus, PauseReason } from "../constants.js";
import type { ChatIssueCreationMode } from "../constants.js";
import type { ProjectWorkspaceSourceType } from "./project.js";

export interface OrganizationWorkspace {
  sourceType: ProjectWorkspaceSourceType;
  cwd: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  defaultRef: string | null;
}

export type OrganizationWorkspaceRootSource = "org_root";

export type OrganizationWorkspaceFileEntryEntityType = "agent_workspace";

export interface OrganizationWorkspaceFileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  libraryEntryId?: string | null;
  displayLabel?: string;
  entityType?: OrganizationWorkspaceFileEntryEntityType;
  agentId?: string;
  agentIcon?: string | null;
  agentRole?: AgentRole | null;
  workspaceKey?: string;
}

export interface OrganizationWorkspaceFileList {
  source: OrganizationWorkspaceRootSource;
  rootPath: string | null;
  repoUrl: string | null;
  directoryPath: string;
  rootExists: boolean;
  entries: OrganizationWorkspaceFileEntry[];
  message: string | null;
}

export interface OrganizationWorkspaceFileDetail {
  source: OrganizationWorkspaceRootSource;
  rootPath: string | null;
  repoUrl: string | null;
  filePath: string;
  libraryEntryId: string | null;
  rootExists: boolean;
  content: string | null;
  contentType: string | null;
  previewKind: "text" | "image" | "binary";
  contentPath: string | null;
  message: string | null;
  truncated: boolean;
}

export interface OrganizationWorkspaceFileUpdateRequest {
  content: string;
}

export interface OrganizationWorkspaceFileCreateRequest {
  filePath: string;
  content?: string;
}

export interface OrganizationWorkspaceDirectoryCreateRequest {
  directoryPath: string;
}

export interface OrganizationWorkspaceEntryRenameRequest {
  name: string;
}

export interface OrganizationWorkspaceEntryMoveRequest {
  destinationDirectoryPath: string;
}

export interface OrganizationWorkspaceEntryMutationResult {
  path: string;
  previousPath?: string;
  isDirectory?: boolean;
  libraryEntryId?: string | null;
}

export interface LibraryEntry {
  id: string;
  orgId: string;
  kind: "file";
  sourceType: "workspace_file";
  currentPath: string | null;
  title: string;
  status: "active" | "archived" | "deleted";
  createdAt: Date;
  updatedAt: Date;
}

export interface Organization {
  id: string;
  name: string;
  urlKey: string;
  description: string | null;
  status: OrganizationStatus;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  issuePrefix: string;
  issueCounter: number;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  requireBoardApprovalForNewAgents: boolean;
  defaultChatIssueCreationMode: ChatIssueCreationMode;
  workspace: OrganizationWorkspace | null;
  brandColor: string | null;
  logoAssetId: string | null;
  logoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}
