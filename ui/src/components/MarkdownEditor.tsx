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
  type RealmPlugin,
} from "@mdxeditor/editor";
import { Sparkles, X } from "lucide-react";
import { buildAgentMentionHref, buildIssueMentionHref, buildProjectMentionHref } from "@rudderhq/shared";
import { useI18n } from "@/context/I18nContext";
import { translateLegacyString } from "@/i18n/legacyPhrases";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { AgentIcon } from "./AgentIconPicker";
import {
  applyMentionChipDecoration,
  clearMentionChipDecoration,
  parseMentionChipHref,
  stripMentionChipLabelPrefix,
} from "../lib/mention-chips";
import { MentionAwareLinkNode, mentionAwareLinkNodeReplacement } from "../lib/mention-aware-link-node";
import { mentionDeletionPlugin } from "../lib/mention-deletion";
import { issueStatusIcon, issueStatusIconDefault } from "../lib/status-colors";
import {
  applySkillTokenDecoration,
  clearSkillTokenDecoration,
  parseSkillReference,
  removeSkillReferenceFromMarkdown,
} from "../lib/skill-reference";
import { findAdjacentSkillTokenElement } from "../lib/skill-token-dom";
import { skillTokenPlugin } from "../lib/skill-token-node";
import { cn } from "../lib/utils";

/* ---- Mention types ---- */

export interface MentionOption {
  id: string;
  name: string;
  kind?: "agent" | "project" | "issue" | "skill";
  searchText?: string;
  agentId?: string;
  agentIcon?: string | null;
  projectId?: string;
  projectColor?: string | null;
  issueId?: string;
  issueIdentifier?: string | null;
  issueStatus?: string | null;
  issueProjectName?: string | null;
  issueProjectColor?: string | null;
  issueAssigneeName?: string | null;
  issueAssigneeIcon?: string | null;
  skillRefLabel?: string | null;
  skillMarkdownTarget?: string | null;
  skillDisplayName?: string | null;
  skillDescription?: string | null;
}

/* ---- Editor props ---- */

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  contentClassName?: string;
  onBlur?: () => void;
  imageUploadHandler?: (file: File) => Promise<string>;
  bordered?: boolean;
  /** List of mentionable entities. Enables @-mention autocomplete. */
  mentions?: MentionOption[];
  /** Optional surface used to align the mention menu for larger composer UIs. */
  mentionMenuAnchorRef?: RefObject<HTMLElement | null>;
  mentionMenuPlacement?: "caret" | "container";
  /** Called according to submitShortcut. */
  onSubmit?: () => void;
  submitShortcut?: "mod-enter" | "enter";
}

export interface MarkdownEditorRef {
  focus: () => void;
}

type CaretTarget =
  | { kind: "text"; node: Text; offset: number }
  | { kind: "after"; node: Node }
  | { kind: "inside"; node: Node; offset: number };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSafeMarkdownLinkUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return true;
  return !/^(javascript|data|vbscript):/i.test(trimmed);
}

function getLastCaretTarget(node: Node): CaretTarget {
  if (node.nodeType === Node.TEXT_NODE) {
    const textNode = node as Text;
    return { kind: "text", node: textNode, offset: textNode.textContent?.length ?? 0 };
  }

  if (node instanceof HTMLElement && node.dataset.skillToken === "true") {
    return { kind: "after", node };
  }

  for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
    const target = getLastCaretTarget(node.childNodes[index]!);
    if (target) return target;
  }

  return { kind: "inside", node, offset: node.childNodes.length };
}

/* ---- Mention detection helpers ---- */

interface MentionState {
  query: string;
  top: number;
  left: number;
  viewportTop: number;
  viewportBottom: number;
  viewportLeft: number;
  textNode: Text;
  atPos: number;
  endPos: number;
}

const MENTION_MENU_MIN_WIDTH = 180;
const MENTION_MENU_MAX_HEIGHT = 200;
const MENTION_PANEL_MAX_HEIGHT = 360;
const MENTION_MENU_VIEWPORT_PADDING = 12;
const MENTION_MENU_OFFSET = 4;
const MENTION_PANEL_OFFSET = 10;

export interface MentionMenuAnchor {
  viewportTop: number;
  viewportBottom: number;
  viewportLeft: number;
}

export interface MentionMenuContainerAnchor {
  viewportTop: number;
  viewportBottom: number;
  viewportLeft: number;
  viewportRight: number;
}

interface ImagePreviewState {
  alt: string;
  name: string;
  src: string;
}

const CODE_BLOCK_LANGUAGES: Record<string, string> = {
  txt: "Text",
  md: "Markdown",
  js: "JavaScript",
  jsx: "JavaScript (JSX)",
  ts: "TypeScript",
  tsx: "TypeScript (TSX)",
  json: "JSON",
  bash: "Bash",
  sh: "Shell",
  python: "Python",
  go: "Go",
  rust: "Rust",
  sql: "SQL",
  html: "HTML",
  css: "CSS",
  yaml: "YAML",
  yml: "YAML",
};

const FALLBACK_CODE_BLOCK_DESCRIPTOR: CodeBlockEditorDescriptor = {
  // Keep this lower than codeMirrorPlugin's descriptor priority so known languages
  // still use the standard matching path; this catches malformed/unknown fences.
  priority: 0,
  match: () => true,
  Editor: CodeMirrorEditor,
};

function EmptyImageToolbar() {
  return null;
}

function detectMention(container: HTMLElement): MentionState | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;

  const range = sel.getRangeAt(0);
  const textNode = range.startContainer;
  if (textNode.nodeType !== Node.TEXT_NODE) return null;
  if (!container.contains(textNode)) return null;

  const text = textNode.textContent ?? "";
  const offset = range.startOffset;

  // Walk backwards from cursor to find @
  let atPos = -1;
  for (let i = offset - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "@") {
      if (i === 0 || /\s/.test(text[i - 1])) {
        atPos = i;
      }
      break;
    }
    if (/\s/.test(ch)) break;
  }

  if (atPos === -1) return null;

  const query = text.slice(atPos + 1, offset);

  // Get position relative to container
  const tempRange = document.createRange();
  tempRange.setStart(textNode, atPos);
  tempRange.setEnd(textNode, atPos + 1);
  const rect = tempRange.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();

  return {
    query,
    top: rect.bottom - containerRect.top,
    left: rect.left - containerRect.left,
    viewportTop: rect.top,
    viewportBottom: rect.bottom,
    viewportLeft: rect.left,
    textNode: textNode as Text,
    atPos,
    endPos: offset,
  };
}

function clamp(value: number, min: number, max: number) {
  if (max <= min) return min;
  return Math.min(Math.max(value, min), max);
}

function getPreviewImageName(image: HTMLImageElement) {
  const alt = image.getAttribute("alt")?.trim();
  if (alt) return alt;
  try {
    const url = new URL(image.currentSrc || image.src, window.location.href);
    const filename = url.pathname.split("/").pop()?.trim();
    if (filename) return decodeURIComponent(filename);
  } catch {
    // Ignore malformed URLs and fall back to a generic label.
  }
  return "Image preview";
}

export function getMentionMenuPositionForViewport(
  state: MentionMenuAnchor,
  viewportWidth: number,
  viewportHeight: number,
) {
  const maxWidth = Math.max(
    MENTION_MENU_MIN_WIDTH,
    viewportWidth - MENTION_MENU_VIEWPORT_PADDING * 2,
  );
  const availableBelow = Math.max(
    0,
    viewportHeight - state.viewportBottom - MENTION_MENU_VIEWPORT_PADDING - MENTION_MENU_OFFSET,
  );
  const availableAbove = Math.max(
    0,
    state.viewportTop - MENTION_MENU_VIEWPORT_PADDING - MENTION_MENU_OFFSET,
  );
  const openUpward = availableBelow < 140 && availableAbove > availableBelow;
  const maxHeight = Math.max(
    96,
    Math.min(
      MENTION_MENU_MAX_HEIGHT,
      openUpward ? availableAbove : availableBelow,
    ),
  );
  const left = clamp(
    state.viewportLeft,
    MENTION_MENU_VIEWPORT_PADDING,
    viewportWidth - MENTION_MENU_VIEWPORT_PADDING - MENTION_MENU_MIN_WIDTH,
  );

  if (openUpward) {
    return {
      left,
      bottom: viewportHeight - state.viewportTop + MENTION_MENU_OFFSET,
      maxHeight,
      maxWidth,
    } as const;
  }

  return {
    left,
    top: state.viewportBottom + MENTION_MENU_OFFSET,
    maxHeight,
    maxWidth,
  } as const;
}

export function getMentionPanelPositionForViewport(
  state: MentionMenuContainerAnchor,
  viewportWidth: number,
  viewportHeight: number,
) {
  const availableWidth = Math.max(
    MENTION_MENU_MIN_WIDTH,
    viewportWidth - MENTION_MENU_VIEWPORT_PADDING * 2,
  );
  const desiredWidth = clamp(
    state.viewportRight - state.viewportLeft,
    MENTION_MENU_MIN_WIDTH,
    availableWidth,
  );
  const left = clamp(
    state.viewportLeft,
    MENTION_MENU_VIEWPORT_PADDING,
    viewportWidth - MENTION_MENU_VIEWPORT_PADDING - desiredWidth,
  );
  const availableBelow = Math.max(
    0,
    viewportHeight - state.viewportBottom - MENTION_MENU_VIEWPORT_PADDING - MENTION_PANEL_OFFSET,
  );
  const availableAbove = Math.max(
    0,
    state.viewportTop - MENTION_MENU_VIEWPORT_PADDING - MENTION_PANEL_OFFSET,
  );
  const openUpward = availableAbove >= 128 || availableAbove >= availableBelow;
  const maxHeight = Math.max(
    128,
    Math.min(
      MENTION_PANEL_MAX_HEIGHT,
      openUpward ? availableAbove : availableBelow,
    ),
  );

  if (openUpward) {
    return {
      left,
      width: desiredWidth,
      bottom: viewportHeight - state.viewportTop + MENTION_PANEL_OFFSET,
      maxHeight,
    } as const;
  }

  return {
    left,
    width: desiredWidth,
    top: state.viewportBottom + MENTION_PANEL_OFFSET,
    maxHeight,
  } as const;
}

function getMentionPanelPosition(anchor: HTMLElement) {
  const rect = anchor.getBoundingClientRect();
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

function getMentionMenuPosition(state: MentionState) {
  return getMentionMenuPositionForViewport(state, window.innerWidth, window.innerHeight);
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function mentionMarkdown(option: MentionOption): string {
  if (option.kind === "skill" && option.skillMarkdownTarget && option.skillRefLabel) {
    return `[${option.skillRefLabel}](${option.skillMarkdownTarget}) `;
  }
  if (option.kind === "issue" && option.issueId) {
    return `[${option.name}](${buildIssueMentionHref(option.issueId, option.issueIdentifier ?? null)}) `;
  }
  if (option.kind === "project" && option.projectId) {
    return `[${option.name}](${buildProjectMentionHref(option.projectId, option.projectColor ?? null)}) `;
  }
  const agentId = option.agentId ?? option.id.replace(/^agent:/, "");
  return `[${option.name}](${buildAgentMentionHref(agentId, option.agentIcon ?? null)}) `;
}

/** Replace `@<query>` in the markdown string with the selected mention token. */
function applyMention(markdown: string, query: string, option: MentionOption): string {
  const search = `@${query}`;
  const replacement = mentionMarkdown(option);
  const idx = markdown.lastIndexOf(search);
  if (idx === -1) return markdown;
  return markdown.slice(0, idx) + replacement + markdown.slice(idx + search.length);
}

/* ---- Component ---- */

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
}: MarkdownEditorProps, forwardedRef) {
  const { locale } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const ref = useRef<MDXEditorMethods>(null);
  const latestValueRef = useRef(value);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [imagePreview, setImagePreview] = useState<ImagePreviewState | null>(null);
  const [imagePreviewNaturalSize, setImagePreviewNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const dragDepthRef = useRef(0);

  // Stable ref for imageUploadHandler so plugins don't recreate on every render
  const imageUploadHandlerRef = useRef(imageUploadHandler);
  imageUploadHandlerRef.current = imageUploadHandler;

  // Mention state (ref kept in sync so callbacks always see the latest value)
  const [mentionState, setMentionState] = useState<MentionState | null>(null);
  const mentionStateRef = useRef<MentionState | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
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
        const searchText = (mention.searchText ?? mention.name).toLowerCase();
        return searchText.includes(q);
      })
      .slice(0, 8);
  }, [mentionState?.query, mentions]);
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

  const removeSkillTokenByLabel = useCallback((label: string) => {
    const normalizedLabel = label.trim();
    if (!normalizedLabel) return false;

    const current = latestValueRef.current;
    const next = removeSkillReferenceFromMarkdown(current, normalizedLabel);
    if (next === current) return false;

    latestValueRef.current = next;
    ref.current?.setMarkdown(next);
    onChange(next);
    requestAnimationFrame(() => {
      focusEditorAtEnd();
    });
    return true;
  }, [focusEditorAtEnd, onChange]);

  const removeAdjacentSkillToken = useCallback((direction: "backward" | "forward") => {
    const selection = window.getSelection();
    const skillToken = findAdjacentSkillTokenElement(selection, direction);
    const label = skillToken?.textContent?.trim() ?? "";
    return removeSkillTokenByLabel(label);
  }, [removeSkillTokenByLabel]);

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
      headingsPlugin(),
      listsPlugin(),
      quotePlugin(),
      tablePlugin(),
      linkPlugin({ validateUrl: isSafeMarkdownLinkUrl }),
      linkDialogPlugin(),
      skillTokenPlugin(),
      mentionDeletionPlugin(),
      thematicBreakPlugin(),
      codeBlockPlugin({
        defaultCodeBlockLanguage: "txt",
        codeBlockEditorDescriptors: [FALLBACK_CODE_BLOCK_DESCRIPTOR],
      }),
      codeMirrorPlugin({ codeBlockLanguages: CODE_BLOCK_LANGUAGES }),
      markdownShortcutPlugin(),
    ];
    if (imageHandler) {
      all.push(imagePlugin({ imageUploadHandler: imageHandler, EditImageToolbar: EmptyImageToolbar }));
    }
    return all;
  }, [focusEditorAtEnd, hasImageUpload]);

  useEffect(() => {
    if (value !== latestValueRef.current) {
      ref.current?.setMarkdown(value);
      latestValueRef.current = value;
    }
  }, [value]);

  useEffect(() => {
    if (!imagePreview?.src) {
      setImagePreviewNaturalSize(null);
      return;
    }
    const image = new window.Image();
    image.onload = () => {
      setImagePreviewNaturalSize({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      setImagePreviewNaturalSize(null);
    };
    image.src = imagePreview.src;
    return () => {
      image.onload = null;
      image.onerror = null;
    };
  }, [imagePreview?.src]);

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
          applySkillTokenDecoration(link);
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
      if (!removeAdjacentSkillToken(direction)) return;
      event.preventDefault();
      event.stopPropagation();
    };

    const handleNativeBeforeInput = (event: InputEvent) => {
      if (event.inputType !== "deleteContentBackward" && event.inputType !== "deleteContentForward") {
        return;
      }
      const direction = event.inputType === "deleteContentBackward" ? "backward" : "forward";
      if (!removeAdjacentSkillToken(direction)) return;
      event.preventDefault();
      event.stopPropagation();
    };

    editable.addEventListener("keydown", handleNativeKeyDown, true);
    editable.addEventListener("beforeinput", handleNativeBeforeInput, true);
    return () => {
      editable.removeEventListener("keydown", handleNativeKeyDown, true);
      editable.removeEventListener("beforeinput", handleNativeBeforeInput, true);
    };
  }, [removeAdjacentSkillToken, value]);

  const selectMention = useCallback(
    (option: MentionOption) => {
      // Read from ref to avoid stale-closure issues (selectionchange can
      // update state between the last render and this callback firing).
      const state = mentionStateRef.current;
      if (!state) return;
      const current = latestValueRef.current;
      const next = applyMention(current, state.query, option);
      if (next !== current) {
        latestValueRef.current = next;
        ref.current?.setMarkdown(next);
        onChange(next);
      }

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const editable = containerRef.current?.querySelector('[contenteditable="true"]');
          if (!(editable instanceof HTMLElement)) return;
          decorateInlineTokens();
          editable.focus();

          const matchingTargets = option.kind === "skill"
            ? Array.from(editable.querySelectorAll("[data-skill-token='true']"))
              .filter((node): node is HTMLElement => node instanceof HTMLElement)
              .filter((node) => node.textContent?.trim() === (option.skillRefLabel ?? option.name))
            : (() => {
                const mentionHref = option.kind === "project" && option.projectId
                  ? buildProjectMentionHref(option.projectId, option.projectColor ?? null)
                  : option.kind === "issue" && option.issueId
                    ? buildIssueMentionHref(option.issueId, option.issueIdentifier ?? null)
                    : buildAgentMentionHref(
                        option.agentId ?? option.id.replace(/^agent:/, ""),
                        option.agentIcon ?? null,
                      );
                return Array.from(editable.querySelectorAll("a"))
                  .filter((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement)
                  .filter((link) => {
                    const href = link.getAttribute("href") ?? "";
                    return href === mentionHref && stripMentionChipLabelPrefix(link.textContent ?? "") === option.name;
                  });
              })();
          const containerRect = containerRef.current?.getBoundingClientRect();
          const target = matchingTargets.sort((a, b) => {
            const rectA = a.getBoundingClientRect();
            const rectB = b.getBoundingClientRect();
            const leftA = containerRect ? rectA.left - containerRect.left : rectA.left;
            const topA = containerRect ? rectA.top - containerRect.top : rectA.top;
            const leftB = containerRect ? rectB.left - containerRect.left : rectB.left;
            const topB = containerRect ? rectB.top - containerRect.top : rectB.top;
            const distA = Math.hypot(leftA - state.left, topA - state.top);
            const distB = Math.hypot(leftB - state.left, topB - state.top);
            return distA - distB;
          })[0] ?? null;
          if (!target) return;

          const selection = window.getSelection();
          if (!selection) return;
          const range = document.createRange();
          const nextSibling = target.nextSibling;
          if (nextSibling?.nodeType === Node.TEXT_NODE) {
            const text = nextSibling.textContent ?? "";
            if (text.startsWith(" ")) {
              range.setStart(nextSibling, 1);
              range.collapse(true);
              selection.removeAllRanges();
              selection.addRange(range);
              return;
            }
          }

          range.setStartAfter(target);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
        });
      });

      mentionStateRef.current = null;
      setMentionState(null);
    },
    [decorateInlineTokens, onChange],
  );

  function hasFilePayload(evt: DragEvent<HTMLDivElement>) {
    return Array.from(evt.dataTransfer?.types ?? []).includes("Files");
  }

  const canDropImage = Boolean(imageUploadHandler);
  const imagePreviewDialogWidth = imagePreviewNaturalSize
    ? `min(calc(100vw - 1.5rem), ${imagePreviewNaturalSize.width}px, 1440px)`
    : "min(calc(100vw - 1.5rem), 1440px)";

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
          if (removeAdjacentSkillToken(direction)) {
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
          if (removeAdjacentSkillToken("backward")) {
            event.preventDefault();
            event.stopPropagation();
          }
          return;
        }

        if (nativeEvent.inputType === "deleteContentForward") {
          if (removeAdjacentSkillToken("forward")) {
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
      onMouseDownCapture={(event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const skillToken = target.closest("[data-skill-token='true']");
        if (!skillToken) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onClickCapture={(event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const skillToken = target.closest("[data-skill-token='true']");
        if (!skillToken) return;
        event.preventDefault();
        event.stopPropagation();
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
          latestValueRef.current = next;
          onChange(next);
        }}
        onBlur={() => onBlur?.()}
        className={cn("rudder-mdxeditor", !bordered && "rudder-mdxeditor--borderless")}
        contentEditableClassName={cn(
          "rudder-mdxeditor-content focus:outline-none [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:list-item",
          contentClassName,
        )}
        additionalLexicalNodes={[MentionAwareLinkNode, mentionAwareLinkNodeReplacement]}
        plugins={plugins}
      />

      {/* Mention dropdown */}
      {mentionActive && filteredMentions.length > 0 && mentionMenuPosition && typeof document !== "undefined"
        ? createPortal(
            <div
              data-testid="markdown-mention-menu"
              className={cn(
                "fixed z-50 overflow-y-auto border border-border bg-popover shadow-md",
                mentionMenuPlacement === "container"
                  ? "rounded-[var(--radius-lg)] p-1.5 shadow-[var(--shadow-lg)]"
                  : "min-w-[180px] rounded-md",
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
                      return (
                        <button
                          key={option.id}
                          data-testid={`markdown-mention-option-${option.id}`}
                          className={cn(
                            "flex w-full items-center gap-2 text-left text-sm transition-colors hover:bg-accent/50",
                            mentionMenuPlacement === "container"
                              ? "rounded-[var(--radius-md)] px-3 py-2"
                              : "px-3 py-1.5",
                            i === mentionIndex && "bg-accent",
                          )}
                          onMouseDown={(e) => {
                            e.preventDefault(); // prevent blur
                            selectMention(option);
                          }}
                          onMouseEnter={() => setMentionIndex(i)}
                        >
                          {option.kind === "skill" ? (
                            <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />
                          ) : option.kind === "project" && option.projectId ? (
                            <span
                              className="inline-flex h-2.5 w-2.5 shrink-0 rounded-full border border-border/50"
                              style={{ backgroundColor: option.projectColor ?? "#64748b" }}
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
                              className="h-4 w-4 shrink-0 text-muted-foreground"
                            />
                          )}
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
                                      className="h-3 w-3 shrink-0 text-muted-foreground"
                                    />
                                  ) : null}
                                  <span className="truncate">{option.issueAssigneeName ?? "Unassigned"}</span>
                                </span>
                              </div>
                            ) : null}
                            {option.kind === "skill" ? (
                              <div className="truncate text-[11px] text-muted-foreground">
                                {option.skillDescription ?? option.skillDisplayName}
                              </div>
                            ) : null}
                          </div>
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
                          {option.kind === "skill" && (
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

      <Dialog open={imagePreview !== null} onOpenChange={(open) => {
        if (!open) setImagePreview(null);
      }}>
        <DialogContent
          showCloseButton={false}
          className="rudder-markdown-editor-image-preview-panel top-[50%] w-fit translate-y-[-50%] border-0 bg-transparent p-0 shadow-none"
          style={{ maxWidth: imagePreviewDialogWidth }}
        >
          <DialogTitle className="sr-only">
            {imagePreview?.name ?? "Image preview"}
          </DialogTitle>
          {imagePreview ? (
            <div
              data-testid="markdown-editor-image-preview-dialog"
              className="rudder-markdown-editor-image-preview-media relative flex w-fit max-w-full items-center justify-center overflow-hidden"
            >
              <DialogClose className="absolute right-2 top-2 z-10 flex size-8 items-center justify-center rounded-sm bg-black/55 text-white shadow-[0_6px_18px_rgb(0_0_0/0.28)] transition-colors hover:bg-black/70 focus:outline-none focus:ring-2 focus:ring-white/80">
                <X className="size-4" aria-hidden="true" />
                <span className="sr-only">Close image preview</span>
              </DialogClose>
              <img
                src={imagePreview.src}
                alt={imagePreview.alt}
                className="chat-attachment-preview-image"
              />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
});
