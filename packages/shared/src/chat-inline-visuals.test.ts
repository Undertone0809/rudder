import { describe, expect, it } from "vitest";
import {
  MAX_CODEX_INLINE_VISUALS,
  chatInlineVisualMappingsFromStructuredPayload,
  parseCodexInlineVisualDirectives,
  stripCodexInlineVisualDirectives,
} from "./chat-inline-visuals.js";

describe("Codex inline visual directives", () => {
  it("parses exact directives with stable source ranges", () => {
    const body = [
      "Before",
      '::codex-inline-vis{file="chart-one.html"}',
      "Middle",
      '::codex-inline-vis{file="simulator.v2.html"}',
      "After",
    ].join("\n");

    const parsed = parseCodexInlineVisualDirectives(body);

    expect(parsed.issues).toEqual([]);
    expect(parsed.directives).toHaveLength(2);
    expect(parsed.directives.map(({ file, raw, index }) => ({ file, raw, index }))).toEqual([
      {
        file: "chart-one.html",
        raw: '::codex-inline-vis{file="chart-one.html"}',
        index: 0,
      },
      {
        file: "simulator.v2.html",
        raw: '::codex-inline-vis{file="simulator.v2.html"}',
        index: 1,
      },
    ]);
    for (const directive of parsed.directives) {
      expect(body.slice(directive.start, directive.end)).toBe(directive.raw);
    }
    expect(stripCodexInlineVisualDirectives(body, parsed.directives)).toBe([
      "Before",
      "Middle",
      "After",
    ].join("\n"));
  });

  it.each([
    ['::codex-inline-vis{file="../escape.html"}', "invalid_file"],
    ['::codex-inline-vis{file="/tmp/escape.html"}', "invalid_file"],
    ['::codex-inline-vis{file="folder\\escape.html"}', "invalid_file"],
    ['::codex-inline-vis{file="chart.svg"}', "invalid_file"],
    ['::codex-inline-vis{src="chart.html"}', "unknown_attribute"],
    ['::codex-inline-vis{file="a.html" file="b.html"}', "duplicate_attribute"],
    ['::codex-inline-vis{file=chart.html}', "malformed_attributes"],
    ['::codex-inline-vis{file="chart.html" extra="x"}', "unknown_attribute"],
  ])("rejects invalid directive %s", (body, code) => {
    const parsed = parseCodexInlineVisualDirectives(body);
    expect(parsed.directives).toEqual([]);
    expect(parsed.issues).toEqual([
      expect.objectContaining({ code, start: 0, end: body.length, raw: body }),
    ]);
  });

  it("reports malformed unterminated grammar without consuming following prose", () => {
    const body = 'Before ::codex-inline-vis{file="chart.html"\nAfter';
    const parsed = parseCodexInlineVisualDirectives(body);
    expect(parsed.directives).toEqual([]);
    expect(parsed.issues).toEqual([
      expect.objectContaining({ code: "unterminated", start: 7, end: body.length }),
    ]);
  });

  it("accepts no more than the message limit", () => {
    const body = Array.from(
      { length: MAX_CODEX_INLINE_VISUALS + 1 },
      (_, index) => `::codex-inline-vis{file="visual-${index}.html"}`,
    ).join("\n");
    const parsed = parseCodexInlineVisualDirectives(body);
    expect(parsed.directives).toHaveLength(MAX_CODEX_INLINE_VISUALS);
    expect(parsed.issues).toEqual([
      expect.objectContaining({ code: "count_limit" }),
    ]);
  });

  it("does not treat Mermaid or similar prose as inline HTML", () => {
    const body = [
      "```mermaid",
      "graph TD",
      "  A --> B",
      "```",
      "::codex-inline-visual{file=\"not-the-directive.html\"}",
    ].join("\n");
    expect(parseCodexInlineVisualDirectives(body)).toEqual({ directives: [], issues: [] });
  });

  it("only accepts directives that occupy their own line outside fenced code", () => {
    const body = [
      'Inline ::codex-inline-vis{file="inline.html"}',
      "```text",
      '::codex-inline-vis{file="quoted.html"}',
      "```",
      '  ::codex-inline-vis{file="accepted.html"}  ',
    ].join("\n");

    const parsed = parseCodexInlineVisualDirectives(body);

    expect(parsed.directives.map((directive) => directive.file)).toEqual(["accepted.html"]);
  });

  it("rejects directives whose attribute record spans multiple lines", () => {
    const body = '::codex-inline-vis{\n  file="chart.html"\n}';
    const parsed = parseCodexInlineVisualDirectives(body);

    expect(parsed.directives).toEqual([]);
    expect(parsed.issues).toEqual([
      expect.objectContaining({ code: "malformed_attributes", raw: body }),
    ]);
  });

  it("accepts only bounded server mapping metadata", () => {
    expect(chatInlineVisualMappingsFromStructuredPayload({
      inlineVisuals: [
        { directiveIndex: 1, file: "missing.html", status: "unavailable", reason: "missing" },
        { directiveIndex: 0, file: "chart.html", status: "ready", attachmentId: "attachment-1" },
        { directiveIndex: 0, file: "duplicate.html", status: "ready", attachmentId: "attachment-2" },
        { directiveIndex: 2, file: "../escape.html", status: "ready", attachmentId: "attachment-3" },
      ],
    })).toEqual([
      { directiveIndex: 0, file: "chart.html", status: "ready", attachmentId: "attachment-1" },
      { directiveIndex: 1, file: "missing.html", status: "unavailable", reason: "missing" },
    ]);
    expect(chatInlineVisualMappingsFromStructuredPayload({ inlineVisuals: "untrusted" })).toEqual([]);
  });
});
