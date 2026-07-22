import { describe, expect, it } from "vitest";
import { resolvePiRudderMcpToolEntries } from "./execute.js";

describe("Pi Browser capability", () => {
  it("splits core and Browser manifests into separate native bridges", () => {
    const manifest = [
      { name: "rudder_issue_get" },
      { name: "rudder_browser_open" },
      { name: "rudder_browser_close" },
    ];

    expect(resolvePiRudderMcpToolEntries(manifest, "core")).toEqual([
      { name: "rudder_issue_get" },
    ]);
    expect(resolvePiRudderMcpToolEntries(manifest, "browser")).toEqual([
      { name: "rudder_browser_open" },
      { name: "rudder_browser_close" },
    ]);
  });

  it("defensively keeps Browser tools out of the core bridge", () => {
    expect(resolvePiRudderMcpToolEntries([
      { name: "rudder_issue_get" },
      { name: "rudder_browser_open" },
    ], "core")).toEqual([
      { name: "rudder_issue_get" },
    ]);
  });

  it("rejects non-canonical whitespace names instead of registering a residual Browser tool", () => {
    expect(resolvePiRudderMcpToolEntries([
      { name: "rudder_agent_me" },
      { name: " rudder_browser_open " },
      { name: "rudder_browser_read" },
    ], "core")).toEqual([
      { name: "rudder_agent_me" },
    ]);
  });
});
