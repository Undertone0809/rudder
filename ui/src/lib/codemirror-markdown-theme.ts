import { HighlightStyle } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

export const codeMirrorMarkdownHighlightStyle = HighlightStyle.define([
  { tag: tags.url, color: "var(--rudder-doc-link)" },
]);

export function codeMirrorMarkdownEditorTheme() {
  return EditorView.theme({
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
    ".cm-gutters": {
      display: "none",
    },
    ".cm-activeLine": {
      backgroundColor: "transparent",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--foreground)",
    },
    ".cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "color-mix(in oklab, var(--accent-base) 24%, transparent)",
    },
    "&.cm-focused .cm-selectionBackground": {
      backgroundColor: "color-mix(in oklab, var(--accent-base) 32%, transparent)",
    },
  });
}
