import { describe, expect, it } from "vitest";
import {
  buildWorkspaceHtmlPreviewSrcDoc,
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

  it("injects the restrictive preview policy into a complete HTML document", () => {
    const preview = buildWorkspaceHtmlPreviewSrcDoc(
      "<!doctype html><html><head><title>Report</title></head><body><h1>Report</h1></body></html>",
    );

    expect(preview).toContain("Content-Security-Policy");
    expect(preview).toContain("default-src 'none'");
    expect(preview).toContain("form-action 'none'");
    expect(preview).toContain("<h1>Report</h1>");
  });

  it("keeps the preview policy ahead of untrusted head-like text", () => {
    const content = "<!-- <head> --><html><head><title>Report</title></head><body>Report</body></html>";
    const preview = buildWorkspaceHtmlPreviewSrcDoc(content);

    expect(preview.indexOf("Content-Security-Policy")).toBeGreaterThanOrEqual(0);
    expect(preview.indexOf("Content-Security-Policy")).toBeLessThan(preview.indexOf(content));
    expect(preview).toMatch(/^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"/);
  });

  it("wraps HTML fragments in a policy-protected document", () => {
    const preview = buildWorkspaceHtmlPreviewSrcDoc("<main>Rendered report</main>");

    expect(preview).toMatch(/^<!doctype html><html><head>/);
    expect(preview).toContain("Content-Security-Policy");
    expect(preview).toContain("<body><main>Rendered report</main></body>");
  });
});
