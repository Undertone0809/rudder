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

export interface MentionOption {
  id: string;
  name: string;
  kind?: "agent" | "project" | "issue" | "chat" | "library_doc" | "library_entry" | "library_file" | "library_directory" | "skill";
  searchText?: string;
  agentId?: string;
  agentIcon?: string | null;
  agentRole?: AgentRole | null;
  projectId?: string;
  projectColor?: string | null;
  issueId?: string;
  issueIdentifier?: string | null;
  issueStatus?: string | null;
  issueProjectName?: string | null;
  issueProjectColor?: string | null;
  issueAssigneeName?: string | null;
  issueAssigneeIcon?: string | null;
  issueAssigneeRole?: AgentRole | null;
  chatConversationId?: string;
  chatTitle?: string | null;
  chatStatus?: string | null;
  chatSummary?: string | null;
  chatUpdatedAt?: Date | string | null;
  libraryDocumentId?: string;
  libraryDocumentTitle?: string | null;
  libraryDocumentUpdatedAt?: Date | string | null;
  libraryDocumentPath?: string | null;
  libraryEntryId?: string | null;
  libraryFilePath?: string | null;
  libraryDirectoryPath?: string | null;
  skillRefLabel?: string | null;
  skillMarkdownTarget?: string | null;
  skillDisplayName?: string | null;
  skillDescription?: string | null;
  skillCategoryLabel?: string | null;
  skillLocationLabel?: string | null;
  skillDetailsHref?: string | null;
}

/* ---- Editor props ---- */

export interface MarkdownEditorProps {
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
  /** Whether selected agent mentions are plain references or comment wake requests. */
  agentMentionIntent?: "reference" | "wake";
  /** Optional surface used to align the mention menu for larger composer UIs. */
  mentionMenuAnchorRef?: RefObject<HTMLElement | null>;
  mentionMenuPlacement?: "caret" | "container";
  mentionMenuSize?: "default" | "compact";
  /** Called according to submitShortcut. */
  onSubmit?: () => void;
  submitShortcut?: "mod-enter" | "enter";
  /** Composer mode that preserves normal Markdown syntax as literal text. */
  plainText?: boolean;
  /** Optional handler for activating decorated inline reference tokens. */
  onInlineTokenClick?: (token: AtomicInlineTokenElement) => void;
}

export interface MarkdownEditorRef {
  focus: () => void;
}

export type CaretTarget =
  | { kind: "text"; node: Text; offset: number }
  | { kind: "after"; node: Node }
  | { kind: "inside"; node: Node; offset: number };

export const INLINE_CARET_BOUNDARY = "\u200B";

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isSafeMarkdownLinkUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return true;
  return !/^(javascript|data|vbscript):/i.test(trimmed);
}

export function normalizePlainTextComposerMarkdown(value: string) {
  return value
    .replaceAll(INLINE_CARET_BOUNDARY, "")
    .replace(/\\([\\`*_[\]{}()#+\-.!|>])/g, "$1");
}

export function findCanonicalReferenceCandidates(markdown: string) {
  return Array.from(markdown.matchAll(/\[([^\]\n]+)\]\(([^)\n]+)\)/g));
}

export function hasCanonicalRudderReference(markdown: string) {
  return findCanonicalReferenceCandidates(markdown).some((match) => {
    const label = match[1] ?? "";
    const href = match[2] ?? "";
    return Boolean(parseMentionChipHref(href) || parseSkillReference(href, label));
  });
}

export function getMdastSourceSlice(node: unknown, markdown: string) {
  const positioned = node as {
    position?: {
      start?: { offset?: number };
      end?: { offset?: number };
    };
  };
  const start = positioned.position?.start?.offset;
  const end = positioned.position?.end?.offset;
  if (typeof start !== "number" || typeof end !== "number" || start < 0 || end < start) {
    return null;
  }
  return markdown.slice(start, end);
}

export function getMdastLinkLabel(node: unknown) {
  const link = node as { children?: Array<{ type?: string; value?: string }> };
  return (link.children ?? [])
    .map((child) => (child.type === "text" ? child.value ?? "" : ""))
    .join("")
    .trim();
}

export function appendPlainTextMarkdownNode(lexicalParent: LexicalNode, text: string) {
  const textNode = $createTextNode(text);
  if ($isElementNode(lexicalParent) && lexicalParent.getType() !== "root") {
    lexicalParent.append(textNode);
    return;
  }

  const paragraph = $createParagraphNode();
  paragraph.append(textNode);
  if ($isElementNode(lexicalParent)) {
    lexicalParent.append(paragraph);
  }
}

export function plainTextMarkdownImportPlugin(getMarkdown: () => string): RealmPlugin {
  const plainTextVisitor: MdastImportVisitor<any> = {
    priority: 90,
    testNode(node) {
      const type = (node as { type?: string }).type;
      if (type === "link") {
        const href = (node as { url?: string }).url ?? "";
        const label = getMdastLinkLabel(node);
        if (parseMentionChipHref(href) || parseSkillReference(href, label)) {
          return false;
        }
      }
      return type === "strong"
        || type === "emphasis"
        || type === "delete"
        || type === "inlineCode"
        || type === "link"
        || type === "image"
        || type === "heading"
        || type === "list"
        || type === "listItem"
        || type === "blockquote"
        || type === "code"
        || type === "thematicBreak"
        || type === "table"
        || type === "tableRow"
        || type === "tableCell";
    },
    visitNode({ mdastNode, lexicalParent }) {
      const source = getMdastSourceSlice(mdastNode, getMarkdown());
      if (source === null) return;
      appendPlainTextMarkdownNode(lexicalParent as LexicalNode, source);
    },
  };

  return realmPlugin({
    init(realm) {
      realm.pub(addImportVisitor$, plainTextVisitor);
    },
  })();
}

export function canonicalMarkdownFromFragment(fragment: DocumentFragment) {
  const read = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return (node.textContent ?? "").replaceAll(INLINE_CARET_BOUNDARY, "");
    }
    if (node instanceof HTMLBRElement) return "\n";
    if (node instanceof HTMLElement) {
      const token = readAtomicInlineTokenElement(node);
      if (token) return `[${token.label}](${token.href})`;
    }
    return Array.from(node.childNodes).map(read).join("");
  };

  return Array.from(fragment.childNodes).map(read).join("");
}

export function getLastCaretTarget(node: Node): CaretTarget {
  if (node.nodeType === Node.TEXT_NODE) {
    const textNode = node as Text;
    return { kind: "text", node: textNode, offset: textNode.textContent?.length ?? 0 };
  }

  if (
    node instanceof HTMLElement
    && (node.dataset.skillToken === "true" || node.dataset.mentionKind)
  ) {
    return { kind: "after", node };
  }

  for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
    const target = getLastCaretTarget(node.childNodes[index]!);
    if (target) return target;
  }

  return { kind: "inside", node, offset: node.childNodes.length };
}

export function placeCaretNearInlineToken(token: HTMLElement) {
  const editable = token.closest('[contenteditable="true"]');
  if (!(editable instanceof HTMLElement)) return;

  editable.focus();

  const selection = window.getSelection();
  if (!selection) return;

  const range = document.createRange();
  // Contenteditable=false inline chips are a brittle selection boundary for
  // Lexical. A click on the chip should leave the user in the useful editing
  // position: after the chip, where Backspace can remove it and typing can
  // continue normally.
  range.setStartAfter(token);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function getVisibleTextOffsetBeforeNode(editable: HTMLElement, node: Node) {
  const range = document.createRange();
  range.setStart(editable, 0);
  range.setEndBefore(node);
  return range.toString().length;
}

export function getVisibleTextOffsetAtPosition(editable: HTMLElement, textNode: Text, offset: number) {
  const range = document.createRange();
  range.setStart(editable, 0);
  range.setEnd(textNode, offset);
  return range.toString().length;
}

export function findFirstTextNodeInSubtree(node: Node): Text | null {
  if (node.nodeType === Node.TEXT_NODE) return node as Text;

  for (const child of Array.from(node.childNodes)) {
    const match = findFirstTextNodeInSubtree(child);
    if (match) return match;
  }

  return null;
}

export function findFirstTextNodeAfterNode(root: Node, node: Node): Text | null {
  let current: Node | null = node;
  while (current && current !== root) {
    let sibling = current.nextSibling;
    while (sibling) {
      const match = findFirstTextNodeInSubtree(sibling);
      if (match) return match;
      sibling = sibling.nextSibling;
    }
    current = current.parentNode;
  }

  return null;
}

export function placeCaretAfterAtomicInlineToken(
  editable: HTMLElement,
  token: HTMLElement,
  options: { createBoundaryText?: boolean } = {},
) {
  const createBoundaryText = options.createBoundaryText ?? true;
  editable.focus();

  const selection = window.getSelection();
  if (!selection) return false;

  let boundaryText = findFirstTextNodeAfterNode(editable, token);
  if (!boundaryText && createBoundaryText && token.parentNode) {
    boundaryText = document.createTextNode(" ");
    token.parentNode.insertBefore(boundaryText, token.nextSibling);
  }

  const range = document.createRange();
  if (boundaryText) {
    const text = boundaryText.textContent ?? "";
    const offset = text.length > 0 && /^[\s\u00A0\u200B]/u.test(text) ? 1 : 0;
    range.setStart(boundaryText, offset);
  } else {
    range.setStartAfter(token);
  }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

export function placeCaretAtVisibleTextOffset(
  editable: HTMLElement,
  offset: number,
  options: { createBoundaryText?: boolean } = {},
) {
  editable.focus();

  const selection = window.getSelection();
  if (!selection) return;

  const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, offset);
  let lastTextNode: Text | null = null;
  let lastAtomicToken: HTMLElement | null = null;

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    lastTextNode = node;
    const length = node.textContent?.length ?? 0;
    const atomicToken = closestAtomicInlineToken(node);
    if (atomicToken) {
      lastAtomicToken = atomicToken;
      if (remaining <= length) {
        const range = document.createRange();
        range.setStartAfter(atomicToken);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      remaining -= length;
      continue;
    }
    if (remaining <= length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    remaining -= length;
  }

  const range = document.createRange();
  if (lastAtomicToken && lastTextNode && lastAtomicToken.contains(lastTextNode)) {
    if (placeCaretAfterAtomicInlineToken(editable, lastAtomicToken, options)) return;
    range.setStartAfter(lastAtomicToken);
  } else if (lastTextNode) {
    range.setStart(lastTextNode, lastTextNode.textContent?.length ?? 0);
  } else {
    range.setStart(editable, editable.childNodes.length);
  }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

export type LexicalTextPosition = {
  node: TextNode;
  offset: number;
};

export function findLexicalTextPositionAtOffset(
  node: LexicalNode,
  remainingOffset: { value: number },
  lastTextPosition: { value: LexicalTextPosition | null },
): LexicalTextPosition | null {
  if ($isTextNode(node)) {
    const length = node.getTextContentSize();
    lastTextPosition.value = { node, offset: length };
    if (remainingOffset.value <= length) {
      return { node, offset: Math.max(0, remainingOffset.value) };
    }
    remainingOffset.value -= length;
    return null;
  }

  if (!$isElementNode(node)) return null;

  for (const child of node.getChildren()) {
    const match = findLexicalTextPositionAtOffset(child, remainingOffset, lastTextPosition);
    if (match) return match;
  }

  return null;
}

export function selectLexicalTextOffset(offset: number) {
  const root = $getRoot();
  const remainingOffset = { value: Math.max(0, offset) };
  const lastTextPosition = { value: null as LexicalTextPosition | null };
  const position = findLexicalTextPositionAtOffset(root, remainingOffset, lastTextPosition)
    ?? lastTextPosition.value;

  if (!position) {
    root.selectEnd();
    return;
  }

  const selection = $createRangeSelection();
  selection.anchor.set(position.node.getKey(), position.offset, "text");
  selection.focus.set(position.node.getKey(), position.offset, "text");
  $setSelection(selection);
}

export function focusLexicalTextOffset(editor: LexicalEditor, offset: number) {
  editor.update(() => {
    selectLexicalTextOffset(offset);
  }, { discrete: true });
  editor.focus();
}

export function closestAtomicInlineToken(target: EventTarget | null): HTMLElement | null {
  const element = target instanceof HTMLElement
    ? target
    : target instanceof Node
      ? target.parentElement
      : null;
  if (!element) return null;
  const token = element.closest("[data-skill-token='true'], [data-mention-kind]");
  return token instanceof HTMLElement ? token : null;
}

export type AtomicInlineTokenEvent = {
  target: EventTarget | null;
  nativeEvent: Event & { stopImmediatePropagation?: () => void };
  preventDefault: () => void;
  stopPropagation: () => void;
  clientX?: number;
};

export function stopAtomicInlineTokenEvent(
  event: AtomicInlineTokenEvent,
  options: { placeCaret?: boolean } = {},
) {
  const token = closestAtomicInlineToken(event.target);
  if (!token) return false;
  event.preventDefault();
  event.stopPropagation();
  event.nativeEvent.stopImmediatePropagation?.();
  if (options.placeCaret && typeof event.clientX === "number") {
    placeCaretNearInlineToken(token);
  }
  return true;
}

/* ---- Mention detection helpers ---- */

export interface MentionState {
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
}

export const MENTION_MENU_MIN_WIDTH = 180;
export const MENTION_MENU_DEFAULT_WIDTH = 520;
export const MENTION_MENU_MAX_HEIGHT = 200;
export const MENTION_PANEL_MAX_HEIGHT = 360;
export const MENTION_MENU_VIEWPORT_PADDING = 12;
export const MENTION_MENU_OFFSET = 4;
export const MENTION_PANEL_OFFSET = 10;

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

export const CODE_BLOCK_LANGUAGES: Record<string, string> = {
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

export const FALLBACK_CODE_BLOCK_DESCRIPTOR: CodeBlockEditorDescriptor = {
  // Keep this lower than codeMirrorPlugin's descriptor priority so known languages
  // still use the standard matching path; this catches malformed/unknown fences.
  priority: 0,
  match: () => true,
  Editor: CodeMirrorEditor,
};

export function EmptyImageToolbar() {
  return null;
}

export const mdxEditorTranslations: Translation = (key, defaultValue, interpolations) => {
  const overrides: Record<string, string> = {
    "createLink.url": "Page or URL",
    "createLink.urlPlaceholder": "Paste a URL",
    "createLink.text": "Link title",
    "createLink.textTooltip": "The text shown for this link",
    "createLink.saveTooltip": "Apply link changes",
    "createLink.cancelTooltip": "Cancel",
    "dialogControls.save": "Done",
    "dialogControls.cancel": "Cancel",
    "linkPreview.edit": "Edit",
    "linkPreview.copyToClipboard": "Copy link",
    "linkPreview.copied": "Copied",
    "linkPreview.remove": "Remove Link",
  };
  const template = overrides[key] ?? defaultValue;
  if (!interpolations) return template;
  return Object.entries(interpolations).reduce(
    (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
    template,
  );
};

export function detectMention(container: HTMLElement): MentionState | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;

  const range = sel.getRangeAt(0);
  const textNode = range.startContainer;
  if (textNode.nodeType !== Node.TEXT_NODE) return null;
  if (!container.contains(textNode)) return null;

  const text = textNode.textContent ?? "";
  const offset = range.startOffset;

  // Walk backwards from cursor to find a mention trigger.
  let atPos = -1;
  let trigger: MentionState["trigger"] | null = null;
  for (let i = offset - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "@" || ch === "$") {
      if (i === 0 || /\s/.test(text[i - 1])) {
        atPos = i;
        trigger = ch;
      }
      break;
    }
    if (/\s/.test(ch)) break;
  }

  if (atPos === -1 || !trigger) return null;

  const query = text.slice(atPos + 1, offset);

  // Get position relative to container
  const tempRange = document.createRange();
  tempRange.setStart(textNode, atPos);
  tempRange.setEnd(textNode, atPos + 1);
  const rect = tempRange.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();

  return {
    trigger,
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

export function clamp(value: number, min: number, max: number) {
  if (max <= min) return min;
  return Math.min(Math.max(value, min), max);
}

export function getPreviewImageName(image: HTMLImageElement) {
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
  const availableWidth = Math.max(
    MENTION_MENU_MIN_WIDTH,
    viewportWidth - MENTION_MENU_VIEWPORT_PADDING * 2,
  );
  const width = Math.min(MENTION_MENU_DEFAULT_WIDTH, availableWidth);
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
    viewportWidth - MENTION_MENU_VIEWPORT_PADDING - width,
  );

  if (openUpward) {
    return {
      left,
      width,
      bottom: viewportHeight - state.viewportTop + MENTION_MENU_OFFSET,
      maxHeight,
    } as const;
  }

  return {
    left,
    width,
    top: state.viewportBottom + MENTION_MENU_OFFSET,
    maxHeight,
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

export function getMentionPanelPosition(anchor: HTMLElement) {
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

export function getMentionMenuPosition(state: MentionState) {
  return getMentionMenuPositionForViewport(state, window.innerWidth, window.innerHeight);
}

export function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function mentionMarkdown(option: MentionOption, agentMentionIntent?: "reference" | "wake"): string {
  const token = mentionTokenDetails(option, agentMentionIntent);
  return token ? `[${token.label}](${token.href}) ` : "";
}

export function mentionVisibleLabel(option: MentionOption): string {
  return mentionTokenDetails(option)?.label ?? option.name;
}

export function mentionTokenDetails(
  option: MentionOption,
  agentMentionIntent?: "reference" | "wake",
): { href: string; isSkill: boolean; label: string } | null {
  if (option.kind === "skill") {
    if (!option.skillMarkdownTarget || !option.skillRefLabel) return null;
    return { href: option.skillMarkdownTarget, isSkill: true, label: option.skillRefLabel };
  }
  if (option.kind === "issue" && option.issueId) {
    return {
      href: buildIssueMentionHref(option.issueId, option.issueIdentifier ?? null),
      isSkill: false,
      label: option.name,
    };
  }
  if (option.kind === "project" && option.projectId) {
    return {
      href: buildProjectMentionHref(option.projectId, option.projectColor ?? null),
      isSkill: false,
      label: option.name,
    };
  }
  const agentId = option.agentId ?? option.id.replace(/^agent:/, "");
  return {
    href: buildAgentMentionHref(agentId, option.agentIcon ?? null, agentMentionIntent),
    isSkill: false,
    label: option.name,
  };
}

export function getAllSubstringIndexes(value: string, search: string): number[] {
  const indexes: number[] = [];
  let idx = value.indexOf(search);
  while (idx !== -1) {
    indexes.push(idx);
    idx = value.indexOf(search, idx + search.length);
  }
  return indexes;
}

export function countSubstringOccurrences(value: string, search: string): number {
  return getAllSubstringIndexes(value, search).length;
}

export function commonSuffixLength(a: string, b: string, maxLength: number): number {
  const limit = Math.min(a.length, b.length, maxLength);
  let length = 0;
  while (length < limit && a[a.length - 1 - length] === b[b.length - 1 - length]) {
    length += 1;
  }
  return length;
}

export function commonPrefixLength(a: string, b: string, maxLength: number): number {
  const limit = Math.min(a.length, b.length, maxLength);
  let length = 0;
  while (length < limit && a[length] === b[length]) {
    length += 1;
  }
  return length;
}

export function getVisibleMentionOrdinal(editable: HTMLElement | null, state: MentionState, search: string): number | null {
  if (!editable || !editable.contains(state.textNode)) return null;
  const range = document.createRange();
  range.setStart(editable, 0);
  range.setEnd(state.textNode, state.atPos);
  return countSubstringOccurrences(range.toString(), search);
}

export function findActiveMentionIndex(markdown: string, state: MentionState, editable: HTMLElement | null): number {
  const search = `${state.trigger}${state.query}`;
  const indexes = getAllSubstringIndexes(markdown, search);
  if (indexes.length === 0) return -1;
  if (indexes.length === 1) return indexes[0]!;

  const ordinal = getVisibleMentionOrdinal(editable, state, search);
  const ordinalIndex = typeof ordinal === "number" ? indexes[ordinal] ?? null : null;
  const nodeText = state.textNode.textContent ?? "";
  const beforeText = nodeText.slice(0, state.atPos);
  const afterText = nodeText.slice(state.endPos);
  const contextScores = indexes.map((idx) => ({
    idx,
    score: commonSuffixLength(markdown.slice(0, idx), beforeText, 80)
      + commonPrefixLength(markdown.slice(idx + search.length), afterText, 80),
  }));
  const bestScore = Math.max(...contextScores.map((candidate) => candidate.score));
  const bestIndexes = contextScores
    .filter((candidate) => candidate.score === bestScore)
    .map((candidate) => candidate.idx);

  if (ordinalIndex !== null && bestIndexes.includes(ordinalIndex)) return ordinalIndex;
  if (bestScore > 0) return bestIndexes[0]!;
  return ordinalIndex ?? indexes[indexes.length - 1]!;
}

/** Replace the active trigger query range with the selected mention token. */
export function applyMention(
  markdown: string,
  state: MentionState,
  option: MentionOption,
  editable: HTMLElement | null,
  agentMentionIntent?: "reference" | "wake",
): string {
  const search = `${state.trigger}${state.query}`;
  const replacement = mentionMarkdown(option, agentMentionIntent);
  if (!replacement) return markdown;
  const idx = findActiveMentionIndex(markdown, state, editable);
  if (idx === -1) return markdown;
  const replacementEnd = idx + search.length;
  const replaceLength = replacement.endsWith(" ") && markdown[replacementEnd] === " "
    ? search.length + 1
    : search.length;
  return markdown.slice(0, idx) + replacement + markdown.slice(idx + replaceLength);
}

export function replaceMentionInLexicalEditor(
  editor: LexicalEditor,
  state: MentionState,
  option: MentionOption,
  editable: HTMLElement,
  agentMentionIntent?: "reference" | "wake",
) {
  if (!editable.contains(state.textNode)) return false;
  const token = mentionTokenDetails(option, agentMentionIntent);
  if (!token) return false;

  const text = state.textNode.textContent ?? "";
  const endPos = text[state.endPos] === " " ? state.endPos + 1 : state.endPos;
  const startVisibleOffset = getVisibleTextOffsetAtPosition(editable, state.textNode, state.atPos);
  const endVisibleOffset = getVisibleTextOffsetAtPosition(editable, state.textNode, endPos);
  let replaced = false;

  editor.update(() => {
    const root = $getRoot();
    const start = findLexicalTextPositionAtOffset(
      root,
      { value: startVisibleOffset },
      { value: null },
    );
    const end = findLexicalTextPositionAtOffset(
      root,
      { value: endVisibleOffset },
      { value: null },
    );
    if (!start || !end) return;

    const selection = $createRangeSelection();
    selection.setTextNodeRange(start.node, start.offset, end.node, end.offset);
    $setSelection(selection);

    const mentionNode = token.isSkill
      ? $createSkillTokenNode(token.label, token.href)
      : $createMentionTokenNode(token.label, token.href);
    const caretBoundary = $createTextNode(INLINE_CARET_BOUNDARY);
    selection.insertNodes([mentionNode, caretBoundary]);
    caretBoundary.selectEnd();
    replaced = true;
  }, { discrete: true });

  return replaced;
}

export function rootEditorCapturePlugin(onEditor: (editor: LexicalEditor | null) => void): RealmPlugin {
  return realmPlugin({
    postInit(realm) {
      realm.pub(createRootEditorSubscription$, (editor) => {
        onEditor(editor);
        return () => onEditor(null);
      });
    },
  })();
}

/* ---- Component ---- */
