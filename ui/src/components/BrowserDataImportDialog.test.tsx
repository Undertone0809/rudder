// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserDataImportDialog } from "./BrowserDataImportDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const messages: Record<string, string> = {
  "browser.import.title": "Import browser data",
  "browser.import.description": "Choose a browser profile and the data to import.",
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
  "browser.import.notAvailableFromSource": "Not available from this profile",
  "browser.import.disclosure": "Imported sessions are shared by every organization and Agent in this Rudder instance.",
  "browser.import.action": "Import",
  "browser.import.importing": "Importing...",
  "browser.import.failed": "Browser data import failed.",
  "browser.import.result.imported": "Imported {{count}}",
  "browser.import.result.skipped": "Skipped {{count}}",
  "browser.import.result.failed": "Failed {{count}}",
  "browser.import.result.status.succeeded": "Import complete",
  "browser.import.result.status.partial": "Partial import",
  "browser.import.result.status.failed": "Import failed",
  "browser.import.result.skippedReasons": "Skipped details",
  "browser.import.result.failures": "Failures",
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

const listSources = vi.fn();
const importBrowserData = vi.fn();
const onOpenChange = vi.fn();
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderDialog(open: boolean) {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => {
    root!.render(<BrowserDataImportDialog open={open} onOpenChange={onOpenChange} />);
  });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  listSources.mockReset();
  importBrowserData.mockReset();
  onOpenChange.mockReset();
  listSources.mockResolvedValue([
    {
      id: "opaque-profile-1",
      displayName: "Google Chrome - Work",
      browserName: "Google Chrome",
      profileName: "Work",
      supported: { cookies: true, passwords: false },
    },
  ]);
  importBrowserData.mockResolvedValue({
    status: "partial",
    importedCount: 3,
    skippedCount: 2,
    failedCount: 1,
    errors: [
      { errorCode: "COOKIE_DECRYPT_FAILED", message: "One cookie could not be decrypted.", count: 1, kind: "failed" },
    ],
  });

  (window as typeof window & { desktopShell?: unknown }).desktopShell = {
    listBrowserImportSources: listSources,
    importBrowserData,
  };
});

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
  }
  container?.remove();
  root = null;
  container = null;
  delete (window as typeof window & { desktopShell?: unknown }).desktopShell;
});

describe("BrowserDataImportDialog", () => {
  it("aggregates expected skips without flooding the dialog as destructive errors", async () => {
    importBrowserData.mockResolvedValue({
      status: "succeeded",
      importedCount: 3009,
      skippedCount: 671,
      failedCount: 0,
      errors: [
        {
          errorCode: "COOKIE_PARTITION_UNSUPPORTED",
          message: "Partitioned cookies are not supported and were skipped.",
          count: 553,
          kind: "skipped",
        },
        {
          errorCode: "COOKIE_EXPIRED",
          message: "Expired cookies were skipped.",
          count: 118,
          kind: "skipped",
        },
      ],
    });

    renderDialog(true);
    await flush();
    const importButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Import");
    act(() => importButton!.click());
    await flush();

    const resultStatus = document.body.querySelector('[role="status"]');
    expect(resultStatus?.textContent).toContain("Import complete");
    expect(resultStatus?.textContent).toContain("Skipped details");
    expect(resultStatus?.textContent?.match(/COOKIE_PARTITION_UNSUPPORTED/g)).toHaveLength(1);
    expect(resultStatus?.textContent).toContain("553");
    expect(resultStatus?.querySelector(".text-destructive")).toBeNull();
    expect(document.body.querySelector('[data-testid="browser-import-scroll-region"]')?.className)
      .toContain("overflow-y-auto");
  });

  it("discovers sources only after opening and marks password import unavailable", async () => {
    renderDialog(false);
    expect(listSources).not.toHaveBeenCalled();

    renderDialog(true);
    await flush();

    expect(listSources).toHaveBeenCalledTimes(1);
    const sourceSelect = document.body.querySelector<HTMLSelectElement>("#browser-import-source");
    expect(sourceSelect?.selectedOptions[0]?.textContent?.trim()).toBe("Google Chrome - Work");
    expect(document.body.textContent).toContain("Cookies");
    expect(document.body.textContent).toContain("cookie-backed signed-in sessions");
    expect(document.body.textContent).toContain("Passwords");
    expect(document.body.textContent).toContain("Not available in this version");
    expect(document.body.textContent).toContain("shared by every organization and Agent");
  });

  it("imports only cookies and visibly reports partial counts and sanitized errors", async () => {
    renderDialog(true);
    await flush();

    const importButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Import");
    expect(importButton).toBeTruthy();

    act(() => importButton!.click());
    await flush();

    expect(importBrowserData).toHaveBeenCalledWith({
      sourceId: "opaque-profile-1",
      importCookies: true,
    });
    expect(document.body.textContent).toContain("Imported 3");
    expect(document.body.textContent).toContain("Skipped 2");
    expect(document.body.textContent).toContain("Failed 1");
    const resultStatus = document.body.querySelector('[role="status"]');
    expect(resultStatus).not.toBeNull();
    expect(resultStatus!.textContent).toContain("Partial import");
    expect(document.body.textContent).toContain("COOKIE_DECRYPT_FAILED");
    expect(document.body.textContent).toContain("One cookie could not be decrypted.");
    expect(document.body.textContent).not.toContain("opaque-profile-1");
  });

  it("keeps unknown import rejections generic", async () => {
    importBrowserData.mockRejectedValue(new Error("SQLITE_CORRUPT at /Users/private/Cookies"));

    renderDialog(true);
    await flush();

    const importButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Import");
    act(() => importButton!.click());
    await flush();

    const alert = document.body.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("Browser data import failed.");
    expect(document.body.textContent).not.toContain("SQLITE_CORRUPT");
    expect(document.body.textContent).not.toContain("/Users/private");
  });

  it("uses source capabilities to disable cookie import with an explicit status", async () => {
    listSources.mockResolvedValue([
      {
        id: "opaque-profile-unsupported",
        displayName: "Chromium - Guest",
        browserName: "Chromium",
        profileName: "Guest",
        supported: { cookies: false, passwords: false },
      },
    ]);

    renderDialog(true);
    await flush();

    expect(document.body.textContent).toContain("Not available from this profile");
    const importButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Import");
    expect(importButton?.hasAttribute("disabled")).toBe(true);
    expect(importBrowserData).not.toHaveBeenCalled();
  });

  it.each([
    ["succeeded", "Import complete"],
    ["failed", "Import failed"],
  ] as const)("labels a %s result explicitly", async (status, expectedLabel) => {
    importBrowserData.mockResolvedValue({
      status,
      importedCount: status === "succeeded" ? 2 : 0,
      skippedCount: 0,
      failedCount: status === "failed" ? 2 : 0,
      errors: [],
    });

    renderDialog(true);
    await flush();

    const importButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Import");
    act(() => importButton!.click());
    await flush();

    const resultStatus = document.body.querySelector('[role="status"]');
    expect(resultStatus).not.toBeNull();
    expect(resultStatus!.textContent).toContain(expectedLabel);
  });

  it("blocks user dismissal and ignores a stale import after a parent close and reopen", async () => {
    const oldImport = createDeferred<{
      status: "succeeded";
      importedCount: number;
      skippedCount: number;
      failedCount: number;
      errors: [];
    }>();
    importBrowserData.mockReturnValueOnce(oldImport.promise);
    listSources.mockResolvedValue([
      {
        id: "opaque-profile-1",
        displayName: "Google Chrome - Work",
        browserName: "Google Chrome",
        profileName: "Work",
        supported: { cookies: true, passwords: false },
      },
      {
        id: "opaque-profile-2",
        displayName: "Google Chrome - Personal",
        browserName: "Google Chrome",
        profileName: "Personal",
        supported: { cookies: true, passwords: false },
      },
    ]);

    renderDialog(true);
    await flush();
    const importButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Import");
    act(() => importButton!.click());
    await flush();
    expect(document.body.textContent).toContain("Importing...");

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Import browser data");

    renderDialog(false);
    renderDialog(true);
    await flush();
    const sourceSelect = document.body.querySelector<HTMLSelectElement>("#browser-import-source");
    expect(sourceSelect).not.toBeNull();
    act(() => {
      sourceSelect!.value = "opaque-profile-2";
      sourceSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(sourceSelect!.value).toBe("opaque-profile-2");

    await act(async () => {
      oldImport.resolve({
        status: "succeeded",
        importedCount: 99,
        skippedCount: 0,
        failedCount: 0,
        errors: [],
      });
      await oldImport.promise;
    });

    expect(document.body.textContent).not.toContain("Imported 99");
    expect(document.body.querySelector('[role="status"]')).toBeNull();
    expect(sourceSelect!.value).toBe("opaque-profile-2");
  });
});
