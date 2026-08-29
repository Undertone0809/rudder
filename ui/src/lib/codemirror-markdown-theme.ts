import { HighlightStyle } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

export const codeMirrorMarkdownHighlightStyle = HighlightStyle.define([
  { tag: tags.url, color: "var(--rudder-doc-link)" },
]);

export const codeMirrorMarkdownThemeSpec: Parameters<typeof EditorView.theme>[0] = {
  "&": {
    backgroundColor: "transparent",
    color: "var(--foreground)",
    height: "100%",
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "inherit",
    lineHeight: "1.55",
  },
  ".cm-content": {
    minHeight: "7rem",
    padding: "0.5rem 0.75rem",
    caretColor: "var(--foreground)",
  },
  ".cm-line": {
    padding: "0",
    minHeight: "1.55em",
  },
  '.cm-line[data-markdown-source-kind="list"]': {
    paddingLeft: "1.35em",
  },
  '.cm-line[data-markdown-source-heading-level="1"]': {
    fontSize: "1.75em",
    fontWeight: "700",
    lineHeight: "1.25",
    marginTop: "0.55em",
    marginBottom: "0.3em",
  },
  '.cm-line[data-markdown-source-heading-level="2"]': {
    fontSize: "1.45em",
    fontWeight: "700",
    lineHeight: "1.3",
    marginTop: "0.5em",
    marginBottom: "0.25em",
  },
  '.cm-line[data-markdown-source-heading-level="3"]': {
    fontSize: "1.2em",
    fontWeight: "650",
    lineHeight: "1.35",
    marginTop: "0.4em",
    marginBottom: "0.2em",
  },
  '.cm-line[data-markdown-source-heading-level="4"], .cm-line[data-markdown-source-heading-level="5"], .cm-line[data-markdown-source-heading-level="6"]': {
    fontWeight: "650",
    marginTop: "0.3em",
  },
  '.cm-line[data-markdown-source-kind="blockquote"]': {
    borderLeft: "2px solid color-mix(in oklab, var(--foreground) 20%, transparent)",
    color: "var(--muted-foreground)",
    paddingLeft: "0.75em",
  },
  '.cm-line[data-markdown-source-kind="indented-code"]': {
    backgroundColor: "var(--code-surface)",
    color: "var(--code-foreground)",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    padding: "0.35em 0.75em",
  },
  '.cm-line[data-markdown-preview-state="preview"][data-markdown-thematic-break="true"]': {
    borderBottom: "1px solid color-mix(in oklab, var(--foreground) 16%, transparent)",
  },
  '.cm-line[data-markdown-source-kind="fenced-code"]': {
    backgroundColor: "var(--code-surface)",
    color: "var(--code-foreground)",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    paddingLeft: "0.75em",
    paddingRight: "0.75em",
  },
  '.cm-line[data-markdown-source-kind="fenced-code"][data-markdown-source-block-edge="first"]': {
    borderTopLeftRadius: "calc(var(--radius) - 3px)",
    borderTopRightRadius: "calc(var(--radius) - 3px)",
    paddingTop: "0.45em",
  },
  '.cm-line[data-markdown-source-kind="fenced-code"][data-markdown-source-block-edge="last"]': {
    borderBottomLeftRadius: "calc(var(--radius) - 3px)",
    borderBottomRightRadius: "calc(var(--radius) - 3px)",
    paddingBottom: "0.45em",
  },
  ".cm-gutters": {
    display: "none",
  },
  ".cm-activeLine": {
    backgroundColor: "transparent",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--foreground)",
  },
  ".cm-content ::selection": {
    backgroundColor: "color-mix(in oklab, var(--rudder-doc-link) 28%, transparent)",
    color: "var(--foreground)",
  },
  "& > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "color-mix(in oklab, var(--rudder-doc-link) 18%, transparent)",
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "color-mix(in oklab, var(--rudder-doc-link) 26%, transparent)",
  },
  ".rudder-cm-markdown-strong": {
    fontWeight: "700",
  },
  ".rudder-cm-markdown-emphasis": {
    fontStyle: "italic",
  },
  ".rudder-cm-markdown-strikethrough": {
    textDecoration: "line-through",
  },
  ".rudder-cm-markdown-inline-code": {
    backgroundColor: "color-mix(in oklab, var(--foreground) 8%, transparent)",
    borderRadius: "0.28em",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: "0.92em",
    padding: "0.08em 0.28em",
  },
  ".rudder-cm-markdown-link": {
    color: "var(--rudder-doc-link)",
    textDecoration: "underline",
    textDecorationColor: "color-mix(in oklab, var(--rudder-doc-link) 48%, transparent)",
    textUnderlineOffset: "0.14em",
  },
  ".rudder-codemirror-markdown-website": {
    display: "inline-flex",
    marginRight: "0.28em",
    verticalAlign: "-0.12em",
  },
  ".rudder-codemirror-markdown-website .rudder-website-link-icon": {
    display: "inline-flex",
  },
  ".rudder-cm-markdown-task-checkbox": {
    accentColor: "var(--accent-base)",
    cursor: "pointer",
    height: "0.95em",
    margin: "0 0.38em 0 0.12em",
    verticalAlign: "-0.08em",
    width: "0.95em",
  },
  ".rudder-cm-markdown-unordered-list-marker": {
    color: "var(--muted-foreground)",
    display: "inline-block",
    fontWeight: "700",
    marginLeft: "-0.08em",
    textAlign: "center",
    width: "0.9em",
  },
  ".rudder-codemirror-markdown-preview": {
    display: "inline-block",
    verticalAlign: "top",
  },
  ".rudder-markdown.rudder-codemirror-markdown-rendered": {
    color: "inherit",
    fontSize: "inherit",
    lineHeight: "inherit",
  },
  ".rudder-codemirror-markdown-rendered :where(p, ul, ol, blockquote)": {
    marginBottom: "0",
    marginTop: "0",
  },
  ".rudder-codemirror-markdown-rendered :where(ul, ol)": {
    paddingLeft: "1.35em",
  },
  ".rudder-codemirror-markdown-rendered li": {
    marginBottom: "0",
    marginTop: "0",
    paddingLeft: "0",
  },
};

export function codeMirrorMarkdownEditorTheme() {
  return EditorView.theme(codeMirrorMarkdownThemeSpec);
}
