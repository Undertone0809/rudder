// @vitest-environment node

import { TooltipProvider } from "@/components/ui/tooltip";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstanceShortcutsSettings } from "./InstanceShortcutsSettings";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: { shortcuts: [] },
    isLoading: false,
    error: null,
  }),
  useMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: {
    getShortcuts: vi.fn(),
    updateShortcuts: vi.fn(),
  },
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({
    t: (key: string) => {
      const messages: Record<string, string> = {
        "common.systemSettings": "System settings",
        "common.shortcuts": "Shortcuts",
      };
      return messages[key] ?? key;
    },
  }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

function renderPage() {
  return renderToStaticMarkup(
    <TooltipProvider>
      <InstanceShortcutsSettings />
    </TooltipProvider>,
  );
}

describe("InstanceShortcutsSettings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the Escape system shortcut as read-only without entering capture mode", () => {
    const html = renderPage();

    expect(html).toContain("Navigate back / close detail");
    expect(html).toContain("Read-only");
    expect(html).not.toContain("Press a shortcut. Escape cancels capture.");
  });

  it("renders shortcuts as a command and keybinding table", () => {
    const html = renderPage();

    expect(html).toContain("Search shortcuts");
    expect(html).toContain("Command");
    expect(html).toContain("Keybinding");
    expect(html).toContain("Open command palette");
  });

  it("shows only the current platform default keybinding variant", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    const macHtml = renderPage();
    expect(macHtml).toContain("Cmd+K");
    expect(macHtml).not.toContain("Ctrl+K");

    vi.stubGlobal("navigator", { platform: "Win32" });
    const windowsHtml = renderPage();
    expect(windowsHtml).toContain("Ctrl+K");
    expect(windowsHtml).not.toContain("Cmd+K");
    expect(windowsHtml).not.toContain("Meta+K");
  });
});
