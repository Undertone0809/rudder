import { describe, expect, it } from "vitest";
import {
  buildAgentSkillReferenceHref,
  buildLocalSkillReferenceHref,
  buildOrganizationSkillReferenceHref,
  isMarkdownSkillPath,
  parseSkillReference,
  removeSkillReferenceFromMarkdown,
} from "./skill-reference";

describe("skill-reference", () => {
  it("recognizes skill markdown targets", () => {
    expect(isMarkdownSkillPath("/workspace/.agents/skills/build-advisor/SKILL.md")).toBe(true);
    expect(isMarkdownSkillPath("https://github.com/acme/repo/blob/main/skills/design/SKILL.md")).toBe(true);
    expect(isMarkdownSkillPath("/workspace/docs/guide.md")).toBe(true);
    expect(isMarkdownSkillPath("/workspace/skills/build-advisor")).toBe(false);
    expect(isMarkdownSkillPath("")).toBe(false);
  });

  it("parses both legacy dollar-prefixed refs and canonical skill refs", () => {
    expect(
      parseSkillReference(
        "/workspace/.agents/skills/build-advisor/SKILL.md",
        "$rudder/build-advisor",
      ),
    ).toEqual({
      href: "/workspace/.agents/skills/build-advisor/SKILL.md",
      label: "build-advisor",
    });

    expect(
      parseSkillReference(
        "/workspace/.agents/skills/build-advisor/SKILL.md",
        "rudder/build-advisor",
      ),
    ).toEqual({
      href: "/workspace/.agents/skills/build-advisor/SKILL.md",
      label: "build-advisor",
    });

    expect(
      parseSkillReference(
        "/workspace/.agents/skills/build-advisor/SKILL.md",
        "build-advisor",
      ),
    ).toEqual({
      href: "/workspace/.agents/skills/build-advisor/SKILL.md",
      label: "build-advisor",
    });

    expect(
      parseSkillReference(
        "/workspace/docs/guide.md",
        "rudder/build-advisor",
      ),
    ).toBeNull();
  });

  it("builds and parses skill protocol references without relying on markdown labels", () => {
    expect(buildOrganizationSkillReferenceHref("skill-123", "build-advisor")).toBe("skill://org/skill-123?ref=build-advisor");
    expect(buildAgentSkillReferenceHref("agent-1", "agent:helper", "helper")).toBe("skill://agent/agent-1/agent%3Ahelper?ref=helper");
    expect(buildLocalSkillReferenceHref("/workspace/.agents/skills/local-helper/SKILL.md", "local-helper")).toBe(
      "skill://local/%2Fworkspace%2F.agents%2Fskills%2Flocal-helper?ref=local-helper",
    );

    expect(parseSkillReference("skill://org/skill-123?ref=build-advisor", "")).toEqual({
      href: "skill://org/skill-123?ref=build-advisor",
      label: "build-advisor",
    });
    expect(parseSkillReference("skill://agent/agent-1/agent%3Ahelper?ref=agent-helper", "Old Helper")).toEqual({
      href: "skill://agent/agent-1/agent%3Ahelper?ref=agent-helper",
      label: "agent-helper",
    });
  });

  it("removes a skill reference as a whole markdown token", () => {
    expect(
      removeSkillReferenceFromMarkdown(
        "Use this\n\n[$rudder/build-advisor](/workspace/.agents/skills/build-advisor/SKILL.md)",
        "rudder/build-advisor",
      ),
    ).toBe("Use this");

    expect(
      removeSkillReferenceFromMarkdown(
        [
          "Use these",
          "",
          "[$rudder/build-advisor](/workspace/.agents/skills/build-advisor/SKILL.md)",
          "[rudder/release](/workspace/.agents/skills/release/SKILL.md)",
        ].join("\n"),
        "rudder/build-advisor",
      ),
    ).toBe(
      [
        "Use these",
        "",
        "[rudder/release](/workspace/.agents/skills/release/SKILL.md)",
      ].join("\n"),
    );

    expect(
      removeSkillReferenceFromMarkdown(
        "Use this\n\n[rudder/build-advisor](/workspace/.agents/skills/build-advisor/SKILL.md)\u00A0",
        "build-advisor",
      ),
    ).toBe("Use this");

    expect(
      removeSkillReferenceFromMarkdown(
        "Use this\n\n[build-advisor](skill://org/skill-123?ref=build-advisor)\u00A0",
        "build-advisor",
      ),
    ).toBe("Use this");
  });
});
