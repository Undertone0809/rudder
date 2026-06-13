// @vitest-environment node

import { describe, expect, it } from "vitest";
import { translateMessage } from "./I18nContext";
import { translateLegacyString } from "@/i18n/legacyPhrases";
import { libraryCopy } from "@/lib/library-copy";

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
    expect(translateLegacyString("zh-CN", "Library UI Proof")).toBe("Library UI Proof");
    expect(translateLegacyString("zh-CN", "Attach from Library")).toBe("Attach from Library");
    expect(translateLegacyString("zh-CN", "No Library files available.")).toBe("No Library files available.");
    expect(translateLegacyString("zh-CN", "Edit in Library")).toBe("Edit in Library");
    expect(translateLegacyString("zh-CN", "Import or scan skills into Library first, then enable them here.")).toBe(
      "Import or scan skills into Library first, then enable them here.",
    );
    expect(translateLegacyString("zh-CN", "Agent-private skills belong to this agent only. Edit them in Library, then enable them here when you want Rudder to load them.")).toBe(
      "Agent-private skills belong to this agent only. Edit them in Library, then enable them here when you want Rudder to load them.",
    );
    expect(translateLegacyString("zh-CN", "Bundled Rudder skills are locked on. Community presets and other organization skills stay optional; Library-backed skills can be edited from Library.")).toBe(
      "Bundled Rudder skills are locked on. Community presets and other organization skills stay optional; Library-backed skills can be edited from Library.",
    );
    expect(libraryCopy("attachFromLibrary", "zh-CN")).toBe("从文档添加");
    expect(libraryCopy("noLibraryFiles", "zh-CN")).toBe("暂无文档文件。");
    expect(libraryCopy("editInLibrary", "zh-CN")).toBe("在文档中编辑");
    expect(libraryCopy("importSkillsIntoLibraryFirst", "zh-CN")).toBe("请先将技能导入或扫描到文档中，然后在这里启用。");
    expect(libraryCopy("agentPrivateSkillsHelp", "zh-CN")).toBe(
      "智能体私有技能只属于当前智能体。先在文档中编辑，需要 Rudder 加载时再在这里启用。",
    );
    expect(libraryCopy("organizationSkillsHelp", "zh-CN")).toBe(
      "内置 Rudder 技能固定开启。社区预设和其他组织技能保持可选；由文档库支持的技能可在文档中编辑。",
    );
    expect(translateLegacyString("zh-CN", "Choose file")).toBe("选择文件");
    expect(translateLegacyString("zh-CN", "No file chosen")).toBe("未选择文件");
    expect(translateLegacyString("zh-CN", "Heartbeat on interval")).toBe("按间隔心跳");
    expect(translateLegacyString("zh-CN", "Run heartbeat every 3600 sec")).toBe("每隔 3600 秒运行心跳");
    expect(translateLegacyString("zh-CN", "Monthly UTC budget")).toBe("UTC 月度预算");
    expect(translateLegacyString("zh-CN", "0% of limit")).toBe("已用上限的 0%");
    expect(translateLegacyString("zh-CN", "Soft alert at 80%")).toBe("80% 时软提醒");
    expect(translateLegacyString("zh-CN", "Design tokens")).toBe("Design tokens");
    expect(translateLegacyString("zh-CN", "Next: Library migration")).toBe("Next: Library migration");
    expect(translateLegacyString("zh-CN", "Codex (local)")).toBe("Codex (local)");
    expect(translateLegacyString("zh-CN", "Replacing existing Rudder Desktop if needed...")).toBe(
      "如有需要，正在替换现有 Rudder Desktop...",
    );
  });
});
