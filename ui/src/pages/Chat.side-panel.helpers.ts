const CHAT_SIDE_PANEL_MARKDOWN_DRAFT_STORAGE_PREFIX = "rudder.chat-side-panel.markdown-draft.v1";

type ChatSidePanelMarkdownDraft = {
  baseContent: string;
  content: string;
  filePath: string;
  organizationId: string;
  updatedAt: string;
};

export type RestoredChatSidePanelMarkdownDraft = {
  baseContent: string;
  conflicted: boolean;
  content: string;
};

function markdownDraftStorageKey(organizationId: string, filePath: string) {
  return `${CHAT_SIDE_PANEL_MARKDOWN_DRAFT_STORAGE_PREFIX}:${encodeURIComponent(organizationId)}:${encodeURIComponent(filePath)}`;
}

export function clearChatSidePanelMarkdownDraft(organizationId: string, filePath: string) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(markdownDraftStorageKey(organizationId, filePath));
  } catch {
    // Storage can be unavailable in hardened browser contexts.
  }
}

export function storeChatSidePanelMarkdownDraft(
  organizationId: string,
  filePath: string,
  baseContent: string,
  content: string,
) {
  if (typeof window === "undefined") return;
  if (content === baseContent) {
    clearChatSidePanelMarkdownDraft(organizationId, filePath);
    return;
  }
  try {
    const draft: ChatSidePanelMarkdownDraft = {
      organizationId,
      filePath,
      baseContent,
      content,
      updatedAt: new Date().toISOString(),
    };
    window.sessionStorage.setItem(markdownDraftStorageKey(organizationId, filePath), JSON.stringify(draft));
  } catch {
    // The editor remains usable when session storage is unavailable.
  }
}

export function restoreChatSidePanelMarkdownDraft(
  organizationId: string,
  filePath: string,
  serverContent: string,
): RestoredChatSidePanelMarkdownDraft {
  const serverDraft = { baseContent: serverContent, conflicted: false, content: serverContent };
  if (typeof window === "undefined") return serverDraft;
  try {
    const stored = window.sessionStorage.getItem(markdownDraftStorageKey(organizationId, filePath));
    if (!stored) return serverDraft;
    const draft = JSON.parse(stored) as Partial<ChatSidePanelMarkdownDraft>;
    const valid = draft.organizationId === organizationId
      && draft.filePath === filePath
      && typeof draft.baseContent === "string"
      && typeof draft.content === "string";
    if (!valid || draft.content === serverContent) {
      clearChatSidePanelMarkdownDraft(organizationId, filePath);
      return serverDraft;
    }
    return {
      baseContent: draft.baseContent as string,
      conflicted: draft.baseContent !== serverContent,
      content: draft.content as string,
    };
  } catch {
    clearChatSidePanelMarkdownDraft(organizationId, filePath);
    return serverDraft;
  }
}

export function splitChatSidePanelYamlFrontmatter(content: string) {
  const match = content.match(/^(---\r?\n[\s\S]*?\r?\n---)(\r?\n|$)/);
  if (!match) return { frontmatter: null, separator: "", body: content };
  return {
    frontmatter: match[1] ?? "",
    separator: match[2] ?? "\n",
    body: content.slice(match[0].length),
  };
}

export function joinChatSidePanelYamlFrontmatter(frontmatter: string | null, separator: string, body: string) {
  return frontmatter === null ? body : `${frontmatter}${separator || "\n"}${body}`;
}

export function countChatSidePanelMarkdownWords(content: string) {
  return content.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

export type BrowserWebviewInputEvent = Event & {
  input?: {
    type?: string;
    key?: string;
    code?: string;
    meta?: boolean;
    control?: boolean;
    alt?: boolean;
    shift?: boolean;
  };
};

export type BrowserLoadError = { code: string; url: string };

function browserErrorHost(url: string) {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

export function chatSidePanelBrowserErrorContent(error: BrowserLoadError) {
  const host = browserErrorHost(error.url);
  if (error.code === "ERR_CONNECTION_REFUSED") {
    return { summary: `${host} refused to connect.`, suggestions: ["Checking the connection", "Checking the proxy and firewall"] };
  }
  if (error.code === "ERR_NAME_NOT_RESOLVED") {
    return { summary: `${host}'s server IP address could not be found.`, suggestions: ["Checking the address", "Checking the connection"] };
  }
  if (error.code === "ERR_TIMED_OUT") {
    return { summary: `${host} took too long to respond.`, suggestions: ["Checking the connection", "Trying again later"] };
  }
  return { summary: `The page at ${host} could not be loaded.`, suggestions: ["Checking the address", "Trying again later"] };
}

export function isChatSidePanelCloseShortcutInput(input: BrowserWebviewInputEvent["input"]) {
  if (!input || input.type === "keyUp") return false;
  const isCloseKey = input.key?.toLowerCase() === "w" || input.code === "KeyW";
  if (!isCloseKey || input.alt || input.shift) return false;
  const isMac = navigator.platform.toLowerCase().includes("mac");
  return isMac ? Boolean(input.meta) && !input.control : Boolean(input.control) && !input.meta;
}
