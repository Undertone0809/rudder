const CHAT_SIDE_PANEL_MARKDOWN_DRAFT_STORAGE_PREFIX = "rudder.chat-side-panel.markdown-draft.v1";

export {
  browserSidePanelErrorContent as chatSidePanelBrowserErrorContent,
  isBrowserSidePanelCloseShortcutInput as isChatSidePanelCloseShortcutInput,
  type BrowserLoadError,
  type BrowserWebviewInputEvent
} from "@/lib/browser-side-panel";

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
