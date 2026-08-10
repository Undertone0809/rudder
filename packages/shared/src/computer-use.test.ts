import { describe, expect, it } from "vitest";
import {
  COMPUTER_USE_ACTIONS,
  COMPUTER_USE_AGENT_INSTRUCTION,
  COMPUTER_USE_MCP_SERVER_NAME,
  COMPUTER_USE_MCP_TOOLS,
  computerUseActionForToolName,
  computerUseActionSchemas,
} from "./computer-use.js";

describe("Computer Use contract", () => {
  it("publishes one strict MCP tool for every action", () => {
    expect(COMPUTER_USE_MCP_SERVER_NAME).toBe("rudder-computer");
    expect(COMPUTER_USE_MCP_TOOLS.map((tool) => computerUseActionForToolName(tool.name)))
      .toEqual(COMPUTER_USE_ACTIONS);
    for (const tool of COMPUTER_USE_MCP_TOOLS) {
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it("requires a fresh observation for every mutating action", () => {
    for (const action of COMPUTER_USE_ACTIONS.filter((name) => !["list_apps", "list_windows", "get_app_state", "stop"].includes(name))) {
      expect(computerUseActionSchemas[action].safeParse({}).success, action).toBe(false);
    }
  });

  it("inherits the Codex confirmation taxonomy without gating ordinary actions", () => {
    expect(COMPUTER_USE_AGENT_INSTRUCTION).toContain("Changing a password or another authentication credential");
    expect(COMPUTER_USE_AGENT_INSTRUCTION).toContain("browser-generated security warnings");
    expect(COMPUTER_USE_AGENT_INSTRUCTION).toContain("consequential financial actions");
    expect(COMPUTER_USE_AGENT_INSTRUCTION).toContain("Permanently deleting data");
    expect(COMPUTER_USE_AGENT_INSTRUCTION).toContain("legally binding agreement");
    expect(COMPUTER_USE_AGENT_INSTRUCTION).toContain("Changing security-sensitive system or network settings");
    expect(COMPUTER_USE_AGENT_INSTRUCTION).toContain("Deleting recoverable data");
    expect(COMPUTER_USE_AGENT_INSTRUCTION).toContain("ordinary purchase, donation, or subscription");
    expect(COMPUTER_USE_AGENT_INSTRUCTION).toContain("Routine, low-impact communications");
    expect(COMPUTER_USE_AGENT_INSTRUCTION).toContain("Actions not otherwise listed in this taxonomy");
    expect(COMPUTER_USE_AGENT_INSTRUCTION).toContain("no route is preferred by policy");
    expect(COMPUTER_USE_AGENT_INSTRUCTION).toContain("Do not ask early");
  });
});
