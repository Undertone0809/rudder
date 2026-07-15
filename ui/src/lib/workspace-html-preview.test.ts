// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  buildWorkspaceHtmlStaticFallbackSrcDoc,
  isWorkspaceHtmlContentType,
  isWorkspaceHtmlFilePath,
} from "./workspace-html-preview";

describe("workspace HTML preview", () => {
  it("recognizes HTML by extension or MIME type", () => {
    expect(isWorkspaceHtmlFilePath("reports/summary.HTML")).toBe(true);
    expect(isWorkspaceHtmlFilePath("reports/summary.htm")).toBe(true);
    expect(isWorkspaceHtmlFilePath("reports/summary.md")).toBe(false);
    expect(isWorkspaceHtmlContentType("text/html; charset=utf-8")).toBe(true);
    expect(isWorkspaceHtmlContentType("text/plain")).toBe(false);
  });

  it("places a restrictive static fallback policy before untrusted HTML", () => {
    const preview = buildWorkspaceHtmlStaticFallbackSrcDoc(
      [
        "<meta http-equiv='refresh' content='0;url=https://outside.example'>",
        "<base href='https://outside.example/'>",
        "<!-- untrusted marker -->",
        "<a href='https://outside.example/' ping='https://outside.example/ping'>Outside</a>",
        "<a href='h&#x09;ttps://outside.example/encoded'>Encoded outside</a>",
        "<a href='&#x01;https://outside.example/c0'>C0 outside</a>",
        "<a href='jav&#x0a;ascript:alert(1)'>Encoded script</a>",
        "<a href='/local'>Local</a>",
        "<a href='#inside'>Inside</a>",
        "<a href='https://outside.example/file' download>Download</a>",
        "<script>document.body.dataset.ran = 'yes'</script>",
      ].join(""),
    );

    expect(preview.indexOf("Content-Security-Policy")).toBeLessThan(preview.indexOf("<!-- untrusted marker -->"));
    expect(preview).toContain("script-src 'none'");
    expect(preview).toContain("connect-src 'none'");
    expect(preview).toContain("object-src 'none'");
    expect(preview).not.toContain("http-equiv=\"refresh\"");
    expect(preview).not.toContain("<base");
    expect(preview).not.toContain("ping=");
    expect(preview).not.toContain("href=\"https://outside.example/");
    expect(preview).not.toContain("outside.example/encoded");
    expect(preview).not.toContain("outside.example/c0");
    expect(preview).not.toContain("javascript:alert");
    expect(preview).toContain("data-rudder-blocked-href=\"external\"");
    expect(preview).toContain("data-rudder-blocked-href=\"download\"");
    expect(preview).toContain("href=\"/local\"");
    expect(preview).toContain("href=\"#inside\"");
  });
});
