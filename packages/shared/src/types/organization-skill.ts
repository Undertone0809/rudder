export type OrganizationSkillSourceType = "local_path" | "github" | "url" | "catalog" | "skills_sh";

export type OrganizationSkillTrustLevel = "markdown_only" | "assets" | "scripts_executables";

export type OrganizationSkillCompatibility = "compatible" | "unknown" | "invalid";

export type OrganizationSkillSourceBadge =
  | "rudder"
  | "community"
  | "github"
  | "local"
  | "url"
  | "catalog"
  | "skills_sh";

export type OrganizationSkillWorkspaceEditPath = string | null;

export interface OrganizationSkillFileInventoryEntry {
  path: string;
  kind: "skill" | "markdown" | "reference" | "script" | "asset" | "other";
}

export interface OrganizationSkill {
  id: string;
  orgId: string;
  key: string;
  slug: string;
  name: string;
  description: string | null;
  markdown: string;
  sourceType: OrganizationSkillSourceType;
  sourceLocator: string | null;
  sourceRef: string | null;
  trustLevel: OrganizationSkillTrustLevel;
  compatibility: OrganizationSkillCompatibility;
  fileInventory: OrganizationSkillFileInventoryEntry[];
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrganizationSkillListItem {
  id: string;
  orgId: string;
  key: string;
  slug: string;
  name: string;
  description: string | null;
  sourceType: OrganizationSkillSourceType;
  sourceLocator: string | null;
  sourceRef: string | null;
  trustLevel: OrganizationSkillTrustLevel;
  compatibility: OrganizationSkillCompatibility;
  fileInventory: OrganizationSkillFileInventoryEntry[];
  createdAt: Date;
  updatedAt: Date;
  attachedAgentCount: number;
  editable: boolean;
  editableReason: string | null;
  sourceLabel: string | null;
  sourceBadge: OrganizationSkillSourceBadge;
  sourcePath: string | null;
  workspaceEditPath: OrganizationSkillWorkspaceEditPath;
}

export interface OrganizationSkillUsageAgent {
  id: string;
  name: string;
  urlKey: string;
  agentRuntimeType: string;
  desired: boolean;
  actualState: string | null;
}

export interface OrganizationSkillDetail extends OrganizationSkill {
  attachedAgentCount: number;
  usedByAgents: OrganizationSkillUsageAgent[];
  editable: boolean;
  editableReason: string | null;
  sourceLabel: string | null;
  sourceBadge: OrganizationSkillSourceBadge;
  sourcePath: string | null;
  workspaceEditPath: OrganizationSkillWorkspaceEditPath;
}

export interface OrganizationSkillUpdateStatus {
  supported: boolean;
  reason: string | null;
  trackingRef: string | null;
  currentRef: string | null;
  latestRef: string | null;
  hasUpdate: boolean;
}

export interface OrganizationSkillImportRequest {
  source: string;
}

export interface OrganizationSkillImportResult {
  imported: OrganizationSkill[];
  warnings: string[];
}

export interface OrganizationSkillProjectScanRequest {
  projectIds?: string[];
  workspaceIds?: string[];
}

export interface OrganizationSkillProjectScanSkipped {
  projectId: string;
  projectName: string;
  workspaceId: string | null;
  workspaceName: string | null;
  path: string | null;
  reason: string;
}

export interface OrganizationSkillProjectScanConflict {
  slug: string;
  key: string;
  projectId: string;
  projectName: string;
  workspaceId: string;
  workspaceName: string;
  path: string;
  existingSkillId: string;
  existingSkillKey: string;
  existingSourceLocator: string | null;
  reason: string;
}

export interface OrganizationSkillProjectScanResult {
  scannedProjects: number;
  scannedWorkspaces: number;
  discovered: number;
  imported: OrganizationSkill[];
  updated: OrganizationSkill[];
  skipped: OrganizationSkillProjectScanSkipped[];
  conflicts: OrganizationSkillProjectScanConflict[];
  warnings: string[];
}

export interface OrganizationSkillLocalScanRequest {
  roots?: string[];
}

export interface OrganizationSkillLocalScanSkipped {
  root: string;
  path: string | null;
  reason: string;
}

export interface OrganizationSkillLocalScanConflict {
  root: string;
  path: string;
  slug: string;
  key: string;
  existingSkillId: string;
  existingSkillKey: string;
  existingSourceLocator: string | null;
  reason: string;
}

export interface OrganizationSkillLocalScanResult {
  scannedRoots: number;
  discovered: number;
  imported: OrganizationSkill[];
  updated: OrganizationSkill[];
  skipped: OrganizationSkillLocalScanSkipped[];
  conflicts: OrganizationSkillLocalScanConflict[];
  warnings: string[];
}

export interface OrganizationSkillCreateRequest {
  name: string;
  slug?: string | null;
  description?: string | null;
  markdown?: string | null;
}

export interface OrganizationSkillFileDetail {
  skillId: string;
  path: string;
  kind: OrganizationSkillFileInventoryEntry["kind"];
  content: string;
  language: string | null;
  markdown: boolean;
  editable: boolean;
}

export interface OrganizationSkillFileUpdateRequest {
  path: string;
  content: string;
}
