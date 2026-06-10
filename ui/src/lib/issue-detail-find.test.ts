// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  activateIssueFindMatch,
  clearIssueFindHighlights,
  highlightIssueFindMatches,
  isIssueFindShortcut,
} from "./issue-detail-find";

describe("issue detail find helpers", () => {
  it("highlights case-insensitive matches and restores the original text on cleanup", () => {
    const root = document.createElement("div");
    root.innerHTML = "<h1>Fix issue detail search</h1><p>Search should find issue text.</p>";

    const matches = highlightIssueFindMatches(root, "issue");

    expect(matches).toHaveLength(2);
    expect(root.querySelectorAll("mark[data-issue-find-highlight='true']")).toHaveLength(2);

    const active = activateIssueFindMatch(matches, 1);

    expect((active as HTMLElement | null)?.textContent).toBe("issue");
    expect(root.querySelectorAll(".issue-find-highlight--active")).toHaveLength(1);

    clearIssueFindHighlights(root);

    expect(root.querySelector("mark")).toBeNull();
    expect(root.textContent).toBe("Fix issue detail searchSearch should find issue text.");
  });

  it("skips form controls, active editable regions, and find UI chrome while allowing button text", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <p>issue visible</p>
      <button type="button">issue property trigger</button>
      <input value="issue input" />
      <div contenteditable="true">issue editable</div>
      <div data-issue-find-ui>issue overlay</div>
    `;
    const editable = root.querySelector<HTMLElement>("[contenteditable='true']");

    const matches = highlightIssueFindMatches(root, "issue", { skipElement: editable });

    expect(matches).toHaveLength(2);
    expect((matches[0] as HTMLElement | undefined)?.textContent).toBe("issue");
    expect((matches[1] as HTMLElement | undefined)?.closest("button")?.textContent).toBe("issue property trigger");
  });

  it("can search inactive contenteditable text used by rendered markdown", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div contenteditable="true">issue markdown preview</div>`;

    const matches = highlightIssueFindMatches(root, "issue");

    expect(matches).toHaveLength(1);
  });

  it("keeps active editable text out of mark mode search", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div contenteditable="true" tabindex="0">issue active editor</div>`;
    document.body.appendChild(root);
    const editable = root.querySelector<HTMLElement>("[contenteditable='true']");
    editable?.focus();

    const matches = highlightIssueFindMatches(root, "issue", { skipElement: editable });

    expect(document.activeElement).toBe(editable);
    expect(matches).toHaveLength(0);
    expect(root.querySelector("mark[data-issue-find-highlight='true']")).toBeNull();
    root.remove();
  });

  it("searches active editable text with CSS highlights without mutating editor DOM", () => {
    const win = window as typeof window & {
      CSS?: unknown;
      Highlight?: unknown;
    };
    const hadCss = Object.prototype.hasOwnProperty.call(win, "CSS");
    const hadHighlight = Object.prototype.hasOwnProperty.call(win, "Highlight");
    const originalCss = win.CSS;
    const originalHighlight = win.Highlight;
    const highlights = new Map<string, { size: number }>();

    class TestHighlight {
      size: number;

      constructor(...ranges: Range[]) {
        this.size = ranges.length;
      }
    }

    Object.defineProperty(win, "CSS", {
      configurable: true,
      value: {
        highlights: {
          delete: (name: string) => {
            highlights.delete(name);
          },
          set: (name: string, highlight: { size: number }) => {
            highlights.set(name, highlight);
          },
        },
      },
    });
    Object.defineProperty(win, "Highlight", {
      configurable: true,
      value: TestHighlight,
    });

    try {
      const root = document.createElement("div");
      root.innerHTML = `<div contenteditable="true" tabindex="0">issue active editor</div>`;
      document.body.appendChild(root);
      const editable = root.querySelector<HTMLElement>("[contenteditable='true']");
      editable?.focus();

      const matches = highlightIssueFindMatches(root, "issue", {
        mode: "css",
        skipElement: editable,
      });

      expect(document.activeElement).toBe(editable);
      expect(matches).toHaveLength(1);
      expect(highlights.get("rudder-issue-find-highlight")?.size).toBe(1);
      expect(root.querySelector("mark[data-issue-find-highlight='true']")).toBeNull();
      expect(root.textContent).toBe("issue active editor");
      root.remove();
    } finally {
      if (hadCss) {
        Object.defineProperty(win, "CSS", { configurable: true, value: originalCss });
      } else {
        Reflect.deleteProperty(win, "CSS");
      }
      if (hadHighlight) {
        Object.defineProperty(win, "Highlight", { configurable: true, value: originalHighlight });
      } else {
        Reflect.deleteProperty(win, "Highlight");
      }
    }
  });

  it("does not fall back to mark wrapping editable text when CSS highlights are unavailable", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <p>issue normal text</p>
      <div contenteditable="true" tabindex="0">issue editable text</div>
    `;

    const matches = highlightIssueFindMatches(root, "issue", { mode: "css" });

    expect(matches).toHaveLength(1);
    expect(root.querySelectorAll("mark[data-issue-find-highlight='true']")).toHaveLength(1);
    expect(root.querySelector("[contenteditable='true']")?.textContent).toBe("issue editable text");
  });

  it("recognizes platform find shortcuts without accepting modified variants", () => {
    expect(isIssueFindShortcut(new KeyboardEvent("keydown", { key: "f", metaKey: true }))).toBe(true);
    expect(isIssueFindShortcut(new KeyboardEvent("keydown", { key: "F", ctrlKey: true }))).toBe(true);
    expect(isIssueFindShortcut(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isIssueFindShortcut(new KeyboardEvent("keydown", { key: "g", metaKey: true }))).toBe(false);
  });
});
