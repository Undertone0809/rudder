import type { DesktopReleaseNotes } from "@/lib/desktop-shell";
import type { InstanceLocale } from "@rudderhq/shared";

export type DesktopReleaseNotesCopy = {
  description: string;
  docs: string;
  continue: string;
  defaultTitle: string;
};

const zhSectionTitles: Record<string, string> = {
  New: "新增",
  "New Features": "新功能",
  Improved: "改进",
  Fixed: "修复",
  "Bug Fixes": "问题修复",
};

const zhReleaseItems: Record<string, Record<string, string>> = {
  "0.7.15": {
    "Added semantic result cards for 40 built-in Rudder MCP tools across Goals, Issues, Projects, approvals, and Automations. Cards link to related records, show summaries and structured receipts, progressively load long result lists, report final outcomes clearly, and keep webhook secrets hidden.":
      "在 Goals、Issues、Projects、审批和 Automations 中，为 40 个内置 Rudder MCP 工具增加语义化结果卡片。卡片会链接到相关记录，展示摘要和结构化回执，渐进式加载较长的结果列表，清晰报告最终结果，并隐藏 webhook 密钥。",
    "Added annotations for stable transcript items in Run Detail, including the ability to select text and send it as feedback.":
      "为 Run Detail 中的稳定 transcript 条目增加批注，支持选择文本并将其作为反馈发送。",
    "Redesigned command details around a focused Shell view with copyable output, replacing the Task and Markdown tabs.":
      "围绕聚焦的 Shell 视图重新设计命令详情，支持复制输出，并移除 Task 和 Markdown 标签页。",
    "Improved Chat feedback recovery so drafts and annotations survive missing conversations, Project context loading retries after failure, and a send in progress cannot be submitted twice.":
      "改进 Chat 反馈恢复：即使对话缺失，草稿和批注也能保留；Project 上下文加载失败后会重试；发送中的消息不能重复提交。",
    "Made failed Chat responses actionable by focusing them on Retry and Open run, without stale response content or actions.":
      "让失败的 Chat 响应可以继续处理：聚焦于“重试”和“打开运行记录”，不再显示过期的响应内容或操作。",
    "Chat drafts are now available before runtime context preparation finishes.":
      "现在无需等待运行时上下文准备完成，也可以使用 Chat 草稿。",
    "Improved Markdown rendering and editing stability for links, images, and text selection, and kept Issue creation controls usable at constrained widths.":
      "改进 Markdown 链接、图片和文本选择的渲染与编辑稳定性，并确保在受限宽度下仍可使用 Issue 创建控件。",
    "Improved Desktop account continuity: avatars persist across restarts and fall back to initials when an image cannot load.":
      "改进 Desktop 账号连续性：头像会跨重启保留，图片无法加载时会回退为首字母。",
    "Fixed Windows CLI installation and runtime setup failures caused by npm command invocation.":
      "修复 npm 命令调用导致的 Windows CLI 安装和运行时设置失败。",
    "Fixed Desktop release notes disappearing after a renderer reload; they remain available until acknowledged.":
      "修复渲染进程重新加载后 Desktop 发布说明消失的问题；在确认前会继续保留。",
  },
};

export function desktopReleaseNotesCopy(locale: InstanceLocale): DesktopReleaseNotesCopy {
  if (locale === "zh-CN") {
    return {
      description: "此版本包含的更新。",
      docs: "文档",
      continue: "继续",
      defaultTitle: "Rudder 更新内容",
    };
  }

  return {
    description: "Updates installed with this version.",
    docs: "Docs",
    continue: "Continue",
    defaultTitle: "What's new in Rudder",
  };
}

export function localizeDesktopReleaseNotes(notes: DesktopReleaseNotes, locale: InstanceLocale): DesktopReleaseNotes {
  if (locale !== "zh-CN") return notes;

  const itemTranslations = zhReleaseItems[notes.version] ?? {};
  return {
    ...notes,
    title: `Rudder ${notes.version} 更新内容`,
    sections: notes.sections.map((section) => ({
      ...section,
      title: zhSectionTitles[section.title] ?? section.title,
      items: section.items.map((item) => itemTranslations[item] ?? item),
    })),
  };
}
