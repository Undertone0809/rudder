import { useCallback, useEffect, useRef, useState } from "react";
import { useAutosaveIndicator } from "../hooks/useAutosaveIndicator";
import { cn } from "../lib/utils";
import { MarkdownBody } from "./MarkdownBody";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";

interface InlineEditorProps {
  value: string;
  onSave: (value: string) => void | Promise<unknown>;
  as?: "h1" | "h2" | "p" | "span";
  className?: string;
  placeholder?: string;
  multiline?: boolean;
  imageUploadHandler?: (file: File) => Promise<string>;
  mentions?: MentionOption[];
  onMentionQueryChange?: (query: string | null) => void;
  editorEngine?: "legacy" | "milkdown";
  alwaysEdit?: boolean;
  variant?: "default" | "issue-description";
}

/** Shared padding so display and edit modes occupy the exact same box. */
const pad = "px-1 -mx-1";
const markdownPad = pad;
const AUTOSAVE_DEBOUNCE_MS = 900;

function eventTargetElement(target: EventTarget | null): HTMLElement | null {
  if (target instanceof HTMLElement) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function settleSave(promise: Promise<void>) {
  void promise.catch(() => undefined);
}

export function InlineEditor({
  value,
  onSave,
  as: Tag = "span",
  className,
  placeholder = "Click to edit...",
  multiline = false,
  imageUploadHandler,
  mentions,
  onMentionQueryChange,
  editorEngine,
  alwaysEdit = false,
  variant = "default",
}: InlineEditorProps) {
  const [editing, setEditing] = useState(alwaysEdit);
  const [multilineFocused, setMultilineFocused] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const markdownRef = useRef<MarkdownEditorRef>(null);
  const autosaveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const latestQueuedValueRef = useRef<string | null>(null);
  const pendingSaveCountRef = useRef(0);
  const explicitSaveValueRef = useRef<string | null>(null);
  const hasDraftChangeRef = useRef(false);
  const previousValueRef = useRef(value);
  const {
    state: autosaveState,
    markDirty,
    reset,
    runSave,
  } = useAutosaveIndicator();

  useEffect(() => {
    const valueChanged = previousValueRef.current !== value;
    previousValueRef.current = value;
    if (!valueChanged) return;
    if (multiline && multilineFocused) return;
    hasDraftChangeRef.current = false;
    setDraft(value);
  }, [value, multiline, multilineFocused]);

  const clearAutosaveDebounce = useCallback(() => {
    if (!autosaveDebounceRef.current) return;
    clearTimeout(autosaveDebounceRef.current);
    autosaveDebounceRef.current = null;
  }, []);

  useEffect(() => clearAutosaveDebounce, [clearAutosaveDebounce]);

  const autoSize = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  const markdownSurfaceClassName = cn(
    "rudder-inline-markdown-surface rounded",
    variant === "issue-description" && "rudder-issue-description-surface",
  );
  const markdownBodyClassName = cn(
    "rudder-inline-markdown-body",
    variant === "issue-description" && "rudder-issue-description-markdown rudder-issue-description-markdown-read",
  );
  const markdownEditorContentClassName = cn(
    "rudder-edit-in-place-content",
    variant === "issue-description" && "rudder-issue-description-markdown rudder-issue-description-markdown-edit",
    className,
  );

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
      if (inputRef.current instanceof HTMLTextAreaElement) {
        autoSize(inputRef.current);
      }
    }
  }, [editing, autoSize]);

  useEffect(() => {
    if (!editing || !multiline) return;
    const frame = requestAnimationFrame(() => {
      markdownRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [editing, multiline]);

  const commit = useCallback(async (nextValue = draft) => {
    const trimmed = nextValue.trim();
    const hasPendingSave = pendingSaveCountRef.current > 0;
    if (trimmed !== value || hasPendingSave) {
      if (hasPendingSave && latestQueuedValueRef.current === trimmed) {
        await saveQueueRef.current;
      } else {
        latestQueuedValueRef.current = trimmed;
        pendingSaveCountRef.current += 1;
        const queuedSave = saveQueueRef.current
          .catch(() => undefined)
          .then(async () => {
            await Promise.resolve(onSave(trimmed));
          });
        saveQueueRef.current = queuedSave;
        try {
          await queuedSave;
        } finally {
          pendingSaveCountRef.current -= 1;
          if (pendingSaveCountRef.current === 0 && latestQueuedValueRef.current === trimmed) {
            latestQueuedValueRef.current = null;
          }
        }
      }
    } else {
      setDraft(value);
    }
    if (!multiline) {
      setEditing(false);
    }
  }, [draft, multiline, onSave, value]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !multiline) {
      e.preventDefault();
      settleSave(commit());
    }
    if (e.key === "Escape") {
      clearAutosaveDebounce();
      reset();
      setDraft(value);
      if (multiline) {
        setMultilineFocused(false);
        if (!alwaysEdit) {
          setEditing(false);
        }
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      } else {
        setEditing(false);
      }
    }
  }

  useEffect(() => {
    if (!multiline) return;
    if (!multilineFocused) return;
    const trimmed = draft.trim();
    if (explicitSaveValueRef.current === trimmed) {
      explicitSaveValueRef.current = null;
      return;
    }
    if (trimmed === value) {
      if (autosaveState !== "saved") {
        reset();
      }
      return;
    }
    markDirty();
    clearAutosaveDebounce();
    autosaveDebounceRef.current = setTimeout(() => {
      autosaveDebounceRef.current = null;
      settleSave(runSave(() => commit(trimmed)));
    }, AUTOSAVE_DEBOUNCE_MS);

    return clearAutosaveDebounce;
  }, [autosaveState, clearAutosaveDebounce, commit, draft, markDirty, multiline, multilineFocused, reset, runSave, value]);

  if (multiline && editing) {
    return (
      <div
        className={cn(
          markdownPad,
          markdownSurfaceClassName,
        )}
        onFocusCapture={() => setMultilineFocused(true)}
        onBlurCapture={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          clearAutosaveDebounce();
          setMultilineFocused(false);
          if (!alwaysEdit) {
            setEditing(false);
          }
          const currentDraft = hasDraftChangeRef.current
            ? markdownRef.current?.getMarkdown?.() ?? draft
            : draft;
          const trimmed = currentDraft.trim();
          explicitSaveValueRef.current = trimmed;
          if (trimmed === value) {
            reset();
            settleSave(commit(currentDraft));
            return;
          }
          settleSave(runSave(() => commit(currentDraft)));
        }}
        onKeyDown={handleKeyDown}
      >
        <MarkdownEditor
          ref={markdownRef}
          engine={editorEngine}
          value={draft}
          onChange={(nextDraft) => {
            explicitSaveValueRef.current = null;
            hasDraftChangeRef.current = true;
            setDraft(nextDraft);
          }}
          placeholder={placeholder}
          bordered={false}
          className="bg-transparent"
          contentClassName={markdownEditorContentClassName}
          imageUploadHandler={imageUploadHandler}
          mentions={mentions}
          onMentionQueryChange={onMentionQueryChange}
          activateInlineTokensOnPlainClick={variant === "issue-description"}
          submitShortcut="mod-enter"
          onSubmit={() => {
            clearAutosaveDebounce();
            const currentDraft = markdownRef.current?.getMarkdown?.() ?? draft;
            const trimmed = currentDraft.trim();
            explicitSaveValueRef.current = trimmed;
            if (trimmed === value) {
              reset();
              settleSave(commit(currentDraft));
              return;
            }
            settleSave(runSave(() => commit(currentDraft)));
          }}
        />
        <div className="flex min-h-4 items-center justify-end pr-1">
          <span
            className={cn(
              "text-[11px] transition-opacity duration-150",
              autosaveState === "error" ? "text-destructive" : "text-muted-foreground",
              autosaveState === "idle" ? "opacity-0" : "opacity-100",
            )}
          >
            {autosaveState === "saving"
              ? "Autosaving..."
              : autosaveState === "saved"
                ? "Saved"
                : autosaveState === "error"
                  ? "Could not save"
                  : "Idle"}
          </span>
        </div>
      </div>
    );
  }

  if (editing) {

    return (
      <textarea
        ref={inputRef}
        value={draft}
        rows={1}
        onChange={(e) => {
          setDraft(e.target.value);
          autoSize(e.target);
        }}
        onBlur={() => {
          settleSave(commit());
        }}
        onKeyDown={handleKeyDown}
        className={cn(
          "w-full bg-transparent rounded outline-none resize-none overflow-hidden",
          pad,
          className
        )}
      />
    );
  }

  // Use div instead of Tag when rendering markdown to avoid invalid nesting
  // (e.g. <p> cannot contain the <div>/<p> elements that markdown produces)
  const DisplayTag = value && multiline ? "div" : Tag;

  return (
    <DisplayTag
      className={cn(
        multiline ? markdownSurfaceClassName : "rounded overflow-hidden",
        multiline
          ? "cursor-text"
          : "cursor-pointer transition-colors hover:bg-accent/50",
        pad,
        className,
        multiline && !value && "min-h-9 py-1 text-muted-foreground italic",
        !multiline && !value && "text-muted-foreground italic",
      )}
      onClick={(event) => {
        if (eventTargetElement(event.target)?.closest("a")) return;
        setEditing(true);
      }}
    >
      {value && multiline ? (
        <MarkdownBody
          className={markdownBodyClassName}
          copyMarkdownOnCopy
          onLinkClick={({ event }) => {
            event.stopPropagation();
          }}
        >
          {value}
        </MarkdownBody>
      ) : (
        value || placeholder
      )}
    </DisplayTag>
  );
}
