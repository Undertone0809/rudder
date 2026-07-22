import { describe, expect, it, vi } from "vitest";
import type { BrowserAdvancedAction } from "./browser-agent-advanced.js";
import {
  BrowserAgentError,
  createBrowserAgentTabController,
  type BrowserAgentTab,
  type BrowserRuntimeIdentity,
} from "./browser-agent-tabs.js";

const owner: BrowserRuntimeIdentity = {
  orgId: "org-1",
  agentId: "agent-1",
  runId: "run-1",
};

class FakeTab implements BrowserAgentTab {
  destroyed = false;
  url = "about:blank";
  title = "";
  readonly scripts: string[] = [];
  readonly advancedCalls: Array<{ action: BrowserAdvancedAction; args: Record<string, unknown> }> = [];
  clipboardItems: Array<{ entries: Array<{ mimeType: string; text?: string }> }> = [];
  stopCalls = 0;
  executionGate: Promise<void> | null = null;
  closeGate: Promise<void> | null = null;
  assetBundleGate: Promise<void> | null = null;
  png = Buffer.from("png-data");
  advancedError: Error | null = null;
  viewport = { width: 1280, height: 720 };
  visible = false;
  private readonly destroyedListeners = new Set<() => void>();

  async loadURL(url: string) {
    this.url = url;
    this.title = new URL(url).hostname;
  }

  async goBack() {
    this.url = "https://example.com/back";
    this.title = "Back";
  }

  async goForward() {
    this.url = "https://example.com/forward";
    this.title = "Forward";
  }

  async reload() {
    this.title = "Reloaded";
  }

  getViewport() {
    return { ...this.viewport };
  }

  setViewport(width: number, height: number) {
    this.viewport = { width, height };
  }

  resetViewport() {
    this.viewport = { width: 1280, height: 720 };
  }

  isVisible() {
    return this.visible;
  }

  setVisible(visible: boolean) {
    this.visible = visible;
  }

  async advanced(action: BrowserAdvancedAction, args: Record<string, unknown>) {
    this.advancedCalls.push({ action, args });
    if (this.advancedError) throw this.advancedError;
    if (action === "clipboard") {
      if (args.action === "write") this.clipboardItems = structuredClone(args.items as typeof this.clipboardItems);
      return { items: structuredClone(this.clipboardItems) };
    }
    if (action === "screenshot") {
      return { mimeType: "image/png", base64: this.png.toString("base64") };
    }
    if (action === "assets" && args.action === "bundle") {
      await this.assetBundleGate;
      const totalBytes = Math.min(60, Number(args.maxTotalBytes || 0));
      return { action, performed: true, summary: { totalBytes } };
    }
    return { action, performed: true };
  }

  getURL() {
    return this.url;
  }

  getTitle() {
    return this.title;
  }

  isDestroyed() {
    return this.destroyed;
  }

  stop() {
    this.stopCalls += 1;
  }

  async close() {
    await this.closeGate;
    if (this.destroyed) return;
    this.destroyed = true;
    for (const listener of this.destroyedListeners) listener();
  }

  onDestroyed(listener: () => void) {
    this.destroyedListeners.add(listener);
  }

  async executeIsolatedJavaScript(script: string) {
    this.scripts.push(script);
    await this.executionGate;
    if (script.includes("RUDDER_BROWSER_READ_V1")) {
      return {
        url: this.url,
        title: this.title,
        text: "Example page",
        refs: [{ ref: "snapshot-1:0", role: "button", name: "Continue" }],
      };
    }
    if (script.includes("RUDDER_BROWSER_CLICK_V1")) return { clicked: true };
    if (script.includes("RUDDER_BROWSER_TYPE_V1")) return { typed: true, submitted: false };
    return {};
  }

  async capturePng() {
    return this.png;
  }
}

function createHarness(options: {
  maxTabsPerRun?: number;
  maxTabsTotal?: number;
  commandTimeoutMs?: number;
  maxScreenshotBytes?: number;
  maxAssetBundleBytesPerRun?: number;
  maxRunStatusFailures?: number;
  createTabGate?: Promise<void>;
  clock?: () => number;
  listUserTabs?: () => Array<{ id: string; title?: string; url?: string }>;
} = {}) {
  const tabs: FakeTab[] = [];
  let nextId = 1;
  const controller = createBrowserAgentTabController({
    createId: () => `tab-${nextId++}`,
    createSnapshotId: () => "snapshot-1",
    getRudderAppOrigins: () => ["http://127.0.0.1:3100"],
    createTab: vi.fn(async () => {
      const tab = new FakeTab();
      tabs.push(tab);
      await options.createTabGate;
      return tab;
    }),
    ...options,
  });
  return { controller, tabs };
}

describe("Browser Agent tab controller", () => {
  it("lists user-visible built-in Browser tabs without mixing in run-owned Agent tabs", async () => {
    const { controller } = createHarness({
      listUserTabs: () => [{
        id: "opaque-user-tab",
        title: "Private reset document",
        url: "https://user:password@example.com/reset?token=secret#private",
      }],
    });
    await controller.execute({ identity: owner, action: "open", args: { url: "https://agent.example.com" } });

    await expect(controller.execute({ identity: owner, action: "user_tabs", args: {} })).resolves.toEqual({
      tabs: [{ id: "opaque-user-tab", title: "example.com", url: "https://example.com/" }],
    });
  });

  it("opens and lists only tabs owned by the exact organization, agent, and run", async () => {
    const { controller } = createHarness();

    await expect(controller.execute({
      identity: owner,
      action: "open",
      args: { url: "https://example.com/path?secret=hidden" },
    })).resolves.toMatchObject({ tabId: "tab-1", url: "https://example.com/path?secret=hidden" });

    await controller.execute({
      identity: { ...owner, runId: "run-2" },
      action: "open",
      args: { url: "https://example.org" },
    });

    await expect(controller.execute({ identity: owner, action: "tabs", args: {} })).resolves.toEqual({
      tabs: [expect.objectContaining({ tabId: "tab-1", url: "https://example.com/path?secret=hidden" })],
      selectedTabId: "tab-1",
    });
  });

  it("navigates back, forward, and reloads through the owned tab history", async () => {
    const { controller } = createHarness();
    const opened = await controller.execute({
      identity: owner,
      action: "open",
      args: { url: "https://example.com/start" },
    }) as { tabId: string };

    await expect(controller.execute({ identity: owner, action: "back", args: { tabId: opened.tabId } }))
      .resolves.toMatchObject({ url: "https://example.com/back", title: "Back" });
    await expect(controller.execute({ identity: owner, action: "forward", args: { tabId: opened.tabId } }))
      .resolves.toMatchObject({ url: "https://example.com/forward", title: "Forward" });
    await expect(controller.execute({ identity: owner, action: "reload", args: { tabId: opened.tabId } }))
      .resolves.toMatchObject({ title: "Reloaded" });
  });

  it("persists viewport and visibility before opening a tab and isolates them by run", async () => {
    const { controller, tabs } = createHarness();

    await expect(controller.execute({
      identity: owner,
      action: "viewport",
      args: { action: "set", width: 390, height: 844 },
    })).resolves.toEqual({ viewport: { width: 390, height: 844 }, overridden: true });
    await expect(controller.execute({
      identity: owner,
      action: "visibility",
      args: { visible: true },
    })).resolves.toEqual({ visible: true, selectedTabId: null });

    await controller.execute({ identity: owner, action: "open", args: { url: "https://example.com" } });
    await controller.execute({
      identity: { ...owner, runId: "run-2" },
      action: "open",
      args: { url: "https://example.org" },
    });

    expect(tabs[0]?.viewport).toEqual({ width: 390, height: 844 });
    expect(tabs[0]?.visible).toBe(true);
    expect(tabs[1]?.viewport).toEqual({ width: 1280, height: 720 });
    expect(tabs[1]?.visible).toBe(false);
  });

  it("applies viewport reset and shows only the selected tab", async () => {
    const { controller, tabs } = createHarness();
    await controller.execute({ identity: owner, action: "open", args: { url: "https://example.com" } });
    await controller.execute({ identity: owner, action: "open", args: { url: "https://example.org" } });
    await controller.execute({ identity: owner, action: "visibility", args: { visible: true } });

    expect(tabs[0]?.visible).toBe(false);
    expect(tabs[1]?.visible).toBe(true);
    await controller.execute({ identity: owner, action: "read", args: { tabId: "tab-1" } });
    expect(tabs[0]?.visible).toBe(true);
    expect(tabs[1]?.visible).toBe(false);

    await controller.execute({
      identity: owner,
      action: "viewport",
      args: { action: "set", width: 412, height: 915 },
    });
    expect(tabs.map((tab) => tab.viewport)).toEqual([
      { width: 412, height: 915 },
      { width: 412, height: 915 },
    ]);
    await expect(controller.execute({
      identity: owner,
      action: "viewport",
      args: { action: "reset" },
    })).resolves.toEqual({ viewport: { width: 1280, height: 720 }, overridden: false });
    expect(tabs.map((tab) => tab.viewport)).toEqual([
      { width: 1280, height: 720 },
      { width: 1280, height: 720 },
    ]);
  });

  it("reaps run state that exists without an open tab", async () => {
    const { controller } = createHarness();
    await controller.execute({ identity: owner, action: "visibility", args: { visible: true } });

    const checked: BrowserRuntimeIdentity[] = [];
    await controller.reapInactiveRuns(async (identity) => {
      checked.push(identity);
      return false;
    });

    expect(checked).toEqual([owner]);
    await expect(controller.execute({ identity: owner, action: "tabs", args: {} })).resolves.toEqual({
      tabs: [],
      selectedTabId: null,
    });
  });

  it("isolates the virtual clipboard by run and clears it with run state", async () => {
    const { controller } = createHarness();
    const otherRun = { ...owner, runId: "run-2" };
    await controller.execute({
      identity: owner,
      action: "clipboard",
      args: { action: "writeText", text: "run-one" },
    });

    await expect(controller.execute({
      identity: owner,
      action: "clipboard",
      args: { action: "readText" },
    })).resolves.toEqual({ text: "run-one" });
    await expect(controller.execute({
      identity: otherRun,
      action: "clipboard",
      args: { action: "readText" },
    })).resolves.toEqual({ text: "" });

    await controller.closeRun(owner);
    await expect(controller.execute({
      identity: owner,
      action: "clipboard",
      args: { action: "read" },
    })).resolves.toEqual({ items: [] });
  });

  it("synchronizes the run clipboard with the selected page and virtual CUA shortcuts", async () => {
    const { controller, tabs } = createHarness();
    await controller.execute({ identity: owner, action: "open", args: { url: "https://example.com" } });
    await controller.execute({
      identity: owner,
      action: "clipboard",
      args: { action: "writeText", text: "from-run" },
    });
    expect(tabs[0]?.clipboardItems).toEqual([{ entries: [{ mimeType: "text/plain", text: "from-run" }] }]);

    tabs[0]!.clipboardItems = [{ entries: [{ mimeType: "text/plain", text: "from-page" }] }];
    await expect(controller.execute({
      identity: owner,
      action: "clipboard",
      args: { action: "readText" },
    })).resolves.toEqual({ text: "from-page" });

    await controller.execute({
      identity: owner,
      action: "cua",
      args: { tabId: "tab-1", action: "keypress", keys: ["ControlOrMeta", "v"] },
    });
    expect(tabs[0]?.advancedCalls.slice(-3).map((call) => [call.action, call.args.action])).toEqual([
      ["clipboard", "write"],
      ["cua", "keypress"],
      ["clipboard", "read"],
    ]);
  });

  it("keeps serialized clipboard commands below the one MiB Broker limit", async () => {
    const { controller } = createHarness();
    await expect(controller.execute({
      identity: owner,
      action: "clipboard",
      args: {
        action: "write",
        items: [{ entries: [{ mimeType: "application/octet-stream", base64: "a".repeat(650_001) }] }],
      },
    })).rejects.toMatchObject({ code: "browser_invalid_argument" });
  });

  it("cancels an admitted operation immediately when its transport disconnects", async () => {
    const { controller, tabs } = createHarness();
    await controller.execute({ identity: owner, action: "open", args: { url: "https://example.com" } });
    tabs[0]!.assetBundleGate = new Promise<void>(() => undefined);
    const abort = new AbortController();
    const operation = controller.execute({
      identity: owner,
      action: "assets",
      args: {
        tabId: "tab-1",
        action: "bundle",
        inventoryId: "inventory-1",
        assetIds: ["asset-1"],
      },
      signal: abort.signal,
    });
    await vi.waitFor(() => expect(tabs[0]?.advancedCalls).toHaveLength(1));

    abort.abort();

    await expect(operation).rejects.toMatchObject({ code: "browser_unavailable" });
    await vi.waitFor(() => expect(tabs[0]?.destroyed).toBe(true));
  });

  it("routes advanced Browser actions only through an owned tab", async () => {
    const { controller } = createHarness();
    await controller.execute({ identity: owner, action: "open", args: { url: "https://example.com" } });

    await expect(controller.execute({
      identity: owner,
      action: "snapshot",
      args: { tabId: "tab-1", boxes: true },
    })).resolves.toMatchObject({ tabId: "tab-1", action: "snapshot", performed: true });
    await expect(controller.execute({
      identity: { ...owner, runId: "run-2" },
      action: "snapshot",
      args: { tabId: "tab-1" },
    })).rejects.toMatchObject({ code: "browser_tab_forbidden" });
  });

  it("enforces the asset quota across every tab owned by a run", async () => {
    const { controller, tabs } = createHarness({ maxAssetBundleBytesPerRun: 100 });
    await controller.execute({ identity: owner, action: "open", args: { url: "https://example.com" } });
    await controller.execute({ identity: owner, action: "open", args: { url: "https://example.org" } });

    await controller.execute({
      identity: owner,
      action: "assets",
      args: { tabId: "tab-1", action: "bundle", inventoryId: "inventory-1", assetIds: ["asset-1"] },
    });
    await controller.execute({
      identity: owner,
      action: "assets",
      args: { tabId: "tab-2", action: "bundle", inventoryId: "inventory-2", assetIds: ["asset-2"] },
    });

    expect(tabs[0]?.advancedCalls.at(-1)?.args.maxTotalBytes).toBe(100);
    expect(tabs[1]?.advancedCalls.at(-1)?.args.maxTotalBytes).toBe(40);
    await expect(controller.execute({
      identity: owner,
      action: "assets",
      args: { tabId: "tab-1", action: "bundle", inventoryId: "inventory-1", assetIds: ["asset-3"] },
    })).rejects.toMatchObject({ code: "browser_result_too_large" });
  });

  it("serializes concurrent asset bundles across tabs before admitting run quota", async () => {
    const { controller, tabs } = createHarness({ maxAssetBundleBytesPerRun: 100 });
    await controller.execute({ identity: owner, action: "open", args: { url: "https://example.com" } });
    await controller.execute({ identity: owner, action: "open", args: { url: "https://example.org" } });
    let releaseFirstBundle!: () => void;
    tabs[0]!.assetBundleGate = new Promise<void>((resolve) => { releaseFirstBundle = resolve; });

    const first = controller.execute({
      identity: owner,
      action: "assets",
      args: { tabId: "tab-1", action: "bundle", inventoryId: "inventory-1", assetIds: ["asset-1"] },
    });
    await vi.waitFor(() => expect(tabs[0]?.advancedCalls).toHaveLength(1));
    const second = controller.execute({
      identity: owner,
      action: "assets",
      args: { tabId: "tab-2", action: "bundle", inventoryId: "inventory-2", assetIds: ["asset-2"] },
    });
    await Promise.resolve();
    expect(tabs[1]?.advancedCalls).toHaveLength(0);

    releaseFirstBundle();
    await Promise.all([first, second]);
    expect(tabs[0]?.advancedCalls[0]?.args.maxTotalBytes).toBe(100);
    expect(tabs[1]?.advancedCalls[0]?.args.maxTotalBytes).toBe(40);
  });

  it("rejects cross-run tab control without exposing page content", async () => {
    const { controller } = createHarness();
    await controller.execute({ identity: owner, action: "open", args: { url: "https://example.com" } });

    await expect(controller.execute({
      identity: { ...owner, runId: "run-2" },
      action: "read",
      args: { tabId: "tab-1" },
    })).rejects.toMatchObject<Partial<BrowserAgentError>>({ code: "browser_tab_forbidden" });
  });

  it("blocks non-web and Rudder navigation before creating a tab", async () => {
    const { controller, tabs } = createHarness();

    await expect(controller.execute({
      identity: owner,
      action: "open",
      args: { url: "file:///tmp/private.txt" },
    })).rejects.toMatchObject({ code: "browser_unsafe_url" });
    await expect(controller.execute({
      identity: owner,
      action: "open",
      args: { url: "http://localhost:3100/api/orgs" },
    })).rejects.toMatchObject({ code: "browser_unsafe_url" });
    expect(tabs).toHaveLength(0);
  });

  it("uses bounded ref-based scripts for read, click, and type", async () => {
    const { controller, tabs } = createHarness();
    await controller.execute({ identity: owner, action: "open", args: { url: "https://example.com" } });

    await expect(controller.execute({
      identity: owner,
      action: "read",
      args: { tabId: "tab-1" },
    })).resolves.toMatchObject({
      tabId: "tab-1",
      text: "Example page",
      refs: [{ ref: "snapshot-1:0", role: "button", name: "Continue" }],
    });
    await expect(controller.execute({
      identity: owner,
      action: "click",
      args: { tabId: "tab-1", ref: "snapshot-1:0" },
    })).resolves.toMatchObject({ clicked: true, tabId: "tab-1" });
    await expect(controller.execute({
      identity: owner,
      action: "type",
      args: { tabId: "tab-1", ref: "snapshot-1:0", text: "hello'); window.evil = true; //" },
    })).resolves.toMatchObject({ typed: true, tabId: "tab-1" });

    expect(tabs[0]?.scripts).toHaveLength(3);
    expect(tabs[0]?.scripts[1]).toContain("RUDDER_BROWSER_CLICK_V1");
    expect(tabs[0]?.scripts[2]).toContain("RUDDER_BROWSER_TYPE_V1");
    expect(tabs[0]?.scripts[2]).not.toContain("window.evil = true");
    expect(tabs[0]?.scripts[0]).not.toContain("data-rudder-browser-ref");
    expect(tabs[0]?.scripts[1]).toContain("__RUDDER_BROWSER_REFS_V1__");
  });

  it("captures screenshots and closes leases on run cleanup or global reset", async () => {
    const { controller, tabs } = createHarness();
    await controller.execute({ identity: owner, action: "open", args: { url: "https://example.com" } });
    await controller.execute({
      identity: { ...owner, runId: "run-2" },
      action: "open",
      args: { url: "https://example.org" },
    });

    await expect(controller.execute({
      identity: owner,
      action: "screenshot",
      args: { tabId: "tab-1" },
    })).resolves.toEqual({
      tabId: "tab-1",
      url: "https://example.com",
      mimeType: "image/png",
      base64: Buffer.from("png-data").toString("base64"),
    });

    await controller.closeRun(owner);
    expect(tabs[0]?.destroyed).toBe(true);
    expect(tabs[1]?.destroyed).toBe(false);
    await controller.closeAll();
    expect(tabs[1]?.destroyed).toBe(true);
  });

  it("waits for native tab cleanup before run cleanup completes", async () => {
    const { controller, tabs } = createHarness();
    await controller.execute({ identity: owner, action: "open", args: { url: "https://example.com" } });
    let releaseClose!: () => void;
    tabs[0]!.closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });

    let cleanupFinished = false;
    const cleanup = controller.closeRun(owner).then(() => { cleanupFinished = true; });
    await Promise.resolve();
    expect(cleanupFinished).toBe(false);

    releaseClose();
    await cleanup;
    expect(tabs[0]?.destroyed).toBe(true);
  });

  it("reaps tabs after their run becomes inactive", async () => {
    const { controller, tabs } = createHarness();
    await controller.execute({ identity: owner, action: "open", args: { url: "https://example.com" } });

    await controller.reapInactiveRuns(async (identity) => identity.runId !== "run-1");

    expect(tabs[0]?.destroyed).toBe(true);
  });

  it("caps tabs per run and globally", async () => {
    const perRun = createHarness({ maxTabsPerRun: 1 });
    await perRun.controller.execute({ identity: owner, action: "open", args: { url: "https://example.com" } });
    await expect(perRun.controller.execute({
      identity: owner,
      action: "open",
      args: { url: "https://example.org" },
    })).rejects.toMatchObject({ code: "browser_tab_limit" });

    const global = createHarness({ maxTabsPerRun: 2, maxTabsTotal: 1 });
    await global.controller.execute({ identity: owner, action: "open", args: { url: "https://example.com" } });
    await expect(global.controller.execute({
      identity: { ...owner, runId: "run-2" },
      action: "open",
      args: { url: "https://example.org" },
    })).rejects.toMatchObject({ code: "browser_tab_limit" });
  });

  it("serializes commands for one tab so navigation cannot race a snapshot", async () => {
    const { controller, tabs } = createHarness();
    await controller.execute({ identity: owner, action: "open", args: { url: "https://example.com" } });
    let releaseRead!: () => void;
    tabs[0]!.executionGate = new Promise<void>((resolve) => { releaseRead = resolve; });

    const read = controller.execute({ identity: owner, action: "read", args: { tabId: "tab-1" } });
    await vi.waitFor(() => expect(tabs[0]?.scripts).toHaveLength(1));
    const navigate = controller.execute({
      identity: owner,
      action: "navigate",
      args: { tabId: "tab-1", url: "https://example.org" },
    });
    expect(tabs[0]?.url).toBe("https://example.com");

    releaseRead();
    await read;
    await navigate;
    expect(tabs[0]?.url).toBe("https://example.org");
  });

  it("stops and closes a tab when a command exceeds the Desktop deadline", async () => {
    const { controller, tabs } = createHarness({ commandTimeoutMs: 25 });
    await controller.execute({ identity: owner, action: "open", args: { url: "https://example.com" } });
    vi.useFakeTimers();
    tabs[0]!.executionGate = new Promise<void>(() => undefined);
    let releaseClose!: () => void;
    tabs[0]!.closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const read = controller.execute({ identity: owner, action: "read", args: { tabId: "tab-1" } });
    let rejected = false;
    void read.catch(() => { rejected = true; });
    await vi.advanceTimersByTimeAsync(25);

    expect(tabs[0]?.stopCalls).toBe(1);
    expect(rejected).toBe(true);
    await expect(read).rejects.toMatchObject({ code: "browser_timeout" });
    releaseClose();
    await vi.runAllTimersAsync();
    expect(tabs[0]?.destroyed).toBe(true);
    vi.useRealTimers();
  });

  it("cancels in-flight opens during closeAll and releases their capacity reservation", async () => {
    let releaseOpen!: () => void;
    const createTabGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const { controller, tabs } = createHarness({ maxTabsPerRun: 1, createTabGate });
    const firstOpen = controller.execute({
      identity: owner,
      action: "open",
      args: { url: "https://example.com" },
    });
    const firstRejection = expect(firstOpen).rejects.toMatchObject({ code: "browser_tab_not_found" });
    await vi.waitFor(() => expect(tabs).toHaveLength(1));
    await expect(controller.execute({
      identity: owner,
      action: "open",
      args: { url: "https://example.org" },
    })).rejects.toMatchObject({ code: "browser_tab_limit" });

    await controller.closeAll();
    releaseOpen();
    await firstRejection;
    expect(tabs[0]?.destroyed).toBe(true);

    await expect(controller.execute({
      identity: owner,
      action: "open",
      args: { url: "https://example.net" },
    })).resolves.toMatchObject({ tabId: "tab-2" });
  });

  it("rejects oversized screenshots without serializing the image", async () => {
    const { controller, tabs } = createHarness({ maxScreenshotBytes: 4 });
    await controller.execute({ identity: owner, action: "open", args: { url: "https://example.com" } });
    tabs[0]!.png = Buffer.alloc(5);

    await expect(controller.execute({
      identity: owner,
      action: "screenshot",
      args: { tabId: "tab-1" },
    })).rejects.toMatchObject({ code: "browser_result_too_large" });
  });

  it("maps Chromium full-page dimension failures to the stable result-too-large error", async () => {
    const { controller, tabs } = createHarness();
    await controller.execute({ identity: owner, action: "open", args: { url: "https://example.com" } });
    tabs[0]!.advancedError = new Error("Browser full-page screenshot exceeds Chromium's 16384-pixel dimension limit.");

    await expect(controller.execute({
      identity: owner,
      action: "screenshot",
      args: { tabId: "tab-1", fullPage: true },
    })).rejects.toMatchObject({
      code: "browser_result_too_large",
      message: expect.stringMatching(/16384-pixel dimension limit/i),
    });
  });

  it("does not execute a command whose Broker deadline expired in the tab queue", async () => {
    let clock = 1_000;
    const { controller, tabs } = createHarness({ clock: () => clock, commandTimeoutMs: 100 });
    await controller.execute({ identity: owner, action: "open", args: { url: "https://example.com" } });
    let releaseRead!: () => void;
    tabs[0]!.executionGate = new Promise<void>((resolve) => { releaseRead = resolve; });

    const read = controller.execute({
      identity: owner,
      action: "read",
      args: { tabId: "tab-1" },
      deadlineAt: 1_100,
    });
    await vi.waitFor(() => expect(tabs[0]?.scripts).toHaveLength(1));
    const navigate = controller.execute({
      identity: owner,
      action: "navigate",
      args: { tabId: "tab-1", url: "https://example.org" },
      deadlineAt: 1_050,
    });
    const rejection = expect(navigate).rejects.toMatchObject({ code: "browser_timeout" });
    clock = 1_060;
    releaseRead();

    await read;
    await rejection;
    expect(tabs[0]?.url).toBe("https://example.com");
  });

  it("checks run ownership in parallel during a lifecycle sweep", async () => {
    const { controller } = createHarness();
    await controller.execute({ identity: owner, action: "open", args: { url: "https://example.com" } });
    await controller.execute({
      identity: { ...owner, runId: "run-2" },
      action: "open",
      args: { url: "https://example.org" },
    });
    const resolvers: Array<(active: boolean) => void> = [];
    const checking = controller.reapInactiveRuns(() => new Promise<boolean>((resolve) => {
      resolvers.push(resolve);
    }));
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers.forEach((resolve) => resolve(true));
    await checking;
  });

  it("revokes leases after repeated run-status failures", async () => {
    const { controller, tabs } = createHarness({ maxRunStatusFailures: 3 });
    await controller.execute({ identity: owner, action: "open", args: { url: "https://example.com" } });
    const unavailable = async () => { throw new Error("status unavailable"); };

    await controller.reapInactiveRuns(unavailable);
    await controller.reapInactiveRuns(unavailable);
    expect(tabs[0]?.destroyed).toBe(false);
    await controller.reapInactiveRuns(unavailable);
    expect(tabs[0]?.destroyed).toBe(true);
  });
});
