import { describe, expect, it } from "vitest";
import {
  createMarkdownSourceBoundaryMap,
  normalizeEscapedMarkdownNewlines,
  normalizeMarkdownHtmlBreaks,
  normalizeRelaxedMarkdownSyntax,
  normalizeRenderedMarkdownSource,
} from "./markdown-normalize";

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

describe("normalizeEscapedMarkdownNewlines", () => {
  it("turns escaped newline blocks into real markdown newlines", () => {
    expect(normalizeEscapedMarkdownNewlines("Plan complete.\\n\\n1. Confirm\\n2. Ship")).toBe(
      "Plan complete.\n\n1. Confirm\n2. Ship",
    );
  });

  it("leaves isolated escaped newline examples alone", () => {
    expect(normalizeEscapedMarkdownNewlines("Use `\\n` for newline examples.")).toBe("Use `\\n` for newline examples.");
  });
});

describe("normalizeMarkdownHtmlBreaks", () => {
  it("removes standalone html break tags from prose while preserving the surrounding text", () => {
    expect(normalizeMarkdownHtmlBreaks("First line\n<br />\nSecond line\nDone<br />again")).toBe(
      "First line\n\nSecond line\nDone\nagain",
    );
  });

  it("preserves html break examples inside code and markdown link labels", () => {
    const source = "Use `<br />` in docs.\n\n```html\n<br />\n```\n\nSee [literal <br />](https://example.com).";
    expect(normalizeMarkdownHtmlBreaks(source)).toBe(source);
  });
});

describe("normalizeRenderedMarkdownSource", () => {
  it("applies escaped newline, html break, and relaxed markdown normalization together", () => {
    expect(normalizeRenderedMarkdownSource("Plan\\n\\n-[]todo\\n<br />\\nDone")).toBe("Plan\n\n- [ ] todo\n\nDone");
  });
});

describe("createMarkdownSourceBoundaryMap", () => {
  it("maps normalized escaped newlines, html breaks, and compact tasks back to raw boundaries", () => {
    const raw = "Plan\\n\\n-[]任务\\n<br />\\nDone";
    const rendered = normalizeRenderedMarkdownSource(raw);
    const mapping = createMarkdownSourceBoundaryMap(raw, rendered);

    expect(rendered).toBe("Plan\n\n- [ ] 任务\n\nDone");
    expect(mapping.renderedBoundaryToRaw[rendered.indexOf("任务")]).toBe(raw.indexOf("任务"));
    expect(mapping.renderedBoundaryToRaw[rendered.indexOf("任务") + "任务".length])
      .toBe(raw.indexOf("任务") + "任务".length);
    expect(mapping.renderedBoundaryToRaw[rendered.indexOf("Done")]).toBe(raw.indexOf("Done"));
    expect(mapping.renderedBoundaryToRaw.at(-1)).toBe(raw.length);
  });

  it("keeps exact raw boundaries around a hard-wrapped markdown link", () => {
    const raw = [
      "See [Rudder 文档](https://rudder.dev/docs?",
      "lang=zh) now",
    ].join("\n");
    const rendered = normalizeRenderedMarkdownSource(raw);
    const mapping = createMarkdownSourceBoundaryMap(raw, rendered);
    const labelStart = rendered.indexOf("Rudder 文档");
    const labelEnd = labelStart + "Rudder 文档".length;

    expect(rendered).toContain("(https://rudder.dev/docs?lang=zh)");
    expect(mapping.renderedBoundaryToRaw[labelStart]).toBe(raw.indexOf("Rudder 文档"));
    expect(mapping.renderedBoundaryToRaw[labelEnd]).toBe(raw.indexOf("Rudder 文档") + "Rudder 文档".length);
    expect(mapping.renderedBoundaryToRaw[rendered.indexOf(" now")]).toBe(raw.indexOf(" now"));
  });

  it("maps inserted bare-mention link syntax while preserving CJK, entities, and Unicode boundaries", () => {
    const raw = "你好 @Ålice 👩🏽‍💻 &amp; 完成";
    const rendered = "你好 [@Ålice](agent://agent-1) 👩🏽‍💻 &amp; 完成";
    const mapping = createMarkdownSourceBoundaryMap(raw, rendered);

    const mentionStart = rendered.indexOf("@Ålice");
    const mentionEnd = mentionStart + "@Ålice".length;
    const emojiStart = rendered.indexOf("👩🏽‍💻");
    const entityStart = rendered.indexOf("&amp;");
    expect(mapping.renderedBoundaryToRaw[mentionStart]).toBe(raw.indexOf("@Ålice"));
    expect(mapping.renderedBoundaryToRaw[mentionEnd]).toBe(raw.indexOf("@Ålice") + "@Ålice".length);
    expect(mapping.renderedBoundaryToRaw[emojiStart]).toBe(raw.indexOf("👩🏽‍💻"));
    expect(mapping.renderedBoundaryToRaw[entityStart]).toBe(raw.indexOf("&amp;"));
    expect(mapping.renderedBoundaryToRaw.at(-1)).toBe(raw.length);
  });

  it("keeps repeated labels and punctuation anchored to their matching raw occurrence", () => {
    const raw = "aaaa [same](https://one.test) .... same .... [same](https://two.test) zzzz";
    const rendered = "aaaa [same](https://one.test) .... [same](mention://inserted) same .... [same](https://two.test) zzzz";
    const mapping = createMarkdownSourceBoundaryMap(raw, rendered);
    const secondRawLinkLabel = raw.lastIndexOf("same");
    const secondRenderedLinkLabel = rendered.lastIndexOf("same");

    expect(mapping.renderedBoundaryToRaw[secondRenderedLinkLabel]).toBe(secondRawLinkLabel);
    expect(mapping.renderedBoundaryToRaw[secondRenderedLinkLabel + "same".length])
      .toBe(secondRawLinkLabel + "same".length);
    expect(mapping.renderedBoundaryToRaw.every((value, index, values) => (
      index === 0 || value >= values[index - 1]!
    ))).toBe(true);
  });

  it("preserves exact unchanged-tail boundaries beyond the old bounded-lookahead distance", () => {
    const longInsertedSyntax = `[annotation](${`mention://${"x".repeat(2_500)}`})`;
    const tail = `尾部 ${"unchanged ".repeat(320)}🏁`;
    const raw = `Prefix @agent ${tail}`;
    const rendered = `Prefix [@agent](${longInsertedSyntax}) ${tail}`;
    const mapping = createMarkdownSourceBoundaryMap(raw, rendered);
    const renderedTailStart = rendered.indexOf(tail);
    const rawTailStart = raw.indexOf(tail);

    expect(renderedTailStart).toBeGreaterThan(2_048);
    expect(mapping.renderedBoundaryToRaw[renderedTailStart]).toBe(rawTailStart);
    expect(mapping.renderedBoundaryToRaw.at(-1)).toBe(raw.length);
  });
});
