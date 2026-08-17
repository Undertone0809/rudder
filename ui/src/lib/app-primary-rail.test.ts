// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = new Map<string, string>();
const storageListeners = new Set<(event: StorageEvent) => void>();

Object.defineProperty(globalThis, "window", {
  value: {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
      if (type === "storage") storageListeners.add(listener);
    },
    removeEventListener: (type: string, listener: (event: StorageEvent) => void) => {
      if (type === "storage") storageListeners.delete(listener);
    },
  },
  configurable: true,
});

const {
  openAppRailItem,
  readOpenAppRailItems,
  reconcileOpenAppRailItems,
  removeOpenAppRailItem,
  subscribeOpenAppRailItems,
} = await import("./app-primary-rail");

const alpha = {
  key: "local:alpha",
  title: "Alpha CRM",
  iconDataUrl: null,
  identity: {
    desktopInstallationId: "desktop-1",
    appPublicId: "app-alpha",
    localBindingId: "binding-alpha",
  },
};
const beta = {
  key: "local:beta",
  title: "Beta Dashboard",
  iconDataUrl: "data:image/png;base64,beta",
  identity: {
    desktopInstallationId: "desktop-1",
    appPublicId: "app-beta",
    localBindingId: "binding-beta",
  },
};

describe("open App Primary Rail state", () => {
  beforeEach(() => {
    storage.clear();
  });

  it("stores open Apps per organization without duplicates", () => {
    openAppRailItem("org-1", alpha);
    openAppRailItem("org-1", { ...alpha, title: "Alpha CRM Revised" });
    openAppRailItem("org-2", beta);

    expect(readOpenAppRailItems("org-1")).toEqual([
      { ...alpha, title: "Alpha CRM Revised" },
    ]);
    expect(readOpenAppRailItems("org-2")).toEqual([beta]);
  });

  it("removes only the requested App view entry", () => {
    openAppRailItem("org-1", alpha);
    openAppRailItem("org-1", beta);

    removeOpenAppRailItem("org-1", alpha.key);

    expect(readOpenAppRailItems("org-1")).toEqual([beta]);
  });

  it("reconciles deleted Apps and refreshes their visible identity", () => {
    openAppRailItem("org-1", alpha);
    openAppRailItem("org-1", beta);

    reconcileOpenAppRailItems("org-1", [{ ...alpha, title: "Alpha CRM 2" }]);

    expect(readOpenAppRailItems("org-1")).toEqual([
      { ...alpha, title: "Alpha CRM 2" },
    ]);
  });

  it("notifies subscribers after an App opens or closes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOpenAppRailItems(listener);

    openAppRailItem("org-1", alpha);
    removeOpenAppRailItem("org-1", alpha.key);

    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("retains every opened App until the operator explicitly removes it", () => {
    for (let index = 0; index < 30; index += 1) {
      openAppRailItem("org-1", {
        ...alpha,
        key: `local:app-${index}`,
        title: `App ${index}`,
      });
    }

    expect(readOpenAppRailItems("org-1")).toHaveLength(30);
    expect(readOpenAppRailItems("org-1")[0]?.key).toBe("local:app-0");
  });
});
