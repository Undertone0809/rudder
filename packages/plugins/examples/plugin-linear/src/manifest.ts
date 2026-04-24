import type { PaperclipPluginManifestV1 } from "@rudder/plugin-sdk";

const PLUGIN_ID = "rudder.linear";
const PLUGIN_VERSION = "0.1.0";
const PAGE_ROUTE = "linear";
const SLOT_IDS = {
  page: "linear-page",
  settingsPage: "linear-settings-page",
  issueTab: "linear-issue-tab",
} as const;
const EXPORT_NAMES = {
  page: "LinearPluginPage",
  settingsPage: "LinearPluginSettingsPage",
  issueTab: "LinearIssueTab",
} as const;

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Linear",
  description: "Import-first Linear connector for Rudder issues.",
  author: "Rudder",
  categories: ["connector", "ui"],
  capabilities: [
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "issues.read",
    "issues.create",
    "projects.read",
    "organizations.read",
    "ui.page.register",
    "ui.detailTab.register",
    "instance.settings.register",
    "activity.log.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    required: ["apiTokenSecretRef", "organizationMappings"],
    properties: {
      apiTokenSecretRef: {
        type: "string",
        title: "Linear API Token Secret Ref",
        format: "secret-ref",
        minLength: 1,
      },
      organizationMappings: {
        type: "array",
        title: "Organization Mappings",
        items: {
          type: "object",
          required: ["orgId", "teamMappings"],
          properties: {
            orgId: {
              type: "string",
              title: "Organization ID",
              minLength: 1,
            },
            teamMappings: {
              type: "array",
              title: "Allowed Linear Teams",
              minItems: 1,
              items: {
                type: "object",
                required: ["teamId"],
                properties: {
                  teamId: {
                    type: "string",
                    title: "Linear Team ID",
                    minLength: 1,
                  },
                  teamName: {
                    type: "string",
                    title: "Linear Team Name",
                  },
                  stateMappings: {
                    type: "array",
                    title: "State Mappings",
                    items: {
                      type: "object",
                      required: ["linearStateId", "rudderStatus"],
                      properties: {
                        linearStateId: {
                          type: "string",
                          title: "Linear State ID",
                          minLength: 1,
                        },
                        linearStateName: {
                          type: "string",
                          title: "Linear State Name",
                        },
                        rudderStatus: {
                          type: "string",
                          title: "Rudder Status",
                          enum: ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  ui: {
    slots: [
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "Linear",
        exportName: EXPORT_NAMES.page,
        routePath: PAGE_ROUTE,
      },
      {
        type: "settingsPage",
        id: SLOT_IDS.settingsPage,
        displayName: "Linear Settings",
        exportName: EXPORT_NAMES.settingsPage,
      },
      {
        type: "detailTab",
        id: SLOT_IDS.issueTab,
        displayName: "Linear",
        exportName: EXPORT_NAMES.issueTab,
        entityTypes: ["issue"],
      },
    ],
  },
};

export default manifest;
