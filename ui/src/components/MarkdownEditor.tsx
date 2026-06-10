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
import { Boxes, FileText, Folder, MessageSquare } from "lucide-react";
import { buildAgentMentionHref, buildChatMentionHref, buildIssueMentionHref, buildLibraryDirectoryMentionHref, buildLibraryDocMentionHref, buildLibraryFileMentionHref, buildProjectMentionHref, type AgentRole } from "@rudderhq/shared";
import { useI18n } from "@/context/I18nContext";
import { useNavigate } from "@/lib/router";
import { translateLegacyString } from "@/i18n/legacyPhrases";
import { ImagePreviewDialog, type ImagePreviewState } from "@/components/ImagePreviewDialog";
import { AgentIcon } from "./AgentIconPicker";
import { StatusIcon } from "./StatusIcon";
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
  mentionChipNavigationPath,
  parseMentionChipHref,
  stripMentionChipLabelPrefix,
} from "../lib/mention-chips";
import { MentionAwareLinkNode, mentionAwareLinkNodeReplacement } from "../lib/mention-aware-link-node";
import { mentionDeletionPlugin } from "../lib/mention-deletion";
import { $createMentionTokenNode, mentionTokenPlugin } from "../lib/mention-token-node";
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
import { filterMentionOptions } from "../lib/mention-filter";
import { $createSkillTokenNode, skillTokenPlugin } from "../lib/skill-token-node";
import { useScrollbarActivityRef } from "../hooks/useScrollbarActivityRef";
import { useMarkdownMentions } from "../context/MarkdownMentionsContext";
import { cn, formatDateTime, relativeTime } from "../lib/utils";
import { MilkdownMarkdownEditor } from "./MilkdownMarkdownEditor";
import {
  getMentionMenuPositionForViewport,
  getMentionPanelPositionForViewport,
  type MentionMenuAnchor,
  type MentionMenuContainerAnchor,
} from "../lib/mention-menu-position";

export {
  getMentionMenuPositionForViewport,
  getMentionPanelPositionForViewport,
};

/* ---- Mention types ---- */

export interface MentionOption {
  id: string;
  name: string;
  kind?: "agent" | "project" | "issue" | "chat" | "library_doc" | "library_file" | "library_directory" | "skill";
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

export interface InlineTokenClickEvent {
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

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
  onMentionQueryChange?: (query: string | null) => void;
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
  onInlineTokenClick?: (token: AtomicInlineTokenElement, event: InlineTokenClickEvent) => void;
  /** Experimental editor engine for true Markdown surfaces. */
  engine?: "legacy" | "milkdown";
}

export interface MarkdownEditorRef {
  focus: () => void;
  getMarkdown?: () => string;
}

type CaretTarget =
  | { kind: "text"; node: Text; offset: number }
  | { kind: "after"; node: Node }
  | { kind: "inside"; node: Node; offset: number };

const INLINE_CARET_BOUNDARY = "\u200B";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSafeMarkdownLinkUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return true;
  return !/^(javascript|data|vbscript):/i.test(trimmed);
}

function normalizePlainTextComposerMarkdown(value: string) {
  return value
    .replaceAll(INLINE_CARET_BOUNDARY, "")
    .replace(/\\([\\`*_[\]{}()#+\-.!|>])/g, "$1");
}

function findCanonicalReferenceCandidates(markdown: string) {
  return Array.from(markdown.matchAll(/\[([^\]\n]+)\]\(([^)\n]+)\)/g));
}

function hasCanonicalRudderReference(markdown: string) {
  return findCanonicalReferenceCandidates(markdown).some((match) => {
    const label = match[1] ?? "";
    const href = match[2] ?? "";
    return Boolean(parseMentionChipHref(href) || parseSkillReference(href, label));
  });
}

function getMdastSourceSlice(node: unknown, markdown: string) {
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

function getMdastLinkLabel(node: unknown) {
  const link = node as { children?: Array<{ type?: string; value?: string }> };
  return (link.children ?? [])
    .map((child) => (child.type === "text" ? child.value ?? "" : ""))
    .join("")
    .trim();
}

export type PlainTextMarkdownSourcePart =
  | { kind: "text"; text: string }
  | { kind: "mention"; href: string; label: string }
  | { kind: "skill"; href: string; label: string };

export function splitPlainTextMarkdownSourceByAtomicReferences(markdown: string): PlainTextMarkdownSourcePart[] {
  const parts: PlainTextMarkdownSourcePart[] = [];
  let cursor = 0;

  for (const match of findCanonicalReferenceCandidates(markdown)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const label = match[1] ?? "";
    const href = match[2] ?? "";
    const parsedMention = parseMentionChipHref(href);
    const parsedSkill = parseSkillReference(href, label);

    if (!parsedMention && !parsedSkill) continue;

    if (start > cursor) {
      parts.push({ kind: "text", text: markdown.slice(cursor, start) });
    }
    if (parsedSkill) {
      parts.push({ kind: "skill", href: parsedSkill.href, label: parsedSkill.label });
    } else {
      parts.push({ kind: "mention", href, label });
    }
    cursor = end;
  }

  if (cursor < markdown.length) {
    parts.push({ kind: "text", text: markdown.slice(cursor) });
  }

  return parts.length > 0 ? parts : [{ kind: "text", text: markdown }];
}

function appendPlainTextMarkdownNodes(lexicalParent: LexicalNode, nodes: LexicalNode[]) {
  if (nodes.length === 0) return;
  if ($isElementNode(lexicalParent) && lexicalParent.getType() !== "root") {
    lexicalParent.append(...nodes);
    return;
  }

  const paragraph = $createParagraphNode();
  paragraph.append(...nodes);
  if ($isElementNode(lexicalParent)) {
    lexicalParent.append(paragraph);
  }
}

function appendPlainTextMarkdownNode(lexicalParent: LexicalNode, text: string) {
  const nodes: LexicalNode[] = [];
  for (const part of splitPlainTextMarkdownSourceByAtomicReferences(text)) {
    if (part.kind === "mention") {
      nodes.push($createMentionTokenNode(part.label, part.href));
    } else if (part.kind === "skill") {
      nodes.push($createSkillTokenNode(part.label, part.href));
    } else if (part.text) {
      nodes.push($createTextNode(part.text));
    }
  }
  appendPlainTextMarkdownNodes(lexicalParent, nodes);
}

function plainTextMarkdownImportPlugin(getMarkdown: () => string): RealmPlugin {
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

function canonicalMarkdownFromFragment(fragment: DocumentFragment) {
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

function tokenMarkdownIdentity(token: Pick<AtomicInlineTokenElement, "href" | "kind" | "label">) {
  if (token.kind === "skill") {
    const skillReference = parseSkillReference(token.href, token.label);
    return skillReference
      ? { href: skillReference.href, kind: token.kind, label: skillReference.label }
      : { href: token.href, kind: token.kind, label: token.label.trim() };
  }

  return {
    href: token.href,
    kind: token.kind,
    label: stripMentionChipLabelPrefix(token.label.trim()),
  };
}

function tokenIdentitiesMatch(
  left: Pick<AtomicInlineTokenElement, "href" | "kind" | "label">,
  right: Pick<AtomicInlineTokenElement, "href" | "kind" | "label">,
) {
  const normalizedLeft = tokenMarkdownIdentity(left);
  const normalizedRight = tokenMarkdownIdentity(right);
  return normalizedLeft.kind === normalizedRight.kind
    && normalizedLeft.href === normalizedRight.href
    && normalizedLeft.label === normalizedRight.label;
}

function findAtomicTokenDomOrdinal(editable: HTMLElement, token: AtomicInlineTokenElement) {
  const tokenElements = Array.from(editable.querySelectorAll("[data-skill-token='true'], [data-mention-kind], a"))
    .filter((element): element is HTMLElement => element instanceof HTMLElement)
    .filter((element) => {
      const candidate = readAtomicInlineTokenElement(element);
      return Boolean(candidate && tokenIdentitiesMatch(candidate, token));
    });

  const index = tokenElements.findIndex((element) => element === token.element || element.contains(token.element));
  return Math.max(0, index);
}

function findAtomicTokenMarkdownOffset(markdown: string, token: AtomicInlineTokenElement, ordinal: number) {
  const matches = findCanonicalReferenceCandidates(markdown).filter((match) => {
    const label = match[1]?.trim() ?? "";
    const href = match[2]?.trim() ?? "";
    const parsedSkill = parseSkillReference(href, label);
    const candidate = parsedSkill
      ? { href: parsedSkill.href, kind: "skill" as const, label: parsedSkill.label }
      : { href, kind: "mention" as const, label };
    return tokenIdentitiesMatch(candidate, token);
  });
  const match = matches[Math.min(ordinal, Math.max(0, matches.length - 1))];
  if (!match || typeof match.index !== "number") return null;

  let offset = match.index + match[0].length;
  while (offset < markdown.length && /[ \t\u00A0]/u.test(markdown[offset] ?? "")) {
    offset += 1;
  }
  return offset;
}

function isMarkdownOffsetImmediatelyAfterCanonicalReference(markdown: string, offset: number) {
  return findCanonicalReferenceCandidates(markdown).some((match) => {
    const start = match.index ?? -1;
    return start >= 0 && start + match[0].length === offset;
  });
}

function getLastCaretTarget(node: Node): CaretTarget {
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

function placeCaretNearInlineToken(token: HTMLElement) {
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

function getVisibleTextOffsetBeforeNode(editable: HTMLElement, node: Node) {
  const range = document.createRange();
  range.setStart(editable, 0);
  range.setEndBefore(node);
  return range.toString().length;
}

function getVisibleTextOffsetAtPosition(editable: HTMLElement, textNode: Text, offset: number) {
  const range = document.createRange();
  range.setStart(editable, 0);
  range.setEnd(textNode, offset);
  return range.toString().length;
}

function findFirstTextNodeInSubtree(node: Node): Text | null {
  if (node.nodeType === Node.TEXT_NODE) return node as Text;

  for (const child of Array.from(node.childNodes)) {
    const match = findFirstTextNodeInSubtree(child);
    if (match) return match;
  }

  return null;
}

function findFirstTextNodeAfterNode(root: Node, node: Node): Text | null {
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

function placeCaretAfterAtomicInlineToken(
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

function placeCaretAtVisibleTextOffset(
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

type LexicalTextPosition = {
  node: TextNode;
  offset: number;
};

function findLexicalTextPositionAtOffset(
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

function selectLexicalTextOffset(offset: number) {
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

function focusLexicalTextOffset(editor: LexicalEditor, offset: number) {
  editor.update(() => {
    selectLexicalTextOffset(offset);
  }, { discrete: true });
  editor.focus();
}

function closestAtomicInlineToken(target: EventTarget | null): HTMLElement | null {
  const element = target instanceof HTMLElement
    ? target
    : target instanceof Node
      ? target.parentElement
      : null;
  if (!element) return null;
  const token = element.closest("[data-skill-token='true'], [data-mention-kind]");
  return token instanceof HTMLElement ? token : null;
}

type AtomicInlineTokenEvent = {
  target: EventTarget | null;
  nativeEvent: Event & { stopImmediatePropagation?: () => void };
  preventDefault: () => void;
  stopPropagation: () => void;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  clientX?: number;
};

function stopAtomicInlineTokenEvent(
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

interface MentionState {
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

const mdxEditorTranslations: Translation = (key, defaultValue, interpolations) => {
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

function detectMention(container: HTMLElement): MentionState | null {
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

function getMentionMenuPosition(state: MentionState, size: MarkdownEditorProps["mentionMenuSize"] = "default") {
  return getMentionMenuPositionForViewport(
    state,
    window.innerWidth,
    window.innerHeight,
    size === "compact" ? { width: 320, maxHeight: 180 } : undefined,
  );
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function mentionMarkdown(option: MentionOption, agentMentionIntent?: "reference" | "wake"): string {
  const token = mentionTokenDetails(option, agentMentionIntent);
  return token ? `[${token.label}](${token.href}) ` : "";
}

function mentionVisibleLabel(option: MentionOption): string {
  return mentionTokenDetails(option)?.label ?? option.name;
}

function mentionTokenDetails(option: MentionOption, agentMentionIntent?: "reference" | "wake"): { href: string; isSkill: boolean; label: string } | null {
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
  if (option.kind === "chat" && option.chatConversationId) {
    return {
      href: buildChatMentionHref(option.chatConversationId, option.chatTitle ?? option.name),
      isSkill: false,
      label: option.name,
    };
  }
  if (option.kind === "library_doc" && option.libraryDocumentId) {
    return {
      href: buildLibraryDocMentionHref(option.libraryDocumentId, option.libraryDocumentTitle ?? option.name),
      isSkill: false,
      label: option.name,
    };
  }
  if (option.kind === "library_file" && option.libraryFilePath) {
    return {
      href: buildLibraryFileMentionHref(option.libraryFilePath, option.name),
      isSkill: false,
      label: option.name,
    };
  }
  if (option.kind === "library_directory" && option.libraryDirectoryPath) {
    return {
      href: buildLibraryDirectoryMentionHref(option.libraryDirectoryPath, option.name),
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

function getAllSubstringIndexes(value: string, search: string): number[] {
  const indexes: number[] = [];
  let idx = value.indexOf(search);
  while (idx !== -1) {
    indexes.push(idx);
    idx = value.indexOf(search, idx + search.length);
  }
  return indexes;
}

function countSubstringOccurrences(value: string, search: string): number {
  return getAllSubstringIndexes(value, search).length;
}

function commonSuffixLength(a: string, b: string, maxLength: number): number {
  const limit = Math.min(a.length, b.length, maxLength);
  let length = 0;
  while (length < limit && a[a.length - 1 - length] === b[b.length - 1 - length]) {
    length += 1;
  }
  return length;
}

function commonPrefixLength(a: string, b: string, maxLength: number): number {
  const limit = Math.min(a.length, b.length, maxLength);
  let length = 0;
  while (length < limit && a[length] === b[length]) {
    length += 1;
  }
  return length;
}

function getVisibleMentionOrdinal(editable: HTMLElement | null, state: MentionState, search: string): number | null {
  if (!editable || !editable.contains(state.textNode)) return null;
  const range = document.createRange();
  range.setStart(editable, 0);
  range.setEnd(state.textNode, state.atPos);
  return countSubstringOccurrences(range.toString(), search);
}

function findActiveMentionIndex(markdown: string, state: MentionState, editable: HTMLElement | null): number {
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
function applyMention(
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

function replaceMentionInLexicalEditor(
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

function rootEditorCapturePlugin(onEditor: (editor: LexicalEditor | null) => void): RealmPlugin {
  return realmPlugin({
    postInit(realm) {
      realm.pub(createRootEditorSubscription$, (editor) => {
        onEditor(editor);
        return () => onEditor(null);
      });
    },
  })();
}

function mergeMentionOptions(globalMentions: MentionOption[], localMentions: MentionOption[] | undefined) {
  if (!localMentions || localMentions.length === 0) return globalMentions;
  if (globalMentions.length === 0) return localMentions;
  const merged = new Map<string, MentionOption>();
  for (const mention of globalMentions) merged.set(mention.id, mention);
  for (const mention of localMentions) merged.set(mention.id, mention);
  return Array.from(merged.values());
}

/* ---- Component ---- */

const LegacyMarkdownEditor = forwardRef<MarkdownEditorRef, MarkdownEditorProps>(function LegacyMarkdownEditor({
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
  agentMentionIntent = "reference",
  mentionMenuAnchorRef,
  mentionMenuPlacement = "caret",
  mentionMenuSize = "default",
  onSubmit,
  submitShortcut = "mod-enter",
  plainText = false,
  onInlineTokenClick,
}: MarkdownEditorProps, forwardedRef) {
  const { locale } = useI18n();
  const navigate = useNavigate();
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
      if (mention.kind === "chat" && mention.chatConversationId) {
        map.set(`chat:${mention.chatConversationId}`, mention);
      }
      if (mention.kind === "project" && mention.projectId) {
        map.set(`project:${mention.projectId}`, mention);
      }
      if (mention.kind === "library_doc" && mention.libraryDocumentId) {
        map.set(`library_doc:${mention.libraryDocumentId}`, mention);
      }
      if (mention.kind === "library_file" && mention.libraryFilePath) {
        map.set(`library_file:${mention.libraryFilePath}`, mention);
      }
      if (mention.kind === "library_directory" && mention.libraryDirectoryPath) {
        map.set(`library_directory:${mention.libraryDirectoryPath}`, mention);
      }
    }
    return map;
  }, [mentions]);
  const skillDetailsHrefByTarget = useMemo(
    () => new Map(
      (mentions ?? [])
        .filter((mention) => mention.kind === "skill" && mention.skillMarkdownTarget && mention.skillDetailsHref)
        .map((mention) => [mention.skillMarkdownTarget!, mention.skillDetailsHref!] as const),
    ),
    [mentions],
  );

  const filteredMentions = useMemo(() => {
    if (!mentionState || !mentions) return [];
    return filterMentionOptions(mentions, mentionState.trigger, mentionState.query);
  }, [mentionState?.query, mentionState?.trigger, mentions]);
  useEffect(() => {
    onMentionQueryChange?.(mentionState?.trigger === "@" ? mentionState.query : null);
  }, [mentionState?.query, mentionState?.trigger, onMentionQueryChange]);
  const mentionMenuPosition = useMemo(
    () => {
      if (!mentionState) return null;
      if (mentionMenuPlacement === "container") {
        const anchor = mentionMenuAnchorRef?.current ?? containerRef.current;
        if (anchor) return getMentionPanelPosition(anchor);
      }
      return getMentionMenuPosition(mentionState, mentionMenuSize);
    },
    [mentionMenuAnchorRef, mentionMenuPlacement, mentionMenuSize, mentionState],
  );
  const groupedMentionOptions = useMemo(() => {
    const labelForKind = (kind: MentionOption["kind"]) => {
      if (kind === "skill") return "Skills";
      if (kind === "project") return "Projects";
      if (kind === "issue") return "Issues";
      if (kind === "chat") return "Chats";
      if (kind === "library_doc" || kind === "library_file" || kind === "library_directory") return "Library";
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

  const armPendingMentionInputFromToken = useCallback((token: AtomicInlineTokenElement) => {
    if (!plainText) return false;
    const editable = containerRef.current?.querySelector('[contenteditable="true"]');
    if (!(editable instanceof HTMLElement) || !editable.contains(token.element)) return false;

    const markdownOffset = findAtomicTokenMarkdownOffset(
      latestValueRef.current,
      token,
      findAtomicTokenDomOrdinal(editable, token),
    );
    if (markdownOffset === null) return false;

    pendingMentionInputRef.current = {
      markdownOffset,
      visibleOffset: getVisibleTextOffsetBeforeNode(editable, token.element) + token.label.length + 1,
    };
    clearPendingMentionInputSoon();
    return true;
  }, [clearPendingMentionInputSoon, plainText]);

  const armPendingMentionInputFromSelection = useCallback(() => {
    if (!plainText) return false;
    const selection = window.getSelection();
    const token = findAdjacentAtomicInlineTokenElement(selection, "backward")
      ?? readAtomicInlineTokenElement(selection?.anchorNode);
    if (!token) return false;
    return armPendingMentionInputFromToken(token);
  }, [armPendingMentionInputFromToken, plainText]);

  const insertPendingMentionText = useCallback((text: string) => {
    const pendingMentionInput = pendingMentionInputRef.current;
    if (!pendingMentionInput) return false;

    const current = latestValueRef.current;
    const needsBoundarySpace = pendingMentionInput.markdownOffset > 0
      && isMarkdownOffsetImmediatelyAfterCanonicalReference(current, pendingMentionInput.markdownOffset)
      && !/^[\s\p{P}\p{S}]/u.test(text);
    const textToInsert = needsBoundarySpace ? ` ${text}` : text;
    const next = current.slice(0, pendingMentionInput.markdownOffset)
      + textToInsert
      + current.slice(pendingMentionInput.markdownOffset);
    pendingMentionInput.markdownOffset += textToInsert.length;
    pendingMentionInput.visibleOffset += textToInsert.length;
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

  const insertTextAtAtomicBoundary = useCallback((text: string) => {
    if (!text) return false;
    if (!pendingMentionInputRef.current && !armPendingMentionInputFromSelection()) return false;
    return insertPendingMentionText(text);
  }, [armPendingMentionInputFromSelection, insertPendingMentionText]);

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
    getMarkdown: () => {
      const editorMarkdown = ref.current?.getMarkdown();
      if (typeof editorMarkdown !== "string") return latestValueRef.current;
      return plainText ? normalizePlainTextComposerMarkdown(editorMarkdown) : editorMarkdown;
    },
  }), [focusEditorAtEnd, plainText]);

  // Whether the image plugin should be included (boolean is stable across renders
  // as long as the handler presence doesn't toggle)
  const hasImageUpload = Boolean(imageUploadHandler);
  const translatedPlaceholder = useMemo(
    () => (placeholder ? translateLegacyString(locale, placeholder) : undefined),
    [locale, placeholder],
  );
  const hasEditorContent = value.replaceAll(INLINE_CARET_BOUNDARY, "").length > 0;

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

        if (parsed.kind === "library_doc" || parsed.kind === "library_file" || parsed.kind === "library_directory") {
          applyMentionChipDecoration(link, parsed);
          continue;
        }

        const option = mentionOptionByKey.get(`agent:${parsed.agentId}`);
        applyMentionChipDecoration(link, {
          ...parsed,
          icon: option?.agentIcon ?? parsed.icon ?? null,
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
      if (event.defaultPrevented) return;

      if (
        /^insert(?:Text|CompositionText|FromComposition)$/u.test(event.inputType)
        && typeof event.data === "string"
        && event.data.length > 0
        && insertTextAtAtomicBoundary(event.data)
      ) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

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
  }, [insertTextAtAtomicBoundary, removeAdjacentAtomicToken, value]);

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
      const replacement = mentionMarkdown(option, agentMentionIntent);
      const activeMarkdownIndex = findActiveMentionIndex(current, state, editableElement);
      const next = applyMention(current, state, option, editableElement, agentMentionIntent);
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
          ? replaceMentionInLexicalEditor(lexicalEditor, state, option, editableElement, agentMentionIntent)
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
                    : option.kind === "chat" && option.chatConversationId
                      ? buildChatMentionHref(option.chatConversationId, option.chatTitle ?? option.name)
                      : option.kind === "library_doc" && option.libraryDocumentId
                        ? buildLibraryDocMentionHref(option.libraryDocumentId, option.libraryDocumentTitle ?? option.name)
                        : option.kind === "library_file" && option.libraryFilePath
                          ? buildLibraryFileMentionHref(option.libraryFilePath, option.name)
                          : option.kind === "library_directory" && option.libraryDirectoryPath
                            ? buildLibraryDirectoryMentionHref(option.libraryDirectoryPath, option.name)
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
  const handleDefaultInlineTokenClick = useCallback((token: AtomicInlineTokenElement, _event: InlineTokenClickEvent) => {
    if (token.kind === "mention") {
      const parsed = parseMentionChipHref(token.href);
      if (!parsed) return;
      const target = mentionChipNavigationPath(parsed);
      navigate(target);
      return;
    }

    const detailsHref = skillDetailsHrefByTarget.get(token.href);
    if (detailsHref) {
      navigate(detailsHref);
    }
  }, [navigate, skillDetailsHrefByTarget]);
  const activateInlineToken = useCallback((event: AtomicInlineTokenEvent) => {
    const token = readAtomicInlineTokenElement(event.target instanceof Node ? event.target : null);
    if (!token) return false;
    if (plainText && !event.ctrlKey && !event.metaKey) {
      stopAtomicInlineTokenEvent(event, { placeCaret: true });
      armPendingMentionInputFromToken(token);
      return true;
    }
    stopAtomicInlineTokenEvent(event);
    (onInlineTokenClick ?? handleDefaultInlineTokenClick)(token, event);
    return true;
  }, [armPendingMentionInputFromToken, handleDefaultInlineTokenClick, onInlineTokenClick, plainText]);

  const placeAtomicInlineTokenCaret = useCallback((event: AtomicInlineTokenEvent) => {
    const token = readAtomicInlineTokenElement(event.target instanceof Node ? event.target : null);
    if (!token) return false;
    stopAtomicInlineTokenEvent(event, { placeCaret: true });
    armPendingMentionInputFromToken(token);
    return true;
  }, [armPendingMentionInputFromToken]);

  return (
    <div
      ref={containerRef}
      data-rudder-has-content={hasEditorContent ? "true" : "false"}
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
          insertTextAtAtomicBoundary(e.key);
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

        if (
          /^insert(?:Text|CompositionText|FromComposition)$/u.test(nativeEvent.inputType)
          && typeof nativeEvent.data === "string"
          && nativeEvent.data.length > 0
          && insertTextAtAtomicBoundary(nativeEvent.data)
        ) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }

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
        placeAtomicInlineTokenCaret(event);
      }}
      onMouseDownCapture={(event) => {
        placeAtomicInlineTokenCaret(event);
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
      onPasteCapture={(event) => {
        if (!plainText) return;
        const text = event.clipboardData.getData("text/plain");
        if (!text || !insertTextAtAtomicBoundary(text)) return;
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
                      const chatTimeLabel = option.chatUpdatedAt ? relativeTime(option.chatUpdatedAt) : null;
                      const chatTimeTitle = option.chatUpdatedAt ? formatDateTime(option.chatUpdatedAt) : undefined;
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
                              className="inline-flex shrink-0"
                              aria-label={`Status: ${issueStatusLabel}`}
                              title={issueStatusLabel}
                            >
                              <StatusIcon status={option.issueStatus ?? "default"} />
                            </span>
                          ) : option.kind === "chat" ? (
                            <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
                          ) : option.kind === "library_file" ? (
                            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                          ) : option.kind === "library_directory" ? (
                            <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
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
                            option.kind === "chat" ? (
                              <div className="min-w-0 flex-1 truncate font-medium text-foreground">
                                {option.name}
                              </div>
                            ) : option.kind === "issue" && option.issueId ? (
                              <div className="min-w-0 flex-1 truncate font-medium text-foreground">
                                {option.name}
                              </div>
                            ) : (
                              <div className="min-w-0 flex-1">
                                <div className="truncate font-medium text-foreground">{option.name}</div>
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
                                {option.kind === "library_doc" || option.kind === "library_file" || option.kind === "library_directory" ? (
                                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                                    {option.libraryDirectoryPath ?? option.libraryFilePath ?? option.libraryDocumentPath ?? "Doc"}
                                  </div>
                                ) : null}
                              </div>
                            )
                          ) : null}
                          {option.kind === "chat" && option.chatConversationId && (
                            <span className="ml-auto shrink-0 text-[11px] text-muted-foreground" title={chatTimeTitle}>
                              {chatTimeLabel ?? "Chat"}
                            </span>
                          )}
                          {((option.kind === "library_doc" && option.libraryDocumentId) || (option.kind === "library_file" && option.libraryFilePath) || (option.kind === "library_directory" && option.libraryDirectoryPath)) && (
                            <span className="ml-auto text-[11px] text-muted-foreground">
                              {option.kind === "library_directory" ? "Folder" : "Doc"}
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

export const MarkdownEditor = forwardRef<MarkdownEditorRef, MarkdownEditorProps>(function MarkdownEditor(props, forwardedRef) {
  const globalMentions = useMarkdownMentions();
  const mergedMentions = useMemo(
    () => mergeMentionOptions(globalMentions.mentions, props.mentions),
    [globalMentions.mentions, props.mentions],
  );
  const handleMentionQueryChange = useCallback((query: string | null) => {
    globalMentions.onMentionQueryChange(query);
    props.onMentionQueryChange?.(query);
  }, [globalMentions, props.onMentionQueryChange]);
  const editorProps = {
    ...props,
    mentions: mergedMentions,
    onMentionQueryChange: handleMentionQueryChange,
  };
  if (props.engine === "milkdown" && !props.plainText) {
    return <MilkdownMarkdownEditor {...editorProps} ref={forwardedRef} />;
  }
  return <LegacyMarkdownEditor {...editorProps} ref={forwardedRef} />;
});
