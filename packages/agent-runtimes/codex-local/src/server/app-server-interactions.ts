import type { AgentRuntimeExecutionContext } from "@rudderhq/agent-runtime-utils";
import type { ChatAskUserRequest, ChatAskUserResponse } from "@rudderhq/shared";
import type {
  CodexAppServerServerRequestContext,
  CodexAppServerServerRequestHandler,
} from "./app-server-client.js";

type RequestApproval = NonNullable<AgentRuntimeExecutionContext["requestApproval"]>;
type WaitForApproval = NonNullable<AgentRuntimeExecutionContext["waitForApproval"]>;
type ApprovalDecision = Awaited<ReturnType<WaitForApproval>>;
type JsonRecord = Record<string, unknown>;

const APPROVAL_TIMEOUT_MS = 30 * 60_000;

export interface CodexAppServerInteractionOptions {
  bypassApprovalsAndSandbox: boolean;
  getSessionId?: () => string | null;
  getTurnId?: () => string | null;
  requestApproval?: RequestApproval;
  waitForApproval?: WaitForApproval;
}

type QuestionBinding = {
  providerQuestionId: string;
  optionLabels: Map<string, string>;
  allowFreeform: boolean;
};

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function boundedText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Codex App Server request was cancelled");
}

function awaitBeforeAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then((value) => {
      cleanup();
      resolve(value);
    }, (error: unknown) => {
      cleanup();
      reject(error);
    });
  });
}

function providerPayload(
  request: CodexAppServerServerRequestContext,
  options: CodexAppServerInteractionOptions,
  interactionKind: "permission" | "question",
  choices: string[],
): JsonRecord {
  const params = asRecord(request.params) ?? {};
  const requestId = String(request.id);
  const payload: JsonRecord = {
    provider: "codex",
    runtimeType: "codex_local",
    protocol: "app-server",
    interactionKind,
    requestId,
    providerRequestId: requestId,
    toolName: request.method,
    choices,
  };
  const sessionId = options.getSessionId?.();
  const turnId = options.getTurnId?.() ?? boundedText(params.turnId, 200);
  if (sessionId) payload.sessionId = sessionId;
  if (turnId) payload.turnId = turnId;
  for (const key of ["itemId", "kind", "command", "cwd", "reason", "grantRoot", "environmentId"]) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      payload[key] = boundedText(value, key === "command" ? 4_000 : key === "reason" ? 1_000 : 1_024);
    }
  }
  return payload;
}

async function createApprovalDecision(
  request: CodexAppServerServerRequestContext,
  options: CodexAppServerInteractionOptions,
  interactionKind: "permission" | "question",
  choices: string[],
  inputRequest?: ChatAskUserRequest,
): Promise<ApprovalDecision | { id: string; status: "rejected" | "cancelled" } | null> {
  if (!options.requestApproval) return null;
  const approval = await awaitBeforeAbort(options.requestApproval({
    type: "agent_runtime",
    payload: providerPayload(request, options, interactionKind, choices),
    ...(inputRequest ? { inputRequest } : {}),
  }), request.signal);
  if (approval.status === "rejected" || approval.status === "cancelled") {
    return { id: approval.id, status: approval.status };
  }
  if (approval.status === "approved") return { id: approval.id, status: "approved" };
  if (approval.status !== "pending" || !options.waitForApproval) return null;
  const decision = await awaitBeforeAbort(
    options.waitForApproval(approval.id, APPROVAL_TIMEOUT_MS),
    request.signal,
  );
  return decision.id === approval.id
    ? decision
    : { id: approval.id, status: "cancelled" };
}

function requestUserInputBinding(paramsValue: unknown): {
  request: ChatAskUserRequest;
  questions: Map<string, QuestionBinding>;
} {
  const params = asRecord(paramsValue);
  const rawQuestions = params?.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length < 1 || rawQuestions.length > 4) {
    throw new Error("Codex request_user_input must contain between one and four questions");
  }
  const providerQuestionIds = new Set<string>();
  const questions = new Map<string, QuestionBinding>();
  const requestQuestions: ChatAskUserRequest["questions"] = [];

  for (const [questionIndex, value] of rawQuestions.entries()) {
    const question = asRecord(value);
    const providerQuestionId = boundedText(question?.id, 200);
    const text = boundedText(question?.question, 240);
    if (!question || !providerQuestionId || providerQuestionIds.has(providerQuestionId) || !text) {
      throw new Error("Codex request_user_input contains an invalid or duplicate question");
    }
    providerQuestionIds.add(providerQuestionId);
    if (question.isSecret === true) {
      throw new Error("Secret Codex request_user_input is unsupported by the current Rudder approval contract");
    }
    const rawOptions = question.options;
    if (!Array.isArray(rawOptions) || rawOptions.length < 2 || rawOptions.length > 4) {
      throw new Error("Codex request_user_input options do not fit the Rudder question contract");
    }

    const questionId = `codex_q${questionIndex + 1}`;
    const optionLabels = new Map<string, string>();
    const options = rawOptions.map((rawOption, optionIndex) => {
      const option = asRecord(rawOption);
      const label = boundedText(option?.label, 80);
      if (!label) throw new Error("Codex request_user_input contains an invalid option");
      const optionId = `${questionId}_o${optionIndex + 1}`;
      optionLabels.set(optionId, label);
      const description = boundedText(option?.description, 220);
      return {
        id: optionId,
        label,
        ...(description ? { description } : {}),
      };
    });
    const header = boundedText(question.header, 32);
    requestQuestions.push({
      id: questionId,
      ...(header ? { header } : {}),
      question: text,
      options,
      ...(question.isOther === true ? { allowFreeform: true } : {}),
    });
    questions.set(questionId, {
      providerQuestionId,
      optionLabels,
      allowFreeform: question.isOther === true,
    });
  }

  return { request: { questions: requestQuestions }, questions };
}

function providerAnswers(
  responseValue: ChatAskUserResponse | undefined,
  questionBindings: Map<string, QuestionBinding>,
): JsonRecord {
  const response = asRecord(responseValue);
  const answers = response?.answers;
  if (!Array.isArray(answers) || answers.length !== questionBindings.size) {
    throw new Error("Rudder did not return a complete Codex request_user_input response");
  }
  const output: JsonRecord = {};
  const seen = new Set<string>();
  for (const value of answers) {
    const answer = asRecord(value);
    const questionId = boundedText(answer?.questionId, 200);
    const binding = questionBindings.get(questionId);
    if (!binding || seen.has(questionId) || !Array.isArray(answer?.optionIds)) {
      throw new Error("Rudder returned an invalid Codex request_user_input answer");
    }
    seen.add(questionId);
    const optionIds = answer.optionIds;
    if (optionIds.length > 1) {
      throw new Error("Multiple selections are unsupported for this Codex request_user_input question");
    }
    const selected = optionIds.map((value) => {
      const optionId = boundedText(value, 200);
      const label = binding.optionLabels.get(optionId);
      if (!label) throw new Error("Rudder selected an unknown Codex request_user_input option");
      return label;
    });
    const freeformText = boundedText(answer.freeformText, 2_000);
    if (freeformText && !binding.allowFreeform) {
      throw new Error("Rudder returned freeform text for a Codex question that does not allow it");
    }
    if (selected.length > 0 && freeformText) {
      throw new Error("Codex request_user_input cannot combine an option and freeform answer");
    }
    const values = [...selected, ...(freeformText ? [freeformText] : [])];
    if (values.length !== 1) throw new Error("Codex request_user_input requires one explicit answer per question");
    output[binding.providerQuestionId] = { answers: values };
  }
  return { answers: output };
}

async function handleUserInput(
  request: CodexAppServerServerRequestContext,
  options: CodexAppServerInteractionOptions,
): Promise<JsonRecord> {
  if (!options.requestApproval || !options.waitForApproval) {
    throw new Error("Rudder approval bridge is unavailable for Codex request_user_input");
  }
  const bridge = requestUserInputBinding(request.params);
  const approval = await createApprovalDecision(
    request,
    options,
    "question",
    ["answer", "cancel"],
    bridge.request,
  );
  if (!approval || approval.status === "rejected" || approval.status === "cancelled") {
    throw new Error("Codex request_user_input was not approved");
  }
  const decision = approval.status === "approved"
    ? await awaitBeforeAbort(options.waitForApproval(approval.id, APPROVAL_TIMEOUT_MS), request.signal)
    : approval;
  if (decision.id !== approval.id || decision.status !== "approved") {
    throw new Error("Codex request_user_input was not approved");
  }
  return providerAnswers(decision.inputResponse, bridge.questions);
}

async function approvalChoice(
  request: CodexAppServerServerRequestContext,
  options: CodexAppServerInteractionOptions,
): Promise<"accept" | "decline" | "cancel"> {
  if (request.signal.aborted) return "cancel";
  if (options.bypassApprovalsAndSandbox) return "accept";
  const approval = await createApprovalDecision(request, options, "permission", ["allow", "deny"]);
  if (!approval) return "decline";
  if (approval.status === "approved") return "accept";
  if (approval.status === "cancelled" || request.signal.aborted) return "cancel";
  return "decline";
}

export function createCodexAppServerServerRequestHandlers(
  options: boolean | CodexAppServerInteractionOptions,
): Readonly<Record<string, CodexAppServerServerRequestHandler>> {
  const interactionOptions: CodexAppServerInteractionOptions = typeof options === "boolean"
    ? { bypassApprovalsAndSandbox: options }
    : options;
  const choice = async (request: CodexAppServerServerRequestContext) => ({
    decision: await approvalChoice(request, interactionOptions),
  });
  const legacyChoice = async (request: CodexAppServerServerRequestContext) => {
    const result = await approvalChoice(request, interactionOptions);
    return {
      decision: result === "accept" ? "approved" : result === "cancel" ? "abort" : "denied",
    };
  };
  return {
    "item/commandExecution/requestApproval": choice,
    "item/fileChange/requestApproval": choice,
    "item/tool/requestUserInput": (request) => handleUserInput(request, interactionOptions),
    "mcpServer/elicitation/request": () => ({ action: "cancel", content: null, _meta: null }),
    "item/permissions/requestApproval": async () => {
      throw new Error("Codex permission-profile changes are unsupported by the current Rudder approval contract");
    },
    "item/tool/call": () => ({
      contentItems: [{ type: "inputText", text: "Dynamic App Server tools are not registered for this Rudder run." }],
      success: false,
    }),
    "account/chatgptAuthTokens/refresh": async () => {
      throw new Error("Codex App Server must use the isolated CODEX_HOME credentials for this run");
    },
    "attestation/generate": async () => {
      throw new Error("Client attestation is not enabled for Rudder App Server chat runs");
    },
    applyPatchApproval: legacyChoice,
    execCommandApproval: legacyChoice,
  };
}
