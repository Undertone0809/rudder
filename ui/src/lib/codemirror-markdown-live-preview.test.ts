import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { GFM } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import {
  safeInteractiveMarkdownHref,
  sourceDrivenMarkdownPreview,
} from "./codemirror-markdown-live-preview";
import {
  findAtomicMarkdownReferences,
  getMarkdownPreviewBlocks,
} from "./markdown-live-preview";

function preview(source: string, activeIds = new Set<string>()) {
  const state = EditorState.create({
    doc: source,
    extensions: [markdown({ extensions: GFM })],
  });
  return sourceDrivenMarkdownPreview(
    state,
    getMarkdownPreviewBlocks(source),
    activeIds,
    [],
  );
}

function decoratedRanges(source: string, activeIds = new Set<string>()) {
  return preview(source, activeIds).decorations.map((range) => ({
    from: range.from,
    to: range.to,
    source: source.slice(range.from, range.to),
    class: range.value.spec.class as string | undefined,
    attributes: range.value.spec.attributes as Record<string, string> | undefined,
  }));
}

describe("sourceDrivenMarkdownPreview", () => {
  it("hides delimiters while keeping semantic text in the original source line", () => {
    const source = "# Heading\nText **bold** and [OpenAI](https://openai.com).";
    const ranges = decoratedRanges(source);

    expect(ranges.some((range) => range.source === "# ")).toBe(true);
    expect(ranges.some((range) => range.class === "rudder-cm-markdown-strong")).toBe(true);
    expect(ranges.some((range) => range.source === "https://openai.com")).toBe(true);
    expect(preview(source).websiteLinks).toEqual([
      expect.objectContaining({
        href: "https://openai.com",
      }),
    ]);
  });

  it("reveals every delimiter in the active logical block without dropping line styling", () => {
    const source = "# Heading\nText **bold**.";
    const blocks = getMarkdownPreviewBlocks(source);
    const ranges = decoratedRanges(source, new Set([blocks[0]!.id]));

    expect(ranges.some((range) => range.source === "# ")).toBe(false);
    expect(ranges).toContainEqual(expect.objectContaining({
      attributes: expect.objectContaining({
        "data-markdown-preview-state": "source",
        "data-markdown-source-heading-level": "1",
      }),
    }));
  });

  it("keeps fenced code as original CodeMirror lines in preview and source states", () => {
    const source = "```ts\nconst answer = 42;\n```";
    const blocks = getMarkdownPreviewBlocks(source);
    const previewRanges = decoratedRanges(source);
    const sourceRanges = decoratedRanges(source, new Set([blocks[0]!.id]));

    expect(previewRanges.filter((range) => (
      range.attributes?.["data-markdown-source-kind"] === "fenced-code"
    ))).toHaveLength(3);
    expect(previewRanges.some((range) => range.source === "```")).toBe(true);
    expect(sourceRanges.some((range) => range.source === "```")).toBe(false);
  });

  it("continues decorating surrounding Markdown when a paragraph contains an atomic reference", () => {
    const source = "**Review** with [Ada](agent://agent-1) and *continue*.";
    const state = EditorState.create({
      doc: source,
      extensions: [markdown({ extensions: GFM })],
    });
    const result = sourceDrivenMarkdownPreview(
      state,
      getMarkdownPreviewBlocks(source),
      new Set(),
      findAtomicMarkdownReferences(source),
    );
    const classes = result.decorations.map((range) => range.value.spec.class);

    expect(classes).toContain("rudder-cm-markdown-strong");
    expect(classes).toContain("rudder-cm-markdown-emphasis");
  });

  it("styles setext headings and thematic breaks without replacing their source lines", () => {
    const source = "Setext heading\n---\n\n***";
    const ranges = decoratedRanges(source);

    expect(ranges).toContainEqual(expect.objectContaining({
      attributes: expect.objectContaining({
        "data-markdown-source-heading-level": "2",
      }),
    }));
    expect(ranges).toContainEqual(expect.objectContaining({
      attributes: expect.objectContaining({
        "data-markdown-thematic-break": "true",
      }),
    }));
    expect(ranges.some((range) => range.source === "***")).toBe(true);
  });

  it("overwrites recycled line semantics when an incomplete heading becomes a list", () => {
    const ranges = decoratedRanges("keyi\n- asd\n-");
    const firstLine = ranges.find((range) => (
      range.attributes?.["data-source-line-start"] === "1"
    ));
    const listLine = ranges.find((range) => (
      range.attributes?.["data-source-line-start"] === "2"
    ));

    expect(firstLine?.attributes?.["data-markdown-source-heading-level"]).toBe("none");
    expect(listLine?.attributes?.["data-markdown-source-heading-level"]).toBe("none");
    expect(listLine?.attributes?.["data-markdown-source-kind"]).toBe("list");
  });

  it("renders nested formatting and website metadata for inline and auto links", () => {
    const source = "[**Bold**](https://example.com) and <https://openai.com>";
    const result = preview(source);
    const classes = result.decorations.map((range) => range.value.spec.class);

    expect(classes).toContain("rudder-cm-markdown-strong");
    expect(classes.filter((className) => className === "rudder-cm-markdown-link")).toHaveLength(2);
    expect(result.websiteLinks.map((link) => link.href)).toEqual([
      "https://example.com",
      "https://openai.com",
    ]);
  });

  it("decodes escaped destinations for metadata and never activates unsafe schemes", () => {
    const escaped = preview("[Docs](https://example.com/a\\(b\\))");
    expect(escaped.websiteLinks).toEqual([
      expect.objectContaining({
        href: "https://example.com/a(b)",
      }),
    ]);

    const unsafe = decoratedRanges("[Run](javascript:alert\\(1\\))");
    const unsafeLink = unsafe.find((range) => (
      range.class === "rudder-cm-markdown-link"
    ));
    expect(unsafeLink?.attributes?.["data-markdown-link-href"]).toBeUndefined();

    const unsafeAutolink = decoratedRanges("<javascript:alert(1)>").find((range) => (
      range.class === "rudder-cm-markdown-link"
    ));
    expect(unsafeAutolink?.attributes?.["data-markdown-link-href"]).toBeUndefined();
  });

  it("keeps relative links and email autolinks interactive", () => {
    for (const href of ["README.md", "docs/file.md", "?tab=x", "#details"]) {
      const link = decoratedRanges(`[Open](${href})`).find((range) => (
        range.class === "rudder-cm-markdown-link"
      ));
      expect(link?.attributes?.["data-markdown-link-href"]).toBe(href);
      expect(link?.attributes?.contenteditable).toBe("false");
    }

    const email = decoratedRanges("<foo@example.com>").find((range) => (
      range.class === "rudder-cm-markdown-link"
    ));
    expect(email?.attributes?.["data-markdown-link-href"]).toBe("mailto:foo@example.com");
    expect(email?.attributes?.contenteditable).toBe("false");
    expect(safeInteractiveMarkdownHref("data:text/html,unsafe")).toBeNull();
  });

  it("renders GFM task markers as interactive checkboxes", () => {
    const source = "- [x] completed\n- [ ] pending";
    const ranges = preview(source).decorations.filter((range) => (
      source.slice(range.from, range.to).match(/^\[[ x]\]$/iu)
    ));

    expect(ranges).toHaveLength(2);
    expect(ranges.every((range) => Boolean(range.value.spec.widget))).toBe(true);
  });

  it("renders ordinary unordered markers as bullets in preview and active source blocks", () => {
    const source = "- first\n+ second\n* third\n1. ordered\n\nParagraph";
    const blocks = getMarkdownPreviewBlocks(source);
    const previewRanges = preview(source).decorations;
    const activeRanges = preview(source, new Set([blocks[0]!.id])).decorations;
    const unorderedMarkers = (ranges: typeof previewRanges) => ranges.filter((range) => (
      /^[-+*]$/u.test(source.slice(range.from, range.to))
      && Boolean(range.value.spec.widget)
    ));

    expect(unorderedMarkers(previewRanges)).toHaveLength(3);
    expect(unorderedMarkers(activeRanges)).toHaveLength(3);
    expect(previewRanges.some((range) => (
      source.slice(range.from, range.to) === "1."
      && Boolean(range.value.spec.widget)
    ))).toBe(false);
  });

  it("leaves task-list bullets available to the existing checkbox source behavior", () => {
    const source = "- [x] completed\n- [ ] pending";
    const blocks = getMarkdownPreviewBlocks(source);
    const ranges = preview(source, new Set([blocks[0]!.id])).decorations;

    expect(ranges.some((range) => (
      source.slice(range.from, range.to) === "-"
      && Boolean(range.value.spec.widget)
    ))).toBe(false);
  });

  it("decorates a large selection-only document in one syntax-tree pass", () => {
    const source = Array.from(
      { length: 3_000 },
      (_, index) => `Line ${index} with **bold** and [link](https://example.com/${index}).`,
    ).join("\n");
    const state = EditorState.create({
      doc: source,
      extensions: [markdown({ extensions: GFM })],
    });
    const blocks = getMarkdownPreviewBlocks(source);
    const startedAt = performance.now();
    const result = sourceDrivenMarkdownPreview(
      state,
      blocks,
      new Set([blocks[1_500]!.id]),
      [],
    );
    const elapsed = performance.now() - startedAt;

    expect(result.decorations.length).toBeGreaterThan(12_000);
    expect(elapsed).toBeLessThan(750);
  });
});
