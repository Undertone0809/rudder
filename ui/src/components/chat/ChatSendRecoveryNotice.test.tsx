// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSendRecoveryCheckingNotice } from "./ChatSendRecoveryNotice";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function render(checking: boolean, scope = "chat-1") {
  act(() => root.render(<ChatSendRecoveryCheckingNotice key={scope} checking={checking} />));
}

describe("recovery checking presentation", () => {
  it("never paints a brief check or its cancelled timer", () => {
    render(true);
    act(() => vi.advanceTimersByTime(249));
    expect(container.textContent).toBe("");
    render(false);
    act(() => vi.advanceTimersByTime(1000));
    expect(container.textContent).toBe("");
  });

  it("explains a sustained check and hides immediately when it finishes or a live send takes over", () => {
    render(true);
    act(() => vi.advanceTimersByTime(250));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Checking the previous message");
    render(false);
    expect(container.textContent).toBe("");
    render(true);
    expect(container.textContent).toBe("");
    act(() => vi.advanceTimersByTime(249));
    expect(container.textContent).toBe("");
  });

  it("does not carry a visible notice or pending timer into another draft scope", () => {
    render(true);
    act(() => vi.advanceTimersByTime(250));
    render(true, "chat-2");
    expect(container.textContent).toBe("");
    act(() => vi.advanceTimersByTime(100));
    render(false, "chat-3");
    act(() => vi.advanceTimersByTime(1000));
    expect(container.textContent).toBe("");
  });
});
