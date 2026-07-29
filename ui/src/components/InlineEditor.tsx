import { useCallback, useEffect, useRef, useState } from "react";
import { useAutosaveIndicator } from "../hooks/useAutosaveIndicator";
import { normalizeMarkdownDocumentValue } from "../lib/markdown-document-value";
import type { MarkdownEditorEngine } from "../lib/markdown-editor-engine";
import { cn } from "../lib/utils";
import { MarkdownBody } from "./MarkdownBody";
import {
  MarkdownEditor,
  type MarkdownEditorRef,
  type MentionOption,
} from "./MarkdownEditor";

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
  editorEngine?: MarkdownEditorEngine;
  documentIdentity?: string;
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
  documentIdentity,
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
  const previousValueRef = useRef(value);
  const draftDirtyRef = useRef(false);
  const pendingExternalValueRef = useRef<string | null>(null);
  const suppressNextBlurSaveRef = useRef(false);
  const [hasExternalUpdate, setHasExternalUpdate] = useState(false);
  const {
    state: autosaveState,
    markDirty,
    reset,
    runSave,
  } = useAutosaveIndicator();

  const clearAutosaveDebounce = useCallback(() => {
    if (!autosaveDebounceRef.current) return;
    clearTimeout(autosaveDebounceRef.current);
    autosaveDebounceRef.current = null;
  }, []);

  useEffect(() => clearAutosaveDebounce, [clearAutosaveDebounce]);

  useEffect(() => {
    const valueChanged = previousValueRef.current !== value;
    previousValueRef.current = value;
    if (!valueChanged) return;
    const currentDraft = markdownRef.current?.getMarkdown?.() ?? draft;
    const normalizedDraft = editorEngine === "codemirror"
      ? normalizeMarkdownDocumentValue(currentDraft)
      : currentDraft.trim();
    if (
      editorEngine === "codemirror"
      && multiline
      && multilineFocused
      && draftDirtyRef.current
      && normalizedDraft !== value
    ) {
      pendingExternalValueRef.current = value;
      setHasExternalUpdate(true);
      clearAutosaveDebounce();
      return;
    }
    draftDirtyRef.current = false;
    pendingExternalValueRef.current = null;
    setHasExternalUpdate(false);
    setDraft(value);
  }, [
    clearAutosaveDebounce,
    draft,
    editorEngine,
    multiline,
    multilineFocused,
    value,
  ]);

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
    if (editorEngine === "codemirror" && alwaysEdit) return;
    const frame = requestAnimationFrame(() => {
      markdownRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [alwaysEdit, editing, editorEngine, multiline]);

  const commit = useCallback(async (nextValue = draft) => {
    const normalized = editorEngine === "codemirror"
      ? normalizeMarkdownDocumentValue(nextValue)
      : nextValue.trim();
    const hasPendingSave = pendingSaveCountRef.current > 0;
    if (normalized !== value || hasPendingSave) {
      if (hasPendingSave && latestQueuedValueRef.current === normalized) {
        await saveQueueRef.current;
      } else {
        latestQueuedValueRef.current = normalized;
        pendingSaveCountRef.current += 1;
        const queuedSave = saveQueueRef.current
          .catch(() => undefined)
          .then(async () => {
            await Promise.resolve(onSave(normalized));
          });
        saveQueueRef.current = queuedSave;
        try {
          await queuedSave;
        } finally {
          pendingSaveCountRef.current -= 1;
          if (pendingSaveCountRef.current === 0 && latestQueuedValueRef.current === normalized) {
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
  }, [draft, editorEngine, multiline, onSave, value]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !multiline) {
      e.preventDefault();
      settleSave(commit());
    }
    if (e.key === "Escape") {
      clearAutosaveDebounce();
      reset();
      suppressNextBlurSaveRef.current = true;
      draftDirtyRef.current = false;
      pendingExternalValueRef.current = null;
      setHasExternalUpdate(false);
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
    if (pendingExternalValueRef.current !== null) {
      clearAutosaveDebounce();
      return;
    }
    const normalized = editorEngine === "codemirror"
      ? normalizeMarkdownDocumentValue(draft)
      : draft.trim();
    if (explicitSaveValueRef.current === normalized) {
      explicitSaveValueRef.current = null;
      return;
    }
    if (normalized === value) {
      if (autosaveState !== "saved") {
        reset();
      }
      return;
    }
    markDirty();
    clearAutosaveDebounce();
    autosaveDebounceRef.current = setTimeout(() => {
      autosaveDebounceRef.current = null;
      settleSave(runSave(() => commit(normalized)));
    }, AUTOSAVE_DEBOUNCE_MS);

    return clearAutosaveDebounce;
  }, [autosaveState, clearAutosaveDebounce, commit, draft, editorEngine, markDirty, multiline, multilineFocused, reset, runSave, value]);

  if (multiline && (editing || editorEngine === "codemirror")) {
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
          if (suppressNextBlurSaveRef.current) {
            suppressNextBlurSaveRef.current = false;
            return;
          }
          const currentDraft = markdownRef.current?.getMarkdown?.() ?? draft;
          const normalized = editorEngine === "codemirror"
            ? normalizeMarkdownDocumentValue(currentDraft)
            : currentDraft.trim();
          if (pendingExternalValueRef.current !== null) {
            reset();
            return;
          }
          explicitSaveValueRef.current = normalized;
          if (normalized === value) {
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
            const normalized = editorEngine === "codemirror"
              ? normalizeMarkdownDocumentValue(nextDraft)
              : nextDraft.trim();
            draftDirtyRef.current = normalized !== value;
            if (!draftDirtyRef.current) {
              pendingExternalValueRef.current = null;
              setHasExternalUpdate(false);
            }
            setDraft(nextDraft);
          }}
          placeholder={placeholder}
          bordered={false}
          className="bg-transparent"
          contentClassName={markdownEditorContentClassName}
          imageUploadHandler={imageUploadHandler}
          mentions={mentions}
          onMentionQueryChange={onMentionQueryChange}
          documentIdentity={documentIdentity}
          activateInlineTokensOnPlainClick={variant === "issue-description"}
          submitShortcut="mod-enter"
          onSubmit={() => {
            clearAutosaveDebounce();
            const currentDraft = markdownRef.current?.getMarkdown?.() ?? draft;
            const normalized = editorEngine === "codemirror"
              ? normalizeMarkdownDocumentValue(currentDraft)
              : currentDraft.trim();
            pendingExternalValueRef.current = null;
            setHasExternalUpdate(false);
            explicitSaveValueRef.current = normalized;
            if (normalized === value) {
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
              autosaveState === "idle" && !hasExternalUpdate ? "opacity-0" : "opacity-100",
            )}
          >
            {autosaveState === "saving"
              ? "Autosaving..."
              : hasExternalUpdate
                ? "Updated elsewhere — submit to overwrite"
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
