import { describe, expect, it } from "vitest";
import { inspectRudderPluginArchiveSchema } from "./plugin-v1.js";

describe("inspectRudderPluginArchiveSchema", () => {
  it("accepts archive payloads above the retired 10 MiB transport limit", () => {
    const result = inspectRudderPluginArchiveSchema.safeParse({
      sourceLabel: "large-plugin.zip",
      filename: "large-plugin.zip",
      content: "a".repeat(14_000_001),
      encoding: "base64",
    });

    expect(result.success).toBe(true);
  });
});
