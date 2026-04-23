import { describe, expect, it } from "vitest";
import {
  agentCompactLabel,
  agentSupportingLabel,
  formatChatAgentLabel,
  formatSidebarAgentLabel,
} from "./agent-labels";

describe("agentSupportingLabel", () => {
  it("prefers the custom title when present", () => {
    expect(
      agentSupportingLabel({
        role: "engineer",
        title: "Founding Engineer",
      }),
    ).toBe("Founding Engineer");
  });

  it("falls back to the role label when no custom title is set", () => {
    expect(
      agentSupportingLabel({
        role: "designer",
        title: "   ",
      }),
    ).toBe("Designer");
  });
});

describe("formatSidebarAgentLabel", () => {
  it("uses the supporting label in the combined agent label", () => {
    expect(
      formatSidebarAgentLabel({
        name: "Nia",
        role: "engineer",
        title: "Founding Engineer",
      }),
    ).toBe("Nia (Founding Engineer)");
  });
});

describe("formatChatAgentLabel", () => {
  it("adds the supporting label when the name and title differ", () => {
    expect(
      formatChatAgentLabel({
        name: "Elias",
        role: "engineer",
        title: "Founding Engineer",
      }),
    ).toBe("Elias (Founding Engineer)");
  });

  it("avoids repeating the same name and title", () => {
    expect(
      formatChatAgentLabel({
        name: "CEO",
        role: "ceo",
        title: null,
      }),
    ).toBe("CEO");
  });
});

describe("agentCompactLabel", () => {
  it("keeps short custom titles for compact UI surfaces", () => {
    expect(
      agentCompactLabel({
        role: "engineer",
        title: "Founding Engineer",
      }),
    ).toBe("Founding Engineer");
  });

  it("falls back to the canonical role label when the custom title is too long", () => {
    expect(
      agentCompactLabel({
        role: "cto",
        title: "Chief Technology Officer",
      }),
    ).toBe("CTO");
  });
});
