// @vitest-environment jsdom

import type { DesktopReleaseNotesResult, DesktopShellApi } from "@/lib/desktop-shell";
import { RUDDER_DOCS_URL } from "@/lib/product-links";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopReleaseNotesDialog } from "./DesktopReleaseNotesDialog";

const i18n = vi.hoisted(() => {
  let locale: "en" | "zh-CN" = "en";
  const englishCopy: Record<string, string> = {
    "desktopReleaseNotes.description": "Updates installed with this version.",
    "desktopReleaseNotes.docs": "Docs",
    "desktopReleaseNotes.continue": "Continue",
  };

  return {
    setLocale(nextLocale: "en" | "zh-CN") {
      locale = nextLocale;
    },
    useI18n: () => ({
      locale,
      t: (key: string) => englishCopy[key] ?? key,
    }),
  };
});

vi.mock("@/context/I18nContext", () => ({ useI18n: i18n.useI18n }));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let cleanupFn: (() => void) | null = null;

function renderHarness(result: DesktopReleaseNotesResult) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const markReleaseNotesShown = vi.fn().mockResolvedValue(undefined);
  const openExternal = vi.fn().mockResolvedValue(undefined);

  Object.defineProperty(window, "desktopShell", {
    configurable: true,
    value: {
      getReleaseNotes: vi.fn().mockResolvedValue(result),
      markReleaseNotesShown,
      openExternal,
    } as Partial<DesktopShellApi>,
  });

  act(() => {
    root.render(<DesktopReleaseNotesDialog />);
  });

  cleanupFn = () => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
    delete (window as typeof window & { desktopShell?: unknown }).desktopShell;
  };

  return { markReleaseNotesShown, openExternal };
}

afterEach(() => {
  i18n.setLocale("en");
  cleanupFn?.();
  cleanupFn = null;
});

describe("DesktopReleaseNotesDialog", () => {
  it("shows release notes returned by the desktop shell and marks them read", async () => {
    const harness = renderHarness({
      status: "available",
      notes: {
        version: "0.4.0",
        title: "What's new in Rudder 0.4.0",
        sections: [
          {
            title: "New Features",
            items: ["Moved organization workspaces to Documents."],
          },
        ],
      },
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("What's new in Rudder 0.4.0");
    expect(document.body.textContent).toContain("Moved organization workspaces to Documents.");
    expect(document.body.querySelector('img[alt="Rudder"]')?.getAttribute("src")).toBe("/rudder-logo.png");

    const docsAction = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Docs");
    await act(async () => {
      docsAction?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(harness.openExternal).toHaveBeenCalledWith(RUDDER_DOCS_URL);
    expect(harness.markReleaseNotesShown).not.toHaveBeenCalled();

    const action = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Continue");
    await act(async () => {
      action?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(harness.markReleaseNotesShown).toHaveBeenCalledWith("0.4.0");
    expect(document.body.textContent).not.toContain("What's new in Rudder 0.4.0");
  });

  it("stays hidden when the current version has already been shown", async () => {
    renderHarness({ status: "already-shown" });

    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("localizes the release notes dialog for Chinese UI", async () => {
    i18n.setLocale("zh-CN");
    const harness = renderHarness({
      status: "available",
      notes: {
        version: "0.7.15",
        title: "What's new in Rudder 0.7.15",
        sections: [
          {
            title: "New",
            items: [
              "Added semantic result cards for 40 built-in Rudder MCP tools across Goals, Issues, Projects, approvals, and Automations. Cards link to related records, show summaries and structured receipts, progressively load long result lists, report final outcomes clearly, and keep webhook secrets hidden.",
              "Added annotations for stable transcript items in Run Detail, including the ability to select text and send it as feedback.",
              "Redesigned command details around a focused Shell view with copyable output, replacing the Task and Markdown tabs.",
            ],
          },
          {
            title: "Improved",
            items: [
              "Improved Chat feedback recovery so drafts and annotations survive missing conversations, Project context loading retries after failure, and a send in progress cannot be submitted twice.",
              "Made failed Chat responses actionable by focusing them on Retry and Open run, without stale response content or actions.",
              "Chat drafts are now available before runtime context preparation finishes.",
              "Improved Markdown rendering and editing stability for links, images, and text selection, and kept Issue creation controls usable at constrained widths.",
              "Improved Desktop account continuity: avatars persist across restarts and fall back to initials when an image cannot load.",
            ],
          },
          {
            title: "Fixed",
            items: [
              "Fixed Windows CLI installation and runtime setup failures caused by npm command invocation.",
              "Fixed Desktop release notes disappearing after a renderer reload; they remain available until acknowledged.",
            ],
          },
        ],
      },
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("Rudder 0.7.15 更新内容");
    expect(document.body.textContent).toContain("此版本包含的更新。");
    expect(document.body.textContent).toContain("新增");
    expect(document.body.textContent).toContain("改进");
    expect(document.body.textContent).toContain("修复");
    for (const item of [
      "在 Goals、Issues、Projects、审批和 Automations 中，为 40 个内置 Rudder MCP 工具增加语义化结果卡片。",
      "为 Run Detail 中的稳定 transcript 条目增加批注，支持选择文本并将其作为反馈发送。",
      "围绕聚焦的 Shell 视图重新设计命令详情，支持复制输出，并移除 Task 和 Markdown 标签页。",
      "改进 Chat 反馈恢复：即使对话缺失，草稿和批注也能保留；Project 上下文加载失败后会重试；发送中的消息不能重复提交。",
      "让失败的 Chat 响应可以继续处理：聚焦于“重试”和“打开运行记录”，不再显示过期的响应内容或操作。",
      "现在无需等待运行时上下文准备完成，也可以使用 Chat 草稿。",
      "改进 Markdown 链接、图片和文本选择的渲染与编辑稳定性，并确保在受限宽度下仍可使用 Issue 创建控件。",
      "改进 Desktop 账号连续性：头像会跨重启保留，图片无法加载时会回退为首字母。",
      "修复 npm 命令调用导致的 Windows CLI 安装和运行时设置失败。",
      "修复渲染进程重新加载后 Desktop 发布说明消失的问题；在确认前会继续保留。",
    ]) {
      expect(document.body.textContent).toContain(item);
    }
    expect(document.body.textContent).toContain("文档");
    expect(document.body.textContent).toContain("继续");
    expect(document.body.textContent).not.toContain("What's new in Rudder 0.7.15");
    expect(document.body.textContent).not.toContain("Updates installed with this version.");

    const docsAction = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "文档");
    await act(async () => {
      docsAction?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(harness.openExternal).toHaveBeenCalledWith(RUDDER_DOCS_URL);
    expect(harness.markReleaseNotesShown).not.toHaveBeenCalled();

    const action = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "继续");
    await act(async () => {
      action?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(harness.markReleaseNotesShown).toHaveBeenCalledWith("0.7.15");
    expect(document.body.textContent).not.toContain("Rudder 0.7.15 更新内容");
  });
});
