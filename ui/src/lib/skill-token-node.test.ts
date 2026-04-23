import { describe, expect, it } from "vitest";
import { $createParagraphNode, $getRoot, createEditor } from "lexical";
import { $createSkillTokenNode, SkillTokenNode } from "./skill-token-node";

const SKILL_HREF = "/workspace/.agents/skills/build-advisor/SKILL.md";
const SKILL_LABEL = "rudder/build-advisor";

function createTestEditor() {
  return createEditor({
    namespace: "skill-token-node-test",
    nodes: [SkillTokenNode],
    onError(error: Error) {
      throw error;
    },
  });
}

describe("SkillTokenNode", () => {
  it("stores skill refs as token text entities", () => {
    const editor = createTestEditor();

    editor.update(() => {
      const node = $createSkillTokenNode(SKILL_LABEL, SKILL_HREF);

      expect(node.getTextContent()).toBe(SKILL_LABEL);
      expect(node.getHref()).toBe(SKILL_HREF);
      expect(node.getMode()).toBe("token");
      expect(node.canInsertTextBefore()).toBe(true);
      expect(node.canInsertTextAfter()).toBe(true);
      expect(node.isTextEntity()).toBe(true);
    });
  });

  it("serializes href alongside the token text", () => {
    const editor = createTestEditor();

    editor.update(() => {
      const node = $createSkillTokenNode(SKILL_LABEL, SKILL_HREF);

      expect(node.exportJSON()).toMatchObject({
        href: SKILL_HREF,
        text: SKILL_LABEL,
        type: "skill-token",
        mode: "token",
      });
    });
  });

  it("behaves like a text entity inside paragraphs", () => {
    const editor = createTestEditor();

    editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      const token = $createSkillTokenNode(SKILL_LABEL, SKILL_HREF);
      paragraph.append(token);
      root.append(paragraph);

      expect(paragraph.getTextContent()).toBe(SKILL_LABEL);
      expect(root.getTextContent()).toBe(SKILL_LABEL);
      expect(token.getParent()?.is(paragraph)).toBe(true);
      expect(token.getPreviousSibling()).toBeNull();
      expect(token.getNextSibling()).toBeNull();
    });
  });
});
