import { Button } from "@/components/ui/button";
import { Paperclip } from "lucide-react";
import { useRef, useState, type ChangeEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";

const DEFAULT_ATTACHMENT_ACCEPT = "image/*,application/pdf,text/plain,text/markdown,application/json,text/csv,text/html,.md,.markdown";

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
      className="chat-composer min-w-0 rounded-[var(--radius-lg)] p-3"
      data-issue-detail-escape-back={escapeBackWhenEmpty ? (body.trim() ? "dirty" : "empty") : undefined}
      data-detail-escape-layer={detailEscapeLayer ? "true" : undefined}
      data-testid={testId}
      onMouseDown={focusComposerEditor}
      tabIndex={-1}
    >
      <div
        data-testid="issue-comment-composer-editor-scroll"
        className="scrollbar-auto-hide max-h-[min(38dvh,22rem)] overflow-y-auto overscroll-contain pr-1"
      >
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
          contentClassName="min-h-[64px] bg-transparent text-sm leading-6 text-foreground"
          bordered={false}
        />
      </div>
      {attachmentStatus ? <div className="mt-2">{attachmentStatus}</div> : null}
      <div className="mt-3 flex items-center justify-end gap-3">
        {(imageUploadHandler || onAttachFile) ? (
          <div className="mr-auto flex items-center gap-3">
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
        <Button type="button" size="sm" disabled={!canSubmit || attaching} onClick={onSubmit}>
          {submitting ? "Posting..." : submitLabel}
        </Button>
      </div>
    </div>
  );
}
