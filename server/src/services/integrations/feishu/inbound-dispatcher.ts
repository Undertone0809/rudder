import type {
  AgentIntegrationChatType,
  AgentIntegrationDropReason,
  AgentIntegrationProvider,
} from "@rudderhq/shared";

export interface FeishuInboundMessage {
  provider: "feishu";
  eventId: string;
  appId: string;
  botOpenId: string | null;
  chatId: string;
  chatType: AgentIntegrationChatType;
  messageId: string;
  senderOpenId: string;
  senderUnionId: string | null;
  body: string;
  commandBody: string;
  addressedToBot: boolean;
  messageType: string;
  parentMessageId?: string | null;
  receivedAt?: Date;
}

export interface ResolvedAgentIntegration {
  id: string;
  orgId: string;
  agentId: string;
  provider: AgentIntegrationProvider;
  status: "active" | "revoked" | "error";
}

export interface ResolvedIntegrationUserBinding {
  userId: string;
  orgMember: boolean;
}

export interface ResolvedIntegrationChatBinding {
  conversationId: string;
}

export interface AppendedIntegrationMessage {
  chatMessageId: string;
}

export interface CreatedIntegrationIssue {
  issueId: string;
}

export interface StartedIntegrationRun {
  runId: string;
}

export interface MintedIntegrationBindingToken {
  token: string;
  expiresAt: Date;
}

export interface FeishuOutboundResponse {
  provider: "feishu";
  externalChatId: string;
  externalMessageId: string | null;
  text: string;
}

export interface AgentIntegrationInboundAuditInput {
  orgId: string | null;
  integrationId: string | null;
  provider: AgentIntegrationProvider;
  externalChatId: string | null;
  externalChatType: AgentIntegrationChatType | null;
  externalEventId: string | null;
  externalMessageId: string | null;
  senderOpenId: string | null;
  dropReason: AgentIntegrationDropReason;
  bodyPersisted: false;
  metadata?: Record<string, unknown> | null;
}

export interface AgentIntegrationInboundDispatcherDeps {
  resolveActiveIntegration: (event: FeishuInboundMessage) => Promise<ResolvedAgentIntegration | null>;
  auditDrop: (input: AgentIntegrationInboundAuditInput) => Promise<void>;
  resolveUserBinding: (
    integration: ResolvedAgentIntegration,
    event: FeishuInboundMessage,
  ) => Promise<ResolvedIntegrationUserBinding | null>;
  mintBindingToken: (
    integration: ResolvedAgentIntegration,
    event: FeishuInboundMessage,
  ) => Promise<MintedIntegrationBindingToken>;
  tryInsertDedup: (integration: ResolvedAgentIntegration, event: FeishuInboundMessage) => Promise<boolean>;
  ensureChatBinding: (
    integration: ResolvedAgentIntegration,
    binding: ResolvedIntegrationUserBinding,
    event: FeishuInboundMessage,
  ) => Promise<ResolvedIntegrationChatBinding>;
  appendInboundMessage: (
    integration: ResolvedAgentIntegration,
    binding: ResolvedIntegrationUserBinding,
    chat: ResolvedIntegrationChatBinding,
    event: FeishuInboundMessage,
  ) => Promise<AppendedIntegrationMessage>;
  createIssueFromCommand?: (
    integration: ResolvedAgentIntegration,
    binding: ResolvedIntegrationUserBinding,
    chat: ResolvedIntegrationChatBinding,
    message: AppendedIntegrationMessage,
    command: ParsedIntegrationIssueCommand,
    event: FeishuInboundMessage,
  ) => Promise<CreatedIntegrationIssue>;
  enqueueAgentRun?: (
    integration: ResolvedAgentIntegration,
    binding: ResolvedIntegrationUserBinding,
    chat: ResolvedIntegrationChatBinding,
    message: AppendedIntegrationMessage,
    event: FeishuInboundMessage,
    issue: CreatedIntegrationIssue | null,
  ) => Promise<StartedIntegrationRun | null>;
  createOutboundPlaceholder?: (
    integration: ResolvedAgentIntegration,
    chat: ResolvedIntegrationChatBinding,
    event: FeishuInboundMessage,
    message: AppendedIntegrationMessage,
    issue: CreatedIntegrationIssue | null,
    run: StartedIntegrationRun | null,
  ) => Promise<void>;
}

export type AgentIntegrationInboundDispatchResult =
  | { status: "dropped"; reason: AgentIntegrationDropReason }
  | {
    status: "binding_required";
    bindingToken: MintedIntegrationBindingToken;
    outbound: FeishuOutboundResponse;
  }
  | {
    status: "accepted";
    conversationId: string;
    chatMessageId: string;
    issueId: string | null;
    runId: string | null;
    outbound: FeishuOutboundResponse;
  };

export interface ParsedIntegrationIssueCommand {
  title: string;
  body: string | null;
}

export function parseIntegrationIssueCommand(commandBody: string): ParsedIntegrationIssueCommand | null {
  const normalized = commandBody.trim();
  if (!normalized.toLowerCase().startsWith("/issue")) return null;
  const rawPayload = normalized.slice("/issue".length).trim();
  if (!rawPayload) return null;
  const [titleLine, ...bodyLines] = rawPayload.split(/\r?\n/);
  const title = titleLine?.trim();
  if (!title) return null;
  const body = bodyLines.join("\n").trim();
  return { title, body: body || null };
}

export async function dispatchFeishuInboundMessage(
  event: FeishuInboundMessage,
  deps: AgentIntegrationInboundDispatcherDeps,
): Promise<AgentIntegrationInboundDispatchResult> {
  const integration = await deps.resolveActiveIntegration(event);
  if (!integration || integration.status !== "active") {
    await auditDrop(deps, event, null, "revoked_installation");
    return { status: "dropped", reason: "revoked_installation" };
  }

  if (event.chatType === "group" && !event.addressedToBot) {
    await auditDrop(deps, event, integration, "not_addressed_in_group");
    return { status: "dropped", reason: "not_addressed_in_group" };
  }

  if (event.messageType !== "text") {
    await auditDrop(deps, event, integration, "unsupported_message_type");
    return { status: "dropped", reason: "unsupported_message_type" };
  }

  const binding = await deps.resolveUserBinding(integration, event);
  if (!binding) {
    const bindingToken = await deps.mintBindingToken(integration, event);
    await auditDrop(deps, event, integration, "unbound_user");
    return {
      status: "binding_required",
      bindingToken,
      outbound: createBindingRequiredResponse(event, bindingToken),
    };
  }

  if (!binding.orgMember) {
    await auditDrop(deps, event, integration, "non_org_member");
    return { status: "dropped", reason: "non_org_member" };
  }

  const dedupInserted = await deps.tryInsertDedup(integration, event);
  if (!dedupInserted) {
    await auditDrop(deps, event, integration, "duplicate");
    return { status: "dropped", reason: "duplicate" };
  }

  const chat = await deps.ensureChatBinding(integration, binding, event);
  const message = await deps.appendInboundMessage(integration, binding, chat, event);
  const command = parseIntegrationIssueCommand(event.commandBody);
  const issue = command && deps.createIssueFromCommand
    ? await deps.createIssueFromCommand(integration, binding, chat, message, command, event)
    : null;
  const run = deps.enqueueAgentRun
    ? await deps.enqueueAgentRun(integration, binding, chat, message, event, issue)
    : null;

  if (deps.createOutboundPlaceholder) {
    await deps.createOutboundPlaceholder(integration, chat, event, message, issue, run);
  }

  return {
    status: "accepted",
    conversationId: chat.conversationId,
    chatMessageId: message.chatMessageId,
    issueId: issue?.issueId ?? null,
    runId: run?.runId ?? null,
    outbound: createAcceptedResponse(event, issue, run),
  };
}

function createBindingRequiredResponse(
  event: FeishuInboundMessage,
  bindingToken: MintedIntegrationBindingToken,
): FeishuOutboundResponse {
  return {
    provider: event.provider,
    externalChatId: event.chatId,
    externalMessageId: null,
    text: [
      "请先绑定 Rudder 账号后再和这个 Agent 对话。",
      `绑定口令：${bindingToken.token}`,
      "口令 15 分钟内有效。绑定完成后请重新发送消息。",
    ].join("\n"),
  };
}

function createAcceptedResponse(
  event: FeishuInboundMessage,
  issue: CreatedIntegrationIssue | null,
  run: StartedIntegrationRun | null,
): FeishuOutboundResponse {
  const details = [
    issue ? `issue=${issue.issueId}` : null,
    run ? `run=${run.runId}` : null,
  ].filter(Boolean);
  return {
    provider: event.provider,
    externalChatId: event.chatId,
    externalMessageId: null,
    text: details.length > 0
      ? `已写入 Rudder Messenger，并开始处理（${details.join(", ")}）。`
      : "已写入 Rudder Messenger，并开始处理。",
  };
}

async function auditDrop(
  deps: Pick<AgentIntegrationInboundDispatcherDeps, "auditDrop">,
  event: FeishuInboundMessage,
  integration: ResolvedAgentIntegration | null,
  dropReason: AgentIntegrationDropReason,
) {
  await deps.auditDrop({
    orgId: integration?.orgId ?? null,
    integrationId: integration?.id ?? null,
    provider: event.provider,
    externalChatId: event.chatId || null,
    externalChatType: event.chatType || null,
    externalEventId: event.eventId || null,
    externalMessageId: event.messageId || null,
    senderOpenId: event.senderOpenId || null,
    dropReason,
    bodyPersisted: false,
    metadata: null,
  });
}
