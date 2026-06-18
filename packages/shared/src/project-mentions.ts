export const PROJECT_MENTION_SCHEME = "project://";
export const AGENT_MENTION_SCHEME = "agent://";
export const AUTOMATION_MENTION_SCHEME = "automation://";
export const ISSUE_MENTION_SCHEME = "issue://";
export const CHAT_MENTION_SCHEME = "chat://";
export const LIBRARY_DOC_MENTION_SCHEME = "library-doc://";
export const LIBRARY_ENTRY_MENTION_SCHEME = "library-entry://";
export const LIBRARY_FILE_MENTION_SCHEME = "library-file://";
export const LIBRARY_DIRECTORY_MENTION_SCHEME = "library-directory://";

const PROJECT_MENTION_LINK_RE = /\[[^\]]*]\((project:\/\/[^)\s]+)\)/gi;
const AGENT_MENTION_LINK_RE = /\[[^\]]*]\((agent:\/\/[^)\s]+)\)/gi;
const AUTOMATION_MENTION_LINK_RE = /\[[^\]]*]\((automation:\/\/[^)\s]+)\)/gi;
const ISSUE_MENTION_LINK_RE = /\[[^\]]*]\((issue:\/\/[^)\s]+)\)/gi;
const CHAT_MENTION_LINK_RE = /\[[^\]]*]\((chat:\/\/[^)\s]+)\)/gi;
const LIBRARY_DOC_MENTION_LINK_RE = /\[[^\]]*]\((library-doc:\/\/[^)\s]+)\)/gi;
const LIBRARY_ENTRY_MENTION_LINK_RE = /\[[^\]]*]\((library-entry:\/\/[^)\s]+)\)/gi;
const LIBRARY_FILE_MENTION_LINK_RE = /\[[^\]]*]\((library-file:\/\/[^)\s]+)\)/gi;
const LIBRARY_DIRECTORY_MENTION_LINK_RE = /\[[^\]]*]\((library-directory:\/\/[^)\s]+)\)/gi;

export interface ParsedProjectMention {
  projectId: string;
  color: string | null;
  icon?: string | null;
}

export interface ParsedAgentMention {
  agentId: string;
  icon: string | null;
  intent: "reference" | "wake";
}

export interface ParsedAutomationMention {
  automationId: string;
  title: string | null;
}

export interface ParsedIssueMention {
  issueId: string;
  ref: string | null;
  commentId: string | null;
  status: string | null;
}

export interface ParsedChatMention {
  conversationId: string;
  title: string | null;
}

export interface ParsedLibraryDocMention {
  documentId: string;
  title: string | null;
}

export interface ParsedLibraryEntryMention {
  entryId: string;
  title: string | null;
  path: string | null;
}

export interface ParsedLibraryFileMention {
  filePath: string;
  title: string | null;
}

export interface ParsedLibraryDirectoryMention {
  directoryPath: string;
  title: string | null;
}

function stripMarkdownCode(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");
}

export function buildProjectMentionHref(projectId: string, color?: string | null, icon?: string | null): string {
  void color;
  void icon;
  const trimmedProjectId = projectId.trim();
  return `${PROJECT_MENTION_SCHEME}${trimmedProjectId}`;
}

export function parseProjectMentionHref(href: string): ParsedProjectMention | null {
  if (!href.startsWith(PROJECT_MENTION_SCHEME)) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "project:") return null;

  const projectId = `${url.hostname}${url.pathname}`.replace(/^\/+/, "").trim();
  if (!projectId) return null;

  return {
    projectId,
    color: null,
  };
}

export function buildAgentMentionHref(agentId: string, icon?: string | null, intent?: "reference" | "wake" | null): string {
  void icon;
  const trimmedAgentId = agentId.trim();
  const params = new URLSearchParams();
  if (intent === "wake") params.set("intent", "wake");
  const search = params.toString();
  if (!search) {
    return `${AGENT_MENTION_SCHEME}${trimmedAgentId}`;
  }
  return `${AGENT_MENTION_SCHEME}${trimmedAgentId}?${search}`;
}

export function parseAgentMentionHref(href: string): ParsedAgentMention | null {
  if (!href.startsWith(AGENT_MENTION_SCHEME)) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "agent:") return null;

  const agentId = `${url.hostname}${url.pathname}`.replace(/^\/+/, "").trim();
  if (!agentId) return null;

  return {
    agentId,
    icon: null,
    intent: url.searchParams.get("intent") === "wake" ? "wake" : "reference",
  };
}

export function buildAutomationMentionHref(automationId: string, title?: string | null): string {
  void title;
  const trimmedAutomationId = automationId.trim();
  return `${AUTOMATION_MENTION_SCHEME}${trimmedAutomationId}`;
}

export function parseAutomationMentionHref(href: string): ParsedAutomationMention | null {
  if (!href.startsWith(AUTOMATION_MENTION_SCHEME)) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "automation:") return null;

  const automationId = `${url.hostname}${url.pathname}`.replace(/^\/+/, "").trim();
  if (!automationId) return null;

  return {
    automationId,
    title: null,
  };
}

export function buildIssueMentionHref(issueId: string, ref?: string | null, commentId?: string | null, status?: string | null): string {
  void ref;
  void status;
  const trimmedIssueId = issueId.trim();
  const trimmedCommentId = commentId?.trim();
  const params = new URLSearchParams();
  if (trimmedCommentId) params.set("c", trimmedCommentId);
  const query = params.toString();
  return query ? `${ISSUE_MENTION_SCHEME}${trimmedIssueId}?${query}` : `${ISSUE_MENTION_SCHEME}${trimmedIssueId}`;
}

export function parseIssueMentionHref(href: string): ParsedIssueMention | null {
  if (!href.startsWith(ISSUE_MENTION_SCHEME)) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "issue:") return null;

  const issueId = `${url.hostname}${url.pathname}`.replace(/^\/+/, "").trim();
  if (!issueId) return null;

  const commentId = (url.searchParams.get("c") ?? url.searchParams.get("commentId") ?? "").trim() || null;

  return {
    issueId,
    ref: null,
    commentId,
    status: null,
  };
}

export function buildChatMentionHref(conversationId: string, title?: string | null): string {
  void title;
  const trimmedConversationId = conversationId.trim();
  return `${CHAT_MENTION_SCHEME}${trimmedConversationId}`;
}

export function parseChatMentionHref(href: string): ParsedChatMention | null {
  if (!href.startsWith(CHAT_MENTION_SCHEME)) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "chat:") return null;

  const conversationId = `${url.hostname}${url.pathname}`.replace(/^\/+/, "").trim();
  if (!conversationId) return null;

  return {
    conversationId,
    title: null,
  };
}

export function buildLibraryDocMentionHref(documentId: string, title?: string | null): string {
  void title;
  const trimmedDocumentId = documentId.trim();
  return `${LIBRARY_DOC_MENTION_SCHEME}${trimmedDocumentId}`;
}

export function parseLibraryDocMentionHref(href: string): ParsedLibraryDocMention | null {
  if (!href.startsWith(LIBRARY_DOC_MENTION_SCHEME)) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "library-doc:") return null;

  const documentId = `${url.hostname}${url.pathname}`.replace(/^\/+/, "").trim();
  if (!documentId) return null;

  return {
    documentId,
    title: null,
  };
}

export function buildLibraryEntryMentionHref(entryId: string, title?: string | null, pathHint?: string | null): string {
  void title;
  const trimmedEntryId = entryId.trim();
  const trimmedPathHint = pathHint?.trim() ?? "";
  if (!trimmedPathHint) return `${LIBRARY_ENTRY_MENTION_SCHEME}${trimmedEntryId}`;
  const search = new URLSearchParams({ p: trimmedPathHint });
  return `${LIBRARY_ENTRY_MENTION_SCHEME}${trimmedEntryId}?${search.toString()}`;
}

function escapeMarkdownLinkLabel(label: string): string {
  return label.replace(/([\\[\]])/g, "\\$1");
}

export function buildLibraryEntryMentionMarkdown(entryId: string, label: string, pathHint?: string | null): string {
  return `[${escapeMarkdownLinkLabel(label)}](${buildLibraryEntryMentionHref(entryId, label, pathHint)})`;
}

export function parseLibraryEntryMentionHref(href: string): ParsedLibraryEntryMention | null {
  if (!href.startsWith(LIBRARY_ENTRY_MENTION_SCHEME)) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "library-entry:") return null;

  const entryId = `${url.hostname}${url.pathname}`.replace(/^\/+/, "").trim();
  if (!entryId) return null;
  const path = (url.searchParams.get("p") ?? url.searchParams.get("path") ?? "").trim();

  return {
    entryId,
    title: null,
    path: path || null,
  };
}

export function buildLibraryFileMentionHref(filePath: string, title?: string | null): string {
  void title;
  const trimmedFilePath = filePath.trim();
  const search = new URLSearchParams({ p: trimmedFilePath });
  return `${LIBRARY_FILE_MENTION_SCHEME}file?${search.toString()}`;
}

export function buildLibraryFileMentionMarkdown(filePath: string, label: string): string {
  return `[${escapeMarkdownLinkLabel(label)}](${buildLibraryFileMentionHref(filePath, label)})`;
}

export function parseLibraryFileMentionHref(href: string): ParsedLibraryFileMention | null {
  if (!href.startsWith(LIBRARY_FILE_MENTION_SCHEME)) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "library-file:") return null;

  const filePath = (url.searchParams.get("p") ?? url.searchParams.get("path") ?? "").trim();
  if (!filePath) return null;

  return {
    filePath,
    title: null,
  };
}

export function buildLibraryDirectoryMentionHref(directoryPath: string, title?: string | null): string {
  void title;
  const trimmedDirectoryPath = directoryPath.trim();
  const search = new URLSearchParams({ p: trimmedDirectoryPath });
  return `${LIBRARY_DIRECTORY_MENTION_SCHEME}directory?${search.toString()}`;
}

export function parseLibraryDirectoryMentionHref(href: string): ParsedLibraryDirectoryMention | null {
  if (!href.startsWith(LIBRARY_DIRECTORY_MENTION_SCHEME)) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "library-directory:") return null;

  const directoryPath = (url.searchParams.get("p") ?? url.searchParams.get("path") ?? "").trim();
  if (!directoryPath) return null;

  return {
    directoryPath,
    title: null,
  };
}

export function extractProjectMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(PROJECT_MENTION_LINK_RE);
  const source = stripMarkdownCode(markdown);
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const parsed = parseProjectMentionHref(match[1]);
    if (parsed) ids.add(parsed.projectId);
  }
  return [...ids];
}

export function extractAgentMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(AGENT_MENTION_LINK_RE);
  const source = stripMarkdownCode(markdown);
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const parsed = parseAgentMentionHref(match[1]);
    if (parsed) ids.add(parsed.agentId);
  }
  return [...ids];
}

export function extractAgentWakeMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(AGENT_MENTION_LINK_RE);
  const source = stripMarkdownCode(markdown);
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const parsed = parseAgentMentionHref(match[1]);
    if (parsed?.intent === "wake") ids.add(parsed.agentId);
  }
  return [...ids];
}

export function extractAutomationMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(AUTOMATION_MENTION_LINK_RE);
  const source = stripMarkdownCode(markdown);
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const parsed = parseAutomationMentionHref(match[1]);
    if (parsed) ids.add(parsed.automationId);
  }
  return [...ids];
}

export function extractIssueMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(ISSUE_MENTION_LINK_RE);
  const source = stripMarkdownCode(markdown);
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const parsed = parseIssueMentionHref(match[1]);
    if (parsed) ids.add(parsed.issueId);
  }
  return [...ids];
}

export function extractChatMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(CHAT_MENTION_LINK_RE);
  const source = stripMarkdownCode(markdown);
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const parsed = parseChatMentionHref(match[1]);
    if (parsed) ids.add(parsed.conversationId);
  }
  return [...ids];
}

export function extractLibraryDocMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(LIBRARY_DOC_MENTION_LINK_RE);
  const source = stripMarkdownCode(markdown);
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const parsed = parseLibraryDocMentionHref(match[1]);
    if (parsed) ids.add(parsed.documentId);
  }
  return [...ids];
}

export function extractLibraryEntryMentionIds(markdown: string): string[] {
  if (!markdown) return [];
  const ids = new Set<string>();
  const re = new RegExp(LIBRARY_ENTRY_MENTION_LINK_RE);
  const source = stripMarkdownCode(markdown);
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const parsed = parseLibraryEntryMentionHref(match[1]);
    if (parsed) ids.add(parsed.entryId);
  }
  return [...ids];
}

export function extractLibraryFileMentionPaths(markdown: string): string[] {
  if (!markdown) return [];
  const paths = new Set<string>();
  const re = new RegExp(LIBRARY_FILE_MENTION_LINK_RE);
  const source = stripMarkdownCode(markdown);
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const parsed = parseLibraryFileMentionHref(match[1]);
    if (parsed) paths.add(parsed.filePath);
  }
  return [...paths];
}

export function extractLibraryDirectoryMentionPaths(markdown: string): string[] {
  if (!markdown) return [];
  const paths = new Set<string>();
  const re = new RegExp(LIBRARY_DIRECTORY_MENTION_LINK_RE);
  const source = stripMarkdownCode(markdown);
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const parsed = parseLibraryDirectoryMentionHref(match[1]);
    if (parsed) paths.add(parsed.directoryPath);
  }
  return [...paths];
}
