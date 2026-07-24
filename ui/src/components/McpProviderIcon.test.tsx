import { describe, expect, it } from "vitest";
import { mcpProviderLogoSrc } from "./McpProviderIcon";

describe("McpProviderIcon", () => {
  it("maps curated providers to their brand assets", () => {
    expect(mcpProviderLogoSrc("supabase")).toBe("/brands/supabase-logo.svg");
    expect(mcpProviderLogoSrc("notion")).toBe("/brands/notion-logo.svg");
    expect(mcpProviderLogoSrc("linear")).toBe("/brands/linear-logo.svg");
  });

  it("uses the generic icon fallback for custom MCP connections", () => {
    expect(mcpProviderLogoSrc("custom")).toBeUndefined();
  });
});
