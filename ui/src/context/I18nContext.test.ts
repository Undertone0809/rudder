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
    expect(translateLegacyString("zh-CN", "Messenger")).toBe("消息");
    expect(translateLegacyString("zh-CN", "Structure")).toBe("组织结构");
    expect(translateLegacyString("zh-CN", "Resources")).toBe("资源");
    expect(
      translateLegacyString("zh-CN", "Top-ups, fees, credits, commitments, and other non-request charges."),
    ).toBe("充值、费用、抵扣、承诺用量，以及其他非请求产生的费用。");
    expect(
      translateLegacyString("zh-CN", "No finance events yet. Add account-level charges once biller invoices or credits land."),
    ).toBe("暂无财务事件。计费方发票或抵扣入账后，可添加账户级费用。");
    expect(translateLegacyString("zh-CN", "in 268.2M · out 362.0k")).toBe("输入 268.2M · 输出 362.0k");
    expect(translateLegacyString("zh-CN", "0 api · 33 subscription")).toBe("0 API · 33 订阅");
    expect(translateLegacyString("zh-CN", "Threads sorted by latest activity")).toBe("话题按最近活动排序");
    expect(translateLegacyString("zh-CN", "Create new chat")).toBe("创建新聊天");
    expect(translateLegacyString("zh-CN", "Issue update")).toBe("任务更新");
    expect(translateLegacyString("zh-CN", "in review")).toBe("评审中");
    expect(translateLegacyString("zh-CN", "Open issue")).toBe("打开任务");
    expect(translateLegacyString("zh-CN", "Quick comment")).toBe("快速评论");
    expect(translateLegacyString("zh-CN", "Issue Tracker")).toBe("任务跟踪");
    expect(translateLegacyString("zh-CN", "Draft Issues (6)")).toBe("草稿任务（6）");
    expect(translateLegacyString("zh-CN", "Following (62)")).toBe("关注中（62）");
    expect(translateLegacyString("zh-CN", "Display")).toBe("显示");
    expect(translateLegacyString("zh-CN", "in review · medium · created by me · assigned to me")).toBe(
      "评审中 · 中 · 我创建的 · 指派给我",
    );
  });
});
