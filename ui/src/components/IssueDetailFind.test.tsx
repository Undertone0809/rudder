// @vitest-environment jsdom

import { act, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, useRef, useState } from "react";
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

function CustomLabelHarness() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  return (
    <div>
      <IssueDetailFind rootRef={rootRef} searchLabel="Find in Library" />
      <section ref={rootRef}>
        <p>Library document content</p>
      </section>
    </div>
  );
}

function DynamicCssHarness() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  return (
    <div>
      <IssueDetailFind rootRef={rootRef} highlightMode="css" />
      <button type="button" data-testid="load-content" onClick={() => setLoaded(true)}>Load content</button>
      <section ref={rootRef}>
        <p>Initial content</p>
        {loaded ? <p>Dynamically loaded result</p> : null}
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
    expect(document.querySelector("[data-detail-escape-layer='true']")).not.toBeNull();

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

  it("uses a contextual search label when provided", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanup = () => {
      act(() => root.unmount());
      container.remove();
    };

    await act(async () => {
      root.render(<CustomLabelHarness />);
      await Promise.resolve();
    });

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true }));
      await Promise.resolve();
    });

    expect(document.querySelector<HTMLInputElement>("input[aria-label='Find in Library']")).not.toBeNull();
    expect(document.querySelector("[role='search']")?.getAttribute("aria-label")).toBe("Find in Library");
  });

  it("refreshes a CSS-highlight query when asynchronous content enters the root", async () => {
    const highlights = new Map<string, { size: number }>();
    class TestHighlight {
      size: number;

      constructor(...ranges: Range[]) {
        this.size = ranges.length;
      }
    }
    Object.defineProperty(window, "CSS", {
      configurable: true,
      value: { highlights },
    });
    Object.defineProperty(window, "Highlight", {
      configurable: true,
      value: TestHighlight,
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanup = () => {
      act(() => root.unmount());
      container.remove();
    };

    await act(async () => {
      root.render(<DynamicCssHarness />);
      await Promise.resolve();
    });
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true }));
      await Promise.resolve();
    });

    const input = document.querySelector<HTMLInputElement>("input[aria-label='Find in issue']");
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(input, "Dynamically loaded result");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("0 of 0");

    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-testid='load-content']")!.click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("1 of 1");
    expect(highlights.get("rudder-issue-find-highlight")?.size).toBe(1);
  });
});
