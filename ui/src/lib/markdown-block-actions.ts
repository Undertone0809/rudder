import type { MarkdownPreviewBlockKind } from "./markdown-live-preview";

export type MarkdownBlockAction =
  | "display"
  | "headline"
  | "subheader"
  | "body"
  | "task"
  | "list"
  | "number-list"
  | "code-block";

const LIST_MARKER_RE = /^(\s*)([-+*]|\d+[.)])[ \t]+/u;
const TASK_MARKER_RE = /^(\s*)([-+*]|\d+[.)])[ \t]+\[[ xX]\][ \t]+/u;
const HEADING_RE = /^\s{0,3}(#{1,6})[ \t]+/u;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})[^\r\n]*$/u;

function lineSeparator(source: string) {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

function removeFence(source: string) {
  const separator = lineSeparator(source);
  const lines = source.split(separator);
  if (lines.length < 2 || !FENCE_RE.test(lines[0]!) || !FENCE_RE.test(lines.at(-1)!)) {
    return source;
  }
  return lines.slice(1, -1).join(separator);
}

function stripSetext(source: string) {
  const separator = lineSeparator(source);
  const lines = source.split(separator);
  if (lines.length === 2 && /^\s*(?:=+|-+)\s*$/u.test(lines[1]!)) {
    return lines[0]!;
  }
  return source;
}

function stripBlockSyntax(source: string) {
  let value = removeFence(stripSetext(source));
  value = value.replace(/^\s{0,3}#{1,6}[ \t]+/u, "");
  value = value.replace(TASK_MARKER_RE, "$1");
  value = value.replace(LIST_MARKER_RE, "$1");
  value = value.replace(/^\s{0,3}>[ \t]?/u, "");
  return value;
}

function formatList(source: string, ordered: boolean) {
  const separator = lineSeparator(source);
  const lines = removeFence(stripSetext(source)).split(separator);
  return lines.map((line) => {
    const content = stripBlockSyntax(line).trim();
    if (!content) return line;
    const marker = ordered ? "1. " : "- ";
    return `${marker}${content}`;
  }).join(separator);
}

function headingLevel(source: string) {
  return source.match(HEADING_RE)?.[1].length ?? null;
}

function isTask(source: string) {
  return source.split(/\r?\n/u).filter((line) => line.trim()).every((line) => TASK_MARKER_RE.test(line));
}

function isUnorderedList(source: string) {
  const lines = source.split(/\r?\n/u).filter((line) => line.trim());
  return lines.length > 0 && lines.every((line) => /^\s*[-+*][ \t]+/u.test(line));
}

function isOrderedList(source: string) {
  const lines = source.split(/\r?\n/u).filter((line) => line.trim());
  return lines.length > 0 && lines.every((line) => /^\s*\d+[.)][ \t]+/u.test(line));
}

export function markdownBlockActionDisabled(
  source: string,
  action: MarkdownBlockAction,
  kind?: MarkdownPreviewBlockKind,
) {
  switch (action) {
    case "display":
      return headingLevel(source) === 1;
    case "headline":
      return headingLevel(source) === 2;
    case "subheader":
      return headingLevel(source) === 3;
    case "body":
      return kind === "line"
        && headingLevel(source) === null
        && !LIST_MARKER_RE.test(source)
        && !FENCE_RE.test(source);
    case "task":
      return isTask(source);
    case "list":
      return isUnorderedList(source);
    case "number-list":
      return isOrderedList(source);
    case "code-block":
      return kind === "fenced-code" || kind === "indented-code";
  }
}

export function applyMarkdownBlockAction(
  source: string,
  action: MarkdownBlockAction,
  kind?: MarkdownPreviewBlockKind,
) {
  if (markdownBlockActionDisabled(source, action, kind)) return source;
  const separator = lineSeparator(source);
  const content = stripBlockSyntax(source).trim();

  switch (action) {
    case "display":
      return `# ${content}`;
    case "headline":
      return `## ${content}`;
    case "subheader":
      return `### ${content}`;
    case "body":
      return content;
    case "task":
      return `- [ ] ${content}`;
    case "list":
      return formatList(source, false);
    case "number-list":
      return formatList(source, true);
    case "code-block":
      return "```" + separator + removeFence(source) + separator + "```";
  }
}
