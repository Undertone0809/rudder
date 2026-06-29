import type {
  CustomIntegrationBindingStatus,
  CustomIntegrationKind,
  CustomIntegrationScope,
  CustomIntegrationStatus,
  CustomIntegrationToolCallStatus,
  CustomIntegrationToolStatus,
} from "../constants.js";

export interface CustomIntegration {
  id: string;
  orgId: string;
  ownerAgentId: string | null;
  scope: CustomIntegrationScope;
  kind: CustomIntegrationKind;
  slug: string;
  displayName: string;
  description: string | null;
  status: CustomIntegrationStatus;
  config: Record<string, unknown>;
  credentialSecretId: string | null;
  createdAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
}

export interface CustomIntegrationTool {
  id: string;
  orgId: string;
  integrationId: string;
  externalToolName: string;
  rudderToolName: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
  config: Record<string, unknown>;
  status: CustomIntegrationToolStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentCustomIntegrationBinding {
  id: string;
  orgId: string;
  agentId: string;
  integrationId: string;
  status: CustomIntegrationBindingStatus;
  enabledToolIds: string[];
  createdAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
}

export interface CustomIntegrationToolCall {
  id: string;
  orgId: string;
  integrationId: string;
  toolId: string;
  agentId: string;
  runId: string | null;
  conversationId: string | null;
  issueId: string | null;
  status: CustomIntegrationToolCallStatus;
  sanitizedInput: Record<string, unknown>;
  sanitizedResult: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
}

export type CustomIntegrationToolSummary = CustomIntegrationTool & {
  enabled: boolean;
};

export type CustomIntegrationSummary = Omit<CustomIntegration, "credentialSecretId"> & {
  hasCredentialSecret: boolean;
  binding: AgentCustomIntegrationBinding | null;
  tools: CustomIntegrationToolSummary[];
};
