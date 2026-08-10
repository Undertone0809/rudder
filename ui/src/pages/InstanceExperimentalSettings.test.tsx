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
      "experimental.sites.section": "Plugins",
      "experimental.sites.title": "Enable Plugins",
      "experimental.sites.enabledDescription": "Plugins are enabled.",
      "experimental.sites.disabledDescription": "Plugins are disabled.",
      "experimental.sites.toggle": "Enable Plugins",
      "experimental.sites.notice": "Imports are reviewed before installation.",
      "experimental.goals.section": "Goals",
      "experimental.goals.title": "Enable Goals",
      "experimental.goals.enabledDescription": "Goals are shown in the primary navigation.",
      "experimental.goals.disabledDescription": "Turn this on to try the Goal workspace.",
      "experimental.goals.toggle": "Enable Goals",
      "experimental.computerUse.section": "Computer Use",
      "experimental.computerUse.title": "Enable Computer Use",
      "experimental.computerUse.disabledDescription": "Adds native app interaction.",
      "experimental.computerUse.readyDescription": "Computer Use is ready.",
      "experimental.computerUse.permissionDescription": "Permissions are required.",
      "experimental.computerUse.desktopRequired": "Rudder Desktop on macOS is required.",
      "experimental.computerUse.toggle": "Enable Computer Use",
      "experimental.computerUse.requestPermissions": "Grant access",
      "experimental.computerUse.openScreenRecording": "Open Screen Recording settings",
      "experimental.computerUse.permissionFailed": "Permission failed.",
      "experimental.updateFailed": "Update failed.",
      "experimental.loadFailed": "Load failed.",
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
    experimentalGoalsEnabled: false,
    experimentalComputerUseEnabled: false,
    locale: "en",
  });
  mocks.updateGeneral.mockResolvedValue({
    censorUsernameInLogs: false,
    showDeveloperDiagnostics: false,
    experimentalSitesEnabled: true,
    experimentalGoalsEnabled: false,
    experimentalComputerUseEnabled: false,
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
  it("enables Plugins while preserving the Apps compatibility setting", async () => {
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
          experimentalPluginsEnabled: true,
          experimentalSitesEnabled: true,
        });
      });
    });

    expect(container.textContent).toContain("Enable Plugins");
    expect(mocks.setBreadcrumbs).toHaveBeenCalled();
  });

  it("stops running Apps before disabling Sites", async () => {
    mocks.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
      showDeveloperDiagnostics: false,
      experimentalSitesEnabled: true,
      experimentalGoalsEnabled: false,
      experimentalComputerUseEnabled: false,
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
      experimentalPluginsEnabled: false,
      experimentalSitesEnabled: false,
    });
  });

  it("enables Goals from the dedicated experimental setting", async () => {
    const container = await renderPage();
    await act(async () => {
      await vi.waitFor(() => {
        expect(container.querySelector('[data-testid="experimental-goals-toggle"]'))
          .not.toBeNull();
      });
      container
        .querySelector<HTMLButtonElement>('[data-testid="experimental-goals-toggle"]')
        ?.click();
      await vi.waitFor(() => {
        expect(mocks.updateGeneral).toHaveBeenCalledWith({
          experimentalGoalsEnabled: true,
        });
      });
    });

    expect(container.textContent).toContain("Enable Goals");
  });

  it("enables Computer Use as one Agent capability and requests macOS permissions", async () => {
    const requestPermissions = vi.fn().mockResolvedValue({
      supported: true,
      accessibility: true,
      screenRecording: true,
      actionReady: true,
      driverVersion: "0.19.2",
      reason: null,
    });
    const readiness = vi.fn().mockResolvedValue({
      supported: true,
      accessibility: false,
      screenRecording: false,
      actionReady: false,
      driverVersion: "0.19.2",
      reason: "Permissions are required.",
    });
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: {
        computerUse: {
          supported: true,
          readiness,
          requestPermissions,
          openScreenRecordingSettings: vi.fn(),
        },
      },
    });
    mocks.updateGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
      showDeveloperDiagnostics: false,
      experimentalSitesEnabled: false,
      experimentalGoalsEnabled: false,
      experimentalComputerUseEnabled: true,
      locale: "en",
    });
    const container = await renderPage();

    await act(async () => {
      await vi.waitFor(() => {
        expect(container.querySelector('[data-testid="experimental-computer-use-toggle"]'))
          .not.toBeNull();
      });
      container.querySelector<HTMLButtonElement>('[data-testid="experimental-computer-use-toggle"]')?.click();
      await vi.waitFor(() => expect(requestPermissions).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(mocks.updateGeneral).toHaveBeenCalledWith({
        experimentalComputerUseEnabled: true,
      }));
    });

    expect(container.textContent).toContain("Enable Computer Use");
  });
});
