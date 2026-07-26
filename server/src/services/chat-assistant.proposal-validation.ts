import type { ChatMessage } from "@rudderhq/shared";
import { fromMarkdown } from "mdast-util-from-markdown";

interface MarkdownNode {
  type: string;
  url?: string;
  identifier?: string;
  children?: MarkdownNode[];
}

function visitMarkdown(node: MarkdownNode, visitor: (node: MarkdownNode) => void) {
  visitor(node);
  for (const child of node.children ?? []) {
    visitMarkdown(child, visitor);
  }
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(stringValues);
  }
  return [];
}

function proposalMarkdownImageTargets(markdown: string) {
  const root = fromMarkdown(markdown) as unknown as MarkdownNode;
  const definitions = new Map<string, string>();
  const imageNodes: MarkdownNode[] = [];
  visitMarkdown(root, (node) => {
    if (node.type === "definition" && node.identifier && node.url) {
      definitions.set(node.identifier, node.url);
    } else if (node.type === "image" || node.type === "imageReference") {
      imageNodes.push(node);
    }
  });
  return imageNodes.flatMap((node) => {
    const target = node.type === "image"
      ? node.url
      : node.identifier
        ? definitions.get(node.identifier)
        : undefined;
    return target ? [target] : [];
  });
}

export function userImageContentPathsFromMessages(messages: ChatMessage[]) {
  return new Set(
    messages
      .slice(-12)
      .filter((message) => message.role === "user")
      .flatMap((message) => message.attachments)
      .filter((attachment) => attachment.contentType?.toLowerCase().startsWith("image/"))
      .map((attachment) => attachment.contentPath)
      .filter((contentPath): contentPath is string => Boolean(contentPath)),
  );
}

export function validateIssueProposalAttachmentSafety(input: {
  body: string;
  structuredPayload: Record<string, unknown> | null;
  description: string;
  allowedImageContentPaths?: ReadonlySet<string>;
  forbiddenAttachmentLocalPaths?: readonly string[];
}) {
  const userVisibleStrings = stringValues({
    body: input.body,
    structuredPayload: input.structuredPayload,
  });
  const leakedLocalPath = input.forbiddenAttachmentLocalPaths?.find((localPath) =>
    localPath.length > 0 && userVisibleStrings.some((value) => value.includes(localPath))
  );
  if (leakedLocalPath) {
    throw new Error("issue_proposal assistant responses must not expose temporary attachment localPath values");
  }
  if (!input.allowedImageContentPaths) return;
  for (const target of proposalMarkdownImageTargets(input.description)) {
    if (!input.allowedImageContentPaths.has(target)) {
      throw new Error("issue_proposal Markdown images must use a canonical contentPath from an available user image attachment");
    }
  }
}
