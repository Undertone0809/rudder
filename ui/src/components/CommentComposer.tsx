import { Button } from "@/components/ui/button";
import { Paperclip } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ChangeEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";

const DEFAULT_ATTACHMENT_ACCEPT = "image/*,application/pdf,text/plain,text/markdown,application/json,text/csv,text/html,.md,.markdown";
const MOBILE_EDITOR_MIN_HEIGHT_PX = 30;
const MOBILE_EDITOR_MAX_HEIGHT_PX = 160;
const MOBILE_EDITOR_MAX_VIEWPORT_RATIO = 0.24;

export interface CommentComposerProps {
  body: string;
  onBodyChange: (body: string) => void;
  onSubmit: () => void | Promise<void>;
  canSubmit: boolean;
  submitting: boolean;
  editorRef?: RefObject<MarkdownEditorRef | null>;
  surfaceRef?: RefObject<HTMLDivElement | null>;
  ariaLabel?: string;
  editorAriaLabel?: string;
  placeholder?: string;
  submitLabel?: string;
  mentions?: MentionOption[];
  onMentionQueryChange?: (query: string | null) => void;
  imageUploadHandler?: (file: File) => Promise<string>;
  onAttachFile?: (file: File) => Promise<void>;
  onAttachmentError?: (error: Error, file: File) => void;
  attachmentAccept?: string;
  attachmentAriaLabel?: string;
  attachmentMultiple?: boolean;
  attachmentStatus?: ReactNode;
  beforeSubmit?: ReactNode;
  secondaryAction?: ReactNode;
  escapeBackWhenEmpty?: boolean;
  detailEscapeLayer?: boolean;
  testId?: string;
}

function shouldForwardComposerFocus(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return !target.closest([
    "a",
    "button",
    "input",
    "textarea",
    "select",
    "[contenteditable='true']",
    "[role='button']",
    "[role='menuitem']",
    "[data-chat-composer-menu-item]",
  ].join(","));
}

export function CommentComposer({
  body,
  onBodyChange,
  onSubmit,
  canSubmit,
  submitting,
  editorRef,
  surfaceRef,
  ariaLabel = "Comment composer",
  editorAriaLabel,
  placeholder = "Leave a comment...",
  submitLabel = "Comment",
  mentions,
  onMentionQueryChange,
  imageUploadHandler,
  onAttachFile,
  onAttachmentError,
  attachmentAccept = DEFAULT_ATTACHMENT_ACCEPT,
  attachmentAriaLabel = "Attach file",
  attachmentMultiple = true,
  attachmentStatus,
  beforeSubmit,
  secondaryAction,
  escapeBackWhenEmpty = false,
  detailEscapeLayer = false,
  testId,
}: CommentComposerProps) {
  const ownEditorRef = useRef<MarkdownEditorRef>(null);
  const ownSurfaceRef = useRef<HTMLDivElement>(null);
  const attachInputRef = useRef<HTMLInputElement>(null);
  const activeEditorRef = editorRef ?? ownEditorRef;
  const activeSurfaceRef = surfaceRef ?? ownSurfaceRef;
  const [attaching, setAttaching] = useState(false);
  const [editorScrollElement, setEditorScrollElement] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!editorScrollElement || typeof ResizeObserver === "undefined") return;
    let animationFrame: number | null = null;
    let observedContent: HTMLElement | null = null;

    const syncHeight = () => {
      if (!observedContent) return;
      const maxHeight = Math.min(
        window.innerHeight * MOBILE_EDITOR_MAX_VIEWPORT_RATIO,
        MOBILE_EDITOR_MAX_HEIGHT_PX,
      );
      const nextHeight = Math.max(
        MOBILE_EDITOR_MIN_HEIGHT_PX,
        Math.min(Math.ceil(observedContent.scrollHeight), maxHeight),
      );
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        editorScrollElement.style.setProperty("--comment-composer-editor-height", `${nextHeight}px`);
        animationFrame = null;
      });
    };

    const resizeObserver = new ResizeObserver(syncHeight);
    const observeEditorContent = () => {
      const nextContent = editorScrollElement.querySelector<HTMLElement>(
        ".rudder-milkdown-content, .rudder-mdxeditor-content, .rudder-codemirror-markdown-content",
      );
      if (nextContent === observedContent) return;
      resizeObserver.disconnect();
      observedContent = nextContent;
      if (observedContent) {
        resizeObserver.observe(observedContent);
        syncHeight();
      }
    };

    const mutationObserver = new MutationObserver(observeEditorContent);
    mutationObserver.observe(editorScrollElement, { childList: true, subtree: true });
    window.addEventListener("resize", syncHeight, { passive: true });
    observeEditorContent();

    return () => {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      window.removeEventListener("resize", syncHeight);
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    };
  }, [editorScrollElement]);

  const focusComposerEditor = (event: MouseEvent<HTMLDivElement>) => {
    if (!shouldForwardComposerFocus(event.target)) return;
    event.preventDefault();
    activeEditorRef.current?.focus();
  };

  async function handleAttachFile(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    setAttaching(true);
    try {
      if (imageUploadHandler) {
        const snippets: string[] = [];
        for (const file of files) {
          try {
            const url = await imageUploadHandler(file);
            const safeName = file.name.replace(/[[\]]/g, "\\$&");
            snippets.push(file.type.startsWith("image/")
              ? `![${safeName}](${url})`
              : `[${safeName}](${url})`);
          } catch (error) {
            onAttachmentError?.(error instanceof Error ? error : new Error("Attachment upload failed"), file);
          }
        }
        if (snippets.length > 0) {
          const currentBody = activeEditorRef.current?.getMarkdown?.() ?? body;
          const markdown = snippets.join("\n\n");
          onBodyChange(currentBody ? `${currentBody}\n\n${markdown}` : markdown);
        }
      } else if (onAttachFile) {
        for (const file of files) {
          try {
            await onAttachFile(file);
          } catch (error) {
            onAttachmentError?.(error instanceof Error ? error : new Error("Attachment upload failed"), file);
          }
        }
      }
    } finally {
      setAttaching(false);
      if (attachInputRef.current) attachInputRef.current.value = "";
      requestAnimationFrame(() => activeEditorRef.current?.focus());
    }
  }

  return (
    <div
      ref={activeSurfaceRef}
      aria-label={ariaLabel}
      className="chat-composer grid min-w-0 grid-cols-[var(--control-height-sm)_minmax(0,1fr)_auto] items-end gap-x-1.5 rounded-[var(--radius-lg)] p-2 md:block md:p-3"
      data-composer-state={body.trim() ? "composing" : "empty"}
      data-issue-detail-escape-back={escapeBackWhenEmpty ? (body.trim() ? "dirty" : "empty") : undefined}
      data-detail-escape-layer={detailEscapeLayer ? "true" : undefined}
      data-testid={testId}
      onMouseDown={focusComposerEditor}
      tabIndex={-1}
    >
      <div
        ref={setEditorScrollElement}
        data-testid="issue-comment-composer-editor-scroll"
        className="motion-comment-composer-height scrollbar-auto-hide relative col-start-2 row-start-1 h-[var(--comment-composer-editor-height)] min-w-0 max-h-[min(24dvh,10rem)] overflow-y-auto overscroll-contain pr-1 md:h-auto md:max-h-[min(38dvh,22rem)]"
        style={{ "--comment-composer-editor-height": "1.875rem" } as CSSProperties}
      >
        {!body.trim() ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-0 z-10 flex items-start pt-px text-sm text-muted-foreground md:hidden"
          >
            {placeholder}
          </span>
        ) : null}
        <MarkdownEditor
          ref={activeEditorRef}
          engine="milkdown"
          value={body}
          onChange={onBodyChange}
          ariaLabel={editorAriaLabel}
          placeholder={placeholder}
          mentions={mentions}
          agentMentionIntent="wake"
          onMentionQueryChange={onMentionQueryChange}
          mentionMenuAnchorRef={activeSurfaceRef}
          mentionMenuPlacement="container"
          onSubmit={onSubmit}
          imageUploadHandler={imageUploadHandler}
          className="rounded-[var(--radius-md)] bg-transparent"
          contentClassName="min-h-7 bg-transparent text-sm leading-6 text-foreground md:min-h-16"
          bordered={false}
        />
      </div>
      {attachmentStatus ? <div className="col-span-3 mt-2 md:mt-2">{attachmentStatus}</div> : null}
      <div className="contents md:mt-3 md:flex md:items-center md:justify-end md:gap-3">
        {(imageUploadHandler || onAttachFile) ? (
          <div className="col-start-1 row-start-1 flex items-center self-end md:mr-auto md:gap-3">
            <input
              ref={attachInputRef}
              type="file"
              accept={attachmentAccept}
              aria-label={attachmentAriaLabel}
              multiple={attachmentMultiple}
              className="hidden"
              onChange={handleAttachFile}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => attachInputRef.current?.click()}
              disabled={attaching || submitting}
              title="Attach file"
            >
              <Paperclip className="h-4 w-4" />
            </Button>
          </div>
        ) : null}
        {beforeSubmit}
        <div className="col-start-3 row-start-1 flex items-center gap-1.5 self-end">
          {secondaryAction}
          <Button type="button" size="sm" disabled={!canSubmit || attaching} onClick={onSubmit}>
            {submitting ? "Posting..." : submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
