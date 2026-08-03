import { useDialog } from "@/context/DialogContext";
import { extractAgentWakeMentionIds, parseShortRef } from "@rudderhq/shared";
import { useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { MarkdownEditorRef } from "./MarkdownEditor";

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
  onAdd: (body: string, reopen?: boolean) => Promise<void>;
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
  const validAgentIds = useMemo(() => new Set(agentMap?.keys() ?? []), [agentMap]);

  async function handleSubmit() {
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
        Boolean(reopenRequested && reopenWillWakeAgent),
      )) {
        setConfirmingUnmentioned(true);
        const confirmed = await confirm({
          title: "未 @ 任何 Agent",
          description: "您未 @ 任何 Agent，是否确认直接发送评论？未 @ Agent 的评论不会触发 Agent，可能无法被及时处理。",
          cancelLabel: "返回并 @ Agent",
          confirmLabel: "直接发送",
          restoreFocus: (confirmed) => {
            if (confirmed) composerSurfaceRef.current?.focus({ preventScroll: true });
            else editorRef.current?.focus();
          },
        });
        setConfirmingUnmentioned(false);
        if (!confirmed) return;
      }

      setSubmitting(true);
      await onAdd(trimmed, reopenRequested);
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
