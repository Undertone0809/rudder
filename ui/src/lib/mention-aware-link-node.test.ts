import { describe, expect, it } from "vitest";
import { $createLinkNode } from "@lexical/link";
import { createEditor } from "lexical";
import {
  MentionAwareLinkNode,
  getMentionAwareLinkNodeInit,
  mentionAwareLinkNodeReplacement,
} from "./mention-aware-link-node";

function createTestEditor() {
  return createEditor({
    namespace: "mention-aware-link-node-test",
    nodes: [MentionAwareLinkNode, mentionAwareLinkNodeReplacement],
    onError(error: Error) {
      throw error;
    },
  });
}

describe("getMentionAwareLinkNodeInit", () => {
  it("copies link attributes without carrying over a node key", () => {
    const init = getMentionAwareLinkNodeInit({
      getURL: () => "agent://agent-123",
      getRel: () => "noreferrer",
      getTarget: () => "_blank",
      getTitle: () => "Agent mention",
    });

    expect(Object.keys(init)).toEqual(["url", "attributes"]);
    expect(init).toEqual({
      url: "agent://agent-123",
      attributes: {
        rel: "noreferrer",
        target: "_blank",
        title: "Agent mention",
      },
    });
  });

  it("replaces LinkNode creation with MentionAwareLinkNode without throwing", () => {
    const editor = createTestEditor();
    let created: unknown;

    editor.update(() => {
      created = $createLinkNode("agent://agent-123");
    });

    expect(created).toBeInstanceOf(MentionAwareLinkNode);
  });

  it("keeps all internal mention URL schemes intact", () => {
    const editor = createTestEditor();
    let sanitized: string[] = [];

    editor.update(() => {
      const node = new MentionAwareLinkNode();
      sanitized = [
        node.sanitizeUrl("agent://agent-123"),
        node.sanitizeUrl("project://project-123?c=336699"),
        node.sanitizeUrl("issue://issue-123?r=RUD-123"),
      ];
    });

    expect(sanitized).toEqual([
      "agent://agent-123",
      "project://project-123?c=336699",
      "issue://issue-123?r=RUD-123",
    ]);
  });
});
