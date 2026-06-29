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
      };
      return messages[key] ?? key;
    },
  }),
}));

vi.mock("../context/ThemeContext", () => ({
  useTheme: () => ({
    theme: "system",
    setTheme,
  }),
}));

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  setBreadcrumbs.mockReset();
  setTheme.mockReset();
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
  });
});
