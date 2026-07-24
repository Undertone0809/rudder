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
  },
  '.cm-line[data-markdown-preview-state="source"][data-markdown-source-kind="list"]': {
    paddingLeft: "1.35em",
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
    backgroundColor: "var(--code-selection)",
    color: "inherit",
  },
  "& > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "var(--code-selection)",
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "color-mix(in oklab, var(--accent-base) 32%, transparent)",
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
