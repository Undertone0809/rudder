import {
  MarkdownEditor,
  type MarkdownEditorProps,
  type MarkdownEditorRef,
} from "@/components/MarkdownEditor";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { SkillMentionOption } from "@/lib/agent-skill-mentions";
import { cn } from "@/lib/utils";
import { ArrowUp, Boxes, Loader2, Paperclip, Plus, Square } from "lucide-react";
import {
  forwardRef,
  type ClipboardEventHandler,
  type CSSProperties,
  type KeyboardEventHandler,
  type ReactNode,
  type Ref,
} from "react";

export type ChatComposerSendMode = "send" | "sending" | "stop" | "stopping" | "queue";

export const ChatComposerSurface = forwardRef<
  HTMLDivElement,
  {
    children: ReactNode;
    centered?: boolean;
    streaming?: boolean;
    fileDragActive?: boolean;
    fileDropTargetProps?: Record<string, unknown>;
    className?: string;
    testId?: string;
  }
>(function ChatComposerSurface({
  children,
  centered = false,
  streaming = false,
  fileDragActive = false,
  fileDropTargetProps,
  className,
  testId = "chat-composer-file-drop-target",
}, ref) {
  return (
    <div
      ref={ref}
      data-testid={testId}
      {...fileDropTargetProps}
      className={cn(
        "chat-composer relative rounded-[var(--radius-lg)] p-3 transition-all duration-300",
        streaming && "chat-composer--streaming",
        fileDragActive
          && "ring-2 ring-[color:var(--accent-base)] ring-offset-2 ring-offset-background",
        centered ? "mx-auto w-full max-w-3xl" : "w-full",
        className,
      )}
    >
      {children}
    </div>
  );
});

export const ChatComposerEditor = forwardRef<
  MarkdownEditorRef,
  MarkdownEditorProps & {
    scrollRef?: Ref<HTMLDivElement>;
    onKeyDownCapture?: KeyboardEventHandler<HTMLDivElement>;
    onPasteCapture?: ClipboardEventHandler<HTMLDivElement>;
    scrollTestId?: string;
  }
>(function ChatComposerEditor({
  scrollRef,
  onKeyDownCapture,
  onPasteCapture,
  scrollTestId = "chat-composer-editor-scroll",
  className,
  contentClassName,
  ...editorProps
}, ref) {
  return (
    <div
      ref={scrollRef}
      data-testid={scrollTestId}
      className="chat-composer-editor-scroll scrollbar-auto-hide overflow-y-auto overscroll-contain"
      onKeyDownCapture={onKeyDownCapture}
      onPasteCapture={onPasteCapture}
    >
      <MarkdownEditor
        ref={ref}
        {...editorProps}
        submitShortcut="enter"
        plainText
        bordered={false}
        className={cn("rounded-[var(--radius-md)] bg-transparent", className)}
        contentClassName={cn(
          "min-h-[88px] bg-transparent text-[15px] leading-7 text-foreground",
          contentClassName,
        )}
      />
    </div>
  );
});

export function ChatComposerToolbar({
  children,
  actions,
  testId = "chat-composer-toolbar",
}: {
  children: ReactNode;
  actions: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="mt-3 flex flex-wrap items-center justify-between gap-2.5"
      data-testid={testId}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {children}
      </div>
      {actions}
    </div>
  );
}

export function ChatComposerAddMenu({
  open,
  onOpenChange,
  onAddFiles,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAddFiles: () => void;
  children?: ReactNode;
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        type="button"
        className="control-hover inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-active)_52%,transparent)] text-sm font-medium text-foreground transition-[color,background-color,border-color,box-shadow,opacity,transform,scale] hover:bg-[color:var(--surface-active)] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40"
        aria-label="Add files and options"
      >
        <Plus className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        className="surface-overlay w-80 max-w-[calc(100vw-2rem)] rounded-[var(--radius-lg)] border p-1.5 text-foreground"
      >
        <DropdownMenuItem
          className="rounded-[var(--radius-md)] px-3 py-2.5"
          onSelect={(event) => {
            event.preventDefault();
            onOpenChange(false);
            window.setTimeout(onAddFiles, 0);
          }}
        >
          <Paperclip className="mr-2 h-4 w-4" />
          Add files
        </DropdownMenuItem>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ChatComposerSkillsButton({
  open,
  onClick,
  buttonRef,
}: {
  open: boolean;
  onClick: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={cn(
        "chat-chip inline-flex max-w-[min(100%,16rem)] min-w-0 items-center gap-1.5 rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[color:var(--surface-active)]",
        open && "bg-[color:var(--surface-active)]",
      )}
      aria-label="Skills"
      aria-expanded={open}
      aria-haspopup="menu"
      onClick={onClick}
    >
      <span className="min-w-0 truncate">Skills</span>
    </button>
  );
}

export function ChatComposerSkillsMenuContent({
  pending,
  skills,
  filteredSkills,
  searchQuery,
  searchInputRef,
  onSearchQueryChange,
  onSelect,
}: {
  pending: boolean;
  skills: SkillMentionOption[];
  filteredSkills: SkillMentionOption[];
  searchQuery: string;
  searchInputRef?: Ref<HTMLInputElement>;
  onSearchQueryChange: (query: string) => void;
  onSelect: (skill: SkillMentionOption) => void;
}) {
  return (
    <>
      <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">Skills</div>
      {pending ? (
        <div className="flex items-center gap-2 rounded-[var(--radius-md)] px-3 py-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading skills...</span>
        </div>
      ) : skills.length === 0 ? (
        <div className="rounded-[var(--radius-md)] px-3 py-2 text-sm leading-6 text-muted-foreground">
          This agent has no enabled skills.
        </div>
      ) : (
        <>
          <div className="px-2 pb-2">
            <input
              ref={searchInputRef}
              className="w-full rounded-[var(--radius-md)] border border-border bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-ring"
              placeholder="Search skills..."
              value={searchQuery}
              onChange={(event) => onSearchQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") event.stopPropagation();
              }}
            />
          </div>
          <div>
            {filteredSkills.length === 0 ? (
              <div className="rounded-[var(--radius-md)] px-3 py-2 text-sm leading-6 text-muted-foreground">
                No skills match search.
              </div>
            ) : filteredSkills.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="menuitem"
                data-chat-composer-menu-item
                className="chat-composer-menu-row"
                onClick={() => onSelect(entry)}
              >
                <Boxes className="h-4 w-4 shrink-0 text-[#2f80ed]" />
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="min-w-0 shrink truncate font-medium text-foreground">
                    {entry.skillDisplayName}
                  </span>
                  {entry.skillCategoryLabel ? (
                    <span className="inline-flex shrink-0 items-center rounded-[var(--radius-sm)] border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground">
                      {entry.skillCategoryLabel}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {entry.skillDescription
                      ?? entry.skillLocationLabel
                      ?? entry.skillRefLabel}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}

export function ChatComposerContextMenu({
  children,
  menuRef,
  testId,
  ariaLabel,
  position,
  onKeyDown,
}: {
  children: ReactNode;
  menuRef?: Ref<HTMLDivElement>;
  testId?: string;
  ariaLabel?: string;
  position: CSSProperties;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
}) {
  return (
    <div
      ref={menuRef}
      data-testid={testId}
      role="menu"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className="chat-composer-context-menu motion-chat-composer-menu-pop surface-overlay fixed z-50 overflow-y-auto rounded-[var(--radius-lg)] border p-1.5 text-foreground"
      style={position}
    >
      {children}
    </div>
  );
}

export function ChatComposerSendButton({
  mode,
  disabled,
  onClick,
  stoppingComplete = false,
  ariaLabel,
}: {
  mode: ChatComposerSendMode;
  disabled: boolean;
  onClick: () => void;
  stoppingComplete?: boolean;
  ariaLabel?: string;
}) {
  const busy = mode === "sending" || (mode === "stopping" && !stoppingComplete);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={onClick}
      disabled={disabled}
      aria-busy={busy ? true : undefined}
      aria-label={ariaLabel ?? (
        mode === "sending"
          ? "Sending"
          : mode === "stopping"
          ? stoppingComplete
            ? "Response stopped"
            : "Stopping response"
            : mode === "stop"
              ? "Stop streaming"
              : mode === "queue"
                ? "Queue"
                : "Send"
      )}
      className={cn(
        "shrink-0 rounded-full border-0 bg-white text-black shadow-sm",
        "hover:bg-zinc-100 dark:bg-white dark:text-black dark:hover:bg-zinc-100",
        "disabled:pointer-events-none disabled:opacity-35",
        "focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--surface-page)]",
        busy && "disabled:opacity-100",
      )}
    >
      {busy ? (
        <Loader2 className="h-[18px] w-[18px] animate-spin" strokeWidth={2.25} />
      ) : mode === "stop" || mode === "stopping" ? (
        <Square className="h-3.5 w-3.5 fill-current" />
      ) : (
        <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.25} />
      )}
    </Button>
  );
}
