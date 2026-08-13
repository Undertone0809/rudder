import { describe, expect, it } from "vitest";
import { readPiLoadedMcpServers } from "./mcp-evidence.js";

describe("readPiLoadedMcpServers", () => {
  it("does not mislabel Pi native tool bridges as MCP servers", () => {
    expect(readPiLoadedMcpServers()).toEqual([]);
  });
});
