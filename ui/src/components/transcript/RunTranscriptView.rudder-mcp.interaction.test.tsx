// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptToolCardEntry } from "./RunTranscriptView.common";
import { RudderMcpPresenterProvider, RudderMcpSemanticPresenter } from "./RunTranscriptView.rudder-mcp";

const issues = Array.from({ length: 13 }, (_, index) => ({
  id: `issue-${index + 1}`,
  identifier: `RUD-${index + 1}`,
  title: `Issue ${index + 1}`,
  status: "todo",
}));

const entry: TranscriptToolCardEntry = {
  ts: "2026-08-26T08:00:00.000Z",
  name: "mcp__rudder-tools__rudder_issue_list",
  toolUseId: "issue-list-1",
  input: {},
  result: JSON.stringify({ structuredContent: { result: issues } }),
  status: "completed",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let intersections: IntersectionObserverCallback[] = [];

class MockIntersectionObserver {
  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly thresholds: ReadonlyArray<number> = [];

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    intersections.push(callback);
    this.root = options?.root ?? null;
    this.rootMargin = options?.rootMargin ?? "";
  }

  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = () => [];
}

function Harness() {
  const [visible, setVisible] = useState(true);
  return (
    <RudderMcpPresenterProvider>
      <button type="button" onClick={() => setVisible((value) => !value)}>Toggle</button>
      {visible ? <RudderMcpSemanticPresenter block={entry} /> : null}
    </RudderMcpPresenterProvider>
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState({}, "", "/");
  intersections = [];
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("Rudder MCP semantic rail interactions", () => {
  it("keeps whole-card links native while applying the current organization route", () => {
    window.history.replaceState({}, "", "/RUD/messenger/chat/chat-1");
    act(() => root?.render(<Harness />));
    const link = container?.querySelector<HTMLAnchorElement>("[data-rudder-semantic-card-link='true']");
    expect(link?.tagName).toBe("A");
    expect(link?.getAttribute("href")).toBe("/RUD/issues/RUD-1");
  });

  it("appends six in place, preserves focus, and finishes the final partial batch", () => {
    act(() => root?.render(<Harness />));
    expect(container?.querySelectorAll("[data-rudder-semantic-card-link]")).toHaveLength(6);

    const focused = container?.querySelectorAll<HTMLAnchorElement>("[data-rudder-semantic-card-link]")[2];
    act(() => focused?.focus());
    expect(document.activeElement).toBe(focused);

    act(() => intersections.at(-1)?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(container?.querySelectorAll("[data-rudder-semantic-card-link]")).toHaveLength(12);
    expect(document.activeElement).toBe(focused);

    act(() => intersections.at(-1)?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(container?.querySelectorAll("[data-rudder-semantic-card-link]")).toHaveLength(13);
    expect(container?.querySelector("[data-rudder-semantic-sentinel]")).toBeNull();
  });

  it("restores mounted count and horizontal position after collapse and reopen", () => {
    act(() => root?.render(<Harness />));
    act(() => intersections.at(-1)?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    const rail = container?.querySelector<HTMLElement>("[data-rudder-semantic-rail]");
    expect(rail).toBeTruthy();
    Object.defineProperty(rail!, "scrollLeft", { configurable: true, writable: true, value: 420 });
    act(() => rail?.dispatchEvent(new Event("scroll", { bubbles: true })));

    const toggle = container?.querySelector<HTMLButtonElement>("button");
    act(() => toggle?.click());
    expect(container?.querySelector("[data-rudder-semantic-rail]")).toBeNull();
    act(() => toggle?.click());

    const reopened = container?.querySelector<HTMLElement>("[data-rudder-semantic-rail]");
    expect(container?.querySelectorAll("[data-rudder-semantic-card-link]")).toHaveLength(12);
    expect(reopened?.scrollLeft).toBe(420);
  });

  it("moves the rail with keyboard arrows", () => {
    act(() => root?.render(<Harness />));
    const rail = container?.querySelector<HTMLElement>("[data-rudder-semantic-rail]");
    const scrollBy = vi.fn();
    Object.defineProperty(rail!, "scrollBy", { configurable: true, value: scrollBy });
    act(() => rail?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(scrollBy).toHaveBeenCalledWith({ left: 296, behavior: "smooth" });
  });
});
