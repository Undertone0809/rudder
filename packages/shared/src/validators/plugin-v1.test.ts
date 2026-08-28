import { describe, expect, it } from "vitest";
import {
  configureRudderPluginMarketplaceSchema,
  inspectRudderPluginArchiveSchema,
  inspectRudderPluginSchema,
} from "./plugin-v1.js";

describe("Plugin V1 package validators", () => {
  it("accepts package inventories with more than 500 files", () => {
    const files = Array.from({ length: 600 }, (_, index) => ({
      path: `assets/${index}.txt`,
      content: "x",
      encoding: "utf8" as const,
    }));

    expect(inspectRudderPluginSchema.safeParse({ sourceLabel: "large", files }).success).toBe(true);
    expect(configureRudderPluginMarketplaceSchema.safeParse({ sourceLabel: "large", files }).success).toBe(true);
  });

  it("does not impose an aggregate archive content ceiling", () => {
    expect(inspectRudderPluginArchiveSchema.safeParse({
      sourceLabel: "large archive",
      filename: "large.zip",
      content: "a".repeat(14_000_001),
      encoding: "base64",
    }).success).toBe(true);
  });
});
