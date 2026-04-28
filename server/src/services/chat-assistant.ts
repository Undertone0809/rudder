import { randomUUID } from "node:crypto";
import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { RudderSkillEntry } from "@rudderhq/agent-runtime-utils/server-utils";
import type { Db } from "@rudderhq/db";
import type {
  AgentRuntimeType,
  ChatConversation,
  ChatContextLink,
  ChatMessage,
  ChatRuntimeDescriptor,
  ChatUserInputRequest,
  OperatorProfileSettings,
} from "@rudderhq/shared";
import { findServerAdapter } from "../agent-runtimes/index.js";
import type { AgentRuntimeInvocationMeta, AgentRuntimeLoadedSkillMeta } from "../agent-runtimes/index.js";
import type { AgentRuntimeExecutionContext, AgentRuntimeExecutionResult } from "../agent-runtimes/types.js";
import { agentRunContextService, RUDDER_COPILOT_LABEL, type AgentRunContextAgent } from "./agent-run-context.js";
import { agentService } from "./agents.js";
import { organizationService } from "./orgs.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { executeAdapterWithModelFallbacks } from "./runtime-kernel/model-fallback.js";

const ORGANIZATION_DEFAULT_CHAT_ADAPTER_TYPES = new Set<AgentRuntimeType>([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "opencode_local",
  "pi_local",
  "openclaw_gateway",
]);

const CHAT_UNSUPPORTED_ADAPTER_TYPES = new Set<AgentRuntimeType>(["process", "http"]);
const CHAT_RESULT_SENTINEL_PREFIX = "__RUDDER_RESULT_";

interface ResolvedChatRuntimeSource {
  descriptor: ChatRuntimeDescriptor;
  runtimeAgent: AgentRunContextAgent | null;
  agentRuntimeType: AgentRuntimeType | null;
  agentRuntimeConfig: Record<string, unknown> | null;
  runtimeSkills: AgentRuntimeLoadedSkillMeta[];
}

export interface ChatAssistantResult {
  kind: "message" | "issue_proposal" | "operation_proposal" | "routing_suggestion" | "user_input_request";
  body: string;
  structuredPayload: Record<string, unknown> | null;
  replyingAgentId?: string | null;
}

export interface GenerateChatAssistantReplyInput {
  conversation: ChatConversation;
  messages: ChatMessage[];
  contextLinks: ChatContextLink[];
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

  constructor(message: string, partialBody: string) {
    super(message);
    this.name = "ChatAssistantStreamError";
    this.partialBody = partialBody;
  }
}

function safeTrim(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function summarizeBody(value: string, maxChars = 160) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "(empty)";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}…`;
}

function modelLabel(config: Record<string, unknown> | null | undefined) {
  return safeTrim(typeof config?.model === "string" ? config.model : null);
}

function unconfiguredDescriptor(error: string): ChatRuntimeDescriptor {
  return {
    sourceType: "unconfigured",
    sourceLabel: "Configure Rudder Copilot",
    runtimeAgentId: null,
    agentRuntimeType: null,
    model: null,
    available: false,
    error,
  };
}

function unavailableAgentDescriptor(input: {
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

function buildPrompt(input: GenerateChatAssistantReplyInput) {
  const contextSummary = input.contextLinks.map((link) => ({
    entityType: link.entityType,
    entityId: link.entityId,
    label: link.entity?.label ?? null,
    identifier: link.entity?.identifier ?? null,
    status: link.entity?.status ?? null,
  }));

  const history = input.messages.slice(-12).map((message) => ({
    role: message.role,
    kind: message.kind,
    status: message.status,
    body: message.body,
    attachments: message.attachments.map((attachment) => ({
      id: attachment.id,
      assetId: attachment.assetId,
      name: attachment.originalFilename ?? attachment.assetId,
      contentType: attachment.contentType,
      byteSize: attachment.byteSize,
      contentPath: attachment.contentPath,
      fetchUrl: `$RUDDER_API_URL${attachment.contentPath}`,
      downloadCommand: `curl -L -H "Authorization: Bearer $RUDDER_API_KEY" "$RUDDER_API_URL${attachment.contentPath}" -o ${attachment.originalFilename ?? attachment.assetId}`,
    })),
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

function buildCurrentUserAttachmentPromptSection(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user" || message.attachments.length === 0) continue;

    const lines = [
      "Current user message attachments:",
      `- The latest user message includes ${message.attachments.length} attachment(s). Inspect them before answering.`,
      `- User message body: ${JSON.stringify(summarizeBody(message.body))}`,
      ...message.attachments.map((attachment, attachmentIndex) => {
        const name = attachment.originalFilename ?? attachment.assetId;
        const fetchUrl = `$RUDDER_API_URL${attachment.contentPath}`;
        const downloadCommand = `curl -L -H "Authorization: Bearer $RUDDER_API_KEY" "${fetchUrl}" -o ${name}`;
        return `- [${attachmentIndex + 1}] name=${name}; contentType=${attachment.contentType}; byteSize=${attachment.byteSize}; contentPath=${attachment.contentPath}; fetchUrl=${fetchUrl}; downloadCommand=${downloadCommand}`;
      }),
    ];
    return lines.join("\n");
  }

  return null;
}

function buildOperatorProfilePromptSection(profile: OperatorProfileSettings | null | undefined) {
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

function buildSelectedProjectPromptSection(contextLinks: ChatContextLink[]) {
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

function buildChatSpeakerPromptSection(runtimeSource: ResolvedChatRuntimeSource) {
  const name = runtimeSource.descriptor.sourceLabel;
  if (runtimeSource.descriptor.sourceType === "agent") {
    return [
      `You are ${name}, replying inside Rudder's chat scene.`,
      "Speak as this agent, using the agent's own instructions and enabled skills as your working context.",
      "Do not claim to be Rudder Copilot or a generic assistant.",
    ].join("\n");
  }

  return [
    `You are ${name}, the system-managed chat copilot for this Rudder organization.`,
    "Stay inside the chat scene. Clarify, structure, and propose work, but do not hand off or dispatch to another agent on your own.",
  ].join("\n");
}

function buildBaseSystemPromptSections(runtimeSource: ResolvedChatRuntimeSource, resultSentinel: string) {
  return [
    buildChatSpeakerPromptSection(runtimeSource),
    "Your job is to clarify work requests for a Rudder AI organization control plane.",
    "This is the dedicated chat scene. Do not use heartbeat issue bootstrap framing.",
    "Always reply in the same language as the user's most recent substantive message unless they explicitly ask for a different language.",
    "Always prefer clarification before proposing issue creation when requirements are incomplete.",
    "Treat message attachments as part of the user's message. If an image attachment is present, fetch or inspect it before claiming you cannot see the image.",
    "Attachment URLs in the conversation input are relative to $RUDDER_API_URL and require Authorization: Bearer $RUDDER_API_KEY when fetched from tools.",
    "Use result kind 'message' for clarification, summaries, and small requests that can stay in chat.",
    "Use result kind 'issue_proposal' for larger work that should become an issue.",
    "Use result kind 'routing_suggestion' only when recommending an agent or role to handle work.",
    "Reply in two phases.",
    "Phase 1: while you work, write concise progress updates in Markdown with no JSON fences. These are process transcript entries, not the final answer.",
    `Phase 2: on a new line, emit exactly ${resultSentinel} followed immediately by one JSON object. The JSON body is the final user-visible answer.`,
    "Do not output anything after that JSON object.",
  ];
}

function buildPlanModePromptSection() {
  return [
    "Plan mode is active for this conversation.",
    "Stay strictly in read-only investigation and planning mode.",
    "Do not propose or imply file edits, shell mutations, or lightweight control-plane changes.",
    "The structured user-input tool request_user_input is available only in plan mode.",
    "Use request_user_input only when a user decision is genuinely blocking a good plan; do not ask questions by default.",
    "To call request_user_input, emit kind 'user_input_request' with structuredPayload.requestUserInput instead of an issue proposal.",
    "request_user_input accepts 1 to 3 short questions. Each question must have 2 to 3 mutually exclusive options.",
    "Converge on an issue-sized implementation plan, and when you are ready to conclude, emit kind 'issue_proposal'.",
    "Include structuredPayload.planDocument.body as markdown for the issue plan document.",
  ].join("\n");
}

function buildResponseSchemaPromptSection(planMode: boolean) {
  const structuredPayload: Record<string, unknown> = {
    summary: "optional short summary",
    issueProposal: {
      title: "required for issue_proposal",
      description: "required for issue_proposal",
      priority: "critical|high|medium|low",
      assigneeAgentId: "optional uuid",
      projectId: "optional uuid",
      goalId: "optional uuid",
      parentId: "optional uuid",
    },
    planDocument: {
      title: "optional plan title",
      body: planMode
        ? "required markdown plan for the issue plan document"
        : "optional markdown plan",
      changeSummary: "optional short summary for the issue document revision",
    },
    routingSuggestion: {
      agentId: "optional uuid",
      reason: "short explanation",
    },
  };
  if (planMode) {
    structuredPayload.requestUserInput = {
      questions: [
        {
          id: "stable_snake_case_id",
          header: "12 chars max",
          question: "short question for the user",
          options: [
            {
              id: "stable_option_id",
              label: "1-5 words",
              description: "one short sentence explaining the tradeoff",
            },
            {
              id: "another_option_id",
              label: "1-5 words",
              description: "one short sentence explaining the tradeoff",
            },
          ],
        },
      ],
    };
  }

  return [
    "JSON shape:",
    JSON.stringify(
      {
        kind: "message",
        body: "final user-visible answer only, not progress updates",
        structuredPayload,
      },
      null,
      2,
    ),
  ].join("\n");
}

function systemPrompt(
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

function extractJsonObject(text: string): Record<string, unknown> | null {
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

function slugifyId(value: string, fallback: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function normalizeUserInputOption(value: unknown, fallbackIndex: number) {
  const option =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const label = typeof option.label === "string" ? option.label.trim() : "";
  if (!label) return null;
  const rawId =
    typeof option.id === "string" ? option.id.trim()
      : typeof option.key === "string" ? option.key.trim()
        : "";
  const description = typeof option.description === "string" && option.description.trim()
    ? option.description.trim()
    : null;
  return {
    id: slugifyId(rawId || label, `option_${fallbackIndex + 1}`),
    label,
    description,
  };
}

function normalizeRequestUserInput(value: unknown): ChatUserInputRequest | null {
  const payload =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (!payload || !Array.isArray(payload.questions)) return null;

  const questions = payload.questions
    .slice(0, 3)
    .map((questionRaw, questionIndex) => {
      const question =
        questionRaw && typeof questionRaw === "object" && !Array.isArray(questionRaw)
          ? (questionRaw as Record<string, unknown>)
          : {};
      const questionText =
        (typeof question.question === "string" ? question.question.trim() : "")
        || (typeof question.prompt === "string" ? question.prompt.trim() : "");
      if (!questionText) return null;
      const rawOptions = Array.isArray(question.options)
        ? question.options
        : Array.isArray(question.choices)
          ? question.choices
          : [];
      const options = rawOptions
        .slice(0, 3)
        .map((optionRaw, optionIndex) => normalizeUserInputOption(optionRaw, optionIndex))
        .filter((option): option is NonNullable<ReturnType<typeof normalizeUserInputOption>> => Boolean(option));
      if (options.length < 2) return null;
      const rawId = typeof question.id === "string" ? question.id.trim() : "";
      const header =
        (typeof question.header === "string" ? question.header.trim() : "")
        || `Question ${questionIndex + 1}`;
      return {
        id: slugifyId(rawId || header || questionText, `question_${questionIndex + 1}`),
        header: header.slice(0, 12),
        question: questionText,
        options,
      };
    })
    .filter((question): question is NonNullable<typeof question> => Boolean(question));

  return questions.length > 0 ? { questions } : null;
}

function normalizeStructuredPayloadForKind(
  kind: string,
  structuredPayload: Record<string, unknown> | null,
) {
  if (kind !== "user_input_request") return structuredPayload;
  const request = normalizeRequestUserInput(structuredPayload?.requestUserInput);
  if (!request) {
    throw new Error("Assistant user_input_request result requires structuredPayload.requestUserInput");
  }
  return {
    ...(structuredPayload ?? {}),
    requestUserInput: request,
  };
}

function validateAssistantResult(
  payload: Record<string, unknown>,
  options: { bodyOverride?: string | null; bodyFallback?: string | null } = {},
): ChatAssistantResult {
  const kind = typeof payload.kind === "string" ? payload.kind : "message";
  const payloadBody = typeof payload.body === "string" ? payload.body.trim() : "";
  const body = options.bodyOverride?.trim() || payloadBody || options.bodyFallback?.trim() || "";
  const structuredPayload =
    payload.structuredPayload && typeof payload.structuredPayload === "object" && !Array.isArray(payload.structuredPayload)
      ? (payload.structuredPayload as Record<string, unknown>)
      : null;

  if (!body) {
    throw new Error("Assistant response body was empty");
  }

  if (
    kind !== "message" &&
    kind !== "issue_proposal" &&
    kind !== "operation_proposal" &&
    kind !== "routing_suggestion" &&
    kind !== "user_input_request"
  ) {
    throw new Error(`Unsupported assistant result kind: ${kind}`);
  }

  const normalizedStructuredPayload = normalizeStructuredPayloadForKind(kind, structuredPayload);

  return {
    kind,
    body,
    structuredPayload: normalizedStructuredPayload,
  };
}

function buildConversationPrompt(
  input: GenerateChatAssistantReplyInput,
  runtimeSource: ResolvedChatRuntimeSource,
  resultSentinel: string,
  orgResourcesPrompt: string,
) {
  const operatorProfileSection = buildOperatorProfilePromptSection(input.operatorProfile);
  const selectedProjectSection = buildSelectedProjectPromptSection(input.contextLinks);
  const currentUserAttachmentSection = buildCurrentUserAttachmentPromptSection(input.messages.slice(-12));
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
    ...(selectedProjectSection ? [selectedProjectSection] : []),
    ...(orgResourcesPrompt ? [orgResourcesPrompt] : []),
    ...(operatorProfileSection ? [operatorProfileSection] : []),
    ...(currentUserAttachmentSection ? [currentUserAttachmentSection] : []),
    "Conversation input:",
    buildPrompt(input),
  ].join("\n\n");
}

function resultText(result: AgentRuntimeExecutionResult) {
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

function assistantResultFromRuntimeQuestion(result: AgentRuntimeExecutionResult): ChatAssistantResult | null {
  const question = result.question;
  if (!question) return null;
  const runtimeQuestions = Array.isArray(question.questions) && question.questions.length > 0
    ? question.questions
    : [{
        id: "question_1",
        header: "Question",
        question: question.prompt,
        choices: question.choices,
      }];
  const request = normalizeRequestUserInput({
    questions: runtimeQuestions.map((runtimeQuestion) => ({
      id: runtimeQuestion.id,
      header: runtimeQuestion.header,
      question: runtimeQuestion.question,
      options: runtimeQuestion.choices,
    })),
  });
  if (!request) return null;
  return {
    kind: "user_input_request",
    body: resultText(result) || request.questions[0]?.question || "I need one decision before continuing.",
    structuredPayload: { requestUserInput: request },
  };
}

function configArgs(agentRuntimeConfig: Record<string, unknown>) {
  const raw = Array.isArray(agentRuntimeConfig.extraArgs)
    ? agentRuntimeConfig.extraArgs
    : Array.isArray(agentRuntimeConfig.args)
      ? agentRuntimeConfig.args
      : [];
  return raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function stripCliArgs(
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

function applyPlanModeRuntimeOverlay(
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

function chatExecutionConfig(
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

function linkedIssueIdsForChat(
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

function linkedProjectIdForChat(contextLinks: ChatContextLink[]) {
  return contextLinks.find((link) => link.entityType === "project")?.entityId ?? null;
}

function stubAgent(input: {
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

function summarizeRuntimeSkills(entries: RudderSkillEntry[]): AgentRuntimeLoadedSkillMeta[] {
  return entries.map((entry) => ({
    key: entry.key,
    runtimeName: entry.runtimeName,
    name: entry.name,
    description: entry.description,
  }));
}

function longestSentinelPrefixSuffix(value: string, sentinel: string) {
  const max = Math.min(value.length, sentinel.length - 1);
  for (let len = max; len > 0; len -= 1) {
    if (value.endsWith(sentinel.slice(0, len))) {
      return len;
    }
  }
  return 0;
}

function createAssistantTextAccumulator() {
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

function createSentinelStream(resultSentinel: string) {
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

function parseAssistantEnvelope(rawText: string, resultSentinel: string) {
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

function parseCompletedAssistantReply(rawText: string, resultSentinel: string): ChatAssistantResult {
  const enveloped = parseAssistantEnvelope(rawText, resultSentinel);
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

function partialBodyFromRawAssistantText(rawText: string, resultSentinel: string) {
  return safeTrim(parseAssistantEnvelope(rawText, resultSentinel).visibleBody) ?? "";
}

async function maybeEmitAssistantState(
  callback: StreamChatAssistantReplyInput["onAssistantState"],
  state: "streaming" | "finalizing" | "stopped",
) {
  if (!callback) return;
  await callback(state);
}

async function maybeEmitAssistantDelta(
  callback: StreamChatAssistantReplyInput["onAssistantDelta"],
  delta: string,
) {
  if (!callback || !delta) return;
  await callback(delta);
}

async function maybeEmitTranscriptEntry(
  callback: StreamChatAssistantReplyInput["onTranscriptEntry"],
  entry: TranscriptEntry,
) {
  if (!callback) return;
  await callback(entry);
}

async function maybeEmitObservedTranscriptEntry(
  callback: StreamChatAssistantReplyInput["onObservedTranscriptEntry"],
  entry: TranscriptEntry,
) {
  if (!callback) return;
  await callback(entry);
}

function shouldSuppressChatTranscriptEntry(entry: TranscriptEntry, resultSentinel: string) {
  if (entry.kind === "result") {
    return true;
  }
  if (entry.kind === "stdout" && entry.text.includes(resultSentinel)) {
    return true;
  }
  return false;
}

export function chatAssistantService(db: Db) {
  const agentsSvc = agentService(db);
  const organizationsSvc = organizationService(db);
  const runContextSvc = agentRunContextService(db);

  async function resolveChatInvocation(input: {
    conversation: Pick<ChatConversation, "id" | "orgId" | "preferredAgentId" | "primaryIssueId" | "contextLinks" | "planMode">;
    contextLinks: ChatContextLink[];
  }) {
    const runtimeSource = await resolveConversationRuntime(input.conversation);
    if (!runtimeSource.descriptor.available) {
      return {
        runtimeSource,
        adapter: null,
        config: null,
        linkedIssueIds: [] as string[],
        linkedProjectId: null as string | null,
        resolvedWorkspace: null,
        sceneContext: null,
        availabilityError: runtimeSource.descriptor.error ?? "Chat assistant is not configured",
      };
    }
    if (!runtimeSource.agentRuntimeType || !runtimeSource.agentRuntimeConfig || !runtimeSource.runtimeAgent) {
      return {
        runtimeSource,
        adapter: null,
        config: null,
        linkedIssueIds: [] as string[],
        linkedProjectId: null as string | null,
        resolvedWorkspace: null,
        sceneContext: null,
        availabilityError: runtimeSource.descriptor.error ?? "Chat runtime is not configured",
      };
    }

    const adapter = findServerAdapter(runtimeSource.agentRuntimeType);
    if (!adapter) {
      return {
        runtimeSource,
        adapter: null,
        config: null,
        linkedIssueIds: [] as string[],
        linkedProjectId: null as string | null,
        resolvedWorkspace: null,
        sceneContext: null,
        availabilityError: `Unknown chat adapter type: ${runtimeSource.agentRuntimeType}`,
      };
    }

    const config = chatExecutionConfig(
      input.conversation,
      runtimeSource.agentRuntimeType,
      runtimeSource.agentRuntimeConfig,
    );
    const linkedIssueIds = linkedIssueIdsForChat(input.conversation, input.contextLinks);
    const linkedProjectId = linkedProjectIdForChat(input.contextLinks);
    const resolvedWorkspace = await runContextSvc.resolveWorkspaceForRun(
      runtimeSource.runtimeAgent,
      {
        issueId: input.conversation.primaryIssueId ?? linkedIssueIds[0] ?? null,
        projectId: linkedProjectId,
      },
      null,
    );

    const sceneContext = await runContextSvc.buildSceneContext({
      scene: "chat",
      agent: runtimeSource.runtimeAgent,
      resolvedWorkspace,
      runtimeConfig: config,
    });

    return {
      runtimeSource,
      adapter,
      config,
      linkedIssueIds,
      linkedProjectId,
      resolvedWorkspace,
      sceneContext,
      availabilityError: null,
    };
  }

  async function resolveAgentRuntime(
    orgId: string,
    agentId: string,
  ): Promise<ResolvedChatRuntimeSource | null> {
    const agent = await agentsSvc.getById(agentId);
    if (!agent || agent.orgId !== orgId || agent.status === "terminated") {
      return {
        descriptor: unavailableAgentDescriptor({
          sourceLabel: "Selected agent",
          runtimeAgentId: null,
          agentRuntimeType: null,
          model: null,
          error: "The selected chat agent is unavailable. Choose another agent or switch back to Rudder Copilot.",
        }),
        runtimeAgent: null,
        agentRuntimeType: null,
        agentRuntimeConfig: null,
        runtimeSkills: [],
      };
    }

    const agentAdapterType = agent.agentRuntimeType as AgentRuntimeType;
    const agentAdapterConfig = (agent.agentRuntimeConfig ?? {}) as Record<string, unknown>;

    if (CHAT_UNSUPPORTED_ADAPTER_TYPES.has(agentAdapterType)) {
      return {
        descriptor: unavailableAgentDescriptor({
          sourceLabel: agent.name,
          runtimeAgentId: agent.id,
          agentRuntimeType: agentAdapterType,
          model: modelLabel(agentAdapterConfig) ?? null,
          error: `${agent.name} uses ${agentAdapterType}, which does not support chat conversations.`,
        }),
        runtimeAgent: {
          id: agent.id,
          orgId: agent.orgId,
          name: agent.name,
          agentRuntimeType: agentAdapterType,
          agentRuntimeConfig: agentAdapterConfig,
        },
        agentRuntimeType: agentAdapterType,
        agentRuntimeConfig: null,
        runtimeSkills: [],
      };
    }

    const { runtimeConfig, runtimeSkillEntries } = await runContextSvc.prepareRuntimeConfig({
      scene: "chat",
      agent: {
        id: agent.id,
        orgId: agent.orgId,
        name: agent.name,
        status: agent.status,
        agentRuntimeType: agentAdapterType,
        agentRuntimeConfig: agentAdapterConfig,
        metadata: agent.metadata ?? null,
      },
    });
    return {
      descriptor: {
        sourceType: "agent",
        sourceLabel: agent.name,
        runtimeAgentId: agent.id,
        agentRuntimeType: agentAdapterType,
        model: modelLabel(runtimeConfig) ?? "Default model",
        available: true,
        error: null,
      },
      runtimeAgent: {
        id: agent.id,
        orgId: agent.orgId,
        name: agent.name,
        agentRuntimeType: agentAdapterType,
        agentRuntimeConfig: runtimeConfig,
      },
      agentRuntimeType: agentAdapterType,
      agentRuntimeConfig: runtimeConfig,
      runtimeSkills: summarizeRuntimeSkills(runtimeSkillEntries),
    };
  }

  async function resolveOrganizationDefaultRuntime(orgId: string): Promise<ResolvedChatRuntimeSource> {
    const organization = await organizationsSvc.getById(orgId);
    if (!organization?.defaultChatAgentRuntimeType) {
      return {
        descriptor: unconfiguredDescriptor(
          "Chat is not configured. Configure Rudder Copilot in Organization Settings, or assign an agent to this conversation.",
        ),
        runtimeAgent: null,
        agentRuntimeType: null,
        agentRuntimeConfig: null,
        runtimeSkills: [],
      };
    }

    const organizationAdapterType = organization.defaultChatAgentRuntimeType as AgentRuntimeType;

    if (!ORGANIZATION_DEFAULT_CHAT_ADAPTER_TYPES.has(organizationAdapterType)) {
      return {
        descriptor: unconfiguredDescriptor(
          `${organizationAdapterType} is not available as a Rudder Copilot runtime.`,
        ),
        runtimeAgent: null,
        agentRuntimeType: null,
        agentRuntimeConfig: null,
        runtimeSkills: [],
      };
    }

    const copilot = await runContextSvc.ensureChatCopilotAgent({
      id: organization.id,
      defaultChatAgentRuntimeType: organization.defaultChatAgentRuntimeType,
      defaultChatAgentRuntimeConfig: (organization.defaultChatAgentRuntimeConfig ?? {}) as Record<string, unknown>,
    });
    if (!copilot) {
      return {
        descriptor: unconfiguredDescriptor(
          "Chat is not configured. Configure Rudder Copilot in Organization Settings, or assign an agent to this conversation.",
        ),
        runtimeAgent: null,
        agentRuntimeType: null,
        agentRuntimeConfig: null,
        runtimeSkills: [],
      };
    }

    const { runtimeConfig, runtimeSkillEntries } = await runContextSvc.prepareRuntimeConfig({
      scene: "chat",
      agent: {
        id: copilot.id,
        orgId: copilot.orgId,
        name: RUDDER_COPILOT_LABEL,
        status: copilot.status,
        agentRuntimeType: copilot.agentRuntimeType,
        agentRuntimeConfig: copilot.agentRuntimeConfig ?? {},
        metadata: copilot.metadata ?? null,
      },
    });
    return {
      descriptor: {
        sourceType: "copilot",
        sourceLabel: RUDDER_COPILOT_LABEL,
        runtimeAgentId: copilot.id,
        agentRuntimeType: organizationAdapterType,
        model: modelLabel(runtimeConfig) ?? "Default model",
        available: true,
        error: null,
      },
      runtimeAgent: {
        id: copilot.id,
        orgId: copilot.orgId,
        name: RUDDER_COPILOT_LABEL,
        agentRuntimeType: organizationAdapterType,
        agentRuntimeConfig: runtimeConfig,
      },
      agentRuntimeType: organizationAdapterType,
      agentRuntimeConfig: runtimeConfig,
      runtimeSkills: summarizeRuntimeSkills(runtimeSkillEntries),
    };
  }

  async function resolveConversationRuntime(
    conversation: Pick<ChatConversation, "orgId" | "preferredAgentId">,
  ) {
    if (conversation.preferredAgentId) {
      const agentRuntime = await resolveAgentRuntime(conversation.orgId, conversation.preferredAgentId);
      if (agentRuntime) return agentRuntime;
    }
    return resolveOrganizationDefaultRuntime(conversation.orgId);
  }

  async function enrichConversation<T extends ChatConversation>(conversation: T): Promise<T> {
    const resolved = await resolveConversationRuntime(conversation);
    return {
      ...conversation,
      chatRuntime: resolved.descriptor,
    };
  }

  async function enrichConversations<T extends ChatConversation>(conversations: T[]): Promise<T[]> {
    return Promise.all(conversations.map((conversation) => enrichConversation(conversation)));
  }

  async function streamChatAssistantReply(
    input: StreamChatAssistantReplyInput,
  ): Promise<StreamChatAssistantReplyResult> {
    const resolvedInvocation = await resolveChatInvocation({
      conversation: input.conversation,
      contextLinks: input.contextLinks,
    });
    if (resolvedInvocation.availabilityError) {
      throw new Error(resolvedInvocation.availabilityError);
    }
    const {
      runtimeSource,
      adapter,
      config,
      linkedIssueIds,
      linkedProjectId,
      sceneContext,
    } = resolvedInvocation;
    if (!adapter || !config || !sceneContext || !runtimeSource.agentRuntimeType) {
      throw new Error("Chat runtime is not configured");
    }
    const runtimeAgentType = runtimeSource.agentRuntimeType;
    const resultSentinel = `${CHAT_RESULT_SENTINEL_PREFIX}${randomUUID()}__`;
    const runId = `chat-${input.conversation.id}-${randomUUID()}`;
    const assistantTextAccumulator = createAssistantTextAccumulator();
    const sentinelStream = createSentinelStream(resultSentinel);
    let parser = adapter.parseStdoutLine;
    let stdoutLineBuffer = "";
    const { rudderWorkspace, rudderWorkspaces, rudderRuntimeServiceIntents, rudderScene } = sceneContext;
    const prompt = buildConversationPrompt(
      input,
      runtimeSource,
      resultSentinel,
      typeof rudderWorkspace.orgResourcesPrompt === "string" ? rudderWorkspace.orgResourcesPrompt : "",
    );

    const processTranscriptEntries = async (entries: TranscriptEntry[]) => {
      for (const entry of entries) {
        if (entry.kind === "assistant") {
          const delta = assistantTextAccumulator.push(entry.text, entry.delta === true);
          if (!delta) continue;
          const visibleDelta = sentinelStream.push(delta);
          if (visibleDelta) {
            const assistantTranscriptEntry: TranscriptEntry = {
              kind: "assistant",
              ts: entry.ts,
              text: visibleDelta,
              delta: true,
            };
            await maybeEmitObservedTranscriptEntry(input.onObservedTranscriptEntry, assistantTranscriptEntry);
            await maybeEmitTranscriptEntry(input.onTranscriptEntry, assistantTranscriptEntry);
          }
          continue;
        }
        if (entry.kind === "result") {
          await maybeEmitObservedTranscriptEntry(input.onObservedTranscriptEntry, {
            ...entry,
            text: partialBodyFromRawAssistantText(entry.text, resultSentinel),
          });
        } else if (!(entry.kind === "stdout" && entry.text.includes(resultSentinel))) {
          await maybeEmitObservedTranscriptEntry(input.onObservedTranscriptEntry, entry);
        }
        if (shouldSuppressChatTranscriptEntry(entry, resultSentinel)) {
          continue;
        }
        await maybeEmitTranscriptEntry(input.onTranscriptEntry, entry);
      }
    };

    const processStdoutLine = async (line: string) => {
      if (!parser || !line.trim()) return;
      await processTranscriptEntries(parser(line, new Date().toISOString()));
    };

    const flushStdoutChunk = async (chunk: string, finalize = false) => {
      const combined = `${stdoutLineBuffer}${chunk}`;
      const lines = combined.split(/\r?\n/);
      stdoutLineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        await processStdoutLine(line);
      }
      if (finalize && stdoutLineBuffer.trim()) {
        const trailing = stdoutLineBuffer;
        stdoutLineBuffer = "";
        await processStdoutLine(trailing);
      }
    };

    await maybeEmitAssistantState(input.onAssistantState, "streaming");

    const result = await executeAdapterWithModelFallbacks(adapter, {
      runId,
      agent: stubAgent({
        orgId: input.conversation.orgId,
        agentRuntimeType: runtimeAgentType,
        agentRuntimeConfig: config,
        sourceLabel: runtimeSource.descriptor.sourceLabel,
        sourceId: runtimeSource.descriptor.runtimeAgentId ?? `org-chat:${input.conversation.orgId}`,
      }),
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config,
      context: {
        chatPrompt: prompt,
        chatConversationId: input.conversation.id,
        chatMode: true,
        rudderScene,
        rudderWorkspace,
        rudderWorkspaces,
        ...(rudderRuntimeServiceIntents ? { rudderRuntimeServiceIntents } : {}),
        ...(linkedProjectId ? { projectId: linkedProjectId } : {}),
        ...(linkedIssueIds[0] ? { issueId: linkedIssueIds[0] } : {}),
        ...(linkedIssueIds.length > 0 ? { issueIds: linkedIssueIds } : {}),
      },
      onMeta: async (meta) => {
        await input.onInvocationMeta?.({
          ...meta,
          loadedSkills: runtimeSource.runtimeSkills,
        });
      },
      authToken: adapter.supportsLocalAgentJwt
        ? createLocalAgentJwt(
          runtimeSource.descriptor.runtimeAgentId ?? `org-chat:${input.conversation.orgId}`,
          input.conversation.orgId,
          runtimeAgentType,
          runId,
        ) ?? undefined
        : undefined,
      abortSignal: input.abortSignal,
      onLog: async (stream, chunk) => {
        if (stream === "stdout") {
          if (chunk.startsWith("[rudder]")) {
            const entry: TranscriptEntry = {
              kind: "stdout",
              ts: new Date().toISOString(),
              text: chunk,
            };
            await maybeEmitObservedTranscriptEntry(input.onObservedTranscriptEntry, entry);
            await maybeEmitTranscriptEntry(input.onTranscriptEntry, entry);
            return;
          }
          await flushStdoutChunk(chunk);
        }
      },
    }, {
      resolveAdapter: findServerAdapter,
      createAuthToken: (agentRuntimeType) =>
        createLocalAgentJwt(
          runtimeSource.descriptor.runtimeAgentId ?? `org-chat:${input.conversation.orgId}`,
          input.conversation.orgId,
          agentRuntimeType,
          runId,
        ) ?? undefined,
      onAttemptStart: (_attempt, attemptAdapter) => {
        parser = attemptAdapter.parseStdoutLine;
      },
    });

    await flushStdoutChunk("", true);
    await maybeEmitAssistantDelta(input.onAssistantDelta, sentinelStream.finish());

    const partialBody =
      partialBodyFromRawAssistantText(
        assistantTextAccumulator.fullText || resultText(result),
        resultSentinel,
      ) ||
      (safeTrim(sentinelStream.visibleText) ?? "");

    if (input.abortSignal?.aborted) {
      await maybeEmitAssistantState(input.onAssistantState, "stopped");
      return {
        outcome: "stopped",
        partialBody,
        replyingAgentId: runtimeSource.descriptor.runtimeAgentId,
      };
    }

    if (result.timedOut) {
      throw new ChatAssistantStreamError("Chat request timed out", partialBody);
    }
    if ((result.exitCode ?? 0) !== 0 || result.errorMessage) {
      throw new ChatAssistantStreamError(result.errorMessage ?? "Chat adapter execution failed", partialBody);
    }

    await maybeEmitAssistantState(input.onAssistantState, "finalizing");

    const raw = resultText(result) || assistantTextAccumulator.fullText;
    const runtimeQuestionReply = input.conversation.planMode
      ? assistantResultFromRuntimeQuestion(result)
      : null;
    const reply = runtimeQuestionReply ?? parseCompletedAssistantReply(raw, resultSentinel);
    if (reply.kind === "user_input_request" && !input.conversation.planMode) {
      throw new Error("request_user_input is only available in plan mode");
    }
    const finalBody = reply.body;
    reply.replyingAgentId = runtimeSource.descriptor.runtimeAgentId;

    const streamedBody = safeTrim(sentinelStream.visibleText) ?? "";
    if (finalBody && finalBody !== streamedBody) {
      await maybeEmitAssistantDelta(input.onAssistantDelta, finalBody);
    }

    return {
      outcome: "completed",
      reply,
      partialBody: finalBody,
      replyingAgentId: runtimeSource.descriptor.runtimeAgentId,
    };
  }

  return {
    enrichConversation,
    enrichConversations,
    getChatAssistantAvailability: async (conversation: ChatConversation) => {
      const resolved = await resolveChatInvocation({
        conversation,
        contextLinks: Array.isArray(conversation.contextLinks) ? conversation.contextLinks : [],
      });
      return resolved.runtimeSource.descriptor.available && !resolved.availabilityError
        ? {
          ...resolved.runtimeSource.descriptor,
          available: true as const,
        }
        : {
          ...resolved.runtimeSource.descriptor,
          available: false as const,
          error: resolved.availabilityError ?? resolved.runtimeSource.descriptor.error,
        };
    },
    generateChatAssistantReply: async (
      input: GenerateChatAssistantReplyInput,
    ): Promise<ChatAssistantResult> => {
      const result = await streamChatAssistantReply(input);
      if (result.outcome !== "completed") {
        throw new Error("Chat assistant reply was stopped before completion");
      }
      return result.reply;
    },
    streamChatAssistantReply,
  };
}
