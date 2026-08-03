import { describe, expect, it } from "vitest";
import {
  applyMarkdownBlockAction,
  markdownBlockActionDisabled,
} from "./markdown-block-actions";

describe("markdown block actions", () => {
  it("converts paragraphs and removes existing heading syntax", () => {
    expect(applyMarkdownBlockAction("Paragraph", "headline", "line")).toBe("## Paragraph");
    expect(applyMarkdownBlockAction("### Existing", "body", "line")).toBe("Existing");
    expect(applyMarkdownBlockAction("Setext title\n---", "display", "setext-heading")).toBe(
      "# Setext title",
    );
  });

  it("converts every item in a list block", () => {
    expect(applyMarkdownBlockAction("- first\n1. second", "number-list", "list")).toBe(
      "1. first\n1. second",
    );
    expect(applyMarkdownBlockAction("1. first\n2. second", "list", "list")).toBe(
      "- first\n- second",
    );
  });

  it("adds and removes task syntax", () => {
    expect(applyMarkdownBlockAction("Review this", "task", "line")).toBe("- [ ] Review this");
    expect(applyMarkdownBlockAction("- [x] Done", "body", "list")).toBe("Done");
  });

  it("wraps fenced code without nesting fences", () => {
    expect(applyMarkdownBlockAction("const value = 1;", "code-block", "line")).toBe(
      "```\nconst value = 1;\n```",
    );
    expect(applyMarkdownBlockAction("```ts\nconst value = 1;\n```", "body", "fenced-code")).toBe(
      "const value = 1;",
    );
  });

  it("marks actions that already match the block type as disabled", () => {
    expect(markdownBlockActionDisabled("# Heading", "display", "line")).toBe(true);
    expect(markdownBlockActionDisabled("- first\n- second", "list", "list")).toBe(true);
    expect(markdownBlockActionDisabled("```\ncode\n```", "code-block", "fenced-code")).toBe(true);
    expect(markdownBlockActionDisabled("Paragraph", "headline", "line")).toBe(false);
  });
});
