import { describe, expect, it } from "vitest";
import { normalizeRelaxedMarkdownSyntax } from "./markdown-normalize";

describe("normalizeRelaxedMarkdownSyntax", () => {
  it("repairs hard-wrapped URL link destinations", () => {
    expect(normalizeRelaxedMarkdownSyntax([
      "[https://github.com/Undertone0809/rudder/releases?page=5](https://github.com/Undertone0809/rudder/releases?",
      "page=5)",
    ].join("\n"))).toBe(
      "[https://github.com/Undertone0809/rudder/releases?page=5](https://github.com/Undertone0809/rudder/releases?page=5)",
    );
  });

  it("normalizes compact task-list and escaped-bracket list markers", () => {
    expect(normalizeRelaxedMarkdownSyntax("-[]1\n-[x]done\n-\\[]1")).toBe("- [ ] 1\n- [x] done\n- \\[]1");
  });

  it("does not normalize examples inside fenced code blocks", () => {
    const source = [
      "```md",
      "-[]1",
      "[https://example.com](https://example.com?",
      "a=1)",
      "```",
    ].join("\n");

    expect(normalizeRelaxedMarkdownSyntax(source)).toBe(source);
  });
});
