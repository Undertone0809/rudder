// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isUsableSelectionAnnotationRect,
  placeSelectionAnnotationToolbar,
  SelectionAnnotationToolbar,
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
  it("rejects zero, non-finite, and dimensionless selection geometry", () => {
    expect(isUsableSelectionAnnotationRect({
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      width: 0,
      height: 0,
    })).toBe(false);
    expect(isUsableSelectionAnnotationRect({
      left: Number.NaN,
      right: 40,
      top: 20,
      bottom: 40,
      width: 40,
      height: 20,
    })).toBe(false);
    expect(isUsableSelectionAnnotationRect({
      left: 20,
      right: 20,
      top: 20,
      bottom: 40,
      width: 0,
      height: 20,
    })).toBe(false);
    expect(isUsableSelectionAnnotationRect({
      left: 20,
      right: 60,
      top: 20,
      bottom: 40,
      width: 40,
      height: 20,
    })).toBe(true);
  });

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

  it("flips and shifts inside an optional container boundary", () => {
    expect(placeSelectionAnnotationToolbar(
      { left: 490, right: 510, top: 44, bottom: 64, width: 20, height: 20 },
      { width: 180, height: 36 },
      {
        width: 1_000,
        height: 820,
        padding: 8,
        gap: 8,
        boundaryRect: {
          left: 200,
          right: 520,
          top: 36,
          bottom: 500,
          width: 320,
          height: 464,
        },
      },
    )).toEqual({
      left: 332,
      top: 72,
      placement: "bottom",
    });
  });

  it("renders in a portal and supports arrow keys, activation, Escape, and focus return", () => {
    const onAddToChat = vi.fn();
    const onAskInSideChat = vi.fn();
    const onDismiss = vi.fn();
    const focusReturn = document.createElement("button");
    document.body.appendChild(focusReturn);
    const onReturnFocus = vi.fn(() => focusReturn.focus());

    act(() => {
      root.render(
        <SelectionAnnotationToolbar
          open
          anchorRect={{ left: 40, right: 140, top: 100, bottom: 120, width: 100, height: 20 }}
          onAddToChat={onAddToChat}
          onAskInSideChat={onAskInSideChat}
          onDismiss={onDismiss}
          onReturnFocus={onReturnFocus}
          autoFocus
        />,
      );
    });

    expect(host.children).toHaveLength(0);
    const toolbar = document.body.querySelector("[role='toolbar']")!;
    const buttons = Array.from(toolbar.querySelectorAll("button"));
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Add to chat",
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
    expect(onAskInSideChat).toHaveBeenCalledOnce();

    act(() => {
      toolbar.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onReturnFocus).toHaveBeenCalledOnce();
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
          onAskInSideChat={vi.fn()}
          onDismiss={vi.fn()}
        />,
      );
    });

    const firstButton = document.body.querySelector("[role='toolbar'] button")!;
    expect(firstButton.className).toContain("[@media(pointer:coarse)]:min-h-11");
    expect(firstButton.className).toContain("motion-reduce:transition-none");
  });

  it("disables Side Chat when the owning assistant message is not completed", () => {
    act(() => {
      root.render(
        <SelectionAnnotationToolbar
          open
          anchorRect={{ left: 40, right: 140, top: 100, bottom: 120, width: 100, height: 20 }}
          onAddToChat={vi.fn()}
          onAskInSideChat={vi.fn()}
          askInSideChatDisabled
          onDismiss={vi.fn()}
        />,
      );
    });

    const sideChat = document.body.querySelector<HTMLButtonElement>(
      "[role='toolbar'] button:last-child",
    );
    expect(sideChat?.disabled).toBe(true);
    expect(sideChat?.getAttribute("aria-disabled")).toBe("true");
  });

  it("measures its portal content, repositions from the live range, and handles global Escape", () => {
    const onDismiss = vi.fn();
    const getAnchorRect = vi.fn()
      .mockReturnValueOnce({ left: 260, right: 300, top: 100, bottom: 120, width: 40, height: 20 })
      .mockReturnValue({ left: 20, right: 60, top: 160, bottom: 180, width: 40, height: 20 });
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      right: 250,
      top: 0,
      bottom: 44,
      width: 250,
      height: 44,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }));

    act(() => {
      root.render(
        <SelectionAnnotationToolbar
          open
          anchorRect={{ left: 260, right: 300, top: 100, bottom: 120, width: 40, height: 20 }}
          getAnchorRect={getAnchorRect}
          onAddToChat={vi.fn()}
          onAskInSideChat={vi.fn()}
          onDismiss={onDismiss}
        />,
      );
    });

    const toolbar = document.body.querySelector<HTMLElement>("[role='toolbar']")!;
    expect(toolbar.style.left).toBe("155px");

    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(getAnchorRect).toHaveBeenCalled();
    expect(toolbar.style.left).toBe("8px");

    act(() => {
      document.body.focus();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onDismiss).toHaveBeenCalledOnce();

    HTMLElement.prototype.getBoundingClientRect = originalRect;
  });

  it("keeps the last valid position when live geometry is temporarily invalid", () => {
    const liveRects = [
      { left: 260, right: 300, top: 100, bottom: 120, width: 40, height: 20 },
      { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 },
      { left: Number.NaN, right: 60, top: 160, bottom: 180, width: 40, height: 20 },
      { left: 20, right: 20, top: 160, bottom: 180, width: 0, height: 20 },
    ];
    const getAnchorRect = vi.fn(() => liveRects.shift() ?? null);

    act(() => {
      root.render(
        <SelectionAnnotationToolbar
          open
          anchorRect={{ left: 260, right: 300, top: 100, bottom: 120, width: 40, height: 20 }}
          getAnchorRect={getAnchorRect}
          onAddToChat={vi.fn()}
          onAskInSideChat={vi.fn()}
          onDismiss={vi.fn()}
        />,
      );
    });

    const toolbar = document.body.querySelector<HTMLElement>("[role='toolbar']")!;
    const initialPosition = { left: toolbar.style.left, top: toolbar.style.top };
    for (let index = 0; index < 3; index += 1) {
      act(() => window.dispatchEvent(new Event("scroll")));
      expect({ left: toolbar.style.left, top: toolbar.style.top }).toEqual(initialPosition);
    }
  });

  it("keeps the last valid workspace boundary when live boundary geometry is invalid", () => {
    const getBoundaryRect = vi.fn()
      .mockReturnValueOnce({
        left: 200,
        right: 520,
        top: 36,
        bottom: 500,
        width: 320,
        height: 464,
      })
      .mockReturnValue({
        left: 0,
        right: 0,
        top: Number.NaN,
        bottom: 0,
        width: 0,
        height: 0,
      });
    act(() => {
      root.render(
        <SelectionAnnotationToolbar
          open
          anchorRect={{ left: 490, right: 510, top: 44, bottom: 64, width: 20, height: 20 }}
          boundaryRect={{
            left: 200,
            right: 520,
            top: 36,
            bottom: 500,
            width: 320,
            height: 464,
          }}
          getBoundaryRect={getBoundaryRect}
          onAddToChat={vi.fn()}
          onAskInSideChat={vi.fn()}
          onDismiss={vi.fn()}
        />,
      );
    });
    const toolbar = document.body.querySelector<HTMLElement>("[role='toolbar']")!;
    const initialPosition = { left: toolbar.style.left, top: toolbar.style.top };
    act(() => window.dispatchEvent(new Event("resize")));
    expect({ left: toolbar.style.left, top: toolbar.style.top }).toEqual(initialPosition);
  });

  it("dismisses when the canonical source is no longer available", () => {
    const onAnchorUnavailable = vi.fn();
    act(() => {
      root.render(
        <SelectionAnnotationToolbar
          open
          anchorRect={{ left: 40, right: 140, top: 100, bottom: 120, width: 100, height: 20 }}
          isAnchorAvailable={() => false}
          onAnchorUnavailable={onAnchorUnavailable}
          onAddToChat={vi.fn()}
          onAskInSideChat={vi.fn()}
          onDismiss={vi.fn()}
        />,
      );
    });
    expect(onAnchorUnavailable).toHaveBeenCalledOnce();
  });
});
