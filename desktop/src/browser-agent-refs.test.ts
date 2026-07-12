// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  createBrowserAgentTabController,
  type BrowserAgentTab,
  type BrowserRuntimeIdentity,
} from "./browser-agent-tabs.js";

const owner: BrowserRuntimeIdentity = { orgId: "org-1", agentId: "agent-1", runId: "run-1" };

class DomTab implements BrowserAgentTab {
  private destroyed = false;
  private url = "https://example.com";
  private readonly listeners: Array<() => void> = [];

  async loadURL(url: string) { this.url = url; }
  getURL() { return this.url; }
  getTitle() { return document.title; }
  isDestroyed() { return this.destroyed; }
  stop() {}
  close() {
    this.destroyed = true;
    this.listeners.forEach((listener) => listener());
  }
  onDestroyed(listener: () => void) { this.listeners.push(listener); }
  async executeIsolatedJavaScript(script: string) { return window.eval(script) as unknown; }
  async capturePng() { return Buffer.from("png"); }
}

function createHarness() {
  const tab = new DomTab();
  const controller = createBrowserAgentTabController({
    createId: () => "tab-1",
    createSnapshotId: (() => {
      let id = 0;
      return () => `snapshot-${++id}`;
    })(),
    createTab: async () => tab,
    getControlPlaneOrigins: () => ["http://127.0.0.1:3100"],
  });
  return { controller, tab };
}

async function openAndRead(controller: ReturnType<typeof createBrowserAgentTabController>) {
  await controller.execute({ identity: owner, action: "open", args: { url: "https://example.com" } });
  return await controller.execute({
    identity: owner,
    action: "read",
    args: { tabId: "tab-1" },
  }) as { text: string; refs: Array<{ ref: string; name: string }> };
}

describe("Browser Agent isolated element refs", () => {
  let topmost: Element | null;

  beforeEach(() => {
    document.title = "Hostile page";
    document.body.innerHTML = `
      <button id="approve" type="button">Approve</button>
      <input id="query" type="text" aria-label="Query" />
      <div id="overlay">Overlay</div>
    `;
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 10, y: 10, left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20 }),
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: () => undefined,
    });
    topmost = document.getElementById("approve");
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => topmost,
    });
  });

  it("rejects a same-node label mutation before click", async () => {
    const { controller } = createHarness();
    const snapshot = await openAndRead(controller);
    const approve = snapshot.refs.find((ref) => ref.name === "Approve")!;
    document.getElementById("approve")!.textContent = "Delete everything";

    await expect(controller.execute({
      identity: owner,
      action: "click",
      args: { tabId: "tab-1", ref: approve.ref },
    })).rejects.toMatchObject({ code: "browser_ref_not_found" });
  });

  it("rejects covered, disabled, and input-type-mutated nodes", async () => {
    const covered = createHarness();
    const coveredSnapshot = await openAndRead(covered.controller);
    const approve = coveredSnapshot.refs.find((ref) => ref.name === "Approve")!;
    topmost = document.getElementById("overlay");
    await expect(covered.controller.execute({
      identity: owner,
      action: "click",
      args: { tabId: "tab-1", ref: approve.ref },
    })).rejects.toMatchObject({ code: "browser_ref_not_found" });

    document.body.innerHTML = `<button id="approve" type="button">Approve</button><input id="query" type="text" aria-label="Query" />`;
    topmost = document.getElementById("approve");
    const disabled = createHarness();
    const disabledSnapshot = await openAndRead(disabled.controller);
    const disabledRef = disabledSnapshot.refs.find((ref) => ref.name === "Approve")!;
    (document.getElementById("approve") as HTMLButtonElement).disabled = true;
    await expect(disabled.controller.execute({
      identity: owner,
      action: "click",
      args: { tabId: "tab-1", ref: disabledRef.ref },
    })).rejects.toMatchObject({ code: "browser_ref_not_found" });

    document.body.innerHTML = `<button id="approve" type="button">Approve</button><input id="query" type="text" aria-label="Query" />`;
    topmost = document.getElementById("query");
    const mutated = createHarness();
    const mutatedSnapshot = await openAndRead(mutated.controller);
    const inputRef = mutatedSnapshot.refs.find((ref) => ref.name === "Query")!;
    (document.getElementById("query") as HTMLInputElement).type = "password";
    await expect(mutated.controller.execute({
      identity: owner,
      action: "type",
      args: { tabId: "tab-1", ref: inputRef.ref, text: "secret" },
    })).rejects.toMatchObject({ code: "browser_ref_not_found" });
  });

  it("invalidates every ref after a successful interaction", async () => {
    const { controller } = createHarness();
    const snapshot = await openAndRead(controller);
    const approve = snapshot.refs.find((ref) => ref.name === "Approve")!;
    topmost = document.getElementById("approve");

    await expect(controller.execute({
      identity: owner,
      action: "click",
      args: { tabId: "tab-1", ref: approve.ref },
    })).resolves.toMatchObject({ clicked: true });
    await expect(controller.execute({
      identity: owner,
      action: "click",
      args: { tabId: "tab-1", ref: approve.ref },
    })).rejects.toMatchObject({ code: "browser_ref_not_found" });
  });

  it("rejects owning form action or method changes before type and submit", async () => {
    document.body.innerHTML = `
      <form id="search" action="/search" method="get">
        <input id="query" type="text" aria-label="Query" />
      </form>
    `;
    topmost = document.getElementById("query");
    const { controller } = createHarness();
    const snapshot = await openAndRead(controller);
    const inputRef = snapshot.refs.find((ref) => ref.name === "Query")!;
    const form = document.getElementById("search") as HTMLFormElement;
    form.action = "/delete";
    form.method = "post";

    await expect(controller.execute({
      identity: owner,
      action: "type",
      args: { tabId: "tab-1", ref: inputRef.ref, text: "hello", submit: true },
    })).rejects.toMatchObject({ code: "browser_ref_not_found" });
  });

  it("decodes non-ASCII input payloads as UTF-8", async () => {
    topmost = document.getElementById("query");
    const { controller } = createHarness();
    const snapshot = await openAndRead(controller);
    const inputRef = snapshot.refs.find((ref) => ref.name === "Query")!;

    await expect(controller.execute({
      identity: owner,
      action: "type",
      args: { tabId: "tab-1", ref: inputRef.ref, text: "你好 🌍" },
    })).resolves.toMatchObject({ typed: true, submitted: false });
    expect((document.getElementById("query") as HTMLInputElement).value).toBe("你好 🌍");
  });

  it("reports contenteditable typing as successful after changing its visible text", async () => {
    document.body.innerHTML = `<div id="editor" contenteditable="true">Draft</div>`;
    const editor = document.getElementById("editor")!;
    Object.defineProperty(editor, "isContentEditable", { configurable: true, value: true });
    topmost = editor;
    const { controller } = createHarness();
    const snapshot = await openAndRead(controller);
    const editorRef = snapshot.refs.find((ref) => ref.name === "Draft")!;

    await expect(controller.execute({
      identity: owner,
      action: "type",
      args: { tabId: "tab-1", ref: editorRef.ref, text: "Published" },
    })).resolves.toMatchObject({ typed: true, submitted: false });
    expect(editor.textContent).toBe("Published");
  });

  it("omits text and controls hidden by an ancestor", async () => {
    document.body.innerHTML = `
      <p>VISIBLE_TEXT</p>
      <section aria-hidden="true"><p>HIDDEN_SECRET</p><button>Hidden action</button></section>
      <section inert><p>INERT_SECRET</p></section>
    `;
    topmost = document.querySelector("button");
    const { controller } = createHarness();
    const snapshot = await openAndRead(controller);

    expect(snapshot.text).toContain("VISIBLE_TEXT");
    expect(snapshot.text).not.toContain("HIDDEN_SECRET");
    expect(snapshot.text).not.toContain("INERT_SECRET");
    expect(snapshot.refs).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Hidden action" }),
    ]));
  });

  it("includes rendered text below the viewport while keeping refs viewport-bound", async () => {
    document.body.innerHTML = `<p id="top">TOP_TEXT</p><p id="below"><button>Below action</button>BELOW_FOLD_TEXT</p>`;
    Object.defineProperty(document.getElementById("below"), "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 10, y: 2_000, left: 10, top: 2_000, right: 110, bottom: 2_020, width: 100, height: 20 }),
    });
    Object.defineProperty(document.querySelector("button"), "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 10, y: 2_000, left: 10, top: 2_000, right: 110, bottom: 2_020, width: 100, height: 20 }),
    });
    topmost = document.querySelector("button");
    const { controller } = createHarness();
    const snapshot = await openAndRead(controller);

    expect(snapshot.text).toContain("TOP_TEXT");
    expect(snapshot.text).toContain("BELOW_FOLD_TEXT");
    expect(snapshot.refs).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Below action" }),
    ]));
  });

  it("rejects a form mutated by focus or input handlers before submission", async () => {
    document.body.innerHTML = `
      <form id="search" action="/search" method="get">
        <input id="query" name="query" type="text" aria-label="Query" />
      </form>
    `;
    topmost = document.getElementById("query");
    const form = document.getElementById("search") as HTMLFormElement;
    const input = document.getElementById("query") as HTMLInputElement;
    let submitCalls = 0;
    form.requestSubmit = () => { submitCalls += 1; };
    input.addEventListener("focus", () => {
      form.action = "/delete";
      form.method = "post";
      form.target = "_blank";
      input.name = "confirm_delete";
    });

    const { controller } = createHarness();
    const snapshot = await openAndRead(controller);
    const inputRef = snapshot.refs.find((ref) => ref.name === "Query")!;
    await expect(controller.execute({
      identity: owner,
      action: "type",
      args: { tabId: "tab-1", ref: inputRef.ref, text: "confirm", submit: true },
    })).rejects.toMatchObject({ code: "browser_ref_not_found" });
    expect(submitCalls).toBe(0);
  });

  it("reports submit only after an uncancelled submit event", async () => {
    document.body.innerHTML = `
      <form id="search" action="/search" method="get">
        <input id="query" name="query" required type="text" aria-label="Query" />
      </form>
    `;
    topmost = document.getElementById("query");
    const form = document.getElementById("search") as HTMLFormElement;
    form.requestSubmit = () => {
      form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    };
    form.addEventListener("submit", (event) => event.preventDefault());

    const { controller } = createHarness();
    const snapshot = await openAndRead(controller);
    const inputRef = snapshot.refs.find((ref) => ref.name === "Query")!;
    await expect(controller.execute({
      identity: owner,
      action: "type",
      args: { tabId: "tab-1", ref: inputRef.ref, text: "hello", submit: true },
    })).resolves.toMatchObject({ typed: true, submitted: false });
  });

  it("observes an uncancelled submit even when a form listener stops propagation", async () => {
    document.body.innerHTML = `
      <form id="search" action="/search" method="get">
        <input id="query" name="query" type="text" aria-label="Query" />
      </form>
    `;
    topmost = document.getElementById("query");
    const form = document.getElementById("search") as HTMLFormElement;
    form.addEventListener("submit", (event) => event.stopPropagation());
    form.requestSubmit = () => {
      form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    };

    const { controller } = createHarness();
    const snapshot = await openAndRead(controller);
    const inputRef = snapshot.refs.find((ref) => ref.name === "Query")!;
    await expect(controller.execute({
      identity: owner,
      action: "type",
      args: { tabId: "tab-1", ref: inputRef.ref, text: "hello", submit: true },
    })).resolves.toMatchObject({ typed: true, submitted: true });
  });
});
