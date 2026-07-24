import { markdownLanguage } from "@codemirror/lang-markdown";
import { resolveKnownWebsiteIcon } from "@rudderhq/shared";

export type MarkdownPreviewBlockKind =
  | "line"
  | "table"
  | "fenced-code"
  | "indented-code"
  | "setext-heading"
  | "list"
  | "blockquote"
  | "html";

export interface MarkdownPreviewBlock {
  id: string;
  from: number;
  to: number;
  startLine: number;
  endLine: number;
  kind: MarkdownPreviewBlockKind;
  markdown: string;
  previewable: boolean;
}

export interface MarkdownSelectionRange {
  from: number;
  to: number;
}

export interface AtomicMarkdownReference {
  from: number;
  to: number;
  markdown: string;
  label: string;
  href: string;
}

interface SourceLine {
  number: number;
  from: number;
  to: number;
  text: string;
}

const FENCE_START_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const TABLE_DELIMITER_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/u;
const SETEXT_DELIMITER_RE = /^ {0,3}(?:=+|-+)\s*$/u;
const RAW_HTML_LINE_RE =
  /^\s*<\/?[a-z][\w-]*(?:\s[^>]*)?\s*\/?>|^\s*<!--|^\s*<![A-Z]|^\s*<\?|^\s*<%/iu;
const LIST_ITEM_RE = /^ {0,3}(?:[-+*]|\d+[.)])[ \t]+/u;
const BLOCKQUOTE_RE = /^ {0,3}>/u;
const ATX_HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]+|$)/u;
const THEMATIC_BREAK_RE =
  /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/u;
const HTML_OPEN_TAG_RE = /^\s*<([a-z][\w-]*)(?:\s[^>]*)?\s*\/?>/iu;
const HTML_VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const RUDDER_REFERENCE_SCHEME_RE =
  /^(?:agent|automation|chat|issue|library[-_](?:directory|doc|entry|file)|project):\/\//iu;

function sourceLines(source: string): SourceLine[] {
  if (!source) return [];

  const lines: SourceLine[] = [];
  let from = 0;
  let number = 1;
  while (from <= source.length) {
    const newline = source.indexOf("\n", from);
    const to = newline === -1 ? source.length : newline;
    lines.push({
      number,
      from,
      to,
      text: source.slice(from, to).replace(/\r$/u, ""),
    });
    if (newline === -1) break;
    from = newline + 1;
    number += 1;
  }
  return lines;
}

function markdownBlock(
  source: string,
  lines: SourceLine[],
  startIndex: number,
  endIndex: number,
  kind: MarkdownPreviewBlockKind,
  previewable = true,
): MarkdownPreviewBlock {
  const start = lines[startIndex]!;
  const end = lines[endIndex]!;
  return {
    id: `${start.from}:${end.to}`,
    from: start.from,
    to: end.to,
    startLine: start.number,
    endLine: end.number,
    kind,
    markdown: source.slice(start.from, end.to),
    previewable,
  };
}

function closingFenceIndex(lines: SourceLine[], startIndex: number, opener: string) {
  const marker = opener[0]!;
  const minimumLength = opener.length;
  const closingRe = new RegExp(`^ {0,3}${marker === "`" ? "`" : "~"}{${minimumLength},}\\s*$`, "u");
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (closingRe.test(lines[index]!.text)) return index;
  }
  return lines.length - 1;
}

function fenceOpener(text: string) {
  const match = text.match(FENCE_START_RE);
  if (!match) return null;
  const opener = match[1]!;
  const info = match[2] ?? "";
  if (opener.startsWith("`") && info.includes("`")) return null;
  return opener;
}

function tableEndIndex(lines: SourceLine[], headerIndex: number) {
  let index = headerIndex + 2;
  while (index < lines.length) {
    const text = lines[index]!.text;
    if (!text.trim() || !text.includes("|")) break;
    index += 1;
  }
  return index - 1;
}

function indentedCodeEndIndex(lines: SourceLine[], startIndex: number) {
  let index = startIndex + 1;
  while (index < lines.length) {
    const text = lines[index]!.text;
    if (text.trim() && !/^(?: {4}|\t)/u.test(text)) break;
    index += 1;
  }
  return index - 1;
}

function listEndIndex(lines: SourceLine[], startIndex: number) {
  const startIndent = lines[startIndex]!.text.match(/^[ \t]*/u)?.[0]
    .replace(/\t/gu, "    ").length ?? 0;
  let index = startIndex + 1;
  while (index < lines.length) {
    const text = lines[index]!.text;
    if (!text.trim()) {
      let nextIndex = index + 1;
      while (nextIndex < lines.length && !lines[nextIndex]!.text.trim()) {
        nextIndex += 1;
      }
      if (nextIndex >= lines.length) break;

      const nextText = lines[nextIndex]!.text;
      const nextIndent = nextText.match(/^[ \t]*/u)?.[0]
        .replace(/\t/gu, "    ").length ?? 0;
      if (!LIST_ITEM_RE.test(nextText) && nextIndent <= startIndent) break;
      index = nextIndex;
      continue;
    }

    const itemIndent = text.match(/^[ \t]*/u)?.[0]
      .replace(/\t/gu, "    ").length ?? 0;
    if (
      itemIndent <= startIndent
      && (
        fenceOpener(text) !== null
        || ATX_HEADING_RE.test(text)
        || BLOCKQUOTE_RE.test(text)
        || RAW_HTML_LINE_RE.test(text)
        || THEMATIC_BREAK_RE.test(text)
      )
    ) {
      break;
    }
    index += 1;
  }
  return index - 1;
}

function htmlEndIndex(lines: SourceLine[], startIndex: number) {
  const firstLine = lines[startIndex]!.text;
  if (/^\s*<!--/u.test(firstLine)) {
    if (firstLine.includes("-->")) return startIndex;
    for (let index = startIndex + 1; index < lines.length; index += 1) {
      if (lines[index]!.text.includes("-->")) return index;
      if (!lines[index]!.text.trim()) return index - 1;
    }
    return lines.length - 1;
  }

  const tag = firstLine.match(HTML_OPEN_TAG_RE)?.[1]?.toLowerCase();
  if (
    !tag
    || HTML_VOID_TAGS.has(tag)
    || /\/>\s*$/u.test(firstLine)
    || new RegExp(`</${tag}\\s*>`, "iu").test(firstLine)
  ) {
    return startIndex;
  }

  const closingTag = new RegExp(`</${tag}\\s*>`, "iu");
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (closingTag.test(lines[index]!.text)) return index;
    if (!lines[index]!.text.trim()) return index - 1;
  }
  return lines.length - 1;
}

function markdownSyntaxRanges(source: string) {
  const rawHtml: Array<{ from: number; to: number }> = [];
  const blockquotes: Array<{ from: number; to: number }> = [];
  markdownLanguage.parser.parse(source).iterate({
    enter(node) {
      if (
        node.name === "HTMLBlock"
        || node.name === "HTMLTag"
        || node.name === "Comment"
      ) {
        rawHtml.push({ from: node.from, to: node.to });
      }
      if (node.name === "Blockquote") {
        blockquotes.push({ from: node.from, to: node.to });
      }
    },
  });
  return { rawHtml, blockquotes };
}

function sourceLineEndIndex(
  lines: SourceLine[],
  startIndex: number,
  syntaxTo: number,
) {
  let endIndex = startIndex;
  while (
    endIndex + 1 < lines.length
    && lines[endIndex + 1]!.from < syntaxTo
  ) {
    endIndex += 1;
  }
  return endIndex;
}

/**
 * Splits source Markdown into the editing units used by document live preview.
 * Ordinary content remains physical-line-addressable. Structures whose syntax
 * cannot be safely previewed a line at a time stay in a single source block.
 */
export function getMarkdownPreviewBlocks(source: string): MarkdownPreviewBlock[] {
  const lines = sourceLines(source);
  const syntaxRanges = markdownSyntaxRanges(source);
  const blocks: MarkdownPreviewBlock[] = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (!line.text.trim()) {
      index += 1;
      continue;
    }

    const fence = fenceOpener(line.text);
    if (fence) {
      const endIndex = closingFenceIndex(lines, index, fence);
      blocks.push(markdownBlock(source, lines, index, endIndex, "fenced-code"));
      index = endIndex + 1;
      continue;
    }

    const nextLine = lines[index + 1];
    if (
      nextLine
      && line.text.includes("|")
      && TABLE_DELIMITER_RE.test(nextLine.text)
    ) {
      const endIndex = tableEndIndex(lines, index);
      blocks.push(markdownBlock(source, lines, index, endIndex, "table"));
      index = endIndex + 1;
      continue;
    }

    if (nextLine && SETEXT_DELIMITER_RE.test(nextLine.text) && line.text.trim()) {
      blocks.push(markdownBlock(source, lines, index, index + 1, "setext-heading"));
      index += 2;
      continue;
    }

    if (/^(?: {4}|\t)/u.test(line.text)) {
      const endIndex = indentedCodeEndIndex(lines, index);
      blocks.push(markdownBlock(source, lines, index, endIndex, "indented-code"));
      index = endIndex + 1;
      continue;
    }

    if (LIST_ITEM_RE.test(line.text)) {
      const endIndex = listEndIndex(lines, index);
      blocks.push(markdownBlock(source, lines, index, endIndex, "list"));
      index = endIndex + 1;
      continue;
    }

    if (BLOCKQUOTE_RE.test(line.text)) {
      const syntaxRange = syntaxRanges.blockquotes.find(
        (range) => range.from <= line.from && range.to >= line.to,
      );
      const endIndex = syntaxRange
        ? sourceLineEndIndex(lines, index, syntaxRange.to)
        : index;
      blocks.push(markdownBlock(source, lines, index, endIndex, "blockquote"));
      index = endIndex + 1;
      continue;
    }

    if (RAW_HTML_LINE_RE.test(line.text)) {
      const endIndex = htmlEndIndex(lines, index);
      blocks.push(markdownBlock(source, lines, index, endIndex, "html", false));
      index = endIndex + 1;
      continue;
    }

    blocks.push(markdownBlock(
      source,
      lines,
      index,
      index,
      "line",
      !syntaxRanges.rawHtml.some((range) => (
        range.from < line.to && range.to > line.from
      )),
    ));
    index += 1;
  }

  return blocks;
}

/**
 * Supplies document-level link-reference definitions to an isolated preview
 * block without changing the source range that becomes editable. CommonMark
 * reference links otherwise cannot resolve when each preview line is rendered
 * independently.
 */
export function markdownReferenceDefinitions(source: string) {
  const definitions: string[] = [];
  markdownLanguage.parser.parse(source).iterate({
    enter(node) {
      if (node.name !== "LinkReference") return;
      definitions.push(source.slice(node.from, node.to));
    },
  });
  return definitions;
}

export interface MarkdownPreviewDocument {
  source: string;
  blocks: MarkdownPreviewBlock[];
  referenceDefinitions: string[];
}

export function getMarkdownPreviewDocument(
  source: string,
  previous?: MarkdownPreviewDocument,
): MarkdownPreviewDocument {
  if (previous?.source === source) return previous;
  return {
    source,
    blocks: getMarkdownPreviewBlocks(source),
    referenceDefinitions: markdownReferenceDefinitions(source),
  };
}

export function markdownPreviewSource(
  block: MarkdownPreviewBlock,
  referenceDefinitions: readonly string[],
) {
  if (!block.previewable || referenceDefinitions.length === 0) {
    return block.markdown;
  }
  const externalDefinitions = referenceDefinitions.filter(
    (definition) => !block.markdown.includes(definition),
  );
  if (externalDefinitions.length === 0) return block.markdown;
  return `${block.markdown}\n\n${externalDefinitions.join("\n")}`;
}

export function activeMarkdownPreviewBlockIds(
  blocks: readonly MarkdownPreviewBlock[],
  selections: readonly MarkdownSelectionRange[],
) {
  const active = new Set<string>();
  for (const block of blocks) {
    if (
      selections.some((selection) => {
        const from = Math.min(selection.from, selection.to);
        const to = Math.max(selection.from, selection.to);
        return block.from <= to && block.to >= from;
      })
    ) {
      active.add(block.id);
    }
  }
  return active;
}

export function readSingleHttpUrl(clipboardText: string): string | null {
  const value = clipboardText.trim();
  if (!value || /[\r\n\s]/u.test(value)) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return value;
  } catch {
    return null;
  }
}

export function escapeMarkdownLinkLabel(value: string) {
  return value.replace(/\\/gu, "\\\\").replace(/([\[\]])/gu, "\\$1");
}

export function escapeMarkdownLinkDestination(value: string) {
  return value.replace(/\\/gu, "\\\\").replace(/([()])/gu, "\\$1");
}

export function buildMarkdownLink(label: string, url: string) {
  return `[${escapeMarkdownLinkLabel(label)}](${escapeMarkdownLinkDestination(url)})`;
}

export function provisionalWebsiteLabel(url: string) {
  const known = resolveKnownWebsiteIcon(url);
  if (known?.siteName) return known.siteName;
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function isAtomicReference(label: string, href: string) {
  const normalizedHref = href.trim();
  if (RUDDER_REFERENCE_SCHEME_RE.test(normalizedHref)) return true;
  if (/^skill:\/\//iu.test(normalizedHref)) return true;
  return label.trim().startsWith("$") && /\.md(?:[#?].*)?$/iu.test(normalizedHref);
}

function unescapeMarkdownPunctuation(value: string) {
  return value.replace(/\\([!-/:-@\[-`{-~])/gu, "$1");
}

function isEscapedCharacter(source: string, index: number) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function findInlineLinkEnd(source: string, destinationStart: number) {
  let depth = 1;
  for (let index = destinationStart; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "\n" || character === "\r") return -1;
    if (character === "\\" && index + 1 < source.length) {
      index += 1;
      continue;
    }
    if (character === "(") depth += 1;
    if (character !== ")") continue;
    depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

export function findAtomicMarkdownReferences(source: string): AtomicMarkdownReference[] {
  const references: AtomicMarkdownReference[] = [];
  const parsedLinkRanges = new Set<string>();
  markdownLanguage.parser.parse(source).iterate({
    enter(node) {
      if (node.name === "Link") {
        parsedLinkRanges.add(`${node.from}:${node.to}`);
      }
    },
  });
  for (let from = 0; from < source.length; from += 1) {
    if (source[from] !== "[" || isEscapedCharacter(source, from)) continue;
    let labelEnd = from + 1;
    for (; labelEnd < source.length; labelEnd += 1) {
      if (source[labelEnd] === "\n" || source[labelEnd] === "\r") break;
      if (source[labelEnd] === "\\" && labelEnd + 1 < source.length) {
        if (source[labelEnd + 1] === "\n" || source[labelEnd + 1] === "\r") break;
        labelEnd += 1;
        continue;
      }
      if (source[labelEnd] === "]") break;
    }
    if (source[labelEnd] !== "]" || source[labelEnd + 1] !== "(") continue;
    const destinationStart = labelEnd + 2;
    const destinationEnd = findInlineLinkEnd(source, destinationStart);
    if (destinationEnd < 0) continue;
    const to = destinationEnd + 1;
    if (!parsedLinkRanges.has(`${from}:${to}`)) continue;

    const label = unescapeMarkdownPunctuation(source.slice(from + 1, labelEnd));
    const href = unescapeMarkdownPunctuation(
      source.slice(destinationStart, destinationEnd),
    );
    if (!isAtomicReference(label, href)) continue;
    const markdown = source.slice(from, to);
    references.push({
      from,
      to,
      markdown,
      label,
      href,
    });
    from = destinationEnd;
  }
  return references;
}
