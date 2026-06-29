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
        "general.appearance.defaultStyle.label": "Default",
        "general.appearance.defaultStyle.description": "Rudder low-glare surfaces",
        "general.appearance.mira.label": "Mira",
        "general.appearance.mira.description": "Compact cards and controls",
        "general.appearance.luma.label": "Luma",
        "general.appearance.luma.description": "Soft spacious controls",
        "general.appearance.baseColor": "Base color",
        "general.appearance.neutralBase.label": "Neutral",
        "general.appearance.neutralBase.description": "Balanced gray surfaces",
        "general.appearance.oliveBase.label": "Olive",
        "general.appearance.oliveBase.description": "Muted olive surfaces",
        "general.appearance.themeColor": "Theme",
        "general.appearance.neutralTheme.label": "Neutral",
        "general.appearance.neutralTheme.description": "Monochrome actions",
        "general.appearance.emeraldTheme.label": "Emerald",
        "general.appearance.emeraldTheme.description": "Green action color",
      };
      return messages[key] ?? key;
    },
  }),
}));

vi.mock("../context/ThemeContext", () => ({
  useTheme: () => ({
    theme: "system",
    designStyle: "default",
    baseColor: "neutral",
    accentTheme: "neutral",
    setTheme,
    setDesignStyle,
    setBaseColor,
    setAccentTheme,
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
    expect(container.textContent).toContain("Default");
    expect(container.textContent).toContain("Mira");
    expect(container.textContent).toContain("Luma");
    expect(Array.from(container.querySelectorAll("button[aria-pressed='true']")).some((button) => (
      button.textContent?.includes("Default")
    ))).toBe(true);

    const buttons = Array.from(container.querySelectorAll("button"));
    const miraButton = buttons.find((button) => button.textContent?.includes("Mira"));
    const lumaButton = buttons.find((button) => button.textContent?.includes("Luma"));
    expect(miraButton).toBeDefined();
    expect(lumaButton).toBeDefined();

    act(() => {
      miraButton?.click();
      lumaButton?.click();
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
    expect(container.textContent).toContain("Theme");
    expect(container.textContent).toContain("Green action color");
    expect(Array.from(container.querySelectorAll("button[aria-pressed='true']")).some((button) => (
      button.textContent?.includes("Neutral")
    ))).toBe(true);

    const buttons = Array.from(container.querySelectorAll("button"));
    const oliveButton = buttons.find((button) => button.textContent?.includes("Olive"));
    const emeraldButton = buttons.find((button) => button.textContent?.includes("Emerald"));
    expect(oliveButton).toBeDefined();
    expect(emeraldButton).toBeDefined();

    act(() => {
      oliveButton?.click();
      emeraldButton?.click();
    });

    expect(setBaseColor).toHaveBeenCalledWith("olive");
    expect(setAccentTheme).toHaveBeenCalledWith("emerald");
  });
});
