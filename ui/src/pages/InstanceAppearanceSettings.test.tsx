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
        "general.appearance.defaultStyle.label": "Rudder",
        "general.appearance.defaultStyle.description": "Rudder low-glare surfaces",
        "general.appearance.mira.label": "Mira",
        "general.appearance.mira.description": "Compact cards and controls",
        "general.appearance.luma.label": "Luma",
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
        "general.appearance.theme.emerald.label": "Emerald",
        "general.appearance.theme.emerald.description": "Jewel green action color",
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
    expect(container.textContent).toContain("Rudder");
    expect(container.textContent).toContain("Mira");
    expect(container.textContent).toContain("Luma");
    expect(Array.from(container.querySelectorAll("button[aria-pressed='true']")).some((button) => (
      button.textContent?.includes("Luma")
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
    expect(container.textContent).toContain("Warm taupe surfaces");
    expect(container.textContent).toContain("Theme");
    expect(container.textContent).toContain("Jewel green action color");
    expect(container.textContent).toContain("Pink action color");
    expect(Array.from(container.querySelectorAll("button[aria-pressed='true']")).some((button) => (
      button.textContent?.includes("Neutral")
    ))).toBe(true);

    const buttons = Array.from(container.querySelectorAll("button"));
    const oliveButton = buttons.find((button) => button.textContent?.includes("Olive"));
    const emeraldButton = buttons.find((button) => button.textContent?.includes("Emerald"));
    const taupeButton = buttons.find((button) => button.textContent?.includes("Taupe"));
    const pinkButton = buttons.find((button) => button.textContent?.includes("Pink"));
    expect(oliveButton).toBeDefined();
    expect(emeraldButton).toBeDefined();
    expect(taupeButton).toBeDefined();
    expect(pinkButton).toBeDefined();

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
});
