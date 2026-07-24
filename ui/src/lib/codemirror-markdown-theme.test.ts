import { tags } from "@lezer/highlight";
import { describe, expect, it } from "vitest";
import { codeMirrorMarkdownHighlightStyle } from "./codemirror-markdown-theme";

describe("codeMirrorMarkdownHighlightStyle", () => {
  it("uses the document link token for Markdown URLs instead of the light-only CodeMirror default", () => {
    expect(codeMirrorMarkdownHighlightStyle.specs).toContainEqual({
      tag: tags.url,
      color: "var(--rudder-doc-link)",
    });
  });
});
