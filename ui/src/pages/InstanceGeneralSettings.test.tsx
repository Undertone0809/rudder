// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstanceGeneralSettings } from "./InstanceGeneralSettings";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      censorUsernameInLogs: false,
      locale: "en",
    },
    isLoading: false,
    error: null,
  }),
  useMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useQueryClient: () => ({
    setQueryData: vi.fn(),
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/I18nContext", () => ({
  useI18n: () => ({
    t: (key: string) => {
      const messages: Record<string, string> = {
        "common.systemSettings": "System settings",
        "common.general": "General",
        "general.title": "General",
        "general.description": "General settings",
        "general.loadFailed": "Failed to load general settings.",
        "general.updateFailed": "Failed to save general settings.",
        "general.language.title": "Board language",
        "general.language.description": "Language section",
        "general.language.label": "Language",
        "general.language.option.en.label": "English",
        "general.language.option.en.description": "Default product language",
        "general.language.option.zh-CN.label": "简体中文",
        "general.language.option.zh-CN.description": "Simplified Chinese",
        "general.language.preview.en.primary": "Hello",
        "general.language.preview.en.secondary": "Board UI",
        "general.language.preview.zh-CN.primary": "你好",
        "general.language.preview.zh-CN.secondary": "控制台界面",
        "general.logs.title": "Operator logs",
        "general.logs.description": "Logs section",
        "general.logs.censor.title": "Censor username in logs",
        "general.logs.censor.description": "Censor description",
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
    setTheme: vi.fn(),
  }),
}));

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
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
    root.render(<InstanceGeneralSettings />);
  });

  return container;
}

describe("InstanceGeneralSettings", () => {
  it("does not render the removed board language helper row", async () => {
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Board language");
    expect(container.textContent).not.toContain("Language help");
  });

  it("does not render the removed theme behavior helper row", async () => {
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Appearance");
    expect(container.textContent).toContain("Color mode");
    expect(container.textContent).not.toContain("Theme behavior");
    expect(container.textContent).not.toContain("Theme changes are stored locally in your browser.");
  });
});
