// @vitest-environment jsdom
import { buildAgentMentionHref } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import {
  findAdjacentAtomicInlineTokenElement,
  removeAtomicInlineTokenFromMarkdown,
} from "./inline-token-dom";

function setCollapsedSelection(node: Node, offset: number) {
  const selection = window.getSelection();
  expect(selection).toBeTruthy();
  if (!selection) throw new Error("Expected window selection");

  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

describe("inline token DOM deletion", () => {
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

    const selection = setCollapsedSelection(trailingSpace, trailingSpace.textContent?.length ?? 0);
    const token = findAdjacentAtomicInlineTokenElement(selection, "backward");
    expect(token?.element).toBe(skill);
    expect(token?.kind).toBe("skill");
    expect(token?.label).toBe("build-advisor");
  });

  it("finds a mention token when backspacing from the trailing inline space", () => {
    const href = buildAgentMentionHref("agent-123", "code");
    const editable = document.createElement("div");
    const paragraph = document.createElement("p");
    const before = document.createTextNode("Ask ");
    const mention = document.createElement("span");
    mention.dataset.mentionKind = "agent";
    mention.dataset.mentionHref = href;
    mention.textContent = "QA";
    const trailingSpace = document.createTextNode("\u00A0");

    paragraph.append(before, mention, trailingSpace);
    editable.append(paragraph);
    document.body.append(editable);

    const selection = setCollapsedSelection(trailingSpace, trailingSpace.textContent?.length ?? 0);
    const token = findAdjacentAtomicInlineTokenElement(selection, "backward");
    expect(token?.element).toBe(mention);
    expect(token?.kind).toBe("mention");
    expect(token?.href).toBe(href);
    expect(token?.label).toBe("QA");
  });

  it("does not treat mid-text backspace as token deletion", () => {
    const editable = document.createElement("div");
    const paragraph = document.createElement("p");
    const skill = document.createElement("a");
    skill.href = "/workspace/.agents/skills/build-advisor/SKILL.md";
    skill.textContent = "rudder/build-advisor";
    const text = document.createTextNode(" plain text");

    paragraph.append(skill, text);
    editable.append(paragraph);
    document.body.append(editable);

    const selection = setCollapsedSelection(text, 4);
    expect(findAdjacentAtomicInlineTokenElement(selection, "backward")).toBeNull();
  });

  it("removes the exact mention reference from markdown and its separator space", () => {
    const href = buildAgentMentionHref("agent-123", "code");
    const markdown = `Ask [QA](${href}) about this`;

    expect(
      removeAtomicInlineTokenFromMarkdown(markdown, {
        href,
        kind: "mention",
        label: "QA",
      }),
    ).toBe("Ask about this");
  });

  it("removes a prefixed skill reference when the rendered token only shows the slug", () => {
    const href = "/workspace/.agents/skills/build-advisor/SKILL.md";
    const markdown = `Use [rudder/build-advisor](${href}) here`;

    expect(
      removeAtomicInlineTokenFromMarkdown(markdown, {
        href,
        kind: "skill",
        label: "build-advisor",
      }),
    ).toBe("Use here");
  });
});
