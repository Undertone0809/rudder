import type { Issue, Organization, Project } from "@rudderhq/shared";

export type LinearStateMapping = {
  linearStateId: string;
  linearStateName?: string;
  rudderStatus: Issue["status"];
};

export type LinearTeamMapping = {
  teamId: string;
  teamName?: string;
  stateMappings: LinearStateMapping[];
};

export type LinearOrganizationMapping = {
  orgId: string;
  teamMappings: LinearTeamMapping[];
};

export type LinearPluginConfig = {
  apiTokenSecretRef?: string;
  organizationMappings: LinearOrganizationMapping[];
  /** Internal test-only switch. Not exposed in the public settings schema. */
  fixtureMode?: boolean;
};

export type LinearUserSummary = {
  id: string;
  name: string;
  email?: string | null;
};

export type LinearProjectSummary = {
  id: string;
  name: string;
};

export type LinearStateSummary = {
  id: string;
  name: string;
  type?: string | null;
};

export type LinearTeamSummary = {
  id: string;
  key: string;
  name: string;
  states: LinearStateSummary[];
};

export type LinearIssueSummary = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  updatedAt: string;
  createdAt?: string | null;
  team: LinearTeamSummary;
  state: LinearStateSummary;
  project: LinearProjectSummary | null;
  assignee: LinearUserSummary | null;
};

export type LinearIssueListFilters = {
  allowedTeamIds: string[];
  teamId?: string;
  stateId?: string;
  projectId?: string;
  assigneeId?: string;
  query?: string;
};

export type LinearIssueConnection = {
  nodes: LinearIssueSummary[];
  endCursor: string | null;
  hasNextPage: boolean;
};

export type LinearCatalog = {
  teams: LinearTeamSummary[];
  projects: LinearProjectSummary[];
  users: LinearUserSummary[];
};

export type ImportedLinearLink = {
  externalId: string;
  rudderIssueId: string;
  rudderIssueIdentifier: string | null;
  orgId: string | null;
};

export type LinearLinkState = {
  externalId: string;
  linearIdentifier: string;
  linearTitle: string;
  linearUrl: string;
  orgId: string;
  rudderIssueId: string;
  rudderIssueIdentifier: string | null;
  teamId: string;
  teamName: string;
  projectId: string | null;
  projectName: string | null;
  stateId: string;
  stateName: string;
  importedAt: string;
  updatedAt: string;
};

export type SettingsBootstrapData = {
  config: LinearPluginConfig;
  organizations: Array<Pick<Organization, "id" | "name" | "issuePrefix">>;
  fixtureMode: boolean;
};

export type PageBootstrapData = {
  configured: boolean;
  message: string | null;
  projects: Array<Pick<Project, "id" | "name">>;
  teamMappings: LinearTeamMapping[];
};

export type LinearCatalogData = LinearCatalog & {
  orgId: string;
};

export type SettingsCatalogData = LinearCatalog & {
  orgId: string | null;
};

export type LinearIssueRow = LinearIssueSummary & {
  imported: boolean;
  importedRudderIssueId: string | null;
  importedRudderIssueIdentifier: string | null;
  importedOrgId: string | null;
};

export type LinearIssuesData = {
  rows: LinearIssueRow[];
  endCursor: string | null;
  hasNextPage: boolean;
  totalShown: number;
};

export type IssueLinkData =
  | {
    linked: false;
    issueTitle: string;
    searchQuery: string;
  }
  | {
    linked: true;
    issueTitle: string;
    link: LinearLinkState;
    latestIssue: LinearIssueSummary | null;
    staleReason: string | null;
  };

export type ImportMode = "single" | "selected" | "allMatching";

export type ImportLinearIssuesActionInput = {
  orgId: string;
  targetProjectId: string;
  mode: ImportMode;
  issueIds?: string[];
  filters?: Omit<LinearIssueListFilters, "allowedTeamIds">;
};

export type ImportLinearIssuesActionResult = {
  importedCount: number;
  duplicateCount: number;
  fallbackCount: number;
  adjustedCount: number;
  importedIssues: Array<{
    linearId: string;
    rudderIssueId: string;
    rudderIssueIdentifier: string | null;
    fallbackStatus: boolean;
    adjustedStatus: boolean;
    finalStatus: Issue["status"];
  }>;
  duplicateIssueIds: string[];
};
