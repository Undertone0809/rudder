import type { AgentRuntimeMediaAttachment, TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { RudderSkillEntry } from "@rudderhq/agent-runtime-utils/server-utils";
import type {
  AgentRuntimeType,
  ChatContextLink,
  ChatConversation,
  ChatMessage,
  ChatRuntimeDescriptor,
  IssueLabel,
  OperatorProfileSettings,
} from "@rudderhq/shared";
import {
  chatAskUserRequestFromStructuredPayload,
  chatAutomationCreateFromStructuredPayload,
  chatIssueProposalFromStructuredPayload,
  sanitizeChatStructuredPayload,
} from "@rudderhq/shared";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { AgentRuntimeInvocationMeta, AgentRuntimeLoadedSkillMeta } from "../agent-runtimes/index.js";
import type { AgentRuntimeExecutionContext, AgentRuntimeExecutionResult } from "../agent-runtimes/types.js";
import type { StorageService } from "../storage/types.js";
import { type AgentRunContextAgent } from "./agent-run-context.js";

export const CHAT_UNSUPPORTED_ADAPTER_TYPES = new Set<AgentRuntimeType>(["process", "http"]);
export const CHAT_RESULT_SENTINEL_PREFIX = "__RUDDER_RESULT_";
export const CHAT_ASSISTANT_USER_ERROR_MESSAGE =
  "The assistant hit a system-level issue. Rudder saved the details for diagnostics; retry when ready.";

export interface ChatAttachmentPromptReference {
  localPath?: string;
  localPathError?: string;
}

const CHAT_LOCAL_IMAGE_RUNTIME_TYPES = new Set<AgentRuntimeType>(["codex_local", "claude_local"]);

export interface ResolvedChatRuntimeSource {
  descriptor: ChatRuntimeDescriptor;
  runtimeAgent: AgentRunContextAgent | null;
  agentRuntimeType: AgentRuntimeType | null;
  agentRuntimeConfig: Record<string, unknown> | null;
  runtimeSkills: AgentRuntimeLoadedSkillMeta[];
}

export interface ChatAssistantResult {
  kind: "message" | "ask_user" | "issue_proposal" | "operation_proposal" | "automation_create";
  body: string;
  structuredPayload: Record<string, unknown> | null;
  replyingAgentId?: string | null;
  generatedAttachments?: ChatGeneratedAttachment[];
}

export interface ChatGeneratedAttachment {
  source: "codex_image_generation";
  originalFilename: string;
  contentType: string;
  body: Buffer;
  toolCallId?: string | null;
}

export interface GenerateChatAssistantReplyInput {
  conversation: ChatConversation;
  messages: ChatMessage[];
  contextLinks: ChatContextLink[];
  issueLabels?: IssueLabel[] | null;
  operatorProfile?: OperatorProfileSettings | null;
}

export interface StreamChatAssistantReplyInput extends GenerateChatAssistantReplyInput {
  abortSignal?: AbortSignal;
  onAssistantDelta?: (delta: string) => Promise<void> | void;
  onAssistantState?: (state: "streaming" | "finalizing" | "stopped") => Promise<void> | void;
  onInvocationMeta?: (meta: AgentRuntimeInvocationMeta) => Promise<void> | void;
  onTranscriptEntry?: (entry: TranscriptEntry) => Promise<void> | void;
  onObservedTranscriptEntry?: (entry: TranscriptEntry) => Promise<void> | void;
}

export type StreamChatAssistantReplyResult =
  | {
    outcome: "completed";
    reply: ChatAssistantResult;
    partialBody: string;
    replyingAgentId: string | null;
  }
  | {
    outcome: "stopped";
    partialBody: string;
    replyingAgentId: string | null;
  };

export class ChatAssistantStreamError extends Error {
  partialBody: string;
  generatedAttachments: ChatGeneratedAttachment[];

  constructor(message: string, partialBody: string, generatedAttachments: ChatGeneratedAttachment[] = []) {
    super(message);
    this.name = "ChatAssistantStreamError";
    this.partialBody = partialBody;
    this.generatedAttachments = generatedAttachments;
  }
}

export function safeTrim(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function summarizeBody(value: string, maxChars = 160) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "(empty)";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}…`;
}

export function modelLabel(config: Record<string, unknown> | null | undefined) {
  return safeTrim(typeof config?.model === "string" ? config.model : null);
}

export function unconfiguredDescriptor(error: string): ChatRuntimeDescriptor {
  return {
    sourceType: "unconfigured",
    sourceLabel: "Choose an agent",
    runtimeAgentId: null,
    agentRuntimeType: null,
    model: null,
    available: false,
    error,
  };
}

export function unavailableAgentDescriptor(input: {
  sourceLabel: string;
  runtimeAgentId: string | null;
  agentRuntimeType: AgentRuntimeType | null;
  model: string | null;
  error: string;
}): ChatRuntimeDescriptor {
  return {
    sourceType: "agent",
    sourceLabel: input.sourceLabel,
    runtimeAgentId: input.runtimeAgentId,
    agentRuntimeType: input.agentRuntimeType,
    model: input.model,
    available: false,
    error: input.error,
  };
}

export function buildPrompt(
  input: GenerateChatAssistantReplyInput,
  attachmentReferences: Map<string, ChatAttachmentPromptReference> = new Map(),
) {
  const contextSummary = input.contextLinks.map((link) => ({
    entityType: link.entityType,
    entityId: link.entityId,
    label: link.entity?.label ?? null,
    identifier: link.entity?.identifier ?? null,
    status: link.entity?.status ?? null,
    description: link.entity?.description ?? null,
    priority: link.entity?.priority ?? null,
  }));

  const history = input.messages.slice(-12).map((message) => ({
    role: message.role,
    kind: message.kind,
    status: message.status,
    body: message.body,
    attachments: message.attachments.map((attachment) => {
      const reference = attachmentReferences.get(attachment.id);
      return {
        id: attachment.id,
        assetId: attachment.assetId,
        name: attachment.originalFilename ?? attachment.assetId,
        contentType: attachment.contentType,
        byteSize: attachment.byteSize,
        contentPath: attachment.contentPath,
        ...(reference?.localPath ? { localPath: reference.localPath } : {}),
        ...(reference?.localPathError ? { localPathError: reference.localPathError } : {}),
      };
    }),
    structuredPayload: message.structuredPayload,
  }));

  return JSON.stringify(
    {
      conversation: {
        id: input.conversation.id,
        title: input.conversation.title,
        status: input.conversation.status,
        summary: input.conversation.summary,
        planMode: input.conversation.planMode,
        issueCreationMode: input.conversation.issueCreationMode,
        preferredAgentId: input.conversation.preferredAgentId,
        routedAgentId: input.conversation.routedAgentId,
        primaryIssueId: input.conversation.primaryIssueId,
      },
      contextLinks: contextSummary,
      recentMessages: history,
    },
    null,
    2,
  );
}

export function buildCurrentUserAttachmentPromptSection(
  messages: ChatMessage[],
  attachmentReferences: Map<string, ChatAttachmentPromptReference> = new Map(),
) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user" || message.attachments.length === 0) continue;

    const lines = [
      "Current user message attachments:",
      `- The latest user message includes ${message.attachments.length} attachment(s). Inspect any listed localPath directly before answering.`,
      `- User message body: ${JSON.stringify(summarizeBody(message.body))}`,
      ...message.attachments.map((attachment, attachmentIndex) => {
        const name = attachment.originalFilename ?? attachment.assetId;
        const reference = attachmentReferences.get(attachment.id);
        const parts = [
          `name=${name}`,
          `contentType=${attachment.contentType}`,
          `byteSize=${attachment.byteSize}`,
          `contentPath=${attachment.contentPath}`,
        ];
        if (reference?.localPath) {
          parts.push(`localPath=${reference.localPath}`);
          parts.push("runtimeReference=local_image_file");
        } else if (reference?.localPathError) {
          parts.push(`localPathError=${reference.localPathError}`);
        }
        return `- [${attachmentIndex + 1}] ${parts.join("; ")}`;
      }),
    ];
    return lines.join("\n");
  }

  return null;
}

export function buildOperatorProfilePromptSection(profile: OperatorProfileSettings | null | undefined) {
  const nickname = safeTrim(profile?.nickname);
  const moreAboutYou = safeTrim(profile?.moreAboutYou);
  if (!nickname && !moreAboutYou) return null;

  return [
    "Current board operator profile:",
    ...(nickname ? [`- Preferred form of address: ${nickname}`] : []),
    ...(moreAboutYou ? [`- Background about the operator: ${moreAboutYou}`] : []),
    "Use this only as background context when you address the operator or interpret their requests.",
  ].join("\n");
}

export function buildSelectedProjectPromptSection(contextLinks: ChatContextLink[]) {
  const projectLink = contextLinks.find((link) => link.entityType === "project");
  if (!projectLink) return null;

  const lines = [
    "Selected project context:",
    `- Project ID: ${projectLink.entityId}`,
  ];
  if (projectLink.entity?.label) {
    lines.push(`- Name: ${projectLink.entity.label}`);
  }
  if (projectLink.entity?.status) {
    lines.push(`- Status: ${projectLink.entity.status}`);
  }
  if (projectLink.entity?.subtitle) {
    lines.push(`- Description: ${projectLink.entity.subtitle}`);
  }
  lines.push(
    "Use this as the default project for issue proposals and project-scoped reasoning unless the user explicitly chooses another project.",
  );
  return lines.join("\n");
}

export function buildSelectedIssuePromptSection(
  conversation: Pick<ChatConversation, "primaryIssue">,
  contextLinks: ChatContextLink[],
) {
  const issueLink = contextLinks.find((link) => link.entityType === "issue");
  const primaryIssue = conversation.primaryIssue;
  if (!issueLink && !primaryIssue) return null;

  const lines = ["Selected issue context:"];
  if (issueLink) {
    lines.push(`- Issue ID: ${issueLink.entityId}`);
    if (issueLink.entity?.identifier) {
      lines.push(`- Identifier: ${issueLink.entity.identifier}`);
    }
    if (issueLink.entity?.label) {
      lines.push(`- Title: ${issueLink.entity.label}`);
    }
    if (issueLink.entity?.status) {
      lines.push(`- Status: ${issueLink.entity.status}`);
    }
    if (issueLink.entity?.priority) {
      lines.push(`- Priority: ${issueLink.entity.priority}`);
    }
    if (issueLink.entity?.description?.trim()) {
      lines.push(`- Description: ${issueLink.entity.description.trim()}`);
    }
  } else if (primaryIssue) {
    lines.push(`- Issue ID: ${primaryIssue.id}`);
    if (primaryIssue.identifier) {
      lines.push(`- Identifier: ${primaryIssue.identifier}`);
    }
    lines.push(`- Title: ${primaryIssue.title}`);
    lines.push(`- Status: ${primaryIssue.status}`);
    lines.push(`- Priority: ${primaryIssue.priority}`);
  }
  lines.push(
    "Use this as the default issue context for this chat unless the user explicitly switches topics.",
  );
  return lines.join("\n");
}

export function buildIssueLabelsPromptSection(labels: IssueLabel[] | null | undefined) {
  if (!labels || labels.length === 0) return null;
  const lines = [
    "Organization issue labels:",
    ...labels.map((label) => `- ${label.name} (${label.id})`),
  ];
  if (labels.length >= 5) {
    lines.push(
      "This organization has a mature label taxonomy. When emitting an issueProposal for agent-created work, include labelIds with at least one best-fit label id from this list.",
    );
  }
  return lines.join("\n");
}

export function buildChatSpeakerPromptSection(runtimeSource: ResolvedChatRuntimeSource) {
  const name = runtimeSource.descriptor.sourceLabel;
  if (runtimeSource.descriptor.sourceType === "agent") {
    const agentId = runtimeSource.descriptor.runtimeAgentId;
    return [
      `You are ${name}, replying inside Rudder's chat scene.`,
      "Speak as this agent, using the agent's own instructions and enabled skills as your working context.",
      "Do not claim to be a generic assistant or any agent other than the selected chat agent.",
      agentId
        ? `When emitting issue_proposal, use assigneeAgentId "${agentId}" only if this agent should actually own execution; otherwise choose the correct owner or set assigneeUnassignedReason.`
        : "When emitting issue_proposal, include an explicit assignee decision; leave it unassigned only with assigneeUnassignedReason.",
    ].join("\n");
  }

  return "A preferred agent must be selected before the chat assistant can reply.";
}

export function buildChatResponseQualityPromptSection() {
  return [
    "Before answering, classify the user's request depth:",
    "- Quick factual or status request: answer directly and keep it concise.",
    "- Ambiguous work request: ask one to three blocking clarification questions before proposing work.",
    "- Product, design, architecture, strategy, or workflow judgment: reason from scenarios, actors, needs, non-needs, constraints, failure modes, and corner cases before giving a decision-ready answer.",
    "- Implementation request with local evidence available: inspect the relevant files, docs, or artifacts before giving a confident recommendation.",
    "For non-trivial judgment questions, do not jump from the user's proposed solution to an answer. Reframe the durable job-to-be-done, map the likely scenarios, identify what must be true for the answer to be correct, compare two to three realistic options when useful, and recommend one next move.",
    "Do not claim certainty you do not have. State assumptions, confidence, and remaining unknowns when they matter. Keep the final answer concise and user-visible; do not expose hidden chain-of-thought or unnecessary process.",
  ].join("\n");
}

export function buildAutomationRunInputPromptSection(messages: ChatMessage[]) {
  const automationInputs = messages
    .slice(-12)
    .filter((message) => message.structuredPayload?.eventType === "automation_run_input");
  if (automationInputs.length === 0) return null;

  const latest = automationInputs.at(-1)!;
  const payload = latest.structuredPayload ?? {};
  const run = asRecord(payload.automationChatRun);
  const guidance = asRecord(payload.guidance);
  const lines = [
    "Automation execution context:",
    "- This conversation contains an existing Rudder Automation run input.",
    "- Treat messages with structuredPayload.eventType = \"automation_run_input\" as system-scheduled execution instructions for an already-created automation, even though they are stored with role \"user\" for chat transcript continuity.",
    "- Do not interpret an automation-run input as an operator-authored request to create, configure, or revise an automation.",
    "- Do not emit result kind \"automation_create\" because of an automation-run input.",
    "- Do not ask for schedule, trigger source, recurrence, or push time when the missing detail is only about creating or configuring the automation; that automation already exists.",
    "- Ask the operator only for information required to complete the current run's actual content task.",
  ];
  if (typeof run?.automationTitle === "string") {
    lines.push(`- Automation title: ${run.automationTitle}`);
  }
  if (typeof run?.automationId === "string") {
    lines.push(`- Automation ID: ${run.automationId}`);
  }
  if (typeof run?.runId === "string") {
    lines.push(`- Automation run ID: ${run.runId}`);
  }
  if (typeof run?.source === "string") {
    lines.push(`- Trigger source: ${run.source}`);
  }
  if (guidance?.mayCreateAutomation === false) {
    lines.push("- For this automation-run input, mayCreateAutomation: false.");
  }
  return lines.join("\n");
}

export function buildBaseSystemPromptSections(runtimeSource: ResolvedChatRuntimeSource, resultSentinel: string) {
  return [
    buildChatSpeakerPromptSection(runtimeSource),
    "Your job is to clarify work requests for a Rudder AI organization control plane.",
    "This is the dedicated chat scene. Do not use heartbeat issue bootstrap framing.",
    "Always reply in the same language as the user's most recent substantive message unless they explicitly ask for a different language.",
    "Always prefer clarification before proposing issue creation when requirements are incomplete.",
    "Treat message attachments as part of the user's message. If an image attachment includes localPath metadata, inspect that local file before claiming you cannot see the image.",
    "Do not expose internal attachment retrieval commands or auth-bearing asset fetch instructions to the user.",
    buildChatResponseQualityPromptSection(),
    "Use result kind 'message' for clarification, summaries, and small requests that can stay in chat.",
    "Use result kind 'ask_user' only when one to three short structured questions are blocked on the user's decision before the conversation can continue safely.",
    "For ask_user, each requestUserInput question id must be unique, and option ids must be unique within their question. Set question selectionMode to 'multiple' only when the user can choose more than one option; omit it for normal single-choice questions.",
    "Use result kind 'issue_proposal' for larger work that should become an issue.",
    "For issue_proposal, include exactly one owner decision in structuredPayload.issueProposal: either assigneeAgentId/assigneeUserId for the proposed owner, or assigneeUnassignedReason explaining why the issue should intentionally remain unassigned. Do not leave ownership implicit. Do not default to the selected chat agent unless that agent should actually own execution.",
    "Issue proposals create To Do issues by default. Omit status for the normal runnable default; set status to 'backlog' only when the issue should intentionally wait and not be picked up by agents yet.",
    "Use result kind 'automation_create' only when the latest operator-authored user request clearly asks the selected agent to set up recurring automatic work and the schedule, assignee, and output are clear. Never use automation_create for automation-run input messages.",
    "For automation_create, include structuredPayload.automationCreate with title, instructions, schedule.cronExpression, and schedule.timezone. Omit assigneeAgentId to assign the automation to the selected chat agent. Use outputMode 'track_issue' so each run creates reviewable board-tracked work.",
    "Reply in two phases.",
    "Phase 1: while you work, write concise progress updates in Markdown with no JSON fences. These are process transcript entries, not the final answer.",
    `Phase 2: on a new line, emit exactly ${resultSentinel} followed immediately by one JSON object. The JSON body is the final user-visible answer.`,
    "Do not output anything after that JSON object.",
  ];
}

export function buildPlanModePromptSection() {
  return [
    "Plan mode is active for this conversation.",
    "Stay strictly in read-only investigation and planning mode.",
    "Do not propose or imply file edits, shell mutations, or lightweight control-plane changes.",
    "Converge on an issue-sized implementation plan, and when you are ready to conclude, emit kind 'issue_proposal'.",
    "Put the implementation plan in the issue proposal description or cite a Project Library file link when durable documentation is needed.",
  ].join("\n");
}

export function buildResponseSchemaPromptSection(planMode: boolean) {
  return [
    "JSON shape:",
    JSON.stringify(
      {
        kind: "message",
        body: "final user-visible answer only, not progress updates",
        structuredPayload: {
          summary: "optional short summary",
          issueProposal: {
            title: "required for issue_proposal",
            description: "required for issue_proposal",
            status: "optional backlog|todo|in_progress|in_review|done|blocked|cancelled; omit for default todo, use backlog only when explicitly deferring work",
            priority: "critical|high|medium|low",
            assigneeAgentId: "optional uuid",
            assigneeUserId: "optional user id",
            assigneeUnassignedReason: "required explanation when no assigneeAgentId or assigneeUserId is set",
            reviewerAgentId: "optional uuid",
            reviewerUserId: "optional user id",
            labelIds: ["optional label uuid"],
            projectId: "optional uuid",
            goalId: "optional uuid",
            parentId: "optional uuid",
          },
          routingSuggestion: {
            agentId: "optional uuid",
            reason: "short explanation",
          },
          requestUserInput: {
            questions: [
              {
                id: "stable_question_id",
                header: "optional short header",
                question: "required short question",
                options: [
                  {
                    id: "stable_option_id",
                    label: "required short option label",
                    description: "optional short tradeoff",
                    recommended: false,
                  },
                ],
                selectionMode: "single",
                allowFreeform: true,
              },
            ],
          },
          automationCreate: {
            title: "required for automation_create",
            instructions: "optional instructions for what the assigned agent should do when the automation runs",
            priority: "critical|high|medium|low",
            outputMode: "track_issue",
            projectId: "optional uuid",
            goalId: "optional uuid",
            parentIssueId: "optional uuid",
            schedule: {
              cronExpression: "required cron expression, for example 0 12 * * *",
              timezone: "required IANA timezone, for example Asia/Shanghai",
            },
          },
          richReferences: [
            {
              type: "issue",
              issueId: "optional issue uuid",
              identifier: "optional issue identifier such as ZST-153",
              display: "card|inline",
            },
            {
              type: "issue_comment",
              issueId: "optional issue uuid",
              identifier: "optional issue identifier such as ZST-153",
              commentId: "required comment uuid",
              display: "card|inline",
            },
          ],
        },
      },
      null,
      2,
    ),
  ].join("\n");
}

export function systemPrompt(
  runtimeSource: ResolvedChatRuntimeSource,
  conversation: Pick<ChatConversation, "planMode">,
  resultSentinel: string,
) {
  return [
    ...buildBaseSystemPromptSections(runtimeSource, resultSentinel),
    ...(conversation.planMode ? [buildPlanModePromptSection()] : []),
    buildResponseSchemaPromptSection(conversation.planMode),
  ].join("\n");
}

export function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to brace matching.
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;

  try {
    const parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function extractImageGenerationItem(event: Record<string, unknown>) {
  const direct = event.type === "image_generation_call" ? event : null;
  const item = asRecord(event.item);
  const payload = asRecord(event.payload);
  const candidate = direct ?? item ?? payload;
  if (candidate?.type !== "image_generation_call") return null;
  return candidate;
}

export function base64PngToBuffer(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const base64 = trimmed.includes(",") ? trimmed.slice(trimmed.indexOf(",") + 1) : trimmed;
  if (!/^[a-zA-Z0-9+/=\s]+$/.test(base64)) return null;
  try {
    const buffer = Buffer.from(base64.replace(/\s+/g, ""), "base64");
    if (buffer.length <= 0) return null;
    return buffer;
  } catch {
    return null;
  }
}

export function extractGeneratedAttachments(result: AgentRuntimeExecutionResult): ChatGeneratedAttachment[] {
  const raw =
    result.resultJson && typeof result.resultJson === "object" && !Array.isArray(result.resultJson)
      ? (result.resultJson as Record<string, unknown>)
      : null;
  const stdout = typeof raw?.stdout === "string" ? raw.stdout : "";
  if (!stdout) return [];

  const attachments: ChatGeneratedAttachment[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !line.includes("image_generation_call")) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const event = asRecord(parsed);
    if (!event) continue;
    const item = extractImageGenerationItem(event);
    if (!item) continue;
    const buffer = base64PngToBuffer(item.result);
    if (!buffer) continue;

    const toolCallId = typeof item.id === "string" && item.id.trim() ? item.id.trim() : null;
    const key = toolCallId ?? `${buffer.length}:${buffer.subarray(0, 32).toString("base64")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const filenameStem = toolCallId?.replace(/[^a-zA-Z0-9._-]+/g, "_") || `generated-image-${attachments.length + 1}`;
    attachments.push({
      source: "codex_image_generation",
      originalFilename: `${filenameStem}.png`,
      contentType: "image/png",
      body: buffer,
      toolCallId,
    });
  }
  return attachments;
}

export function isImageAttachment(attachment: Pick<ChatMessage["attachments"][number], "contentType">) {
  return attachment.contentType.toLowerCase().startsWith("image/");
}

export function extensionForContentType(contentType: string) {
  switch (contentType.toLowerCase()) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/svg+xml":
      return ".svg";
    default:
      return "";
  }
}

export function safeAttachmentFilename(
  attachment: Pick<ChatMessage["attachments"][number], "id" | "assetId" | "originalFilename" | "contentType">,
  index: number,
) {
  const fallbackExt = extensionForContentType(attachment.contentType);
  const sourceName = attachment.originalFilename ?? `${attachment.assetId}${fallbackExt}`;
  const base = path.basename(sourceName).trim();
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  const filename = cleaned || `attachment-${index + 1}${fallbackExt}`;
  const hasExt = path.extname(filename).length > 0;
  const withExt = hasExt || !fallbackExt ? filename : `${filename}${fallbackExt}`;
  return `${String(index + 1).padStart(2, "0")}-${attachment.id.replace(/[^a-zA-Z0-9._-]+/g, "_")}-${withExt}`.slice(0, 180);
}

export async function prepareChatAttachmentReferences(input: {
  runtimeType: AgentRuntimeType;
  messages: ChatMessage[];
  storage?: StorageService;
  runId: string;
}) {
  const references = new Map<string, ChatAttachmentPromptReference>();
  const media: AgentRuntimeMediaAttachment[] = [];
  if (!CHAT_LOCAL_IMAGE_RUNTIME_TYPES.has(input.runtimeType) || !input.storage) {
    return { references, media, cleanup: async () => {} };
  }

  const attachments = input.messages
    .slice(-12)
    .flatMap((message) => message.attachments)
    .filter(isImageAttachment);
  if (attachments.length === 0) {
    return { references, media, cleanup: async () => {} };
  }

  const safeRunId = input.runId.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `rudder-chat-attachments-${safeRunId}-`));

  const preparedMedia = await Promise.all(attachments.map(async (attachment, index) => {
    const targetPath = path.join(dir, safeAttachmentFilename(attachment, index));
    try {
      const object = await input.storage!.getObject(attachment.orgId, attachment.objectKey);
      await pipeline(object.stream, createWriteStream(targetPath, { mode: 0o600 }));
      references.set(attachment.id, { localPath: targetPath });
      return {
        source: "chat_attachment",
        attachmentId: attachment.id,
        assetId: attachment.assetId,
        name: attachment.originalFilename ?? attachment.assetId,
        originalFilename: attachment.originalFilename,
        contentType: attachment.contentType,
        byteSize: attachment.byteSize,
        localPath: targetPath,
      } satisfies AgentRuntimeMediaAttachment;
    } catch (error) {
      references.set(attachment.id, {
        localPathError: error instanceof Error ? error.message : "Failed to prepare image attachment",
      });
      return null;
    }
  }));
  media.push(...preparedMedia.filter((item): item is AgentRuntimeMediaAttachment => item !== null));

  return {
    references,
    media,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

export function validateAssistantResult(
  payload: Record<string, unknown>,
  options: { bodyOverride?: string | null; bodyFallback?: string | null } = {},
): ChatAssistantResult {
  const kind = typeof payload.kind === "string" ? payload.kind : "message";
  const payloadBody = typeof payload.body === "string" ? payload.body.trim() : "";
  const body = options.bodyOverride?.trim() || payloadBody || options.bodyFallback?.trim() || "";
  const structuredPayload =
    payload.structuredPayload && typeof payload.structuredPayload === "object" && !Array.isArray(payload.structuredPayload)
      ? sanitizeChatStructuredPayload(payload.structuredPayload as Record<string, unknown>)
      : null;

  if (!body) {
    throw new Error("Assistant response body was empty");
  }

  if (
    kind !== "message"
    && kind !== "ask_user"
    && kind !== "issue_proposal"
    && kind !== "operation_proposal"
    && kind !== "automation_create"
  ) {
    throw new Error(`Unsupported assistant result kind: ${kind}`);
  }

  if (kind === "ask_user" && !chatAskUserRequestFromStructuredPayload(structuredPayload)) {
    throw new Error("ask_user assistant responses require structuredPayload.requestUserInput with 1-3 valid questions");
  }

  if (kind === "issue_proposal" && !chatIssueProposalFromStructuredPayload(structuredPayload)) {
    throw new Error("issue_proposal assistant responses require structuredPayload.issueProposal with title, description, and an explicit owner decision");
  }

  if (kind === "automation_create" && !chatAutomationCreateFromStructuredPayload(structuredPayload)) {
    throw new Error("automation_create assistant responses require structuredPayload.automationCreate with a valid schedule");
  }

  return {
    kind,
    body,
    structuredPayload,
  };
}

export function buildConversationPrompt(
  input: GenerateChatAssistantReplyInput,
  runtimeSource: ResolvedChatRuntimeSource,
  resultSentinel: string,
  orgResourcesPrompt: string,
  attachmentReferences: Map<string, ChatAttachmentPromptReference> = new Map(),
) {
  const operatorProfileSection = buildOperatorProfilePromptSection(input.operatorProfile);
  const selectedProjectSection = buildSelectedProjectPromptSection(input.contextLinks);
  const selectedIssueSection = buildSelectedIssuePromptSection(input.conversation, input.contextLinks);
  const issueLabelsSection = buildIssueLabelsPromptSection(input.issueLabels);
  const automationRunInputSection = buildAutomationRunInputPromptSection(input.messages);
  const currentUserAttachmentSection = buildCurrentUserAttachmentPromptSection(input.messages.slice(-12), attachmentReferences);
  /**
   * Chat prompt assembly stays compositional on purpose.
   *
   * Reasoning:
   * - Always-loaded sections should hold only invariant chat-scene rules.
   * - Conditional behavior such as plan mode should be injected only when active,
   *   so the runtime does not carry dormant "when X, do Y" branches in every chat.
   *
   * Traceability:
   * - doc/plans/2026-04-18-chat-plan-mode.md
   * - doc/DEVELOPING.md
   */
  return [
    systemPrompt(runtimeSource, input.conversation, resultSentinel),
    ...(selectedIssueSection ? [selectedIssueSection] : []),
    ...(selectedProjectSection ? [selectedProjectSection] : []),
    ...(issueLabelsSection ? [issueLabelsSection] : []),
    ...(automationRunInputSection ? [automationRunInputSection] : []),
    ...(orgResourcesPrompt ? [orgResourcesPrompt] : []),
    ...(operatorProfileSection ? [operatorProfileSection] : []),
    ...(currentUserAttachmentSection ? [currentUserAttachmentSection] : []),
    "Conversation input:",
    buildPrompt(input, attachmentReferences),
  ].join("\n\n");
}

export function resultText(result: AgentRuntimeExecutionResult) {
  if (typeof result.summary === "string" && result.summary.trim().length > 0) {
    return result.summary.trim();
  }
  const raw =
    result.resultJson && typeof result.resultJson === "object" && !Array.isArray(result.resultJson)
      ? (result.resultJson as Record<string, unknown>)
      : null;
  const candidate = typeof raw?.text === "string"
    ? raw.text
    : typeof raw?.message === "string"
      ? raw.message
      : typeof raw?.content === "string"
        ? raw.content
        : null;
  return safeTrim(candidate) ?? "";
}

export function configArgs(agentRuntimeConfig: Record<string, unknown>) {
  const raw = Array.isArray(agentRuntimeConfig.extraArgs)
    ? agentRuntimeConfig.extraArgs
    : Array.isArray(agentRuntimeConfig.args)
      ? agentRuntimeConfig.args
      : [];
  return raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

export function stripCliArgs(
  args: string[],
  input: {
    flagsWithValues?: string[];
    standaloneFlags?: string[];
    prefixedFlags?: string[];
  },
) {
  const flagsWithValues = new Set(input.flagsWithValues ?? []);
  const standaloneFlags = new Set(input.standaloneFlags ?? []);
  const prefixedFlags = input.prefixedFlags ?? [];
  const next: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (flagsWithValues.has(arg)) {
      index += 1;
      continue;
    }
    if (standaloneFlags.has(arg)) {
      continue;
    }
    if (prefixedFlags.some((prefix) => arg.startsWith(prefix))) {
      continue;
    }
    next.push(arg);
  }

  return next;
}

export function applyPlanModeRuntimeOverlay(
  agentRuntimeType: AgentRuntimeType,
  agentRuntimeConfig: Record<string, unknown>,
) {
  const args = configArgs(agentRuntimeConfig);

  if (agentRuntimeType === "codex_local") {
    return {
      ...agentRuntimeConfig,
      dangerouslyBypassApprovalsAndSandbox: false,
      dangerouslyBypassSandbox: false,
      extraArgs: [
        "-s",
        "read-only",
        ...stripCliArgs(args, {
          flagsWithValues: ["-s", "--sandbox"],
          standaloneFlags: ["--dangerously-bypass-approvals-and-sandbox"],
          prefixedFlags: ["--sandbox="],
        }),
      ],
    };
  }

  if (agentRuntimeType === "claude_local") {
    return {
      ...agentRuntimeConfig,
      dangerouslySkipPermissions: false,
      extraArgs: [
        "--permission-mode",
        "plan",
        ...stripCliArgs(args, {
          flagsWithValues: ["--permission-mode"],
          standaloneFlags: ["--dangerously-skip-permissions"],
          prefixedFlags: ["--permission-mode="],
        }),
      ],
    };
  }

  if (agentRuntimeType === "cursor") {
    return {
      ...agentRuntimeConfig,
      mode: "plan",
      extraArgs: stripCliArgs(args, {
        flagsWithValues: ["--mode"],
        prefixedFlags: ["--mode="],
      }),
    };
  }

  return agentRuntimeConfig;
}

export function chatExecutionConfig(
  conversation: Pick<ChatConversation, "planMode">,
  agentRuntimeType: AgentRuntimeType,
  agentRuntimeConfig: Record<string, unknown>,
): Record<string, unknown> {
  const baseConfig = conversation.planMode
    ? applyPlanModeRuntimeOverlay(agentRuntimeType, agentRuntimeConfig)
    : agentRuntimeConfig;
  return {
    ...baseConfig,
    promptTemplate: "{{context.chatPrompt}}",
    bootstrapPromptTemplate: "",
    maxTurns: 1,
    chrome: false,
  };
}

export function linkedIssueIdsForChat(
  conversation: Pick<ChatConversation, "primaryIssueId">,
  contextLinks: ChatContextLink[],
) {
  return Array.from(
    new Set(
      [
        conversation.primaryIssueId,
        ...contextLinks
          .filter((link) => link.entityType === "issue")
          .map((link) => link.entityId),
      ].filter((value): value is string => typeof value === "string" && value.trim().length > 0),
    ),
  );
}

export function linkedProjectIdForChat(contextLinks: ChatContextLink[]) {
  return contextLinks.find((link) => link.entityType === "project")?.entityId ?? null;
}

export function stubAgent(input: {
  orgId: string;
  agentRuntimeType: AgentRuntimeType;
  agentRuntimeConfig: Record<string, unknown>;
  sourceLabel: string;
  sourceId: string;
}): AgentRuntimeExecutionContext["agent"] {
  return {
    id: input.sourceId,
    orgId: input.orgId,
    name: input.sourceLabel,
    agentRuntimeType: input.agentRuntimeType,
    agentRuntimeConfig: input.agentRuntimeConfig,
  };
}

export function summarizeRuntimeSkills(entries: RudderSkillEntry[]): AgentRuntimeLoadedSkillMeta[] {
  return entries.map((entry) => ({
    key: entry.key,
    runtimeName: entry.runtimeName,
    name: entry.name,
    description: entry.description,
  }));
}

export function longestSentinelPrefixSuffix(value: string, sentinel: string) {
  const max = Math.min(value.length, sentinel.length - 1);
  for (let len = max; len > 0; len -= 1) {
    if (value.endsWith(sentinel.slice(0, len))) {
      return len;
    }
  }
  return 0;
}

export function createAssistantTextAccumulator() {
  let fullText = "";

  return {
    get fullText() {
      return fullText;
    },
    push(fragment: string, isDelta = false) {
      if (!fragment) return "";
      if (isDelta) {
        fullText += fragment;
        return fragment;
      }
      if (fragment.startsWith(fullText)) {
        const delta = fragment.slice(fullText.length);
        fullText = fragment;
        return delta;
      }
      if (fullText.endsWith(fragment) || fullText.includes(fragment)) {
        return "";
      }
      fullText += fragment;
      return fragment;
    },
  };
}

export function createSentinelStream(resultSentinel: string) {
  let visibleText = "";
  let resultPayloadText = "";
  let carry = "";
  let seenSentinel = false;

  return {
    get visibleText() {
      return visibleText;
    },
    get resultPayloadText() {
      return resultPayloadText;
    },
    get seenSentinel() {
      return seenSentinel;
    },
    push(text: string) {
      if (!text) return "";
      if (seenSentinel) {
        resultPayloadText += text;
        return "";
      }

      const combined = `${carry}${text}`;
      const sentinelIndex = combined.indexOf(resultSentinel);
      if (sentinelIndex >= 0) {
        const visibleDelta = combined.slice(0, sentinelIndex);
        seenSentinel = true;
        visibleText += visibleDelta;
        resultPayloadText += combined.slice(sentinelIndex + resultSentinel.length);
        carry = "";
        return visibleDelta;
      }

      const holdLength = longestSentinelPrefixSuffix(combined, resultSentinel);
      const visibleDelta = combined.slice(0, combined.length - holdLength);
      carry = combined.slice(combined.length - holdLength);
      visibleText += visibleDelta;
      return visibleDelta;
    },
    finish() {
      if (seenSentinel) {
        if (carry) resultPayloadText += carry;
        carry = "";
        return "";
      }

      const visibleDelta = carry;
      carry = "";
      visibleText += visibleDelta;
      return visibleDelta;
    },
  };
}

export function parseAssistantEnvelope(rawText: string, resultSentinel: string) {
  const sentinelIndex = rawText.indexOf(resultSentinel);
  if (sentinelIndex === -1) {
    return {
      visibleBody: rawText.trim(),
      jsonPayload: null as Record<string, unknown> | null,
      usedSentinel: false,
    };
  }

  const visibleBody = rawText.slice(0, sentinelIndex).trim();
  const jsonPayload = extractJsonObject(rawText.slice(sentinelIndex + resultSentinel.length));
  return {
    visibleBody,
    jsonPayload,
    usedSentinel: true,
  };
}

export function parseCompletedAssistantReply(
  rawText: string,
  resultSentinel: string,
  options: { requireSentinel?: boolean } = {},
): ChatAssistantResult {
  const enveloped = parseAssistantEnvelope(rawText, resultSentinel);
  if (options.requireSentinel && !enveloped.usedSentinel) {
    throw new Error("Chat adapter completed without the required Rudder result sentinel");
  }
  if (options.requireSentinel && enveloped.usedSentinel && !enveloped.jsonPayload) {
    throw new Error("Chat adapter emitted the Rudder result sentinel without a valid JSON payload");
  }
  if (enveloped.jsonPayload) {
    return validateAssistantResult(enveloped.jsonPayload, {
      bodyFallback: enveloped.usedSentinel ? enveloped.visibleBody : null,
    });
  }

  const legacyPayload = extractJsonObject(rawText);
  if (legacyPayload) {
    return validateAssistantResult(legacyPayload);
  }

  const body = safeTrim(enveloped.visibleBody);
  if (!body) {
    throw new Error("Chat adapter returned no assistant text");
  }
  return {
    kind: "message",
    body,
    structuredPayload: null,
  };
}

export function partialBodyFromRawAssistantText(rawText: string, resultSentinel: string) {
  return safeTrim(parseAssistantEnvelope(rawText, resultSentinel).visibleBody) ?? "";
}

export async function maybeEmitAssistantState(
  callback: StreamChatAssistantReplyInput["onAssistantState"],
  state: "streaming" | "finalizing" | "stopped",
) {
  if (!callback) return;
  await callback(state);
}

export async function maybeEmitAssistantDelta(
  callback: StreamChatAssistantReplyInput["onAssistantDelta"],
  delta: string,
) {
  if (!callback || !delta) return;
  await callback(delta);
}

export async function maybeEmitTranscriptEntry(
  callback: StreamChatAssistantReplyInput["onTranscriptEntry"],
  entry: TranscriptEntry,
) {
  if (!callback) return;
  await callback(entry);
}

export async function maybeEmitObservedTranscriptEntry(
  callback: StreamChatAssistantReplyInput["onObservedTranscriptEntry"],
  entry: TranscriptEntry,
) {
  if (!callback) return;
  await callback(entry);
}

export function shouldSuppressChatTranscriptEntry(entry: TranscriptEntry, resultSentinel: string) {
  if (entry.kind === "result") {
    return true;
  }
  if (entry.kind === "stdout" && entry.text.includes(resultSentinel)) {
    return true;
  }
  return false;
}
