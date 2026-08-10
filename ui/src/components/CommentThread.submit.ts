import { useDialog } from "@/context/DialogContext";
import { translateMessage } from "@/context/I18nContext";
import { extractAgentWakeMentionIds, parseShortRef, type AgentStatus, type InstanceLocale } from "@rudderhq/shared";
import { useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { MarkdownEditorRef } from "./MarkdownEditor";

export function isAgentWakeEligible(status: AgentStatus | null | undefined): boolean {
  return status !== undefined
    && status !== null
    && status !== "paused"
    && status !== "terminated"
    && status !== "pending_approval";
}

export function shouldConfirmUnmentionedComment(
  markdown: string,
  validAgentIds: ReadonlySet<string> = new Set(),
  reopenWillWakeAgent = false,
) {
  if (reopenWillWakeAgent) return false;
  return !extractAgentWakeMentionIds(markdown).some((agentRef) => {
    if (validAgentIds.has(agentRef)) return true;
    const shortRef = parseShortRef(agentRef);
    if (shortRef?.kind !== "agent") return false;
    let matches = 0;
    for (const agentId of validAgentIds) {
      if (agentId.replace(/-/g, "").toLowerCase().startsWith(shortRef.prefix)) matches += 1;
      if (matches > 1) return false;
    }
    return matches === 1;
  });
}

interface UseCommentSubmitOptions {
  agentMap?: ReadonlyMap<string, unknown>;
  body: string;
  canReopen: boolean;
  composerSurfaceRef: RefObject<HTMLDivElement | null>;
  draftKey?: string;
  editorRef: RefObject<MarkdownEditorRef | null>;
  locale: InstanceLocale;
  onAdd: (body: string, reopen?: boolean, intent?: "comment" | "steer") => Promise<void>;
  reopen: boolean;
  reopenWillWakeAgent: boolean;
  setReopen: Dispatch<SetStateAction<boolean>>;
  updateBody: (body: string) => void;
}

function clearDraft(draftKey: string) {
  try {
    localStorage.removeItem(draftKey);
  } catch {
    // Ignore localStorage failures.
  }
}

export function useCommentSubmit({
  agentMap,
  body,
  canReopen,
  composerSurfaceRef,
  draftKey,
  editorRef,
  locale,
  onAdd,
  reopen,
  reopenWillWakeAgent,
  setReopen,
  updateBody,
}: UseCommentSubmitOptions) {
  const { confirm } = useDialog();
  const [submitting, setSubmitting] = useState(false);
  const [confirmingUnmentioned, setConfirmingUnmentioned] = useState(false);
  const submissionInFlightRef = useRef(false);
  const focusRetryFrameRef = useRef<number | null>(null);
  const focusRetryTimeoutRef = useRef<number | null>(null);
  const validAgentIds = useMemo(() => new Set(agentMap?.keys() ?? []), [agentMap]);

  useEffect(() => () => {
    if (focusRetryFrameRef.current !== null) {
      window.cancelAnimationFrame(focusRetryFrameRef.current);
    }
    if (focusRetryTimeoutRef.current !== null) {
      window.clearTimeout(focusRetryTimeoutRef.current);
    }
  }, []);

  function restoreEditorFocus() {
    editorRef.current?.focus();
    if (typeof window !== "undefined") {
      if (focusRetryFrameRef.current !== null) {
        window.cancelAnimationFrame(focusRetryFrameRef.current);
        focusRetryFrameRef.current = null;
      }
      if (focusRetryTimeoutRef.current !== null) {
        window.clearTimeout(focusRetryTimeoutRef.current);
        focusRetryTimeoutRef.current = null;
      }
      const retry = () => {
        focusRetryFrameRef.current = null;
        const activeElement = document.activeElement;
        if (
          !activeElement
          || activeElement === document.body
          || activeElement instanceof HTMLElement && activeElement.closest('[role="dialog"]')
        ) {
          editorRef.current?.focus();
        }
      };
      focusRetryFrameRef.current = window.requestAnimationFrame(retry);
      focusRetryTimeoutRef.current = window.setTimeout(() => {
        focusRetryTimeoutRef.current = null;
        retry();
      }, 250);
    }
  }

  async function handleSubmit(intent: "comment" | "steer" = "comment") {
    if (submissionInFlightRef.current) return;
    const currentMarkdown = editorRef.current?.getMarkdown?.() ?? body;
    const trimmed = currentMarkdown.trim();
    if (!trimmed) return;
    const reopenRequested = canReopen && reopen ? true : undefined;

    submissionInFlightRef.current = true;
    try {
      if (shouldConfirmUnmentionedComment(
        trimmed,
        validAgentIds,
        intent === "steer" || Boolean(reopenRequested && reopenWillWakeAgent),
      )) {
        setConfirmingUnmentioned(true);
        const confirmed = await confirm({
          title: translateMessage(locale, "comments.unmentionedConfirm.title"),
          description: translateMessage(locale, "comments.unmentionedConfirm.description"),
          cancelLabel: translateMessage(locale, "comments.unmentionedConfirm.cancel"),
          confirmLabel: translateMessage(locale, "comments.unmentionedConfirm.confirm"),
          restoreFocus: (confirmed) => {
            if (confirmed) composerSurfaceRef.current?.focus({ preventScroll: true });
            else restoreEditorFocus();
          },
        });
        setConfirmingUnmentioned(false);
        if (!confirmed) {
          restoreEditorFocus();
          return;
        }
      }

      setSubmitting(true);
      if (intent === "steer") {
        await onAdd(trimmed, reopenRequested, "steer");
      } else {
        await onAdd(trimmed, reopenRequested);
      }
      updateBody("");
      if (draftKey) clearDraft(draftKey);
      setReopen(canReopen);
    } finally {
      setSubmitting(false);
      setConfirmingUnmentioned(false);
      submissionInFlightRef.current = false;
    }
  }

  return {
    canSubmit: !submitting && !confirmingUnmentioned && !!body.trim(),
    handleSubmit,
    submitting,
  };
}
