import { describe, expect, it } from "vitest";
import { resolveMarkdownEditorEngine } from "./markdown-editor-engine";

describe("resolveMarkdownEditorEngine", () => {
  it("keeps plain-text composers on the legacy path even when an engine leaks through", () => {
    expect(resolveMarkdownEditorEngine({ plainText: true, engine: "codemirror" })).toBe("legacy");
    expect(resolveMarkdownEditorEngine({ plainText: true, engine: "milkdown" })).toBe("legacy");
  });

  it("uses explicit document engines and defaults to legacy", () => {
    expect(resolveMarkdownEditorEngine({ engine: "codemirror" })).toBe("codemirror");
    expect(resolveMarkdownEditorEngine({ engine: "milkdown" })).toBe("milkdown");
    expect(resolveMarkdownEditorEngine({ engine: "legacy" })).toBe("legacy");
    expect(resolveMarkdownEditorEngine({})).toBe("legacy");
  });
});
