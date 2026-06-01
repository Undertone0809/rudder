// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { shouldHandleDetailEscape } from "./detail-escape";

function keyboardEvent(key: string, target?: EventTarget) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true });
  if (target) {
    Object.defineProperty(event, "target", {
      configurable: true,
      value: target,
    });
  }
  return event;
}

describe("shouldHandleDetailEscape", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("handles plain Escape on detail pages", () => {
    expect(shouldHandleDetailEscape(keyboardEvent("Escape", document.body))).toBe(true);
  });

  it("ignores modified Escape and non-Escape keys", () => {
    expect(shouldHandleDetailEscape(new KeyboardEvent("keydown", { key: "Escape", metaKey: true }))).toBe(false);
    expect(shouldHandleDetailEscape(keyboardEvent("Enter", document.body))).toBe(false);
  });

  it("does not navigate away while focused inside editable fields", () => {
    const input = document.createElement("input");
    document.body.append(input);

    expect(shouldHandleDetailEscape(keyboardEvent("Escape", input))).toBe(false);
  });

  it("does not navigate away while dialogs or popovers are open", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    expect(shouldHandleDetailEscape(keyboardEvent("Escape", document.body))).toBe(false);

    document.body.innerHTML = "";
    const popover = document.createElement("div");
    popover.setAttribute("data-radix-popper-content-wrapper", "");
    document.body.append(popover);
    expect(shouldHandleDetailEscape(keyboardEvent("Escape", document.body))).toBe(false);
  });
});
