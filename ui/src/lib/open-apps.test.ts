// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { closeApp, openApp, readOpenApps } from "./open-apps";

beforeEach(() => window.sessionStorage.clear());

describe("opened Apps", () => {
  const app = { key: "managed:a", title: "Research", path: "/apps/view/managed%3Aa" };

  it("deduplicates reopen, restores session state, and scopes close to an organization", () => {
    openApp("org-a", app);
    const snapshot = readOpenApps("org-a");
    openApp("org-a", app);
    expect(readOpenApps("org-a")).toBe(snapshot);
    openApp("org-b", app);
    closeApp("org-a", app.key);
    expect(readOpenApps("org-a")).toEqual([]);
    expect(readOpenApps("org-b")).toEqual([app]);
    openApp("org-a", app);
    expect(JSON.parse(window.sessionStorage.getItem("rudder.openApps:org-a")!)).toEqual([app]);
  });

  it("ignores malformed state and non-App navigation targets", () => {
    window.sessionStorage.setItem("rudder.openApps:bad", "{");
    expect(readOpenApps("bad")).toEqual([]);
    window.sessionStorage.setItem("rudder.openApps:bad", JSON.stringify([{ ...app, path: "https://example.com" }, app]));
    expect(readOpenApps("bad")).toEqual([app]);
  });

  it("keeps in-memory state usable when session storage is unavailable", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("disabled"); });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("disabled"); });
    try {
      openApp("blocked", app);
      expect(readOpenApps("blocked")).toEqual([app]);
      closeApp("blocked", app.key);
      expect(readOpenApps("blocked")).toEqual([]);
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  it("retains session changes when reads succeed but writes exceed quota", () => {
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    try {
      openApp("quota", app);
      expect(readOpenApps("quota")).toEqual([app]);
      closeApp("quota", app.key);
      expect(readOpenApps("quota")).toEqual([]);
    } finally { set.mockRestore(); }
  });
});
