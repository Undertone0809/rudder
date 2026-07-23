// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SelectionAnnotationToolbar,
  placeSelectionAnnotationToolbar,
} from "./SelectionAnnotationToolbar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("selection annotation toolbar", () => {
  it("flips below and shifts inside the viewport", () => {
    expect(placeSelectionAnnotationToolbar(
      { left: 390, right: 410, top: 4, bottom: 24, width: 20, height: 20 },
      { width: 180, height: 36 },
      { width: 420, height: 820, padding: 8, gap: 8 },
    )).toEqual({
      left: 232,
      top: 32,
      placement: "bottom",
    });
  });

  it("renders in a portal and supports arrow keys, activation, Escape, and focus return", () => {
    const onAddToChat = vi.fn();
    const onMoreDetails = vi.fn();
    const onAskInSideChat = vi.fn();
    const onDismiss = vi.fn();
    const focusReturn = document.createElement("button");
    document.body.appendChild(focusReturn);
    const returnFocusRef = { current: focusReturn };

    act(() => {
      root.render(
        <SelectionAnnotationToolbar
          open
          anchorRect={{ left: 40, right: 140, top: 100, bottom: 120, width: 100, height: 20 }}
          onAddToChat={onAddToChat}
          onMoreDetails={onMoreDetails}
          onAskInSideChat={onAskInSideChat}
          onDismiss={onDismiss}
          returnFocusRef={returnFocusRef}
          autoFocus
        />,
      );
    });

    expect(host.children).toHaveLength(0);
    const toolbar = document.body.querySelector("[role='toolbar']")!;
    const buttons = Array.from(toolbar.querySelectorAll("button"));
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Add to chat",
      "More details",
      "Ask in side chat",
    ]);
    expect(document.activeElement).toBe(buttons[0]);

    act(() => {
      buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(document.activeElement).toBe(buttons[1]);

    act(() => {
      buttons[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onMoreDetails).toHaveBeenCalledOnce();

    act(() => {
      toolbar.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(focusReturn);

    focusReturn.remove();
  });

  it("uses coarse-pointer 44px targets and reduced-motion-safe classes", () => {
    act(() => {
      root.render(
        <SelectionAnnotationToolbar
          open
          anchorRect={{ left: 40, right: 140, top: 100, bottom: 120, width: 100, height: 20 }}
          onAddToChat={vi.fn()}
          onMoreDetails={vi.fn()}
          onAskInSideChat={vi.fn()}
          onDismiss={vi.fn()}
        />,
      );
    });

    const firstButton = document.body.querySelector("[role='toolbar'] button")!;
    expect(firstButton.className).toContain("[@media(pointer:coarse)]:min-h-11");
    expect(firstButton.className).toContain("motion-reduce:transition-none");
  });
});
