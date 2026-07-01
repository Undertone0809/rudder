import { chatsApi } from "@/api/chats";
import { issuesApi } from "@/api/issues";
import { organizationsApi } from "@/api/orgs";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import type { OrganizationWorkspaceFileEntry } from "@rudderhq/shared";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileText,
  Folder,
  Image as ImageIcon,
  MessageSquareText,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { conversationDisplayTitle, type ChatSidePanelTarget } from "./Chat.parts";

const CHAT_SIDE_PANEL_IMAGE_FILE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
]);
const CHAT_SIDE_PANEL_TEXT_DOCUMENT_FILE_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdown",
  ".mdx",
  ".txt",
  ".text",
]);

function sidePanelTargetKey(target: ChatSidePanelTarget) {
  if (target.kind === "issue") return `issue:${target.issueId}:${target.commentId ?? ""}`;
  if (target.kind === "chat") return `chat:${target.conversationId}:${target.messageId ?? ""}`;
  if (target.kind === "library_file") return `library-file:${target.filePath}`;
  if (target.kind === "library_directory") return `library-directory:${target.directoryPath}`;
  return `library-entry:${target.entryId}:${target.path ?? ""}`;
}

function sidePanelTargetTypeLabel(target: ChatSidePanelTarget) {
  if (target.kind === "issue") return "Issue";
  if (target.kind === "chat") return "Chat";
  if (target.kind === "library_directory") return "Library folder";
  if (target.kind === "library_entry") return "Library entry";
  return "Library file";
}

function sidePanelIcon(target: ChatSidePanelTarget) {
  if (target.kind === "chat") return <MessageSquareText className="h-4 w-4" aria-hidden />;
  if (target.kind === "library_directory") return <Folder className="h-4 w-4" aria-hidden />;
  return <FileText className="h-4 w-4" aria-hidden />;
}

function chatSidePanelFullPageHref(target: ChatSidePanelTarget) {
  if (target.kind === "issue") {
    const base = `/issues/${target.issueId}`;
    return target.commentId ? `${base}#comment-${encodeURIComponent(target.commentId)}` : base;
  }
  if (target.kind === "chat") {
    const base = `/messenger/chat/${target.conversationId}`;
    return target.messageId ? `${base}?messageId=${encodeURIComponent(target.messageId)}` : base;
  }
  if (target.kind === "library_file") return `/library?path=${encodeURIComponent(target.filePath)}`;
  if (target.kind === "library_directory") {
    return target.directoryPath
      ? `/library?directory=${encodeURIComponent(target.directoryPath)}`
      : "/library";
  }
  const search = new URLSearchParams({ entry: target.entryId });
  if (target.path) search.set("path", target.path);
  return `/library?${search.toString()}`;
}

function LoadingPanelBody() {
  return (
    <div className="space-y-3" data-testid="chat-side-panel-loading">
      <div className="h-4 w-2/3 animate-pulse rounded bg-[color:var(--surface-active)]" />
      <div className="h-20 animate-pulse rounded-[var(--radius-lg)] bg-[color:var(--surface-active)]" />
      <div className="h-28 animate-pulse rounded-[var(--radius-lg)] bg-[color:var(--surface-active)]" />
    </div>
  );
}

function chatSidePanelWorkspaceFileExtension(filePath: string | null) {
  if (!filePath) return null;
  const basename = filePath.split("/").at(-1) ?? filePath;
  const extensionIndex = basename.lastIndexOf(".");
  return extensionIndex === -1 ? null : basename.slice(extensionIndex).toLowerCase();
}

function isChatSidePanelWorkspaceImageFile(filePath: string | null) {
  const extension = chatSidePanelWorkspaceFileExtension(filePath);
  return extension !== null && CHAT_SIDE_PANEL_IMAGE_FILE_EXTENSIONS.has(extension);
}

function isChatSidePanelWorkspaceTextDocumentFile(filePath: string | null) {
  const extension = chatSidePanelWorkspaceFileExtension(filePath);
  return extension !== null && CHAT_SIDE_PANEL_TEXT_DOCUMENT_FILE_EXTENSIONS.has(extension);
}

function displayChatSidePanelWorkspaceEntryLabel(entry: Pick<OrganizationWorkspaceFileEntry, "displayLabel" | "name">) {
  return entry.displayLabel?.trim() || entry.name;
}

function ChatSidePanelLibraryTree({
  entries,
  selectedOrganizationId,
  onOpenTarget,
}: {
  entries: OrganizationWorkspaceFileEntry[];
  selectedOrganizationId: string | null | undefined;
  onOpenTarget: (target: ChatSidePanelTarget) => void;
}) {
  if (entries.length === 0) {
    return <div className="px-2 py-3 text-sm text-muted-foreground">This folder is empty or unavailable.</div>;
  }

  return (
    <ul className="space-y-0.5">
      {entries.map((entry) => (
        <ChatSidePanelLibraryTreeNode
          key={entry.path}
          entry={entry}
          selectedOrganizationId={selectedOrganizationId}
          onOpenTarget={onOpenTarget}
        />
      ))}
    </ul>
  );
}

function ChatSidePanelLibraryTreeNode({
  entry,
  selectedOrganizationId,
  onOpenTarget,
  depth = 0,
}: {
  entry: OrganizationWorkspaceFileEntry;
  selectedOrganizationId: string | null | undefined;
  onOpenTarget: (target: ChatSidePanelTarget) => void;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const primaryLabel = displayChatSidePanelWorkspaceEntryLabel(entry);
  const childrenQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceFiles(selectedOrganizationId ?? "__none__", entry.path),
    queryFn: () => organizationsApi.listWorkspaceFiles(selectedOrganizationId!, entry.path),
    enabled: Boolean(selectedOrganizationId && entry.isDirectory && expanded),
    refetchOnWindowFocus: false,
  });
  const childEntries = childrenQuery.data?.entries ?? [];

  if (entry.isDirectory) {
    return (
      <li>
        <div
          className="group flex w-full items-center rounded-md pr-1 text-sm text-foreground transition-[background-color,color,opacity,transform] duration-150 hover:bg-accent/60"
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
          data-workspace-entry-path={entry.path}
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-0 pr-2 text-left"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </span>
            <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{primaryLabel}</div>
            </div>
          </button>
        </div>
        {expanded ? (
          childrenQuery.isPending ? (
            <div
              className="px-2 py-1.5 text-sm text-muted-foreground"
              style={{ paddingLeft: `${(depth + 1) * 14 + 23}px` }}
            >
              Loading files...
            </div>
          ) : childEntries.length > 0 ? (
            <ul className="space-y-0.5">
              {childEntries.map((childEntry) => (
                <ChatSidePanelLibraryTreeNode
                  key={childEntry.path}
                  entry={childEntry}
                  selectedOrganizationId={selectedOrganizationId}
                  onOpenTarget={onOpenTarget}
                  depth={depth + 1}
                />
              ))}
            </ul>
          ) : null
        ) : null}
      </li>
    );
  }

  const FileIcon = isChatSidePanelWorkspaceImageFile(entry.path)
    ? ImageIcon
    : isChatSidePanelWorkspaceTextDocumentFile(entry.path)
      ? FileText
      : FileCode2;

  return (
    <li>
      <div
        className="group flex w-full items-center rounded-md pr-1 text-sm text-muted-foreground transition-[background-color,color,opacity,transform] duration-150 hover:bg-accent/50 hover:text-foreground"
        style={{ paddingLeft: `${depth * 14 + 23}px` }}
        data-workspace-entry-path={entry.path}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-0 pr-2 text-left"
          onClick={() => onOpenTarget({
            kind: "library_file",
            filePath: entry.path,
            label: primaryLabel,
          })}
        >
          <FileIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{primaryLabel}</span>
        </button>
      </div>
    </li>
  );
}

export function ChatSidePanel({
  target,
  selectedOrganizationId,
  onClose,
}: {
  target: ChatSidePanelTarget | null;
  selectedOrganizationId: string | null | undefined;
  onClose: () => void;
}) {
  const [tabs, setTabs] = useState<ChatSidePanelTarget[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    const nextKey = sidePanelTargetKey(target);
    setTabs((current) => {
      if (current.some((candidate) => sidePanelTargetKey(candidate) === nextKey)) {
        return current.map((candidate) => (sidePanelTargetKey(candidate) === nextKey ? target : candidate));
      }
      return [...current, target];
    });
    setActiveKey(nextKey);
  }, [target]);

  const visibleTabs = tabs.length > 0 ? tabs : target ? [target] : [];
  const activeTarget = useMemo(() => {
    if (visibleTabs.length === 0) return null;
    if (activeKey) {
      const matchingTab = visibleTabs.find((candidate) => sidePanelTargetKey(candidate) === activeKey);
      if (matchingTab) return matchingTab;
    }
    return visibleTabs.at(-1) ?? null;
  }, [activeKey, visibleTabs]);

  const issueTarget = activeTarget?.kind === "issue" ? activeTarget : null;
  const chatTarget = activeTarget?.kind === "chat" ? activeTarget : null;
  const libraryFileTarget = activeTarget?.kind === "library_file" ? activeTarget : null;
  const libraryDirectoryTarget = activeTarget?.kind === "library_directory" ? activeTarget : null;

  const issueQuery = useQuery({
    queryKey: queryKeys.issues.detail(issueTarget?.issueId ?? "__none__"),
    queryFn: () => issuesApi.get(issueTarget!.issueId),
    enabled: !!issueTarget,
  });
  const chatQuery = useQuery({
    queryKey: queryKeys.chats.detail(selectedOrganizationId ?? "__none__", chatTarget?.conversationId ?? "__none__"),
    queryFn: () => chatsApi.get(chatTarget!.conversationId),
    enabled: !!selectedOrganizationId && !!chatTarget,
  });
  const chatMessagesQuery = useQuery({
    queryKey: queryKeys.chats.messages(selectedOrganizationId ?? "__none__", chatTarget?.conversationId ?? "__none__"),
    queryFn: () => chatsApi.listMessages(chatTarget!.conversationId),
    enabled: !!selectedOrganizationId && !!chatTarget,
  });
  const libraryFileQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceFile(selectedOrganizationId ?? "__none__", libraryFileTarget?.filePath ?? ""),
    queryFn: () => organizationsApi.readWorkspaceFile(selectedOrganizationId!, libraryFileTarget!.filePath),
    enabled: !!selectedOrganizationId && !!libraryFileTarget,
  });
  const libraryDirectoryQuery = useQuery({
    queryKey: queryKeys.organizations.workspaceFiles(selectedOrganizationId ?? "__none__", libraryDirectoryTarget?.directoryPath ?? ""),
    queryFn: () => organizationsApi.listWorkspaceFiles(selectedOrganizationId!, libraryDirectoryTarget!.directoryPath),
    enabled: !!selectedOrganizationId && !!libraryDirectoryTarget,
  });

  if (!activeTarget) return null;

  const loading = Boolean(
    (issueTarget && issueQuery.isPending)
      || (chatTarget && (chatQuery.isPending || chatMessagesQuery.isPending))
      || (libraryFileTarget && libraryFileQuery.isPending)
      || (libraryDirectoryTarget && libraryDirectoryQuery.isPending),
  );
  const error = issueQuery.error ?? chatQuery.error ?? chatMessagesQuery.error ?? libraryFileQuery.error ?? libraryDirectoryQuery.error;
  const fullPageHref = chatSidePanelFullPageHref(activeTarget);
  const issue = issueTarget ? issueQuery.data : null;
  const chat = chatTarget ? chatQuery.data : null;
  const chatMessages = chatTarget ? (chatMessagesQuery.data ?? []) : [];
  const libraryFile = libraryFileTarget ? libraryFileQuery.data : null;
  const libraryDirectory = libraryDirectoryTarget ? libraryDirectoryQuery.data : null;
  const activeTargetKey = sidePanelTargetKey(activeTarget);

  const closePanel = () => {
    setTabs([]);
    setActiveKey(null);
    onClose();
  };

  const openSidePanelTarget = (nextTarget: ChatSidePanelTarget) => {
    const nextKey = sidePanelTargetKey(nextTarget);
    setTabs((current) => {
      if (current.some((candidate) => sidePanelTargetKey(candidate) === nextKey)) {
        return current.map((candidate) => (sidePanelTargetKey(candidate) === nextKey ? nextTarget : candidate));
      }
      return [...current, nextTarget];
    });
    setActiveKey(nextKey);
  };

  const closeSidePanelTab = (tab: ChatSidePanelTarget) => {
    const closingKey = sidePanelTargetKey(tab);
    if (visibleTabs.length <= 1) {
      closePanel();
      return;
    }

    const closingIndex = visibleTabs.findIndex((candidate) => sidePanelTargetKey(candidate) === closingKey);
    const nextTabs = visibleTabs.filter((candidate) => sidePanelTargetKey(candidate) !== closingKey);
    setTabs(nextTabs);
    if (closingKey === activeTargetKey) {
      const fallbackTarget = nextTabs[Math.min(Math.max(closingIndex, 0), nextTabs.length - 1)] ?? nextTabs.at(-1) ?? null;
      setActiveKey(fallbackTarget ? sidePanelTargetKey(fallbackTarget) : null);
    }
  };

  const libraryDirectoryEntries = libraryDirectory?.entries ?? [];
  const libraryDirectoryFileCount = libraryDirectoryEntries.filter((entry) => !entry.isDirectory).length;
  const libraryDirectoryFolderCount = libraryDirectoryEntries.length - libraryDirectoryFileCount;

  const isMobile = typeof window !== "undefined" && window.matchMedia?.("(max-width: 767px)").matches;

  return (
    <aside
      key={activeTargetKey}
      data-testid="chat-side-panel"
      className={cn(
        "motion-chat-side-panel flex min-h-0 w-full shrink-0 flex-col overflow-hidden border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-panel)_94%,transparent)] shadow-[var(--shadow-sm)]",
        isMobile
          ? "fixed inset-x-3 bottom-3 top-[4.75rem] z-40 rounded-[var(--radius-xl)] border shadow-[0_24px_90px_-36px_rgb(0_0_0/0.75)]"
          : "border-t md:w-[min(420px,36vw)] md:border-l md:border-t-0",
      )}
      aria-label="Side Panel"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[color:var(--border-soft)] px-4 py-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Side Panel</p>
            <h2 className="mt-1 flex min-w-0 items-center gap-2 truncate text-sm font-semibold text-foreground">
              <span className="shrink-0 text-muted-foreground">{sidePanelIcon(activeTarget)}</span>
              <span className="truncate">{activeTarget.label}</span>
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{sidePanelTargetTypeLabel(activeTarget)}</p>
          </div>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Close Side Panel" onClick={closePanel}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        {visibleTabs.length > 1 ? (
          <div
            role="tablist"
            aria-label="Side Panel targets"
            data-testid="chat-side-panel-tabs"
            className="scrollbar-auto-hide flex shrink-0 gap-1 overflow-x-auto border-b border-[color:var(--border-soft)] px-3 py-2"
          >
            {visibleTabs.map((tab) => {
              const tabKey = sidePanelTargetKey(tab);
              const selected = tabKey === activeTargetKey;
              return (
                <div
                  key={tabKey}
                  role="presentation"
                  className={cn(
                    "group flex max-w-[12.5rem] shrink-0 items-center rounded-full border pr-1 transition-colors",
                    selected
                      ? "border-[color:var(--border-strong)] bg-[color:var(--surface-active)] text-foreground"
                      : "border-transparent text-muted-foreground hover:bg-[color:var(--surface-active)] hover:text-foreground",
                  )}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    data-testid="chat-side-panel-tab"
                    className="min-w-0 flex-1 truncate rounded-l-full px-3 py-1.5 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    onClick={() => setActiveKey(tabKey)}
                  >
                    {tab.label}
                  </button>
                  <button
                    type="button"
                    data-testid="chat-side-panel-tab-close"
                    aria-label={`Close ${tab.label} tab`}
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[color:var(--surface-panel)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeSidePanelTab(tab);
                    }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
        <div className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {loading ? (
            <LoadingPanelBody />
          ) : error ? (
            <div role="alert" className="rounded-[var(--radius-lg)] border border-destructive/30 bg-destructive/10 px-3 py-3 text-sm text-destructive">
              {error instanceof Error ? error.message : "Could not load this Side Panel target."}
            </div>
          ) : issueTarget && issue ? (
            <div className="space-y-4" data-testid="chat-side-panel-issue-view">
              <div className="rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] px-3 py-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono">{issue.identifier ?? issue.id.slice(0, 8)}</span>
                  <span>·</span>
                  <span>{issue.status.replace(/_/g, " ")}</span>
                  <span>·</span>
                  <span>{issue.priority}</span>
                </div>
                <h3 className="mt-2 text-base font-semibold leading-6 text-foreground">{issue.title}</h3>
                {issue.description ? (
                  <p className="mt-2 line-clamp-6 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{issue.description}</p>
                ) : null}
              </div>
              {issueTarget.commentId ? <p className="text-xs text-muted-foreground">Target comment: {issueTarget.commentId}</p> : null}
            </div>
          ) : chatTarget ? (
            <div className="space-y-4" data-testid="chat-side-panel-chat-view">
              <div className="rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] px-3 py-3">
                <h3 className="text-base font-semibold text-foreground">{chat ? conversationDisplayTitle(chat) : activeTarget.label}</h3>
                {chat?.summary ? <p className="mt-2 text-sm leading-6 text-muted-foreground">{chat.summary}</p> : null}
                <p className="mt-2 text-xs text-muted-foreground">{chatMessages.length} message{chatMessages.length === 1 ? "" : "s"}</p>
              </div>
              <div className="space-y-2">
                {chatMessages.slice(-3).map((message) => (
                  <div key={message.id} className={cn("rounded-[var(--radius-md)] border border-[color:var(--border-soft)] px-3 py-2 text-sm", message.id === chatTarget.messageId && "border-[color:var(--accent-base)] bg-[color:color-mix(in_oklab,var(--accent-base)_10%,transparent)]")}>
                    <div className="mb-1 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{message.role}</div>
                    <p className="line-clamp-4 whitespace-pre-wrap text-muted-foreground">{message.body || message.kind}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : libraryFileTarget && libraryFile ? (
            <div className="space-y-4" data-testid="chat-side-panel-library-file-view">
              <div className="rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] px-3 py-3 text-sm">
                <div className="font-mono text-xs text-muted-foreground">{libraryFile.filePath}</div>
                <div className="mt-2 text-xs text-muted-foreground">{libraryFile.contentType ?? libraryFile.previewKind}{libraryFile.truncated ? " · truncated" : ""}</div>
              </div>
              {libraryFile.previewKind === "text" && libraryFile.content !== null ? (
                <pre className="max-h-[52vh] overflow-auto rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] bg-[color:var(--code-surface)] p-3 text-xs leading-5 text-[color:var(--code-foreground)]"><code>{libraryFile.content}</code></pre>
              ) : libraryFile.previewKind === "image" && libraryFile.contentPath ? (
                <img src={libraryFile.contentPath} alt={libraryFile.filePath} className="max-h-[52vh] rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] object-contain" />
              ) : (
                <p className="text-sm text-muted-foreground">No inline preview is available for this file.</p>
              )}
            </div>
          ) : libraryDirectoryTarget ? (
            <div className="space-y-3" data-testid="chat-side-panel-library-directory-view">
              {libraryDirectory ? (
                <div className="rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] px-3 py-2 text-sm">
                  <div className="truncate font-mono text-xs text-muted-foreground">{libraryDirectory.directoryPath || "Library root"}</div>
                  <div className="mt-1 text-xs text-muted-foreground" data-testid="chat-side-panel-library-file-count">
                    {libraryDirectoryFileCount} file{libraryDirectoryFileCount === 1 ? "" : "s"} · {libraryDirectoryFolderCount} folder{libraryDirectoryFolderCount === 1 ? "" : "s"}
                  </div>
                </div>
              ) : null}
              <ChatSidePanelLibraryTree
                entries={libraryDirectoryEntries}
                selectedOrganizationId={selectedOrganizationId}
                onOpenTarget={openSidePanelTarget}
              />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Open this target in the full page for details.</p>
          )}
        </div>
        <div className="flex shrink-0 justify-end border-t border-[color:var(--border-soft)] px-4 py-3">
          <Link to={fullPageHref} className="inline-flex h-8 items-center rounded-[var(--radius-sm)] px-3 text-sm text-muted-foreground transition-colors hover:bg-[color:var(--surface-active)] hover:text-foreground">
            Open full page
          </Link>
        </div>
      </div>
    </aside>
  );
}
