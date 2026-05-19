import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from "react";
import { Milkdown, MilkdownProvider, useEditor, useInstance } from "@milkdown/react";
import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { insert, replaceAll } from "@milkdown/kit/utils";
import {
  buildAgentMentionHref,
  buildIssueMentionHref,
  buildLibraryDocMentionHref,
  buildLibraryFileMentionHref,
  buildProjectMentionHref,
} from "@rudderhq/shared";
import { Boxes, FileText } from "lucide-react";
import { useI18n } from "@/context/I18nContext";
import { translateLegacyString } from "@/i18n/legacyPhrases";
import { useScrollbarActivityRef } from "../hooks/useScrollbarActivityRef";
import { issueStatusIcon, issueStatusIconDefault } from "../lib/status-colors";
import { projectColorBackgroundStyle } from "../lib/project-colors";
import { cn } from "../lib/utils";
import { AgentIcon } from "./AgentIconPicker";
import type { MarkdownEditorProps, MarkdownEditorRef, MentionOption } from "./MarkdownEditor";
import {
  getMentionMenuPositionForViewport,
  getMentionPanelPositionForViewport,
} from "../lib/mention-menu-position";

type MentionState = {
  trigger: "@" | "$";
  query: string;
  top: number;
  left: number;
  viewportTop: number;
  viewportBottom: number;
  viewportLeft: number;
  textNode: Text;
  atPos: number;
  endPos: number;
};

function mentionTokenDetails(option: MentionOption): { href: string; label: string } | null {
  if (option.kind === "skill") {
    if (!option.skillMarkdownTarget || !option.skillRefLabel) return null;
    return { href: option.skillMarkdownTarget, label: option.skillRefLabel };
  }
  if (option.kind === "issue" && option.issueId) {
    return { href: buildIssueMentionHref(option.issueId, option.issueIdentifier ?? null), label: option.name };
  }
  if (option.kind === "library_doc" && option.libraryDocumentId) {
    return {
      href: buildLibraryDocMentionHref(option.libraryDocumentId, option.libraryDocumentTitle ?? option.name),
      label: option.name,
    };
  }
  if (option.kind === "library_file" && option.libraryFilePath) {
    return { href: buildLibraryFileMentionHref(option.libraryFilePath, option.name), label: option.name };
  }
  if (option.kind === "project" && option.projectId) {
    return { href: buildProjectMentionHref(option.projectId, option.projectColor ?? null), label: option.name };
  }
  const agentId = option.agentId ?? option.id.replace(/^agent:/, "");
  return { href: buildAgentMentionHref(agentId, option.agentIcon ?? null), label: option.name };
}

export function mentionMarkdown(option: MentionOption): string {
  const token = mentionTokenDetails(option);
  return token ? `[${token.label}](${token.href}) ` : "";
}

function getAllSubstringIndexes(value: string, search: string): number[] {
  const indexes: number[] = [];
  let index = value.indexOf(search);
  while (index !== -1) {
    indexes.push(index);
    index = value.indexOf(search, index + search.length);
  }
  return indexes;
}

function applyMention(markdown: string, state: MentionState, option: MentionOption): string {
  const search = `${state.trigger}${state.query}`;
  const replacement = mentionMarkdown(option);
  if (!replacement) return markdown;
  const indexes = getAllSubstringIndexes(markdown, search);
  if (indexes.length === 0) {
    const text = state.textNode.textContent ?? "";
    if (!text) return markdown;
    return text.slice(0, state.atPos) + replacement + text.slice(state.endPos);
  }
  const index = indexes[indexes.length - 1]!;
  const replacementEnd = index + search.length;
  const replaceLength = replacement.endsWith(" ") && markdown[replacementEnd] === " "
    ? search.length + 1
    : search.length;
  return markdown.slice(0, index) + replacement + markdown.slice(index + replaceLength);
}

function detectMention(container: HTMLElement): MentionState | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return null;

  const range = selection.getRangeAt(0);
  const textNode = range.startContainer;
  if (textNode.nodeType !== Node.TEXT_NODE) return null;
  if (!container.contains(textNode)) return null;

  const text = textNode.textContent ?? "";
  const offset = range.startOffset;
  let atPos = -1;
  let trigger: MentionState["trigger"] | null = null;

  for (let index = offset - 1; index >= 0; index -= 1) {
    const char = text[index];
    if (char === "@" || char === "$") {
      if (index === 0 || /\s/.test(text[index - 1] ?? "")) {
        atPos = index;
        trigger = char;
      }
      break;
    }
    if (/\s/.test(char ?? "")) break;
  }

  if (atPos === -1 || !trigger) return null;
  const query = text.slice(atPos + 1, offset);
  if (/[\n\r()[\]{}]/.test(query)) return null;

  const caretRange = range.cloneRange();
  const rect = caretRange.getBoundingClientRect();
  return {
    trigger,
    query,
    top: rect.bottom + 4,
    left: rect.left,
    viewportTop: rect.top,
    viewportBottom: rect.bottom,
    viewportLeft: rect.left,
    textNode: textNode as Text,
    atPos,
    endPos: offset,
  };
}

function hasFilePayload(evt: DragEvent<HTMLDivElement> | ClipboardEvent<HTMLDivElement>) {
  if ("dataTransfer" in evt) return Array.from(evt.dataTransfer?.types ?? []).includes("Files");
  return Array.from(evt.clipboardData?.types ?? []).includes("Files");
}

function firstImageFile(files: FileList | null | undefined) {
  return Array.from(files ?? []).find((file) => file.type.startsWith("image/")) ?? null;
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

const MilkdownEditorInner = forwardRef<MarkdownEditorRef, MarkdownEditorProps>(function MilkdownEditorInner({
  value,
  onChange,
  placeholder,
  className,
  contentClassName,
  onBlur,
  imageUploadHandler,
  bordered = true,
  mentions,
  onMentionQueryChange,
  mentionMenuAnchorRef,
  mentionMenuPlacement = "caret",
  onSubmit,
  submitShortcut = "mod-enter",
}: MarkdownEditorProps, forwardedRef) {
  const { locale } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const latestValueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onBlurRef = useRef(onBlur);
  const imageUploadHandlerRef = useRef(imageUploadHandler);
  const [mentionState, setMentionState] = useState<MentionState | null>(null);
  const mentionStateRef = useRef<MentionState | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const mentionMenuRef = useScrollbarActivityRef();
  const translatedPlaceholder = useMemo(
    () => (placeholder ? translateLegacyString(locale, placeholder) : undefined),
    [locale, placeholder],
  );

  useEffect(() => {
    onChangeRef.current = onChange;
    onBlurRef.current = onBlur;
    imageUploadHandlerRef.current = imageUploadHandler;
  }, [imageUploadHandler, onBlur, onChange]);

  const { get } = useEditor((root) =>
    Editor
      .make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, value);
        const listenerManager = ctx.get(listenerCtx);
        listenerManager.markdownUpdated((_ctx, markdown) => {
          latestValueRef.current = markdown;
          onChangeRef.current(markdown);
        });
        listenerManager.blur(() => {
          onBlurRef.current?.();
        });
      })
      .use(listener)
      .use(history)
      .use(commonmark)
      .use(gfm),
  []);

  const [loading, getInstance] = useInstance();

  const focus = useCallback(() => {
    const editor = loading ? get() : getInstance();
    editor?.action((ctx) => {
      ctx.get(editorViewCtx).focus();
    });
  }, [get, getInstance, loading]);

  useImperativeHandle(forwardedRef, () => ({ focus }), [focus]);

  useEffect(() => {
    if (value === latestValueRef.current) return;
    latestValueRef.current = value;
    const editor = loading ? get() : getInstance();
    editor?.action(replaceAll(value, true));
  }, [get, getInstance, loading, value]);

  const filteredMentions = useMemo(() => {
    if (!mentionState || !mentions) return [];
    const query = mentionState.query.toLowerCase();
    return mentions
      .filter((mention) => {
        if (mentionState.trigger === "$") return mention.kind === "skill";
        const searchText = (mention.searchText ?? mention.name).toLowerCase();
        return searchText.includes(query);
      })
      .slice(0, 8);
  }, [mentionState, mentions]);

  const mentionMenuPosition = useMemo(() => {
    if (!mentionState) return null;
    if (mentionMenuPlacement === "container") {
      const anchor = mentionMenuAnchorRef?.current ?? containerRef.current;
      const rect = anchor?.getBoundingClientRect();
      if (rect) {
        return getMentionPanelPositionForViewport(
          {
            viewportTop: rect.top,
            viewportBottom: rect.bottom,
            viewportLeft: rect.left,
            viewportRight: rect.right,
          },
          window.innerWidth,
          window.innerHeight,
        );
      }
    }
    return getMentionMenuPositionForViewport(mentionState, window.innerWidth, window.innerHeight);
  }, [mentionMenuAnchorRef, mentionMenuPlacement, mentionState]);

  const groupedMentionOptions = useMemo(() => {
    const labelForKind = (kind: MentionOption["kind"]) => {
      if (kind === "skill") return "Skills";
      if (kind === "project") return "Projects";
      if (kind === "issue") return "Issues";
      if (kind === "library_doc" || kind === "library_file") return "Docs";
      return "Agents";
    };

    const groups: Array<{ label: string; options: MentionOption[] }> = [];
    for (const option of filteredMentions) {
      const label = labelForKind(option.kind);
      const existing = groups.find((group) => group.label === label);
      if (existing) {
        existing.options.push(option);
      } else {
        groups.push({ label, options: [option] });
      }
    }
    return groups;
  }, [filteredMentions]);

  useEffect(() => {
    onMentionQueryChange?.(mentionState?.trigger === "@" ? mentionState.query : null);
  }, [mentionState?.query, mentionState?.trigger, onMentionQueryChange]);

  const checkMention = useCallback(() => {
    if (!mentions || mentions.length === 0) {
      mentionStateRef.current = null;
      setMentionState(null);
      return;
    }
    const editable = containerRef.current?.querySelector('[contenteditable="true"]');
    const next = editable instanceof HTMLElement ? detectMention(editable) : null;
    mentionStateRef.current = next;
    setMentionState(next);
    if (next) setMentionIndex(0);
  }, [mentions]);

  const selectMention = useCallback((option: MentionOption) => {
    const state = mentionStateRef.current;
    if (!state) return;
    const replacement = mentionMarkdown(option);
    if (!replacement) return;
    const next = applyMention(latestValueRef.current, state, option);
    if (next !== latestValueRef.current) {
      latestValueRef.current = next;
      onChangeRef.current(next);
    }
    const editor = loading ? get() : getInstance();
    const triggerText = `${state.trigger}${state.query}`;
    editor?.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { from, to } = view.state.selection;
      const start = Math.max(0, from - triggerText.length);
      view.dispatch(view.state.tr.delete(start, to));
    });
    editor?.action(insert(replacement.trimEnd(), false));
    editor?.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { from } = view.state.selection;
      view.dispatch(view.state.tr.insertText(" ", from));
    });
    requestAnimationFrame(() => focus());
    mentionStateRef.current = null;
    setMentionState(null);
  }, [focus, get, getInstance, loading]);

  const uploadImage = useCallback(async (file: File) => {
    const handler = imageUploadHandlerRef.current;
    if (!handler) return;
    try {
      const src = await handler(file);
      setUploadError(null);
      const markdown = `![${file.name}](${src})\n\n`;
      const editor = loading ? get() : getInstance();
      editor?.action(insert(markdown, false));
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Image upload failed");
    }
  }, [get, getInstance, loading]);

  const canDropImage = Boolean(imageUploadHandler);

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative rudder-milkdown-scope",
        bordered ? "rounded-md border border-border bg-transparent" : "bg-transparent",
        isDragOver && "bg-accent/20 ring-1 ring-primary/60",
        className,
      )}
      onKeyDownCapture={(event) => {
        const shouldSubmitOnModEnter =
          submitShortcut === "mod-enter" && event.key === "Enter" && (event.metaKey || event.ctrlKey);
        const shouldSubmitOnEnter =
          submitShortcut === "enter"
          && event.key === "Enter"
          && !event.shiftKey
          && !event.ctrlKey
          && !event.metaKey
          && !event.altKey;

        if (onSubmit && (shouldSubmitOnModEnter || shouldSubmitOnEnter)) {
          event.preventDefault();
          event.stopPropagation();
          onSubmit();
          return;
        }

        if (mentionState && filteredMentions.length > 0) {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setMentionIndex((index) => Math.min(index + 1, filteredMentions.length - 1));
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setMentionIndex((index) => Math.max(index - 1, 0));
            return;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            selectMention(filteredMentions[mentionIndex]!);
            return;
          }
        }

        if (mentionState && event.key === "Escape") {
          event.preventDefault();
          mentionStateRef.current = null;
          setMentionState(null);
        }
      }}
      onKeyUpCapture={checkMention}
      onMouseUpCapture={checkMention}
      onPasteCapture={(event) => {
        if (!canDropImage || !hasFilePayload(event)) return;
        const file = firstImageFile(event.clipboardData.files);
        if (!file) return;
        event.preventDefault();
        void uploadImage(file);
      }}
      onDragEnter={(event) => {
        if (!canDropImage || !hasFilePayload(event)) return;
        setIsDragOver(true);
      }}
      onDragOver={(event) => {
        if (!canDropImage || !hasFilePayload(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => {
        setIsDragOver(false);
      }}
      onDrop={(event) => {
        setIsDragOver(false);
        if (!canDropImage || !hasFilePayload(event)) return;
        const file = firstImageFile(event.dataTransfer.files);
        if (!file) return;
        event.preventDefault();
        void uploadImage(file);
      }}
    >
      <div
        className={cn(
          "rudder-milkdown-content focus:outline-none [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5",
          !bordered && "rudder-milkdown-content--borderless",
          contentClassName,
        )}
        data-placeholder={translatedPlaceholder}
      >
        <Milkdown />
      </div>
      {uploadError ? (
        <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {uploadError}
        </div>
      ) : null}
      {mentionState && filteredMentions.length > 0 && mentionMenuPosition ? (
        <div
          ref={mentionMenuRef}
          role={mentionMenuPlacement === "container" ? "menu" : "listbox"}
          data-testid="markdown-mention-menu"
          className={cn(
            "scrollbar-auto-hide fixed z-[70] overflow-y-auto rounded-lg border border-border p-1.5 shadow-lg",
            mentionMenuPlacement === "container"
              ? "chat-composer-context-menu motion-chat-composer-menu-pop surface-overlay text-foreground"
              : "bg-popover text-popover-foreground",
          )}
          style={mentionMenuPosition}
        >
          {(() => {
            let optionIndex = 0;
            return groupedMentionOptions.map((group) => (
              <div key={group.label} className="py-0.5">
                {mentionMenuPlacement === "container" ? (
                  <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
                    {group.label}
                  </div>
                ) : null}
                {group.options.map((option) => {
                  const index = optionIndex;
                  optionIndex += 1;
                  const issueStatusLabel = option.issueStatus ? statusLabel(option.issueStatus) : "Issue";
                  const isContainerMenu = mentionMenuPlacement === "container";
                  const skillDescription = option.skillDescription
                    ?? option.skillLocationLabel
                    ?? option.skillDisplayName
                    ?? option.name;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role={isContainerMenu ? "menuitem" : "option"}
                      aria-selected={isContainerMenu ? undefined : index === mentionIndex}
                      data-testid={`markdown-mention-option-${option.id}`}
                      data-mention-option-index={index}
                      data-chat-composer-menu-item={isContainerMenu ? true : undefined}
                      className={cn(
                        isContainerMenu
                          ? "chat-composer-menu-row"
                          : "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                        index === mentionIndex
                          ? isContainerMenu
                            ? "bg-[color:var(--surface-active)] text-foreground"
                            : "bg-accent text-accent-foreground"
                          : "hover:bg-accent/60",
                      )}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        selectMention(option);
                      }}
                      onMouseEnter={() => setMentionIndex(index)}
                    >
                      {option.kind === "skill" && isContainerMenu ? (
                        <>
                          <Boxes className="h-4 w-4 shrink-0 text-[#2f80ed]" />
                          <span className="flex min-w-0 flex-1 items-center gap-2">
                            <span className="min-w-0 shrink truncate font-medium text-foreground">
                              {option.skillDisplayName ?? option.name}
                            </span>
                            {option.skillCategoryLabel ? (
                              <span className="inline-flex shrink-0 items-center rounded-[var(--radius-sm)] border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground">
                                {option.skillCategoryLabel}
                              </span>
                            ) : null}
                            <span className="min-w-0 flex-1 truncate text-muted-foreground">
                              {skillDescription}
                            </span>
                          </span>
                        </>
                      ) : option.kind === "skill" ? (
                        <Boxes className="h-4 w-4 shrink-0 text-[#2f80ed]" />
                      ) : option.kind === "project" && option.projectId ? (
                        <span
                          className="inline-flex h-2.5 w-2.5 shrink-0 rounded-full border border-border/50"
                          style={projectColorBackgroundStyle(option.projectColor)}
                        />
                      ) : option.kind === "issue" && option.issueId ? (
                        <span
                          className={cn(
                            "relative inline-flex h-4 w-4 shrink-0 rounded-full border-2",
                            option.issueStatus ? issueStatusIcon[option.issueStatus] ?? issueStatusIconDefault : issueStatusIconDefault,
                          )}
                          aria-label={`Status: ${issueStatusLabel}`}
                        >
                          {option.issueStatus === "done" ? (
                            <span className="absolute inset-0 m-auto h-2 w-2 rounded-full bg-current" />
                          ) : null}
                        </span>
                      ) : option.kind === "library_file" ? (
                        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                      ) : option.kind === "library_doc" ? (
                        <Boxes className="h-4 w-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <AgentIcon
                          icon={option.agentIcon}
                          role={option.agentRole}
                          className="h-4 w-4 shrink-0 text-muted-foreground"
                        />
                      )}
                      {!(option.kind === "skill" && isContainerMenu) ? (
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium text-foreground">{option.name}</div>
                          {option.kind === "issue" && option.issueId ? (
                            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                              {option.issueStatus ? <span>{issueStatusLabel}</span> : null}
                              {option.issueProjectName ? (
                                <span className="inline-flex min-w-0 items-center gap-1">
                                  <span
                                    className="h-2 w-2 shrink-0 rounded-full border border-border/50"
                                    style={{ backgroundColor: option.issueProjectColor ?? "#64748b" }}
                                    aria-hidden="true"
                                  />
                                  <span className="truncate">{option.issueProjectName}</span>
                                </span>
                              ) : null}
                              <span className="inline-flex min-w-0 items-center gap-1">
                                {option.issueAssigneeIcon ? (
                                  <AgentIcon
                                    icon={option.issueAssigneeIcon}
                                    role={option.issueAssigneeRole}
                                    className="h-3 w-3 shrink-0 text-muted-foreground"
                                  />
                                ) : null}
                                <span className="truncate">{option.issueAssigneeName ?? "Unassigned"}</span>
                              </span>
                            </div>
                          ) : null}
                          {option.kind === "skill" ? (
                            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                              {option.skillCategoryLabel ? (
                                <span className="inline-flex shrink-0 items-center rounded-[var(--radius-sm)] border border-border/70 bg-muted/50 px-1.5 py-0.5 leading-none">
                                  {option.skillCategoryLabel}
                                </span>
                              ) : null}
                              <span className="min-w-0 truncate">
                                {option.skillDescription ?? option.skillLocationLabel ?? option.skillDisplayName}
                              </span>
                            </div>
                          ) : null}
                          {option.kind === "library_doc" || option.kind === "library_file" ? (
                            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                              {option.libraryFilePath ?? option.libraryDocumentPath ?? "Library doc"}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                      {option.kind === "issue" && option.issueId ? (
                        <span className="ml-auto text-[11px] text-muted-foreground">Issue</span>
                      ) : null}
                      {option.kind === "project" && option.projectId ? (
                        <span className="ml-auto text-[11px] text-muted-foreground">Project</span>
                      ) : null}
                      {((option.kind === "library_doc" && option.libraryDocumentId)
                        || (option.kind === "library_file" && option.libraryFilePath)) ? (
                        <span className="ml-auto text-[11px] text-muted-foreground">Doc</span>
                      ) : null}
                      {option.kind === "skill" && !isContainerMenu ? (
                        <span className="ml-auto text-[11px] text-muted-foreground">Skill</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ));
          })()}
        </div>
      ) : null}
    </div>
  );
});

export const MilkdownMarkdownEditor = forwardRef<MarkdownEditorRef, MarkdownEditorProps>(function MilkdownMarkdownEditor(
  props,
  ref,
) {
  return (
    <MilkdownProvider>
      <MilkdownEditorInner {...props} ref={ref} />
    </MilkdownProvider>
  );
});
