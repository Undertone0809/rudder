import {
  AnchoredResponseAnnotationMarkers,
  ResponseAnnotationEditor,
  SentResponseAnnotationsCard,
  type ResponseAnnotationEditorChanges,
} from "@/components/chat/ResponseAnnotations";
import { SelectionAnnotationToolbar } from "@/components/chat/SelectionAnnotationToolbar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useToolCallFailureIndicators } from "@/context/ThemeContext";
import {
  chatInlineAnnotationsFromStructuredPayload,
  type ChatInlineAnnotationInput,
} from "@rudderhq/shared";
import {
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  FileDiff,
  FileText,
  Images,
  ListTodo,
  Loader2,
  MessageSquare,
  TerminalSquare,
  User
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useScrollbarActivityRef } from "../../hooks/useScrollbarActivityRef";
import {
  CHAT_ANNOTATION_BLOCK_ATTRIBUTE,
  CHAT_ANNOTATION_SOURCE_ATTRIBUTE,
  registerChatAnnotationSourceText,
  shouldAutoFocusChatAnnotationToolbar,
} from "../../lib/chat-response-annotation-selection";
import { readDesktopShell } from "../../lib/desktop-shell";
import { cn } from "../../lib/utils";
import { MarkdownBody } from "../MarkdownBody";
import {
  asRecord,
  compactWhitespace,
  formatTranscriptDuration,
  formatTranscriptTimestamp,
  getTranscriptTimestampTitle,
  TranscriptActionIconCategory,
  TranscriptActionIconSlot,
  TranscriptActionIconStack,
  TranscriptActionIconStatus,
  TranscriptAnnotationSourceContext,
  TranscriptBlock,
  TranscriptDensity,
  TranscriptMarkdownLinkClickHandler,
  TranscriptPresentation,
  TranscriptRunAnnotationContext,
  TranscriptSentAnnotationContext,
  TranscriptToolCardEntry,
  truncate
} from "./RunTranscriptView.common";
import { formatSemanticDigest, getTodoListCompletedCount } from "./RunTranscriptView.normalize";
import { formatNiceToolRequest, formatNiceToolResponse } from "./RunTranscriptView.presentation";
import { describeToolSemanticInfo, formatCommandTerminalOutput, isCommandTool, neutralizeToolFailureSemanticInfo } from "./RunTranscriptView.semantic";
import { formatMemoryScopeLabel, stripWrappedShell } from "./RunTranscriptView.shell";
import { getTranscriptAgentAvatarInfo, TranscriptAgentAvatarIcon } from "./TranscriptAgentAvatarIcon";

async function writeTranscriptClipboardText(text: string) {
  const desktopShell = readDesktopShell();
  if (desktopShell?.copyText) {
    await desktopShell.copyText(text);
    return;
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand?.("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard write failed.");
}

function TranscriptAnnotationSource({
  block,
  context,
  transcriptKind,
  children,
}: {
  block: Extract<TranscriptBlock, { type: "message" | "thinking" }>;
  context?: TranscriptAnnotationSourceContext;
  transcriptKind: "assistant" | "thinking";
  children: ReactNode;
}) {
  const sourceRootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sourceRoot = sourceRootRef.current;
    if (!sourceRoot) return;
    registerChatAnnotationSourceText(sourceRoot, block.text);
  }, [block.text]);
  if (
    !context
    || block.streaming
    || typeof block.generationId !== "string"
    || !Number.isInteger(block.generationSeqStart)
    || !Number.isInteger(block.generationSeqEnd)
  ) {
    return children;
  }
  const annotations = (context.annotations ?? []).filter((annotation) => (
    annotation.surface === "process_transcript"
    && annotation.sourceMessageId === context.sourceMessageId
    && annotation.transcriptKind === transcriptKind
    && annotation.generationId === block.generationId
    && annotation.generationSeqStart === block.generationSeqStart
    && annotation.generationSeqEnd === block.generationSeqEnd
  ));
  const blockId = [
    "process",
    context.sourceMessageId,
    block.generationId,
    block.generationSeqStart,
    block.generationSeqEnd,
    transcriptKind,
  ].join(":");
  return (
    <div
      ref={sourceRootRef}
      {...{
        [CHAT_ANNOTATION_SOURCE_ATTRIBUTE]: blockId,
        [CHAT_ANNOTATION_BLOCK_ATTRIBUTE]: blockId,
      }}
      data-annotation-surface="process_transcript"
      data-message-id={context.sourceMessageId}
      data-conversation-id={context.sourceConversationId}
      data-transcript-kind={transcriptKind}
      data-generation-id={block.generationId}
      data-generation-seq-start={block.generationSeqStart}
      data-generation-seq-end={block.generationSeqEnd}
      className="relative"
    >
      {children}
      <AnchoredResponseAnnotationMarkers
        sourceRootRef={sourceRootRef}
        source={block.text}
        annotations={annotations}
        onActivate={context.onActivateAnnotation}
      />
    </div>
  );
}

function transcriptBlockIdentity(block: TranscriptBlock): string {
  const primarySourceEntryId = block.sourceEntryIds?.[0];
  if (primarySourceEntryId) return primarySourceEntryId;
  switch (block.type) {
    case "message":
      return [
        block.type,
        block.messageId ?? block.segmentId ?? block.generationId ?? "block",
        block.generationSeqStart ?? block.ts,
        block.generationSeqEnd ?? block.ts,
      ].join(":");
    case "thinking":
      return [
        block.type,
        block.segmentId ?? block.generationId ?? "block",
        block.generationSeqStart ?? block.ts,
        block.generationSeqEnd ?? block.ts,
      ].join(":");
    case "tool":
      return [block.type, block.toolUseId ?? block.name, block.ts].join(":");
    case "command_group":
      return [
        block.type,
        block.items[0]?.toolUseId ?? block.items[0]?.name ?? "group",
        block.ts,
      ].join(":");
    case "activity":
      return [block.type, block.activityId ?? block.name, block.ts].join(":");
    case "todo_list":
      return [block.type, block.todoListId ?? block.ts].join(":");
    case "stdout":
    case "memory_update":
    case "event":
      return [block.type, block.ts].join(":");
  }
}

function isStableTranscriptBlock(block: TranscriptBlock): boolean {
  if (block.type === "message") return block.role === "assistant" && !block.streaming;
  if (block.type === "thinking") return !block.streaming;
  if (block.type === "tool") return block.status !== "running";
  if (block.type === "command_group") return block.items.every((item) => item.status !== "running");
  return false;
}

function transcriptBlockAnnotationText(block: TranscriptBlock): string {
  const limit = (value: string) => value.length > 4000 ? `${value.slice(0, 3997)}...` : value;
  switch (block.type) {
    case "message":
    case "thinking":
    case "stdout":
      return limit(block.text);
    case "tool": {
      const request = formatNiceToolRequest(block.name, block.input);
      const response = block.result ? formatNiceToolResponse(block.name, block.input, block.result) : "";
      return limit([request, response].filter(Boolean).join("\n\n"));
    }
    case "command_group":
      return limit(block.items.map((item) => {
        const request = formatNiceToolRequest(item.name, item.input);
        return [request, item.result].filter(Boolean).join("\n\n");
      }).filter(Boolean).join("\n\n"));
    case "activity":
      return limit(block.name);
    case "todo_list":
      return limit(block.items.map((item) => item.text).join("\n"));
    case "memory_update":
      return limit([block.summary, block.effect].filter(Boolean).join("\n\n"));
    case "event":
      return limit([block.label, block.text, block.detail].filter(Boolean).join("\n\n"));
  }
}

export function TranscriptRunAnnotationBlock({
  block,
  presentation,
  context,
  streaming = false,
  children,
}: {
  block: TranscriptBlock;
  presentation: TranscriptPresentation;
  context?: TranscriptRunAnnotationContext;
  streaming?: boolean;
  children: ReactNode;
}) {
  const stable = isStableTranscriptBlock(block);
  const blockId = transcriptBlockIdentity(block);
  const canAnnotate = presentation === "detail"
    && !streaming
    && stable
    && Boolean(context)
    && (block.sourceEntryIds?.length ?? 0) > 0;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const blockRootRef = useRef<HTMLDivElement | null>(null);
  const getAnnotationBoundaryRect = useCallback(() => (
    blockRootRef.current
      ?.closest<HTMLElement>(
        '.transcript-modal-body, [data-testid="agent-runs-detail-pane"]',
      )
      ?.getBoundingClientRect()
      ?? null
  ), []);
  const [pendingSelection, setPendingSelection] = useState<{
    text: string;
    range: Range;
    anchorRect: DOMRect;
    autoFocus: boolean;
  } | null>(null);
  const [pendingAnnotation, setPendingAnnotation] = useState<{
    annotation: ChatInlineAnnotationInput;
    anchorKind: "text" | "transition";
    anchorRect: DOMRect;
    autoFocus: boolean;
  } | null>(null);
  const beginAnnotation = (
    text: string,
    anchor: HTMLButtonElement,
    anchorKind: "text" | "transition",
    anchorRect?: DOMRect,
    autoFocus = true,
  ) => {
    if (!context) return;
    const normalizedText = text.trim();
    if (!normalizedText) return;
    const rect = anchorRect ?? anchor.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    setPendingAnnotation({
      annotation: {
        id: globalThis.crypto?.randomUUID?.() ?? `run-annotation-${Date.now()}`,
        selectedText: normalizedText,
        comment: null,
        sourceHash: "pending",
        surface: "agent_run_transcript",
        sourceRunId: context.sourceRunId,
        sourceAgentId: context.sourceAgentId,
        anchorKind,
        sourceEntryId: blockId,
        sourceMemberIds: block.sourceEntryIds?.length ? block.sourceEntryIds : [blockId],
        attachmentFileIndexes: [],
      },
      anchorKind,
      anchorRect: rect,
      autoFocus,
    });
    setPendingSelection(null);
  };
  const handleAnnotate = (anchor: HTMLButtonElement) => {
    beginAnnotation(transcriptBlockAnnotationText(block), anchor, "transition");
  };
  useEffect(() => {
    if (!canAnnotate) return undefined;
    const updateSelection = (event: Event) => {
      const eventTarget = event.target instanceof Element ? event.target : null;
      if (eventTarget?.closest('[role="toolbar"][aria-label="Response annotation actions"]')) return;
      const root = blockRootRef.current;
      const selection = window.getSelection();
      if (!root || !selection || selection.rangeCount !== 1 || selection.isCollapsed) {
        setPendingSelection(null);
        return;
      }
      const range = selection.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) {
        setPendingSelection(null);
        return;
      }
      const text = selection.toString().trim();
      const anchorRect = range.getBoundingClientRect();
      if (!text || anchorRect.width <= 0 || anchorRect.height <= 0) {
        setPendingSelection(null);
        return;
      }
      setPendingSelection({
        text,
        range: range.cloneRange(),
        anchorRect,
        autoFocus: shouldAutoFocusChatAnnotationToolbar(event),
      });
    };
    document.addEventListener("mouseup", updateSelection);
    document.addEventListener("touchend", updateSelection);
    document.addEventListener("keyup", updateSelection);
    document.addEventListener("selectionchange", updateSelection);
    return () => {
      document.removeEventListener("mouseup", updateSelection);
      document.removeEventListener("touchend", updateSelection);
      document.removeEventListener("keyup", updateSelection);
      document.removeEventListener("selectionchange", updateSelection);
    };
  }, [canAnnotate]);

  if (!context) return children;

  const commitPendingSelection = () => {
    if (!pendingSelection || !triggerRef.current) return;
    beginAnnotation(
      pendingSelection.text,
      triggerRef.current,
      "text",
      pendingSelection.anchorRect,
      pendingSelection.autoFocus,
    );
    window.getSelection()?.removeAllRanges();
  };

  const finishAnnotation = ({
    comment,
    pendingFiles,
    attachmentIds,
  }: ResponseAnnotationEditorChanges) => {
    if (!pendingAnnotation) return;
    const annotation = pendingAnnotation.annotation;
    context.onAnnotate({
      sourceRunId: context.sourceRunId,
      sourceAgentId: context.sourceAgentId,
      blockId,
      sourceMemberIds: block.sourceEntryIds,
      blockType: block.type,
      text: annotation.selectedText,
      anchorKind: pendingAnnotation.anchorKind,
      ts: block.ts,
      anchor: triggerRef.current ?? document.createElement("button"),
      comment,
      pendingFiles,
      attachmentIds,
      block,
    });
    setPendingAnnotation(null);
  };

  return (
    <div
      ref={blockRootRef}
      data-run-transcript-block="true"
      data-run-transcript-block-id={blockId}
      data-run-transcript-block-type={block.type}
      data-run-transcript-block-ts={block.ts}
      data-run-transcript-block-stable={stable ? "true" : undefined}
      className={cn("group/run-transcript-block relative", canAnnotate && "pr-8")}
    >
      {children}
      {canAnnotate ? (
        <button
          ref={triggerRef}
          type="button"
          data-testid="run-transcript-annotation-trigger"
          data-run-transcript-annotation-trigger="true"
          className="absolute right-0 top-0 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted/70 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 group-hover/run-transcript-block:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100 motion-reduce:transition-none"
          aria-label="Annotate transcript block"
          title="Annotate transcript block"
          onClick={(event) => handleAnnotate(event.currentTarget)}
        >
          <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
      {canAnnotate && pendingSelection && !pendingAnnotation ? (
        <SelectionAnnotationToolbar
          open
          anchorRect={pendingSelection.anchorRect}
          getAnchorRect={() => (
            typeof pendingSelection.range.getBoundingClientRect === "function"
              ? pendingSelection.range.getBoundingClientRect()
              : pendingSelection.anchorRect
          )}
          boundaryRect={getAnnotationBoundaryRect()}
          getBoundaryRect={getAnnotationBoundaryRect}
          anchorObservationRoot={blockRootRef.current}
          onAddToChat={commitPendingSelection}
          onAskInSideChat={commitPendingSelection}
          showAskInSideChat={false}
          onDismiss={() => setPendingSelection(null)}
          onAnchorUnavailable={() => setPendingSelection(null)}
          autoFocus={pendingSelection.autoFocus}
        />
      ) : null}
      {canAnnotate && pendingAnnotation ? (
        <ResponseAnnotationEditor
          annotation={pendingAnnotation.annotation}
          ordinal={1}
          pendingFiles={[]}
          anchorRect={pendingAnnotation.anchorRect}
          getAnchorRect={() => (
            pendingAnnotation.anchorKind === "text"
              ? pendingAnnotation.anchorRect
              : triggerRef.current?.isConnected
                ? triggerRef.current.getBoundingClientRect()
                : pendingAnnotation.anchorRect
          )}
          boundaryRect={getAnnotationBoundaryRect()}
          getBoundaryRect={getAnnotationBoundaryRect}
          returnFocusRef={triggerRef}
          autoFocus={pendingAnnotation.autoFocus}
          showSelectedTextContext
          onSave={finishAnnotation}
          onCancel={() => setPendingAnnotation(null)}
          onDelete={() => setPendingAnnotation(null)}
        />
      ) : null}
    </div>
  );
}

function formatCommandCopyText(command: string, output: string | null) {
  return output ? `${command}\n\n${output}` : command;
}

type CommandTerminalView = "shell" | "task" | "markdown";

const COMMAND_TERMINAL_VIEWS: Array<{
  id: CommandTerminalView;
  label: string;
  Icon: typeof TerminalSquare;
}> = [
  { id: "shell", label: "Shell", Icon: TerminalSquare },
  { id: "task", label: "Task", Icon: ListTodo },
  { id: "markdown", label: "Markdown", Icon: FileText },
];

function commandTerminalStatusLabel(
  status: TranscriptToolCardEntry["status"],
  showFailureIndicators: boolean,
) {
  switch (status) {
    case "running":
      return "Running";
    case "error":
      return showFailureIndicators ? "Failed" : "Result available";
    default:
      return "Completed";
  }
}

function formatCommandMarkdown({
  command,
  output,
  status,
  taskLabel,
  taskSummary,
  showFailureIndicators,
}: {
  command: string;
  output: string | null;
  status: TranscriptToolCardEntry["status"];
  taskLabel: string;
  taskSummary: string;
  showFailureIndicators: boolean;
}) {
  const title = taskSummary || taskLabel || "Command";
  const outputSection = output
    ? `## Output\n\n${output}`
    : "## Output\n\n_No output captured._";
  return [
    `# ${title}`,
    "",
    `- **Type:** ${taskLabel}`,
    `- **Status:** ${commandTerminalStatusLabel(status, showFailureIndicators)}`,
    "",
    "~~~sh",
    command,
    "~~~",
    "",
    outputSection,
  ].join("\n");
}

const TRANSCRIPT_RESPONSE_COLLAPSED_LINE_LIMIT = 14;
const TRANSCRIPT_RESPONSE_COLLAPSED_CHAR_LIMIT = 1400;

function isLikelyLongTranscriptResponse(text: string) {
  if (text.length > TRANSCRIPT_RESPONSE_COLLAPSED_CHAR_LIMIT) return true;
  return text.split("\n").length > TRANSCRIPT_RESPONSE_COLLAPSED_LINE_LIMIT;
}

export function ExpandableTranscriptResponsePre({
  text,
  className,
  collapsedLabel = "response",
  testId,
}: {
  text: string;
  className?: string;
  collapsedLabel?: string;
  testId?: string;
}) {
  const preRef = useRef<HTMLPreElement | null>(null);
  const scrollbarActivityRef = useScrollbarActivityRef();
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(() => isLikelyLongTranscriptResponse(text));
  const toggleLabel = expanded ? "Show less" : `Show full ${collapsedLabel}`;

  const setPreRef = useCallback((element: HTMLPreElement | null) => {
    preRef.current = element;
    scrollbarActivityRef(element);
  }, [scrollbarActivityRef]);

  const measureCanExpand = useCallback(() => {
    const element = preRef.current;
    if (!element || expanded) return;

    const hasLayoutMeasurement = element.scrollHeight > 0 || element.clientHeight > 0;
    setCanExpand(
      hasLayoutMeasurement
        ? element.scrollHeight > element.clientHeight + 1
        : isLikelyLongTranscriptResponse(text),
    );
  }, [expanded, text]);

  useEffect(() => {
    setExpanded(false);
    setCanExpand(isLikelyLongTranscriptResponse(text));
  }, [text]);

  useEffect(() => {
    const element = preRef.current;
    if (!element || expanded) return;

    measureCanExpand();
    const scheduleFrame = window.requestAnimationFrame ?? ((callback: FrameRequestCallback) => window.setTimeout(callback, 0));
    const cancelFrame = window.cancelAnimationFrame ?? window.clearTimeout;
    const frameId = scheduleFrame(measureCanExpand);
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measureCanExpand);
    resizeObserver?.observe(element);
    window.addEventListener("resize", measureCanExpand);

    return () => {
      cancelFrame(frameId);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measureCanExpand);
    };
  }, [expanded, measureCanExpand]);

  return (
    <div className="space-y-1.5">
      <pre
        ref={setPreRef}
        className={cn(
          "scrollbar-auto-hide overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px]",
          !expanded && "max-h-72 overflow-y-auto overscroll-contain pr-1",
          className,
        )}
        data-testid={testId}
        data-transcript-response-collapsed={canExpand && !expanded ? "true" : undefined}
      >
        {text}
      </pre>
      {canExpand ? (
        <button
          type="button"
          className="inline-flex h-6 items-center rounded-md px-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {toggleLabel}
        </button>
      ) : null}
    </div>
  );
}

export function TranscriptMessageBlock({
  block,
  density,
  presentation = "default",
  className,
  collapsibleSummary = false,
  onMarkdownLinkClick,
  annotationSource,
  sentAnnotationContext,
}: {
  block: Extract<TranscriptBlock, { type: "message" }>;
  density: TranscriptDensity;
  presentation?: TranscriptPresentation;
  className?: string;
  collapsibleSummary?: boolean;
  onMarkdownLinkClick?: TranscriptMarkdownLinkClickHandler;
  annotationSource?: TranscriptAnnotationSourceContext;
  sentAnnotationContext?: TranscriptSentAnnotationContext;
}) {
  const compact = density === "compact";
  const isUser = block.role === "user";
  const isSteer = block.source === "steer";
  const showRoleLabel = isUser && presentation !== "detail";
  const [open, setOpen] = useState(true);
  const steerAnnotations = block.steerMessage
    ? chatInlineAnnotationsFromStructuredPayload(block.steerMessage.structuredPayload)
    : [];

  const body = (
    <TranscriptAnnotationSource
      block={block}
      context={block.role === "assistant" ? annotationSource : undefined}
      transcriptKind="assistant"
    >
      <MarkdownBody
        className={cn(
          "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
          compact
            ? "text-xs leading-5 text-foreground/85"
            : presentation === "detail"
              ? "text-sm leading-7"
              : "text-sm",
          className,
        )}
        onLinkClick={onMarkdownLinkClick}
      >
        {block.text}
      </MarkdownBody>
    </TranscriptAnnotationSource>
  );

  if (isSteer) {
    return (
      <div
        data-testid="chat-transcript-steer-message"
        data-message-id={block.messageId}
        data-control-action-id={block.controlActionId}
        className="flex justify-end py-1"
        title={getTranscriptTimestampTitle(block.ts)}
      >
        <div className="max-w-[min(100%,72ch)] text-right">
          {block.steerMessage ? (
            <SentResponseAnnotationsCard
              annotations={steerAnnotations}
              attachments={block.steerMessage.attachments}
              onSelect={sentAnnotationContext?.onSelect}
              onExpandedChange={(expanded) => sentAnnotationContext?.onExpandedChange?.(
                steerAnnotations,
                expanded,
              )}
              unlocatableAnnotationId={sentAnnotationContext?.unlocatableAnnotationId}
              className="mb-2 ml-auto"
            />
          ) : null}
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Steer
          </div>
          <div
            data-testid="chat-user-message-bubble"
            data-message-highlight-target="true"
            className="chat-message-user ml-auto w-fit rounded-[var(--radius-xl)] px-4 py-3 text-left shadow-[var(--shadow-sm)]"
          >
            {body}
          </div>
        </div>
      </div>
    );
  }

  if (!isUser || !collapsibleSummary) {
    return (
      <div title={getTranscriptTimestampTitle(block.ts)}>
        {showRoleLabel && (
          <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground">
            <User className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
            <span>User</span>
          </div>
        )}
        {body}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border/30 bg-muted/10" title={getTranscriptTimestampTitle(block.ts)}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? "Collapse user message" : "Expand user message"}
      >
        <DisclosureChevron open={open} className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground">
          <User className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
          <span>User</span>
        </div>
      </button>
      {open && <div className="motion-disclosure-enter border-t border-border/20 px-2.5 pb-2.5 pt-2">{body}</div>}
    </div>
  );
}

export function TranscriptThinkingBlock({
  block,
  density,
  className,
  collapsibleSummary = false,
  onMarkdownLinkClick,
  annotationSource,
  localizeText = (text) => text,
}: {
  block: Extract<TranscriptBlock, { type: "thinking" }>;
  density: TranscriptDensity;
  className?: string;
  collapsibleSummary?: boolean;
  onMarkdownLinkClick?: TranscriptMarkdownLinkClickHandler;
  annotationSource?: TranscriptAnnotationSourceContext;
  localizeText?: (text: string) => string;
}) {
  const [open, setOpen] = useState(() => Boolean(block.streaming));

  useEffect(() => {
    if (block.streaming) {
      setOpen(true);
    }
  }, [block.streaming]);

  const previewSource = compactWhitespace(block.text);
  const preview = truncate(previewSource, density === "compact" ? 100 : 160);

  const body = (
    <TranscriptAnnotationSource
      block={block}
      context={annotationSource}
      transcriptKind="thinking"
    >
      <MarkdownBody
        className={cn(
          "italic text-foreground/75 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
          density === "compact" ? "text-[11px] leading-5" : "text-sm leading-6",
          className,
        )}
        onLinkClick={onMarkdownLinkClick}
      >
        {block.text}
      </MarkdownBody>
    </TranscriptAnnotationSource>
  );

  if (!collapsibleSummary) {
    return body;
  }

  return (
    <div className="rounded-lg border border-border/30 bg-muted/10" title={getTranscriptTimestampTitle(block.ts)}>
      <button
        type="button"
        className="flex w-full items-start gap-2 px-2.5 py-2 text-left"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? "Collapse thinking" : "Expand thinking"}
      >
        {block.streaming ? (
          <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
        ) : (
          <DisclosureChevron open={open} className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium tracking-wide text-muted-foreground">{localizeText("Thinking")}</div>
          {!open && !block.streaming ? (
            <div className="mt-0.5 line-clamp-2 text-[12px] leading-5 text-foreground/55">{preview || "…"}</div>
          ) : null}
        </div>
      </button>
      {(open || block.streaming) && (
        <div className="motion-disclosure-enter border-t border-border/20 px-2.5 pb-2.5 pt-2">{body}</div>
      )}
    </div>
  );
}

export function renderTranscriptBlock({
  block,
  index,
  density,
  presentation,
  collapseStdout,
  thinkingClassName,
  onMarkdownLinkClick,
  annotationSource,
  sentAnnotationContext,
  runAnnotationContext,
  localizeText = (text) => text,
  streaming = false,
}: {
  block: TranscriptBlock;
  index: number;
  density: TranscriptDensity;
  presentation: TranscriptPresentation;
  collapseStdout: boolean;
  thinkingClassName?: string;
  onMarkdownLinkClick?: TranscriptMarkdownLinkClickHandler;
  annotationSource?: TranscriptAnnotationSourceContext;
  sentAnnotationContext?: TranscriptSentAnnotationContext;
  runAnnotationContext?: TranscriptRunAnnotationContext;
  localizeText?: (text: string) => string;
  streaming?: boolean;
}) {
  return (
    <div key={`${block.type}-${block.ts}-${index}`} className={cn(index === -1 && "hidden")}>
      <TranscriptRunAnnotationBlock block={block} presentation={presentation} context={runAnnotationContext} streaming={streaming}>
        {block.type === "message" && (
          <TranscriptMessageBlock
            block={block}
            density={density}
            presentation={presentation}
            collapsibleSummary={presentation === "chat"}
            onMarkdownLinkClick={onMarkdownLinkClick}
            annotationSource={annotationSource}
            sentAnnotationContext={sentAnnotationContext}
          />
        )}
        {block.type === "thinking" && (
          <TranscriptThinkingBlock
            block={block}
            density={density}
            className={thinkingClassName}
            onMarkdownLinkClick={onMarkdownLinkClick}
            annotationSource={annotationSource}
            localizeText={localizeText}
          />
        )}
        {block.type === "tool" && <TranscriptToolCard block={block} density={density} presentation={presentation} />}
        {block.type === "command_group" && <TranscriptCommandGroup block={block} density={density} />}
        {block.type === "todo_list" && <TranscriptTodoListRow block={block} density={density} presentation={presentation} />}
        {block.type === "stdout" && (
          <TranscriptStdoutRow
            block={block}
            density={density}
            collapseByDefault={collapseStdout}
            presentation={presentation}
          />
        )}
        {block.type === "memory_update" && <TranscriptMemoryUpdateRow block={block} density={density} />}
        {block.type === "activity" && <TranscriptActivityRow block={block} density={density} />}
        {block.type === "event" && (
          <TranscriptEventRow block={block} density={density} presentation={presentation} />
        )}
      </TranscriptRunAnnotationBlock>
    </div>
  );
}

export function CommandTerminalDetail({
  command,
  output,
  status,
  taskLabel = "Command",
  taskSummary = "Command details",
  duration = null,
  showFailureIndicators = true,
  className,
}: {
  command: string;
  output: string | null;
  status: TranscriptToolCardEntry["status"];
  taskLabel?: string;
  taskSummary?: string;
  duration?: string | null;
  showFailureIndicators?: boolean;
  className?: string;
}) {
  const hasCommand = command.trim().length > 0;
  const [activeView, setActiveView] = useState<CommandTerminalView>(() => hasCommand ? "shell" : "task");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const viewId = useId().replace(/:/gu, "");
  const disabledViews = useMemo(
    () => new Set<CommandTerminalView>(hasCommand ? [] : ["shell", "markdown"]),
    [hasCommand],
  );
  const copyLabel =
    copyState === "copied" ? "Copied command output" : copyState === "failed" ? "Copy failed" : "Copy command output";
  const copyText = useMemo(() => formatCommandCopyText(command, output), [command, output]);
  const markdownSource = useMemo(() => formatCommandMarkdown({
    command,
    output,
    status,
    taskLabel,
    taskSummary,
    showFailureIndicators,
  }), [command, output, showFailureIndicators, status, taskLabel, taskSummary]);
  const terminalStatusLabel = commandTerminalStatusLabel(status, showFailureIndicators);
  const activeViewIndex = COMMAND_TERMINAL_VIEWS.findIndex((view) => view.id === activeView);
  const activeViewMeta = COMMAND_TERMINAL_VIEWS[activeViewIndex] ?? COMMAND_TERMINAL_VIEWS[0];
  const activeTabId = `command-terminal-${viewId}-tab-${activeViewMeta.id}`;
  const activePanelId = `command-terminal-${viewId}-panel`;

  useEffect(() => () => clearTimeout(resetTimerRef.current), []);

  useEffect(() => {
    if (!disabledViews.has(activeView)) return;
    const fallbackView = COMMAND_TERMINAL_VIEWS.find((view) => !disabledViews.has(view.id));
    if (fallbackView) setActiveView(fallbackView.id);
  }, [activeView, disabledViews]);

  const handleCopy = useCallback(async () => {
    clearTimeout(resetTimerRef.current);
    try {
      await writeTranscriptClipboardText(copyText);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    resetTimerRef.current = setTimeout(() => setCopyState("idle"), 1600);
  }, [copyText]);

  const handleViewKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!(["ArrowLeft", "ArrowRight", "Home", "End"] as string[]).includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    const nextIndex = event.key === "Home"
      ? COMMAND_TERMINAL_VIEWS.findIndex((view) => !disabledViews.has(view.id))
      : event.key === "End"
        ? [...COMMAND_TERMINAL_VIEWS].map((view) => view.id).findLastIndex((id) => !disabledViews.has(id))
        : (() => {
          for (let offset = 1; offset <= COMMAND_TERMINAL_VIEWS.length; offset += 1) {
            const candidateIndex = (index + direction * offset + COMMAND_TERMINAL_VIEWS.length) % COMMAND_TERMINAL_VIEWS.length;
            const candidate = COMMAND_TERMINAL_VIEWS[candidateIndex];
            if (candidate && !disabledViews.has(candidate.id)) return candidateIndex;
          }
          return index;
        })();
    const nextView = COMMAND_TERMINAL_VIEWS[nextIndex];
    if (!nextView) return;
    setActiveView(nextView.id);
    tabRefs.current[nextIndex]?.focus();
  }, [disabledViews]);

  const renderShellView = () => (
    <div className="p-3 font-mono text-[11px] leading-5 sm:p-4">
      <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[color:var(--code-foreground)]">
        <span className="select-none text-[color:var(--accent-base)]">$ </span>
        {command}
      </pre>
      {output ? (
        <ExpandableTranscriptResponsePre
          text={output}
          collapsedLabel="output"
          className={cn(
            "mt-3",
              status === "error" && showFailureIndicators
                ? "text-red-300"
                : "text-[color:var(--code-foreground)]",
          )}
        />
      ) : null}
    </div>
  );

  const renderTaskView = () => (
    <div className="p-3 sm:p-4">
      <div className="grid gap-x-4 gap-y-2 p-3 text-[11px] sm:grid-cols-[5rem_minmax(0,1fr)]">
        <span className="font-semibold uppercase tracking-[0.12em] text-[color:var(--code-muted)]">Intent</span>
        <span className="min-w-0 break-words text-[color:var(--code-foreground)]">{taskSummary}</span>
        <span className="font-semibold uppercase tracking-[0.12em] text-[color:var(--code-muted)]">Type</span>
        <span className="min-w-0 break-words text-[color:var(--code-foreground)]">{taskLabel}</span>
        <span className="font-semibold uppercase tracking-[0.12em] text-[color:var(--code-muted)]">Status</span>
        <span className={cn(
          "font-medium",
          status === "error" && showFailureIndicators
            ? "text-red-300"
            : status === "running"
              ? "text-cyan-300"
              : status === "error"
                ? "text-[color:var(--code-foreground)]"
                : "text-emerald-300",
        )}>
          {terminalStatusLabel}
        </span>
        <span className="font-semibold uppercase tracking-[0.12em] text-[color:var(--code-muted)]">Duration</span>
        <span className="text-[color:var(--code-foreground)]">{duration ?? (status === "running" ? "In progress" : "Not recorded")}</span>
      </div>
    </div>
  );

  const renderMarkdownView = () => (
    <div className="p-3 sm:p-4">
      <ExpandableTranscriptResponsePre
        text={markdownSource}
        collapsedLabel="Markdown source"
        className="text-[color:var(--code-foreground)]"
        testId="command-terminal-markdown-source"
      />
    </div>
  );

  const renderActiveView = () => {
    switch (activeView) {
      case "task":
        return renderTaskView();
      case "markdown":
        return renderMarkdownView();
      default:
        return renderShellView();
    }
  };

  return (
    <div
      data-testid="command-terminal-detail"
      className={cn(
        "group/command-terminal relative overflow-hidden rounded-[var(--radius-md)] border border-[color:var(--code-border)] bg-[color:var(--code-surface)] text-[color:var(--code-foreground)] shadow-[var(--shadow-sm)]",
        className,
      )}
    >
      <div className="flex min-h-10 items-center justify-between gap-2 border-b border-[color:var(--code-border)] bg-[color:color-mix(in_oklab,var(--code-surface-elevated)_90%,transparent)] px-2.5 py-1.5">
        <div
          role="tablist"
          aria-label="Command views"
          className="scrollbar-auto-hide flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pr-1"
        >
          {COMMAND_TERMINAL_VIEWS.map(({ id, label, Icon }, index) => {
            const selected = activeView === id;
            const disabled = disabledViews.has(id);
            return (
              <button
                key={id}
                ref={(element) => {
                  tabRefs.current[index] = element;
                }}
                type="button"
                role="tab"
                id={`command-terminal-${viewId}-tab-${id}`}
                aria-controls={activePanelId}
                aria-selected={selected}
                aria-label={label}
                title={label}
                tabIndex={selected ? 0 : -1}
                disabled={disabled}
                data-command-terminal-view={id}
                data-state={selected ? "active" : "inactive"}
                className={cn(
                  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-base)]/60",
                  disabled
                    ? "cursor-not-allowed border-transparent text-[color:var(--code-muted)] opacity-45"
                    : selected
                    ? "border-[color:var(--code-border)] bg-[color:var(--code-surface)] text-[color:var(--code-foreground)] shadow-sm"
                    : "border-transparent text-[color:var(--code-muted)] hover:border-[color:var(--code-border)] hover:bg-[color:var(--code-surface)]/70 hover:text-[color:var(--code-foreground)]",
                )}
                onClick={() => {
                  if (!disabled) setActiveView(id);
                }}
                onKeyDown={(event) => handleViewKeyDown(event, index)}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">{label}</span>
              </button>
            );
          })}
        </div>
        <TooltipProvider delayDuration={120}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[color:var(--code-border)] bg-[color:var(--code-surface)] text-[color:var(--code-muted)] opacity-0 transition-[background-color,color,opacity] hover:bg-[color:var(--code-surface-elevated)] hover:text-[color:var(--code-foreground)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-base)]/60 group-hover/command-terminal:opacity-100 group-focus-within/command-terminal:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100"
                aria-label={copyLabel}
                data-testid="command-terminal-copy-button"
                data-copy-state={copyState}
                onClick={() => void handleCopy()}
              >
                {copyState === "copied" ? (
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="left" sideOffset={8}>
              {copyLabel}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div
        id={activePanelId}
        role="tabpanel"
        aria-labelledby={activeTabId}
        data-command-terminal-panel={activeView}
        tabIndex={0}
        className="min-w-0 outline-none"
      >
        {renderActiveView()}
      </div>
    </div>
  );
}

function getToolCommand(block: TranscriptToolCardEntry): string | null {
  if (typeof block.input === "string" && isCommandTool(block.name, block.input)) {
    return stripWrappedShell(block.input);
  }
  const record = asRecord(block.input);
  if (record) {
    if (typeof record.command === "string") return stripWrappedShell(record.command);
    if (typeof record.cmd === "string") return stripWrappedShell(record.cmd);
  }
  return null;
}

export function TranscriptToolCard({
  block,
  density,
  presentation = "default",
}: {
  block: TranscriptToolCardEntry;
  density: TranscriptDensity;
  presentation?: TranscriptPresentation;
}) {
  const showFailureIndicators = useToolCallFailureIndicators();
  const renderFailure = showFailureIndicators && block.status === "error";
  const visualStatus = block.status === "error" && !showFailureIndicators
    ? "completed"
    : block.status;
  const [open, setOpen] = useState(presentation !== "detail" && renderFailure);
  const failureAutoOpenRef = useRef(presentation !== "detail" && renderFailure);
  const compact = density === "compact";
  const detail = presentation === "detail";
  const rawSemantic = describeToolSemanticInfo(block.name, block.input);
  const semantic = showFailureIndicators
    ? rawSemantic
    : neutralizeToolFailureSemanticInfo(rawSemantic);
  const isCommand = isCommandTool(block.name, block.input);
  const statusLabel =
    block.status === "running"
      ? "Running"
      : block.status === "error"
        ? renderFailure ? "Errored" : null
        : isCommand
          ? null
          : "Completed";
  const statusTone =
    block.status === "running"
      ? "text-cyan-700 dark:text-cyan-300"
      : renderFailure
        ? "text-red-700 dark:text-red-300"
        : "text-emerald-700 dark:text-emerald-300";
  const duration = formatTranscriptDuration(block.ts, block.endTs);
  const command = getToolCommand(block);
  const requestText = command ?? formatNiceToolRequest(block.name, block.input);
  const responseText = command
    ? formatCommandTerminalOutput(block.result)
    : block.result
      ? formatNiceToolResponse(block.name, block.input, block.result)
      : "Waiting for result...";
  const canExpand = semantic.category !== "skill";
  const detailsClass = cn(
    "space-y-3",
    renderFailure && "rounded-xl border border-red-500/20 bg-red-500/[0.06] p-3",
    detail && "rounded-xl border border-border/40 bg-background/60 p-3",
  );
  const summary = semantic.summary;
  const agentAvatarInfo = getTranscriptAgentAvatarInfo(block.name, block.input);
  const outerClass = cn(
    detail && "rounded-xl border border-border/60 bg-background/80 p-3 shadow-sm",
    renderFailure && "rounded-xl border border-red-500/20 bg-red-500/[0.04] p-3",
  );

  useEffect(() => {
    if (presentation !== "detail" && renderFailure) {
      setOpen((current) => {
        if (!current) {
          failureAutoOpenRef.current = true;
          return true;
        }
        return current;
      });
      return;
    }
    if (failureAutoOpenRef.current) {
      failureAutoOpenRef.current = false;
      setOpen(false);
    }
  }, [presentation, renderFailure]);

  const toggleOpen = () => {
    failureAutoOpenRef.current = false;
    setOpen((value) => !value);
  };

  return (
    <div className={outerClass} title={getTranscriptTimestampTitle(block.ts)}>
      <div className="flex items-start gap-2">
        {agentAvatarInfo ? (
          <span className="relative mt-0.5 h-5 w-8 shrink-0" data-transcript-action-icon-slot="true">
            <TranscriptAgentAvatarIcon info={agentAvatarInfo} status={visualStatus} />
          </span>
        ) : (
          <TranscriptActionIconSlot category={semantic.category} status={visualStatus} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[11px] font-semibold tracking-[0.06em] text-muted-foreground">
              {semantic.label}
            </span>
            {statusLabel ? (
              <span className={cn("text-[10px] font-semibold tracking-[0.05em]", statusTone)}>
                {statusLabel}
              </span>
            ) : null}
            {duration && (
              <span className="text-[10px] font-medium tracking-[0.04em] text-muted-foreground">
                {duration}
              </span>
            )}
          </div>
          <div className={cn("mt-1 truncate text-foreground/80", compact ? "text-xs" : "text-sm")} title={summary}>
            {summary}
          </div>
        </div>
        {canExpand ? (
          <button
            type="button"
            className="mt-0.5 inline-flex h-5 w-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
            onClick={toggleOpen}
            aria-expanded={open}
            aria-label={open ? `Collapse ${isCommand ? "command" : "tool"} details` : `Expand ${isCommand ? "command" : "tool"} details`}
          >
            <DisclosureChevron open={open} className="h-4 w-4" />
          </button>
        ) : null}
      </div>
      {canExpand && open && (
        <div className="motion-disclosure-enter mt-3">
          {command ? (
            <CommandTerminalDetail
              command={requestText}
              output={responseText}
              status={block.status}
              showFailureIndicators={showFailureIndicators}
              taskLabel={semantic.label}
              taskSummary={summary}
              duration={duration}
            />
          ) : (
            <div className={detailsClass}>
              <div className={cn("grid gap-3", compact ? "grid-cols-1" : "lg:grid-cols-2")}>
                <div>
                  <div className="mb-1 text-[10px] font-semibold tracking-[0.06em] text-muted-foreground">
                    Request
                  </div>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/80">
                    {requestText}
                  </pre>
                </div>
                <div>
                  <div className="mb-1 text-[10px] font-semibold tracking-[0.06em] text-muted-foreground">
                    Response
                  </div>
                  <ExpandableTranscriptResponsePre
                    text={responseText ?? "No response"}
                    className={cn(
                      renderFailure ? "text-red-700 dark:text-red-300" : "text-foreground/80",
                    )}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function hasSelectedText() {
  if (typeof window === "undefined") return false;
  return (window.getSelection()?.toString().length ?? 0) > 0;
}

export function DisclosureChevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <ChevronRight
      data-state={open ? "open" : "closed"}
      className={cn("motion-disclosure-icon", className)}
      aria-hidden
    />
  );
}

export function areAllToolEntriesErrored(entries: TranscriptToolCardEntry[]) {
  return entries.length > 0 && entries.every((entry) => entry.status === "error");
}

export function formatTranscriptLabel(label: string) {
  return label
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function TranscriptCommandGroup({
  block,
  density,
}: {
  block: Extract<TranscriptBlock, { type: "command_group" }>;
  density: TranscriptDensity;
}) {
  const showFailureIndicators = useToolCallFailureIndicators();
  const compact = density === "compact";
  const runningItem = [...block.items].reverse().find((item) => item.status === "running");
  const allToolsErrored = areAllToolEntriesErrored(block.items);
  const renderGroupFailure = showFailureIndicators && allToolsErrored;
  const [open, setOpen] = useState(renderGroupFailure);
  const failureAutoOpenRef = useRef(renderGroupFailure);
  const isRunning = Boolean(runningItem);
  const showExpandedErrorState = open && renderGroupFailure;
  const semanticItems = block.items.map((item) => {
    const semantic = describeToolSemanticInfo(item.name, item.input);
    return showFailureIndicators ? semantic : neutralizeToolFailureSemanticInfo(semantic);
  });
  const summary = formatSemanticDigest(semanticItems, 0, { preferDirectSummary: true });
  const visibleIcons = block.items.slice(0, 3).map((item, index) => {
    const semantic = semanticItems[index] ?? describeToolSemanticInfo(item.name, item.input);
    return {
      category: semantic.category,
      status: item.status === "error" && showFailureIndicators
        ? "error"
        : item.status === "running"
          ? "running"
          : "completed",
    } satisfies { category: TranscriptActionIconCategory; status: TranscriptActionIconStatus };
  });

  useEffect(() => {
    if (renderGroupFailure) {
      setOpen((current) => {
        if (!current) {
          failureAutoOpenRef.current = true;
          return true;
        }
        return current;
      });
      return;
    }
    if (failureAutoOpenRef.current) {
      failureAutoOpenRef.current = false;
      setOpen(false);
    }
  }, [renderGroupFailure]);

  const toggleOpen = () => {
    failureAutoOpenRef.current = false;
    setOpen((value) => !value);
  };

  return (
    <div className={cn(showExpandedErrorState && "rounded-xl border border-red-500/20 bg-red-500/[0.04] p-3")} title={getTranscriptTimestampTitle(block.ts)}>
      <div
        role="button"
        tabIndex={0}
        className="flex cursor-pointer items-start gap-2"
        onClick={() => {
          if (hasSelectedText()) return;
          toggleOpen();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleOpen();
          }
        }}
      >
        <TranscriptActionIconStack icons={visibleIcons} highlightError={showExpandedErrorState} />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold leading-none tracking-[0.05em] text-muted-foreground/70">
            Command activity
          </div>
          <div
            className={cn("mt-1 truncate text-foreground/85", compact ? "text-xs" : "text-sm")}
            title={summary || (isRunning ? "Working with commands" : "Command details")}
          >
            {summary || (isRunning ? "Working with commands" : "Command details")}
          </div>
        </div>
        <button
          type="button"
          className="mt-0.5 inline-flex h-5 w-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
          onClick={(event) => {
            event.stopPropagation();
            toggleOpen();
          }}
          aria-label={open ? "Collapse command details" : "Expand command details"}
        >
          <DisclosureChevron open={open} className="h-4 w-4" />
        </button>
      </div>
      {open && (
        <div className={cn("motion-disclosure-enter mt-3 space-y-3", renderGroupFailure && "rounded-xl border border-red-500/20 bg-red-500/[0.06] p-3")}>
          {block.items.map((item, index) => (
            <TranscriptToolCard
              key={`${item.ts}-${index}`}
              block={item}
              density={density}
              presentation="chat"
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function TranscriptActivityRow({
  block,
  density,
}: {
  block: Extract<TranscriptBlock, { type: "activity" }>;
  density: TranscriptDensity;
}) {
  const isImageView = block.name.replace(/[\s_-]+/g, "").toLowerCase() === "imageview";

  return (
    <div className="flex items-start gap-2" title={getTranscriptTimestampTitle(block.ts)}>
      {isImageView ? (
        <Images
          className={cn(
            "mt-0.5 h-4 w-4 shrink-0 text-muted-foreground",
            block.status === "running" && "animate-pulse text-cyan-600 dark:text-cyan-300",
          )}
          aria-hidden
        />
      ) : block.status === "completed" ? (
        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-300" />
      ) : (
        <span className="relative mt-1 flex h-2.5 w-2.5 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-70" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-cyan-500" />
        </span>
      )}
      <div
        className={cn(
          "min-w-0 flex-1 truncate text-foreground/80",
          density === "compact" ? "text-xs leading-5" : "text-sm leading-6",
        )}
        title={block.name}
      >
        {block.name}
      </div>
    </div>
  );
}

export function TranscriptTodoListRow({
  block,
  density,
  presentation = "default",
}: {
  block: Extract<TranscriptBlock, { type: "todo_list" }>;
  density: TranscriptDensity;
  presentation?: TranscriptPresentation;
}) {
  const compact = density === "compact";
  const completedCount = getTodoListCompletedCount(block.items);
  const running = block.items.some((item) => item.status === "in_progress");
  const allCompleted = block.items.length > 0 && completedCount === block.items.length;
  const detail = presentation === "detail";

  return (
    <div
      className={cn(
        "rounded-xl border border-border/45 bg-muted/10",
        detail ? "p-3" : compact ? "p-2.5" : "p-3",
      )}
      title={getTranscriptTimestampTitle(block.ts)}
    >
      <div className="flex items-center gap-2">
        {running ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-cyan-600 dark:text-cyan-300" />
        ) : allCompleted ? (
          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-300" />
        ) : (
          <span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/55" />
        )}
        <div className="min-w-0 flex-1 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground">
          Todo List
        </div>
        <div className="text-[10px] font-medium tabular-nums text-muted-foreground">
          {completedCount}/{block.items.length}
        </div>
      </div>
      <ul className={cn("mt-2 space-y-1.5", compact ? "text-xs leading-5" : "text-sm leading-6")}>
        {block.items.map((item, index) => (
          <li key={`${item.status}-${index}-${item.text}`} className="flex items-start gap-2 text-foreground/82">
            <span
              className={cn(
                "mt-[0.35em] inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border",
                item.status === "completed"
                  ? "border-emerald-500/40 bg-emerald-500/[0.10] text-emerald-700 dark:text-emerald-300"
                  : item.status === "in_progress"
                    ? "border-cyan-500/40 bg-cyan-500/[0.10] text-cyan-700 dark:text-cyan-300"
                    : "border-border bg-background text-transparent",
              )}
            >
              {item.status === "completed" ? (
                <Check className="h-2.5 w-2.5" />
              ) : item.status === "in_progress" ? (
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
              ) : (
                <span className="h-1.5 w-1.5 rounded-full" />
              )}
            </span>
            <span className={cn("min-w-0 break-words", item.status === "completed" && "text-muted-foreground line-through decoration-muted-foreground/40")}>
              {item.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TranscriptMemoryUpdateRow({
  block,
  density,
}: {
  block: Extract<TranscriptBlock, { type: "memory_update" }>;
  density: TranscriptDensity;
}) {
  const [open, setOpen] = useState(block.status === "error" && Boolean(block.failureReason));
  const compact = density === "compact";
  const isError = block.status === "error";
  const title = isError ? "Memory update failed" : "Agent memory updated";
  const scopeLabel = formatMemoryScopeLabel(block.scope);
  const agentLabel = block.agentName ?? "Agent";
  const expandedState = open ? "expanded" : "collapsed";
  const ariaLabel = `${title}, ${agentLabel}, ${scopeLabel}, ${expandedState}`;
  const paths = block.changes.map((change) => change.path);
  const tags = [agentLabel, scopeLabel, block.effect];

  return (
    <div
      data-transcript-memory-update="true"
      className={cn(
        "rounded-lg border px-2.5 py-2",
        isError
          ? "border-red-500/20 bg-red-500/[0.04]"
          : "border-border/45 bg-muted/10",
      )}
      title={getTranscriptTimestampTitle(block.ts)}
    >
      <div
        role="button"
        tabIndex={0}
        className="flex cursor-pointer items-start gap-2 text-left"
        onClick={() => {
          if (hasSelectedText()) return;
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen((value) => !value);
          }
        }}
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <TranscriptActionIconSlot category="memory" status={isError ? "error" : "completed"} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn(
              "font-semibold tracking-[0.05em]",
              compact ? "text-[11px]" : "text-xs",
              isError ? "text-red-700 dark:text-red-300" : "text-foreground/80",
            )}>
              {title}
            </span>
            <span className="hidden text-[10px] font-medium tabular-nums text-muted-foreground sm:inline">
              {formatTranscriptTimestamp(block.ts)}
            </span>
          </div>
          <div className={cn("mt-1 break-words text-foreground/82", compact ? "text-xs leading-5" : "text-sm leading-6")}>
            {isError && block.failureReason ? block.failureReason : block.summary}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex max-w-full items-center rounded-md border border-border/55 bg-background/65 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
              >
                <span className="truncate">{tag}</span>
              </span>
            ))}
          </div>
        </div>
        <button
          type="button"
          className="mt-0.5 inline-flex h-5 w-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
          onClick={(event) => {
            event.stopPropagation();
            setOpen((value) => !value);
          }}
          aria-expanded={open}
          aria-label={open ? "Collapse memory update details" : "Expand memory update details"}
        >
          <DisclosureChevron open={open} className="h-4 w-4" />
        </button>
      </div>
      {open ? (
        <div className="motion-disclosure-enter mt-2 space-y-2 border-t border-border/30 pt-2">
          {isError && block.failureReason ? (
            <div>
              <div className="mb-1 text-[10px] font-semibold text-muted-foreground">
                Failure
              </div>
              <div className="whitespace-pre-wrap break-words text-xs text-red-700 dark:text-red-300">
                {block.failureReason}
              </div>
            </div>
          ) : null}
          <div>
            <div className="mb-1 text-[10px] font-semibold text-muted-foreground">
              Paths
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/80">
              {paths.join("\n")}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function TranscriptEventRow({
  block,
  density,
  presentation = "default",
}: {
  block: Extract<TranscriptBlock, { type: "event" }>;
  density: TranscriptDensity;
  presentation?: TranscriptPresentation;
}) {
  const [open, setOpen] = useState(!block.collapseByDefault);
  const compact = density === "compact";
  const detail = presentation === "detail";
  const collapsible = block.collapseByDefault === true;
  const isFileChange = block.label === "file change";
  const preview = truncate(compactWhitespace(block.text), compact ? 96 : 140);
  const toneClasses =
    block.tone === "error"
      ? "rounded-xl border border-red-500/20 bg-red-500/[0.06] p-3 text-red-700 dark:text-red-300"
      : block.tone === "warn"
        ? "text-amber-700 dark:text-amber-300"
        : block.tone === "info"
          ? "text-sky-700 dark:text-sky-300"
          : "text-foreground/75";

  if (isFileChange) {
    const isWarn = block.tone === "warn" || block.tone === "error";
    const content = (
      <>
        <FileDiff
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            isWarn ? "text-amber-600 dark:text-amber-300" : "text-muted-foreground",
          )}
        />
        <span className={cn("shrink-0 font-medium", isWarn ? undefined : "text-muted-foreground")}>
          File change
        </span>
        <span aria-hidden className="shrink-0 text-border">
          /
        </span>
        <span className="min-w-0 flex-1 truncate">
          {preview || "Updated files"}
        </span>
        {block.detail ? (
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground">
            <DisclosureChevron open={open} className="h-3.5 w-3.5" />
          </span>
        ) : null}
      </>
    );

    return (
      <div
        data-transcript-file-change="true"
        className={cn("max-w-full", detail ? "py-0.5" : undefined)}
        title={getTranscriptTimestampTitle(block.ts)}
      >
        {block.detail ? (
          <button
            type="button"
            className={cn(
              "flex min-h-7 w-full max-w-full items-center gap-2 rounded-md px-1.5 text-left transition-colors hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
              compact ? "py-0.5 text-xs leading-5" : "py-1 text-sm leading-6",
              isWarn ? "bg-amber-500/[0.04] text-amber-800 dark:text-amber-200" : "text-foreground/72",
            )}
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} file change details: ${preview || "Updated files"}`}
          >
            {content}
          </button>
        ) : (
          <div className={cn(
            "flex min-h-7 w-full max-w-full items-center gap-2 px-1.5 text-left",
            compact ? "py-0.5 text-xs leading-5" : "py-1 text-sm leading-6",
            isWarn ? "text-amber-800 dark:text-amber-200" : "text-foreground/72",
          )}>
            {content}
          </div>
        )}
        {block.detail && open ? (
          <pre className={cn(
            "motion-disclosure-enter mt-1 max-w-full overflow-x-auto whitespace-pre-wrap break-words border-l border-border/45 py-1 pl-3 font-mono text-[11px] leading-5 text-foreground/70",
            detail ? "ml-1.5" : "ml-6",
          )}>
            {block.detail}
          </pre>
        ) : null}
      </div>
    );
  }

  return (
    <div className={toneClasses} title={getTranscriptTimestampTitle(block.ts)}>
      <div className="flex items-start gap-2">
        {block.tone === "error" ? (
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        ) : block.tone === "warn" ? (
          <TerminalSquare className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        ) : (
          <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-current/50" />
        )}
        <div className="min-w-0 flex-1">
          {collapsible && (
            <button
              type="button"
              className={cn(
                "mb-1 inline-flex max-w-full items-center gap-1 rounded-md text-left font-medium transition-colors hover:text-red-800 dark:hover:text-red-100",
                compact ? "text-[11px]" : "text-xs",
              )}
              onClick={() => setOpen((value) => !value)}
              aria-expanded={open}
              aria-label={open ? "Collapse stderr details" : "Expand stderr details"}
            >
              <DisclosureChevron open={open} className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 truncate">
                {formatTranscriptLabel(block.label)}: {preview || "Details"}
              </span>
            </button>
          )}
          {block.label === "result" && block.tone !== "error" ? (
            <div className={cn("whitespace-pre-wrap break-words text-sky-700 dark:text-sky-300", compact ? "text-[11px]" : "text-xs")}>
              {block.text}
            </div>
          ) : collapsible && !open ? null : detail ? (
            <div className={cn(collapsible && open && "motion-disclosure-enter", "whitespace-pre-wrap break-words", compact ? "text-[11px]" : "text-xs")}>
              {block.text}
            </div>
          ) : (
            <div className={cn(collapsible && open && "motion-disclosure-enter", "whitespace-pre-wrap break-words", compact ? "text-[11px]" : "text-xs")}>
              <span className="text-[10px] font-semibold tracking-[0.05em] text-muted-foreground/70">
                {formatTranscriptLabel(block.label)}
              </span>
              {block.text ? <span className="ml-2">{block.text}</span> : null}
            </div>
          )}
          {block.detail && (!collapsible || open) && (
            <pre className={cn(block.collapseByDefault && open && "motion-disclosure-enter", "mt-2 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/75")}>
              {block.detail}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

export function TranscriptStdoutRow({
  block,
  density,
  collapseByDefault,
  presentation = "default",
}: {
  block: Extract<TranscriptBlock, { type: "stdout" }>;
  density: TranscriptDensity;
  collapseByDefault: boolean;
  presentation?: TranscriptPresentation;
}) {
  const [open, setOpen] = useState(!collapseByDefault);
  const detail = presentation === "detail";

  return (
    <div title={getTranscriptTimestampTitle(block.ts)}>
      {detail ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex h-5 w-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setOpen((value) => !value)}
            aria-label={open ? "Collapse stdout details" : "Expand stdout details"}
          >
            <DisclosureChevron open={open} className="h-4 w-4" />
          </button>
          <span className="text-[10px] font-semibold tracking-[0.06em] text-muted-foreground">
            details
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold tracking-[0.06em] text-muted-foreground">
            Stdout
          </span>
          <button
            type="button"
            className="inline-flex h-5 w-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setOpen((value) => !value)}
            aria-label={open ? "Collapse stdout" : "Expand stdout"}
          >
            <DisclosureChevron open={open} className="h-4 w-4" />
          </button>
        </div>
      )}
      {open && (
        <pre className={cn(
          "motion-disclosure-enter",
          detail ? "overflow-x-auto whitespace-pre-wrap break-words font-mono text-foreground/80" : "mt-2 overflow-x-auto whitespace-pre-wrap break-words font-mono text-foreground/80",
          density === "compact" ? "text-[11px]" : "text-xs",
        )}>
          {block.text}
        </pre>
      )}
    </div>
  );
}
