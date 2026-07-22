// @vitest-environment jsdom

import fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserAdvancedDriver } from "./browser-agent-advanced.js";

function createHarness() {
  const contentHandlers = new Map<string, (...args: any[]) => void>();
  const debuggerHandlers = new Map<string, (...args: any[]) => void>();
  let attached = false;
  const png = Buffer.from("advanced-png");
  let clipboardItems: Array<{ entries: Array<{ mimeType: string; text?: string }> }> = [];
  const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "Page.getFrameTree") return {
      frameTree: { frame: { id: "main-frame", loaderId: "loader-1", url: "https://example.com" } },
    };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
    if (method === "Runtime.evaluate") {
      const expression = String(params?.expression || "");
      if (expression === "document.readyState") return { result: { value: "complete" } };
      if (expression === "document.hasFocus() && !(document.activeElement instanceof HTMLIFrameElement)") {
        return { result: { value: true } };
      }
      if (expression.includes("?.set(JSON.parse")) {
        const encoded = Array.from(expression.matchAll(/atob\("([^"]+)"\)/gu)).at(-1)?.[1];
        if (encoded) clipboardItems = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
        return { result: { value: null } };
      }
      if (expression.includes(".shortcut(\"copy\")")) {
        const target = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
        const text = target?.value.slice(target.selectionStart ?? 0, target.selectionEnd ?? 0) ?? "";
        clipboardItems = [{ entries: [{ mimeType: "text/plain", text }] }];
        return { result: { value: clipboardItems } };
      }
      if (expression.includes(".shortcut(\"paste\")")) {
        const target = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
        const text = clipboardItems[0]?.entries[0]?.text ?? "";
        target?.setRangeText(text, target.selectionStart ?? 0, target.selectionEnd ?? 0, "end");
        return { result: { value: clipboardItems } };
      }
      return { result: { value: "Example title" } };
    }
    if (method === "Page.getLayoutMetrics") return { cssContentSize: { width: 800, height: 1200 } };
    if (method === "Page.captureScreenshot") return { data: png.toString("base64") };
    if (method === "Page.printToPDF") return { data: Buffer.from("pdf-data").toString("base64") };
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelector") return { nodeId: 2 };
    if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
      (document.activeElement as HTMLElement | null)?.click?.();
    }
    return { method, params };
  });
  const browserDebugger = {
    isAttached: vi.fn(() => attached),
    attach: vi.fn(() => { attached = true; }),
    detach: vi.fn(() => { attached = false; }),
    sendCommand,
    on: vi.fn((event: string, listener: (...args: any[]) => void) => { debuggerHandlers.set(event, listener); }),
    removeListener: vi.fn((event: string, listener: (...args: any[]) => void) => {
      if (debuggerHandlers.get(event) === listener) debuggerHandlers.delete(event);
    }),
  };
  const fetch = vi.fn(async (
    _input: string,
    _init?: { method?: string; redirect?: "follow"; signal?: AbortSignal },
  ) => new Response(Buffer.from("asset-bytes"), {
    status: 200,
    headers: { "content-type": "image/png", "content-length": "11" },
  }));
  const setCookie = vi.fn(async () => undefined);
  const contents = {
    debugger: browserDebugger,
    session: { fetch, cookies: { set: setCookie } },
    getURL: vi.fn(() => "https://example.com/page"),
    getTitle: vi.fn(() => "Example title"),
    isDestroyed: vi.fn(() => false),
    on: vi.fn((event: string, listener: (...args: any[]) => void) => { contentHandlers.set(event, listener); }),
    removeListener: vi.fn((event: string, listener: (...args: any[]) => void) => {
      if (contentHandlers.get(event) === listener) contentHandlers.delete(event);
    }),
    removeAllListeners: vi.fn((event: string) => { contentHandlers.delete(event); }),
    executeJavaScript: vi.fn(async () => undefined),
    executeJavaScriptInIsolatedWorld: vi.fn(async (_worldId: number, scripts: Array<{ code: string }>) => (
      window.eval(scripts[0]?.code ?? "") as unknown
    )),
  };
  const windowStub = {
    webContents: contents,
    getContentSize: vi.fn(() => [800, 600]),
    capturePage: vi.fn(async () => ({ toPNG: () => png })),
  };
  return {
    browserDebugger,
    contentHandlers,
    contents,
    debuggerHandlers,
    fetch,
    png,
    setCookie,
    sendCommand,
    windowStub,
  };
}

function snapshotNodeId(root: any, elementId: string): string {
  const find = (node: any): string | null => {
    if (node?.attributes?.id === elementId && typeof node.nodeId === "string") return node.nodeId;
    for (const child of node?.children ?? []) {
      const nodeId = find(child);
      if (nodeId) return nodeId;
    }
    return null;
  };
  const nodeId = find(root);
  if (!nodeId) throw new Error(`Snapshot node ${elementId} was not found.`);
  return nodeId;
}

function advancedDomInput(code: string): { action?: string; args?: Record<string, unknown> } | null {
  const encoded = /atob\("([^"]+)"\)/u.exec(code)?.[1];
  return encoded ? JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) : null;
}

describe("Browser Agent advanced driver", () => {
  beforeEach(() => {
    document.title = "Advanced fixture";
    document.body.innerHTML = `
      <main data-testid="main">
        <h2>Browser controls</h2>
        <div id="status-wrapper"><span>Ready now</span></div>
        <button id="continue">Continue</button>
        <label for="query">Query</label>
        <input id="query" placeholder="Search" />
        <input id="password-secret" type="password" value="hunter2" />
        <input id="hidden-secret" type="hidden" value="hidden-token" data-auth-token="raw-token" />
        <input id="agree" type="checkbox" />
        <input id="upload" type="file" />
        <select id="color"><option value="red">Red</option><option value="blue">Blue</option></select>
        <img class="hero" src="https://example.com/hero.png" alt="Hero" />
      </main>
    `;
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 10, y: 20, left: 10, top: 20, right: 110, bottom: 50, width: 100, height: 30 }),
    });
    Object.defineProperty(window.performance, "getEntriesByType", {
      configurable: true,
      value: () => [],
    });
    Object.defineProperty(window, "CSS", {
      configurable: true,
      value: { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&") },
    });
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: () => [document.querySelector("#continue")],
    });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => document.querySelector("#continue"),
    });
  });

  it("captures DOM state and performs semantic locator and DOM-node actions", async () => {
    const harness = createHarness();
    const driver = await createBrowserAdvancedDriver({ window: harness.windowStub });

    const snapshot = await driver.execute("snapshot", { boxes: true }) as any;
    expect(snapshot.title).toBe("Advanced fixture");
    expect(JSON.stringify(snapshot.root)).toContain("Continue");

    await expect(driver.execute("locator", {
      action: "count",
      locator: { strategy: "role", value: "button", name: "Continue", exact: true },
    })).resolves.toEqual({ count: 1 });
    await expect(driver.execute("locator", {
      action: "count",
      locator: { strategy: "role", value: "heading", name: "Browser controls", exact: true },
    })).resolves.toEqual({ count: 1 });
    await expect(driver.execute("locator", {
      action: "count",
      locator: { strategy: "text", value: "Ready now", exact: true },
    })).resolves.toEqual({ count: 1 });
    await driver.execute("locator", {
      action: "fill",
      locator: { strategy: "label", value: "Query", exact: true },
      value: "rudder",
    });
    expect((document.querySelector("#query") as HTMLInputElement).value).toBe("rudder");
    await driver.execute("locator", {
      action: "setChecked",
      locator: { strategy: "css", value: "#agree" },
      checked: true,
    });
    expect((document.querySelector("#agree") as HTMLInputElement).checked).toBe(true);
    await driver.execute("locator", {
      action: "select",
      locator: { strategy: "css", value: "#color" },
      values: ["blue"],
    });
    expect((document.querySelector("#color") as HTMLSelectElement).value).toBe("blue");
    await expect(driver.execute("locator", {
      action: "click",
      locator: { strategy: "css", value: "#continue" },
    })).resolves.toMatchObject({ performed: true });
    expect(harness.sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", expect.objectContaining({
      type: "mousePressed",
      x: 60,
      y: 35,
    }));

    const dom = await driver.execute("dom_cua", { action: "get", boxes: true }) as any;
    const serialized = JSON.stringify(dom.root);
    const nodeId = /"nodeId":"([^"]+)"[^}]*"tag":"button"/.exec(serialized)?.[1];
    expect(nodeId).toBeTruthy();
    const clicked = vi.fn();
    document.querySelector("#continue")?.addEventListener("click", clicked);
    await driver.execute("dom_cua", { action: "click", nodeId });
    expect(clicked).toHaveBeenCalledTimes(1);

    await driver.dispose();
    expect(harness.browserDebugger.detach).toHaveBeenCalledTimes(1);
  });

  it("uses CDP for trusted CUA, isolated virtual clipboard shortcuts, dialogs, and screenshots", async () => {
    const harness = createHarness();
    const driver = await createBrowserAdvancedDriver({ window: harness.windowStub });

    await driver.execute("cua", { action: "click", x: 40, y: 50, keys: ["Shift"] });
    await driver.execute("cua", { action: "keypress", keys: ["ControlOrMeta", "a"] });
    await driver.execute("cua", { action: "type", text: "hello" });
    expect(harness.sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", expect.objectContaining({ type: "mousePressed", x: 40, y: 50 }));
    expect(harness.sendCommand).toHaveBeenCalledWith("Input.insertText", { text: "hello" });

    const query = document.querySelector("#query") as HTMLInputElement;
    query.value = "private clipboard";
    query.focus();
    query.setSelectionRange(0, 7);
    await driver.execute("cua", { action: "keypress", keys: ["ControlOrMeta", "c"] });
    await expect(driver.execute("clipboard", { action: "read" })).resolves.toEqual({
      items: [{ entries: [{ mimeType: "text/plain", text: "private" }] }],
    });
    expect(harness.sendCommand).not.toHaveBeenCalledWith("Input.dispatchKeyEvent", expect.objectContaining({ key: "c" }));

    query.setSelectionRange(query.value.length, query.value.length);
    await driver.execute("cua", { action: "keypress", keys: ["Meta", "v"] });
    expect(query.value).toBe("private clipboardprivate");
    expect(harness.sendCommand).not.toHaveBeenCalledWith("Input.dispatchKeyEvent", expect.objectContaining({ key: "v" }));

    await expect(driver.execute("evaluate" as any, { function: "() => document.cookie" }))
      .rejects.toThrow(/unsupported|disabled/i);

    harness.debuggerHandlers.get("message")?.({}, "Page.javascriptDialogOpening", {
      type: "prompt",
      message: "Name?",
      defaultPrompt: "Rudder",
    });
    await expect(driver.execute("dialog", { action: "get" })).resolves.toMatchObject({
      dialog: { type: "prompt", message: "Name?" },
    });
    await expect(driver.execute("dialog", { action: "accept", promptText: "Agent" })).rejects.toThrow(/unavailable.*dismissed/i);
    expect(harness.sendCommand).toHaveBeenCalledWith("Page.handleJavaScriptDialog", { accept: false });

    const screenshot = await driver.execute("screenshot", { fullPage: true, format: "png" }) as any;
    expect(screenshot.base64).toBe(harness.png.toString("base64"));
    expect(harness.sendCommand).toHaveBeenCalledWith("Page.captureScreenshot", expect.objectContaining({
      captureBeyondViewport: true,
      clip: expect.objectContaining({ width: 800, height: 1200 }),
    }));
    await driver.dispose();
  });

  it("takes ownership of Electron dialogs and settles their native callback", async () => {
    const harness = createHarness();
    const electronDefaultHandler = vi.fn();
    harness.contentHandlers.set("-run-dialog", electronDefaultHandler);
    const driver = await createBrowserAdvancedDriver({ window: harness.windowStub });
    const callback = vi.fn((accepted: boolean) => {
      harness.debuggerHandlers.get("message")?.({}, "Page.javascriptDialogClosed", { result: accepted });
    });
    harness.contentHandlers.get("-run-dialog")?.({
      dialogType: "prompt",
      messageText: "Name?",
      defaultPromptText: "Rudder",
      frame: { url: "https://example.com/frame" },
    }, callback);

    await expect(driver.execute("dialog", { action: "get" })).resolves.toMatchObject({
      dialog: { type: "prompt", message: "Name?", defaultPrompt: "Rudder" },
    });
    await expect(driver.execute("dialog", { action: "accept", promptText: "Agent" })).rejects.toThrow(/unavailable.*dismissed/i);
    expect(callback).toHaveBeenCalledWith(false, "");
    expect(harness.setCookie).not.toHaveBeenCalled();
    expect(electronDefaultHandler).not.toHaveBeenCalled();
    expect(harness.sendCommand).not.toHaveBeenCalledWith("Page.handleJavaScriptDialog", expect.anything());

    await driver.dispose();
  });

  it("returns trusted click control when a dialog opens before mouse release completes", async () => {
    const harness = createHarness();
    const driver = await createBrowserAdvancedDriver({ window: harness.windowStub });
    let releaseMouse: ((value: unknown) => void) | null = null;
    const callback = vi.fn((accepted: boolean) => {
      if (accepted) {
        harness.debuggerHandlers.get("message")?.({}, "Page.javascriptDialogClosed", { result: true });
        releaseMouse?.({});
      }
    });
    harness.sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
        const pending = new Promise((resolve) => { releaseMouse = resolve; });
        harness.contentHandlers.get("-run-dialog")?.({
          dialogType: "confirm",
          messageText: "Continue?",
          defaultPromptText: "",
        }, callback);
        return pending;
      }
      return { method, params };
    });

    await expect(driver.execute("cua", { action: "click", x: 40, y: 50 })).resolves.toEqual({ performed: true });
    await expect(driver.execute("dialog", { action: "get" })).resolves.toMatchObject({
      dialog: { type: "confirm", message: "Continue?" },
    });
    await driver.execute("dialog", { action: "accept" });
    expect(callback).toHaveBeenCalledWith(true, "");

    await driver.dispose();
  });

  it("handles an expected locator prompt atomically", async () => {
    const harness = createHarness();
    const driver = await createBrowserAdvancedDriver({ window: harness.windowStub });
    const callback = vi.fn((accepted: boolean) => {
      if (accepted) harness.debuggerHandlers.get("message")?.({}, "Page.javascriptDialogClosed", { result: true });
    });
    harness.sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
        harness.contentHandlers.get("-run-dialog")?.({
          dialogType: "prompt",
          messageText: "Name?",
          defaultPromptText: "Rudder",
          frame: { url: "https://example.com/form" },
        }, callback);
      }
      return { method, params };
    });

    await expect(driver.execute("locator", {
      action: "click",
      locator: { strategy: "css", value: "#continue" },
      dialogResponse: { accept: true, promptText: "Agent" },
    })).rejects.toThrow(/unavailable.*dismissed/i);
    expect(callback).toHaveBeenCalledWith(false, "");
    expect(harness.setCookie).not.toHaveBeenCalled();

    await driver.dispose();
  });

  it("handles an expected locator prompt through CDP when Electron does not run its dialog callback", async () => {
    const harness = createHarness();
    const driver = await createBrowserAdvancedDriver({ window: harness.windowStub });
    harness.sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
        harness.debuggerHandlers.get("message")?.({}, "Page.javascriptDialogOpening", {
          type: "prompt",
          message: "Name?",
          defaultPrompt: "Rudder",
        });
      }
      return { method, params };
    });

    await expect(driver.execute("locator", {
      action: "click",
      locator: { strategy: "css", value: "#continue" },
      dialogResponse: { accept: true, promptText: "Agent" },
    })).rejects.toThrow(/unavailable.*dismissed/i);
    expect(harness.sendCommand).toHaveBeenCalledWith("Page.handleJavaScriptDialog", {
      accept: false,
    });

    await driver.dispose();
  });

  it("waits for real Chromium network activity before reporting networkidle", async () => {
    const harness = createHarness();
    const driver = await createBrowserAdvancedDriver({ window: harness.windowStub });
    harness.debuggerHandlers.get("message")?.({}, "Network.requestWillBeSent", {
      requestId: "request-1",
      type: "Fetch",
    });
    setTimeout(() => {
      harness.debuggerHandlers.get("message")?.({}, "Network.loadingFinished", { requestId: "request-1" });
    }, 100);
    document.querySelector("#continue")?.addEventListener("click", () => {
      harness.debuggerHandlers.get("message")?.({}, "Page.frameNavigated", {
        frame: { id: "main-frame", loaderId: "loader-2", url: "https://example.com/next" },
      });
    }, { once: true });

    const startedAt = Date.now();
    await driver.execute("locator", {
      action: "click",
      locator: { strategy: "css", value: "#continue" },
      expectNavigation: { waitUntil: "networkidle", timeoutMs: 2_000 },
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(550);
    await driver.dispose();
  });

  it("fails closed for model-supplied upload paths, inspects coordinates, and exports bounded page content", async () => {
    const harness = createHarness();
    const driver = await createBrowserAdvancedDriver({ window: harness.windowStub });
    const directory = await fs.mkdtemp("/tmp/rudder-browser-upload-test-");
    const uploadPath = `${directory}/fixture.txt`;
    await fs.writeFile(uploadPath, "upload payload", "utf8");
    try {
      await expect(driver.execute("locator", {
        action: "setFiles",
        locator: { strategy: "css", value: "#upload" },
        paths: [uploadPath],
      })).rejects.toThrow(/disabled|unsupported/i);
      expect(harness.sendCommand).not.toHaveBeenCalledWith("DOM.setFileInputFiles", expect.anything());

      await expect(driver.execute("cua", { action: "elementInfo", x: 60, y: 35 })).resolves.toMatchObject({
        elements: [expect.objectContaining({ tag: "button", name: "Continue" })],
      });

      await expect(driver.execute("content", { format: "html" })).rejects.toThrow(/disabled|unsupported/i);
      const exported = await driver.execute("content", { format: "text" }) as any;
      await expect(fs.readFile(exported.path, "utf8")).resolves.toBe("Example title");
      expect(exported).toMatchObject({ format: "text", mimeType: "text/plain" });
      await driver.dispose();
      await expect(fs.stat(exported.directoryPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("resolves safe locator operations inside a cross-origin frame context", async () => {
    const harness = createHarness();
    const defaultImplementation = harness.sendCommand.getMockImplementation();
    harness.sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      const expression = String(params?.expression || "");
      if (method === "Page.createIsolatedWorld") {
        return { executionContextId: params?.frameId === "child-frame" ? 22 : 11 };
      }
      if (method === "Runtime.evaluate" && params?.contextId === 11 && expression.includes("HTMLIFrameElement")) {
        return { result: { objectId: "iframe-object" } };
      }
      if (method === "Runtime.callFunctionOn" && params?.objectId === "iframe-object") {
        return { result: { value: { x: 15, y: 25, width: 300, height: 200, clientLeft: 3, clientTop: 4 } } };
      }
      if (method === "DOM.describeNode" && params?.objectId === "iframe-object") {
        return { node: { frameId: "child-frame", backendNodeId: 90 } };
      }
      if (method === "Runtime.evaluate" && params?.contextId === 22 && expression.includes("RUDDER_BROWSER_ADVANCED_DOM_V1")) {
        const encoded = /atob\("([^"]+)"\)/u.exec(expression)?.[1];
        const input = encoded ? JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) : null;
        if (["resolveSelector", "resolveFileInputSelector"].includes(input?.args?.action)) {
          return { result: { value: { selector: "#frame-target" } } };
        }
        if (input?.args?.action === "count") return { result: { value: { count: 1 } } };
        if (input?.args?.action === "focus") {
          return { result: { value: { value: {
            x: Number(input.args.__frameOffsetX) + 5,
            y: Number(input.args.__frameOffsetY) + 7,
            width: 10,
            height: 10,
          } } } };
        }
      }
      if (method === "Runtime.evaluate" && params?.contextId === 22 && expression === "document.querySelector(\"#frame-target\")") {
        return { result: { objectId: "frame-file-input" } };
      }
      if (method === "Runtime.evaluate" && params?.contextId === 22 && expression.includes("const __target")) {
        return { result: { value: "Frame target" } };
      }
      if (method === "DOM.describeNode" && params?.objectId === "frame-file-input") {
        return { node: { backendNodeId: 91 } };
      }
      return defaultImplementation?.(method, params);
    });
    const driver = await createBrowserAdvancedDriver({ window: harness.windowStub });
    const locator = { strategy: "css", value: "#frame-target", frame: ["iframe#cross-origin"] };

    await expect(driver.execute("locator", { action: "count", locator })).resolves.toEqual({ count: 1 });
    await expect(driver.execute("locator", { action: "click", locator })).resolves.toMatchObject({ performed: true });
    expect(harness.sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", expect.objectContaining({
      type: "mousePressed",
      x: 28,
      y: 41,
    }));
    await driver.dispose();
  });

  it("never exposes credentials through snapshots, locator reads, or raw Chromium trees", async () => {
    const harness = createHarness();
    const driver = await createBrowserAdvancedDriver({ window: harness.windowStub });

    const snapshot = await driver.execute("snapshot", { maxNodes: 20 }) as unknown;
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("hidden-token");
    expect(serialized).not.toContain("raw-token");
    expect(harness.sendCommand).not.toHaveBeenCalledWith("DOMSnapshot.captureSnapshot", expect.anything());
    expect(harness.sendCommand).not.toHaveBeenCalledWith("Accessibility.getFullAXTree", expect.anything());

    await expect(driver.execute("locator", {
      action: "value",
      locator: { strategy: "css", value: "#password-secret" },
    })).resolves.toEqual({ value: null, redacted: true });
    await expect(driver.execute("locator", {
      action: "attribute",
      name: "value",
      locator: { strategy: "css", value: "#hidden-secret" },
    })).resolves.toEqual({ value: null, redacted: true });
    await driver.dispose();
  });

  it("does not inspect a huge live child collection after maxNodes is exhausted", async () => {
    const harness = createHarness();
    const root = document.documentElement;
    let childCollectionReads = 0;
    let indexedChildReads = 0;
    const virtualChildren = new Proxy({ length: 1_000_000 }, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/u.test(property)) {
          indexedChildReads += 1;
          return document.head;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    Object.defineProperty(root, "children", {
      configurable: true,
      get() {
        childCollectionReads += 1;
        return virtualChildren;
      },
    });
    const driver = await createBrowserAdvancedDriver({ window: harness.windowStub });

    let snapshot: any;
    try {
      snapshot = await driver.execute("snapshot", { depth: 30, maxNodes: 1 });
    } finally {
      delete (root as HTMLElement & { children?: HTMLCollection }).children;
    }

    expect(snapshot.nodeCount).toBe(1);
    expect(snapshot.truncated).toBe(true);
    expect(childCollectionReads).toBe(0);
    expect(indexedChildReads).toBe(0);
    expect(harness.sendCommand).not.toHaveBeenCalledWith("DOMSnapshot.captureSnapshot", expect.anything());
    expect(harness.sendCommand).not.toHaveBeenCalledWith("Accessibility.getFullAXTree", expect.anything());
    await driver.dispose();
  }, 15_000);

  it("bounds descendant text work while deriving an accessible name", async () => {
    const harness = createHarness();
    const label = document.createElement("div");
    label.id = "huge-label";
    let nodeValueReads = 0;
    for (let index = 0; index < 10_000; index += 1) {
      const value = index === 0 ? `Bounded target ${"x".repeat(200)}` : "x".repeat(200);
      const text = document.createTextNode(value);
      Object.defineProperty(text, "nodeValue", {
        configurable: true,
        get() {
          nodeValueReads += 1;
          return value;
        },
      });
      label.append(text);
    }
    Object.defineProperty(label, "textContent", {
      configurable: true,
      get() {
        throw new Error("unbounded descendant textContent access");
      },
    });
    const button = document.createElement("button");
    button.setAttribute("aria-labelledby", label.id);
    document.body.append(label, button);
    const driver = await createBrowserAdvancedDriver({ window: harness.windowStub });

    await expect(driver.execute("locator", {
      action: "count",
      locator: { strategy: "role", value: "button", name: "Bounded target" },
    })).resolves.toEqual({ count: 1 });
    expect(nodeValueReads).toBeGreaterThan(0);
    expect(nodeValueReads).toBeLessThan(20);
    await driver.dispose();
  }, 15_000);

  it("does not install the run clipboard in the page world", async () => {
    const harness = createHarness();
    const driver = await createBrowserAdvancedDriver({ window: harness.windowStub });
    const injectedSources = harness.sendCommand.mock.calls
      .filter(([method]) => method === "Page.addScriptToEvaluateOnNewDocument")
      .map(([, params]) => String(params?.source || ""))
      .join("\n");
    expect(injectedSources).not.toContain("navigator, \"clipboard\"");
    expect(injectedSources).not.toContain("navigator.clipboard");
    await driver.dispose();
  });

  it("rejects a connected DOM node whose immutable interaction fingerprint changed", async () => {
    const harness = createHarness();
    const driver = await createBrowserAdvancedDriver({ window: harness.windowStub });
    const dom = await driver.execute("dom_cua", { action: "get" }) as any;
    const serialized = JSON.stringify(dom.root);
    const nodeId = /"nodeId":"([^"]+)"[^}]*"tag":"button"/.exec(serialized)?.[1];
    const button = document.querySelector("#continue") as HTMLButtonElement;
    const clicked = vi.fn();
    button.addEventListener("click", clicked);
    button.textContent = "Delete account";
    button.setAttribute("aria-label", "Delete account");

    await expect(driver.execute("dom_cua", { action: "click", nodeId })).rejects.toThrow(/stale|fresh snapshot/i);
    expect(clicked).not.toHaveBeenCalled();
    await driver.dispose();
  });

  it("invalidates DOM nodes when their form destination or editability changes", async () => {
    const harness = createHarness();
    const form = document.createElement("form");
    form.id = "checkout";
    form.action = "https://example.com/review";
    form.method = "post";
    form.innerHTML = '<input id="order" name="order" /><button id="purchase" type="submit">Purchase</button>';
    document.body.append(form);
    const driver = await createBrowserAdvancedDriver({ window: harness.windowStub });
    const firstSnapshot = await driver.execute("dom_cua", { action: "get" }) as any;
    const purchaseNodeId = snapshotNodeId(firstSnapshot.root, "purchase");

    form.action = "https://attacker.example/collect";
    await expect(driver.execute("dom_cua", { action: "click", nodeId: purchaseNodeId }))
      .rejects.toThrow(/stale|fresh snapshot/i);

    const secondSnapshot = await driver.execute("dom_cua", { action: "get" }) as any;
    const orderNodeId = snapshotNodeId(secondSnapshot.root, "order");
    (form.querySelector("#order") as HTMLInputElement).readOnly = true;
    await expect(driver.execute("dom_cua", { action: "click", nodeId: orderNodeId }))
      .rejects.toThrow(/stale|fresh snapshot/i);
    await driver.dispose();
  });

  it("revalidates a DOM node after focus changes its label and form action", async () => {
    const harness = createHarness();
    const form = document.createElement("form");
    form.action = "https://example.com/review";
    const button = document.createElement("button");
    button.id = "focus-purchase";
    button.textContent = "Review purchase";
    form.append(button);
    document.body.append(form);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => button });
    button.addEventListener("focus", () => {
      button.setAttribute("aria-label", "Transfer funds");
      form.action = "https://attacker.example/collect";
    }, { once: true });
    const driver = await createBrowserAdvancedDriver({ window: harness.windowStub });
    const snapshot = await driver.execute("dom_cua", { action: "get" }) as any;
    const nodeId = snapshotNodeId(snapshot.root, button.id);

    await expect(driver.execute("dom_cua", { action: "click", nodeId }))
      .rejects.toThrow(/stale|fresh snapshot/i);
    expect(harness.sendCommand).not.toHaveBeenCalledWith("Input.dispatchMouseEvent", expect.anything());
    await driver.dispose();
  });

  it("rejects invisible, zero-sized, disabled, and covered DOM nodes", async () => {
    const harness = createHarness();
    const cases = ["invisible-target", "zero-target", "disabled-target", "covered-target"];
    for (const id of cases) {
      const button = document.createElement("button");
      button.id = id;
      button.textContent = id;
      document.body.append(button);
    }
    const invisible = document.querySelector("#invisible-target") as HTMLButtonElement;
    invisible.style.visibility = "hidden";
    const zero = document.querySelector("#zero-target") as HTMLButtonElement;
    Object.defineProperty(zero, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 10, y: 20, left: 10, top: 20, right: 10, bottom: 20, width: 0, height: 0 }),
    });
    const disabled = document.querySelector("#disabled-target") as HTMLButtonElement;
    disabled.disabled = true;
    const covered = document.querySelector("#covered-target") as HTMLButtonElement;
    const overlay = document.createElement("div");
    document.body.append(overlay);
    const driver = await createBrowserAdvancedDriver({ window: harness.windowStub });

    for (const target of [invisible, zero, disabled]) {
      const snapshot = await driver.execute("dom_cua", { action: "get" }) as any;
      await expect(driver.execute("dom_cua", { action: "click", nodeId: snapshotNodeId(snapshot.root, target.id) }))
        .rejects.toThrow(/stale|interactable|fresh snapshot/i);
    }

    const snapshot = await driver.execute("dom_cua", { action: "get" }) as any;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => overlay });
    await expect(driver.execute("dom_cua", { action: "click", nodeId: snapshotNodeId(snapshot.root, covered.id) }))
      .rejects.toThrow(/stale|interactable|fresh snapshot/i);
    await driver.dispose();
  });

  it("revalidates the topmost DOM hit target immediately before trusted dispatch", async () => {
    const harness = createHarness();
    const button = document.querySelector("#continue") as HTMLButtonElement;
    const overlay = document.createElement("div");
    const evaluate = harness.contents.executeJavaScriptInIsolatedWorld.getMockImplementation();
    harness.contents.executeJavaScriptInIsolatedWorld.mockImplementation(async (worldId, scripts, userGesture) => {
      const result = await evaluate?.(worldId, scripts, userGesture);
      const input = advancedDomInput(scripts[0]?.code ?? "");
      if (input?.action === "dom_cua" && input.args?.action === "click") {
        document.body.append(overlay);
        Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => overlay });
      }
      return result;
    });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => button });
    const driver = await createBrowserAdvancedDriver({ window: harness.windowStub });
    const snapshot = await driver.execute("dom_cua", { action: "get" }) as any;

    await expect(driver.execute("dom_cua", { action: "click", nodeId: snapshotNodeId(snapshot.root, button.id) }))
      .rejects.toThrow(/stale|interactable|fresh snapshot/i);
    expect(harness.sendCommand).not.toHaveBeenCalledWith("Input.dispatchMouseEvent", expect.anything());
    await driver.dispose();
  });

  it("does not expose credential-bearing inline SVG markup in asset inventories or bundles", async () => {
    const harness = createHarness();
    document.body.insertAdjacentHTML("beforeend", `
      <svg id="credential-svg" width="640" height="480" data-token="svg-secret" onload="steal()">
        <a href="javascript:steal()"><text>public shape</text></a>
        <foreignObject><input type="hidden" value="foreign-secret" /></foreignObject>
      </svg>
    `);
    const driver = await createBrowserAdvancedDriver({ window: harness.windowStub });

    const inventory = await driver.execute("assets", { action: "list" }) as any;
    const serializedInventory = JSON.stringify(inventory);
    expect(inventory.inlineSvgs).toEqual([
      expect.objectContaining({ id: "inline-svg-1", type: "image/svg+xml", origin: "inline", width: 640, height: 480 }),
    ]);
    for (const leaked of ["svg-secret", "foreign-secret", "credential-svg", "foreignObject", "onload", "javascript:", "markup", "<svg"]) {
      expect(serializedInventory).not.toContain(leaked);
    }

    const bundle = await driver.execute("assets", {
      action: "bundle",
      inventoryId: inventory.id,
      assetIds: [inventory.assets[0].id],
    }) as any;
    const manifest = await fs.readFile(bundle.manifestPath, "utf8");
    for (const leaked of ["svg-secret", "foreign-secret", "credential-svg", "foreignObject", "onload", "javascript:", "<svg"]) {
      expect(manifest).not.toContain(leaked);
    }
    await driver.dispose();
  });

  it("buffers logs, inventories assets, downloads media, and removes artifacts on dispose", async () => {
    const harness = createHarness();
    const driver = await createBrowserAdvancedDriver({ window: harness.windowStub });
    harness.contentHandlers.get("console-message")?.({}, { level: "warning", message: "fixture warning", sourceId: "https://example.com/app.js" });
    harness.contentHandlers.get("console-message")?.({}, 2, "legacy warning");

    await expect(driver.execute("logs", { levels: ["warn"] })).resolves.toMatchObject({
      logs: [
        { level: "warn", message: "fixture warning" },
        { level: "warn", message: "legacy warning" },
      ],
    });
    const inventory = await driver.execute("assets", { action: "list" }) as any;
    expect(inventory.assets).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "image", url: "https://example.com/hero.png" })]));
    await expect(driver.execute("assets", { action: "bundle", inventoryId: inventory.id })).rejects.toThrow(/explicit asset ids or kinds/i);
    await expect(driver.execute("assets", {
      action: "bundle",
      inventoryId: inventory.id,
      assetIds: ["asset-does-not-exist"],
    })).rejects.toThrow(/unknown or stale/i);
    const bundle = await driver.execute("assets", {
      action: "bundle",
      inventoryId: inventory.id,
      assetIds: [inventory.assets[0].id],
      maxTotalBytes: 100,
    }) as any;
    expect(bundle.summary).toMatchObject({ totalBytes: 11, maxTotalBytes: 100 });
    harness.debuggerHandlers.get("message")?.({}, "Page.frameNavigated", {
      frame: { id: "main-frame", loaderId: "loader-reload", url: "https://example.com/page" },
    });
    await expect(driver.execute("assets", {
      action: "bundle",
      inventoryId: inventory.id,
      assetIds: [inventory.assets[0].id],
    })).rejects.toThrow(/page navigated/i);
    const refreshedInventory = await driver.execute("assets", { action: "list" }) as any;
    harness.contents.getURL.mockReturnValue("https://example.com/after-navigation");
    await expect(driver.execute("assets", {
      action: "bundle",
      inventoryId: refreshedInventory.id,
      assetIds: [refreshedInventory.assets[0].id],
    })).rejects.toThrow(/page navigated/i);
    harness.contents.getURL.mockReturnValue("https://example.com");

    const download = await driver.execute("download", {
      mode: "media",
      locator: { strategy: "css", value: "img.hero" },
    }) as any;
    expect(download.state).toBe("completed");
    await expect(fs.readFile(download.path, "utf8")).resolves.toBe("asset-bytes");
    expect(harness.fetch).toHaveBeenCalledWith("https://example.com/hero.png", expect.any(Object));

    await driver.dispose();
    await expect(fs.stat(download.directoryPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(bundle.directoryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects full-page screenshots that Chromium would silently truncate", async () => {
    const harness = createHarness();
    const defaultImplementation = harness.sendCommand.getMockImplementation();
    harness.sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === "Page.getLayoutMetrics") return { cssContentSize: { width: 800, height: 20_000 } };
      return defaultImplementation?.(method, params);
    });
    const driver = await createBrowserAdvancedDriver({ window: harness.windowStub });

    await expect(driver.execute("screenshot", { fullPage: true })).rejects.toThrow(/16384-pixel dimension limit/i);
    expect(harness.sendCommand).not.toHaveBeenCalledWith("Page.captureScreenshot", expect.anything());
    await driver.dispose();
  });

  it("cancels a chunked asset response as soon as the bounded download limit is exceeded", async () => {
    const harness = createHarness();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("four"));
        controller.enqueue(Buffer.from("more"));
      },
      cancel,
    });
    harness.fetch.mockResolvedValueOnce(new Response(body, {
      status: 200,
      headers: { "content-type": "image/png" },
    }));
    const driver = await createBrowserAdvancedDriver({ window: harness.windowStub });
    const inventory = await driver.execute("assets", { action: "list" }) as any;

    const bundle = await driver.execute("assets", {
      action: "bundle",
      inventoryId: inventory.id,
      assetIds: [inventory.assets[0].id],
      maxTotalBytes: 5,
    }) as any;

    expect(bundle.summary).toMatchObject({ downloadedCount: 0, failedCount: 1, totalBytes: 0 });
    expect(bundle.failures[0]?.reason).toMatch(/download limit/i);
    expect(cancel).toHaveBeenCalledOnce();
    await driver.dispose();
  });

  it("blocks unsafe asset URLs and redirected Rudder app targets before bytes are persisted", async () => {
    const harness = createHarness();
    const hero = document.querySelector("img.hero") as HTMLImageElement;
    hero.src = "http://127.0.0.1:3100/api/private";
    const driver = await createBrowserAdvancedDriver({
      window: harness.windowStub,
      getRudderAppOrigins: () => ["http://127.0.0.1:3100"],
    });
    const unsafeInventory = await driver.execute("assets", { action: "list" }) as any;
    const unsafeBundle = await driver.execute("assets", {
      action: "bundle",
      inventoryId: unsafeInventory.id,
      assetIds: [unsafeInventory.assets[0].id],
    }) as any;
    expect(unsafeBundle.failures[0]?.reason).toMatch(/unsafe/i);
    expect(harness.fetch).not.toHaveBeenCalled();

    hero.src = "https://example.com/hero.png";
    const cancel = vi.fn();
    const redirectedBody = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from("private")); },
      cancel,
    });
    const redirected = new Response(redirectedBody, { status: 200 });
    Object.defineProperty(redirected, "url", { value: "http://127.0.0.1:3100/api/private" });
    harness.fetch.mockResolvedValueOnce(redirected);
    const redirectInventory = await driver.execute("assets", { action: "list" }) as any;
    const redirectBundle = await driver.execute("assets", {
      action: "bundle",
      inventoryId: redirectInventory.id,
      assetIds: [redirectInventory.assets[0].id],
    }) as any;
    expect(redirectBundle.failures[0]?.reason).toMatch(/redirect target is unsafe/i);
    expect(cancel).toHaveBeenCalledOnce();
    await driver.dispose();
  });

  it("cancels non-OK and declared-oversize asset responses before removing their abort controllers", async () => {
    const harness = createHarness();
    const nonOkCancel = vi.fn();
    const nonOk = new Response(new ReadableStream<Uint8Array>({ cancel: nonOkCancel }), { status: 404 });
    harness.fetch.mockResolvedValueOnce(nonOk);
    const driver = await createBrowserAdvancedDriver({ window: harness.windowStub });
    const inventory = await driver.execute("assets", { action: "list" }) as any;
    const failed = await driver.execute("assets", {
      action: "bundle",
      inventoryId: inventory.id,
      assetIds: [inventory.assets[0].id],
    }) as any;
    expect(failed.failures[0]?.reason).toMatch(/status 404/i);
    expect(nonOkCancel).toHaveBeenCalledOnce();

    const oversizeCancel = vi.fn();
    const oversize = new Response(new ReadableStream<Uint8Array>({ cancel: oversizeCancel }), {
      status: 200,
      headers: { "content-length": "26000000" },
    });
    harness.fetch.mockResolvedValueOnce(oversize);
    const failedOversize = await driver.execute("assets", {
      action: "bundle",
      inventoryId: inventory.id,
      assetIds: [inventory.assets[0].id],
    }) as any;
    expect(failedOversize.failures[0]?.reason).toMatch(/download limit/i);
    expect(oversizeCancel).toHaveBeenCalledOnce();
    await driver.dispose();
  });

  it("aborts an active bundle fetch and starts no later fetch after disposal", async () => {
    const harness = createHarness();
    const secondImage = document.createElement("img");
    secondImage.src = "https://example.com/second.png";
    secondImage.alt = "Second";
    document.body.append(secondImage);
    const observedRequest: { signal: AbortSignal | null } = { signal: null };
    harness.fetch.mockImplementation((_url, init) => new Promise<Response>((_resolve, reject) => {
      observedRequest.signal = init?.signal ?? null;
      observedRequest.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    }));
    const driver = await createBrowserAdvancedDriver({ window: harness.windowStub });
    const inventory = await driver.execute("assets", { action: "list" }) as any;
    const bundle = driver.execute("assets", {
      action: "bundle",
      inventoryId: inventory.id,
      assetIds: inventory.assets.map((asset: { id: string }) => asset.id),
    });
    await vi.waitFor(() => expect(observedRequest.signal).not.toBeNull());

    const disposal = driver.dispose();

    expect(observedRequest.signal?.aborted).toBe(true);
    await Promise.allSettled([bundle, disposal]);
    expect(harness.fetch).toHaveBeenCalledTimes(1);
  });
});
