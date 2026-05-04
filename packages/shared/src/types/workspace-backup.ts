import type {
  OrganizationWorkspaceFileDetail,
  OrganizationWorkspaceFileList,
} from "./organization.js";

export const WORKSPACE_BACKUP_DEFAULT_INTERVAL_HOURS = 24;
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

export type WorkspaceBackupFileList = OrganizationWorkspaceFileList;
export type WorkspaceBackupFileDetail = OrganizationWorkspaceFileDetail;
