import { describe, expect, it } from "vitest";
import {
  MAX_CODEX_INLINE_VISUALS,
  MAX_RUDDER_INLINE_VISUAL_FRAGMENT_BYTES,
  MAX_RUDDER_INLINE_VISUAL_REPLY_BYTES,
  MAX_RUDDER_INLINE_VISUAL_TOTAL_BYTES,
  RUDDER_INLINE_VISUAL_END,
  RUDDER_INLINE_VISUAL_START,
  chatInlineVisualMappingsFromStructuredPayload,
  createRudderInlineVisualStreamSuppressor,
  parseCodexInlineVisualDirectives,
  parseRudderInlineVisualEnvelopes,
  parseRudderInlineVisualPlacements,
  replaceRudderInlineVisualSources,
  rudderInlineVisualMappingsFromStructuredPayload,
  stripCodexInlineVisualDirectives,
} from "./chat-inline-visuals.js";

function visual(fragment = '<div id="widget">Chart</div>') {
  return `${RUDDER_INLINE_VISUAL_START}\n${fragment}\n${RUDDER_INLINE_VISUAL_END}`;
}

describe("Rudder inline visual envelopes", () => {
  it("parses strict own-line LF and CRLF envelopes with stable source ranges", () => {
    const body = `Before\r\n${visual()}\r\nAfter`;
    const parsed = parseRudderInlineVisualEnvelopes(body);

    expect(parsed.issues).toEqual([]);
    expect(parsed.envelopes).toEqual([
      expect.objectContaining({
        slot: 0,
        fragment: '<div id="widget">Chart</div>',
        byteSize: Buffer.byteLength('<div id="widget">Chart</div>'),
      }),
    ]);
    expect(body.slice(parsed.envelopes[0]!.start, parsed.envelopes[0]!.end)).toContain(RUDDER_INLINE_VISUAL_END);
  });

  it("ignores examples in CommonMark code and quotes", () => {
    const body = [
      "```text",
      visual("inside fence"),
      "```",
      `> ${RUDDER_INLINE_VISUAL_START}`,
      "> quoted",
      `> ${RUDDER_INLINE_VISUAL_END}`,
      `    ${RUDDER_INLINE_VISUAL_START}`,
      "    indented",
      `    ${RUDDER_INLINE_VISUAL_END}`,
    ].join("\n");
    expect(parseRudderInlineVisualEnvelopes(body)).toEqual({ envelopes: [], issues: [] });
  });

  it("treats backticks in a tilde fence info string as fenced content", () => {
    const body = [
      "~~~text `literal`",
      visual("inside tilde fence"),
      "~~~",
    ].join("\n");
    expect(parseRudderInlineVisualEnvelopes(body)).toEqual({ envelopes: [], issues: [] });
  });

  it("rejects malformed, nested, empty, and unterminated envelopes", () => {
    expect(parseRudderInlineVisualEnvelopes(`${RUDDER_INLINE_VISUAL_START}\n${RUDDER_INLINE_VISUAL_END}`).issues)
      .toEqual([expect.objectContaining({ code: "empty", slot: 0 })]);
    expect(parseRudderInlineVisualEnvelopes(`${RUDDER_INLINE_VISUAL_START}\n${RUDDER_INLINE_VISUAL_START}\nx\n${RUDDER_INLINE_VISUAL_END}`).issues)
      .toEqual([expect.objectContaining({ code: "nested", slot: 0 })]);
    expect(parseRudderInlineVisualEnvelopes(`${RUDDER_INLINE_VISUAL_START}\nsecret`).issues)
      .toEqual([expect.objectContaining({ code: "unterminated", slot: 0 })]);
    expect(parseRudderInlineVisualEnvelopes(`prefix ${RUDDER_INLINE_VISUAL_START}\nx\n${RUDDER_INLINE_VISUAL_END}`).envelopes)
      .toEqual([]);
  });

  it("enforces count, fragment, aggregate, and visual-bearing reply byte limits", () => {
    const oversizedFragment = "x".repeat(MAX_RUDDER_INLINE_VISUAL_FRAGMENT_BYTES + 1);
    expect(parseRudderInlineVisualEnvelopes(visual(oversizedFragment)).issues)
      .toEqual([expect.objectContaining({ code: "fragment_size_limit", slot: 0 })]);

    const half = "界".repeat(Math.floor(MAX_RUDDER_INLINE_VISUAL_TOTAL_BYTES / 6));
    const aggregate = [visual(half), visual(half), visual(half)].join("\n");
    expect(parseRudderInlineVisualEnvelopes(aggregate).issues)
      .toContainEqual(expect.objectContaining({ code: "total_size_limit" }));

    const four = Array.from({ length: MAX_CODEX_INLINE_VISUALS + 1 }, () => visual()).join("\n");
    const countParsed = parseRudderInlineVisualEnvelopes(four);
    expect(countParsed.envelopes).toHaveLength(MAX_CODEX_INLINE_VISUALS);
    expect(countParsed.issues).toContainEqual(expect.objectContaining({ code: "count_limit", slot: null }));

    const oversizedReply = `${"p".repeat(MAX_RUDDER_INLINE_VISUAL_REPLY_BYTES)}\n${visual()}`;
    const replyParsed = parseRudderInlineVisualEnvelopes(oversizedReply);
    expect(replyParsed.envelopes).toEqual([]);
    expect(replyParsed.issues).toContainEqual(expect.objectContaining({ code: "reply_size_limit", slot: 0 }));
  });

  it("parses canonical placements and bounded server mappings", () => {
    const body = ["Before", '::rudder-inline-vis{slot="1"}', "After"].join("\n");
    expect(parseRudderInlineVisualPlacements(body).placements).toEqual([
      expect.objectContaining({ slot: 1, raw: '::rudder-inline-vis{slot="1"}' }),
    ]);
    expect(rudderInlineVisualMappingsFromStructuredPayload({
      inlineVisualsV1: [
        {
          version: 1,
          slot: 0,
          file: "inline-visual-1.html",
          status: "ready",
          attachmentId: "attachment-1",
          contentType: "text/html",
          byteSize: 42,
          sha256: "a".repeat(64),
        },
        { version: 1, slot: 1, file: "inline-visual-2.html", status: "unavailable", reason: "empty" },
      ],
    })).toEqual([
      expect.objectContaining({ version: 1, slot: 0, status: "ready", attachmentId: "attachment-1" }),
      expect.objectContaining({ version: 1, slot: 1, status: "unavailable", reason: "empty" }),
    ]);
  });

  it("replaces accepted and rejected source ranges without exposing HTML", () => {
    const body = `Before\n${visual()}\n${RUDDER_INLINE_VISUAL_START}\nsecret`;
    const parsed = parseRudderInlineVisualEnvelopes(body);
    const normalized = replaceRudderInlineVisualSources(body, [
      ...parsed.envelopes.map((entry) => ({ ...entry, replacement: `::rudder-inline-vis{slot="${entry.slot}"}` })),
      ...parsed.issues.map((entry) => ({ ...entry, replacement: entry.slot === null ? "" : `::rudder-inline-vis{slot="${entry.slot}"}` })),
    ]);
    expect(normalized).toContain('::rudder-inline-vis{slot="0"}');
    expect(normalized).toContain('::rudder-inline-vis{slot="1"}');
    expect(normalized).not.toContain("secret");
    expect(normalized).not.toContain(RUDDER_INLINE_VISUAL_START);
  });

  it("quarantines an entire nested envelope through the matching outer end", () => {
    const body = [
      "Before",
      RUDDER_INLINE_VISUAL_START,
      "secret-a",
      RUDDER_INLINE_VISUAL_START,
      "secret-b",
      RUDDER_INLINE_VISUAL_END,
      "secret-after-inner-end",
      RUDDER_INLINE_VISUAL_END,
      "After",
    ].join("\n");
    const parsed = parseRudderInlineVisualEnvelopes(body);
    expect(parsed.envelopes).toEqual([]);
    expect(parsed.issues).toEqual([expect.objectContaining({ code: "nested", slot: 0 })]);
    const normalized = replaceRudderInlineVisualSources(body, parsed.issues.map((entry) => ({
      ...entry,
      replacement: '::rudder-inline-vis{slot="0"}',
    })));
    expect(normalized).toBe('Before\n::rudder-inline-vis{slot="0"}\nAfter');
    expect(normalized).not.toContain("secret");
  });
});

describe("Rudder inline visual streaming suppression", () => {
  it("suppresses a visual for every possible chunk boundary", () => {
    const source = `Before\n${visual('<div id="widget">secret</div>')}\nAfter`;
    for (let split = 0; split <= source.length; split += 1) {
      const suppressor = createRudderInlineVisualStreamSuppressor();
      const output = suppressor.push(source.slice(0, split))
        + suppressor.push(source.slice(split))
        + suppressor.finish();
      expect(output).toBe("Before\nAfter");
      expect(output).not.toContain("secret");
    }
  });

  it("suppresses nested envelopes through the outer end at every chunk boundary", () => {
    const source = [
      "Before",
      RUDDER_INLINE_VISUAL_START,
      "secret-a",
      RUDDER_INLINE_VISUAL_START,
      "secret-b",
      RUDDER_INLINE_VISUAL_END,
      "secret-after-inner-end",
      RUDDER_INLINE_VISUAL_END,
      "After",
    ].join("\n");
    for (let split = 0; split <= source.length; split += 1) {
      const suppressor = createRudderInlineVisualStreamSuppressor();
      const output = suppressor.push(source.slice(0, split))
        + suppressor.push(source.slice(split))
        + suppressor.finish();
      expect(output).toBe("Before\nAfter");
      expect(output).not.toContain("secret");
      expect(output).not.toContain("rudder-inline-visual");
    }
  });

  it("drops partial opening markers and unterminated bodies on stop", () => {
    for (const source of [
      RUDDER_INLINE_VISUAL_START.slice(0, -2),
      `${RUDDER_INLINE_VISUAL_START}\nsecret`,
    ]) {
      const suppressor = createRudderInlineVisualStreamSuppressor();
      const output = suppressor.push(source) + suppressor.finish();
      expect(output).not.toContain("secret");
      expect(output).not.toContain("rudder-inline-visual");
    }
  });

  it("does not suppress fenced documentation examples", () => {
    const source = `\`\`\`text\n${visual("example")}\n\`\`\``;
    const suppressor = createRudderInlineVisualStreamSuppressor();
    expect(suppressor.push(source) + suppressor.finish()).toBe(source);
  });

  it("discards a large single-line fragment incrementally without exposing it", () => {
    const suppressor = createRudderInlineVisualStreamSuppressor();
    expect(suppressor.push(`${RUDDER_INLINE_VISUAL_START}\n`)).toBe("");
    for (let index = 0; index < 64; index += 1) {
      expect(suppressor.push("private".repeat(1024))).toBe("");
    }
    expect(suppressor.push(`\n${RUDDER_INLINE_VISUAL_END}\nVisible`)).toBe("Visible");
    expect(suppressor.finish()).toBe("");
    expect(suppressor.visibleText).toBe("Visible");
  });
});

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
