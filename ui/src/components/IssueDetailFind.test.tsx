// @vitest-environment jsdom

import { act, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueDetailFind } from "./IssueDetailFind";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: ({ ...props }: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock("lucide-react", () => {
  const Icon = () => <span />;
  return {
    ArrowDown: Icon,
    ArrowUp: Icon,
    Search: Icon,
    X: Icon,
  };
});

function Harness() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  return (
    <div>
      <IssueDetailFind rootRef={rootRef} />
      <section ref={rootRef}>
        <h1>Esc does not close issue detail</h1>
        <p>Issue comments mention detail again.</p>
      </section>
    </div>
  );
}

describe("IssueDetailFind", () => {
  let cleanup: (() => void) | null = null;

  beforeEach(() => {
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("opens from Command+F, counts matches, navigates, and cleans up on Escape", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanup = () => {
      act(() => root.unmount());
      container.remove();
    };

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true }));
      await Promise.resolve();
    });

    const input = document.querySelector<HTMLInputElement>("input[aria-label='Find in issue']");
    expect(input).not.toBeNull();

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(input, "detail");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("1 of 2");
    expect(document.querySelectorAll("mark[data-issue-find-highlight='true']")).toHaveLength(2);
    expect(document.querySelector(".issue-find-highlight--active")?.textContent).toBe("detail");

    await act(async () => {
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });

    expect(document.querySelector(".issue-find-highlight--active")?.textContent).toBe("detail");
    expect(document.body.textContent).toContain("2 of 2");

    await act(async () => {
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
    });

    expect(document.querySelector("input[aria-label='Find in issue']")).toBeNull();
    expect(document.querySelector("mark[data-issue-find-highlight='true']")).toBeNull();
  });
});
