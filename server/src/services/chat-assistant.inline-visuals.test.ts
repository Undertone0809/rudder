import { describe, expect, it } from "vitest";
import { extractCodexInlineVisualArtifacts, validateAssistantResult } from "./chat-assistant.helpers.js";

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
        retained: "safe",
      },
    }).structuredPayload).toEqual({ retained: "safe" });
  });
});
