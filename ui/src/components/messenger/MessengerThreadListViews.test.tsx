// @vitest-environment jsdom

import type { ChatConversation, MessengerThreadSummary } from "@rudderhq/shared";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatThreadRow,
  conversationDisplayTitle,
  MessengerDragHandle,
  nonEmptyString,
  sanitizeThreadKey,
  ThreadRow,
} from "./MessengerThreadListViews";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, onClick, ...props }: { children: ReactNode; to: string; onClick?: () => void }) => (
    <a
      href={to}
      {...props}
      onClick={(event) => {
        event.preventDefault();
        onClick?.();
      }}
    >
      {children}
    </a>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children, side: _side, align: _align, sideOffset: _sideOffset, collisionPadding: _collisionPadding, ...props }: {
    children: ReactNode;
    side?: string;
    align?: string;
    sideOffset?: number;
    collisionPadding?: number;
  }) => <aside {...props}>{children}</aside>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, disabled, onClick }: { children: ReactNode; disabled?: boolean; onClick?: () => void }) => (
    <button type="button" disabled={disabled} onClick={onClick}>{children}</button>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuSub: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function render(element: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

function button(container: ParentNode, label: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((candidate) => candidate.textContent?.trim() === label);
}

describe("thread list helpers", () => {
  it("sanitizes stable DOM keys and rejects blank or non-string values", () => {
    expect(sanitizeThreadKey("issue:ABC/42?tab=run")).toBe("issue-ABC-42-tab-run");
    expect(nonEmptyString("  useful ")).toBe("  useful ");
    expect(nonEmptyString("   ")).toBeNull();
    expect(nonEmptyString(42)).toBeNull();
  });

  it("derives a useful conversation title from the highest-priority available context", () => {
    expect(conversationDisplayTitle({
      title: "New chat",
      summary: "Architecture review",
      latestUserMessagePreview: "Please inspect the boundaries",
      latestReplyPreview: null,
    })).toBe("Architecture review");
    expect(conversationDisplayTitle({
      title: "New chat",
      summary: null,
      latestUserMessagePreview: "Please inspect the boundaries",
      latestReplyPreview: null,
    })).toContain("Please inspect the boundaries");
  });
});

describe("MessengerDragHandle", () => {
  it("stays absent without sortable props and forwards accessible drag bindings when enabled", () => {
    const empty = render(<MessengerDragHandle label="Drag thread" />);
    expect(empty.querySelector("button")).toBeNull();

    act(() => root?.unmount());
    root = null;
    const onPointerDown = vi.fn();
    const enabled = render(
      <MessengerDragHandle
        label="Drag thread"
        compact
        dragHandleProps={{
          attributes: {
            role: "button",
            tabIndex: 0,
            "aria-disabled": false,
            "aria-pressed": undefined,
            "aria-roledescription": "sortable",
            "aria-describedby": "drag-instructions",
          },
          listeners: { onPointerDown },
        }}
      />,
    );
    const handle = enabled.querySelector<HTMLButtonElement>('[aria-label="Drag thread"]');
    expect(handle?.getAttribute("aria-roledescription")).toBe("sortable");
    act(() => handle?.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(onPointerDown).toHaveBeenCalledOnce();
  });
});

function conversation(overrides: Partial<ChatConversation> = {}): ChatConversation {
  const now = new Date("2026-07-18T04:00:00.000Z");
  return {
    id: "chat-1",
    orgId: "org-1",
    status: "active",
    mutability: "native_chat",
    title: "Runtime boundaries",
    summary: "Keep changes local",
    latestReplyPreview: "The extraction is ready",
    latestUserMessagePreview: "Review this boundary",
    userMessageCount: 1,
    preferredAgentId: null,
    routedAgentId: null,
    primaryIssueId: null,
    forkedFromConversationId: null,
    forkedFromMessageId: null,
    forkRootConversationId: null,
    primaryIssue: null,
    issueCreationMode: "manual_approval",
    planMode: false,
    createdByUserId: null,
    lastMessageAt: now,
    lastReadAt: null,
    isPinned: false,
    isUnread: true,
    unreadCount: 120,
    needsAttention: true,
    resolvedAt: null,
    contextLinks: [],
    chatRuntime: {} as ChatConversation["chatRuntime"],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("ChatThreadRow", () => {
  it("renders unread/source/generation states and routes selection and primary actions", () => {
    const handlers = {
      onRenameDraftChange: vi.fn(), onCommitRename: vi.fn(), onCancelRename: vi.fn(),
      onStartRename: vi.fn(), onRegenerateTitle: vi.fn(), onFork: vi.fn(), onArchive: vi.fn(),
      onDelete: vi.fn(), onTogglePin: vi.fn(), onToggleUnread: vi.fn(), onCopyConversationLink: vi.fn(), onSelect: vi.fn(),
    };
    const group = {
      id: "group-1", orgId: "org-1", userId: "user-1", name: "Critical", icon: "brain::red",
      sortOrder: 0, collapsed: false, pinnedAt: null, createdAt: new Date(), updatedAt: new Date(), entries: [],
    };
    const container = render(
      <ChatThreadRow
        conversation={conversation()}
        agent={null}
        agentId={null}
        sourceBadge={{ key: "feishu", label: "Feishu" }}
        href="/messenger/chat/chat-1"
        active={false}
        generating={false}
        density="comfortable"
        renaming={false}
        renameDraft=""
        titleGenerating
        customGroups={[group]}
        customGroupId="other-group"
        customGroupPending={false}
        onMoveToCustomGroup={vi.fn()}
        onRemoveFromCustomGroup={vi.fn()}
        {...handlers}
      />,
    );

    expect(container.textContent).toContain("Runtime boundaries");
    expect(container.textContent).toContain("Feishu");
    expect(container.querySelector('[data-testid$="unread-badge"]')?.textContent).toBe("99+");
    expect(container.querySelector('[aria-label="Generating chat title"]')).toBeTruthy();
    expect(button(container, "Move out of group")?.querySelector("svg")).toBeNull();
    expect(button(container, "Critical")?.querySelector("svg")).not.toBeNull();
    act(() => {
      container.querySelector<HTMLAnchorElement>('a[href="/messenger/chat/chat-1"]')?.click();
      button(container, "Fork")?.click();
      button(container, "Mark as Read")?.click();
      button(container, "Copy Chat Link")?.click();
    });
    expect(handlers.onSelect).toHaveBeenCalledWith("/messenger/chat/chat-1");
    expect(handlers.onFork).toHaveBeenCalledOnce();
    expect(handlers.onToggleUnread).toHaveBeenCalledOnce();
    expect(handlers.onCopyConversationLink).toHaveBeenCalledOnce();
  });

  it("commits or cancels inline renaming from keyboard and input changes", () => {
    const onRenameDraftChange = vi.fn();
    const onCommitRename = vi.fn();
    const onCancelRename = vi.fn();
    const container = render(
      <ChatThreadRow
        conversation={conversation({ unreadCount: 0 })}
        agent={null} agentId={null} href="/chat" active generating={false} density="compact"
        renaming renameDraft="Draft" onRenameDraftChange={onRenameDraftChange}
        onCommitRename={onCommitRename} onCancelRename={onCancelRename}
        onFork={vi.fn()} onArchive={vi.fn()} onDelete={vi.fn()} onTogglePin={vi.fn()}
        onToggleUnread={vi.fn()} onCopyConversationLink={vi.fn()} onSelect={vi.fn()}
      />,
    );
    const input = container.querySelector<HTMLInputElement>("input")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(input, "Renamed");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onRenameDraftChange).toHaveBeenCalledWith("Renamed");
    expect(onCommitRename).toHaveBeenCalledOnce();
    expect(onCancelRename).toHaveBeenCalledOnce();
  });
});

function issueThread(overrides: Partial<MessengerThreadSummary> = {}): MessengerThreadSummary {
  return {
    threadKey: "issue:ISS-42",
    kind: "issues",
    title: "Bound runtime fan-out",
    subtitle: "Issue fallback",
    preview: "Direct preview",
    latestActivityAt: new Date("2026-07-18T04:00:00.000Z"),
    lastReadAt: null,
    unreadCount: 3,
    needsAttention: true,
    isPinned: true,
    href: "/issues/issue-42",
    metadata: {
      splitIssue: true,
      issueIdentifier: "ISS-42",
      description: "Production-shaped issue detail",
      status: "in_progress",
      priority: "high",
    },
    ...overrides,
  };
}

describe("ThreadRow", () => {
  it("renders issue-specific status and invokes selection, pin, hide, and group callbacks", () => {
    const onSelect = vi.fn();
    const onTogglePin = vi.fn();
    const onHideIssue = vi.fn();
    const onMoveToCustomGroup = vi.fn();
    const onRemoveFromCustomGroup = vi.fn();
    const onCreateCustomGroup = vi.fn();
    const group = {
      id: "group-1", orgId: "org-1", userId: "user-1", name: "Critical", icon: "brain::red",
      sortOrder: 0, collapsed: false, pinnedAt: null, createdAt: new Date(), updatedAt: new Date(), entries: [],
    };
    const thread = issueThread();
    const container = render(
      <ThreadRow
        thread={thread} active={false} density="comfortable" onTogglePin={onTogglePin}
        onHideIssue={onHideIssue} customGroups={[group]} customGroupId="other-group"
        customGroupPending={false} onMoveToCustomGroup={onMoveToCustomGroup}
        onRemoveFromCustomGroup={onRemoveFromCustomGroup} onCreateCustomGroup={onCreateCustomGroup}
        onSelect={onSelect}
      />,
    );

    expect(container.querySelector('[title="Issue status: in progress"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="issue-ISS-42-unread-badge"]')?.textContent).toBe("3");
    expect(container.textContent).toContain("Direct preview");
    expect(button(container, "Move out of group")?.querySelector("svg")).toBeNull();
    expect(button(container, "Critical")?.querySelector("svg")).not.toBeNull();
    act(() => {
      container.querySelector<HTMLAnchorElement>('a[href="/issues/issue-42"]')?.click();
      button(container, "Unpin")?.click();
      button(container, "Hide")?.click();
      button(container, "Critical")?.click();
      button(container, "Move out of group")?.click();
      button(container, "New group")?.click();
    });
    expect(onSelect).toHaveBeenCalledWith(thread);
    expect(onTogglePin).toHaveBeenCalledOnce();
    expect(onHideIssue).toHaveBeenCalledOnce();
    expect(onMoveToCustomGroup).toHaveBeenCalledWith("group-1");
    expect(onRemoveFromCustomGroup).toHaveBeenCalledOnce();
    expect(onCreateCustomGroup).toHaveBeenCalledWith(expect.any(HTMLElement), expect.any(HTMLButtonElement));
  });

  it("replaces row actions with an active-run indicator and hides non-split controls", () => {
    const running = issueThread({
      metadata: { ...issueThread().metadata, activeExecutionRunId: "run-1" },
    });
    const container = render(
      <ThreadRow thread={running} active density="compact" onTogglePin={vi.fn()} onSelect={vi.fn()} />,
    );
    expect(container.querySelector('[aria-label="Issue run in progress"]')).toBeTruthy();

    act(() => root?.render(
      <ThreadRow
        thread={{ ...running, threadKey: "system:approvals", kind: "approvals", metadata: {}, isPinned: true }}
        active={false} density="compact" onTogglePin={vi.fn()} onSelect={vi.fn()}
      />,
    ));
    expect(document.querySelector('[aria-label="Thread actions"]')).toBeNull();
    expect(document.querySelector('[aria-label="Unpin thread"]')).toBeNull();
  });
});
