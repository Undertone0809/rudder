import type {
  OrganizationWorkspaceFileDetail,
  OrganizationWorkspaceFileList,
} from "./organization.js";

export const WORKSPACE_BACKUP_RUNNING_INTERVAL_HOURS = 2;
export const WORKSPACE_BACKUP_OFFLINE_INTERVAL_HOURS = 24;
export const WORKSPACE_BACKUP_DEFAULT_INTERVAL_HOURS = WORKSPACE_BACKUP_OFFLINE_INTERVAL_HOURS;
export const WORKSPACE_BACKUP_DEFAULT_RETENTION_DAYS = 30;

export type WorkspaceBackupStatus = "running" | "succeeded" | "failed" | "restored" | "deleted";
export type WorkspaceBackupTriggerSource = "manual" | "scheduled" | "pre_restore";

export interface WorkspaceBackupSummary {
  id: string;
  orgId: string;
  status: WorkspaceBackupStatus;
  triggerSource: WorkspaceBackupTriggerSource;
  artifactProvider: "local_file";
  artifactRef: string;
  archiveSha256: string | null;
  treeSha256: string | null;
  fileCount: number;
  byteSize: number;
  compressedSize: number;
  manifest: Record<string, unknown> | null;
  warnings: string[];
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  expiresAt: string | null;
  restoredFromBackupId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceBackupList {
  backups: WorkspaceBackupSummary[];
}

export interface WorkspaceBackupCreateRequest {
  triggerSource?: WorkspaceBackupTriggerSource;
}

export interface WorkspaceBackupRestoreRequest {
  confirm: boolean;
}

export interface WorkspaceBackupRestoreResult {
  restoredBackup: WorkspaceBackupSummary;
  preRestoreBackup: WorkspaceBackupSummary;
}

export interface WorkspaceBackupDownloadInfo {
  filename: string;
  contentType: "application/json" | "application/zip";
  byteSize: number;
  archiveSha256: string | null;
}

export type WorkspaceBackupFileList = OrganizationWorkspaceFileList;
export type WorkspaceBackupFileDetail = OrganizationWorkspaceFileDetail;
