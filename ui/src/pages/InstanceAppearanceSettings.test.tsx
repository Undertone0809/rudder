// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstanceAppearanceSettings } from "./InstanceAppearanceSettings";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const setBreadcrumbs = vi.hoisted(() => vi.fn());
const setTheme = vi.hoisted(() => vi.fn());
const setDesignStyle = vi.hoisted(() => vi.fn());
const setBaseColor = vi.hoisted(() => vi.fn());
const setAccentTheme = vi.hoisted(() => vi.fn());
const setShowToolCallFailureIndicators = vi.hoisted(() => vi.fn());

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs }),
}));

vi.mock("../context/I18nContext", () => ({
  useI18n: () => ({
    t: (key: string) => {
      const messages: Record<string, string> = {
        "common.systemSettings": "System settings",
        "general.appearance.title": "Appearance",
        "general.appearance.description": "Appearance section",
        "general.appearance.colorMode": "Color mode",
        "general.appearance.light.label": "Light",
        "general.appearance.light.description": "Warm paper surfaces",
        "general.appearance.system.label": "Auto",
        "general.appearance.system.description": "Follow system appearance",
        "general.appearance.dark.label": "Dark",
        "general.appearance.dark.description": "Low-glare workspace",
        "general.appearance.designStyle": "Design style",
        "general.appearance.defaultStyle.label": "Classic",
        "general.appearance.defaultStyle.description": "Balanced low-glare surfaces",
        "general.appearance.mira.label": "Compact",
        "general.appearance.mira.description": "Compact cards and controls",
        "general.appearance.luma.label": "Rudder",
        "general.appearance.luma.description": "Soft spacious controls",
        "general.appearance.baseColor": "Base color",
        "general.appearance.base.neutral.label": "Neutral",
        "general.appearance.base.neutral.description": "Balanced gray surfaces",
        "general.appearance.base.stone.label": "Stone",
        "general.appearance.base.stone.description": "Warm mineral surfaces",
        "general.appearance.base.zinc.label": "Zinc",
        "general.appearance.base.zinc.description": "Cool gray surfaces",
        "general.appearance.base.mauve.label": "Mauve",
        "general.appearance.base.mauve.description": "Muted rose-gray surfaces",
        "general.appearance.base.olive.label": "Olive",
        "general.appearance.base.olive.description": "Muted olive surfaces",
        "general.appearance.base.mist.label": "Mist",
        "general.appearance.base.mist.description": "Soft blue-gray surfaces",
        "general.appearance.base.taupe.label": "Taupe",
        "general.appearance.base.taupe.description": "Warm taupe surfaces",
        "general.appearance.themeColor": "Theme",
        "general.appearance.theme.neutral.label": "Neutral",
        "general.appearance.theme.neutral.description": "Monochrome actions",
        "general.appearance.theme.amber.label": "Amber",
        "general.appearance.theme.amber.description": "Amber action color",
        "general.appearance.theme.blue.label": "Blue",
        "general.appearance.theme.blue.description": "Blue action color",
        "general.appearance.theme.cyan.label": "Cyan",
        "general.appearance.theme.cyan.description": "Cyan action color",
        "general.appearance.theme.emerald.label": "Rudder",
        "general.appearance.theme.emerald.description": "Rudder green action color",
        "general.appearance.theme.fuchsia.label": "Fuchsia",
        "general.appearance.theme.fuchsia.description": "Fuchsia action color",
        "general.appearance.theme.green.label": "Green",
        "general.appearance.theme.green.description": "Green action color",
        "general.appearance.theme.indigo.label": "Indigo",
        "general.appearance.theme.indigo.description": "Indigo action color",
        "general.appearance.theme.lime.label": "Lime",
        "general.appearance.theme.lime.description": "Lime action color",
        "general.appearance.theme.orange.label": "Orange",
        "general.appearance.theme.orange.description": "Orange action color",
        "general.appearance.theme.pink.label": "Pink",
        "general.appearance.theme.pink.description": "Pink action color",
        "general.appearance.toolCalls.title": "Tool calls",
        "general.appearance.toolCalls.failureIndicators.label": "Show failure indicators",
        "general.appearance.toolCalls.failureIndicators.description": "Use red styling and a failure label when a tool call fails.",
        "general.appearance.toolCalls.failureIndicators.ariaLabel": "Toggle tool call failure indicators",
      };
      return messages[key] ?? key;
    },
  }),
}));

vi.mock("../context/ThemeContext", () => ({
  useTheme: () => ({
    theme: "system",
    designStyle: "luma",
    baseColor: "neutral",
    accentTheme: "emerald",
    showToolCallFailureIndicators: false,
    setTheme,
    setDesignStyle,
    setBaseColor,
    setAccentTheme,
    setShowToolCallFailureIndicators,
  }),
}));

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  setBreadcrumbs.mockReset();
  setTheme.mockReset();
  setDesignStyle.mockReset();
  setBaseColor.mockReset();
  setAccentTheme.mockReset();
  setShowToolCallFailureIndicators.mockReset();
});

function renderPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  cleanupFn = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };

  act(() => {
    root.render(<InstanceAppearanceSettings />);
  });

  return container;
}

describe("InstanceAppearanceSettings", () => {
  it("renders color mode as the appearance setting", async () => {
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(setBreadcrumbs).toHaveBeenCalledWith([
      { label: "System settings" },
      { label: "Appearance" },
    ]);
    expect(container.textContent).toContain("Appearance");
    expect(container.textContent).toContain("Appearance section");
    expect(container.textContent).toContain("Color mode");
    expect(container.textContent).toContain("Light");
    expect(container.textContent).toContain("Auto");
    expect(container.textContent).toContain("Dark");
    expect(container.querySelector("button[aria-pressed='true']")?.textContent).toContain("Auto");
  });

  it("renders design style choices and updates the selected style", async () => {
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Design style");
    expect(container.textContent).toContain("Rudder");
    expect(container.textContent).toContain("Classic");
    expect(container.textContent).toContain("Compact");
    expect(container.textContent).not.toContain("Luma");
    expect(container.textContent).not.toContain("Mira");
    expect(Array.from(container.querySelectorAll("button[aria-pressed='true']")).some((button) => (
      button.textContent?.includes("Rudder")
    ))).toBe(true);

    const sections = Array.from(container.querySelectorAll("section[data-slot='settings-section']"));
    const designSection = sections.find((section) => section.querySelector("h2")?.textContent === "Design style");
    const designButtons = Array.from(
      designSection?.querySelectorAll<HTMLButtonElement>("button[data-slot='settings-choice-card']") ?? [],
    );
    expect(designButtons.map((button) => button.textContent)).toEqual([
      expect.stringContaining("Rudder"),
      expect.stringContaining("Classic"),
      expect.stringContaining("Compact"),
    ]);

    act(() => {
      designButtons[2]?.click();
      designButtons[0]?.click();
    });

    expect(setDesignStyle).toHaveBeenCalledWith("mira");
    expect(setDesignStyle).toHaveBeenCalledWith("luma");
  });

  it("renders base color and theme choices independently", async () => {
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Base color");
    expect(container.textContent).toContain("Muted olive surfaces");
    expect(container.textContent).toContain("Warm taupe surfaces");
    expect(container.textContent).toContain("Theme");
    expect(container.textContent).toContain("Rudder green action color");
    expect(container.textContent).toContain("Pink action color");
    expect(Array.from(container.querySelectorAll("button[aria-pressed='true']")).some((button) => (
      button.textContent?.includes("Rudder green action color")
    ))).toBe(true);

    const buttons = Array.from(container.querySelectorAll("button"));
    const oliveButton = buttons.find((button) => button.textContent?.includes("Olive"));
    const emeraldButton = buttons.find((button) => button.textContent?.includes("Rudder green action color"));
    const taupeButton = buttons.find((button) => button.textContent?.includes("Taupe"));
    const pinkButton = buttons.find((button) => button.textContent?.includes("Pink"));
    expect(oliveButton).toBeDefined();
    expect(emeraldButton).toBeDefined();
    expect(taupeButton).toBeDefined();
    expect(pinkButton).toBeDefined();

    const sections = Array.from(container.querySelectorAll("section[data-slot='settings-section']"));
    const themeSection = sections.find((section) => section.querySelector("h2")?.textContent === "Theme");
    const themeButtons = Array.from(themeSection?.querySelectorAll("button[data-slot='settings-choice-card']") ?? []);
    expect(themeButtons[0]?.textContent).toContain("Rudder green action color");

    act(() => {
      oliveButton?.click();
      emeraldButton?.click();
      taupeButton?.click();
      pinkButton?.click();
    });

    expect(setBaseColor).toHaveBeenCalledWith("olive");
    expect(setAccentTheme).toHaveBeenCalledWith("emerald");
    expect(setBaseColor).toHaveBeenCalledWith("taupe");
    expect(setAccentTheme).toHaveBeenCalledWith("pink");
  });

  it("renders tool call failure indicators off by default and enables them directly", () => {
    const container = renderPage();
    const toggle = container.querySelector<HTMLButtonElement>(
      "button[role='switch'][aria-label='Toggle tool call failure indicators']",
    );

    expect(container.textContent).toContain("Tool calls");
    expect(container.textContent).toContain("Show failure indicators");
    expect(toggle?.getAttribute("aria-checked")).toBe("false");

    act(() => {
      toggle?.click();
    });

    expect(setShowToolCallFailureIndicators).toHaveBeenCalledWith(true);
  });
});
