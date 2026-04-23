import { describe, expect, it } from "vitest";
import { isMarkdownSkillPath, parseSkillReference, removeSkillReferenceFromMarkdown } from "./skill-reference";

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
      label: "rudder/build-advisor",
    });

    expect(
      parseSkillReference(
        "/workspace/.agents/skills/build-advisor/SKILL.md",
        "rudder/build-advisor",
      ),
    ).toEqual({
      href: "/workspace/.agents/skills/build-advisor/SKILL.md",
      label: "rudder/build-advisor",
    });

    expect(
      parseSkillReference(
        "/workspace/docs/guide.md",
        "rudder/build-advisor",
      ),
    ).toBeNull();
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
        "rudder/build-advisor",
      ),
    ).toBe("Use this");
  });
});
