// @vitest-environment jsdom

import type { DesktopReleaseNotesResult, DesktopShellApi } from "@/lib/desktop-shell";
import { RUDDER_DOCS_URL, RUDDER_ZH_RELEASES_URL } from "@/lib/product-links";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopReleaseNotesDialog } from "./DesktopReleaseNotesDialog";

const i18n = vi.hoisted(() => {
  let locale: "en" | "zh-CN" = "en";
  const copy = {
    "desktopReleaseNotes.defaultTitle": "What's new in Rudder",
    "desktopReleaseNotes.description": "Updates installed with this version.",
    "desktopReleaseNotes.docs": "Docs",
    "desktopReleaseNotes.continue": "Continue",
  };
  const chineseCopy = {
    "desktopReleaseNotes.defaultTitle": "Rudder 的新变化",
    "desktopReleaseNotes.description": "此版本包含的更新。",
    "desktopReleaseNotes.docs": "文档",
    "desktopReleaseNotes.continue": "继续",
  };

  return {
    setLocale(nextLocale: "en" | "zh-CN") {
      locale = nextLocale;
    },
    useI18n: () => ({
      locale,
      t: (key: keyof typeof copy) => (locale === "zh-CN" ? chineseCopy[key] : copy[key]) ?? key,
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

  it("uses the shipped Chinese release note content when the UI is Chinese", async () => {
    i18n.setLocale("zh-CN");
    const harness = renderHarness({
      status: "available",
      notes: {
        version: "0.7.23",
        title: "What's new in Rudder 0.7.23",
        sections: [{ title: "Improved", items: ["Improved one thing."] }],
        translations: {
          "zh-CN": {
            version: "0.7.23",
            title: "Rudder 0.7.23 更新内容",
            sections: [{ title: "改进", items: ["改进了一项功能。"] }],
          },
        },
      },
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("Rudder 0.7.23 更新内容");
    expect(document.body.textContent).toContain("改进了一项功能。");
    expect(document.body.textContent).toContain("此版本包含的更新。");
    expect(document.body.textContent).toContain("文档");
    expect(document.body.textContent).toContain("继续");
    expect(document.body.textContent).not.toContain("What's new in Rudder 0.7.23");
    expect(document.body.textContent).not.toContain("Improved one thing.");

    const docsAction = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "文档");
    await act(async () => {
      docsAction?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(harness.openExternal).toHaveBeenCalledWith(RUDDER_ZH_RELEASES_URL);
    expect(harness.markReleaseNotesShown).not.toHaveBeenCalled();

    const action = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "继续");
    await act(async () => {
      action?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(harness.markReleaseNotesShown).toHaveBeenCalledWith("0.7.23");
  });

  it("falls back to English release content when an older release has no translation", async () => {
    i18n.setLocale("zh-CN");
    renderHarness({
      status: "available",
      notes: {
        version: "0.4.0",
        title: "What's new in Rudder 0.4.0",
        sections: [{ title: "New Features", items: ["Added one thing."] }],
      },
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("What's new in Rudder 0.4.0");
    expect(document.body.textContent).toContain("Added one thing.");
    expect(document.body.textContent).toContain("此版本包含的更新。");
  });
});
