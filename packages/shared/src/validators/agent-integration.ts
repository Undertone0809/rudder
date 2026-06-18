import { z } from "zod";
import {
  AGENT_INTEGRATION_CHAT_TYPES,
  AGENT_INTEGRATION_DROP_REASONS,
  AGENT_INTEGRATION_OUTBOUND_STATUSES,
  AGENT_INTEGRATION_PROVIDER_REGIONS,
  AGENT_INTEGRATION_PROVIDERS,
  AGENT_INTEGRATION_STATUSES,
  AGENT_INTEGRATION_TRANSPORTS,
} from "../constants.js";

export const agentIntegrationProviderSchema = z.enum(AGENT_INTEGRATION_PROVIDERS);
export const agentIntegrationStatusSchema = z.enum(AGENT_INTEGRATION_STATUSES);
export const agentIntegrationTransportSchema = z.enum(AGENT_INTEGRATION_TRANSPORTS);
export const agentIntegrationProviderRegionSchema = z.enum(AGENT_INTEGRATION_PROVIDER_REGIONS);
export const agentIntegrationChatTypeSchema = z.enum(AGENT_INTEGRATION_CHAT_TYPES);
export const agentIntegrationDropReasonSchema = z.enum(AGENT_INTEGRATION_DROP_REASONS);
export const agentIntegrationOutboundStatusSchema = z.enum(AGENT_INTEGRATION_OUTBOUND_STATUSES);

export const createAgentIntegrationSchema = z.object({
  agentId: z.string().uuid(),
  provider: agentIntegrationProviderSchema.default("feishu"),
  transport: agentIntegrationTransportSchema.default("long_connection"),
  providerRegion: agentIntegrationProviderRegionSchema.default("feishu_cn"),
  appCredentialSecretId: z.string().uuid(),
  externalAppId: z.string().min(1),
  externalBotOpenId: z.string().min(1).optional().nullable(),
  externalTenantKey: z.string().min(1).optional().nullable(),
  installerUserId: z.string().min(1).optional().nullable(),
  manageUrl: z.string().url().optional().nullable(),
});

export type CreateAgentIntegration = z.infer<typeof createAgentIntegrationSchema>;
