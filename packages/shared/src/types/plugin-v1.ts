export type RudderPluginSourceType = "local_upload" | "marketplace" | "git" | "package";
export type RudderPluginCatalogSourceKind = "codex_plugin" | "skills_add";
export type RudderPluginSkillConflictStrategy = "keep" | "replace" | "rename";
export type RudderPluginComponentType = "skill" | "mcp" | "app" | "unsupported";
export type RudderPluginComponentStatus = "ready" | "setup_required" | "unsupported" | "disabled";

export interface RudderPluginPackageFileInput {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
}

export interface RudderPluginCompatibilityComponent {
  key: string;
  type: RudderPluginComponentType;
  name: string;
  path: string | null;
  status: RudderPluginComponentStatus;
  required: boolean;
  detail: string | null;
  metadata: Record<string, unknown>;
}

export interface RudderPluginCapabilitySnapshot {
  status: RudderPluginComponentStatus;
  executionSurface: Record<string, unknown>;
}

export interface RudderPluginCapabilityChange {
  kind: "added" | "removed" | "changed";
  key: string;
  type: RudderPluginComponentType;
  name: string;
  accessImpact: "expanded" | "reduced" | "changed" | "none";
  detail: string;
  before: RudderPluginCapabilitySnapshot | null;
  after: RudderPluginCapabilitySnapshot | null;
}

export interface RudderPluginCapabilityDiff {
  changes: RudderPluginCapabilityChange[];
  accessExpansion: boolean;
}

export interface RudderPluginImportReport {
  id: string;
  orgId: string;
  packageId: string | null;
  sourceType: RudderPluginSourceType;
  sourceLabel: string;
  status: "preview" | "accepted" | "rejected" | "failed";
  digest: string | null;
  manifest: Record<string, unknown> | null;
  components: RudderPluginCompatibilityComponent[];
  warnings: string[];
  errors: string[];
  limits: {
    fileCount: number;
    totalBytes: number;
  };
  createdAt: string;
  operation: "install" | "update";
  installedPluginId: string | null;
  capabilityDiff: RudderPluginCapabilityDiff | null;
  skillConflicts: Array<{
    componentKey: string;
    skillKey: string;
    skillName: string;
    existingSkillId: string;
    existingSkillName: string;
  }>;
}

export interface RudderPluginCatalogEntry {
  slug: string;
  displayName: string;
  developer: string;
  category: string;
  shortDescription: string;
  sourceKind: RudderPluginCatalogSourceKind;
  iconUrl: string;
  installedPluginId: string | null;
  installedVersion: string | null;
  installedSourceSha: string | null;
  latestVersion: string | null;
  latestSourceSha: string | null;
  updateAvailable: boolean;
}

export interface RudderPluginCatalog {
  entries: RudderPluginCatalogEntry[];
  freshness: "fresh" | "stale";
  updatedAt: string;
}

export interface RudderPluginSourceResolution {
  repositoryUrl: string;
  source: string;
  subdirectory: string;
  strategy: "stable_release" | "default_branch_head" | "explicit_ref";
  version: string;
  commitSha: string;
}

export interface RudderPluginDetail {
  slug: string;
  displayName: string;
  developer: string;
  category: string;
  shortDescription: string;
  longDescription: string;
  capabilities: string[];
  websiteUrl: string;
  privacyPolicyUrl: string;
  termsOfServiceUrl: string;
  license: { spdx: string; sourceUrl: string; note: string };
  sourceKind: RudderPluginCatalogSourceKind;
  iconUrl: string;
  previewId: string | null;
  packageId: string;
  action: "install" | "update" | "installed";
  installedPluginId: string | null;
  resolution: RudderPluginSourceResolution;
  components: RudderPluginCompatibilityComponent[];
  groups: {
    skills: RudderPluginCompatibilityComponent[];
    mcps: RudderPluginCompatibilityComponent[];
    apps: RudderPluginCompatibilityComponent[];
    unsupported: RudderPluginCompatibilityComponent[];
  };
  warnings: string[];
  capabilityDiff: RudderPluginCapabilityDiff | null;
  skillConflicts: RudderPluginImportReport["skillConflicts"];
}

export interface RudderPluginComponentLink {
  id: string;
  type: RudderPluginComponentType;
  key: string;
  displayName: string;
  status: RudderPluginComponentStatus;
  targetId: string | null;
  metadata: Record<string, unknown>;
}

export interface RudderInstalledPlugin {
  id: string;
  orgId: string;
  packageId: string;
  previousPackageId: string | null;
  name: string;
  displayName: string;
  description: string | null;
  version: string;
  publisher: string | null;
  sourceLabel: string;
  digest: string;
  enabled: boolean;
  lifecycleState: "installed" | "uninstalling" | "uninstalled";
  setupState: "not_required" | "setup_required" | "configuring" | "ready" | "blocked";
  healthState: "unknown" | "healthy" | "degraded" | "unavailable";
  updateState: "none" | "available" | "review_required" | "applying" | "failed";
  components: RudderPluginComponentLink[];
  manifest: Record<string, unknown>;
  pendingUpdate: null | {
    packageId: string;
    version: string;
    digest: string;
    displayName: string;
    sourceLabel: string;
  };
  installedAt: string;
  updatedAt: string;
}

export interface RudderPluginDiscoverEntry {
  reportId: string;
  packageId: string;
  catalogSlug: string | null;
  name: string;
  displayName: string;
  description: string | null;
  version: string;
  publisher: string | null;
  sourceLabel: string;
  sourceType: "marketplace" | "git";
  digest: string;
  category: string | null;
  policy: Record<string, unknown>;
  components: RudderPluginCompatibilityComponent[];
}

export interface RudderLocalAppPlugin {
  id: string;
  kind: "local_app";
  appId: string;
  name: string;
  description: string | null;
  buildStatus: string;
  appKey: string | null;
  updatedAt: string;
}

export interface RudderPluginDirectory {
  installed: RudderInstalledPlugin[];
  localApps: RudderLocalAppPlugin[];
  discover: RudderPluginDiscoverEntry[];
  discoverSource: "none" | "configured";
}

export interface RudderPluginArchiveInput {
  sourceLabel: string;
  filename: string;
  content: string;
  encoding: "base64";
}

export interface RudderPluginMarketplaceInput {
  sourceLabel: string;
  files?: RudderPluginPackageFileInput[];
  github?: {
    repository: string;
    commit: string;
  };
}

export interface RudderMcpUiResource {
  uri: string;
  name: string;
  description: string | null;
  mimeType: string;
}

export interface RudderMcpUiResourceContent extends RudderMcpUiResource {
  html: string;
}
