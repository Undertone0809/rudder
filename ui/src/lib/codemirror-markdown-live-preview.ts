import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, WidgetType, type EditorView } from "@codemirror/view";
import type {
  AtomicMarkdownReference,
  MarkdownPreviewBlock,
} from "./markdown-live-preview";
import { unescapeMarkdownPunctuation } from "./markdown-live-preview";

export interface MarkdownWebsiteLink {
  from: number;
  to: number;
  labelFrom: number;
  labelTo: number;
  href: string;
}

export interface SourceDrivenMarkdownPreview {
  decorations: Range<Decoration>[];
  websiteLinks: MarkdownWebsiteLink[];
}

const HTTP_URL_RE = /^https?:\/\//iu;
const EXPLICIT_SCHEME_RE = /^([a-z][a-z0-9+.-]*):/iu;

export function safeInteractiveMarkdownHref(href: string) {
  if (!href || /[\u0000-\u001f\u007f]/u.test(href)) return null;
  const scheme = href.match(EXPLICIT_SCHEME_RE)?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https" && scheme !== "mailto") {
    return null;
  }
  return href;
}

function containedByReference(
  from: number,
  to: number,
  references: readonly AtomicMarkdownReference[],
) {
  return references.some((reference) => reference.from <= from && reference.to >= to);
}

function hiddenSyntax(from: number, to: number) {
  return Decoration.replace({
    inclusive: false,
  }).range(from, to);
}

class TaskMarkerWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly checked: boolean,
  ) {
    super();
  }

  eq(other: TaskMarkerWidget) {
    return other.from === this.from
      && other.to === this.to
      && other.checked === this.checked;
  }

  toDOM(view: EditorView) {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = this.checked;
    checkbox.className = "rudder-cm-markdown-task-checkbox";
    checkbox.setAttribute("aria-label", this.checked ? "Mark task incomplete" : "Mark task complete");
    checkbox.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    checkbox.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({
        changes: {
          from: this.from,
          to: this.to,
          insert: this.checked ? "[ ]" : "[x]",
        },
        selection: { anchor: this.to },
        userEvent: "input",
      });
    });
    return checkbox;
  }

  ignoreEvent() {
    return false;
  }
}

function containingPreviewBlock(
  blocks: readonly MarkdownPreviewBlock[],
  from: number,
  to: number,
) {
  let low = 0;
  let high = blocks.length - 1;
  let candidate: MarkdownPreviewBlock | undefined;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const block = blocks[middle]!;
    if (block.from <= from) {
      candidate = block;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return candidate && candidate.to >= to ? candidate : null;
}

function syntaxDecorationsForBlocks(
  state: EditorState,
  blocks: readonly MarkdownPreviewBlock[],
  references: readonly AtomicMarkdownReference[],
) {
  const decorations: Range<Decoration>[] = [];
  const websiteLinks: MarkdownWebsiteLink[] = [];
  const recordedLinks = new Set<string>();
  if (blocks.length === 0) return { decorations, websiteLinks };

  syntaxTree(state).iterate({
    from: blocks[0]!.from,
    to: blocks.at(-1)!.to,
    enter(node) {
      if (!containingPreviewBlock(blocks, node.from, node.to)) return;
      if (containedByReference(node.from, node.to, references)) return false;

      if (
        node.name === "HeaderMark"
        || node.name === "EmphasisMark"
        || node.name === "StrikethroughMark"
        || node.name === "CodeMark"
        || node.name === "QuoteMark"
      ) {
        let to = node.to;
        if (
          (node.name === "HeaderMark" || node.name === "QuoteMark")
          && /[ \t]/u.test(state.sliceDoc(to, to + 1))
        ) {
          to += 1;
        }
        decorations.push(hiddenSyntax(node.from, to));
        return;
      }

      if (node.name === "TaskMarker") {
        const marker = state.sliceDoc(node.from, node.to);
        decorations.push(Decoration.replace({
          widget: new TaskMarkerWidget(
            node.from,
            node.to,
            /^\[[xX]\]$/u.test(marker),
          ),
          inclusive: false,
        }).range(node.from, node.to));
        return;
      }

      if (node.name === "CodeInfo") {
        decorations.push(hiddenSyntax(node.from, node.to));
        return;
      }

      if (node.name === "HorizontalRule") {
        decorations.push(hiddenSyntax(node.from, node.to));
        return;
      }

      if (node.name === "StrongEmphasis") {
        decorations.push(Decoration.mark({
          class: "rudder-cm-markdown-strong",
        }).range(node.from, node.to));
        return;
      }
      if (node.name === "Emphasis") {
        decorations.push(Decoration.mark({
          class: "rudder-cm-markdown-emphasis",
        }).range(node.from, node.to));
        return;
      }
      if (node.name === "Strikethrough") {
        decorations.push(Decoration.mark({
          class: "rudder-cm-markdown-strikethrough",
        }).range(node.from, node.to));
        return;
      }
      if (node.name === "InlineCode") {
        decorations.push(Decoration.mark({
          class: "rudder-cm-markdown-inline-code",
        }).range(node.from, node.to));
        return;
      }

      if (node.name === "Link") {
        const marks: Array<{ from: number; to: number }> = [];
        let urlRange: { from: number; to: number } | null = null;
        for (let child = node.node.firstChild; child; child = child.nextSibling) {
          if (child.name === "LinkMark") marks.push({ from: child.from, to: child.to });
          if (child.name === "URL") urlRange = { from: child.from, to: child.to };
        }
        for (const mark of marks) decorations.push(hiddenSyntax(mark.from, mark.to));
        if (urlRange) decorations.push(hiddenSyntax(urlRange.from, urlRange.to));
        if (marks.length >= 2) {
          const href = urlRange
            ? unescapeMarkdownPunctuation(state.sliceDoc(urlRange.from, urlRange.to))
            : "";
          decorations.push(Decoration.mark({
            class: "rudder-cm-markdown-link",
            attributes: safeInteractiveMarkdownHref(href)
              ? {
                "aria-label": `Open ${href}`,
                "data-markdown-link-href": href,
                role: "link",
                tabindex: "0",
              }
              : undefined,
          }).range(marks[0]!.to, marks[1]!.from));
        }
        const href = urlRange
          ? unescapeMarkdownPunctuation(state.sliceDoc(urlRange.from, urlRange.to))
          : "";
        if (marks.length >= 4 && HTTP_URL_RE.test(href)) {
          const details: MarkdownWebsiteLink = {
            from: node.from,
            to: node.to,
            labelFrom: marks[0]!.to,
            labelTo: marks[1]!.from,
            href,
          };
          const key = `${details.from}:${details.to}`;
          if (!recordedLinks.has(key)) {
            recordedLinks.add(key);
            websiteLinks.push(details);
          }
        }
        return;
      }

      if (node.name === "Autolink") {
        const marks: Array<{ from: number; to: number }> = [];
        let urlRange: { from: number; to: number } | null = null;
        let emailRange: { from: number; to: number } | null = null;
        for (let child = node.node.firstChild; child; child = child.nextSibling) {
          if (child.name === "LinkMark") marks.push({ from: child.from, to: child.to });
          if (child.name === "URL") urlRange = { from: child.from, to: child.to };
          if (child.name === "Email") emailRange = { from: child.from, to: child.to };
        }
        for (const mark of marks) decorations.push(hiddenSyntax(mark.from, mark.to));
        const labelRange = urlRange ?? emailRange;
        if (!labelRange) return;
        const label = unescapeMarkdownPunctuation(
          state.sliceDoc(labelRange.from, labelRange.to),
        );
        const emailAutolink = Boolean(emailRange)
          || (!EXPLICIT_SCHEME_RE.test(label) && label.includes("@"));
        const href = emailAutolink ? `mailto:${label}` : label;
        decorations.push(Decoration.mark({
          class: "rudder-cm-markdown-link",
          attributes: safeInteractiveMarkdownHref(href)
            ? {
              "aria-label": `Open ${href}`,
              "data-markdown-link-href": href,
              role: "link",
              tabindex: "0",
            }
            : undefined,
        }).range(labelRange.from, labelRange.to));
        if (HTTP_URL_RE.test(href)) {
          websiteLinks.push({
            from: node.from,
            to: node.to,
            labelFrom: labelRange.from,
            labelTo: labelRange.to,
            href,
          });
        }
      }
    },
  });

  return { decorations, websiteLinks };
}

export function sourceDrivenMarkdownPreview(
  state: EditorState,
  blocks: readonly MarkdownPreviewBlock[],
  activeIds: ReadonlySet<string>,
  references: readonly AtomicMarkdownReference[],
): SourceDrivenMarkdownPreview {
  const decorations: Range<Decoration>[] = [];
  const websiteLinks: MarkdownWebsiteLink[] = [];

  for (const block of blocks) {
    const active = activeIds.has(block.id) || !block.previewable;
    const headingMatch = block.kind === "line"
      ? block.markdown.match(/^ {0,3}(#{1,6})(?:[ \t]+|$)/u)
      : null;
    const setextMatch = block.kind === "setext-heading"
      ? block.markdown.match(/\r?\n {0,3}(=+|-+)[ \t]*$/u)
      : null;
    const headingLevel = headingMatch?.[1]?.length
      ?? (setextMatch?.[1]?.startsWith("=") ? 1 : setextMatch ? 2 : undefined);
    const thematicBreak = block.kind === "line"
      && /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/u.test(block.markdown);

    for (let lineNumber = block.startLine; lineNumber <= block.endLine; lineNumber += 1) {
      const line = state.doc.line(Math.min(lineNumber, state.doc.lines));
      const blockEdge = block.startLine === block.endLine
        ? "single"
        : lineNumber === block.startLine
          ? "first"
          : lineNumber === block.endLine
            ? "last"
            : "middle";
      decorations.push(
        Decoration.line({
          attributes: {
            "data-markdown-preview-state": active ? "source" : "preview",
            "data-markdown-source-kind": block.kind,
            ...(headingLevel && lineNumber === block.startLine
              ? { "data-markdown-source-heading-level": String(headingLevel) }
              : {}),
            ...(thematicBreak ? { "data-markdown-thematic-break": "true" } : {}),
            ...(block.kind === "fenced-code"
              ? { "data-markdown-source-block-edge": blockEdge }
              : {}),
            "data-source-line-start": String(lineNumber),
            "data-source-line-end": String(block.endLine),
          },
        }).range(line.from),
      );
    }

    if (active) continue;
  }

  const inactiveBlocks = blocks.filter((block) => (
    !activeIds.has(block.id) && block.previewable
  ));
  const result = syntaxDecorationsForBlocks(state, inactiveBlocks, references);
  decorations.push(...result.decorations);
  websiteLinks.push(...result.websiteLinks);

  return { decorations, websiteLinks };
}
