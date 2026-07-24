import { describe, expect, it } from "vitest";
import {
  markdownDocumentOrNull,
  markdownDocumentOrUndefined,
  normalizeMarkdownDocumentValue,
} from "./markdown-document-value";

describe("Markdown document persistence values", () => {
  it("preserves every byte of non-empty Markdown", () => {
    const markdown = "\n  \\*escaped\\* and **bold**  \n";

    expect(normalizeMarkdownDocumentValue(markdown)).toBe(markdown);
    expect(markdownDocumentOrNull(markdown)).toBe(markdown);
    expect(markdownDocumentOrUndefined(markdown)).toBe(markdown);
  });

  it("normalizes whitespace-only documents to each surface's empty sentinel", () => {
    expect(normalizeMarkdownDocumentValue(" \n\t ")).toBe("");
    expect(markdownDocumentOrNull(" \n\t ")).toBeNull();
    expect(markdownDocumentOrUndefined(" \n\t ")).toBeUndefined();
  });
});
