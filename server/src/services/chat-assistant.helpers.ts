import type {
  AgentRuntimeControlCoordinator,
  AgentRuntimeMediaAttachment,
  TranscriptEntry,
} from "@rudderhq/agent-runtime-utils";
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
  MAX_CODEX_INLINE_VISUALS,
  chatAskUserRequestFromStructuredPayload,
  chatAutomationCreateFromStructuredPayload,
  chatIssueProposalFromStructuredPayload,
  parseCodexInlineVisualDirectives,
  redactRudderInlineVisualSources,
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
import {
  buildChatInlineAnnotationsPromptSection,
  buildCurrentUserAttachmentPromptSection,
} from "./chat-assistant.annotations.js";
import {
  buildChatInlineVisualPromptSection
} from "./chat-assistant.inline-visuals.js";
import { validateIssueProposalAttachmentSafety } from "./chat-assistant.proposal-validation.js";

export {
  buildChatInlineVisualPromptSection,
  chatAssistantErrorForLog,
  extractRudderInlineVisualArtifacts,
  redactChatInlineVisualDiagnosticText
} from "./chat-assistant.inline-visuals.js";

export const CHAT_UNSUPPORTED_ADAPTER_TYPES = new Set<AgentRuntimeType>();
export const CHAT_RESULT_SENTINEL_PREFIX = "__RUDDER_RESULT_";
export const CHAT_RESULT_TEXT_BLOCK_BEGIN = "RUDDER_RESULT_BEGIN";
export const CHAT_RESULT_TEXT_BLOCK_END = "RUDDER_RESULT_END";
export const CHAT_ASSISTANT_USER_ERROR_MESSAGE =
  "The assistant hit a system-level issue. Rudder saved the details for diagnostics; retry when ready.";
export const CHAT_ASSISTANT_RECOVERABLE_FAILURE_MESSAGE =
  "The assistant reply could not be completed. Rudder saved this attempt for diagnostics; retry when ready.";

export type ChatRecoverableFailureCode =
  | "chat_result_missing_sentinel"
  | "chat_result_malformed_json"
  | "chat_timed_out"
  | "chat_adapter_failed"
  | "chat_runtime_preparation_failed"
  | "chat_runtime_boot_failed"
  | "chat_runtime_exception";

export type ChatFailurePhase =
  | "runtime_boot"
  | "model_generation"
  | "protocol_finalization";

export type ChatFailureAction =
  | "retry"
  | "repair_runtime"
  | "inspect_run";

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
  inlineVisuals?: ChatInlineVisualResult[];
  inlineVisualsV1?: ChatInlineVisualV1Result[];
}

export type ChatGeneratedAttachment =
  | {
    source: "codex_image_generation";
    originalFilename: string;
    contentType: string;
    body: Buffer;
    toolCallId?: string | null;
  }
  | {
    source: "codex_inline_visual";
    originalFilename: string;
    contentType: "text/html";
    body: Buffer;
    directiveIndex: number;
    directiveFile: string;
  }
  | {
    source: "rudder_inline_visual";
    originalFilename: string;
    contentType: "text/html";
    body: Buffer;
    slot: number;
  };

export type ChatInlineVisualResult =
  | { directiveIndex: number; file: string; status: "captured" }
  | { directiveIndex: number; file: string; status: "unavailable"; reason: string };

export type ChatInlineVisualV1Result =
  | { version: 1; slot: number; file: string; status: "captured"; byteSize: number }
  | { version: 1; slot: number; file: string; status: "unavailable"; reason: string };

export interface GenerateChatAssistantReplyInput {
  conversation: ChatConversation;
  messages: ChatMessage[];
  contextLinks: ChatContextLink[];
  issueLabels?: IssueLabel[] | null;
  operatorProfile?: OperatorProfileSettings | null;
  agentIdSnapshot?: string | null;
  modelSnapshot?: string | null;
  effortSnapshot?: string | null;
}

export interface StreamChatAssistantReplyInput extends GenerateChatAssistantReplyInput {
  userMessageId?: string | null;
  chatTurnId?: string | null;
  turnVariant?: number | null;
  runContext?: Record<string, unknown> | null;
  stream?: boolean;
  abortSignal?: AbortSignal;
  controlCoordinator?: AgentRuntimeControlCoordinator;
  onRunCreated?: (runId: string) => Promise<void> | void;
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
  partialBodyUserVisible: boolean;
  generatedAttachments!: ChatGeneratedAttachment[];
  errorCode: ChatRecoverableFailureCode;
  userMessage: string;
  retryable?: boolean;
  failurePhase?: ChatFailurePhase;
  action?: ChatFailureAction;

  constructor(
    message: string,
    partialBody: string,
    generatedAttachments: ChatGeneratedAttachment[] = [],
    options: {
      partialBodyUserVisible?: boolean;
      errorCode?: ChatRecoverableFailureCode;
      userMessage?: string;
      retryable?: boolean;
      failurePhase?: ChatFailurePhase;
      action?: ChatFailureAction;
    } = {},
  ) {
    super(message);
    this.name = "ChatAssistantStreamError";
    this.partialBody = partialBody;
    this.partialBodyUserVisible = options.partialBodyUserVisible === true;
    Object.defineProperty(this, "generatedAttachments", {
      value: generatedAttachments,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    this.errorCode = options.errorCode ?? "chat_runtime_exception";
    this.userMessage = options.userMessage ?? recoverableFailureMessage(this.errorCode);
    this.retryable = options.retryable;
    this.failurePhase = options.failurePhase;
    this.action = options.action;
  }
}

export function recoverableFailureMessage(code: ChatRecoverableFailureCode) {
  if (code === "chat_result_missing_sentinel") {
    return "The assistant reply could not be completed. Rudder saved the attempt for diagnostics; retry when ready.";
  }
  if (code === "chat_result_malformed_json") {
    return "The assistant returned an incomplete final reply. Rudder saved the attempt and transcript; retry when ready.";
  }
  if (code === "chat_timed_out") {
    return "The assistant timed out before finishing. Rudder saved the partial attempt; retry when ready.";
  }
  if (code === "chat_adapter_failed") {
    return "The assistant runtime failed before finishing. Rudder saved the attempt for diagnostics; retry when ready.";
  }
  if (code === "chat_runtime_preparation_failed") {
    return "The assistant runtime could not prepare its configured skills or files. Check the runtime configuration, then retry.";
  }
  if (code === "chat_runtime_boot_failed") {
    return "The assistant runtime did not start successfully. Fix the runtime command or environment, then run again.";
  }
  return CHAT_ASSISTANT_RECOVERABLE_FAILURE_MESSAGE;
}

export function buildMissingResultSentinelRepairPrompt(input: {
  resultSentinel: string;
  priorText: string;
}) {
  const priorText = redactRudderInlineVisualSources(input.priorText);
  return [
    "Rudder internal repair request:",
    "- Your previous chat turn ended without the required Rudder result sentinel.",
    "- Do not continue the task, browse, inspect files, ask questions, or add new analysis.",
    "- Re-emit the final user-visible answer from your previous response as the required Rudder result envelope.",
    `- If the previous response is only plain user-visible text, output exactly ${CHAT_RESULT_TEXT_BLOCK_BEGIN} on its own line, then the final answer body, then ${CHAT_RESULT_TEXT_BLOCK_END} on its own line.`,
    "- Preserve the original result kind and structuredPayload only when the previous response already contains a valid Rudder result JSON object.",
    `- For structured non-message results only, output exactly one line that starts with ${input.resultSentinel} followed immediately by JSON.`,
    "- Structured JSON shape: {\"kind\":\"ask_user|issue_proposal|operation_proposal|automation_create\",\"body\":\"<final answer>\",\"structuredPayload\":object}",
    "- Do not output anything before or after the result envelope.",
    "",
    "Previous response text:",
    priorText || "(empty)",
  ].join("\n");
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

  const history = input.messages.slice(-12).map((message) => {
    const structuredPayload = message.structuredPayload
      ? { ...message.structuredPayload }
      : null;
    if (structuredPayload) {
      delete structuredPayload.inlineAnnotations;
    }
    return {
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
      structuredPayload: structuredPayload && Object.keys(structuredPayload).length > 0
        ? structuredPayload
        : null,
    };
  });

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
    "You are in chat scene of Rudder.",
    "Always prefer clarification before proposing issue creation when requirements are incomplete.",
    "Treat message attachments as part of the user's message. If an image attachment includes localPath metadata, inspect that local file before claiming you cannot see the image.",
    buildChatInlineVisualPromptSection(),
    buildChatResponseQualityPromptSection(),
    "Use result kind 'message' for clarification, summaries, and small requests that can stay in chat.",
    "Use result kind 'ask_user' only when one to three short structured questions are blocked on the user's decision before the conversation can continue safely.",
    "For ask_user, each requestUserInput question id must be unique, and option ids must be unique within their question. Set question selectionMode to 'multiple' only when the user can choose more than one option; omit it for normal single-choice questions.",
    "Use result kind 'issue_proposal' only when the latest user request explicitly asks for creating an issue, converting the chat to an issue, or drafting an issue proposal. Do not emit issue_proposal just because work is large, durable.",
    "For issue_proposal, include exactly one owner decision in structuredPayload.issueProposal: either assigneeAgentId/assigneeUserId for the proposed owner, or assigneeUnassignedReason explaining why the issue should intentionally remain unassigned. Do not leave ownership implicit. Do not default to the selected chat agent unless that agent should actually own execution.",
    "For initial and revised issue proposals, preserve a user-provided original image in structuredPayload.issueProposal.description when it directly helps explain the requirement, reproduce the problem, provide a design reference, or define acceptance. Prefer the original image over a redraw, generated replacement, or text-only substitute.",
    "Embed each selected proposal image with Markdown image syntax and a meaningful alt text, using only the attachment's canonical contentPath as the target (for example, ![Current broken state](/api/assets/<asset-id>/content)). localPath is temporary runtime inspection context only and must never appear in user-visible proposal JSON or Markdown. Never expose an internal download command, authentication material, or a fabricated image target.",
    "Choose proposal images by relevance; do not copy every attachment indiscriminately. If an attachment is not an image, has no usable contentPath, or is not clearly relevant to the issue scope, omit the image reference and describe missing evidence only when that gap matters.",
    "When revising an issue proposal, re-check relevant user image attachments across the available recentMessages history, even when the latest revision-feedback message has no attachments. Apply the same canonical contentPath, relevance, alt-text, and no-localPath rules to the replacement proposal.",
    "Issue proposals create To Do issues by default. Omit status for the normal runnable default; set status to 'backlog' only when the issue should intentionally wait and not be picked up by agents yet.",
    "Use result kind 'automation_create' only when the latest operator-authored user request clearly asks the selected agent to set up recurring automatic work and the schedule, assignee, and output are clear. Never use automation_create for automation-run input messages.",
    "For automation_create, include structuredPayload.automationCreate with title, instructions, schedule.cronExpression, and schedule.timezone. Omit assigneeAgentId to assign the automation to the selected chat agent. Use outputMode 'track_issue' so each run creates reviewable board-tracked work.",
    "Reply in two phases.",
    "Phase 1: while you work, write concise progress updates in Markdown with no JSON fences. These are process transcript entries, not the final answer.",
    `Phase 2 for ordinary message replies: emit ${CHAT_RESULT_TEXT_BLOCK_BEGIN} on its own line, then the final user-visible answer body only, then ${CHAT_RESULT_TEXT_BLOCK_END} on its own line.`,
    `Phase 2 for ask_user, issue_proposal, operation_proposal, or automation_create replies: emit exactly ${resultSentinel} followed immediately by one JSON object.`,
    `Do not output anything after ${CHAT_RESULT_TEXT_BLOCK_END} or after the JSON object.`,
  ];
}

export function buildTerminalResultEnvelopePromptSection(resultSentinel: string) {
  return [
    "Final Rudder result reminder:",
    "For an ordinary message reply, end this chat turn with this exact shape:",
    CHAT_RESULT_TEXT_BLOCK_BEGIN,
    "<final answer body only>",
    CHAT_RESULT_TEXT_BLOCK_END,
    `Only use ${resultSentinel} plus JSON when the result kind is ask_user, issue_proposal, operation_proposal, or automation_create.`,
    `Do not write anything after ${CHAT_RESULT_TEXT_BLOCK_END} or after the JSON object.`,
  ].join("\n");
}

export function buildPlanModePromptSection() {
  return [
    "Plan mode is active for this conversation.",
    "Stay strictly in read-only investigation and planning mode.",
    "Do not propose or imply file edits, shell mutations, or lightweight work-management changes.",
    "Converge on an issue-sized implementation plan, and when you are ready to conclude, emit kind 'issue_proposal'.",
    "Put the implementation plan in the issue proposal description or cite a Project Library file link when durable documentation is needed.",
  ].join("\n");
}

export function buildResponseSchemaPromptSection(planMode: boolean) {
  return [
    "Structured JSON shape only for ask_user, issue_proposal, operation_proposal, or automation_create replies:",
    JSON.stringify(
      {
        kind: "ask_user|issue_proposal|operation_proposal|automation_create",
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

export function extractCodexInlineVisualArtifacts(result: AgentRuntimeExecutionResult): {
  attachments: ChatGeneratedAttachment[];
  inlineVisuals: ChatInlineVisualResult[];
} {
  const raw = result.resultJson && typeof result.resultJson === "object" && !Array.isArray(result.resultJson)
    ? result.resultJson as Record<string, unknown>
    : null;
  const entries = Array.isArray(raw?.inlineVisuals) ? raw.inlineVisuals : [];
  const attachments: ChatGeneratedAttachment[] = [];
  const inlineVisuals: ChatInlineVisualResult[] = [];
  const seenIndexes = new Set<number>();
  const allowedUnavailableReasons = new Set(["missing", "out_of_window", "path_escape", "too_large", "unreadable"]);

  for (const value of entries) {
    if (inlineVisuals.length >= MAX_CODEX_INLINE_VISUALS) break;
    const entry = asRecord(value);
    if (!entry) continue;
    const directiveIndex = typeof entry.directiveIndex === "number" && Number.isInteger(entry.directiveIndex)
      ? entry.directiveIndex
      : -1;
    const file = typeof entry.file === "string" ? entry.file : "";
    const parsed = parseCodexInlineVisualDirectives(`::codex-inline-vis{file="${file}"}`);
    if (
      directiveIndex < 0
      || directiveIndex >= MAX_CODEX_INLINE_VISUALS
      || seenIndexes.has(directiveIndex)
      || parsed.directives.length !== 1
      || parsed.directives[0]?.file !== file
    ) continue;

    if (entry.status === "unavailable") {
      const reason = typeof entry.reason === "string" ? entry.reason : "";
      if (!allowedUnavailableReasons.has(reason)) continue;
      seenIndexes.add(directiveIndex);
      inlineVisuals.push({ directiveIndex, file, status: "unavailable", reason });
      continue;
    }
    if (entry.status !== "captured" || entry.contentType !== "text/html") continue;
    const declaredSize = typeof entry.byteSize === "number" && Number.isInteger(entry.byteSize)
      ? entry.byteSize
      : -1;
    const body = base64PngToBuffer(entry.bodyBase64);
    if (!body || declaredSize !== body.length || declaredSize > 2 * 1024 * 1024) continue;
    seenIndexes.add(directiveIndex);
    inlineVisuals.push({ directiveIndex, file, status: "captured" });
    attachments.push({
      source: "codex_inline_visual",
      originalFilename: file,
      contentType: "text/html",
      body,
      directiveIndex,
      directiveFile: file,
    });
  }

  inlineVisuals.sort((a, b) => a.directiveIndex - b.directiveIndex);
  attachments.sort((a, b) =>
    a.source === "codex_inline_visual" && b.source === "codex_inline_visual"
      ? a.directiveIndex - b.directiveIndex
      : 0
  );
  return { attachments, inlineVisuals };
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
      if (!attachment.objectKey) throw new Error("Attachment storage reference is unavailable");
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
  options: {
    bodyOverride?: string | null;
    bodyFallback?: string | null;
    allowedProposalImageContentPaths?: ReadonlySet<string>;
    forbiddenAttachmentLocalPaths?: readonly string[];
  } = {},
): ChatAssistantResult {
  const kind = typeof payload.kind === "string" ? payload.kind : "message";
  const payloadBody = typeof payload.body === "string" ? payload.body.trim() : "";
  const body = options.bodyOverride?.trim() || payloadBody || options.bodyFallback?.trim() || "";
  const hasStructuredPayload = Object.hasOwn(payload, "structuredPayload");
  const rawStructuredPayload =
    payload.structuredPayload && typeof payload.structuredPayload === "object" && !Array.isArray(payload.structuredPayload)
      ? payload.structuredPayload as Record<string, unknown>
      : null;
  const sanitizedStructuredPayload = rawStructuredPayload
    ? sanitizeChatStructuredPayload(rawStructuredPayload)
    : null;
  const structuredPayload = sanitizedStructuredPayload
    ? (({
      inlineVisuals: _untrustedInlineVisuals,
      inlineVisualsV1: _untrustedInlineVisualsV1,
      inlineAnnotations: _untrustedInlineAnnotations,
      ...trustedPayload
    }) =>
      Object.keys(trustedPayload).length > 0 ? trustedPayload : null)(sanitizedStructuredPayload)
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
    if (hasStructuredPayload && payload.structuredPayload !== null) {
      throw new Error("ask_user assistant responses require structuredPayload.requestUserInput with 1-3 valid questions");
    }
    return {
      kind: "message",
      body,
      structuredPayload: null,
    };
  }

  if (kind === "issue_proposal") {
    const issueProposal = chatIssueProposalFromStructuredPayload(structuredPayload);
    if (!issueProposal) {
      throw new Error("issue_proposal assistant responses require structuredPayload.issueProposal with title, description, and an explicit owner decision");
    }
    validateIssueProposalAttachmentSafety({
      body,
      structuredPayload,
      description: issueProposal.description,
      allowedImageContentPaths: options.allowedProposalImageContentPaths,
      forbiddenAttachmentLocalPaths: options.forbiddenAttachmentLocalPaths,
    });
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
  const inlineAnnotationsSection = buildChatInlineAnnotationsPromptSection(
    input.messages.slice(-12),
    attachmentReferences,
  );
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
   * - doc/engineering/DEVELOPING.md
   */
  return [
    systemPrompt(runtimeSource, input.conversation, resultSentinel),
    ...(selectedIssueSection ? [selectedIssueSection] : []),
    ...(selectedProjectSection ? [selectedProjectSection] : []),
    ...(issueLabelsSection ? [issueLabelsSection] : []),
    ...(automationRunInputSection ? [automationRunInputSection] : []),
    ...(orgResourcesPrompt ? [orgResourcesPrompt] : []),
    ...(operatorProfileSection ? [operatorProfileSection] : []),
    ...(inlineAnnotationsSection ? [inlineAnnotationsSection] : []),
    ...(currentUserAttachmentSection ? [currentUserAttachmentSection] : []),
    "Conversation input:",
    buildPrompt(input, attachmentReferences),
    buildTerminalResultEnvelopePromptSection(resultSentinel),
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
      permissionMode: "plan",
      extraArgs: stripCliArgs(args, {
        flagsWithValues: ["--permission-mode"],
        standaloneFlags: ["--dangerously-skip-permissions"],
        prefixedFlags: ["--permission-mode="],
      }),
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

export function parseAssistantTextBlock(rawText: string) {
  const beginIndex = rawText.indexOf(CHAT_RESULT_TEXT_BLOCK_BEGIN);
  if (beginIndex === -1) return null;

  const bodyStart = beginIndex + CHAT_RESULT_TEXT_BLOCK_BEGIN.length;
  const endIndex = rawText.indexOf(CHAT_RESULT_TEXT_BLOCK_END, bodyStart);
  if (endIndex === -1) return null;

  const visibleBody = rawText.slice(0, beginIndex).trim();
  const body = safeTrim(rawText.slice(bodyStart, endIndex));
  if (!body) return null;
  return {
    visibleBody,
    body,
  };
}

export function parseCompletedAssistantReply(
  rawText: string,
  resultSentinel: string,
  options: {
    requireSentinel?: boolean;
    allowedProposalImageContentPaths?: ReadonlySet<string>;
    forbiddenAttachmentLocalPaths?: readonly string[];
  } = {},
): ChatAssistantResult {
  const enveloped = parseAssistantEnvelope(rawText, resultSentinel);
  const textBlock = parseAssistantTextBlock(rawText);
  if (textBlock) {
    return {
      kind: "message",
      body: textBlock.body,
      structuredPayload: null,
    };
  }
  if (options.requireSentinel && !enveloped.usedSentinel) {
    throw new Error("Chat adapter completed without the required Rudder result sentinel");
  }
  if (options.requireSentinel && enveloped.usedSentinel && !enveloped.jsonPayload) {
    throw new Error("Chat adapter emitted the Rudder result sentinel without a valid JSON payload");
  }
  if (enveloped.jsonPayload) {
    return validateAssistantResult(enveloped.jsonPayload, {
      bodyFallback: enveloped.usedSentinel ? enveloped.visibleBody : null,
      allowedProposalImageContentPaths: options.allowedProposalImageContentPaths,
      forbiddenAttachmentLocalPaths: options.forbiddenAttachmentLocalPaths,
    });
  }

  const legacyPayload = extractJsonObject(rawText);
  if (legacyPayload) {
    return validateAssistantResult(legacyPayload, {
      allowedProposalImageContentPaths: options.allowedProposalImageContentPaths,
      forbiddenAttachmentLocalPaths: options.forbiddenAttachmentLocalPaths,
    });
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
  return safeTrim(parseAssistantTextBlock(rawText)?.visibleBody)
    ?? safeTrim(parseAssistantEnvelope(rawText, resultSentinel).visibleBody)
    ?? "";
}

export function finalBodyFromRawAssistantText(rawText: string, resultSentinel: string) {
  const textBlock = parseAssistantTextBlock(rawText);
  if (textBlock) return textBlock.body;
  const enveloped = parseAssistantEnvelope(rawText, resultSentinel);
  if (!enveloped.usedSentinel || !enveloped.jsonPayload) return "";
  const body = typeof enveloped.jsonPayload.body === "string" ? enveloped.jsonPayload.body : "";
  return safeTrim(body) ?? "";
}

export function userVisiblePartialBodyFromError(error: unknown) {
  if (!(error instanceof ChatAssistantStreamError)) return "";
  return error.partialBodyUserVisible
    ? error.partialBody
    : error.userMessage ?? CHAT_ASSISTANT_RECOVERABLE_FAILURE_MESSAGE;
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
