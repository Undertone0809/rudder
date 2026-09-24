import type {
  AgentRuntimeApprovalHandle,
  AgentRuntimeApprovalRequest,
  AgentRuntimeApprovalDecision,
} from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import {
  approvals,
  chatConversations,
  heartbeatRunAttempts,
  heartbeatRuns,
  runRuntimeSpans,
} from "@rudderhq/db";
import {
  chatAskUserRequestSchema,
  type ChatAskUserRequest,
} from "@rudderhq/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { conflict, notFound, unprocessable } from "../../errors.js";
import { assertRunIntelligenceAccess } from "../run-intelligence-access.js";

const APPROVAL_POLL_INTERVAL_MS = 500;
const APPROVAL_MAX_WAIT_MS = 30 * 60_000;
const RUNTIME_APPROVAL_TYPES = ["pending", "revision_requested"] as const;
const RUNTIME_APPROVAL_TERMINAL_TYPES = ["approved", "rejected", "cancelled"] as const;

export type RuntimeApprovalInputResponse = {
  answers: Array<{
    questionId: string;
    optionIds: string[];
    freeformText?: string;
  }>;
};

export type RuntimeApprovalFence = {
  spanId: string | null;
  ownerToken: string | null;
  attemptEpoch: number | null;
  attemptId: string | null;
  attemptIndex: number | null;
};

type ValidRuntimeApprovalFence = {
  spanId: string;
  ownerToken: string;
  attemptEpoch: number;
  attemptId: string;
  attemptIndex: number;
};

export type RuntimeApprovalExecution = {
  runId: string;
  orgId: string;
  agentId: string;
  runtimeType: string;
  chatConversationId?: string | null;
  scene?: "chat" | "side_chat" | null;
  getFence: () => RuntimeApprovalFence;
  abortSignal?: AbortSignal;
};

export type RuntimeApprovalEvent = {
  eventType: "approval.requested" | "approval.cancelled";
  payload: {
    approvalId: string;
    type: "agent_runtime";
    requestId: string;
    runId: string;
    attemptId: string;
    attemptIndex: number;
    attemptEpoch: number;
    spanId: string;
    reason?: string;
  };
  idempotencyKey: string;
};

export type RuntimeApprovalRecord = {
  id: string;
  orgId: string;
  type: string;
  requestedByAgentId: string | null;
  status: string;
  payload: Record<string, unknown>;
  decisionNote?: string | null;
};

type RuntimeApprovalService = {
  // Kept in the service contract for callers that expose the regular approval
  // service. Runtime approvals are inserted through the transaction below so
  // the idempotency recheck and insert share one advisory lock.
  create: (
    orgId: string,
    data: Omit<typeof approvals.$inferInsert, "orgId">,
  ) => Promise<RuntimeApprovalRecord>;
  getById: (id: string) => Promise<RuntimeApprovalRecord | null>;
};

type RuntimeApprovalBridgeOptions = {
  db: Db;
  approvals: RuntimeApprovalService;
  execution: RuntimeApprovalExecution;
  onEvent?: (event: RuntimeApprovalEvent) => Promise<void>;
  onQuestionCreated?: (input: {
    approval: RuntimeApprovalRecord;
    inputRequest: ChatAskUserRequest;
  }) => Promise<void>;
  pollIntervalMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

type RuntimeApprovalPayload = Record<string, unknown> & {
  approvalId: string;
  runId: string;
  orgId: string;
  agentId: string;
  runtimeType: string;
  chatConversationId: string | null;
  scene: "chat" | "side_chat" | null;
  attemptId: string;
  attemptIndex: number;
  attemptEpoch: number;
  spanId: string;
  requestId: string;
  inputRequest?: ChatAskUserRequest;
  inputResponse?: RuntimeApprovalInputResponse;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown, maxLength = 256) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

function validIdentifier(value: unknown) {
  const candidate = nonEmptyString(value, 64);
  return candidate && /^[a-zA-Z0-9_-]+$/.test(candidate) ? candidate : null;
}

function requestScopedIdentifier(prefix: string, requestId: string, index: number) {
  const requestPart = requestId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "request";
  return `${prefix}-${requestPart}-${index}-${randomUUID().replace(/-/g, "").slice(0, 10)}`.slice(0, 64);
}

function normalizeAskUserRequest(raw: unknown, requestId: string): ChatAskUserRequest | null {
  const record = asRecord(raw);
  const rawQuestions = record?.questions;
  if (!Array.isArray(rawQuestions)) return null;

  const normalizedQuestions = rawQuestions.map((rawQuestion, questionIndex) => {
    const question = asRecord(rawQuestion) ?? {};
    const rawOptions = Array.isArray(question.options) ? question.options : [];
    const normalizedOptions = rawOptions.map((rawOption, optionIndex) => {
      const option = asRecord(rawOption) ?? {};
      const id = validIdentifier(option.id) ?? (
        option.id === undefined || option.id === null
          ? requestScopedIdentifier(`option-${questionIndex}`, requestId, optionIndex)
          : option.id
      );
      return {
        id,
        label: option.label,
        ...(option.description !== undefined ? { description: option.description } : {}),
        ...(option.recommended !== undefined ? { recommended: option.recommended } : {}),
      };
    });
    const id = validIdentifier(question.id) ?? (
      question.id === undefined || question.id === null
        ? requestScopedIdentifier("question", requestId, questionIndex)
        : question.id
    );
    return {
      id,
      ...(question.header !== undefined ? { header: question.header } : {}),
      question: question.question,
      options: normalizedOptions,
      ...(question.selectionMode !== undefined ? { selectionMode: question.selectionMode } : {}),
      ...(question.allowFreeform !== undefined ? { allowFreeform: question.allowFreeform } : {}),
    };
  });

  const parsed = chatAskUserRequestSchema.safeParse({ questions: normalizedQuestions });
  return parsed.success ? parsed.data : null;
}

function inputRequestFromRuntimeRequest(
  request: AgentRuntimeApprovalRequest,
  requestId: string,
) {
  const inputRequest = (request as unknown as { inputRequest?: unknown }).inputRequest
    ?? asRecord(request.payload)?.inputRequest;
  return inputRequest === undefined ? null : normalizeAskUserRequest(inputRequest, requestId);
}

function requestIdFromRuntimeRequest(request: AgentRuntimeApprovalRequest) {
  const payload = asRecord(request.payload) ?? {};
  const event = asRecord(payload.event);
  return nonEmptyString(
    payload.requestId
      ?? payload.providerRequestId
      ?? payload.controlRequestId
      ?? payload.request_id
      ?? event?.requestId
      ?? event?.request_id,
  ) ?? randomUUID();
}

function safeRuntimePayloadFields(request: AgentRuntimeApprovalRequest) {
  const payload = asRecord(request.payload) ?? {};
  const safe: Record<string, unknown> = {};
  for (const key of ["provider", "toolName", "sessionId", "providerRequestId", "controlRequestId"]) {
    const value = nonEmptyString(payload[key]);
    if (value) safe[key] = value;
  }
  if (Array.isArray(payload.choices)) {
    const choices = payload.choices
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .slice(0, 8);
    if (choices.length > 0) safe.choices = choices;
  }
  return safe;
}

function bindingFromPayload(payload: Record<string, unknown>): RuntimeApprovalPayload | null {
  const runId = nonEmptyString(payload.runId);
  const orgId = nonEmptyString(payload.orgId);
  const agentId = nonEmptyString(payload.agentId);
  const runtimeType = nonEmptyString(payload.runtimeType);
  const requestId = nonEmptyString(payload.requestId);
  const chatConversationId = payload.chatConversationId === null
    ? null
    : nonEmptyString(payload.chatConversationId);
  const scene = payload.scene === "chat" || payload.scene === "side_chat" ? payload.scene : null;
  const attemptId = nonEmptyString(payload.attemptId);
  const spanId = nonEmptyString(payload.spanId);
  const attemptIndex = Number(payload.attemptIndex);
  const attemptEpoch = Number(payload.attemptEpoch);
  const approvalId = nonEmptyString(payload.approvalId);
  if (
    !runId || !orgId || !agentId || !runtimeType || !requestId || !attemptId || !spanId || !approvalId
    || !Number.isInteger(attemptIndex) || attemptIndex < 0
    || typeof attemptEpoch !== "number" || !Number.isInteger(attemptEpoch) || attemptEpoch <= 0
  ) return null;
  return {
    ...payload,
    approvalId,
    runId,
    orgId,
    agentId,
    runtimeType,
    chatConversationId,
    scene,
    attemptId,
    attemptIndex,
    attemptEpoch,
    spanId,
    requestId,
  };
}

function currentFenceForExecution(execution: RuntimeApprovalExecution): ValidRuntimeApprovalFence | null {
  const fence = execution.getFence();
  const { spanId, ownerToken, attemptEpoch, attemptId, attemptIndex } = fence;
  if (
    typeof spanId !== "string" || spanId.trim().length === 0
    || typeof ownerToken !== "string" || ownerToken.trim().length === 0
    || typeof attemptEpoch !== "number" || !Number.isInteger(attemptEpoch) || attemptEpoch <= 0
    || typeof attemptId !== "string" || attemptId.trim().length === 0
    || typeof attemptIndex !== "number" || !Number.isInteger(attemptIndex) || attemptIndex < 0
  ) return null;
  return {
    spanId,
    ownerToken,
    attemptEpoch,
    attemptId,
    attemptIndex,
  };
}

function terminalDecision(
  approvalId: string,
  status: "approved" | "rejected" | "cancelled",
  decisionNote?: string | null,
  inputResponse?: RuntimeApprovalInputResponse,
): AgentRuntimeApprovalDecision & { inputResponse?: RuntimeApprovalInputResponse } {
  return {
    id: approvalId,
    status,
    decisionNote: decisionNote ?? null,
    ...(inputResponse ? { inputResponse } : {}),
  };
}

function pendingDecision(approvalId: string): AgentRuntimeApprovalDecision {
  return { id: approvalId, status: "pending", decisionNote: null };
}

export function validateRuntimeApprovalInputResponse(
  inputRequest: unknown,
  inputResponse: unknown,
): RuntimeApprovalInputResponse {
  const parsedRequest = chatAskUserRequestSchema.safeParse(inputRequest);
  if (!parsedRequest.success) throw unprocessable("Runtime approval input request is invalid");
  const responseRecord = asRecord(inputResponse);
  const rawAnswers = responseRecord?.answers;
  if (!Array.isArray(rawAnswers)) throw unprocessable("Runtime approval input response must contain answers");

  const answers = rawAnswers.map((rawAnswer) => {
    const answer = asRecord(rawAnswer);
    const questionId = validIdentifier(answer?.questionId);
    const optionIds = Array.isArray(answer?.optionIds)
      ? answer.optionIds.map((value) => validIdentifier(value)).filter((value): value is string => Boolean(value))
      : null;
    const freeformText = answer?.freeformText === undefined
      ? undefined
      : nonEmptyString(answer.freeformText, 4_000);
    if (!questionId || !optionIds || optionIds.length !== new Set(optionIds).size) {
      throw unprocessable("Runtime approval input response contains an invalid answer");
    }
    if (answer?.freeformText !== undefined && !freeformText) {
      throw unprocessable("Runtime approval freeform answer must not be blank");
    }
    return {
      questionId,
      optionIds,
      ...(freeformText ? { freeformText } : {}),
    };
  });

  const requestQuestions = parsedRequest.data.questions;
  if (answers.length !== requestQuestions.length) {
    throw unprocessable("Runtime approval input response must answer every question exactly once");
  }
  const answerByQuestionId = new Map(answers.map((answer) => [answer.questionId, answer]));
  if (answerByQuestionId.size !== answers.length) {
    throw unprocessable("Runtime approval input response contains duplicate questions");
  }

  return {
    answers: requestQuestions.map((question) => {
      const answer = answerByQuestionId.get(question.id);
      if (!answer) throw unprocessable("Runtime approval input response contains an unknown question");
      const allowedOptionIds = new Set(question.options.map((option) => option.id));
      if (answer.optionIds.some((optionId) => !allowedOptionIds.has(optionId))) {
        throw unprocessable("Runtime approval input response contains an unknown option");
      }
      const maximumOptions = question.selectionMode === "multiple" ? question.options.length : 1;
      if (answer.optionIds.length > maximumOptions) {
        throw unprocessable("Runtime approval input response selected too many options");
      }
      if (answer.freeformText && question.allowFreeform !== true) {
        throw unprocessable("Runtime approval freeform answer is not allowed for this question");
      }
      if (answer.optionIds.length === 0 && !answer.freeformText) {
        throw unprocessable("Runtime approval input response must select an option or provide freeform text");
      }
      return answer;
    }),
  };
}

async function readCurrentExecution(
  db: Db,
  execution: RuntimeApprovalExecution,
  fence: ValidRuntimeApprovalFence,
) {
  const run = await db
    .select({
      id: heartbeatRuns.id,
      orgId: heartbeatRuns.orgId,
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
      chatConversationId: heartbeatRuns.chatConversationId,
      executionOwnerToken: heartbeatRuns.executionOwnerToken,
      executionLeaseExpiresAt: heartbeatRuns.executionLeaseExpiresAt,
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.id, execution.runId),
      eq(heartbeatRuns.orgId, execution.orgId),
      eq(heartbeatRuns.agentId, execution.agentId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (
    !run
    || run.status !== "running"
    || run.chatConversationId !== (execution.chatConversationId ?? run.chatConversationId)
    || run.executionOwnerToken !== fence.ownerToken
    || (run.executionLeaseExpiresAt && run.executionLeaseExpiresAt.getTime() <= Date.now())
  ) return false;

  const attempt = await db
    .select({
      id: heartbeatRunAttempts.id,
      attemptIndex: heartbeatRunAttempts.attemptIndex,
      status: heartbeatRunAttempts.status,
      ownerToken: heartbeatRunAttempts.ownerToken,
      attemptEpoch: heartbeatRunAttempts.attemptEpoch,
    })
    .from(heartbeatRunAttempts)
    .where(and(
      eq(heartbeatRunAttempts.id, fence.attemptId),
      eq(heartbeatRunAttempts.orgId, execution.orgId),
      eq(heartbeatRunAttempts.runId, execution.runId),
      eq(heartbeatRunAttempts.agentId, execution.agentId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (
    !attempt
    || attempt.status !== "started"
    || attempt.attemptIndex !== fence.attemptIndex
    || attempt.ownerToken !== fence.ownerToken
    || attempt.attemptEpoch !== fence.attemptEpoch
  ) return false;

  const span = await db
    .select({
      id: runRuntimeSpans.id,
      ownerToken: runRuntimeSpans.ownerToken,
      attemptEpoch: runRuntimeSpans.attemptEpoch,
      attemptId: runRuntimeSpans.attemptId,
      state: runRuntimeSpans.state,
    })
    .from(runRuntimeSpans)
    .where(and(
      eq(runRuntimeSpans.id, fence.spanId),
      eq(runRuntimeSpans.orgId, execution.orgId),
      eq(runRuntimeSpans.runId, execution.runId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return Boolean(
    span
    && span.state === "open"
    && span.ownerToken === fence.ownerToken
    && span.attemptEpoch === fence.attemptEpoch
    && span.attemptId === fence.attemptId,
  );
}

async function defaultSleep(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function cancelPendingRuntimeApproval(
  db: Db,
  approval: RuntimeApprovalRecord,
  execution: RuntimeApprovalExecution,
  reason: string,
) {
  const payload = bindingFromPayload(approval.payload);
  if (
    !payload
    || approval.type !== "agent_runtime"
    || approval.id !== payload.approvalId
    || payload.orgId !== execution.orgId
    || payload.runId !== execution.runId
    || payload.agentId !== execution.agentId
    || (execution.chatConversationId !== undefined
      && payload.chatConversationId !== (execution.chatConversationId ?? null))
    || (execution.scene !== undefined && payload.scene !== (execution.scene ?? null))
  ) return null;
  const now = new Date();
  return db
    .update(approvals)
    .set({
      status: "cancelled",
      decisionNote: reason,
      decidedByUserId: null,
      decidedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(approvals.id, approval.id),
      eq(approvals.orgId, execution.orgId),
      eq(approvals.type, "agent_runtime"),
      eq(approvals.requestedByAgentId, execution.agentId),
      sql`${approvals.payload}->>'orgId' = ${execution.orgId}`,
      sql`${approvals.payload}->>'runId' = ${execution.runId}`,
      sql`${approvals.payload}->>'agentId' = ${execution.agentId}`,
      sql`${approvals.payload}->>'spanId' = ${payload.spanId}`,
      sql`${approvals.payload}->>'attemptId' = ${payload.attemptId}`,
      sql`${approvals.payload}->>'attemptIndex' = ${String(payload.attemptIndex)}`,
      sql`${approvals.payload}->>'attemptEpoch' = ${String(payload.attemptEpoch)}`,
      sql`${approvals.payload}->>'requestId' = ${payload.requestId}`,
      inArray(approvals.status, [...RUNTIME_APPROVAL_TYPES]),
    ))
    .returning()
    .then((rows) => rows[0] ?? null);
}

function runtimeApprovalPayload(
  execution: RuntimeApprovalExecution,
  request: AgentRuntimeApprovalRequest,
  fence: ValidRuntimeApprovalFence,
  requestId: string,
  approvalId: string,
  inputRequest: ChatAskUserRequest | null,
): RuntimeApprovalPayload {
  return {
    ...safeRuntimePayloadFields(request),
    approvalId,
    runId: execution.runId,
    orgId: execution.orgId,
    agentId: execution.agentId,
    runtimeType: execution.runtimeType,
    chatConversationId: execution.chatConversationId ?? null,
    scene: execution.scene ?? null,
    attemptId: fence.attemptId,
    attemptIndex: fence.attemptIndex,
    attemptEpoch: fence.attemptEpoch,
    spanId: fence.spanId,
    requestId,
    ...(inputRequest ? { inputRequest } : {}),
  };
}

async function findExistingRuntimeApproval(
  db: Db,
  execution: RuntimeApprovalExecution,
  requestId: string,
  attemptId: string,
) {
  return db
    .select()
    .from(approvals)
    .where(and(
      eq(approvals.orgId, execution.orgId),
      eq(approvals.type, "agent_runtime"),
      sql`${approvals.payload}->>'runId' = ${execution.runId}`,
      sql`${approvals.payload}->>'requestId' = ${requestId}`,
      sql`${approvals.payload}->>'attemptId' = ${attemptId}`,
    ))
    .orderBy(desc(approvals.createdAt), desc(approvals.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

function runtimeApprovalBindingMatchesExecution(
  approval: RuntimeApprovalRecord,
  execution: RuntimeApprovalExecution,
  fence: ValidRuntimeApprovalFence,
) {
  const payload = bindingFromPayload(approval.payload);
  return Boolean(
    payload
    && approval.type === "agent_runtime"
    && approval.id === payload.approvalId
    && payload.orgId === execution.orgId
    && payload.runId === execution.runId
    && payload.agentId === execution.agentId
    && payload.spanId === fence.spanId
    && payload.attemptId === fence.attemptId
    && payload.attemptIndex === fence.attemptIndex
    && payload.attemptEpoch === fence.attemptEpoch
    && (execution.chatConversationId === undefined
      || payload.chatConversationId === (execution.chatConversationId ?? null))
    && (execution.scene === undefined || payload.scene === (execution.scene ?? null))
  );
}

async function createOrFindRuntimeApproval(
  options: RuntimeApprovalBridgeOptions,
  request: AgentRuntimeApprovalRequest,
  requestId: string,
  inputRequest: ChatAskUserRequest | null,
  initialFence: ValidRuntimeApprovalFence,
): Promise<{ approval: RuntimeApprovalRecord | null; created: boolean; stale: boolean }> {
  const approvalId = randomUUID();
  const payload = runtimeApprovalPayload(
    options.execution,
    request,
    initialFence,
    requestId,
    approvalId,
    inputRequest,
  );
  return options.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`runtime-approval:${options.execution.orgId}:${options.execution.runId}:${initialFence.attemptId}:${requestId}`}, 0))`);
    const txDb = tx as unknown as Db;
    const fence = currentFenceForExecution(options.execution);
    if (
      !fence
      || !runtimeApprovalBindingMatchesExecution(
        { id: approvalId, orgId: options.execution.orgId, type: "agent_runtime", requestedByAgentId: options.execution.agentId, status: "pending", payload },
        options.execution,
        fence,
      )
      || fence.spanId !== initialFence.spanId
      || fence.attemptId !== initialFence.attemptId
      || fence.attemptIndex !== initialFence.attemptIndex
      || fence.attemptEpoch !== initialFence.attemptEpoch
      || !(await readCurrentExecution(txDb, options.execution, fence))
    ) return { approval: null, created: false, stale: true };

    const existing = await findExistingRuntimeApproval(
      txDb,
      options.execution,
      requestId,
      fence.attemptId,
    );
    if (existing) return { approval: existing, created: false, stale: false };

    const [created] = await txDb
      .insert(approvals)
      .values({
        id: approvalId,
        orgId: options.execution.orgId,
        type: "agent_runtime",
        requestedByAgentId: options.execution.agentId,
        requestedByUserId: null,
        status: "pending",
        payload,
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: new Date(),
      })
      .returning();
    return { approval: created ?? null, created: Boolean(created), stale: false };
  });
}

async function currentApprovalRecord(
  options: RuntimeApprovalBridgeOptions,
  approvalId: string,
  fence: ValidRuntimeApprovalFence,
) {
  const approval = await options.approvals.getById(approvalId);
  if (!approval || approval.type !== "agent_runtime") return { approval: null, current: false };
  return {
    approval,
    current: runtimeApprovalBindingMatchesExecution(approval, options.execution, fence),
  };
}

async function cancelApprovalIfOwned(
  options: RuntimeApprovalBridgeOptions,
  approval: RuntimeApprovalRecord | null,
  reason: string,
) {
  if (!approval) return null;
  return cancelPendingRuntimeApproval(options.db, approval, options.execution, reason);
}

async function emitCancellation(
  options: RuntimeApprovalBridgeOptions,
  approvalId: string,
  cancelled: RuntimeApprovalRecord | null,
  reason: string,
) {
  if (!cancelled || !options.onEvent) return;
  const payload = bindingFromPayload(cancelled.payload);
  if (!payload) return;
  await options.onEvent({
    eventType: "approval.cancelled",
    idempotencyKey: `approval-cancelled:${approvalId}`,
    payload: {
      approvalId,
      type: "agent_runtime",
      requestId: payload.requestId,
      runId: payload.runId,
      attemptId: payload.attemptId,
      attemptIndex: payload.attemptIndex,
      attemptEpoch: payload.attemptEpoch,
      spanId: payload.spanId,
      reason,
    },
  });
}

export function createRuntimeApprovalBridge(options: RuntimeApprovalBridgeOptions) {
  const pollIntervalMs = Math.max(1, Math.min(options.pollIntervalMs ?? APPROVAL_POLL_INTERVAL_MS, 5_000));
  const sleep = options.sleep ?? defaultSleep;

  const requestApproval = async (
    request: AgentRuntimeApprovalRequest,
  ): Promise<AgentRuntimeApprovalHandle> => {
    if (request.type !== "agent_runtime") throw unprocessable("Unsupported runtime approval type");
    const fence = currentFenceForExecution(options.execution);
    if (!fence || !(await readCurrentExecution(options.db, options.execution, fence))) {
      return { id: randomUUID(), status: "cancelled" };
    }
    const requestId = requestIdFromRuntimeRequest(request);
    const inputRequest = inputRequestFromRuntimeRequest(request, requestId);
    if ((request as unknown as { inputRequest?: unknown }).inputRequest !== undefined && !inputRequest) {
      throw unprocessable("Runtime approval input request is invalid");
    }
    const result = await createOrFindRuntimeApproval(
      options,
      request,
      requestId,
      inputRequest,
      fence,
    );
    if (result.stale || !result.approval) {
      return { id: randomUUID(), status: "cancelled" };
    }
    const approval = result.approval;
    if (!result.created) {
      const existingPayload = bindingFromPayload(approval.payload);
      if (!existingPayload || !runtimeApprovalBindingMatchesExecution(approval, options.execution, fence)) {
        return { id: approval.id, status: "cancelled" };
      }
      if (inputRequest && JSON.stringify(existingPayload.inputRequest) !== JSON.stringify(inputRequest)) {
        throw conflict("Runtime approval request was reused with different input");
      }
      if (inputRequest && options.onQuestionCreated) {
        await options.onQuestionCreated({ approval, inputRequest });
      }
      return {
        id: approval.id,
        status: approval.status === "approved"
          ? "approved"
          : approval.status === "rejected"
            ? "rejected"
            : approval.status === "cancelled"
              ? "cancelled"
              : "pending",
      };
    }
    if (options.onEvent) {
      await options.onEvent({
        eventType: "approval.requested",
        idempotencyKey: `approval-requested:${approval.id}`,
        payload: {
          approvalId: approval.id,
          type: "agent_runtime",
          requestId,
          runId: options.execution.runId,
          attemptId: fence.attemptId,
          attemptIndex: fence.attemptIndex,
          attemptEpoch: fence.attemptEpoch,
          spanId: fence.spanId,
        },
      });
    }
    if (inputRequest && options.onQuestionCreated) {
      await options.onQuestionCreated({ approval, inputRequest });
    }
    return { id: approval.id, status: "pending" };
  };

  const waitForApproval = async (
    approvalId: string,
    timeoutMs: number,
  ): Promise<AgentRuntimeApprovalDecision & { inputResponse?: RuntimeApprovalInputResponse }> => {
    const deadline = Date.now() + Math.max(1_000, Math.min(timeoutMs, APPROVAL_MAX_WAIT_MS));
    while (Date.now() < deadline) {
      const fence = currentFenceForExecution(options.execution);
      if (options.execution.abortSignal?.aborted || !fence || !(await readCurrentExecution(options.db, options.execution, fence))) {
        const staleApproval = await options.approvals.getById(approvalId);
        const cancelled = await cancelApprovalIfOwned(
          options,
          staleApproval,
          "Runtime approval request is no longer current",
        );
        await emitCancellation(options, approvalId, cancelled, "stale_or_aborted");
        return terminalDecision(approvalId, "cancelled", "Runtime approval request is no longer current");
      }
      const current = await currentApprovalRecord(options, approvalId, fence);
      if (!current.approval) {
        return terminalDecision(approvalId, "cancelled", "Runtime approval request was not found");
      }
      const approval = current.approval;
      if (!current.current) {
        // A mismatched binding is never cancelled: the id may refer to a
        // different run or attempt, and this waiter must not mutate it.
        return terminalDecision(approvalId, "cancelled", "Runtime approval request is not bound to this execution");
      }
      if (approval.status === "approved") {
        const payload = bindingFromPayload(approval.payload);
        const inputRequest = payload?.inputRequest;
        const rawResponse = payload?.inputResponse;
        let inputResponse: RuntimeApprovalInputResponse | undefined;
        try {
          inputResponse = inputRequest && rawResponse
            ? validateRuntimeApprovalInputResponse(inputRequest, rawResponse)
            : undefined;
        } catch {
          return terminalDecision(approvalId, "cancelled", "Runtime approval response was missing or invalid");
        }
        if (inputRequest && !inputResponse) {
          return terminalDecision(approvalId, "cancelled", "Runtime approval response was missing or invalid");
        }
        const latestFence = currentFenceForExecution(options.execution);
        if (
          !latestFence
          || !(await readCurrentExecution(options.db, options.execution, latestFence))
          || !runtimeApprovalBindingMatchesExecution(approval, options.execution, latestFence)
        ) {
          const cancelled = await cancelApprovalIfOwned(
            options,
            approval,
            "Runtime approval request is no longer current",
          );
          await emitCancellation(options, approvalId, cancelled, "stale_or_aborted");
          return terminalDecision(approvalId, "cancelled", "Runtime approval request is no longer current");
        }
        return terminalDecision(approvalId, "approved", approval.decisionNote, inputResponse);
      }
      if (approval.status === "rejected" || approval.status === "cancelled") {
        const latestFence = currentFenceForExecution(options.execution);
        if (
          !latestFence
          || !(await readCurrentExecution(options.db, options.execution, latestFence))
          || !runtimeApprovalBindingMatchesExecution(approval, options.execution, latestFence)
        ) {
          return terminalDecision(approvalId, "cancelled", "Runtime approval request is no longer current");
        }
        return terminalDecision(approvalId, approval.status, approval.decisionNote);
      }
      await sleep(pollIntervalMs, options.execution.abortSignal);
    }
    return pendingDecision(approvalId);
  };

  return { requestApproval, waitForApproval };
}

export async function isRuntimeApprovalVisible(
  db: Db,
  approval: RuntimeApprovalRecord,
  scope: { sideChatOwnerId?: string | null } = {},
) {
  if (approval.type !== "agent_runtime") return true;
  const payload = bindingFromPayload(approval.payload);
  if (!payload || payload.orgId !== approval.orgId || approval.requestedByAgentId !== payload.agentId) return false;
  const run = await db
    .select()
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.id, payload.runId),
      eq(heartbeatRuns.orgId, approval.orgId),
      eq(heartbeatRuns.agentId, payload.agentId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!run) return false;
  if (payload.chatConversationId !== null && run.chatConversationId !== payload.chatConversationId) return false;
  try {
    await assertRunIntelligenceAccess(db, run, scope);
  } catch {
    return false;
  }
  return true;
}

export async function filterRuntimeApprovalsForVisibility(
  db: Db,
  approvalRows: RuntimeApprovalRecord[],
  scope: { sideChatOwnerId?: string | null } = {},
) {
  const visible: RuntimeApprovalRecord[] = [];
  for (const approval of approvalRows) {
    if (await isRuntimeApprovalVisible(db, approval, scope)) visible.push(approval);
  }
  return visible;
}

export async function assertRuntimeApprovalVisible(
  db: Db,
  approval: RuntimeApprovalRecord,
  scope: { sideChatOwnerId?: string | null } = {},
) {
  if (!(await isRuntimeApprovalVisible(db, approval, scope))) {
    throw notFound("Approval not found");
  }
}

export async function assertRuntimeApprovalCurrent(
  db: Db,
  approval: RuntimeApprovalRecord,
) {
  const payload = bindingFromPayload(approval.payload);
  if (
    approval.type !== "agent_runtime"
    || approval.id !== payload?.approvalId
    || approval.orgId !== payload?.orgId
    || approval.requestedByAgentId !== payload?.agentId
    || !payload
  ) throw conflict("Runtime approval request is no longer current");
  const execution: RuntimeApprovalExecution = {
    runId: payload.runId,
    orgId: payload.orgId,
    agentId: payload.agentId,
    runtimeType: payload.runtimeType,
    chatConversationId: payload.chatConversationId,
    scene: payload.scene,
    getFence: () => ({
      spanId: payload.spanId,
      ownerToken: null,
      attemptEpoch: payload.attemptEpoch,
      attemptId: payload.attemptId,
      attemptIndex: payload.attemptIndex,
    }),
  };
  const run = await db
    .select({ executionOwnerToken: heartbeatRuns.executionOwnerToken })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, payload.runId), eq(heartbeatRuns.orgId, payload.orgId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const attempt = await db
    .select({ ownerToken: heartbeatRunAttempts.ownerToken })
    .from(heartbeatRunAttempts)
    .where(and(eq(heartbeatRunAttempts.id, payload.attemptId), eq(heartbeatRunAttempts.orgId, payload.orgId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!run?.executionOwnerToken || !attempt?.ownerToken) throw conflict("Runtime approval request is no longer current");
  execution.getFence = () => ({
    spanId: payload.spanId,
    ownerToken: run.executionOwnerToken,
    attemptEpoch: payload.attemptEpoch,
    attemptId: payload.attemptId,
    attemptIndex: payload.attemptIndex,
  });
  if (attempt.ownerToken !== run.executionOwnerToken) throw conflict("Runtime approval request is no longer current");
  const fence: ValidRuntimeApprovalFence = {
    spanId: payload.spanId,
    ownerToken: run.executionOwnerToken,
    attemptEpoch: payload.attemptEpoch,
    attemptId: payload.attemptId,
    attemptIndex: payload.attemptIndex,
  };
  if (!(await readCurrentExecution(db, execution, fence))) {
    throw conflict("Runtime approval request is no longer current");
  }
}

export function runtimeApprovalPayloadForDecision(
  approval: RuntimeApprovalRecord,
  payloadOverride: Record<string, unknown> | undefined,
) {
  if (!payloadOverride) {
    if (approval.type === "agent_runtime" && approval.payload.inputRequest) {
      throw unprocessable("This runtime approval requires a structured input response");
    }
    return approval.payload;
  }
  if (approval.type !== "agent_runtime") return payloadOverride;
  const keys = Object.keys(payloadOverride);
  if (keys.some((key) => key !== "inputResponse")) {
    throw unprocessable("Runtime approval binding cannot be changed");
  }
  const inputRequest = approval.payload.inputRequest;
  if (!inputRequest) throw unprocessable("This runtime approval does not accept structured input");
  const inputResponse = validateRuntimeApprovalInputResponse(inputRequest, payloadOverride.inputResponse);
  return {
    ...approval.payload,
    inputResponse,
  } satisfies Record<string, unknown>;
}

export function isRuntimeApprovalStatus(value: string): value is (typeof RUNTIME_APPROVAL_TERMINAL_TYPES)[number] {
  return (RUNTIME_APPROVAL_TERMINAL_TYPES as readonly string[]).includes(value);
}

export { normalizeAskUserRequest };
