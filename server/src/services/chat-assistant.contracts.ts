export const CHAT_ASSISTANT_RECOVERABLE_FAILURE_MESSAGE =
  "The assistant reply could not be completed. Rudder saved this attempt for diagnostics; retry when ready.";

export type ChatRecoverableFailureCode =
  | "chat_result_missing_sentinel"
  | "chat_result_malformed_json"
  | "chat_timed_out"
  | "chat_adapter_failed"
  | "chat_runtime_preparation_failed"
  | "chat_runtime_boot_failed"
  | "chat_runtime_exception"
  | "codex_provider_auth_required"
  | "claude_fork_acceptance_unknown"
  | "claude_fork_completion_unresolved"
  | "claude_fork_unsubmitted"
  | "network_retry_exhausted"
  | "network_resume_unsafe";

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

export class ChatAssistantStreamError extends Error {
  partialBody: string;
  partialBodyUserVisible: boolean;
  generatedAttachments!: ChatGeneratedAttachment[];
  errorCode: ChatRecoverableFailureCode;
  userMessage: string;
  retryable?: boolean;
  failurePhase?: ChatFailurePhase;
  action?: ChatFailureAction;
  providerFailure?: Record<string, unknown>;

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
      providerFailure?: Record<string, unknown>;
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
    this.providerFailure = options.providerFailure;
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
  if (code === "codex_provider_auth_required") {
    return "The configured Codex provider credentials are not ready. Update provider authentication before retrying.";
  }
  if (code === "claude_fork_acceptance_unknown") {
    return "Claude may have received this Side Chat input. Inspect this Run before sending another message; do not retry the same input.";
  }
  if (code === "claude_fork_completion_unresolved") {
    return "The Side Chat input reached Claude, but its reply could not be confirmed. Inspect this Run; do not retry the same message.";
  }
  if (code === "claude_fork_unsubmitted") {
    return "Claude did not receive the Side Chat input. Send a new message to retry the branch.";
  }
  if (code === "network_retry_exhausted") {
    return "Network recovery retries were exhausted. Check connectivity, then retry this reply.";
  }
  if (code === "network_resume_unsafe") {
    return "Network recovery could not safely resume this reply. Check connectivity, then retry this reply.";
  }
  return CHAT_ASSISTANT_RECOVERABLE_FAILURE_MESSAGE;
}
