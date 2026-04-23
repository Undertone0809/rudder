// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstanceExperimentalSettings } from "./InstanceExperimentalSettings";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      autoRestartDevServerWhenIdle: false,
    },
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

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/I18nContext", () => ({
  useI18n: () => ({
    t: (key: string) => {
      const messages: Record<string, string> = {
        "common.systemSettings": "System settings",
        "common.experimental": "Experimental",
        "experimental.title": "Experimental",
        "experimental.description": "Experimental settings",
        "experimental.loadFailed": "Failed to load experimental settings.",
        "experimental.updateFailed": "Failed to update experimental settings.",
        "experimental.developer.title": "Developer ergonomics",
        "experimental.developer.description": "Developer ergonomics description",
        "experimental.developer.autorestart.title": "Auto-restart dev server when idle",
        "experimental.developer.autorestart.description": "Auto-restart description",
        "settings.eyebrow.labs": "Labs",
      };
      return messages[key] ?? key;
    },
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
    root.render(<InstanceExperimentalSettings />);
  });

  return container;
}

describe("InstanceExperimentalSettings", () => {
  it("shows only the dev-server experimental control", async () => {
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Auto-restart dev server when idle");
    expect(container.textContent).not.toContain("Enable isolated workspaces");
    expect(container.textContent).not.toContain("Workspace behavior");
    expect(container.querySelector('[aria-label="Toggle guarded dev-server auto-restart"]')).not.toBeNull();
  });
});
