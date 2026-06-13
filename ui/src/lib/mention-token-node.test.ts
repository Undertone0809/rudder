import { buildAgentMentionHref } from "@rudderhq/shared";
import { $createParagraphNode, $getRoot, createEditor } from "lexical";
import { describe, expect, it } from "vitest";
import { $createMentionTokenNode, MentionTokenNode } from "./mention-token-node";

const MENTION_HREF = buildAgentMentionHref("agent-123", "code");
const MENTION_LABEL = "Dylan (PM)";

function createTestEditor() {
  return createEditor({
    namespace: "mention-token-node-test",
    nodes: [MentionTokenNode],
    onError(error: Error) {
      throw error;
    },
  });
}

describe("MentionTokenNode", () => {
  it("stores mentions as token text entities", () => {
    const editor = createTestEditor();

    editor.update(() => {
      const node = $createMentionTokenNode(`@${MENTION_LABEL}`, MENTION_HREF);

      expect(node.getTextContent()).toBe(MENTION_LABEL);
      expect(node.getHref()).toBe(MENTION_HREF);
      expect(node.getMode()).toBe("token");
      expect(node.canInsertTextBefore()).toBe(false);
      expect(node.canInsertTextAfter()).toBe(false);
      expect(node.isTextEntity()).toBe(true);
    });
  });

  it("serializes href alongside the token text", () => {
    const editor = createTestEditor();

    editor.update(() => {
      const node = $createMentionTokenNode(MENTION_LABEL, MENTION_HREF);

      expect(node.exportJSON()).toMatchObject({
        href: MENTION_HREF,
        text: MENTION_LABEL,
        type: "mention-token",
        mode: "token",
      });
    });
  });

  it("behaves like a text entity inside paragraphs", () => {
    const editor = createTestEditor();

    editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      const token = $createMentionTokenNode(MENTION_LABEL, MENTION_HREF);
      paragraph.append(token);
      root.append(paragraph);

      expect(paragraph.getTextContent()).toBe(MENTION_LABEL);
      expect(root.getTextContent()).toBe(MENTION_LABEL);
      expect(token.getParent()?.is(paragraph)).toBe(true);
      expect(token.getPreviousSibling()).toBeNull();
      expect(token.getNextSibling()).toBeNull();
    });
  });

  it("can be cloned for writable updates without recursing", () => {
    const editor = createTestEditor();

    editor.update(() => {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      const token = $createMentionTokenNode(MENTION_LABEL, MENTION_HREF);
      paragraph.append(token);
      root.append(paragraph);

      token.setHref(buildAgentMentionHref("agent-456", "code"));
      expect(token.getLatest().getHref()).toContain("agent-456");
      expect(token.getLatest().getMode()).toBe("token");
    });
  });
});
