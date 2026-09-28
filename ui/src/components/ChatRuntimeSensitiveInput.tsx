import { Button } from "@/components/ui/button";
import type { ChatRuntimeSensitiveInputRequest as ChatRuntimeSensitiveInputMetadata } from "@/api/chats";
import { useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

export interface ChatRuntimeSensitiveInputRequest extends ChatRuntimeSensitiveInputMetadata {
  prompt?: string;
}

type ActionState = {
  requestId: string;
  action: "respond" | "cancel";
  phase: "pending" | "complete" | "error";
};

export interface ChatRuntimeSensitiveInputProps {
  request: ChatRuntimeSensitiveInputRequest;
  onRespond: (request: ChatRuntimeSensitiveInputRequest, value: string) => Promise<void>;
  onCancel: (request: ChatRuntimeSensitiveInputRequest) => void | Promise<void>;
}

export function ChatRuntimeSensitiveInput({ request, onRespond, onCancel }: ChatRuntimeSensitiveInputProps) {
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const completionRef = useRef<HTMLParagraphElement>(null);
  const mountedRequestIdRef = useRef(request.requestId);
  const mountedRef = useRef(false);
  const actionLockRequestIdRef = useRef<string | null>(null);
  const [actionState, setActionState] = useState<ActionState | null>(null);

  useLayoutEffect(() => {
    const input = inputRef.current;
    mountedRequestIdRef.current = request.requestId;
    mountedRef.current = true;
    actionLockRequestIdRef.current = null;
    if (input) {
      input.value = "";
      input.focus();
    }
    return () => {
      mountedRef.current = false;
      actionLockRequestIdRef.current = null;
      if (input) input.value = "";
    };
  }, [request.requestId]);

  const currentState = actionState?.requestId === request.requestId ? actionState : null;
  const isPending = currentState?.phase === "pending";
  const isComplete = currentState?.phase === "complete";
  const isLocked = isPending || isComplete;
  const title = request.kind === "sudo" ? "System password requested" : "Secret requested";
  const inputLabel = request.kind === "sudo" ? "Password" : "Secret";

  useLayoutEffect(() => {
    if (currentState?.phase === "error") inputRef.current?.focus();
    if (currentState?.phase === "complete") completionRef.current?.focus();
  }, [currentState?.phase, request.requestId]);

  const settleAction = async (
    requestId: string,
    action: ActionState["action"],
    operation: Promise<void> | void,
  ) => {
    try {
      await operation;
      if (mountedRef.current && mountedRequestIdRef.current === requestId) {
        setActionState({ requestId, action, phase: "complete" });
      }
    } catch {
      if (mountedRef.current && mountedRequestIdRef.current === requestId) {
        actionLockRequestIdRef.current = null;
        setActionState({ requestId, action, phase: "error" });
      }
    }
  };

  const startAction = (action: ActionState["action"], run: () => Promise<void> | void) => {
    const requestId = request.requestId;
    if (actionLockRequestIdRef.current === requestId) return;
    actionLockRequestIdRef.current = requestId;
    setActionState({ requestId, action, phase: "pending" });
    try {
      void settleAction(requestId, action, run());
    } catch {
      void settleAction(requestId, action, Promise.reject());
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isLocked) return;

    const input = inputRef.current;
    if (!input || input.value.length === 0) return;

    let sensitiveValue = input.value;
    const requestForResponse = request;
    input.value = "";
    startAction("respond", async () => {
      try {
        await onRespond(requestForResponse, sensitiveValue);
      } finally {
        sensitiveValue = "";
      }
    });
  };

  const handleCancel = () => {
    if (isLocked) return;
    const input = inputRef.current;
    if (input) input.value = "";
    const requestForCancel = request;
    startAction("cancel", () => onCancel(requestForCancel));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && !isLocked) {
      event.preventDefault();
      handleCancel();
    }
  };

  return (
    <form
      aria-labelledby={titleId}
      aria-busy={isPending}
      className="min-w-0 space-y-2 py-2"
      onSubmit={handleSubmit}
    >
      <div className="min-w-0">
        <p id={titleId} className="text-sm font-medium text-foreground">
          {title}
        </p>
        {request.prompt && <p className="mt-0.5 break-words text-xs text-muted-foreground">{request.prompt}</p>}
      </div>

      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end">
        <label className="min-w-0 flex-1 space-y-1 text-xs font-medium text-foreground">
          <span>{inputLabel}</span>
          <input
            ref={inputRef}
            type="password"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={isLocked}
            onKeyDown={handleKeyDown}
            className="h-9 w-full rounded-[var(--radius-sm)] border border-[color:var(--border-base)] bg-[color:var(--surface-page)] px-3 text-sm font-normal text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>

        <div className="flex shrink-0 gap-2">
          <Button type="submit" size="sm" disabled={isLocked}>
            {isPending && currentState?.action === "respond" ? "Sending..." : "Respond"}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={isLocked} onClick={handleCancel}>
            {isPending && currentState?.action === "cancel" ? "Cancelling..." : "Cancel"}
          </Button>
        </div>
      </div>

      {isPending && (
        <p role="status" className="text-xs text-muted-foreground">
          {currentState?.action === "respond" ? "Sending response..." : "Cancelling request..."}
        </p>
      )}
      {isComplete && (
        <p ref={completionRef} role="status" className="text-xs text-muted-foreground" tabIndex={-1}>
          {currentState?.action === "respond" ? "Response sent." : "Request cancelled."}
        </p>
      )}
      {currentState?.phase === "error" && (
        <p role="alert" className="text-xs text-destructive">
          {currentState.action === "respond"
            ? "Unable to send the response. Please try again."
            : "Unable to cancel this request. Please try again."}
        </p>
      )}
    </form>
  );
}
