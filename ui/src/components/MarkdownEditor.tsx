import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  CodeMirrorEditor,
  MDXEditor,
  codeBlockPlugin,
  codeMirrorPlugin,
  type CodeBlockEditorDescriptor,
  type MDXEditorMethods,
  headingsPlugin,
  imagePlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
  type Translation,
  type RealmPlugin,
  type MdastImportVisitor,
  realmPlugin,
  addImportVisitor$,
  createRootEditorSubscription$,
} from "@mdxeditor/editor";
import { Boxes } from "lucide-react";
import { buildAgentMentionHref, buildIssueMentionHref, buildProjectMentionHref, type AgentRole } from "@rudderhq/shared";
import { useI18n } from "@/context/I18nContext";
import { translateLegacyString } from "@/i18n/legacyPhrases";
import { ImagePreviewDialog, type ImagePreviewState } from "@/components/ImagePreviewDialog";
import { AgentIcon } from "./AgentIconPicker";
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $setSelection,
  type LexicalEditor,
  type LexicalNode,
  type TextNode,
} from "lexical";
import {
  applyMentionChipDecoration,
  clearMentionChipDecoration,
  parseMentionChipHref,
  stripMentionChipLabelPrefix,
} from "../lib/mention-chips";
import { MentionAwareLinkNode, mentionAwareLinkNodeReplacement } from "../lib/mention-aware-link-node";
import { mentionDeletionPlugin } from "../lib/mention-deletion";
import { $createMentionTokenNode, mentionTokenPlugin } from "../lib/mention-token-node";
import { issueStatusIcon, issueStatusIconDefault } from "../lib/status-colors";
import { projectColorBackgroundStyle } from "../lib/project-colors";
import {
  applySkillTokenDecoration,
  clearSkillTokenDecoration,
  parseSkillReference,
} from "../lib/skill-reference";
import {
  findAdjacentAtomicInlineTokenElement,
  readAtomicInlineTokenElement,
  removeAtomicInlineTokenFromMarkdown,
  type AtomicInlineTokenElement,
} from "../lib/inline-token-dom";
import { $createSkillTokenNode, skillTokenPlugin } from "../lib/skill-token-node";
import { useScrollbarActivityRef } from "../hooks/useScrollbarActivityRef";
import { cn } from "../lib/utils";
import { MentionOption, MarkdownEditorProps, MarkdownEditorRef, CaretTarget, INLINE_CARET_BOUNDARY, escapeRegExp, isSafeMarkdownLinkUrl, normalizePlainTextComposerMarkdown, findCanonicalReferenceCandidates, hasCanonicalRudderReference, getMdastSourceSlice, getMdastLinkLabel, appendPlainTextMarkdownNode, plainTextMarkdownImportPlugin, canonicalMarkdownFromFragment, getLastCaretTarget, placeCaretNearInlineToken, getVisibleTextOffsetBeforeNode, getVisibleTextOffsetAtPosition, findFirstTextNodeInSubtree, findFirstTextNodeAfterNode, placeCaretAfterAtomicInlineToken, placeCaretAtVisibleTextOffset, LexicalTextPosition, findLexicalTextPositionAtOffset, selectLexicalTextOffset, focusLexicalTextOffset, closestAtomicInlineToken, AtomicInlineTokenEvent, stopAtomicInlineTokenEvent, MentionState, MENTION_MENU_MIN_WIDTH, MENTION_MENU_DEFAULT_WIDTH, MENTION_MENU_MAX_HEIGHT, MENTION_PANEL_MAX_HEIGHT, MENTION_MENU_VIEWPORT_PADDING, MENTION_MENU_OFFSET, MENTION_PANEL_OFFSET, MentionMenuAnchor, MentionMenuContainerAnchor, CODE_BLOCK_LANGUAGES, FALLBACK_CODE_BLOCK_DESCRIPTOR, EmptyImageToolbar, mdxEditorTranslations, detectMention, clamp, getPreviewImageName, getMentionMenuPositionForViewport, getMentionPanelPositionForViewport, getMentionPanelPosition, getMentionMenuPosition, statusLabel, mentionMarkdown, mentionVisibleLabel, mentionTokenDetails, getAllSubstringIndexes, countSubstringOccurrences, commonSuffixLength, commonPrefixLength, getVisibleMentionOrdinal, findActiveMentionIndex, applyMention, replaceMentionInLexicalEditor, rootEditorCapturePlugin } from "./MarkdownEditor.parts";

export type {
  MentionOption,
  MarkdownEditorRef,
} from "./MarkdownEditor.parts";
export {
  getMentionMenuPositionForViewport,
  getMentionPanelPositionForViewport,
} from "./MarkdownEditor.parts";

/* ---- Mention types ---- */

export const MarkdownEditor = forwardRef<MarkdownEditorRef, MarkdownEditorProps>(function MarkdownEditor({
  value,
  onChange,
  placeholder,
  className,
  contentClassName,
  onBlur,
  imageUploadHandler,
  bordered = true,
  mentions,
  mentionMenuAnchorRef,
  mentionMenuPlacement = "caret",
  onSubmit,
  submitShortcut = "mod-enter",
  plainText = false,
  onInlineTokenClick,
}: MarkdownEditorProps, forwardedRef) {
  const { locale } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const ref = useRef<MDXEditorMethods>(null);
  const lexicalEditorRef = useRef<LexicalEditor | null>(null);
  const latestValueRef = useRef(value);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [imagePreview, setImagePreview] = useState<ImagePreviewState | null>(null);
  const dragDepthRef = useRef(0);

  // Stable ref for imageUploadHandler so plugins don't recreate on every render
  const imageUploadHandlerRef = useRef(imageUploadHandler);
  imageUploadHandlerRef.current = imageUploadHandler;

  // Mention state (ref kept in sync so callbacks always see the latest value)
  const [mentionState, setMentionState] = useState<MentionState | null>(null);
  const mentionStateRef = useRef<MentionState | null>(null);
  const pendingMentionInputRef = useRef<{
    markdownOffset: number;
    visibleOffset: number;
  } | null>(null);
  const pendingMentionInputClearTimerRef = useRef<number | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionMenuElementRef = useRef<HTMLDivElement | null>(null);
  const mentionMenuScrollbarRef = useScrollbarActivityRef();
  const setMentionMenuElement = useCallback((element: HTMLDivElement | null) => {
    mentionMenuElementRef.current = element;
    mentionMenuScrollbarRef(element);
  }, [mentionMenuScrollbarRef]);
  const mentionActive = mentionState !== null && mentions && mentions.length > 0;
  const mentionOptionByKey = useMemo(() => {
    const map = new Map<string, MentionOption>();
    for (const mention of mentions ?? []) {
      if (mention.kind === "agent") {
        const agentId = mention.agentId ?? mention.id.replace(/^agent:/, "");
        map.set(`agent:${agentId}`, mention);
      }
      if (mention.kind === "issue" && mention.issueId) {
        map.set(`issue:${mention.issueId}`, mention);
      }
      if (mention.kind === "project" && mention.projectId) {
        map.set(`project:${mention.projectId}`, mention);
      }
    }
    return map;
  }, [mentions]);

  const filteredMentions = useMemo(() => {
    if (!mentionState || !mentions) return [];
    const q = mentionState.query.toLowerCase();
    return mentions
      .filter((mention) => {
        if (mentionState.trigger === "$") {
          if (mention.kind !== "skill") return false;
        }
        const searchText = (mention.searchText ?? mention.name).toLowerCase();
        return searchText.includes(q);
      })
      .slice(0, 8);
  }, [mentionState?.query, mentionState?.trigger, mentions]);
  const mentionMenuPosition = useMemo(
    () => {
      if (!mentionState) return null;
      if (mentionMenuPlacement === "container") {
        const anchor = mentionMenuAnchorRef?.current ?? containerRef.current;
        if (anchor) return getMentionPanelPosition(anchor);
      }
      return getMentionMenuPosition(mentionState);
    },
    [mentionMenuAnchorRef, mentionMenuPlacement, mentionState],
  );
  const groupedMentionOptions = useMemo(() => {
    const labelForKind = (kind: MentionOption["kind"]) => {
      if (kind === "skill") return "Skills";
      if (kind === "project") return "Projects";
      if (kind === "issue") return "Issues";
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
    if (!mentionActive || filteredMentions.length === 0) return;
    const menu = mentionMenuElementRef.current;
    if (!menu) return;
    const option = menu.querySelector(`[data-mention-option-index="${mentionIndex}"]`);
    if (!(option instanceof HTMLElement)) return;
    if (typeof option.scrollIntoView !== "function") return;
    option.scrollIntoView({ block: "nearest" });
  }, [filteredMentions.length, mentionActive, mentionIndex]);

  const focusEditorAtEnd = useCallback(() => {
    ref.current?.focus(undefined, { defaultSelection: "rootEnd" });

    requestAnimationFrame(() => {
      const editable = containerRef.current?.querySelector('[contenteditable="true"]');
      if (!(editable instanceof HTMLElement)) return;

      editable.focus();
      const selection = window.getSelection();
      if (!selection) return;

      const target = getLastCaretTarget(editable);
      const range = document.createRange();
      if (target.kind === "text") {
        range.setStart(target.node, target.offset);
      } else if (target.kind === "after") {
        range.setStartAfter(target.node);
      } else {
        range.setStart(target.node, target.offset);
      }
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    });
  }, []);

  const clearPendingMentionInputSoon = useCallback(() => {
    if (pendingMentionInputClearTimerRef.current !== null) {
      window.clearTimeout(pendingMentionInputClearTimerRef.current);
    }
    pendingMentionInputClearTimerRef.current = window.setTimeout(() => {
      pendingMentionInputRef.current = null;
      pendingMentionInputClearTimerRef.current = null;
    }, 750);
  }, []);

  const clearPendingMentionInput = useCallback(() => {
    if (pendingMentionInputClearTimerRef.current !== null) {
      window.clearTimeout(pendingMentionInputClearTimerRef.current);
      pendingMentionInputClearTimerRef.current = null;
    }
    pendingMentionInputRef.current = null;
  }, []);

  const insertPendingMentionText = useCallback((text: string) => {
    const pendingMentionInput = pendingMentionInputRef.current;
    if (!pendingMentionInput) return false;

    const current = latestValueRef.current;
    const next = current.slice(0, pendingMentionInput.markdownOffset)
      + text
      + current.slice(pendingMentionInput.markdownOffset);
    pendingMentionInput.markdownOffset += text.length;
    pendingMentionInput.visibleOffset += text.length;
    latestValueRef.current = next;
    ref.current?.setMarkdown(next);
    onChange(next);
    clearPendingMentionInputSoon();

    requestAnimationFrame(() => {
      const editable = containerRef.current?.querySelector('[contenteditable="true"]');
      if (!(editable instanceof HTMLElement)) return;
      const lexicalEditor = lexicalEditorRef.current;
      if (lexicalEditor) {
        focusLexicalTextOffset(lexicalEditor, pendingMentionInput.visibleOffset);
      } else {
        ref.current?.focus(() => {
          selectLexicalTextOffset(pendingMentionInput.visibleOffset);
        }, { defaultSelection: "rootEnd", preventScroll: true });
      }
      placeCaretAtVisibleTextOffset(editable, pendingMentionInput.visibleOffset);
    });
    return true;
  }, [clearPendingMentionInputSoon, onChange]);

  const removeAtomicToken = useCallback((token: AtomicInlineTokenElement) => {
    const current = latestValueRef.current;
    const next = removeAtomicInlineTokenFromMarkdown(current, token);
    if (next === current) return false;

    const editable = containerRef.current?.querySelector('[contenteditable="true"]');
    const caretOffset = editable instanceof HTMLElement && editable.contains(token.element)
      ? getVisibleTextOffsetBeforeNode(editable, token.element)
      : null;

    const restoreCaret = () => {
      const currentEditable = containerRef.current?.querySelector('[contenteditable="true"]');
      if (currentEditable instanceof HTMLElement && caretOffset !== null) {
        ref.current?.focus(() => {
          selectLexicalTextOffset(caretOffset);
        }, { defaultSelection: "rootEnd" });
        placeCaretAtVisibleTextOffset(currentEditable, caretOffset);
        return;
      }
      focusEditorAtEnd();
    };

    latestValueRef.current = next;
    if (plainText && caretOffset !== null) {
      const insertionOffset = Math.min(caretOffset, next.length);
      pendingMentionInputRef.current = {
        markdownOffset: insertionOffset,
        visibleOffset: insertionOffset,
      };
      clearPendingMentionInputSoon();
    }
    ref.current?.setMarkdown(next);
    onChange(next);
    restoreCaret();
    requestAnimationFrame(() => {
      restoreCaret();
      requestAnimationFrame(restoreCaret);
    });
    return true;
  }, [clearPendingMentionInputSoon, focusEditorAtEnd, onChange, plainText]);

  const removeAdjacentAtomicToken = useCallback((direction: "backward" | "forward") => {
    const selection = window.getSelection();
    const token = findAdjacentAtomicInlineTokenElement(selection, direction);
    if (!token) return false;
    return removeAtomicToken(token);
  }, [removeAtomicToken]);

  useImperativeHandle(forwardedRef, () => ({
    focus: () => {
      focusEditorAtEnd();
    },
  }), [focusEditorAtEnd]);

  // Whether the image plugin should be included (boolean is stable across renders
  // as long as the handler presence doesn't toggle)
  const hasImageUpload = Boolean(imageUploadHandler);
  const translatedPlaceholder = useMemo(
    () => (placeholder ? translateLegacyString(locale, placeholder) : undefined),
    [locale, placeholder],
  );

  const plugins = useMemo<RealmPlugin[]>(() => {
    const imageHandler = hasImageUpload
      ? async (file: File) => {
          const handler = imageUploadHandlerRef.current;
          if (!handler) throw new Error("No image upload handler");
          try {
            const src = await handler(file);
            setUploadError(null);
            // After MDXEditor inserts the image, ensure two newlines follow it
            // so the cursor isn't stuck right next to the image.
            setTimeout(() => {
              const current = latestValueRef.current;
              const escapedSrc = escapeRegExp(src);
              const updated = current.replace(
                new RegExp(`(!\\[[^\\]]*\\]\\(${escapedSrc}\\))(?!\\n\\n)`, "g"),
                "$1\n\n",
              );
              if (updated !== current) {
                latestValueRef.current = updated;
                ref.current?.setMarkdown(updated);
                onChange(updated);
                requestAnimationFrame(() => {
                  focusEditorAtEnd();
                });
              }
            }, 100);
            return src;
          } catch (err) {
            const message = err instanceof Error ? err.message : "Image upload failed";
            setUploadError(message);
            throw err;
          }
        }
      : undefined;
    const all: RealmPlugin[] = [
      rootEditorCapturePlugin((editor) => {
        lexicalEditorRef.current = editor;
      }),
      ...(plainText
        ? [plainTextMarkdownImportPlugin(() => latestValueRef.current)]
        : [
            headingsPlugin(),
            listsPlugin(),
            quotePlugin(),
            tablePlugin(),
            linkPlugin({ validateUrl: isSafeMarkdownLinkUrl }),
            linkDialogPlugin({ showLinkTitleField: false }),
          ]),
      mentionTokenPlugin(),
      skillTokenPlugin(),
      mentionDeletionPlugin(),
      ...(plainText
        ? []
        : [
            thematicBreakPlugin(),
            codeBlockPlugin({
              defaultCodeBlockLanguage: "txt",
              codeBlockEditorDescriptors: [FALLBACK_CODE_BLOCK_DESCRIPTOR],
            }),
            codeMirrorPlugin({ codeBlockLanguages: CODE_BLOCK_LANGUAGES }),
            markdownShortcutPlugin(),
          ]),
    ];
    if (imageHandler) {
      all.push(imagePlugin({ imageUploadHandler: imageHandler, EditImageToolbar: EmptyImageToolbar }));
    }
    return all;
  }, [focusEditorAtEnd, hasImageUpload, plainText]);

  useEffect(() => {
    if (value !== latestValueRef.current) {
      ref.current?.setMarkdown(value);
      latestValueRef.current = value;
    }
  }, [value]);

  useEffect(() => {
    if (!plainText) return;

    const handleCopy = (event: ClipboardEvent) => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
      const editable = containerRef.current?.querySelector('[contenteditable="true"]');
      if (!(editable instanceof HTMLElement)) return;
      if (!editable.contains(selection.anchorNode) || !editable.contains(selection.focusNode)) return;

      const canonicalText = canonicalMarkdownFromFragment(selection.getRangeAt(0).cloneContents());
      if (!canonicalText) return;
      event.clipboardData?.setData("text/plain", canonicalText);
      event.preventDefault();
    };

    document.addEventListener("copy", handleCopy, true);
    return () => document.removeEventListener("copy", handleCopy, true);
  }, [plainText]);

  const decorateInlineTokens = useCallback(() => {
    const editable = containerRef.current?.querySelector('[contenteditable="true"]');
    if (!editable) return;
    const links = editable.querySelectorAll("a");
    for (const node of links) {
      const link = node as HTMLAnchorElement;
      const parsed = parseMentionChipHref(link.getAttribute("href") ?? "");
      if (!parsed) {
        clearMentionChipDecoration(link);

        const skillReference = parseSkillReference(link.getAttribute("href") ?? "", link.textContent ?? "");
        if (skillReference) {
          applySkillTokenDecoration(link, skillReference.href);
          continue;
        }

        clearSkillTokenDecoration(link);
        continue;
      } else {
        clearSkillTokenDecoration(link);

        if (parsed.kind === "project") {
          const option = mentionOptionByKey.get(`project:${parsed.projectId}`);
          applyMentionChipDecoration(link, {
            ...parsed,
            color: parsed.color ?? option?.projectColor ?? null,
          });
          continue;
        }

        if (parsed.kind === "issue") {
          applyMentionChipDecoration(link, parsed);
          continue;
        }

        if (parsed.kind === "chat") {
          applyMentionChipDecoration(link, parsed);
          continue;
        }

        const option = mentionOptionByKey.get(`agent:${parsed.agentId}`);
        applyMentionChipDecoration(link, {
          ...parsed,
          icon: parsed.icon ?? option?.agentIcon ?? null,
        });
        continue;
      }

      clearMentionChipDecoration(link);
      clearSkillTokenDecoration(link);
    }
  }, [mentionOptionByKey]);

  // Mention detection: listen for selection changes and input events
  const checkMention = useCallback(() => {
    if (!mentions || mentions.length === 0 || !containerRef.current) {
      mentionStateRef.current = null;
      setMentionState(null);
      return;
    }
    const result = detectMention(containerRef.current);
    mentionStateRef.current = result;
    if (result) {
      setMentionState(result);
      setMentionIndex(0);
    } else {
      setMentionState(null);
    }
  }, [mentions]);

  useEffect(() => {
    if (!mentions || mentions.length === 0) return;

    const el = containerRef.current;
    // Listen for input events on the container so mention detection
    // also fires after typing (e.g. space to dismiss).
    const onInput = () => requestAnimationFrame(checkMention);

    document.addEventListener("selectionchange", checkMention);
    el?.addEventListener("input", onInput, true);
    return () => {
      document.removeEventListener("selectionchange", checkMention);
      el?.removeEventListener("input", onInput, true);
    };
  }, [checkMention, mentions]);

  useEffect(() => {
    if (!mentionActive) return;

    const repositionMentionMenu = () => {
      requestAnimationFrame(checkMention);
    };

    window.addEventListener("resize", repositionMentionMenu);
    window.addEventListener("scroll", repositionMentionMenu, true);
    return () => {
      window.removeEventListener("resize", repositionMentionMenu);
      window.removeEventListener("scroll", repositionMentionMenu, true);
    };
  }, [checkMention, mentionActive]);

  useEffect(() => {
    const editable = containerRef.current?.querySelector('[contenteditable="true"]');
    if (!editable) return;
    decorateInlineTokens();
    const observer = new MutationObserver(() => {
      decorateInlineTokens();
    });
    observer.observe(editable, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, [decorateInlineTokens, value]);

  useEffect(() => {
    const editable = containerRef.current?.querySelector('[contenteditable="true"]');
    if (!(editable instanceof HTMLElement)) return;

    const handleNativeKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Backspace" && event.key !== "Delete") return;
      const direction = event.key === "Backspace" ? "backward" : "forward";
      if (!removeAdjacentAtomicToken(direction)) return;
      event.preventDefault();
      event.stopPropagation();
    };

    const handleNativeBeforeInput = (event: InputEvent) => {
      if (event.inputType !== "deleteContentBackward" && event.inputType !== "deleteContentForward") {
        return;
      }
      const direction = event.inputType === "deleteContentBackward" ? "backward" : "forward";
      if (!removeAdjacentAtomicToken(direction)) return;
      event.preventDefault();
      event.stopPropagation();
    };

    editable.addEventListener("keydown", handleNativeKeyDown, true);
    editable.addEventListener("beforeinput", handleNativeBeforeInput, true);
    return () => {
      editable.removeEventListener("keydown", handleNativeKeyDown, true);
      editable.removeEventListener("beforeinput", handleNativeBeforeInput, true);
    };
  }, [removeAdjacentAtomicToken, value]);

  const selectMention = useCallback(
    (option: MentionOption) => {
      // Read from ref to avoid stale-closure issues (selectionchange can
      // update state between the last render and this callback firing).
      const state = mentionStateRef.current;
      if (!state) return;
      const current = latestValueRef.current;
      const editable = containerRef.current?.querySelector('[contenteditable="true"]');
      const editableElement = editable instanceof HTMLElement ? editable : null;
      const visibleMentionStart = editableElement && editableElement.contains(state.textNode)
        ? getVisibleTextOffsetAtPosition(editableElement, state.textNode, state.atPos)
        : null;
      const replacement = mentionMarkdown(option);
      const activeMarkdownIndex = findActiveMentionIndex(current, state, editableElement);
      const next = applyMention(current, state, option, editableElement);
      const editorNext = plainText && activeMarkdownIndex !== -1
        ? next.slice(0, activeMarkdownIndex + replacement.length)
          + INLINE_CARET_BOUNDARY
          + next.slice(activeMarkdownIndex + replacement.length)
        : next;
      const fallbackCaretOffset = visibleMentionStart !== null
        ? visibleMentionStart + mentionVisibleLabel(option).length + 1
        : null;
      let didReplaceInLexical = false;
      if (next !== current) {
        latestValueRef.current = next;
        if (activeMarkdownIndex !== -1 && visibleMentionStart !== null) {
          pendingMentionInputRef.current = {
            markdownOffset: activeMarkdownIndex + replacement.length,
            visibleOffset: visibleMentionStart + mentionVisibleLabel(option).length + 1,
          };
          clearPendingMentionInputSoon();
        }
        const lexicalEditor = lexicalEditorRef.current;
        didReplaceInLexical = Boolean(lexicalEditor && editableElement
          ? replaceMentionInLexicalEditor(lexicalEditor, state, option, editableElement)
          : false);
        if (!didReplaceInLexical) {
          ref.current?.setMarkdown(editorNext);
        }
        onChange(next);
        if (didReplaceInLexical && editorNext !== next) {
          ref.current?.setMarkdown(editorNext);
        }
      }

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const editable = containerRef.current?.querySelector('[contenteditable="true"]');
          if (!(editable instanceof HTMLElement)) return;
          decorateInlineTokens();
          editable.focus();

          const findMatchingTargets = (editableRoot: HTMLElement) => option.kind === "skill"
            ? Array.from(editableRoot.querySelectorAll("[data-skill-token='true']"))
              .filter((node): node is HTMLElement => node instanceof HTMLElement)
              .filter((node) => node.textContent?.trim() === (option.skillRefLabel ?? option.name))
            : (() => {
                const visibleLabel = mentionVisibleLabel(option);
                const mentionHref = option.kind === "project" && option.projectId
                  ? buildProjectMentionHref(option.projectId, option.projectColor ?? null)
                  : option.kind === "issue" && option.issueId
                    ? buildIssueMentionHref(option.issueId, option.issueIdentifier ?? null)
                    : buildAgentMentionHref(
                        option.agentId ?? option.id.replace(/^agent:/, ""),
                        option.agentIcon ?? null,
                      );
                return Array.from(editableRoot.querySelectorAll("a, [data-mention-href]"))
                  .filter((node): node is HTMLElement => node instanceof HTMLElement)
                  .filter((link) => {
                    const href = link.dataset.mentionHref ?? link.getAttribute("href") ?? "";
                    return href === mentionHref && stripMentionChipLabelPrefix(link.textContent ?? "") === visibleLabel;
                  });
              })();
          const matchingTargets = findMatchingTargets(editable);
          const containerRect = containerRef.current?.getBoundingClientRect();
          const sortByMentionAnchorDistance = (targets: HTMLElement[]) => targets.sort((a, b) => {
            const rectA = a.getBoundingClientRect();
            const rectB = b.getBoundingClientRect();
            const leftA = containerRect ? rectA.left - containerRect.left : rectA.left;
            const topA = containerRect ? rectA.top - containerRect.top : rectA.top;
            const leftB = containerRect ? rectB.left - containerRect.left : rectB.left;
            const topB = containerRect ? rectB.top - containerRect.top : rectB.top;
            const distA = Math.hypot(leftA - state.left, topA - state.top);
            const distB = Math.hypot(leftB - state.left, topB - state.top);
            return distA - distB;
          });
          const target = sortByMentionAnchorDistance(matchingTargets)[0] ?? null;

          const caretOffset = target
            ? getVisibleTextOffsetBeforeNode(editable, target) + mentionVisibleLabel(option).length + 1
            : fallbackCaretOffset;
          if (caretOffset === null) return;
          const restoreFallbackCaretAfterMention = () => {
            const currentEditable = containerRef.current?.querySelector('[contenteditable="true"]');
            if (!(currentEditable instanceof HTMLElement)) return;
            const lexicalEditor = lexicalEditorRef.current;
            if (lexicalEditor) {
              focusLexicalTextOffset(lexicalEditor, caretOffset);
            } else {
              ref.current?.focus(() => {
                selectLexicalTextOffset(caretOffset);
              }, { defaultSelection: "rootEnd", preventScroll: true });
            }
            const currentTarget = target && currentEditable.contains(target)
              ? target
              : sortByMentionAnchorDistance(findMatchingTargets(currentEditable))[0] ?? null;
            if (currentTarget && closestAtomicInlineToken(currentTarget)) {
              placeCaretAfterAtomicInlineToken(currentEditable, currentTarget);
              return;
            }
            placeCaretAtVisibleTextOffset(currentEditable, caretOffset);
          };

          restoreFallbackCaretAfterMention();
          requestAnimationFrame(() => {
            restoreFallbackCaretAfterMention();
            requestAnimationFrame(() => {
              restoreFallbackCaretAfterMention();
            });
          });
        });
      });

      mentionStateRef.current = null;
      setMentionState(null);
    },
    [clearPendingMentionInputSoon, decorateInlineTokens, onChange],
  );

  function hasFilePayload(evt: DragEvent<HTMLDivElement>) {
    return Array.from(evt.dataTransfer?.types ?? []).includes("Files");
  }

  const canDropImage = Boolean(imageUploadHandler);

  const activateInlineToken = useCallback((event: AtomicInlineTokenEvent) => {
    const token = readAtomicInlineTokenElement(event.target instanceof Node ? event.target : null);
    if (!token || !onInlineTokenClick) return false;
    stopAtomicInlineTokenEvent(event);
    onInlineTokenClick(token);
    return true;
  }, [onInlineTokenClick]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative rudder-mdxeditor-scope",
        bordered ? "rounded-md border border-border bg-transparent" : "bg-transparent",
        isDragOver && "ring-1 ring-primary/60 bg-accent/20",
        className,
      )}
      onKeyDownCapture={(e) => {
        if (plainText && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
          const selection = window.getSelection();
          const editable = containerRef.current?.querySelector('[contenteditable="true"]');
          if (
            selection
            && selection.rangeCount > 0
            && !selection.isCollapsed
            && editable instanceof HTMLElement
            && editable.contains(selection.anchorNode)
            && editable.contains(selection.focusNode)
          ) {
            const canonicalText = canonicalMarkdownFromFragment(selection.getRangeAt(0).cloneContents());
            if (canonicalText) {
              e.preventDefault();
              e.stopPropagation();
              void navigator.clipboard?.writeText(canonicalText);
              return;
            }
          }
        }

        const hasPlainTextKey =
          e.key.length === 1
          && !e.altKey
          && !e.ctrlKey
          && !e.metaKey
          && !e.nativeEvent.isComposing;
        if (pendingMentionInputRef.current && hasPlainTextKey) {
          e.preventDefault();
          e.stopPropagation();
          insertPendingMentionText(e.key);
          return;
        }
        if (pendingMentionInputRef.current && !hasPlainTextKey) {
          clearPendingMentionInput();
        }

        const shouldSubmitOnModEnter =
          submitShortcut === "mod-enter" && e.key === "Enter" && (e.metaKey || e.ctrlKey);
        const shouldSubmitOnEnter =
          submitShortcut === "enter"
          && e.key === "Enter"
          && !e.shiftKey
          && !e.ctrlKey
          && !e.metaKey
          && !e.altKey;

        if (onSubmit && (shouldSubmitOnModEnter || shouldSubmitOnEnter)) {
          e.preventDefault();
          e.stopPropagation();
          onSubmit();
          return;
        }

        if (e.key === "Backspace" || e.key === "Delete") {
          const direction = e.key === "Backspace" ? "backward" : "forward";
          if (removeAdjacentAtomicToken(direction)) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        }

        // Mention keyboard handling
        if (mentionActive) {
          // Space dismisses the popup (let the character be typed normally)
          if (e.key === " ") {
            mentionStateRef.current = null;
            setMentionState(null);
            return;
          }
          // Escape always dismisses
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            mentionStateRef.current = null;
            setMentionState(null);
            return;
          }
          // Arrow / Enter / Tab only when there are filtered results
          if (filteredMentions.length > 0) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              e.stopPropagation();
              setMentionIndex((prev) => Math.min(prev + 1, filteredMentions.length - 1));
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              e.stopPropagation();
              setMentionIndex((prev) => Math.max(prev - 1, 0));
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              e.stopPropagation();
              const editable = containerRef.current?.querySelector('[contenteditable="true"]');
              const freshState = editable instanceof HTMLElement ? detectMention(editable) : null;
              if (freshState && freshState.trigger === mentionStateRef.current?.trigger) {
                mentionStateRef.current = freshState;
                setMentionState(freshState);
              }
              selectMention(filteredMentions[mentionIndex]);
              return;
            }
          }
        }
      }}
      onBeforeInputCapture={(event) => {
        const nativeEvent = event.nativeEvent;
        if (!(nativeEvent instanceof InputEvent)) return;

        if (nativeEvent.inputType === "deleteContentBackward") {
          if (removeAdjacentAtomicToken("backward")) {
            event.preventDefault();
            event.stopPropagation();
          }
          return;
        }

        if (nativeEvent.inputType === "deleteContentForward") {
          if (removeAdjacentAtomicToken("forward")) {
            event.preventDefault();
            event.stopPropagation();
          }
        }
      }}
      onDragEnter={(evt) => {
        if (!canDropImage || !hasFilePayload(evt)) return;
        dragDepthRef.current += 1;
        setIsDragOver(true);
      }}
      onPointerDownCapture={(event) => {
        stopAtomicInlineTokenEvent(event, { placeCaret: true });
      }}
      onMouseDownCapture={(event) => {
        stopAtomicInlineTokenEvent(event, { placeCaret: true });
      }}
      onPointerUpCapture={(event) => {
        stopAtomicInlineTokenEvent(event);
      }}
      onMouseUpCapture={(event) => {
        stopAtomicInlineTokenEvent(event);
      }}
      onClickCapture={(event) => {
        if (activateInlineToken(event)) return;
        stopAtomicInlineTokenEvent(event);
      }}
      onCopyCapture={(event) => {
        if (!plainText) return;
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
        const editable = containerRef.current?.querySelector('[contenteditable="true"]');
        if (!(editable instanceof HTMLElement)) return;
        if (!editable.contains(selection.anchorNode) || !editable.contains(selection.focusNode)) return;

        const canonicalText = canonicalMarkdownFromFragment(selection.getRangeAt(0).cloneContents());
        if (!canonicalText) return;
        event.clipboardData.setData("text/plain", canonicalText);
        event.preventDefault();
      }}
      onDoubleClickCapture={(event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const image = target.closest("img");
        if (!(image instanceof HTMLImageElement) || !image.src) return;
        event.preventDefault();
        event.stopPropagation();
        setImagePreview({
          alt: image.alt,
          name: getPreviewImageName(image),
          src: image.currentSrc || image.src,
          naturalSize:
            image.naturalWidth > 0 && image.naturalHeight > 0
              ? { width: image.naturalWidth, height: image.naturalHeight }
              : null,
        });
      }}
      onDragOver={(evt) => {
        if (!canDropImage || !hasFilePayload(evt)) return;
        evt.preventDefault();
        evt.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => {
        if (!canDropImage) return;
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setIsDragOver(false);
      }}
      onDrop={() => {
        dragDepthRef.current = 0;
        setIsDragOver(false);
      }}
    >
      <MDXEditor
        ref={ref}
        markdown={value}
        placeholder={translatedPlaceholder}
        onChange={(next) => {
          const normalizedNext = plainText ? normalizePlainTextComposerMarkdown(next) : next;
          latestValueRef.current = normalizedNext;
          onChange(normalizedNext);
          const onlyRemovedCaretBoundary = plainText
            && next.includes(INLINE_CARET_BOUNDARY)
            && normalizedNext === next.replaceAll(INLINE_CARET_BOUNDARY, "");
          if (
            plainText
            && normalizedNext !== next
            && !onlyRemovedCaretBoundary
            && hasCanonicalRudderReference(normalizedNext)
          ) {
            requestAnimationFrame(() => {
              ref.current?.setMarkdown(normalizedNext);
            });
          }
        }}
        onBlur={() => onBlur?.()}
        className={cn("rudder-mdxeditor", !bordered && "rudder-mdxeditor--borderless")}
        contentEditableClassName={cn(
          "rudder-mdxeditor-content focus:outline-none [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:list-item",
          contentClassName,
        )}
        translation={mdxEditorTranslations}
        additionalLexicalNodes={[MentionAwareLinkNode, mentionAwareLinkNodeReplacement]}
        plugins={plugins}
      />

      {/* Mention dropdown */}
      {mentionActive && filteredMentions.length > 0 && mentionMenuPosition && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={setMentionMenuElement}
              data-testid="markdown-mention-menu"
              role={mentionMenuPlacement === "container" ? "menu" : "listbox"}
              aria-activedescendant={`markdown-mention-option-${filteredMentions[mentionIndex]?.id ?? ""}`}
              className={cn(
                mentionMenuPlacement === "container"
                  ? "chat-composer-context-menu motion-chat-composer-menu-pop surface-overlay scrollbar-auto-hide fixed z-50 overflow-y-auto overscroll-contain rounded-[var(--radius-lg)] border p-1.5 text-foreground"
                  : "scrollbar-auto-hide fixed z-50 min-w-[180px] overflow-y-auto overscroll-contain rounded-md border border-border bg-popover shadow-md",
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
                      const i = optionIndex;
                      optionIndex += 1;
                      const issueStatusLabel = option.issueStatus ? statusLabel(option.issueStatus) : "Issue";
                      const isContainerMenu = mentionMenuPlacement === "container";
                      const skillDescription = option.skillDescription ?? option.skillLocationLabel ?? option.skillDisplayName ?? option.name;
                      return (
                        <button
                          key={option.id}
                          id={`markdown-mention-option-${option.id}`}
                          type="button"
                          data-testid={`markdown-mention-option-${option.id}`}
                          data-mention-option-index={i}
                          data-chat-composer-menu-item={isContainerMenu ? true : undefined}
                          role={isContainerMenu ? "menuitem" : "option"}
                          aria-selected={isContainerMenu ? undefined : i === mentionIndex}
                          className={cn(
                            isContainerMenu
                              ? "chat-composer-menu-row"
                              : "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent/50",
                            i === mentionIndex && (isContainerMenu ? "bg-[color:var(--surface-active)] text-foreground" : "bg-accent"),
                          )}
                          onMouseDown={(e) => {
                            e.preventDefault(); // prevent blur
                            selectMention(option);
                          }}
                          onMouseEnter={() => setMentionIndex(i)}
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
                            </div>
                          ) : null}
                          {option.kind === "issue" && option.issueId && (
                            <span className="ml-auto text-[11px] text-muted-foreground">
                              Issue
                            </span>
                          )}
                          {option.kind === "project" && option.projectId && (
                            <span className="ml-auto text-[11px] text-muted-foreground">
                              Project
                            </span>
                          )}
                          {option.kind === "skill" && !isContainerMenu && (
                            <span className="ml-auto text-[11px] text-muted-foreground">
                              Skill
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ));
              })()}
            </div>,
            document.body,
          )
        : null}

      {isDragOver && canDropImage && (
        <div
          className={cn(
            "pointer-events-none absolute inset-1 z-40 flex items-center justify-center rounded-md border border-dashed border-primary/80 bg-primary/10 text-xs font-medium text-primary",
            !bordered && "inset-0 rounded-sm",
          )}
        >
          Drop image to upload
        </div>
      )}
      {uploadError && (
        <p className="px-3 pb-2 text-xs text-destructive">{uploadError}</p>
      )}

      <ImagePreviewDialog
        preview={imagePreview}
        testId="markdown-editor-image-preview-dialog"
        titleFallback="Image preview"
        onOpenChange={(open) => {
          if (!open) setImagePreview(null);
        }}
      />
    </div>
  );
});
