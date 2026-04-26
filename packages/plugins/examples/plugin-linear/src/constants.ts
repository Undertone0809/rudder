import type { Issue } from "@rudderhq/shared";

export const PLUGIN_ID = "rudder.linear";
export const PLUGIN_VERSION = "0.1.0";
export const PAGE_ROUTE = "linear";
export const ENTITY_TYPE_LINEAR_ISSUE_LINK = "linear_issue_link";
export const ISSUE_LINK_STATE_KEY = "linear-link";
export const DEFAULT_LINEAR_API_URL = "https://api.linear.app/graphql";
export const LINEAR_TOKEN_SETTINGS_URL = "https://linear.app/settings/account/security";
export const LINEAR_PAGE_SIZE = 25;
export const LINEAR_IMPORT_ALL_LIMIT = 100;

export const SLOT_IDS = {
  page: "linear-page",
  settingsPage: "linear-settings-page",
  issueTab: "linear-issue-tab",
} as const;

export const EXPORT_NAMES = {
  page: "LinearPluginPage",
  settingsPage: "LinearPluginSettingsPage",
  issueTab: "LinearIssueTab",
} as const;

export const DATA_KEYS = {
  settingsBootstrap: "settings-bootstrap",
  pageBootstrap: "page-bootstrap",
  settingsCatalog: "settings-catalog",
  catalog: "linear-catalog",
  issues: "linear-issues",
  issueLink: "issue-link",
} as const;

export const ACTION_KEYS = {
  importIssues: "import-linear-issues",
} as const;

export const RUDDER_STATUS_OPTIONS: Issue["status"][] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
];
