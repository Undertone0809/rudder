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

export const connectAgentIntegrationSchema = createAgentIntegrationSchema.omit({ agentId: true });

export type ConnectAgentIntegration = z.infer<typeof connectAgentIntegrationSchema>;

const feishuEventHeaderSchema = z.object({
  event_id: z.string().min(1).optional(),
  app_id: z.string().min(1).optional(),
  create_time: z.string().min(1).optional(),
}).passthrough();

const feishuSenderIdSchema = z.object({
  open_id: z.string().min(1).optional(),
  union_id: z.string().min(1).optional(),
}).passthrough();

const feishuMessageMentionSchema = z.object({
  key: z.string().optional(),
  id: feishuSenderIdSchema.optional(),
}).passthrough();

const feishuMessageSchema = z.object({
  message_id: z.string().min(1).optional(),
  chat_id: z.string().min(1).optional(),
  chat_type: agentIntegrationChatTypeSchema.optional(),
  message_type: z.string().min(1).optional(),
  content: z.string().optional(),
  mentions: z.array(feishuMessageMentionSchema).optional(),
  parent_id: z.string().min(1).optional().nullable(),
}).passthrough();

const feishuEventSchema = z.object({
  sender: z.object({
    sender_id: feishuSenderIdSchema.optional(),
  }).passthrough().optional(),
  message: feishuMessageSchema.optional(),
}).passthrough();

export const mockFeishuInboundEventSchema = z.object({
  eventId: z.string().min(1).optional(),
  appId: z.string().min(1).optional(),
  botOpenId: z.string().min(1).optional().nullable(),
  chatId: z.string().min(1).optional(),
  chatType: agentIntegrationChatTypeSchema.optional(),
  messageId: z.string().min(1).optional(),
  senderOpenId: z.string().min(1).optional(),
  senderUnionId: z.string().min(1).optional().nullable(),
  body: z.string().optional(),
  commandBody: z.string().optional(),
  addressedToBot: z.boolean().optional(),
  messageType: z.string().min(1).optional(),
  parentMessageId: z.string().min(1).optional().nullable(),
  receivedAt: z.string().datetime().optional(),
  header: feishuEventHeaderSchema.optional(),
  event: feishuEventSchema.optional(),
}).passthrough();

export type MockFeishuInboundEvent = z.infer<typeof mockFeishuInboundEventSchema>;
