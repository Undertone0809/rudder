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
import { applySkillTokenDecoration, parseSkillReference } from "./skill-reference";

export interface SerializedSkillTokenNode extends SerializedTextNode {
  href: string;
  type: "skill-token";
  version: 1;
}

function getSkillLabel(node: { children: Array<{ type: string; value?: string }> }) {
  return node.children
    .map((child) => (child.type === "text" ? child.value : ""))
    .join("")
    .trim();
}

export class SkillTokenNode extends TextNode {
  __href: string;

  static getType(): string {
    return "skill-token";
  }

  static clone(node: SkillTokenNode): SkillTokenNode {
    return new SkillTokenNode(node.getTextContent(), node.__href, node.__key);
  }

  static importJSON(serializedNode: SerializedSkillTokenNode): SkillTokenNode {
    return new SkillTokenNode(serializedNode.text, serializedNode.href).updateFromJSON(serializedNode);
  }

  constructor(text: string, href: string, key?: NodeKey) {
    super(text, key);
    this.__href = href;
    this.setMode("token");
    this.toggleUnmergeable();
  }

  createDOM(config: EditorConfig): HTMLElement {
    const element = super.createDOM(config);
    applySkillTokenDecoration(element);
    return element;
  }

  updateDOM(prevNode: this, dom: HTMLElement, config: EditorConfig): boolean {
    const didUpdate = super.updateDOM(prevNode, dom, config);
    applySkillTokenDecoration(dom);
    return didUpdate;
  }

  exportJSON(): SerializedSkillTokenNode {
    return {
      ...super.exportJSON(),
      href: this.__href,
      type: "skill-token",
      version: 1,
    };
  }

  updateFromJSON(serializedNode: SerializedSkillTokenNode): this {
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

export function $createSkillTokenNode(label: string, href: string) {
  return new SkillTokenNode(label, href);
}

export function $isSkillTokenNode(node: LexicalNode | null | undefined): node is SkillTokenNode {
  return node instanceof SkillTokenNode;
}

const skillTokenImportVisitor: MdastImportVisitor<any> = {
  priority: 100,
  testNode: "link",
  visitNode({ mdastNode, lexicalParent, actions }) {
    const label = getSkillLabel(mdastNode);
    const skillReference = parseSkillReference(mdastNode.url, label);
    if (!skillReference) {
      actions.nextVisitor();
      return;
    }

    const skillToken = $createSkillTokenNode(skillReference.label, skillReference.href);
    if ($isElementNode(lexicalParent)) {
      lexicalParent.append(skillToken);
      return;
    }

    const paragraph = $createParagraphNode();
    paragraph.append(skillToken);
    actions.addAndStepInto(paragraph);
  },
};

const skillTokenExportVisitor: LexicalVisitor = {
  priority: 100,
  testLexicalNode: $isSkillTokenNode,
  visitLexicalNode({ lexicalNode, mdastParent, actions }) {
    const skillToken = lexicalNode as SkillTokenNode;
    actions.appendToParent(mdastParent, {
      type: "link",
      title: null,
      url: skillToken.getHref(),
      children: [
        {
          type: "text",
          value: skillToken.getTextContent(),
        },
      ],
    });
  },
};

export const skillTokenPlugin = realmPlugin({
  init(realm) {
    realm.pubIn({
      [addLexicalNode$]: SkillTokenNode,
      [addImportVisitor$]: skillTokenImportVisitor,
      [addExportVisitor$]: skillTokenExportVisitor,
    });
  },
});
