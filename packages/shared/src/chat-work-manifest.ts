import {
  parseAutomationMentionHref,
  parseChatMentionHref,
  parseIssueMentionHref,
  parseLibraryEntryMentionHref,
  parseLibraryFileMentionHref,
} from "./project-mentions.js";

export type ChatWorkManifestCategory = "output" | "source" | "reference";

export interface ExtractedChatWorkTarget {
  targetType: "automation" | "chat_conversation" | "external_url" | "issue" | "issue_comment" | "library_entry" | "library_file";
  targetKey: string;
  title: string;
  url: string | null;
  metadata: Record<string, unknown>;
}

const CATEGORY_RANK: Record<ChatWorkManifestCategory, number> = {
  reference: 0,
  source: 1,
  output: 2,
};

const PROTECTED_CODE_RE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`+[^`\n]*(?:`+|$))/g;
const MARKDOWN_LINK_RE = /(!?)\[([^\]\n]*(?:\\\][^\]\n]*)*)\]\(([^)\n]+)\)/g;
const BARE_HTTP_URL_RE = /https?:\/\/[^\s<>()\[\]{}"']+/gi;
const TRAILING_URL_PUNCTUATION_RE = /[\])}>.,;:!?]+$/;

function stripMarkdownCode(markdown: string): string {
  return markdown.replace(PROTECTED_CODE_RE, (value) => " ".repeat(value.length));
}

function cleanMarkdownLabel(label: string): string {
  return label.replace(/\\([\[\]])/g, "$1").trim();
}

function markdownDestination(value: string): string {
  const trimmed = value.trim();
  const angleWrapped = trimmed.startsWith("<") && trimmed.includes(">");
  if (angleWrapped) return trimmed.slice(1, trimmed.indexOf(">"));
  return trimmed.split(/\s+["']/u, 1)[0] ?? trimmed;
}

function parseInternalRouteUrl(href: string): URL | null {
  try {
    return new URL(href, "http://rudder.local");
  } catch {
    return null;
  }
}

function chatMessageIdFromUrl(url: URL) {
  return (url.searchParams.get("messageId") ?? url.searchParams.get("targetMessageId") ?? "").trim() || null;
}

function issueCommentIdFromUrl(url: URL) {
  const queryComment = (url.searchParams.get("c") ?? url.searchParams.get("commentId") ?? "").trim();
  if (queryComment) return queryComment;
  const hash = decodeURIComponent(url.hash.replace(/^#/, "")).trim();
  return hash.startsWith("comment-") ? hash.slice("comment-".length).trim() || null : null;
}

function internalRouteTarget(href: string, label: string): ExtractedChatWorkTarget | null {
  const url = parseInternalRouteUrl(href);
  if (!url || url.origin !== "http://rudder.local") return null;

  const segments = url.pathname.split("/").filter(Boolean).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  const issueId = segments.length >= 2 && segments.at(-2) === "issues" ? segments.at(-1)?.trim() : "";
  if (issueId) {
    const commentId = issueCommentIdFromUrl(url);
    return {
      targetType: commentId ? "issue_comment" : "issue",
      targetKey: commentId ? `issue-comment:${issueId}:${commentId}` : `issue:${issueId}`,
      title: label || issueId,
      url: null,
      metadata: { issueId, commentId },
    };
  }

  const automationId = segments.length >= 2 && segments.at(-2) === "automations" ? segments.at(-1)?.trim() : "";
  if (automationId) {
    return {
      targetType: "automation",
      targetKey: `automation:${automationId}`,
      title: label || url.searchParams.get("t") || url.searchParams.get("title") || "Automation",
      url: null,
      metadata: { automationId },
    };
  }

  const conversationId = segments.length >= 2 && segments.at(-2) === "chat" ? segments.at(-1)?.trim() : "";
  if (conversationId) {
    const messageId = chatMessageIdFromUrl(url);
    return {
      targetType: "chat_conversation",
      targetKey: messageId ? `chat:${conversationId}:${messageId}` : `chat:${conversationId}`,
      title: label || "Chat",
      url: null,
      metadata: { conversationId, messageId },
    };
  }

  return null;
}

export function normalizeChatWorkExternalUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  url.hash = "";
  return url.toString();
}

export function preferChatWorkManifestCategory(
  current: ChatWorkManifestCategory,
  candidate: ChatWorkManifestCategory,
): ChatWorkManifestCategory {
  return CATEGORY_RANK[candidate] > CATEGORY_RANK[current] ? candidate : current;
}

function externalTarget(rawUrl: string, label?: string | null): ExtractedChatWorkTarget | null {
  const url = normalizeChatWorkExternalUrl(rawUrl);
  if (!url) return null;
  const parsed = new URL(url);
  return {
    targetType: "external_url",
    targetKey: `url:${url}`,
    title: label?.trim() || parsed.hostname,
    url,
    metadata: { hostname: parsed.hostname },
  };
}

function libraryTarget(href: string, label: string): ExtractedChatWorkTarget | null {
  const entry = parseLibraryEntryMentionHref(href);
  if (entry) {
    return {
      targetType: "library_entry",
      targetKey: `library-entry:${entry.entryId}:${entry.path ?? ""}`,
      title: label || entry.path?.split("/").pop() || entry.entryId,
      url: null,
      metadata: {
        entryId: entry.entryId,
        filePath: entry.path,
      },
    };
  }
  const file = parseLibraryFileMentionHref(href);
  if (!file) return null;
  return {
    targetType: "library_file",
    targetKey: `library-file:${file.filePath}`,
    title: label || file.filePath.split("/").pop() || file.filePath,
    url: null,
    metadata: { filePath: file.filePath },
  };
}

function rudderReferenceTarget(href: string, label: string): ExtractedChatWorkTarget | null {
  const issue = parseIssueMentionHref(href);
  if (issue) {
    return {
      targetType: issue.commentId ? "issue_comment" : "issue",
      targetKey: issue.commentId ? `issue-comment:${issue.issueId}:${issue.commentId}` : `issue:${issue.issueId}`,
      title: label || issue.ref || "Issue",
      url: null,
      metadata: {
        issueId: issue.issueId,
        ref: issue.ref,
        commentId: issue.commentId,
      },
    };
  }

  const automation = parseAutomationMentionHref(href);
  if (automation) {
    return {
      targetType: "automation",
      targetKey: `automation:${automation.automationId}`,
      title: label || automation.title || "Automation",
      url: null,
      metadata: {
        automationId: automation.automationId,
      },
    };
  }

  const chat = parseChatMentionHref(href);
  if (chat) {
    const url = parseInternalRouteUrl(href);
    const messageId = url ? chatMessageIdFromUrl(url) : null;
    return {
      targetType: "chat_conversation",
      targetKey: messageId ? `chat:${chat.conversationId}:${messageId}` : `chat:${chat.conversationId}`,
      title: label || chat.title || "Chat",
      url: null,
      metadata: {
        conversationId: chat.conversationId,
        messageId,
      },
    };
  }

  return internalRouteTarget(href, label);
}

export function extractVisibleChatWorkTargets(markdown: string): ExtractedChatWorkTarget[] {
  if (!markdown.trim()) return [];
  const source = stripMarkdownCode(markdown);
  const targets = new Map<string, ExtractedChatWorkTarget>();
  const bareSource = source.split("");

  let linkMatch: RegExpExecArray | null;
  const linkMatcher = new RegExp(MARKDOWN_LINK_RE);
  while ((linkMatch = linkMatcher.exec(source)) !== null) {
    const [raw, imageMarker, rawLabel, rawDestination] = linkMatch;
    bareSource.fill(" ", linkMatch.index, linkMatch.index + raw.length);
    if (imageMarker) continue;
    const label = cleanMarkdownLabel(rawLabel);
    const destination = markdownDestination(rawDestination);
    const target = libraryTarget(destination, label) ?? rudderReferenceTarget(destination, label) ?? externalTarget(destination, label);
    if (target && !targets.has(target.targetKey)) targets.set(target.targetKey, target);
  }

  const bareMatcher = new RegExp(BARE_HTTP_URL_RE);
  const visibleBareSource = bareSource.join("");
  let bareMatch: RegExpExecArray | null;
  while ((bareMatch = bareMatcher.exec(visibleBareSource)) !== null) {
    const rawUrl = bareMatch[0].replace(TRAILING_URL_PUNCTUATION_RE, "");
    const target = externalTarget(rawUrl);
    if (target && !targets.has(target.targetKey)) targets.set(target.targetKey, target);
  }

  return [...targets.values()];
}
