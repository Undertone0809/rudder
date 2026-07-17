import { describe, expect, it } from "vitest";
import { resolvePiRudderMcpToolEntries } from "./execute.js";

describe("Pi Browser capability", () => {
  it("filters Browser tools from the fallback list when Browser is disabled", () => {
    const disabled = resolvePiRudderMcpToolEntries([], false);
    const enabled = resolvePiRudderMcpToolEntries([], true);

    expect(disabled.map((entry) => entry.name)).not.toContain("rudder_browser_open");
    expect(disabled).toHaveLength(69);
    expect(enabled.map((entry) => entry.name)).toContain("rudder_browser_open");
    expect(enabled).toHaveLength(77);
  });

  it("defensively filters Browser tools from a returned manifest when disabled", () => {
    expect(resolvePiRudderMcpToolEntries([
      { name: "rudder_issue_get" },
      { name: "rudder_browser_open" },
    ], false)).toEqual([
      { name: "rudder_issue_get" },
    ]);
  });

  it("rejects non-canonical whitespace names instead of registering a residual Browser tool", () => {
    expect(resolvePiRudderMcpToolEntries([
      { name: "rudder_agent_me" },
      { name: " rudder_browser_open " },
      { name: "rudder_browser_read" },
    ], false)).toEqual([
      { name: "rudder_agent_me" },
    ]);
  });
});
