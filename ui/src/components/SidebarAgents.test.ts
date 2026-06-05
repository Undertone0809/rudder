import { describe, expect, it } from "vitest";
import { formatSidebarAgentLabel } from "../lib/agent-labels";
import { sidebarAgentStatusTag } from "../lib/agent-sidebar-status";

describe("formatSidebarAgentLabel", () => {
  it("falls back to the role label when no custom title is set", () => {
    expect(
      formatSidebarAgentLabel({
        name: "Nia",
        role: "ceo",
        title: null,
      }),
    ).toBe("Nia (CEO)");
  });

  it("prefers the custom title when one is set", () => {
    expect(
      formatSidebarAgentLabel({
        name: "Rosalie",
        role: "engineer",
        title: "Founding Engineer",
      }),
    ).toBe("Rosalie (Founding Engineer)");
  });
});

describe("sidebarAgentStatusTag", () => {
  it("returns a paused tag for paused agents", () => {
    expect(sidebarAgentStatusTag({ status: "paused" })).toBe("paused");
  });

  it("does not tag active or running agents", () => {
    expect(sidebarAgentStatusTag({ status: "active" })).toBeNull();
    expect(sidebarAgentStatusTag({ status: "running" })).toBeNull();
  });
});
