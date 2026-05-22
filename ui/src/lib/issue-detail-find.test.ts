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

    expect(active?.textContent).toBe("issue");
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
    expect(matches[0]?.textContent).toBe("issue");
    expect(matches[1]?.closest("button")?.textContent).toBe("issue property trigger");
  });

  it("can search inactive contenteditable text used by rendered markdown", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div contenteditable="true">issue markdown preview</div>`;

    const matches = highlightIssueFindMatches(root, "issue");

    expect(matches).toHaveLength(1);
  });

  it("recognizes platform find shortcuts without accepting modified variants", () => {
    expect(isIssueFindShortcut(new KeyboardEvent("keydown", { key: "f", metaKey: true }))).toBe(true);
    expect(isIssueFindShortcut(new KeyboardEvent("keydown", { key: "F", ctrlKey: true }))).toBe(true);
    expect(isIssueFindShortcut(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isIssueFindShortcut(new KeyboardEvent("keydown", { key: "g", metaKey: true }))).toBe(false);
  });
});
