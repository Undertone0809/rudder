// @vitest-environment node

import { describe, expect, it } from "vitest";
import { translateMessage } from "./I18nContext";
import { translateLegacyString } from "@/i18n/legacyPhrases";

describe("translateMessage", () => {
  it("returns localized copy for zh-CN", () => {
    expect(translateMessage("zh-CN", "common.systemSettings")).toBe("系统设置");
  });

  it("interpolates dynamic values", () => {
    expect(translateMessage("en", "app.addAnotherAgentToOrganization", { name: "Acme" })).toBe(
      "Add another agent to Acme",
    );
  });

  it("builds the organization skill chat prompt in English", () => {
    expect(
      translateMessage("en", "organizationSkills.createSkillChatPrompt", {
        officeHoursPath: "/tmp/office-hours/SKILL.md",
      }),
    ).toContain("Use [$office-hours](/tmp/office-hours/SKILL.md) as the bar for structure and rigor.");
  });

  it("builds the organization skill chat prompt in zh-CN", () => {
    expect(
      translateMessage("zh-CN", "organizationSkills.createSkillChatPrompt", {
        officeHoursPath: "/tmp/office-hours/SKILL.md",
      }),
    ).toContain("参考 [$office-hours](/tmp/office-hours/SKILL.md) 的结构和严谨度。");
  });

  it("interpolates the organization not found description", () => {
    expect(translateMessage("en", "notFound.description.organization", { prefix: "RUD" })).toBe(
      'No organization matches prefix "RUD".',
    );
  });

  it("builds the localized OpenClaw invite prompt shell", () => {
    expect(
      translateMessage("en", "organizationSettings.invites.prompt.body", {
        candidateList: "- https://example.test",
        connectivityBlock: "Connectivity block",
        resolutionLine: "",
      }),
    ).toContain("You're invited to join a Rudder organization.");
  });

  it("translates legacy hard-coded strings for zh-CN", () => {
    expect(translateLegacyString("zh-CN", "Filters")).toBe("筛选");
    expect(translateLegacyString("zh-CN", "These preferences apply across the board UI.")).toBe(
      "These preferences apply across the 控制台界面.",
    );
    expect(translateLegacyString("zh-CN", "All Agents")).toBe("全部智能体");
    expect(translateLegacyString("zh-CN", "Finished 2d ago")).toBe("2 天前完成");
    expect(translateLegacyString("zh-CN", "1 live")).toBe("1 个运行中");
  });
});
