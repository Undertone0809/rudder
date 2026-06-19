import type {
  AgentIntegrationChatType,
  AgentIntegrationDropReason,
  AgentIntegrationOutboundStatus,
  AgentIntegrationProvider,
  AgentIntegrationProviderRegion,
  AgentIntegrationStatus,
  AgentIntegrationTransport,
} from "../constants.js";

export interface AgentIntegration {
  id: string;
  orgId: string;
  agentId: string;
  provider: AgentIntegrationProvider;
  status: AgentIntegrationStatus;
  transport: AgentIntegrationTransport;
  providerRegion: AgentIntegrationProviderRegion;
  appCredentialSecretId: string;
  externalAppId: string;
  externalBotOpenId: string | null;
  externalTenantKey: string | null;
  installerUserId: string | null;
  manageUrl: string | null;
  installedAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type AgentIntegrationSummary = Omit<AgentIntegration, "appCredentialSecretId"> & {
  hasCredentialSecret: boolean;
};

export interface AgentIntegrationSetupUrl {
  provider: AgentIntegrationProvider;
  providerRegion: AgentIntegrationProviderRegion;
  setupUrl: string;
  expiresAt: Date | null;
}

export interface AgentIntegrationUserBinding {
  id: string;
  orgId: string;
  integrationId: string;
  userId: string;
  externalOpenId: string;
  externalUnionId: string | null;
  boundAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentIntegrationChatBinding {
  id: string;
  orgId: string;
  integrationId: string;
  conversationId: string;
  externalChatId: string;
  externalChatType: AgentIntegrationChatType;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentIntegrationInboundAudit {
  id: string;
  orgId: string | null;
  integrationId: string | null;
  provider: AgentIntegrationProvider;
  externalChatId: string | null;
  externalChatType: AgentIntegrationChatType | null;
  externalEventId: string | null;
  externalMessageId: string | null;
  senderOpenId: string | null;
  dropReason: AgentIntegrationDropReason;
  bodyPersisted: boolean;
  metadata: Record<string, unknown> | null;
  receivedAt: Date;
}

export interface AgentIntegrationOutboundMessage {
  id: string;
  orgId: string;
  integrationId: string;
  conversationId: string | null;
  chatMessageId: string | null;
  issueId: string | null;
  runId: string | null;
  externalChatId: string;
  externalMessageId: string | null;
  status: AgentIntegrationOutboundStatus;
  lastPatchedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentIntegrationBindingToken {
  id: string;
  orgId: string;
  integrationId: string;
  externalOpenId: string;
  externalUnionId: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}
