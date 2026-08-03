// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceExperimentalSettings } from "./InstanceExperimentalSettings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  getGeneral: vi.fn(),
  updateGeneral: vi.fn(),
  setBreadcrumbs: vi.fn(),
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: {
    getGeneral: mocks.getGeneral,
    updateGeneral: mocks.updateGeneral,
  },
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mocks.setBreadcrumbs }),
}));

vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({
    t: (key: string) => ({
      "common.systemSettings": "System settings",
      "common.experimental": "Experimental",
      "experimental.title": "Experimental",
      "experimental.description": "Try early Rudder features.",
      "experimental.sites.section": "Apps",
      "experimental.sites.title": "Enable Apps",
      "experimental.sites.enabledDescription": "Apps are enabled.",
      "experimental.sites.disabledDescription": "Apps are disabled.",
      "experimental.sites.toggle": "Enable Apps",
      "experimental.sites.notice": "Runs Apps on this device.",
      "experimental.loadFailed": "Load failed.",
      "experimental.updateFailed": "Update failed.",
    })[key] ?? key,
  }),
}));

let cleanup: (() => void) | null = null;

async function renderPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <InstanceExperimentalSettings />
      </QueryClientProvider>,
    );
  });
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  return container;
}

beforeEach(() => {
  mocks.getGeneral.mockResolvedValue({
    censorUsernameInLogs: false,
    showDeveloperDiagnostics: false,
    experimentalSitesEnabled: false,
    locale: "en",
  });
  mocks.updateGeneral.mockResolvedValue({
    censorUsernameInLogs: false,
    showDeveloperDiagnostics: false,
    experimentalSitesEnabled: true,
    locale: "en",
  });
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.clearAllMocks();
  document.body.replaceChildren();
  delete (window as typeof window & { desktopShell?: unknown }).desktopShell;
});

describe("InstanceExperimentalSettings", () => {
  it("enables Sites from the dedicated experimental setting", async () => {
    const container = await renderPage();
    await act(async () => {
      await vi.waitFor(() => {
        expect(container.querySelector('[data-testid="experimental-sites-toggle"]'))
          .not.toBeNull();
      });
      container
        .querySelector<HTMLButtonElement>('[data-testid="experimental-sites-toggle"]')
        ?.click();
      await vi.waitFor(() => {
        expect(mocks.updateGeneral).toHaveBeenCalledWith({
          experimentalSitesEnabled: true,
        });
      });
    });

    expect(container.textContent).toContain("Enable Apps");
    expect(mocks.setBreadcrumbs).toHaveBeenCalled();
  });

  it("stops running Apps before disabling Sites", async () => {
    mocks.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
      showDeveloperDiagnostics: false,
      experimentalSitesEnabled: true,
      locale: "en",
    });
    const stop = vi.fn().mockResolvedValue({ status: "stopped" });
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: {
        localApps: {
          supported: true,
          list: vi.fn().mockResolvedValue([{ id: "app-a" }]),
          status: vi.fn().mockResolvedValue({ status: "running" }),
          stop,
        },
      },
    });
    const container = await renderPage();

    await act(async () => {
      await vi.waitFor(() => {
        expect(container.querySelector('[data-testid="experimental-sites-toggle"]'))
          .not.toBeNull();
      });
      container
        .querySelector<HTMLButtonElement>('[data-testid="experimental-sites-toggle"]')
        ?.click();
      await vi.waitFor(() => {
        expect(stop).toHaveBeenCalledWith("app-a");
      });
    });

    expect(mocks.updateGeneral).toHaveBeenCalledWith({
      experimentalSitesEnabled: false,
    });
  });
});
