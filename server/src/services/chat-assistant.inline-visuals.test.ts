import { describe, expect, it } from "vitest";
import {
  chatAssistantErrorForLog,
  ChatAssistantStreamError,
  extractCodexInlineVisualArtifacts,
  extractRudderInlineVisualArtifacts,
  validateAssistantResult,
} from "./chat-assistant.helpers.js";

describe("runtime-neutral Rudder inline visual extraction", () => {
  it("keeps captured backing bytes out of serialized stream errors", () => {
    const attachment = {
      source: "rudder_inline_visual" as const,
      originalFilename: "inline-visual-1.html",
      contentType: "text/html" as const,
      body: Buffer.from('<div id="widget">INLINE_VISUAL_PRIVATE_BYTES_93f1</div>'),
      slot: 0,
    };
    const error = new ChatAssistantStreamError("failed", "", [attachment]);

    expect(error.generatedAttachments).toEqual([attachment]);
    expect(JSON.stringify(error)).not.toContain("INLINE_VISUAL_PRIVATE_BYTES_93f1");
    expect(Object.keys(error)).not.toContain("generatedAttachments");
    expect(JSON.stringify(chatAssistantErrorForLog(error))).not.toContain("INLINE_VISUAL_PRIVATE_BYTES_93f1");
    const enumerableError = Object.assign(new Error("failed"), {
      generatedAttachments: [attachment],
    });
    expect(JSON.stringify(chatAssistantErrorForLog(enumerableError))).not.toContain("INLINE_VISUAL_PRIVATE_BYTES_93f1");
    const sourceBearingError = new Error([
      "provider failure",
      ":::rudder-inline-visual:v1",
      '<div id="widget">private diagnostic</div>',
      ":::rudder-inline-visual:end",
    ].join("\n"));
    expect(JSON.stringify(chatAssistantErrorForLog(sourceBearingError))).not.toContain("private diagnostic");
    expect(JSON.stringify(chatAssistantErrorForLog(sourceBearingError))).not.toContain(":::rudder-inline-visual");
  });

  it("normalizes a message envelope into a generated attachment and canonical placement", () => {
    const result = extractRudderInlineVisualArtifacts([
      "Capacity report",
      ":::rudder-inline-visual:v1",
      "<style>#widget{display:grid}</style>",
      '<div id="widget">Balanced</div>',
      ":::rudder-inline-visual:end",
    ].join("\n"));

    expect(result.body).toBe('Capacity report\n::rudder-inline-vis{slot="0"}');
    expect(result.inlineVisualsV1).toEqual([
      {
        version: 1,
        slot: 0,
        file: "inline-visual-1.html",
        status: "captured",
        byteSize: Buffer.byteLength('<style>#widget{display:grid}</style>\n<div id="widget">Balanced</div>'),
      },
    ]);
    expect(result.attachments).toEqual([
      expect.objectContaining({
        source: "rudder_inline_visual",
        originalFilename: "inline-visual-1.html",
        contentType: "text/html",
        slot: 0,
      }),
    ]);
  });

  it("keeps rejected fragments private and emits an unavailable canonical placement", () => {
    const result = extractRudderInlineVisualArtifacts([
      "Before",
      ":::rudder-inline-visual:v1",
      '<div id="widget"><script>steal()</script></div>',
      ":::rudder-inline-visual:end",
      "After",
    ].join("\n"));

    expect(result.body).toBe('Before\n::rudder-inline-vis{slot="0"}\nAfter');
    expect(result.body).not.toContain("steal");
    expect(result.attachments).toEqual([]);
    expect(result.inlineVisualsV1).toEqual([
      expect.objectContaining({ version: 1, slot: 0, status: "unavailable", reason: "unsafe_fragment" }),
    ]);
  });

  it("shares the three-slot budget with in-flight legacy Codex visuals", () => {
    const result = extractRudderInlineVisualArtifacts([
      ":::rudder-inline-visual:v1",
      '<div id="widget">One</div>',
      ":::rudder-inline-visual:end",
      ":::rudder-inline-visual:v1",
      '<div id="widget">Two</div>',
      ":::rudder-inline-visual:end",
    ].join("\n"), { reservedSlots: 2 });

    expect(result.inlineVisualsV1).toHaveLength(1);
    expect(result.inlineVisualsV1[0]).toEqual(expect.objectContaining({ slot: 2 }));
    expect(result.attachments).toHaveLength(1);
  });
});

describe("chat assistant Codex inline visual extraction", () => {
  it("converts adapter capture metadata into generated attachments and directive results", () => {
    const html = '<div id="widget">Chart</div>';
    const result = extractCodexInlineVisualArtifacts({
      exitCode: 0,
      signal: null,
      timedOut: false,
      resultJson: {
        inlineVisuals: [
          {
            directiveIndex: 0,
            file: "chart.html",
            status: "captured",
            contentType: "text/html",
            byteSize: Buffer.byteLength(html),
            bodyBase64: Buffer.from(html).toString("base64"),
          },
          {
            directiveIndex: 1,
            file: "missing.html",
            status: "unavailable",
            reason: "missing",
          },
          {
            directiveIndex: 2,
            file: "stale.html",
            status: "unavailable",
            reason: "out_of_window",
          },
        ],
      },
    });

    expect(result.inlineVisuals).toEqual([
      { directiveIndex: 0, file: "chart.html", status: "captured" },
      { directiveIndex: 1, file: "missing.html", status: "unavailable", reason: "missing" },
      { directiveIndex: 2, file: "stale.html", status: "unavailable", reason: "out_of_window" },
    ]);
    expect(result.attachments).toEqual([
      expect.objectContaining({
        source: "codex_inline_visual",
        originalFilename: "chart.html",
        contentType: "text/html",
        directiveIndex: 0,
        directiveFile: "chart.html",
      }),
    ]);
    expect(result.attachments[0]?.body.equals(Buffer.from(html))).toBe(true);
  });

  it("drops malformed, oversized, duplicate, and path-bearing adapter metadata", () => {
    const tiny = Buffer.from("ok").toString("base64");
    const result = extractCodexInlineVisualArtifacts({
      exitCode: 0,
      signal: null,
      timedOut: false,
      resultJson: {
        inlineVisuals: [
          { directiveIndex: 0, file: "../escape.html", status: "captured", contentType: "text/html", byteSize: 2, bodyBase64: tiny },
          { directiveIndex: 0, file: "chart.html", status: "captured", contentType: "text/html", byteSize: 2, bodyBase64: tiny },
          { directiveIndex: 0, file: "duplicate.html", status: "captured", contentType: "text/html", byteSize: 2, bodyBase64: tiny },
          { directiveIndex: 1, file: "wrong.svg", status: "captured", contentType: "image/svg+xml", byteSize: 2, bodyBase64: tiny },
          { directiveIndex: 2, file: "large.html", status: "captured", contentType: "text/html", byteSize: 2 * 1024 * 1024 + 1, bodyBase64: tiny },
          { directiveIndex: 3, file: "fourth.html", status: "unavailable", reason: "missing" },
        ],
      },
    });

    expect(result.inlineVisuals).toEqual([
      { directiveIndex: 0, file: "chart.html", status: "captured" },
    ]);
    expect(result.attachments).toHaveLength(1);
  });
});

describe("inline visual metadata ownership", () => {
  it("drops model-provided inline visual mappings from structured payload", () => {
    expect(validateAssistantResult({
      kind: "message",
      body: 'Chart\n::codex-inline-vis{file="chart.html"}',
      structuredPayload: {
        inlineVisuals: [{ directiveIndex: 0, file: "chart.html", status: "ready", attachmentId: "forged" }],
        inlineVisualsV1: [{ version: 1, slot: 0, file: "inline-visual-1.html", status: "ready", attachmentId: "forged" }],
        retained: "safe",
      },
    }).structuredPayload).toEqual({ retained: "safe" });
  });
});
