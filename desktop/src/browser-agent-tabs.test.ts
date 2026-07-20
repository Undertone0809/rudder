import { describe, expect, it, vi } from "vitest";
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
  stopCalls = 0;
  executionGate: Promise<void> | null = null;
  png = Buffer.from("png-data");
  private readonly destroyedListeners = new Set<() => void>();

  async loadURL(url: string) {
    this.url = url;
    this.title = new URL(url).hostname;
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

  close() {
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
  maxRunStatusFailures?: number;
  createTabGate?: Promise<void>;
  clock?: () => number;
} = {}) {
  const tabs: FakeTab[] = [];
  let nextId = 1;
  const controller = createBrowserAgentTabController({
    createId: () => `tab-${nextId++}`,
    createSnapshotId: () => "snapshot-1",
    getOperatingLayerOrigins: () => ["http://127.0.0.1:3100"],
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
    });
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

  it("blocks non-web and Rudder operating-layer navigation before creating a tab", async () => {
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
    const read = controller.execute({ identity: owner, action: "read", args: { tabId: "tab-1" } });
    const rejection = expect(read).rejects.toMatchObject({ code: "browser_timeout" });
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(tabs[0]?.stopCalls).toBe(1);
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
