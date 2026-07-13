// @vitest-environment jsdom

import { en } from "@/i18n/locales/en";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceBrowserSettings } from "./InstanceBrowserSettings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  getBrowser: vi.fn(),
  updateBrowser: vi.fn(),
}));
const confirm = vi.hoisted(() => vi.fn());

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: apiMocks,
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/DialogContext", () => ({
  useDialog: () => ({ confirm }),
}));

const messages: Record<string, string> = {
  "common.systemSettings": "System settings",
  "common.browser": "Browser",
  "browser.title": "Browser",
  "browser.description": "Control the built-in Browser and its shared browsing data.",
  "browser.loadFailed": "Failed to load Browser settings.",
  "browser.updateFailed": "Failed to save Browser settings.",
  "browser.enable.title": "Enable Browser access for Agents",
  "browser.enable.enabledDescription": "Agents can use Browser tools and the Browser skill.",
  "browser.enable.disabledDescription": "Agents lose Browser access. Existing browsing data is retained.",
  "browser.enable.toggle": "Enable Browser access for Agents",
  "browser.links.title": "Open web links from Rudder in",
  "browser.links.description": "This preference is independent of Browser access for Agents.",
  "browser.links.builtIn": en["browser.links.builtIn"],
  "browser.links.default": "Default browser",
  "browser.data.title": "Browsing data",
  "browser.data.description": "Manage the instance-wide Browser profile.",
  "browser.data.trustDisclosure": "Browsing data and signed-in website sessions are shared by every organization and Agent in this Rudder instance.",
  "browser.data.import": "Import...",
  "browser.data.clear": "Clear all browsing data",
  "browser.data.clearDescription": "Remove cookies, site data, cache, and permissions without changing Browser settings.",
  "browser.data.clearConfirmTitle": "Clear all browsing data?",
  "browser.data.clearConfirmDescription": "Every organization will be signed out of websites. Browser settings will not change.",
  "browser.data.clearing": "Clearing...",
  "browser.data.cleared": "All browsing data was cleared.",
  "browser.data.clearFailed": "Failed to clear browsing data.",
  "browser.desktopUnavailable": "Rudder Desktop is required for importing or clearing browsing data.",
  "browser.import.title": "Import browser data",
  "browser.import.description": "Choose a browser profile and the data to import.",
  "browser.import.disabledDescription": "Enable Browser access for Agents before importing data.",
  "browser.import.source": "Browser profile",
  "browser.import.loadingSources": "Looking for browser profiles...",
  "browser.import.noSources": "No supported browser profiles found.",
  "browser.import.desktopUnavailable": "Browser data import is available only in Rudder Desktop.",
  "browser.import.dataTypes": "Data to import",
  "browser.import.cookies": "Cookies",
  "browser.import.cookiesDescription": "Import supported cookie-backed signed-in sessions.",
  "browser.import.passwords": "Passwords",
  "browser.import.passwordsDescription": "Saved-password import requires a future secure importer.",
  "browser.import.notAvailable": "Not available in this version",
  "browser.import.disclosure": "Imported sessions are shared by every organization and Agent in this Rudder instance.",
  "browser.import.action": "Import",
  "browser.import.importing": "Importing...",
  "browser.import.failed": "Browser data import failed.",
  "browser.import.result.imported": "Imported {{count}}",
  "browser.import.result.skipped": "Skipped {{count}}",
  "browser.import.result.failed": "Failed {{count}}",
  "common.cancel": "Cancel",
};

const translate = (key: string, values?: Record<string, string | number>) => {
  const template = messages[key] ?? key;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? ""));
};

vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({
    t: translate,
  }),
}));

let browserSettings: {
  enabled: boolean;
  openLinksIn: "built_in" | "default_browser";
} = { enabled: true, openLinksIn: "built_in" };
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient | null = null;
const clearBrowserData = vi.fn();
const listBrowserImportSources = vi.fn();
const importBrowserData = vi.fn();

async function renderPage() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(["instance", "browser-settings"], browserSettings);
  act(() => {
    root!.render(
      <QueryClientProvider client={queryClient!}>
        <InstanceBrowserSettings />
      </QueryClientProvider>,
    );
  });
  await waitFor(() => {
    expect(container!.textContent).toContain("Enable Browser access for Agents");
  });
  return container;
}

async function waitFor(assertion: () => void) {
  await act(async () => {
    await vi.waitFor(assertion, { interval: 1, timeout: 1000 });
  });
}

beforeEach(() => {
  browserSettings = { enabled: true, openLinksIn: "built_in" };
  apiMocks.getBrowser.mockReset();
  apiMocks.updateBrowser.mockReset();
  apiMocks.getBrowser.mockImplementation(async () => browserSettings);
  apiMocks.updateBrowser.mockImplementation(async (patch: Partial<typeof browserSettings>) => {
    browserSettings = { ...browserSettings, ...patch };
    return browserSettings;
  });
  confirm.mockReset();
  confirm.mockResolvedValue(true);
  clearBrowserData.mockReset();
  clearBrowserData.mockResolvedValue(undefined);
  listBrowserImportSources.mockReset();
  listBrowserImportSources.mockResolvedValue([]);
  importBrowserData.mockReset();
  (window as typeof window & { desktopShell?: unknown }).desktopShell = {
    clearBrowserData,
    importBrowserData,
    listBrowserImportSources,
  };
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  queryClient?.clear();
  root = null;
  container = null;
  queryClient = null;
  delete (window as typeof window & { desktopShell?: unknown }).desktopShell;
});

describe("InstanceBrowserSettings", () => {
  it("shows default-on settings and patches enablement and link destination independently", async () => {
    const page = await renderPage();

    const toggle = page.querySelector('button[role="switch"][aria-label="Enable Browser access for Agents"]');
    const builtIn = Array.from(page.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Rudder Built-in Browser");
    const defaultBrowser = Array.from(page.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Default browser");
    const slidingPill = page.querySelector('[data-browser-link-pill="true"]');

    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    expect(builtIn?.getAttribute("aria-pressed")).toBe("true");
    expect(slidingPill?.getAttribute("aria-hidden")).toBe("true");
    expect(slidingPill?.classList.contains("motion-browser-link-pill")).toBe(true);
    expect(builtIn?.classList.contains("motion-browser-link-option")).toBe(true);
    expect(builtIn?.classList.contains("whitespace-nowrap")).toBe(true);
    expect(builtIn?.parentElement?.classList.contains("w-[20rem]")).toBe(true);
    expect(page.textContent).toContain("shared by every organization and Agent");

    act(() => toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await waitFor(() => {
      expect(apiMocks.updateBrowser).toHaveBeenCalledWith({ enabled: false });
      expect(page.textContent).toContain("Agents lose Browser access. Existing browsing data is retained.");
    });

    act(() => defaultBrowser!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await waitFor(() => {
      expect(apiMocks.updateBrowser).toHaveBeenCalledWith({ openLinksIn: "default_browser" });
    });
  });

  it("opens import and confirms clear without changing Browser settings", async () => {
    const page = await renderPage();
    const importButton = Array.from(page.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Import...");
    const clearButton = Array.from(page.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Clear all browsing data");

    act(() => importButton!.click());
    await waitFor(() => {
      expect(document.body.textContent).toContain("Import browser data");
    });

    act(() => clearButton!.click());
    await waitFor(() => {
      expect(confirm).toHaveBeenCalledWith({
        title: "Clear all browsing data?",
        description: "Every organization will be signed out of websites. Browser settings will not change.",
        confirmLabel: "Clear all browsing data",
        tone: "destructive",
      });
      expect(clearBrowserData).toHaveBeenCalledTimes(1);
    });
    expect(apiMocks.updateBrowser).not.toHaveBeenCalled();
  });

  it("shows explicit native-action unavailability outside Rudder Desktop", async () => {
    delete (window as typeof window & { desktopShell?: unknown }).desktopShell;
    const page = await renderPage();

    expect(page.textContent).toContain("Rudder Desktop is required for importing or clearing browsing data.");
    const clearButton = Array.from(page.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Clear all browsing data");
    expect(clearButton?.hasAttribute("disabled")).toBe(true);
  });

  it("disables import and explains the required enablement while Browser is off", async () => {
    browserSettings = { enabled: false, openLinksIn: "default_browser" };
    const page = await renderPage();

    const importButton = Array.from(page.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Import...");
    expect(importButton?.hasAttribute("disabled")).toBe(true);
    expect(page.textContent).toContain("Enable Browser access for Agents before importing data.");

    act(() => importButton!.click());
    expect(document.body.textContent).not.toContain("Import browser data");
  });
});
