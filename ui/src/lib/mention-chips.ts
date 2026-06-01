import type { CSSProperties } from "react";
import { parseAgentMentionHref, parseChatMentionHref, parseIssueMentionHref, parseLibraryDocMentionHref, parseLibraryFileMentionHref, parseProjectMentionHref } from "@rudderhq/shared";
import { FileText } from "lucide-react";
import { getAgentAvatarBackgroundStyle, getAgentAvatarImageSrc } from "./agent-avatar";
import { getAgentIcon } from "./agent-icons";

export type ParsedMentionChip =
  | {
      kind: "agent";
      agentId: string;
      icon: string | null;
    }
  | {
      kind: "project";
      projectId: string;
      color: string | null;
    }
  | {
      kind: "issue";
      issueId: string;
      ref: string | null;
    }
  | {
      kind: "chat";
      conversationId: string;
      title: string | null;
    }
  | {
      kind: "library_doc";
      documentId: string;
      title: string | null;
    }
  | {
      kind: "library_file";
      filePath: string;
      title: string | null;
    };

const iconMaskCache = new Map<string, string>();

export function stripMentionChipLabelPrefix(label: string): string {
  return label.replace(/^@(?=\S)/, "");
}

export function parseMentionChipHref(href: string): ParsedMentionChip | null {
  const agent = parseAgentMentionHref(href);
  if (agent) {
    return {
      kind: "agent",
      agentId: agent.agentId,
      icon: agent.icon,
    };
  }

  const project = parseProjectMentionHref(href);
  if (project) {
    return {
      kind: "project",
      projectId: project.projectId,
      color: project.color,
    };
  }

  const issue = parseIssueMentionHref(href);
  if (issue) {
    return {
      kind: "issue",
      issueId: issue.issueId,
      ref: issue.ref,
    };
  }

  const chat = parseChatMentionHref(href);
  if (chat) {
    return {
      kind: "chat",
      conversationId: chat.conversationId,
      title: chat.title,
    };
  }

  const libraryDoc = parseLibraryDocMentionHref(href);
  if (libraryDoc) {
    return {
      kind: "library_doc",
      documentId: libraryDoc.documentId,
      title: libraryDoc.title,
    };
  }

  const libraryFile = parseLibraryFileMentionHref(href);
  if (libraryFile) {
    return {
      kind: "library_file",
      filePath: libraryFile.filePath,
      title: libraryFile.title,
    };
  }

  return null;
}

export function mentionChipInlineStyle(mention: ParsedMentionChip): CSSProperties | undefined {
  const style: CSSProperties & Record<string, string> = {};

  if (mention.kind === "project" && mention.color) {
    style["--rudder-mention-project-color"] = mention.color;
  }

  if (mention.kind === "agent") {
    const avatarImageSrc = getAgentAvatarImageSrc(mention.icon);
    if (avatarImageSrc) {
      style["--rudder-mention-agent-avatar-background"] = `url("${escapeCssUrl(avatarImageSrc)}") center / cover no-repeat`;
      const avatarShellStyle = getAgentAvatarBackgroundStyle(mention.icon);
      if (typeof avatarShellStyle?.background === "string") {
        style["--rudder-mention-agent-avatar-shell-background"] = avatarShellStyle.background;
      }
      style["--rudder-mention-icon-mask"] = "none";
      return style as CSSProperties;
    }

    const iconMask = buildAgentIconMask(mention.icon);
    if (iconMask) {
      style["--rudder-mention-icon-mask"] = iconMask;
    }
  }

  if (mention.kind === "library_doc" || mention.kind === "library_file") {
    const iconMask = buildLucideIconMask(FileText, "lucide:file-text");
    if (iconMask) {
      style["--rudder-mention-icon-mask"] = iconMask;
    }
  }

  return Object.keys(style).length > 0 ? (style as CSSProperties) : undefined;
}

export function applyMentionChipDecoration(element: HTMLElement, mention: ParsedMentionChip) {
  clearMentionChipDecoration(element);
  const visibleLabel = element.textContent ?? "";
  const normalizedLabel = stripMentionChipLabelPrefix(visibleLabel);
  if (normalizedLabel !== visibleLabel) {
    element.textContent = normalizedLabel;
  }
  element.dataset.mentionKind = mention.kind;
  element.setAttribute("contenteditable", "false");
  element.classList.add("rudder-mention-chip", `rudder-mention-chip--${mention.kind}`);
  if (mention.kind === "project") {
    element.classList.add("rudder-project-mention-chip");
  }

  const style = mentionChipInlineStyle(mention);
  if (!style) return;
  for (const [key, value] of Object.entries(style)) {
    if (typeof value === "string") {
      if (key.startsWith("--")) {
        element.style.setProperty(key, value);
      } else {
        (element.style as CSSStyleDeclaration & Record<string, string>)[key] = value;
      }
    }
  }
}

export function clearMentionChipDecoration(element: HTMLElement) {
  delete element.dataset.mentionKind;
  delete element.dataset.mentionHref;
  element.classList.remove(
    "rudder-mention-chip",
    "rudder-mention-chip--agent",
    "rudder-mention-chip--chat",
    "rudder-mention-chip--issue",
    "rudder-mention-chip--library_doc",
    "rudder-mention-chip--library_file",
    "rudder-mention-chip--project",
    "rudder-project-mention-chip",
  );
  element.removeAttribute("contenteditable");
  element.style.removeProperty("border-color");
  element.style.removeProperty("background-color");
  element.style.removeProperty("color");
  element.style.removeProperty("--rudder-mention-project-color");
  element.style.removeProperty("--rudder-mention-agent-avatar-background");
  element.style.removeProperty("--rudder-mention-agent-avatar-shell-background");
  element.style.removeProperty("--rudder-mention-icon-mask");
}

function escapeCssUrl(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "");
}

function buildAgentIconMask(iconName: string | null): string | null {
  const cacheKey = iconName ?? "__default__";
  return buildLucideIconMask(getAgentIcon(iconName), `agent:${cacheKey}`);
}

export function buildLucideIconMask(icon: unknown, cacheKey: string): string | null {
  const cached = iconMaskCache.get(cacheKey);
  if (cached) return cached;

  const iconNode = resolveLucideIconNode(icon);
  if (!Array.isArray(iconNode) || iconNode.length === 0) return null;

  const body = iconNode.map(([tag, attrs]) => {
    const attrString = Object.entries(attrs)
      .filter(([key]) => key !== "key")
      .map(([key, value]) => `${key}="${escapeAttribute(String(value))}"`)
      .join(" ");
    return `<${tag}${attrString ? ` ${attrString}` : ""}></${tag}>`;
  }).join("");

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ` +
    `fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" ` +
    `stroke-linejoin="round">${body}</svg>`;
  const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  iconMaskCache.set(cacheKey, url);
  return url;
}

function resolveLucideIconNode(
  icon: unknown,
): Array<[string, Record<string, string>]> | null {
  const staticIconNode = (
    icon as {
      iconNode?: Array<[string, Record<string, string>]>;
    }
  ).iconNode;
  if (Array.isArray(staticIconNode) && staticIconNode.length > 0) {
    return staticIconNode;
  }

  const render = (
    icon as {
      render?: (props: Record<string, unknown>, ref: unknown) => {
        props?: { iconNode?: Array<[string, Record<string, string>]> };
      } | null;
    }
  ).render;
  const rendered = typeof render === "function" ? render({}, null) : null;
  const renderedIconNode = rendered?.props?.iconNode;
  return Array.isArray(renderedIconNode) && renderedIconNode.length > 0
    ? renderedIconNode
    : null;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
