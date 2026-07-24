import { tags } from "@lezer/highlight";
import { describe, expect, it } from "vitest";
import {
  codeMirrorMarkdownHighlightStyle,
  codeMirrorMarkdownThemeSpec,
} from "./codemirror-markdown-theme";

describe("codeMirrorMarkdownHighlightStyle", () => {
  it("uses the document link token for Markdown URLs instead of the light-only CodeMirror default", () => {
    expect(codeMirrorMarkdownHighlightStyle.specs).toContainEqual({
      tag: tags.url,
      color: "var(--rudder-doc-link)",
    });
  });
});

describe("codeMirrorMarkdownThemeSpec", () => {
  it("overrides CodeMirror's focused light-theme selection at equal or greater specificity", () => {
    expect(
      codeMirrorMarkdownThemeSpec[
        "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground"
      ],
    ).toEqual({
      backgroundColor: "color-mix(in oklab, var(--accent-base) 32%, transparent)",
    });
  });

  it("keeps source list indentation and rendered typography aligned", () => {
    expect(
      codeMirrorMarkdownThemeSpec[
        '.cm-line[data-markdown-preview-state="source"][data-markdown-source-kind="list"]'
      ],
    ).toEqual({
      paddingLeft: "1.35em",
    });
    expect(
      codeMirrorMarkdownThemeSpec[
        ".rudder-markdown.rudder-codemirror-markdown-rendered"
      ],
    ).toMatchObject({
      fontSize: "inherit",
      lineHeight: "inherit",
    });
    expect(
      codeMirrorMarkdownThemeSpec[".rudder-codemirror-markdown-preview"],
    ).toEqual({
      display: "inline-block",
      verticalAlign: "top",
    });
  });
});
