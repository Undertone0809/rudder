export interface OrganizationPortabilityInclude {
  organization: boolean;
  agents: boolean;
  projects: boolean;
  issues: boolean;
  skills: boolean;
}

export interface OrganizationPortabilityEnvInput {
  key: string;
  description: string | null;
  agentSlug: string | null;
  kind: "secret" | "plain";
  requirement: "required" | "optional";
  defaultValue: string | null;
  portability: "portable" | "system_dependent";
}

export type OrganizationPortabilityFileEntry =
  | string
  | {
      encoding: "base64";
      data: string;
      contentType?: string | null;
    };

export interface OrganizationPortabilityOrganizationManifestEntry {
  path: string;
  name: string;
  description: string | null;
  brandColor: string | null;
  logoPath: string | null;
  requireBoardApprovalForNewAgents: boolean;
}

export interface OrganizationPortabilitySidebarOrder {
  agents: string[];
  projects: string[];
}

export interface OrganizationPortabilityProjectManifestEntry {
  slug: string;
  name: string;
  path: string;
  description: string | null;
  ownerAgentSlug: string | null;
  leadAgentSlug: string | null;
  targetDate: string | null;
  color: string | null;
  status: string | null;
  executionWorkspacePolicy: Record<string, unknown> | null;
  workspaces: OrganizationPortabilityProjectWorkspaceManifestEntry[];
  metadata: Record<string, unknown> | null;
}

export interface OrganizationPortabilityProjectWorkspaceManifestEntry {
  key: string;
  name: string;
  sourceType: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  defaultRef: string | null;
  visibility: string | null;
  setupCommand: string | null;
  cleanupCommand: string | null;
  metadata: Record<string, unknown> | null;
  isPrimary: boolean;
}

export interface OrganizationPortabilityIssueAutomationTriggerManifestEntry {
  kind: string;
  label: string | null;
  enabled: boolean;
  cronExpression: string | null;
  timezone: string | null;
  signingMode: string | null;
  replayWindowSec: number | null;
}

export interface OrganizationPortabilityIssueAutomationManifestEntry {
  concurrencyPolicy: string | null;
  catchUpPolicy: string | null;
  triggers: OrganizationPortabilityIssueAutomationTriggerManifestEntry[];
}

export interface OrganizationPortabilityIssueManifestEntry {
  slug: string;
  identifier: string | null;
  title: string;
  path: string;
  projectSlug: string | null;
  projectWorkspaceKey: string | null;
  assigneeAgentSlug: string | null;
  parentIssueSlug: string | null;
  description: string | null;
  recurring: boolean;
  automation: OrganizationPortabilityIssueAutomationManifestEntry | null;
  legacyRecurrence: Record<string, unknown> | null;
  status: string | null;
  priority: string | null;
  labelIds: string[];
  billingCode: string | null;
  executionWorkspaceSettings: Record<string, unknown> | null;
  assigneeAgentRuntimeOverrides: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

export interface OrganizationPortabilityAgentManifestEntry {
  slug: string;
  name: string;
  path: string;
  skills: string[];
  role: string;
  title: string | null;
  icon: string | null;
  capabilities: string | null;
  reportsToSlug: string | null;
  agentRuntimeType: string;
  agentRuntimeConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  permissions: Record<string, unknown>;
  budgetMonthlyCents: number;
  metadata: Record<string, unknown> | null;
}

export interface OrganizationPortabilitySkillManifestEntry {
  key: string;
  slug: string;
  name: string;
  path: string;
  description: string | null;
  sourceType: string;
  sourceLocator: string | null;
  sourceRef: string | null;
  trustLevel: string | null;
  compatibility: string | null;
  metadata: Record<string, unknown> | null;
  fileInventory: Array<{
    path: string;
    kind: string;
  }>;
}

export interface OrganizationPortabilityManifest {
  schemaVersion: number;
  generatedAt: string;
  source: {
    orgId: string;
    organizationName: string;
  } | null;
  includes: OrganizationPortabilityInclude;
  organization: OrganizationPortabilityOrganizationManifestEntry | null;
  sidebar: OrganizationPortabilitySidebarOrder | null;
  agents: OrganizationPortabilityAgentManifestEntry[];
  skills: OrganizationPortabilitySkillManifestEntry[];
  projects: OrganizationPortabilityProjectManifestEntry[];
  issues: OrganizationPortabilityIssueManifestEntry[];
  envInputs: OrganizationPortabilityEnvInput[];
}

export interface OrganizationPortabilityExportResult {
  rootPath: string;
  manifest: OrganizationPortabilityManifest;
  files: Record<string, OrganizationPortabilityFileEntry>;
  warnings: string[];
  rudderExtensionPath: string;
}

export interface OrganizationPortabilityExportPreviewFile {
  path: string;
  kind: "organization" | "agent" | "skill" | "project" | "issue" | "extension" | "readme" | "other";
}

export interface OrganizationPortabilityExportPreviewResult {
  rootPath: string;
  manifest: OrganizationPortabilityManifest;
  files: Record<string, OrganizationPortabilityFileEntry>;
  fileInventory: OrganizationPortabilityExportPreviewFile[];
  counts: {
    files: number;
    agents: number;
    skills: number;
    projects: number;
    issues: number;
  };
  warnings: string[];
  rudderExtensionPath: string;
}

export type OrganizationPortabilitySource =
  | {
      type: "inline";
      rootPath?: string | null;
      files: Record<string, OrganizationPortabilityFileEntry>;
    }
  | {
      type: "github";
      url: string;
    };

export type OrganizationPortabilityImportTarget =
  | {
      mode: "new_organization";
      newOrganizationName?: string | null;
    }
  | {
      mode: "existing_organization";
      orgId: string;
    };

export type OrganizationPortabilityAgentSelection = "all" | string[];

export type OrganizationPortabilityCollisionStrategy = "rename" | "skip" | "replace";

export interface OrganizationPortabilityPreviewRequest {
  source: OrganizationPortabilitySource;
  include?: Partial<OrganizationPortabilityInclude>;
  target: OrganizationPortabilityImportTarget;
  agents?: OrganizationPortabilityAgentSelection;
  collisionStrategy?: OrganizationPortabilityCollisionStrategy;
  nameOverrides?: Record<string, string>;
  selectedFiles?: string[];
}

export interface OrganizationPortabilityPreviewAgentPlan {
  slug: string;
  action: "create" | "update" | "skip";
  plannedName: string;
  existingAgentId: string | null;
  reason: string | null;
}

export interface OrganizationPortabilityPreviewProjectPlan {
  slug: string;
  action: "create" | "update" | "skip";
  plannedName: string;
  existingProjectId: string | null;
  reason: string | null;
}

export interface OrganizationPortabilityPreviewIssuePlan {
  slug: string;
  action: "create" | "skip";
  plannedTitle: string;
  reason: string | null;
}

export interface OrganizationPortabilityPreviewResult {
  include: OrganizationPortabilityInclude;
  targetOrganizationId: string | null;
  targetOrganizationName: string | null;
  collisionStrategy: OrganizationPortabilityCollisionStrategy;
  selectedAgentSlugs: string[];
  plan: {
    organizationAction: "none" | "create" | "update";
    agentPlans: OrganizationPortabilityPreviewAgentPlan[];
    projectPlans: OrganizationPortabilityPreviewProjectPlan[];
    issuePlans: OrganizationPortabilityPreviewIssuePlan[];
  };
  manifest: OrganizationPortabilityManifest;
  files: Record<string, OrganizationPortabilityFileEntry>;
  envInputs: OrganizationPortabilityEnvInput[];
  warnings: string[];
  errors: string[];
}

export interface OrganizationPortabilityAgentRuntimeOverride {
  agentRuntimeType: string;
  agentRuntimeConfig?: Record<string, unknown>;
}

export interface OrganizationPortabilityImportRequest extends OrganizationPortabilityPreviewRequest {
  agentRuntimeOverrides?: Record<string, OrganizationPortabilityAgentRuntimeOverride>;
}

export interface OrganizationPortabilityImportResult {
  organization: {
    id: string;
    name: string;
    action: "created" | "updated" | "unchanged";
  };
  agents: {
    slug: string;
    id: string | null;
    action: "created" | "updated" | "skipped";
    name: string;
    reason: string | null;
  }[];
  projects: {
    slug: string;
    id: string | null;
    action: "created" | "updated" | "skipped";
    name: string;
    reason: string | null;
  }[];
  envInputs: OrganizationPortabilityEnvInput[];
  warnings: string[];
}

export interface OrganizationPortabilityExportRequest {
  include?: Partial<OrganizationPortabilityInclude>;
  agents?: string[];
  skills?: string[];
  projects?: string[];
  issues?: string[];
  projectIssues?: string[];
  selectedFiles?: string[];
  expandReferencedSkills?: boolean;
  sidebarOrder?: Partial<OrganizationPortabilitySidebarOrder>;
}
