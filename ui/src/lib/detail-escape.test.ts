// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  shouldHandleDetailEscape,
  shouldHandleDocumentFocusEscape,
  shouldHandleIssueDetailEscape,
} from "./detail-escape";

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

  it("does not navigate away while menus or listboxes are open", () => {
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.append(menu);
    expect(shouldHandleDetailEscape(keyboardEvent("Escape", document.body))).toBe(false);

    document.body.innerHTML = "";
    const listbox = document.createElement("div");
    listbox.setAttribute("role", "listbox");
    document.body.append(listbox);
    expect(shouldHandleDetailEscape(keyboardEvent("Escape", document.body))).toBe(false);
  });
});

describe("shouldHandleIssueDetailEscape", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("allows empty issue comment editors to fall back to page navigation", () => {
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    editor.setAttribute("data-issue-detail-escape-back", "empty");
    document.body.append(editor);

    expect(shouldHandleIssueDetailEscape(keyboardEvent("Escape", editor))).toBe(true);
  });

  it("does not navigate away from dirty editors, find UI, menus, or listboxes", () => {
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    editor.setAttribute("data-issue-detail-escape-back", "dirty");
    document.body.append(editor);
    expect(shouldHandleIssueDetailEscape(keyboardEvent("Escape", editor))).toBe(false);

    document.body.innerHTML = "<div data-issue-find-ui></div>";
    expect(shouldHandleIssueDetailEscape(keyboardEvent("Escape", document.body))).toBe(false);

    document.body.innerHTML = "<div role='menu'></div>";
    expect(shouldHandleIssueDetailEscape(keyboardEvent("Escape", document.body))).toBe(false);

    document.body.innerHTML = "<div role='listbox'></div>";
    expect(shouldHandleIssueDetailEscape(keyboardEvent("Escape", document.body))).toBe(false);
  });
});

describe("shouldHandleDocumentFocusEscape", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("defers to open menu and listbox layers", () => {
    expect(shouldHandleDocumentFocusEscape(keyboardEvent("Escape", document.body))).toBe(true);

    document.body.innerHTML = "<div role='menu'></div>";
    expect(shouldHandleDocumentFocusEscape(keyboardEvent("Escape", document.body))).toBe(false);

    document.body.innerHTML = "<div role='listbox'></div>";
    expect(shouldHandleDocumentFocusEscape(keyboardEvent("Escape", document.body))).toBe(false);
  });
});
