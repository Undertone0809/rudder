import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Milkdown, MilkdownProvider, useEditor, useInstance } from "@milkdown/react";
import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { TextSelection } from "@milkdown/kit/prose/state";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { Plugin as ProsePlugin } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { $prose, getMarkdown, insert, replaceAll } from "@milkdown/kit/utils";
import {
  buildAgentMentionHref,
  buildChatMentionHref,
  buildIssueMentionHref,
  buildLibraryDirectoryMentionHref,
  buildLibraryDocMentionHref,
  buildLibraryFileMentionHref,
  buildProjectMentionHref,
} from "@rudderhq/shared";
import { Boxes, FileText, Folder, MessageSquare } from "lucide-react";
import { useI18n } from "@/context/I18nContext";
import { translateLegacyString } from "@/i18n/legacyPhrases";
import { useScrollbarActivityRef } from "../hooks/useScrollbarActivityRef";
import {
  mentionChipInlineStyle,
  mentionChipNavigationPath,
  parseMentionChipHref,
  stripMentionChipLabelPrefix,
  type ParsedMentionChip,
} from "../lib/mention-chips";
import { projectColorBackgroundStyle } from "../lib/project-colors";
import {
  parseSkillReference,
  skillTokenIconInlineStyle,
} from "../lib/skill-reference";
import { filterMentionOptions } from "../lib/mention-filter";
import { cn } from "../lib/utils";
import { AgentIcon } from "./AgentIconPicker";
import { StatusIcon } from "./StatusIcon";
import type { MarkdownEditorProps, MarkdownEditorRef, MentionOption } from "./MarkdownEditor";
import {
  getMentionMenuPositionForViewport,
  getMentionPanelPositionForViewport,
} from "../lib/mention-menu-position";

export type MentionState = {
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

type ProseMirrorTextNode = {
  isText?: boolean;
  nodeSize: number;
  text?: string;
  marks?: Array<{
    type?: { name?: string };
    attrs?: { href?: string | null };
  }>;
};

type ProseMirrorDoc = {
  content: { size: number };
  descendants: (callback: (node: ProseMirrorTextNode, pos: number) => boolean | void) => void;
  textBetween?: (from: number, to: number, blockSeparator?: string, leafText?: string) => string;
};

type ProseMirrorTransaction = {
  delete: (from: number, to: number) => ProseMirrorTransaction;
  doc?: unknown;
  insert: (pos: number, content: unknown) => ProseMirrorTransaction;
  insertText: (text: string, from?: number, to?: number) => ProseMirrorTransaction;
  replaceWith: (from: number, to: number, content: unknown) => ProseMirrorTransaction;
  setSelection: (selection: unknown) => ProseMirrorTransaction;
  setStoredMarks: (marks: readonly unknown[] | null) => ProseMirrorTransaction;
};

type ProseMirrorState = {
  doc: ProseMirrorDoc;
  schema: {
    marks: {
      link?: { create: (attrs: { href: string }) => unknown };
    };
    text: (text: string, marks?: readonly unknown[]) => unknown;
  };
  selection: { empty?: boolean; from: number; to: number };
  tr: ProseMirrorTransaction;
};

type ProseMirrorView = {
  state: ProseMirrorState;
  dispatch: (transaction: ProseMirrorTransaction) => void;
  focus?: () => void;
  posAtDOM?: (node: Node, offset: number) => number;
};

type RudderTokenRange = {
  from: number;
  to: number;
  href: string;
  label: string;
};

function linkHrefFromTextNode(node: {
  marks?: Array<{ type?: { name?: string }; attrs?: { href?: string | null } }>;
}) {
  return node.marks?.find((mark) => mark.type?.name === "link" && mark.attrs?.href)?.attrs?.href?.trim() ?? "";
}

function mentionTokenDetails(option: MentionOption, agentMentionIntent?: "reference" | "wake"): { href: string; label: string } | null {
  if (option.kind === "skill") {
    if (!option.skillMarkdownTarget || !option.skillRefLabel) return null;
    return { href: option.skillMarkdownTarget, label: option.skillRefLabel };
  }
  if (option.kind === "issue" && option.issueId) {
    return { href: buildIssueMentionHref(option.issueId, option.issueIdentifier ?? null), label: option.name };
  }
  if (option.kind === "chat" && option.chatConversationId) {
    return { href: buildChatMentionHref(option.chatConversationId, option.chatTitle ?? option.name), label: option.name };
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
  if (option.kind === "library_directory" && option.libraryDirectoryPath) {
    return { href: buildLibraryDirectoryMentionHref(option.libraryDirectoryPath, option.name), label: option.name };
  }
  if (option.kind === "project" && option.projectId) {
    return { href: buildProjectMentionHref(option.projectId, option.projectColor ?? null), label: option.name };
  }
  const agentId = option.agentId ?? option.id.replace(/^agent:/, "");
  return { href: buildAgentMentionHref(agentId, option.agentIcon ?? null, agentMentionIntent), label: option.name };
}

export function mentionMarkdown(option: MentionOption, agentMentionIntent?: "reference" | "wake"): string {
  const token = mentionTokenDetails(option, agentMentionIntent);
  return token ? `[${token.label}](${token.href}) ` : "";
}

function canonicalMarkdownLink(label: string, href: string) {
  return `[${label}](${href})`;
}

function escapeInlineCode(value: string) {
  return value.replace(/`/g, "\\`");
}

export function isRudderTokenHref(href: string, label: string) {
  return Boolean(
    parseMentionChipHref(href)
    || parseSkillReference(href, label)
    || (href.trim().startsWith("skill://") && label.trim().startsWith("$")),
  );
}

const MARKDOWN_LINK_FRAGMENT_RE = /\[([^\]\n]+)]\(([^)\n]+)\)/g;

function unescapeMarkdownLinkDestination(value: string) {
  return value.replace(/\\([\\`*_[\]()#+\-.!{}>|&])/g, "$1").trim();
}

export function hasRudderMarkdownReference(markdown: string) {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const re = new RegExp(MARKDOWN_LINK_FRAGMENT_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(normalized)) !== null) {
    const label = match[1]?.trim() ?? "";
    const href = unescapeMarkdownLinkDestination(match[2] ?? "");
    if (isRudderTokenHref(href, label)) return true;
  }
  return false;
}

export function rudderTokenNavigationPath(href: string) {
  const parsed = parseMentionChipHref(href);
  if (parsed) {
    return mentionChipNavigationPath(parsed);
  }

  return null;
}

export function shouldParsePastedMarkdown(markdown: string) {
  const trimmed = markdown.trim();
  if (!trimmed) return false;
  if (hasRudderMarkdownReference(markdown)) return true;
  return /(^|\n)\s{0,3}#{1,6}\s+\S/.test(markdown)
    || /(^|\n)\s{0,3}(?:[-*+]\s+\S|\d+[.)]\s+\S|>\s+\S)/.test(markdown)
    || /(^|\n)\s{0,3}(?:```|~~~)/.test(markdown)
    || /!\[[^\]]*]\([^)]+\)/.test(markdown)
    || /\[[^\]]+]\([^)]+\)/.test(markdown)
    || /(^|\n)\s*\|.+\|\s*(?:\n|$)/.test(markdown);
}

function serializeInlineStyle(style: CSSProperties | undefined) {
  if (!style) return undefined;
  const declarations = Object.entries(style)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => `${key}: ${value};`);
  return declarations.length > 0 ? declarations.join(" ") : undefined;
}

function milkdownMentionDecorationAttrs(mention: ParsedMentionChip, label: string, href: string) {
  const classNames = ["rudder-mention-chip", `rudder-mention-chip--${mention.kind}`];
  if (mention.kind === "project") {
    classNames.push("rudder-project-mention-chip");
  }
  const attrs: Record<string, string> = {
    class: classNames.join(" "),
    "data-mention-kind": mention.kind,
    "data-mention-href": href,
  };
  const navigationPath = rudderTokenNavigationPath(href);
  attrs.title = navigationPath ? `Open ${label}` : label;
  const style = serializeInlineStyle(mentionChipInlineStyle(mention));
  if (style) {
    attrs.style = style;
  }
  return attrs;
}

function applyMentionStyleProperties(element: HTMLElement, mention: ParsedMentionChip) {
  element.style.removeProperty("--rudder-mention-project-color");
  element.style.removeProperty("--rudder-mention-agent-avatar-background");
  element.style.removeProperty("--rudder-mention-agent-avatar-shell-background");
  element.style.removeProperty("--rudder-mention-icon-mask");
  const style = mentionChipInlineStyle(mention);
  if (!style) return;
  for (const [key, value] of Object.entries(style)) {
    if (typeof value !== "string") continue;
    if (key.startsWith("--")) {
      element.style.setProperty(key, value);
    } else {
      (element.style as CSSStyleDeclaration & Record<string, string>)[key] = value;
    }
  }
}

function refreshMilkdownMentionTokenStyles(root: HTMLElement | null, mentions: MentionOption[]) {
  if (!root) return;
  const optionByKey = mentionOptionMap(mentions);
  for (const element of root.querySelectorAll<HTMLElement>("[data-mention-href]")) {
    const parsed = parseMentionChipHref(element.dataset.mentionHref ?? "");
    if (!parsed) continue;
    const mention = parsed.kind === "agent"
      ? { ...parsed, icon: optionByKey.get(`agent:${parsed.agentId}`)?.agentIcon ?? parsed.icon ?? null }
      : parsed.kind === "project"
        ? { ...parsed, color: parsed.color ?? optionByKey.get(`project:${parsed.projectId}`)?.projectColor ?? null }
        : parsed;
    applyMentionStyleProperties(element, mention);
  }
}

function milkdownSkillDecorationAttrs(href: string, label: string) {
  const attrs: Record<string, string> = {
    class: "rudder-skill-token",
    "data-skill-token": "true",
    "data-skill-href": href,
    title: label,
  };
  const style = serializeInlineStyle(skillTokenIconInlineStyle());
  if (style) {
    attrs.style = style;
  }
  return attrs;
}

function mentionOptionMap(mentions: MentionOption[]) {
  const map = new Map<string, MentionOption>();
  for (const mention of mentions) {
    if (mention.kind === "agent") {
      const agentId = mention.agentId ?? mention.id.replace(/^agent:/, "");
      map.set(`agent:${agentId}`, mention);
    }
    if (mention.kind === "project" && mention.projectId) {
      map.set(`project:${mention.projectId}`, mention);
    }
  }
  return map;
}

function buildMilkdownTokenDecorations(doc: ProseMirrorDoc, mentions: MentionOption[]) {
  const optionByKey = mentionOptionMap(mentions);
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const href = linkHrefFromTextNode(node);
    if (!href) return;

    const parsed = parseMentionChipHref(href);
    if (parsed) {
      const label = node.text.replace(/^@(?=\S)/, "");
      const mention = parsed.kind === "agent"
        ? { ...parsed, icon: optionByKey.get(`agent:${parsed.agentId}`)?.agentIcon ?? parsed.icon ?? null }
        : parsed.kind === "project"
          ? { ...parsed, color: parsed.color ?? optionByKey.get(`project:${parsed.projectId}`)?.projectColor ?? null }
          : parsed;
      decorations.push(Decoration.inline(pos, pos + node.nodeSize, milkdownMentionDecorationAttrs(mention, label, href)));
      return;
    }

    const skillReference = parseSkillReference(href, node.text);
    if (skillReference) {
      decorations.push(Decoration.inline(pos, pos + node.nodeSize, milkdownSkillDecorationAttrs(skillReference.href, skillReference.label)));
    }
  });
  return DecorationSet.create(doc as never, decorations);
}

function findRudderTokenRangeAt(doc: ProseMirrorDoc, targetPos: number): RudderTokenRange | null {
  if (targetPos < 0 || targetPos >= doc.content.size) return null;
  let match: RudderTokenRange | null = null;
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const href = linkHrefFromTextNode(node);
    if (!href) return;
    const from = pos;
    const to = pos + node.nodeSize;
    if (targetPos < from || targetPos >= to) return;
    if (!isRudderTokenHref(href, node.text)) return;
    match = { from, to, href, label: node.text };
    return false;
  });
  return match;
}

function findAdjacentRudderTokenRange(state: ProseMirrorState, direction: "backward" | "forward") {
  if (!state.selection.empty) return null;
  const { from } = state.selection;
  if (direction === "backward" && isWhitespaceText(textAt(state.doc, from - 1, from))) {
    return null;
  }
  const candidates = direction === "backward" ? [from - 1] : [from, from + 1];
  for (const candidate of candidates) {
    const range = findRudderTokenRangeAt(state.doc, candidate);
    if (range) return range;
  }
  return null;
}

function findContainingRudderTokenRange(state: ProseMirrorState) {
  if (!state.selection.empty) return null;
  const { from } = state.selection;
  const candidates = [from, from - 1];
  for (const candidate of candidates) {
    const range = findRudderTokenRangeAt(state.doc, candidate);
    if (range && from > range.from && from < range.to) return range;
  }
  return null;
}

function isPrintableInputKey(event: React.KeyboardEvent) {
  return event.key.length === 1
    && !event.nativeEvent.isComposing
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey;
}

function textAt(doc: ProseMirrorDoc, from: number, to: number) {
  if (from < 0 || to <= from || from >= doc.content.size) return "";
  return doc.textBetween?.(from, Math.min(to, doc.content.size), "\n", "\n") ?? "";
}

function isWhitespaceText(value: string) {
  return value.length > 0 && /^\s$/u.test(value);
}

function shouldInsertTokenBoundarySpace(value: string) {
  const firstChar = Array.from(value)[0] ?? "";
  return Boolean(firstChar) && !/^[\p{P}\p{S}]$/u.test(firstChar);
}

type FragmentMarkdownOptions = {
  bareListKind?: "ordered" | "unordered";
  bareListStart?: number;
};

export function readCanonicalFragmentMarkdown(fragment: DocumentFragment, options: FragmentMarkdownOptions = {}) {
  const normalize = (value: string) => value
    .replace(/\u200B/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  function readInline(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node instanceof HTMLBRElement) return "\n";
    if (node instanceof HTMLAnchorElement) {
      const label = node.textContent ?? "";
      const href = node.getAttribute("href") ?? "";
      if (href) {
        return canonicalMarkdownLink(label, href);
      }
    }
    if (node instanceof HTMLElement && node.tagName === "CODE" && !(node.parentElement instanceof HTMLPreElement)) {
      return `\`${escapeInlineCode(node.textContent ?? "")}\``;
    }
    if (node instanceof HTMLElement && (node.tagName === "STRONG" || node.tagName === "B")) {
      return `**${Array.from(node.childNodes).map(readInline).join("")}**`;
    }
    if (node instanceof HTMLElement && (node.tagName === "EM" || node.tagName === "I")) {
      return `*${Array.from(node.childNodes).map(readInline).join("")}*`;
    }
    if (node instanceof HTMLUListElement || node instanceof HTMLOListElement) {
      return `\n${readList(node, 0)}\n`;
    }
    if (node instanceof HTMLLIElement) {
      const marker = options.bareListKind === "ordered" ? `${bareListOrdinal}.` : "-";
      bareListOrdinal += 1;
      return `${readListItem(node, marker, 0)}\n`;
    }
    if (node instanceof HTMLParagraphElement || node instanceof HTMLDivElement) {
      return `${Array.from(node.childNodes).map(readInline).join("")}\n`;
    }
    return Array.from(node.childNodes).map(readInline).join("");
  }

  function readListItem(item: HTMLLIElement, marker: string, indentLevel: number) {
    const indent = "  ".repeat(indentLevel);
    const nestedLists: string[] = [];
    const bodyParts: string[] = [];

    for (const child of Array.from(item.childNodes)) {
      if (child instanceof HTMLUListElement || child instanceof HTMLOListElement) {
        nestedLists.push(readList(child, indentLevel + 1));
        continue;
      }
      bodyParts.push(readInline(child));
    }

    const body = normalize(bodyParts.join(""));
    const lines = body ? body.split("\n") : [""];
    const rendered = [`${indent}${marker} ${lines[0] ?? ""}`.trimEnd()];
    for (const line of lines.slice(1)) {
      rendered.push(`${indent}  ${line}`.trimEnd());
    }
    for (const nested of nestedLists) {
      if (nested.trim()) rendered.push(nested);
    }
    return rendered.join("\n");
  }

  function readList(list: HTMLUListElement | HTMLOListElement, indentLevel: number) {
    const ordered = list instanceof HTMLOListElement;
    const start = Number.parseInt(list.getAttribute("start") ?? "1", 10);
    let ordinal = Number.isFinite(start) ? start : 1;
    const items: string[] = [];

    for (const child of Array.from(list.children)) {
      if (!(child instanceof HTMLLIElement)) continue;
      const marker = ordered ? `${ordinal}.` : "-";
      items.push(readListItem(child, marker, indentLevel));
      ordinal += 1;
    }

    return items.join("\n");
  }

  let bareListOrdinal = options.bareListStart ?? 1;
  return normalize(Array.from(fragment.childNodes).map(readInline).join(""));
}

function fragmentContainsList(fragment: DocumentFragment) {
  return Boolean(fragment.querySelector("ul, ol, li"));
}

function listMarkdownOptionsForSelection(selection: Selection): FragmentMarkdownOptions {
  if (selection.rangeCount === 0) return {};
  const range = selection.getRangeAt(0);
  const ancestor = range.commonAncestorContainer instanceof Element
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  const list = ancestor?.closest("ol, ul");
  if (!(list instanceof HTMLOListElement)) {
    return list instanceof HTMLUListElement ? { bareListKind: "unordered" } : {};
  }

  const selectedListItems = Array.from(list.children)
    .filter((child): child is HTMLLIElement => child instanceof HTMLLIElement && range.intersectsNode(child));
  const firstSelectedIndex = selectedListItems.length > 0
    ? Array.from(list.children).indexOf(selectedListItems[0]!)
    : 0;
  const start = Number.parseInt(list.getAttribute("start") ?? "1", 10);
  return {
    bareListKind: "ordered",
    bareListStart: (Number.isFinite(start) ? start : 1) + Math.max(0, firstSelectedIndex),
  };
}

function normalizeVisibleCopyText(value: string) {
  return value
    .replace(/\u200B/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  const index = findActiveMentionIndex(markdown, state, editable);
  if (index === -1) {
    const text = state.textNode.textContent ?? "";
    if (!text) return markdown;
    return text.slice(0, state.atPos) + replacement + text.slice(state.endPos);
  }
  const replacementEnd = index + search.length;
  const replaceLength = replacement.endsWith(" ") && markdown[replacementEnd] === " "
    ? search.length + 1
    : search.length;
  return markdown.slice(0, index) + replacement + markdown.slice(index + replaceLength);
}

export function insertMentionIntoProseMirrorView(
  view: ProseMirrorView,
  state: MentionState,
  option: MentionOption,
  agentMentionIntent?: "reference" | "wake",
) {
  const token = mentionTokenDetails(option, agentMentionIntent);
  if (!token) return false;
  const triggerText = `${state.trigger}${state.query}`;
  const { from, to } = view.state.selection;
  const start = Math.max(0, from - triggerText.length);
  const replaceTo = isWhitespaceText(textAt(view.state.doc, to, to + 1)) ? to + 1 : to;
  const linkMark = view.state.schema.marks.link?.create({ href: token.href });
  const mentionNode = view.state.schema.text(token.label, linkMark ? [linkMark] : undefined);
  const spaceNode = view.state.schema.text(" ");
  const tr = view.state.tr
    .replaceWith(start, replaceTo, [mentionNode, spaceNode])
    .setStoredMarks([]);
  const selectionPos = start + token.label.length + 1;
  if (tr.doc) {
    tr.setSelection(TextSelection.create(tr.doc as Parameters<typeof TextSelection.create>[0], selectionPos));
  }
  view.dispatch(tr);
  return true;
}

export function insertTextAfterRudderTokenBoundary(view: ProseMirrorView, text: string) {
  if (!text || !view.state.selection.empty) return false;
  const containingRange = findContainingRudderTokenRange(view.state);
  const adjacentRange = findAdjacentRudderTokenRange(view.state, "backward");
  const range = containingRange ?? adjacentRange;
  if (!range) return false;

  const followingText = textAt(view.state.doc, range.to, range.to + 1);
  const insertPos = isWhitespaceText(followingText) ? range.to + 1 : range.to;
  const textToInsert = isWhitespaceText(followingText) || text === " " || !shouldInsertTokenBoundarySpace(text)
    ? text
    : ` ${text}`;
  const tr = view.state.tr
    .insert(insertPos, view.state.schema.text(textToInsert))
    .setStoredMarks([]);
  if (tr.doc) {
    tr.setSelection(TextSelection.create(
      tr.doc as Parameters<typeof TextSelection.create>[0],
      insertPos + textToInsert.length,
    ));
  }
  view.dispatch(tr);
  return true;
}

export function moveSelectionAfterRudderTokenBoundary(view: ProseMirrorView) {
  if (!view.state.selection.empty) return false;
  const containingRange = findContainingRudderTokenRange(view.state);
  const adjacentRange = findAdjacentRudderTokenRange(view.state, "backward");
  const range = containingRange ?? adjacentRange;
  if (!range) return false;

  const followingText = textAt(view.state.doc, range.to, range.to + 1);
  const tr = isWhitespaceText(followingText)
    ? view.state.tr
    : view.state.tr.insert(range.to, view.state.schema.text(" "));
  const selectionPos = isWhitespaceText(followingText) ? range.to + 1 : range.to + 1;
  if (tr.doc) {
    tr.setSelection(TextSelection.create(
      tr.doc as Parameters<typeof TextSelection.create>[0],
      selectionPos,
    ));
  }
  tr.setStoredMarks([]);
  view.dispatch(tr);
  return true;
}

function placeSelectionAfterRudderTokenAnchor(view: ProseMirrorView, anchor: HTMLAnchorElement) {
  if (!view.posAtDOM) return false;
  const lastChild = anchor.lastChild;
  const targetNode = lastChild ?? anchor;
  const targetOffset = targetNode.nodeType === Node.TEXT_NODE
    ? (targetNode.textContent ?? "").length
    : anchor.childNodes.length;
  let targetPos: number;
  try {
    targetPos = view.posAtDOM(targetNode, targetOffset);
  } catch {
    return false;
  }
  const range =
    findRudderTokenRangeAt(view.state.doc, Math.max(0, targetPos - 1))
    ?? findRudderTokenRangeAt(view.state.doc, targetPos);
  if (!range) return false;
  const tr = view.state.tr
    .setSelection(TextSelection.create(
      view.state.doc as unknown as Parameters<typeof TextSelection.create>[0],
      range.to,
    ))
    .setStoredMarks([]);
  view.dispatch(tr);
  moveSelectionAfterRudderTokenBoundary(view);
  view.focus?.();
  return true;
}

export function focusProseMirrorViewAtEnd(view: ProseMirrorView) {
  const endPos = Math.max(1, view.state.doc.content.size);
  const tr = view.state.tr
    .setSelection(TextSelection.create(
      view.state.doc as unknown as Parameters<typeof TextSelection.create>[0],
      endPos,
    ))
    .setStoredMarks([]);
  view.dispatch(tr);
  view.focus?.();
}

export function insertMissingRudderTokenBoundarySpaces(view: ProseMirrorView) {
  if (!view.state.selection.empty) return false;
  const selectionFrom = view.state.selection.from;
  let insertionPos: number | null = null;
  view.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const href = linkHrefFromTextNode(node);
    if (!href || !isRudderTokenHref(href, node.text)) return;
    const range = { from: pos, to: pos + node.nodeSize, href, label: node.text };
    if (range.to > selectionFrom) return;
    const followingText = textAt(view.state.doc, range.to, range.to + 1);
    const textToSelection = textAt(view.state.doc, range.to, selectionFrom);
    if (
      followingText
      && !isWhitespaceText(followingText)
      && shouldInsertTokenBoundarySpace(followingText)
      && textToSelection
      && !/\s/u.test(textToSelection)
    ) {
      insertionPos = range.to;
    }
  });
  if (insertionPos === null) return false;

  const { from } = view.state.selection;
  const tr = view.state.tr
    .insert(insertionPos, view.state.schema.text(" "))
    .setStoredMarks([]);
  if (tr.doc) {
    const selectionPos = from >= insertionPos ? from + 1 : from;
    tr.setSelection(TextSelection.create(
      tr.doc as Parameters<typeof TextSelection.create>[0],
      selectionPos,
    ));
  }
  view.dispatch(tr);
  return true;
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

function BrowserPortal({ children }: { children: ReactNode }) {
  return typeof document === "undefined" ? <>{children}</> : createPortal(children, document.body);
}

export function isMilkdownEditableUnexpectedlyBlank(
  editable: HTMLElement | null,
  expectedMarkdown: string,
): boolean {
  if (!editable) return false;
  if (!expectedMarkdown.trim()) return false;

  const visibleText = (editable.textContent ?? "").replace(/\u200b/g, "").trim();
  if (visibleText) return false;

  const meaningfulElement = editable.querySelector(
    [
      "img",
      "svg",
      "video",
      "audio",
      "iframe",
      "table",
      "pre",
      "code",
      "blockquote",
      "ul",
      "ol",
      "li",
      "hr",
      "a[href]",
      "[data-mention-href]",
      "[data-skill-token='true']",
    ].join(","),
  );
  return !meaningfulElement;
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
  mentionMenuSize = "default",
  onSubmit,
  submitShortcut = "mod-enter",
  agentMentionIntent = "reference",
  onInlineTokenClick,
}: MarkdownEditorProps, forwardedRef) {
  const { locale } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const latestValueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onBlurRef = useRef(onBlur);
  const imageUploadHandlerRef = useRef(imageUploadHandler);
  const mentionsRef = useRef<MentionOption[]>(mentions ?? []);
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
    mentionsRef.current = mentions ?? [];
  }, [imageUploadHandler, onBlur, onChange]);

  const tokenDecorationsPlugin = useMemo(
    () => $prose(() => new ProsePlugin({
      props: {
        decorations: (state) => buildMilkdownTokenDecorations(state.doc as unknown as ProseMirrorDoc, mentionsRef.current),
        handleDOMEvents: {
          beforeinput: (view, event) => {
            const inputEvent = event as InputEvent;
            if (inputEvent.inputType === "insertCompositionText") {
              moveSelectionAfterRudderTokenBoundary(view as unknown as ProseMirrorView);
              return false;
            }
            if (inputEvent.inputType !== "insertText" || !inputEvent.data) return false;
            const repaired = insertTextAfterRudderTokenBoundary(view as unknown as ProseMirrorView, inputEvent.data);
            if (!repaired) return false;
            event.preventDefault();
            queueMicrotask(() => view.dom.dispatchEvent(new Event("input", { bubbles: true })));
            return true;
          },
          input: (view) => {
            insertMissingRudderTokenBoundarySpaces(view as unknown as ProseMirrorView);
            return false;
          },
        },
      },
    })),
    [],
  );

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
      .use(gfm)
      .use(tokenDecorationsPlugin),
  [tokenDecorationsPlugin]);

  const [loading, getInstance] = useInstance();

  useEffect(() => {
    const activeElement = typeof document !== "undefined" ? document.activeElement : null;
    const editable = containerRef.current?.querySelector('[contenteditable="true"]');
    const shouldRestoreFocus = Boolean(
      mentionStateRef.current
      && editable instanceof HTMLElement
      && activeElement instanceof Node
      && editable.contains(activeElement),
    );
    mentionsRef.current = mentions ?? [];
    const editor = loading ? get() : getInstance();
    editor?.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.setMeta("rudderMentionOptionsUpdated", true));
    });
    requestAnimationFrame(() => refreshMilkdownMentionTokenStyles(containerRef.current, mentionsRef.current));
    if (shouldRestoreFocus) {
      requestAnimationFrame(() => {
        const currentEditor = loading ? get() : getInstance();
        currentEditor?.action((ctx) => {
          ctx.get(editorViewCtx).focus();
        });
      });
    }
  }, [get, getInstance, loading, mentions]);

  useEffect(() => {
    requestAnimationFrame(() => refreshMilkdownMentionTokenStyles(containerRef.current, mentionsRef.current));
  }, [value]);

  const focus = useCallback(() => {
    const editor = loading ? get() : getInstance();
    editor?.action((ctx) => {
      focusProseMirrorViewAtEnd(ctx.get(editorViewCtx) as unknown as ProseMirrorView);
    });
  }, [get, getInstance, loading]);

  const getCurrentMarkdown = useCallback(() => {
    let markdown = latestValueRef.current;
    const editor = loading ? get() : getInstance();
    editor?.action((ctx) => {
      markdown = getMarkdown()(ctx);
    });
    return markdown;
  }, [get, getInstance, loading]);

  const repairUnexpectedBlankDom = useCallback(() => {
    const editable = containerRef.current?.querySelector('[contenteditable="true"]');
    if (!(editable instanceof HTMLElement)) return;
    if (!isMilkdownEditableUnexpectedlyBlank(editable, latestValueRef.current)) return;

    const editor = loading ? get() : getInstance();
    editor?.action(replaceAll(latestValueRef.current, true));
    requestAnimationFrame(() => refreshMilkdownMentionTokenStyles(containerRef.current, mentionsRef.current));
  }, [get, getInstance, loading]);

  useImperativeHandle(forwardedRef, () => ({
    focus,
    getMarkdown: getCurrentMarkdown,
  }), [focus, getCurrentMarkdown]);

  useEffect(() => {
    if (value === latestValueRef.current) return;
    latestValueRef.current = value;
    const editor = loading ? get() : getInstance();
    editor?.action(replaceAll(value, true));
  }, [get, getInstance, loading, value]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;

    let frameId: number | null = null;
    const scheduleRepair = () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        repairUnexpectedBlankDom();
      });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") scheduleRepair();
    };

    window.addEventListener("focus", scheduleRepair);
    window.addEventListener("pageshow", scheduleRepair);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      window.removeEventListener("focus", scheduleRepair);
      window.removeEventListener("pageshow", scheduleRepair);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [repairUnexpectedBlankDom]);

  const filteredMentions = useMemo(() => {
    if (!mentionState || !mentions) return [];
    return filterMentionOptions(mentions, mentionState.trigger, mentionState.query);
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
    return getMentionMenuPositionForViewport(
      mentionState,
      window.innerWidth,
      window.innerHeight,
      mentionMenuSize === "compact" ? { width: 320, maxHeight: 180 } : undefined,
    );
  }, [mentionMenuAnchorRef, mentionMenuPlacement, mentionMenuSize, mentionState]);

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
    const editor = loading ? get() : getInstance();
    const editable = containerRef.current?.querySelector('[contenteditable="true"]');
    const next = applyMention(
      latestValueRef.current,
      state,
      option,
      editable instanceof HTMLElement ? editable : null,
      agentMentionIntent,
    );
    let insertedInEditor = false;
    editor?.action((ctx) => {
      insertedInEditor = insertMentionIntoProseMirrorView(
        ctx.get(editorViewCtx) as unknown as ProseMirrorView,
        state,
        option,
        agentMentionIntent,
      );
    });
    if (insertedInEditor && next !== latestValueRef.current) {
      latestValueRef.current = next;
      onChangeRef.current(next);
    }
    if (!insertedInEditor) {
      if (next !== latestValueRef.current) {
        latestValueRef.current = next;
        onChangeRef.current(next);
        editor?.action(replaceAll(next, true));
      }
    }
    requestAnimationFrame(() => {
      const currentEditor = loading ? get() : getInstance();
      currentEditor?.action((ctx) => {
        if (insertedInEditor) {
          ctx.get(editorViewCtx).focus();
          return;
        }
        focusProseMirrorViewAtEnd(ctx.get(editorViewCtx) as unknown as ProseMirrorView);
      });
    });
    mentionStateRef.current = null;
    setMentionState(null);
  }, [get, getInstance, loading]);

  const removeAdjacentRudderToken = useCallback((direction: "backward" | "forward") => {
    const editor = loading ? get() : getInstance();
    let removed = false;
    editor?.action((ctx) => {
      const view = ctx.get(editorViewCtx) as unknown as ProseMirrorView;
      const range = findAdjacentRudderTokenRange(view.state, direction);
      if (!range) return;
      let deleteTo = range.to;
      const followingText = view.state.doc.content.size > range.to
        ? view.state.doc.textBetween?.(range.to, Math.min(range.to + 1, view.state.doc.content.size), "\n", "\n")
        : "";
      if (followingText === " ") {
        deleteTo += 1;
      }
      view.dispatch(view.state.tr.delete(range.from, deleteTo));
      removed = true;
    });
    return removed;
  }, [get, getInstance, loading]);

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

        if (event.key === "Backspace" || event.key === "Delete") {
          const direction = event.key === "Backspace" ? "backward" : "forward";
          if (removeAdjacentRudderToken(direction)) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
        }

        if (isPrintableInputKey(event)) {
          const editor = loading ? get() : getInstance();
          let repairedTokenBoundary = false;
          editor?.action((ctx) => {
            const view = ctx.get(editorViewCtx) as unknown as ProseMirrorView;
            repairedTokenBoundary = insertTextAfterRudderTokenBoundary(view, event.key);
          });
          if (repairedTokenBoundary) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
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
      onInputCapture={() => {
        const editor = loading ? get() : getInstance();
        editor?.action((ctx) => {
          const view = ctx.get(editorViewCtx) as unknown as ProseMirrorView;
          insertMissingRudderTokenBoundarySpaces(view);
          const markdown = getMarkdown()(ctx);
          if (markdown !== latestValueRef.current) {
            latestValueRef.current = markdown;
            onChangeRef.current(markdown);
          }
        });
      }}
      onCopyCapture={(event) => {
        const selection = window.getSelection();
        const editable = containerRef.current?.querySelector('[contenteditable="true"]');
        if (
          !selection
          || selection.rangeCount === 0
          || selection.isCollapsed
          || !(editable instanceof HTMLElement)
          || !editable.contains(selection.anchorNode)
          || !editable.contains(selection.focusNode)
        ) {
          return;
        }
        const selectedFragment = selection.getRangeAt(0).cloneContents();
        const fragmentMarkdownOptions = listMarkdownOptionsForSelection(selection);
        let canonicalMarkdown = "";
        const selectedVisibleText = normalizeVisibleCopyText(selection.toString());
        const fullVisibleText = normalizeVisibleCopyText(editable.innerText);
        if (selectedVisibleText && selectedVisibleText === fullVisibleText) {
          canonicalMarkdown = latestValueRef.current;
        }
        if (!canonicalMarkdown && fragmentContainsList(selectedFragment)) {
          canonicalMarkdown = readCanonicalFragmentMarkdown(selectedFragment, fragmentMarkdownOptions);
        }
        const editor = loading ? get() : getInstance();
        if (!canonicalMarkdown) {
          editor?.action((ctx) => {
            const view = ctx.get(editorViewCtx) as unknown as ProseMirrorView;
            if (view.state.selection.empty) return;
            canonicalMarkdown = getMarkdown({
              from: view.state.selection.from,
              to: view.state.selection.to,
            })(ctx);
          });
        }
        if (!canonicalMarkdown) {
          canonicalMarkdown = selectedVisibleText && selectedVisibleText === fullVisibleText
            ? latestValueRef.current
            : "";
        }
        if (!canonicalMarkdown) {
          canonicalMarkdown = readCanonicalFragmentMarkdown(selectedFragment, fragmentMarkdownOptions);
        }
        if (!canonicalMarkdown.trim()) return;
        event.preventDefault();
        event.clipboardData.setData("text/plain", canonicalMarkdown);
      }}
      onClickCapture={(event) => {
        const anchor = event.target instanceof HTMLElement ? event.target.closest("a") : null;
        if (!(anchor instanceof HTMLAnchorElement)) return;
        const label = anchor.textContent ?? "";
        const href = anchor.getAttribute("href") ?? "";
        if (!href || !isRudderTokenHref(href, label)) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.metaKey && !event.ctrlKey) {
          const editor = loading ? get() : getInstance();
          editor?.action((ctx) => {
            placeSelectionAfterRudderTokenAnchor(ctx.get(editorViewCtx) as unknown as ProseMirrorView, anchor);
          });
          return;
        }
        if (onInlineTokenClick) {
          const skillReference = parseSkillReference(href, label);
          onInlineTokenClick(
            skillReference
              ? {
                  element: anchor,
                  href: skillReference.href,
                  kind: "skill",
                  label: skillReference.label,
                }
              : {
                  element: anchor,
                  href,
                  kind: "mention",
                  label: stripMentionChipLabelPrefix(label),
                },
            event,
          );
          return;
        }
        const navigationPath = rudderTokenNavigationPath(href);
        if (!navigationPath) return;
        window.location.assign(navigationPath);
      }}
      onKeyUpCapture={checkMention}
      onMouseUpCapture={checkMention}
      onPasteCapture={(event) => {
        if (canDropImage && hasFilePayload(event)) {
          const file = firstImageFile(event.clipboardData.files);
          if (!file) return;
          event.preventDefault();
          void uploadImage(file);
          return;
        }

        const markdown = event.clipboardData.getData("text/plain");
        if (!markdown || !shouldParsePastedMarkdown(markdown)) return;
        event.preventDefault();
        const editor = loading ? get() : getInstance();
        editor?.action(insert(markdown, false));
        requestAnimationFrame(checkMention);
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
        <BrowserPortal>
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
                      {option.kind === "chat" && option.chatConversationId ? (
                        <span className="ml-auto text-[11px] text-muted-foreground">Chat</span>
                      ) : null}
                      {((option.kind === "library_doc" && option.libraryDocumentId)
                        || (option.kind === "library_file" && option.libraryFilePath)
                        || (option.kind === "library_directory" && option.libraryDirectoryPath)) ? (
                        <span className="ml-auto text-[11px] text-muted-foreground">
                          {option.kind === "library_directory" ? "Folder" : "Doc"}
                        </span>
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
        </BrowserPortal>
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
