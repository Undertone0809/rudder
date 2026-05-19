// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstanceGeneralSettings } from "./InstanceGeneralSettings";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const navigate = vi.hoisted(() => vi.fn());
const openProductTour = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      censorUsernameInLogs: false,
      showDeveloperDiagnostics: false,
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

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigate,
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ openProductTour }),
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
        "general.language.title": "Language",
        "general.language.description": "Language section",
        "general.language.label": "Board language",
        "general.language.option.en.label": "English",
        "general.language.option.en.description": "Default product language",
        "general.language.option.zh-CN.label": "简体中文",
        "general.language.option.zh-CN.description": "Simplified Chinese",
        "general.language.preview.en.primary": "Hello",
        "general.language.preview.en.secondary": "Board UI",
        "general.language.preview.zh-CN.primary": "你好",
        "general.language.preview.zh-CN.secondary": "控制台界面",
        "general.basics.title": "Basics",
        "general.productTour.title": "Workspace tour",
        "general.productTour.description": "Replay the guided tour.",
        "general.productTour.start": "Start tour",
        "general.logs.title": "Operator logs",
        "general.logs.description": "Logs section",
        "general.logs.censor.title": "Censor username in logs",
        "general.logs.censor.description": "Censor description",
        "general.updates.title": "Desktop app",
        "general.updates.description": "Update channel section",
        "general.updates.loadFailed": "Failed to load desktop update settings.",
        "general.updates.updateFailed": "Failed to update desktop update settings.",
        "general.updates.unavailable": "Desktop update settings are unavailable.",
        "general.updates.canary.title": "Receive early desktop updates",
        "general.updates.canary.disabledDescription": "Stable update channel selected",
        "general.updates.canary.enabledDescription": "Early update channel selected",
        "general.diagnostics.developer.title": "Show developer diagnostics",
        "general.diagnostics.developer.description": "Developer diagnostics description",
        "general.developer.title": "Developer",
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
  delete (window as typeof window & { desktopShell?: unknown }).desktopShell;
  navigate.mockReset();
  openProductTour.mockReset();
  vi.clearAllTimers();
  vi.useRealTimers();
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
  it("groups common controls and starts the product tour from general settings", async () => {
    vi.useFakeTimers();
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Basics");
    expect(container.textContent).toContain("Workspace tour");
    expect(container.textContent).toContain("Replay the guided tour.");

    const startButton = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Start tour"));
    expect(startButton).toBeTruthy();

    act(() => {
      startButton!.click();
    });

    expect(navigate).toHaveBeenCalledWith("/dashboard");
    expect(openProductTour).not.toHaveBeenCalled();

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(openProductTour).toHaveBeenCalledWith({ source: "settings" });
  });

  it("renders language as a single settings item", async () => {
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Language");
    expect(container.textContent).not.toContain("Board language");
    expect(container.textContent).not.toContain("Language section");
  });


  it("renders appearance as a single color mode item", async () => {
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Color mode");
    expect(container.textContent).not.toContain("Appearance");
    expect(container.textContent).not.toContain("Appearance section");
    expect(container.textContent).not.toContain("Theme behavior");
    expect(container.textContent).not.toContain("Theme changes are stored locally in your browser.");
  });

  it("renders the desktop update channel control when desktop support is available", async () => {
    (window as typeof window & { desktopShell?: unknown }).desktopShell = {
      getUpdateChannel: vi.fn(async () => "canary"),
      setUpdateChannel: vi.fn(async () => "stable"),
    };

    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Receive early desktop updates");
    expect(container.textContent).toContain("Early update channel selected");
    expect(container.textContent).toContain("Desktop app");
    expect(container.textContent).not.toContain("Update channel section");
  });

  it("hides desktop update channel control when the desktop bridge rejects the read", async () => {
    (window as typeof window & { desktopShell?: unknown }).desktopShell = {
      getUpdateChannel: vi.fn(async () => {
        throw new Error("No handler registered for 'desktop:get-update-channel'");
      }),
      setUpdateChannel: vi.fn(async () => "canary"),
    };

    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("Receive early desktop updates");
    expect(container.textContent).not.toContain("No handler registered");
    expect(container.textContent).not.toContain("Failed to load desktop update settings.");
  });

  it("renders developer diagnostics as a compact general setting", async () => {
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Developer");
    expect(container.textContent).toContain("Censor username in logs");
    expect(container.textContent).toContain("Show developer diagnostics");
    expect(container.textContent).toContain("Developer diagnostics description");
  });
});
