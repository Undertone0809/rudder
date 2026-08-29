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
      backgroundColor: "color-mix(in oklab, var(--rudder-doc-link) 26%, transparent)",
    });
  });

  it("keeps list indentation and source-driven preview typography aligned", () => {
    expect(
      codeMirrorMarkdownThemeSpec[
        '.cm-line[data-markdown-source-kind="list"]'
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
      codeMirrorMarkdownThemeSpec['.cm-line[data-markdown-source-heading-level="1"]'],
    ).toMatchObject({
      fontSize: "1.75em",
      fontWeight: "700",
    });
    expect(
      codeMirrorMarkdownThemeSpec[".rudder-cm-markdown-unordered-list-marker"],
    ).toMatchObject({
      display: "inline-block",
      width: "0.9em",
    });
  });
});
