import {
  $createParagraphNode,
  $isElementNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedTextNode,
  TextNode,
} from "lexical";
import {
  addExportVisitor$,
  addImportVisitor$,
  addLexicalNode$,
  realmPlugin,
  type LexicalVisitor,
  type MdastImportVisitor,
} from "@mdxeditor/editor";
import {
  applyMentionChipDecoration,
  parseMentionChipHref,
  stripMentionChipLabelPrefix,
} from "./mention-chips";

export interface SerializedMentionTokenNode extends SerializedTextNode {
  href: string;
  type: "mention-token";
  version: 1;
}

function getLinkLabel(node: { children: Array<{ type: string; value?: string }> }) {
  return node.children
    .map((child) => (child.type === "text" ? child.value : ""))
    .join("")
    .trim();
}

function normalizeMentionLabel(label: string) {
  return stripMentionChipLabelPrefix(label.trim());
}

function applyMentionTokenDecoration(element: HTMLElement, href: string) {
  const parsed = parseMentionChipHref(href);
  if (!parsed) return;
  applyMentionChipDecoration(element, parsed);
}

export class MentionTokenNode extends TextNode {
  __href: string;

  static getType(): string {
    return "mention-token";
  }

  static clone(node: MentionTokenNode): MentionTokenNode {
    return new MentionTokenNode(node.getTextContent(), node.__href, node.__key);
  }

  static importJSON(serializedNode: SerializedMentionTokenNode): MentionTokenNode {
    return new MentionTokenNode(serializedNode.text, serializedNode.href).updateFromJSON(serializedNode);
  }

  constructor(text: string, href: string, key?: NodeKey) {
    super(normalizeMentionLabel(text), key);
    this.__href = href;
    this.setMode("token");
    this.toggleUnmergeable();
  }

  createDOM(config: EditorConfig): HTMLElement {
    const element = super.createDOM(config);
    applyMentionTokenDecoration(element, this.__href);
    return element;
  }

  updateDOM(prevNode: this, dom: HTMLElement, config: EditorConfig): boolean {
    const didUpdate = super.updateDOM(prevNode, dom, config);
    applyMentionTokenDecoration(dom, this.__href);
    return didUpdate;
  }

  exportJSON(): SerializedMentionTokenNode {
    return {
      ...super.exportJSON(),
      href: this.__href,
      type: "mention-token",
      version: 1,
    };
  }

  updateFromJSON(serializedNode: SerializedMentionTokenNode): this {
    return super
      .updateFromJSON(serializedNode)
      .setHref(serializedNode.href)
      .setMode("token");
  }

  canInsertTextBefore(): boolean {
    return true;
  }

  canInsertTextAfter(): boolean {
    return true;
  }

  isTextEntity(): boolean {
    return true;
  }

  getHref(): string {
    return this.getLatest().__href;
  }

  setHref(href: string): this {
    const writable = this.getWritable();
    writable.__href = href;
    return writable;
  }
}

export function $createMentionTokenNode(label: string, href: string) {
  return new MentionTokenNode(label, href);
}

export function $isMentionTokenNode(node: LexicalNode | null | undefined): node is MentionTokenNode {
  return node instanceof MentionTokenNode;
}

const mentionTokenImportVisitor: MdastImportVisitor<any> = {
  priority: 110,
  testNode: "link",
  visitNode({ mdastNode, lexicalParent, actions }) {
    if (!parseMentionChipHref(mdastNode.url)) {
      actions.nextVisitor();
      return;
    }

    const label = normalizeMentionLabel(getLinkLabel(mdastNode));
    const mentionToken = $createMentionTokenNode(label, mdastNode.url);
    if ($isElementNode(lexicalParent)) {
      lexicalParent.append(mentionToken);
      return;
    }

    const paragraph = $createParagraphNode();
    paragraph.append(mentionToken);
    actions.addAndStepInto(paragraph);
  },
};

const mentionTokenExportVisitor: LexicalVisitor = {
  priority: 110,
  testLexicalNode: $isMentionTokenNode,
  visitLexicalNode({ lexicalNode, mdastParent, actions }) {
    const mentionToken = lexicalNode as MentionTokenNode;
    actions.appendToParent(mdastParent, {
      type: "link",
      title: null,
      url: mentionToken.getHref(),
      children: [
        {
          type: "text",
          value: mentionToken.getTextContent(),
        },
      ],
    });
  },
};

export const mentionTokenPlugin = realmPlugin({
  init(realm) {
    realm.pubIn({
      [addLexicalNode$]: MentionTokenNode,
      [addImportVisitor$]: mentionTokenImportVisitor,
      [addExportVisitor$]: mentionTokenExportVisitor,
    });
  },
});
