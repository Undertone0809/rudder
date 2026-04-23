// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { findAdjacentSkillTokenElement } from "./skill-token-dom";

describe("findAdjacentSkillTokenElement", () => {
  it("finds a canonical skill link when backspacing from the trailing inline space", () => {
    const editable = document.createElement("div");
    const paragraph = document.createElement("p");
    const before = document.createTextNode("Use this ");
    const skill = document.createElement("a");
    skill.href = "/workspace/.agents/skills/build-advisor/SKILL.md";
    skill.textContent = "rudder/build-advisor";
    const trailingSpace = document.createTextNode("\u00A0");

    paragraph.append(before, skill, trailingSpace);
    editable.append(paragraph);
    document.body.append(editable);

    const selection = window.getSelection();
    expect(selection).toBeTruthy();
    if (!selection) throw new Error("Expected window selection");

    const range = document.createRange();
    range.setStart(trailingSpace, trailingSpace.textContent?.length ?? 0);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    expect(findAdjacentSkillTokenElement(selection, "backward")).toBe(skill);
  });

  it("finds a canonical skill link when deleting forward from adjacent text", () => {
    const editable = document.createElement("div");
    const paragraph = document.createElement("p");
    const before = document.createTextNode("Use this ");
    const skill = document.createElement("a");
    skill.href = "/workspace/.agents/skills/build-advisor/SKILL.md";
    skill.textContent = "rudder/build-advisor";
    const after = document.createTextNode(" next");

    paragraph.append(before, skill, after);
    editable.append(paragraph);
    document.body.append(editable);

    const selection = window.getSelection();
    expect(selection).toBeTruthy();
    if (!selection) throw new Error("Expected window selection");

    const range = document.createRange();
    range.setStart(before, before.textContent?.length ?? 0);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    expect(findAdjacentSkillTokenElement(selection, "forward")).toBe(skill);
  });
});
