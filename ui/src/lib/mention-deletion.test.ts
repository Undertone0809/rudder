import { describe, expect, it } from "vitest";
import { $createLinkNode, LinkNode } from "@lexical/link";
import { buildAgentMentionHref } from "@rudder/shared";
import {
  createEditor,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
} from "lexical";
import { deleteSelectedMentionChip } from "./mention-deletion";
import { $createSkillTokenNode, SkillTokenNode } from "./skill-token-node";

const SKILL_TOKEN_HREF = "/workspace/.agents/skills/build-advisor/SKILL.md";
const SKILL_TOKEN_LABEL = "rudder/build-advisor";

function createTestEditor() {
  return createEditor({
    namespace: "mention-deletion-test",
    nodes: [LinkNode, SkillTokenNode],
    onError(error: Error) {
      throw error;
    },
  });
}

describe("mention deletion", () => {
  it("removes the full mention when backspacing from inside the chip", () => {
    const editor = createTestEditor();

    editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      const before = $createTextNode("Hello ");
      const mention = $createLinkNode(buildAgentMentionHref("agent-123", "code"));
      const mentionText = $createTextNode("@QA");
      const after = $createTextNode(" world");

      mention.append(mentionText);
      paragraph.append(before, mention, after);
      root.append(paragraph);

      mentionText.selectEnd();

      expect(deleteSelectedMentionChip("backward")).toBe(true);
      expect(root.getTextContent()).toBe("Hello  world");

      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
      if (!$isRangeSelection(selection)) {
        throw new Error("Expected range selection after backward mention deletion");
      }
      expect(selection.isCollapsed()).toBe(true);
      expect(selection.anchor.getNode().is(before)).toBe(true);
      expect(selection.anchor.offset).toBe(before.getTextContentSize());
    });
  });

  it("removes the full mention when deleting forward from adjacent text", () => {
    const editor = createTestEditor();

    editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      const before = $createTextNode("Hello ");
      const mention = $createLinkNode(buildAgentMentionHref("agent-123", "code"));
      const mentionText = $createTextNode("@QA");
      const after = $createTextNode(" world");

      mention.append(mentionText);
      paragraph.append(before, mention, after);
      root.append(paragraph);

      before.selectEnd();

      expect(deleteSelectedMentionChip("forward")).toBe(true);
      expect(root.getTextContent()).toBe("Hello  world");

      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
      if (!$isRangeSelection(selection)) {
        throw new Error("Expected range selection after forward mention deletion");
      }
      expect(selection.isCollapsed()).toBe(true);
      expect(selection.anchor.getNode().is(after)).toBe(true);
      expect(selection.anchor.offset).toBe(0);
    });
  });

  it("removes the full skill token when backspacing from the token edge", () => {
    const editor = createTestEditor();

    editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      const before = $createTextNode("Use ");
      const skill = $createSkillTokenNode(SKILL_TOKEN_LABEL, SKILL_TOKEN_HREF);
      const after = $createTextNode(" here");

      paragraph.append(before, skill, after);
      root.append(paragraph);

      skill.selectEnd();

      expect(deleteSelectedMentionChip("backward")).toBe(true);
      expect(root.getTextContent()).toBe("Use  here");

      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
      if (!$isRangeSelection(selection)) {
        throw new Error("Expected range selection after backward skill deletion");
      }
      expect(selection.isCollapsed()).toBe(true);
      expect(selection.anchor.getNode().is(before)).toBe(true);
      expect(selection.anchor.offset).toBe(before.getTextContentSize());
    });
  });

  it("removes the full skill token when deleting forward from adjacent text", () => {
    const editor = createTestEditor();

    editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      const before = $createTextNode("Use ");
      const skill = $createSkillTokenNode(SKILL_TOKEN_LABEL, SKILL_TOKEN_HREF);
      const after = $createTextNode(" here");

      paragraph.append(before, skill, after);
      root.append(paragraph);

      before.selectEnd();

      expect(deleteSelectedMentionChip("forward")).toBe(true);
      expect(root.getTextContent()).toBe("Use  here");

      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
      if (!$isRangeSelection(selection)) {
        throw new Error("Expected range selection after forward skill deletion");
      }
      expect(selection.isCollapsed()).toBe(true);
      expect(selection.anchor.getNode().is(after)).toBe(true);
      expect(selection.anchor.offset).toBe(0);
    });
  });

  it("removes the full skill token when backspacing from the paragraph edge", () => {
    const editor = createTestEditor();

    editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      const before = $createTextNode("Use ");
      const skill = $createSkillTokenNode(SKILL_TOKEN_LABEL, SKILL_TOKEN_HREF);

      paragraph.append(before, skill);
      root.append(paragraph);

      paragraph.selectEnd();

      expect(deleteSelectedMentionChip("backward")).toBe(true);
      expect(root.getTextContent()).toBe("Use ");

      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
      if (!$isRangeSelection(selection)) {
        throw new Error("Expected range selection after paragraph-edge skill deletion");
      }
      expect(selection.isCollapsed()).toBe(true);
      expect(selection.anchor.getNode().is(before)).toBe(true);
      expect(selection.anchor.offset).toBe(before.getTextContentSize());
    });
  });

  it("removes the full skill token when backspacing from the root edge", () => {
    const editor = createTestEditor();

    editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      const before = $createTextNode("Use ");
      const skill = $createSkillTokenNode(SKILL_TOKEN_LABEL, SKILL_TOKEN_HREF);

      paragraph.append(before, skill);
      root.append(paragraph);

      root.selectEnd();

      expect(deleteSelectedMentionChip("backward")).toBe(true);
      expect(root.getTextContent()).toBe("Use ");

      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
      if (!$isRangeSelection(selection)) {
        throw new Error("Expected range selection after root-edge skill deletion");
      }
      expect(selection.isCollapsed()).toBe(true);
      expect(selection.anchor.getNode().is(before)).toBe(true);
      expect(selection.anchor.offset).toBe(before.getTextContentSize());
    });
  });
});
