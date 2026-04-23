import { describe, expect, it } from "vitest";
import { formatSidebarAgentLabel } from "../lib/agent-labels";

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
