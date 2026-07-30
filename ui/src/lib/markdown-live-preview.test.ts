import { describe, expect, it } from "vitest";
import {
  activeMarkdownPreviewBlockIds,
  buildMarkdownLink,
  findAtomicMarkdownReferences,
  getMarkdownPreviewBlocks,
  getMarkdownPreviewDocument,
  markdownPreviewSource,
  markdownReferenceDefinitions,
  provisionalWebsiteLabel,
  readSingleHttpUrl,
} from "./markdown-live-preview";

describe("getMarkdownPreviewBlocks", () => {
  it("reuses the parsed document model while only the selection changes", () => {
    const first = getMarkdownPreviewDocument("# Heading\nParagraph");
    const reused = getMarkdownPreviewDocument("# Heading\nParagraph", first);
    const changed = getMarkdownPreviewDocument("# Changed\nParagraph", first);

    expect(reused).toBe(first);
    expect(changed).not.toBe(first);
    expect(changed.blocks[0]?.markdown).toBe("# Changed");
  });

  it("keeps ordinary source lines independently addressable", () => {
    const source = "# Heading\nA paragraph with **weight**.\n- task";

    expect(getMarkdownPreviewBlocks(source)).toEqual([
      {
        id: "0:9",
        from: 0,
        to: 9,
        startLine: 1,
        endLine: 1,
        kind: "line",
        markdown: "# Heading",
        previewable: true,
      },
      {
        id: "10:38",
        from: 10,
        to: 38,
        startLine: 2,
        endLine: 2,
        kind: "line",
        markdown: "A paragraph with **weight**.",
        previewable: true,
      },
      {
        id: "39:45",
        from: 39,
        to: 45,
        startLine: 3,
        endLine: 3,
        kind: "list",
        markdown: "- task",
        previewable: true,
      },
    ]);
  });

  it("keeps a list item stable while the next list marker is still incomplete", () => {
    const source = "- first\n- second\n-";

    expect(getMarkdownPreviewBlocks(source)).toEqual([
      expect.objectContaining({
        kind: "list",
        startLine: 1,
        endLine: 1,
        markdown: "- first",
      }),
      expect.objectContaining({
        kind: "list",
        startLine: 2,
        endLine: 2,
        markdown: "- second",
      }),
      expect.objectContaining({
        kind: "line",
        startLine: 3,
        endLine: 3,
        markdown: "-",
      }),
    ]);
  });

  it("activates fenced code and GFM tables as indivisible source blocks", () => {
    const source = [
      "| Name | State |",
      "| --- | --- |",
      "| Rudder | ready |",
      "",
      "```ts",
      "const answer = 42;",
      "```",
    ].join("\n");

    const blocks = getMarkdownPreviewBlocks(source);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      kind: "table",
      startLine: 1,
      endLine: 3,
      markdown: "| Name | State |\n| --- | --- |\n| Rudder | ready |",
    });
    expect(blocks[1]).toMatchObject({
      kind: "fenced-code",
      startLine: 5,
      endLine: 7,
      markdown: "```ts\nconst answer = 42;\n```",
    });
  });

  it("activates sibling list items independently while retaining nested content", () => {
    const source = [
      "1. first",
      "1. second",
      "   - [ ] nested task",
      "",
      "1. third",
      "",
      "after",
    ].join("\n");

    expect(getMarkdownPreviewBlocks(source)).toEqual([
      expect.objectContaining({
        kind: "list",
        startLine: 1,
        endLine: 1,
        markdown: "1. first",
      }),
      expect.objectContaining({
        kind: "list",
        startLine: 2,
        endLine: 3,
        markdown: "1. second\n   - [ ] nested task",
      }),
      expect.objectContaining({
        kind: "list",
        startLine: 5,
        endLine: 5,
        markdown: "1. third",
      }),
      expect.objectContaining({
        kind: "line",
        startLine: 7,
        endLine: 7,
      }),
    ]);
  });

  it("does not absorb a paragraph after a list-ending blank line", () => {
    const source = "- first\n\nparagraph";

    expect(getMarkdownPreviewBlocks(source)).toEqual([
      expect.objectContaining({
        kind: "list",
        startLine: 1,
        endLine: 1,
        markdown: "- first",
      }),
      expect.objectContaining({
        kind: "line",
        startLine: 3,
        endLine: 3,
        markdown: "paragraph",
      }),
    ]);
  });

  it("retains a CommonMark lazy continuation in its list block", () => {
    const source = "- first\ncontinued";

    expect(getMarkdownPreviewBlocks(source)).toEqual([
      expect.objectContaining({
        kind: "list",
        startLine: 1,
        endLine: 2,
        markdown: source,
      }),
    ]);
  });

  it("retains a CommonMark lazy continuation in its blockquote block", () => {
    const source = "> quoted\ncontinued\n\noutside";

    expect(getMarkdownPreviewBlocks(source)).toEqual([
      expect.objectContaining({
        kind: "blockquote",
        startLine: 1,
        endLine: 2,
        markdown: "> quoted\ncontinued",
      }),
      expect.objectContaining({
        kind: "line",
        startLine: 4,
        endLine: 4,
        markdown: "outside",
      }),
    ]);
  });

  it("ends a lazy blockquote before a following GFM table", () => {
    const source = "> quoted\nA | B\n--- | ---";

    expect(getMarkdownPreviewBlocks(source)).toEqual([
      expect.objectContaining({
        kind: "blockquote",
        startLine: 1,
        endLine: 1,
        markdown: "> quoted",
      }),
      expect.objectContaining({
        kind: "table",
        startLine: 2,
        endLine: 3,
        markdown: "A | B\n--- | ---",
      }),
    ]);
  });

  it("ends a list before a directly following fenced code block", () => {
    const source = "- first\n```ts\nconst answer = 42;\n```";

    expect(getMarkdownPreviewBlocks(source)).toEqual([
      expect.objectContaining({
        kind: "list",
        startLine: 1,
        endLine: 1,
        markdown: "- first",
      }),
      expect.objectContaining({
        kind: "fenced-code",
        startLine: 2,
        endLine: 4,
        markdown: "```ts\nconst answer = 42;\n```",
      }),
    ]);
  });

  it("does not consume the rest of the document for an invalid backtick fence opener", () => {
    const source = "```js`invalid\n# Heading";

    expect(getMarkdownPreviewBlocks(source)).toEqual([
      expect.objectContaining({
        kind: "line",
        startLine: 1,
        endLine: 1,
        markdown: "```js`invalid",
      }),
      expect.objectContaining({
        kind: "line",
        startLine: 2,
        endLine: 2,
        markdown: "# Heading",
      }),
    ]);
  });

  it("retains document link definitions when rendering an isolated source line", () => {
    const source = [
      "Read [the guide][guide].",
      "",
      "[guide]: https://example.com/guide \"Guide\"",
    ].join("\n");
    const [line] = getMarkdownPreviewBlocks(source);
    const definitions = markdownReferenceDefinitions(source);

    expect(markdownPreviewSource(line!, definitions)).toBe(
      "Read [the guide][guide].\n\n[guide]: https://example.com/guide \"Guide\"",
    );
    expect(markdownPreviewSource(getMarkdownPreviewBlocks("# Heading")[0]!, [])).toBe(
      "# Heading",
    );
  });

  it("recognizes a one-column GFM table as a complete syntax block", () => {
    expect(getMarkdownPreviewBlocks("| Name |\n| --- |\n| Rudder |")).toEqual([
      expect.objectContaining({
        kind: "table",
        startLine: 1,
        endLine: 3,
      }),
    ]);
  });

  it("keeps compact delimiters and long multilingual GFM rows in one table block", () => {
    const source = [
      "| 来源 | 可靠性 | 支撑内容 |",
      "|---|---|---|",
      "| OpenClaw 文档: https://docs.openclaw.ai/concepts/dreaming | 官方文档 | 阶段模型、默认启用方式与 CLI/UI 入口。 |",
      "| OpenClaw 源码, `openclaw/openclaw` | 开源实现 | scoring 和 promotion 阈值。 |",
    ].join("\n");

    expect(getMarkdownPreviewBlocks(source)).toEqual([
      expect.objectContaining({
        kind: "table",
        startLine: 1,
        endLine: 4,
        markdown: source,
      }),
    ]);
  });

  it("never turns raw HTML into a rendered preview block", () => {
    const blocks = getMarkdownPreviewBlocks("<script>alert('no')</script>\n<div>source</div>");

    expect(blocks).toEqual([
      expect.objectContaining({ startLine: 1, previewable: false }),
      expect.objectContaining({ startLine: 2, previewable: false }),
    ]);
  });

  it("keeps a multiline raw HTML block entirely in safe source mode", () => {
    expect(getMarkdownPreviewBlocks("<div>\nunsafe-looking text\n</div>\n\npreview")).toEqual([
      expect.objectContaining({
        kind: "html",
        startLine: 1,
        endLine: 3,
        previewable: false,
      }),
      expect.objectContaining({
        kind: "line",
        startLine: 5,
        previewable: true,
      }),
    ]);
  });

  it("keeps processing instructions as source without hiding Markdown autolinks", () => {
    expect(getMarkdownPreviewBlocks("<?xml version=\"1.0\"?>\n<https://example.com>")).toEqual([
      expect.objectContaining({
        kind: "html",
        startLine: 1,
        previewable: false,
      }),
      expect.objectContaining({
        kind: "line",
        startLine: 2,
        previewable: true,
      }),
    ]);
  });

  it("keeps inline HTML and comments visible as inert source", () => {
    const blocks = getMarkdownPreviewBlocks([
      "Before <span>inside</span> after",
      "Before <!-- hidden --> after",
      "Before <https://example.com> after",
    ].join("\n"));

    expect(blocks.map(({ markdown, previewable }) => ({
      markdown,
      previewable,
    }))).toEqual([
      {
        markdown: "Before <span>inside</span> after",
        previewable: false,
      },
      {
        markdown: "Before <!-- hidden --> after",
        previewable: false,
      },
      {
        markdown: "Before <https://example.com> after",
        previewable: true,
      },
    ]);
  });

  it("returns every logical block touched by a cross-line selection", () => {
    const source = "# One\nparagraph\n# Two";
    const blocks = getMarkdownPreviewBlocks(source);

    expect(activeMarkdownPreviewBlockIds(blocks, [{ from: 2, to: 18 }])).toEqual(
      new Set(blocks.map((block) => block.id)),
    );
    expect(activeMarkdownPreviewBlockIds(blocks, [{ from: 8, to: 8 }])).toEqual(
      new Set([blocks[1]!.id]),
    );
  });
});

describe("Markdown URL authoring", () => {
  it("accepts only one credential-free HTTP(S) URL", () => {
    expect(readSingleHttpUrl(" https://example.com/a?q=1 ")).toBe("https://example.com/a?q=1");
    expect(readSingleHttpUrl("http://example.com")).toBe("http://example.com");
    expect(readSingleHttpUrl("https://user:pass@example.com")).toBeNull();
    expect(readSingleHttpUrl("javascript:alert(1)")).toBeNull();
    expect(readSingleHttpUrl("https://one.example\nhttps://two.example")).toBeNull();
    expect(readSingleHttpUrl("See https://example.com")).toBeNull();
  });

  it("escapes labels and destinations without replacing the pasted URL", () => {
    expect(buildMarkdownLink("A [label] \\\\", "https://example.com/a_(b)")).toBe(
      "[A \\[label\\] \\\\\\\\](https://example.com/a_\\(b\\))",
    );
  });

  it("uses a known site name before falling back to the hostname", () => {
    expect(provisionalWebsiteLabel("https://github.com/openai/codex")).toBe("GitHub");
    expect(provisionalWebsiteLabel("https://docs.example.dev/guide")).toBe("docs.example.dev");
  });
});

describe("atomic Rudder Markdown references", () => {
  it("keeps @ references and historical skill links atomic but leaves normal links editable", () => {
    const source = [
      "[Ada](agent://agent-1)",
      "[deploy](automation://automation-1)",
      "[Doc](library-doc://doc-1)",
      "[Entry](library-entry://entry-1?p=docs%2Fentry.md)",
      "[File](library-file://file?p=docs%2Ffile.md)",
      "[Directory](library-directory://directory?p=docs)",
      "[$review](/skills/review/SKILL.md)",
      "[External spec](https://example.com/SKILL.md)",
      "[OpenAI](https://openai.com)",
    ].join(" ");

    const references = findAtomicMarkdownReferences(source);

    expect(references.map(({ markdown, label }) => ({ markdown, label }))).toEqual([
      { markdown: "[Ada](agent://agent-1)", label: "Ada" },
      { markdown: "[deploy](automation://automation-1)", label: "deploy" },
      { markdown: "[Doc](library-doc://doc-1)", label: "Doc" },
      {
        markdown: "[Entry](library-entry://entry-1?p=docs%2Fentry.md)",
        label: "Entry",
      },
      {
        markdown: "[File](library-file://file?p=docs%2Ffile.md)",
        label: "File",
      },
      {
        markdown: "[Directory](library-directory://directory?p=docs)",
        label: "Directory",
      },
      { markdown: "[$review](/skills/review/SKILL.md)", label: "$review" },
    ]);
  });

  it("ignores canonical-looking text inside code and raw HTML", () => {
    const source = [
      "`[Inline](agent://inline)`",
      "",
      "```md",
      "[Fence](agent://fence)",
      "```",
      "",
      '<div data-reference="[Html](agent://html)">',
      "",
      "[Real](agent://real)",
    ].join("\n");

    expect(findAtomicMarkdownReferences(source)).toEqual([
      expect.objectContaining({
        markdown: "[Real](agent://real)",
        label: "Real",
        href: "agent://real",
      }),
    ]);
  });

  it("recognizes escaped canonical labels and destinations as one atomic reference", () => {
    const markdown = buildMarkdownLink(
      "Ada [platform]",
      "agent://agent-(platform)",
    );

    expect(markdown).toBe(
      "[Ada \\[platform\\]](agent://agent-\\(platform\\))",
    );
    expect(findAtomicMarkdownReferences(markdown)).toEqual([
      {
        from: 0,
        to: markdown.length,
        markdown,
        label: "Ada [platform]",
        href: "agent://agent-(platform)",
      },
    ]);
  });
});
