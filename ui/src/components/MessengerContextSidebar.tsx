import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { chatsApi } from "@/api/chats";
import { ApiError } from "@/api/client";
import { messengerApi } from "@/api/messenger";
import { organizationsApi } from "@/api/orgs";
import { projectsApi } from "@/api/projects";
import {
  composeCustomGroupIconValue,
  CUSTOM_GROUP_COLOR_OPTIONS,
  CUSTOM_GROUP_TONES,
  customGroupColorFor,
  CustomGroupEditor,
  CustomGroupIcon,
  CustomGroupIconPicker,
  customGroupProjectColorCssVars,
  CustomGroupRenameForm,
  customGroupStyle,
  splitCustomGroupIconValue,
  type CustomGroupColor,
} from "@/components/messenger/MessengerCustomGroupVisuals";
import {
  ChatThreadRow,
  conversationDisplayTitle,
  MessengerDragHandle,
  nonEmptyString,
  sanitizeThreadKey,
  ThreadRow,
  type SortableDragHandleProps
} from "@/components/messenger/MessengerThreadListViews";
import { ProjectIcon } from "@/components/ProjectIdentity";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useChatGenerations } from "@/context/ChatGenerationContext";
import { useDialog } from "@/context/DialogContext";
import { useOrganization } from "@/context/OrganizationContext";
import { useSidebar } from "@/context/SidebarContext";
import { resolveMessengerRoute, useMessengerModel } from "@/hooks/useMessenger";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import { isFeishuBackedConversation } from "@/lib/chat-source";
import { displayChatTitle } from "@/lib/chat-title";
import { rememberMessengerPath } from "@/lib/messenger-memory";
import {
  DEFAULT_THREAD_ORGANIZATION_RULE,
  getHiddenIssueThreadsStorageKey,
  getMessengerDefaultThreadOrderStorageKey,
  getMessengerThreadGroupOrderStorageKey,
  isLocallyCollapsedThreadGroupRule,
  isLocalManagedThreadGroupRule,
  isManagedThreadGroupRule,
  readCollapsedThreadGroups,
  readHiddenIssueThreadWatermarks,
  readSplitIssueNotifications,
  readStringList,
  readThreadDensity,
  readThreadOrganizationRule,
  writeCollapsedThreadGroups,
  writeHiddenIssueThreadWatermarks,
  writeSplitIssueNotifications,
  writeStringList,
  writeThreadDensity,
  writeThreadOrganizationRule,
  type MessengerThreadDensity,
  type ThreadOrganizationRule
} from "@/lib/messenger-preferences";
import {
  archiveMessengerChatInCache,
  cancelMessengerChatRenameQueries,
  invalidateMessengerThreadSummaryQueries,
  markMessengerChatPinnedInCache,
  markMessengerThreadPinnedInCache,
  markMessengerThreadReadInCache,
  renameMessengerChatInCache,
} from "@/lib/messenger-query-cache";
import { messengerThreadKindLabel } from "@/lib/messenger-thread-labels";
import {
  customGroupIdFromSectionKey,
  customGroupSectionKey,
  dedupeThreadSummariesByKey,
  flattenThreadSectionEntries,
  flattenThreadSections,
  locallyReadThreadSummary,
  nextDefaultThreadOrderKeysAfterMove,
  organizeCustomThreadDirectory,
  organizeThreadEntries,
  projectIdFromSectionKey,
  resolveChatAgentId,
  sectionAttentionCount,
  sortManagedThreadSections,
  splitIssueThreadWatermark,
  storedThreadSectionIdToKey,
  threadMatchesMessengerIssueRoute,
  threadSectionKeyToStoredId,
  type OrganizedThreadEntry,
  type OrganizedThreadSection
} from "@/lib/messenger-thread-organization";
import {
  getUnhandledMessengerUnreadScrollRequestId,
  markMessengerUnreadScrollRequestHandled,
  MESSENGER_SCROLL_TO_UNREAD_EVENT,
} from "@/lib/messenger-unread-scroll";
import { toOrganizationRelativePath } from "@/lib/organization-routes";
import {
  getProjectOrderStorageKey,
  PROJECT_ORDER_UPDATED_EVENT,
  readProjectOrder,
  writeProjectOrder,
} from "@/lib/project-order";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useLocation, useNavigate } from "@/lib/router";
import { resolveSourceBadge } from "@/lib/source-badge";
import { cn } from "@/lib/utils";
import {
  closestCenter,
  DndContext,
  MeasuringFrequency,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { buildChatMentionHref, type Agent, type ChatConversation, type MessengerCustomGroupWithEntries, type Project } from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderInput,
  FolderPlus,
  ListFilter,
  Loader2,
  MoreHorizontal,
  Palette,
  PanelLeft,
  PencilLine,
  Pin,
  PinOff,
  Plus,
  RefreshCw
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type CustomGroupEditorState = { mode: "create"; threadKey?: string };
type CustomGroupRenameState = { group: MessengerCustomGroupWithEntries; name: string };
type MessengerDragIntent = "move-into-group" | "move-out-of-group" | "reorder-group" | "reorder-entry" | null;
type MessengerInsertionPlacement = "before" | "after" | null;

const MANAGED_GROUP_INITIAL_VISIBLE_COUNT = 6;
const MANAGED_GROUP_VISIBLE_INCREMENT = 10;
const MESSENGER_AUTO_LOAD_RENDERED_THREAD_LIMIT = 160;
const SELECTED_READ_EMPHASIS_HOLD_MS = 1200;
const DELETE_AFTER_STOP_RETRY_DELAYS_MS = [120, 300, 700] as const;
const THREAD_ORGANIZATION_OPTIONS: Array<{ value: ThreadOrganizationRule; label: string }> = [
  { value: "latest", label: "Latest activity" },
  { value: "project", label: "Project" },
  { value: "agent", label: "Agent" },
  { value: "kind", label: "Thread type" },
  { value: "attention", label: "Needs attention" },
];

function sleep(ms: number) {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

function sortableTranslateTransform(transform: { x: number; y: number } | null) {
  if (!transform) return undefined;
  return `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)`;
}

const messengerThreadCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  if (pointerCollisions.length > 0) return pointerCollisions;
  const rectCollisions = rectIntersection(args);
  if (rectCollisions.length > 0) return rectCollisions;
  return closestCenter(args);
};

const MESSENGER_THREAD_DND_MEASURING = {
  droppable: {
    strategy: MeasuringStrategy.WhileDragging,
    frequency: MeasuringFrequency.Optimized,
  },
} as const;

function MessengerInsertionLine({
  placement,
  tone = "accent",
}: {
  placement: MessengerInsertionPlacement;
  tone?: "accent" | "group";
}) {
  if (!placement) return null;
  return (
    <div
      data-testid={`messenger-insertion-line-${placement}`}
      className={cn(
        "pointer-events-none absolute left-2 right-2 h-0.5 rounded-full",
        placement === "before" ? "-top-1" : "-bottom-1",
        tone === "group"
          ? "bg-[color:color-mix(in_oklab,var(--messenger-group-text)_58%,transparent)]"
          : "bg-[color:var(--accent-strong)]",
      )}
    />
  );
}

function escapeMarkdownLinkLabel(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/]/g, "\\]");
}

function chatReferenceMarkdown(conversation: Pick<ChatConversation, "id" | "title" | "summary">) {
  const label = escapeMarkdownLinkLabel(displayChatTitle(conversation).trim() || "Chat");
  return `[${label}](${buildChatMentionHref(conversation.id)})`;
}

function ContextColumnHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  const { isMobile, setSidebarOpen } = useSidebar();

  return (
    <header
      data-testid="workspace-context-header"
      className="workspace-card-header workspace-context-header desktop-chrome desktop-window-drag flex shrink-0 items-center justify-between gap-3 px-4 py-3"
    >
      <div className="min-w-0">
        <h2 className="truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
        <p className="mt-0.5 truncate text-[12px] text-muted-foreground">{description}</p>
      </div>
      {!isMobile ? (
        <button
          type="button"
          aria-label="Collapse workspace sidebar"
          title="Collapse workspace sidebar"
          className="desktop-window-no-drag inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] text-muted-foreground transition-[background-color,color] hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_68%,transparent)] hover:text-foreground"
          onClick={() => setSidebarOpen(false)}
        >
          <PanelLeft className="h-4 w-4" />
        </button>
      ) : null}
    </header>
  );
}

function isMessengerSystemThreadKind(kind: string): kind is "failed-runs" | "budget-alerts" | "join-requests" {
  return kind === "failed-runs" || kind === "budget-alerts" || kind === "join-requests";
}

function threadConversationId(threadKey: string) {
  return threadKey.startsWith("chat:") ? threadKey.slice("chat:".length) : null;
}

function threadOrganizationLabel(rule: ThreadOrganizationRule) {
  if (rule === "custom") return "Latest activity";
  return THREAD_ORGANIZATION_OPTIONS.find((option) => option.value === rule)?.label ?? "Latest activity";
}

interface UnreadThreadTarget {
  threadKey: string;
  groupKey: string | null;
  entryIndex: number | null;
}

type ProjectOrderUpdatedDetail = {
  storageKey: string;
  orderedIds: string[];
};

function MessengerThreadSectionHeader({
  rule,
  density,
  splitIssueNotifications,
  onRuleChange,
  onDensityChange,
  onSplitIssueNotificationsChange,
  onCreateCustomGroup,
}: {
  rule: ThreadOrganizationRule;
  density: MessengerThreadDensity;
  splitIssueNotifications: boolean;
  onRuleChange: (rule: ThreadOrganizationRule) => void;
  onDensityChange: (density: MessengerThreadDensity) => void;
  onSplitIssueNotificationsChange: (enabled: boolean) => void;
  onCreateCustomGroup: (anchor: HTMLElement, invoker: HTMLButtonElement) => void;
}) {
  const organizerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const customGroupHandoffRef = useRef(false);
  const activeRule = rule !== DEFAULT_THREAD_ORGANIZATION_RULE && rule !== "custom";
  const compact = density === "compact";
  const statusLabels = [
    activeRule ? threadOrganizationLabel(rule) : null,
  ].filter(Boolean);
  return (
    <div className="group/section flex items-center justify-between px-3.5 pt-3.5">
      <div className="min-w-0 truncate text-[11px] font-semibold text-muted-foreground/72">
        Threads{statusLabels.length > 0 ? (
          <span className="text-muted-foreground">
            {" · "}
            {statusLabels.join(" · ")}
          </span>
        ) : null}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            ref={organizerTriggerRef}
            type="button"
            data-testid="messenger-thread-organization-trigger"
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] text-muted-foreground transition-[opacity,background-color,color] duration-150 hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
              activeRule ? "opacity-100" : "opacity-0 group-hover/section:opacity-100 group-focus-within/section:opacity-100",
            )}
            aria-label="Organize threads"
          >
            <ListFilter className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="morph-popover morph-popover--from-right surface-overlay w-48 text-foreground"
          onCloseAutoFocus={(event) => {
            if (!customGroupHandoffRef.current) return;
            event.preventDefault();
            customGroupHandoffRef.current = false;
          }}
        >
          <DropdownMenuLabel className="text-xs text-muted-foreground">View</DropdownMenuLabel>
          <DropdownMenuCheckboxItem
            checked={compact}
            onCheckedChange={(checked) => onDensityChange(checked ? "compact" : "comfortable")}
          >
            Compact mode
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={splitIssueNotifications}
            onCheckedChange={(checked) => onSplitIssueNotificationsChange(Boolean(checked))}
          >
            Split issue notifications
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs text-muted-foreground">Organize by</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={rule} onValueChange={(value) => onRuleChange(value as ThreadOrganizationRule)}>
            {THREAD_ORGANIZATION_OPTIONS.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => {
            if (!organizerTriggerRef.current) return;
            customGroupHandoffRef.current = true;
            onCreateCustomGroup(organizerTriggerRef.current, organizerTriggerRef.current);
          }}>
            <FolderPlus className="h-4 w-4" />
            New group
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function SortableThreadSection({
  id,
  children,
}: {
  id: string;
  children: (dragHandleProps: SortableDragHandleProps, dragging: boolean) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const { measureNow, measuredRect, setMeasuredNodeRef } = useMeasuredSortableNode(setNodeRef);

  useEffect(() => {
    if (isDragging) measureNow();
  }, [isDragging, measureNow]);

  return (
    <div
      ref={setMeasuredNodeRef}
      style={{
        height: isDragging && measuredRect ? measuredRect.height : undefined,
        width: isDragging && measuredRect ? measuredRect.width : undefined,
        transform: sortableTranslateTransform(transform),
        transition,
        willChange: isDragging ? "transform" : undefined,
        zIndex: isDragging ? 10 : undefined,
      }}
      className={cn(
        "flex min-h-9 shrink-0 touch-none flex-col gap-1 rounded-[calc(var(--radius-md)-2px)]",
        isDragging && "bg-[color:color-mix(in_oklab,var(--surface-active)_56%,transparent)] opacity-90 shadow-sm ring-1 ring-border/70",
      )}
    >
      {children({ attributes, listeners }, isDragging)}
    </div>
  );
}

function SortableCustomThreadEntry({
  id,
  insertionPlacement,
  children,
}: {
  id: string;
  insertionPlacement?: MessengerInsertionPlacement;
  children: (
    dragHandleProps: SortableDragHandleProps,
    dragging: boolean,
  ) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const { measureNow, measuredRect, setMeasuredNodeRef } = useMeasuredSortableNode(setNodeRef);

  useEffect(() => {
    if (isDragging) measureNow();
  }, [isDragging, measureNow]);

  return (
    <div
      ref={setMeasuredNodeRef}
      style={{
        height: isDragging && measuredRect ? measuredRect.height : undefined,
        width: isDragging && measuredRect ? measuredRect.width : undefined,
        transform: sortableTranslateTransform(transform),
        transition,
        willChange: isDragging ? "transform" : undefined,
        zIndex: isDragging ? 20 : undefined,
      }}
      className={cn("relative touch-none", isDragging && "z-20")}
    >
      <MessengerInsertionLine placement={insertionPlacement ?? null} />
      {children({ attributes, listeners }, isDragging)}
    </div>
  );
}

function useMeasuredSortableNode(setNodeRef: ReturnType<typeof useSortable>["setNodeRef"]) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [measuredRect, setMeasuredRect] = useState<{ height: number; width: number } | null>(null);
  const updateMeasuredRect = useCallback((target: HTMLDivElement | null) => {
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const nextHeight = Math.round(rect.height);
    const nextWidth = Math.round(rect.width);
    if (nextHeight <= 0 || nextWidth <= 0) return;
    setMeasuredRect((current) => current?.height === nextHeight && current.width === nextWidth
      ? current
      : { height: nextHeight, width: nextWidth });
  }, []);
  const setMeasuredNodeRef = useCallback((target: HTMLDivElement | null) => {
    setNodeRef(target);
    setNode(target);
    updateMeasuredRect(target);
  }, [setNodeRef, updateMeasuredRect]);
  const measureNow = useCallback(() => {
    updateMeasuredRect(node);
  }, [node, updateMeasuredRect]);

  useEffect(() => {
    if (!node) return undefined;
    updateMeasuredRect(node);
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => updateMeasuredRect(node));
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, updateMeasuredRect]);

  return { measureNow, measuredRect, setMeasuredNodeRef };
}

type MessengerThreadSummaryItem = ReturnType<typeof useMessengerModel>["threadSummaries"][number];

function chatConversationForThreadSummary(
  thread: MessengerThreadSummaryItem,
  orgId: string,
  conversation: ChatConversation | null | undefined,
): ChatConversation | null {
  if (thread.kind !== "chat") return null;
  const conversationId = threadConversationId(thread.threadKey);
  if (!conversationId) return null;

  const metadata = thread.metadata ?? {};
  const preferredAgentId = nonEmptyString(metadata.preferredAgentId);
  const routedAgentId = nonEmptyString(metadata.routedAgentId);
  const runtimeAgentId = nonEmptyString(metadata.runtimeAgentId);
  const latestUserMessagePreview = nonEmptyString(metadata.latestUserMessagePreview);
  const isPinned = typeof thread.isPinned === "boolean" ? thread.isPinned : Boolean(conversation?.isPinned);
  const sourceBadge = resolveSourceBadge(conversation, metadata);
  const sourceMetadata = conversation?.sourceMetadata
    ?? (sourceBadge?.key === "feishu" ? { source: "agent_integration", provider: "feishu" } : null);
  const mutability = conversation?.mutability
    ?? (sourceBadge?.key === "feishu" ? "external_bound_chat" : "native_chat");
  if (conversation) {
    return {
      ...conversation,
      mutability,
      sourceMetadata,
      title: thread.title.includes("…") ? conversation.title : thread.title,
      preferredAgentId: conversation.preferredAgentId ?? preferredAgentId,
      routedAgentId: conversation.routedAgentId ?? routedAgentId,
      chatRuntime: {
        ...conversation.chatRuntime,
        runtimeAgentId: conversation.chatRuntime?.runtimeAgentId ?? runtimeAgentId,
      },
      lastReadAt: thread.lastReadAt ?? conversation.lastReadAt,
      unreadCount: thread.unreadCount,
      isUnread: thread.unreadCount > 0,
      needsAttention: thread.needsAttention,
      isPinned,
    };
  }

  const activityAt = thread.latestActivityAt ? new Date(thread.latestActivityAt) : new Date();
  const preview = thread.preview ?? thread.subtitle ?? null;
  return {
    id: conversationId,
    orgId,
    status: "active",
    mutability,
    title: thread.title,
    summary: null,
    latestReplyPreview: preview,
    latestUserMessagePreview,
    userMessageCount: 0,
    preferredAgentId,
    routedAgentId,
    primaryIssueId: null,
    forkedFromConversationId: null,
    forkedFromMessageId: null,
    forkRootConversationId: null,
    primaryIssue: null,
    issueCreationMode: "manual_approval",
    planMode: false,
    createdByUserId: null,
    lastMessageAt: activityAt,
    lastReadAt: thread.lastReadAt,
    isPinned,
    isUnread: thread.unreadCount > 0,
    unreadCount: thread.unreadCount,
    needsAttention: thread.needsAttention,
    resolvedAt: null,
    contextLinks: [],
    chatRuntime: {
      sourceType: "unconfigured",
      sourceLabel: "No agent selected",
      runtimeAgentId,
      agentRuntimeType: null,
      model: null,
      available: false,
      error: null,
    },
    sourceMetadata,
    createdAt: activityAt,
    updatedAt: activityAt,
  };
}

export function MessengerContextSidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const relativePath = toOrganizationRelativePath(location.pathname);
  const { selectedOrganizationId } = useOrganization();
  const [splitIssueNotifications, setSplitIssueNotifications] = useState(() =>
    readSplitIssueNotifications(selectedOrganizationId),
  );
  const model = useMessengerModel({ splitIssues: splitIssueNotifications });
  const { isMobile, setSidebarOpen } = useSidebar();
  const { confirm } = useDialog();
  const {
    abortChatStream,
    isChatGenerationActive,
    setChatSendInFlight,
    setStreamDraftForChat,
  } = useChatGenerations();
  const queryClient = useQueryClient();
  const route = resolveMessengerRoute(relativePath);
  const markedThreadRef = useRef<string | null>(null);
  const sidebarScrollbarActivityRef = useScrollbarActivityRef("rudder:sidebar-scroll:messenger");
  const customGroupEditorScrollbarActivityRef = useScrollbarActivityRef();
  const sidebarScrollElementRef = useRef<HTMLElement | null>(null);
  const customGroupEditorAnchorRef = useRef<HTMLElement>(null!);
  const customGroupEditorInvokerRef = useRef<HTMLButtonElement>(null!);
  const customGroupEditorRestoreFocusRef = useRef(true);
  const loadMoreThreadSummariesRef = useRef<HTMLDivElement | null>(null);
  const unreadScrollCursorRef = useRef<string | null>(null);
  const handledUnreadScrollRequestIdRef = useRef(0);
  const unreadLoadMoreRequestRef = useRef<{ requestId: number; loadedCount: number } | null>(null);
  const customGroupIconUpdateQueuesRef = useRef<Record<string, Promise<void>>>({});
  const [renamingConversationId, setRenamingConversationId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [pendingChatRenameTitles, setPendingChatRenameTitles] = useState<Record<string, string>>({});
  const [generatingChatTitleIds, setGeneratingChatTitleIds] = useState<Set<string>>(() => new Set());
  const [customGroupEditor, setCustomGroupEditor] = useState<CustomGroupEditorState | null>(null);
  const [customGroupRename, setCustomGroupRename] = useState<CustomGroupRenameState | null>(null);
  const [customGroupNameDraft, setCustomGroupNameDraft] = useState("");
  const [customGroupIconDraft, setCustomGroupIconDraft] = useState("folder");
  const [customGroupColorDraft, setCustomGroupColorDraft] = useState<CustomGroupColor | null>("amber");
  const [pendingCustomGroupIcons, setPendingCustomGroupIcons] = useState<Record<string, string | null>>({});
  const [generatingGroupTitleIds, setGeneratingGroupTitleIds] = useState<Set<string>>(() => new Set());
  const [draggingThreadId, setDraggingThreadId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragIntent, setDragIntent] = useState<MessengerDragIntent>(null);
  const [locallyReadThreadWatermarks, setLocallyReadThreadWatermarks] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [selectedReadEmphasisKey, setSelectedReadEmphasisKey] = useState<string | null>(null);
  const draggingThreadIdRef = useRef<string | null>(null);
  const dragOverIdRef = useRef<string | null>(null);
  const dragIntentRef = useRef<MessengerDragIntent>(null);
  const collapsedGroupOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const collapsedGroupOpenTargetRef = useRef<string | null>(null);
  const selectedReadEmphasisTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [unreadScrollRequestId, setUnreadScrollRequestId] = useState(0);
  const [threadOrganizationRule, setThreadOrganizationRule] = useState<ThreadOrganizationRule>(() =>
    readThreadOrganizationRule(model.selectedOrganizationId),
  );
  const [threadDensity, setThreadDensity] = useState<MessengerThreadDensity>(() =>
    readThreadDensity(model.selectedOrganizationId),
  );
  const [collapsedThreadGroupKeys, setCollapsedThreadGroupKeys] = useState<Set<string>>(() =>
    readCollapsedThreadGroups(model.selectedOrganizationId, threadOrganizationRule),
  );
  const [visibleThreadGroupEntryLimits, setVisibleThreadGroupEntryLimits] = useState<Record<string, number>>({});
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = sessionQuery.data?.user?.id ?? sessionQuery.data?.session?.userId ?? null;
  const projectOrderStorageKey = useMemo(() => {
    if (!model.selectedOrganizationId) return null;
    return getProjectOrderStorageKey(model.selectedOrganizationId, currentUserId);
  }, [currentUserId, model.selectedOrganizationId]);
  const messengerThreadGroupOrderStorageKey = useMemo(() => {
    if (!model.selectedOrganizationId || !isLocalManagedThreadGroupRule(threadOrganizationRule)) return null;
    return getMessengerThreadGroupOrderStorageKey(model.selectedOrganizationId, currentUserId, threadOrganizationRule);
  }, [currentUserId, model.selectedOrganizationId, threadOrganizationRule]);
  const hiddenIssueThreadsStorageKey = useMemo(() => {
    if (!model.selectedOrganizationId) return null;
    return getHiddenIssueThreadsStorageKey(model.selectedOrganizationId, currentUserId);
  }, [currentUserId, model.selectedOrganizationId]);
  const defaultThreadOrderStorageKey = useMemo(() => {
    if (!model.selectedOrganizationId) return null;
    return getMessengerDefaultThreadOrderStorageKey(model.selectedOrganizationId, currentUserId);
  }, [currentUserId, model.selectedOrganizationId]);
  const [projectOrderIds, setProjectOrderIds] = useState<string[]>(() =>
    projectOrderStorageKey ? readProjectOrder(projectOrderStorageKey) : [],
  );
  const [threadSectionOrderIds, setThreadSectionOrderIds] = useState<string[]>(() =>
    messengerThreadGroupOrderStorageKey ? readStringList(messengerThreadGroupOrderStorageKey) : [],
  );
  const [defaultThreadOrderKeys, setDefaultThreadOrderKeys] = useState<string[]>(() =>
    defaultThreadOrderStorageKey ? readStringList(defaultThreadOrderStorageKey) : [],
  );
  const [hiddenIssueThreadWatermarks, setHiddenIssueThreadWatermarks] = useState<Record<string, string>>(() =>
    hiddenIssueThreadsStorageKey ? readHiddenIssueThreadWatermarks(hiddenIssueThreadsStorageKey) : {},
  );
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  );

  const updateDraggingThreadId = useCallback((threadId: string | null) => {
    if (draggingThreadIdRef.current === threadId) return;
    draggingThreadIdRef.current = threadId;
    setDraggingThreadId(threadId);
  }, []);
  const updateDragOverId = useCallback((threadId: string | null) => {
    if (dragOverIdRef.current === threadId) return;
    dragOverIdRef.current = threadId;
    setDragOverId(threadId);
  }, []);
  const updateDragIntent = useCallback((intent: MessengerDragIntent) => {
    if (dragIntentRef.current === intent) return;
    dragIntentRef.current = intent;
    setDragIntent(intent);
  }, []);
  const clearCollapsedGroupOpenTimer = useCallback(() => {
    if (!collapsedGroupOpenTimerRef.current) return;
    clearTimeout(collapsedGroupOpenTimerRef.current);
    collapsedGroupOpenTimerRef.current = null;
    collapsedGroupOpenTargetRef.current = null;
  }, []);
  const holdSelectedReadEmphasis = useCallback((threadKey: string) => {
    setSelectedReadEmphasisKey(threadKey);
    if (selectedReadEmphasisTimerRef.current) {
      clearTimeout(selectedReadEmphasisTimerRef.current);
    }
    selectedReadEmphasisTimerRef.current = setTimeout(() => {
      selectedReadEmphasisTimerRef.current = null;
      setSelectedReadEmphasisKey((current) => (current === threadKey ? null : current));
    }, SELECTED_READ_EMPHASIS_HOLD_MS);
  }, []);
  const resetThreadDragState = useCallback(() => {
    clearCollapsedGroupOpenTimer();
    updateDraggingThreadId(null);
    updateDragOverId(null);
    updateDragIntent(null);
  }, [clearCollapsedGroupOpenTimer, updateDragIntent, updateDragOverId, updateDraggingThreadId]);
  const handleThreadSectionDragStart = useCallback((event: DragStartEvent) => {
    updateDraggingThreadId(String(event.active.id));
    updateDragOverId(null);
    updateDragIntent(null);
  }, [updateDragIntent, updateDragOverId, updateDraggingThreadId]);

  useEffect(() => {
    setThreadOrganizationRule(readThreadOrganizationRule(model.selectedOrganizationId));
    setThreadDensity(readThreadDensity(model.selectedOrganizationId));
    setSplitIssueNotifications(readSplitIssueNotifications(model.selectedOrganizationId));
    const rule = readThreadOrganizationRule(model.selectedOrganizationId);
    setCollapsedThreadGroupKeys(readCollapsedThreadGroups(model.selectedOrganizationId, rule));
    setVisibleThreadGroupEntryLimits({});
    setPendingChatRenameTitles({});
    setLocallyReadThreadWatermarks(new Map());
    setSelectedReadEmphasisKey(null);
    if (selectedReadEmphasisTimerRef.current) {
      clearTimeout(selectedReadEmphasisTimerRef.current);
      selectedReadEmphasisTimerRef.current = null;
    }
  }, [model.selectedOrganizationId]);

  useEffect(() => {
    setCollapsedThreadGroupKeys(readCollapsedThreadGroups(model.selectedOrganizationId, threadOrganizationRule));
    setVisibleThreadGroupEntryLimits({});
  }, [model.selectedOrganizationId, threadOrganizationRule]);

  useEffect(() => {
    if (!projectOrderStorageKey) {
      setProjectOrderIds([]);
      return;
    }
    setProjectOrderIds(readProjectOrder(projectOrderStorageKey));

    const onStorage = (event: StorageEvent) => {
      if (event.key !== projectOrderStorageKey) return;
      setProjectOrderIds(readProjectOrder(projectOrderStorageKey));
    };
    const onCustomEvent = (event: Event) => {
      const detail = (event as CustomEvent<ProjectOrderUpdatedDetail>).detail;
      if (!detail || detail.storageKey !== projectOrderStorageKey) return;
      setProjectOrderIds(detail.orderedIds);
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener(PROJECT_ORDER_UPDATED_EVENT, onCustomEvent);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(PROJECT_ORDER_UPDATED_EVENT, onCustomEvent);
    };
  }, [projectOrderStorageKey]);

  useEffect(() => {
    if (!messengerThreadGroupOrderStorageKey) {
      setThreadSectionOrderIds([]);
      return;
    }
    setThreadSectionOrderIds(readStringList(messengerThreadGroupOrderStorageKey));

    const onStorage = (event: StorageEvent) => {
      if (event.key !== messengerThreadGroupOrderStorageKey) return;
      setThreadSectionOrderIds(readStringList(messengerThreadGroupOrderStorageKey));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [messengerThreadGroupOrderStorageKey]);

  useEffect(() => {
    if (!defaultThreadOrderStorageKey) {
      setDefaultThreadOrderKeys([]);
      return;
    }
    setDefaultThreadOrderKeys(readStringList(defaultThreadOrderStorageKey));

    const onStorage = (event: StorageEvent) => {
      if (event.key !== defaultThreadOrderStorageKey) return;
      setDefaultThreadOrderKeys(readStringList(defaultThreadOrderStorageKey));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [defaultThreadOrderStorageKey]);

  useEffect(() => {
    if (!hiddenIssueThreadsStorageKey) {
      setHiddenIssueThreadWatermarks({});
      return;
    }
    setHiddenIssueThreadWatermarks(readHiddenIssueThreadWatermarks(hiddenIssueThreadsStorageKey));

    const onStorage = (event: StorageEvent) => {
      if (event.key !== hiddenIssueThreadsStorageKey) return;
      setHiddenIssueThreadWatermarks(readHiddenIssueThreadWatermarks(hiddenIssueThreadsStorageKey));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [hiddenIssueThreadsStorageKey]);

  useEffect(() => {
    if (!model.selectedOrganizationId) return;
    void invalidateMessengerThreadSummaryQueries(queryClient, model.selectedOrganizationId);
  }, [model.selectedOrganizationId, queryClient, splitIssueNotifications]);

  const shouldLoadSidebarConversations = threadOrganizationRule === "project" || threadOrganizationRule === "agent";
  const sidebarConversationLimit = 80;

  const chatsQuery = useQuery({
    queryKey: queryKeys.chats.listPreview(model.selectedOrganizationId ?? "__none__", "all", sidebarConversationLimit),
    queryFn: () => chatsApi.list(model.selectedOrganizationId!, "all", { limit: sidebarConversationLimit }),
    enabled: !!model.selectedOrganizationId && shouldLoadSidebarConversations,
  });

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(model.selectedOrganizationId ?? "__none__"),
    queryFn: () => agentsApi.list(model.selectedOrganizationId!),
    enabled: !!model.selectedOrganizationId,
  });
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(model.selectedOrganizationId ?? "__none__"),
    queryFn: () => projectsApi.list(model.selectedOrganizationId!),
    enabled: !!model.selectedOrganizationId && threadOrganizationRule === "project",
  });
  const intelligenceProfilesQuery = useQuery({
    queryKey: queryKeys.organizations.intelligenceProfiles(model.selectedOrganizationId ?? "__none__"),
    queryFn: () => organizationsApi.listIntelligenceProfiles(model.selectedOrganizationId!),
    enabled: !!model.selectedOrganizationId,
  });
  const customGroupsQuery = useQuery({
    queryKey: queryKeys.messenger.customGroups(model.selectedOrganizationId ?? "__none__"),
    queryFn: () => messengerApi.listCustomGroups(model.selectedOrganizationId!),
    enabled: !!model.selectedOrganizationId,
  });
  useEffect(() => {
    if (Object.keys(pendingCustomGroupIcons).length === 0) return;
    setPendingCustomGroupIcons((current) => {
      let changed = false;
      const next = { ...current };
      for (const group of customGroupsQuery.data?.groups ?? []) {
        if (!(group.id in next)) continue;
        if (next[group.id] !== group.icon) continue;
        delete next[group.id];
        changed = true;
      }
      return changed ? next : current;
    });
  }, [customGroupsQuery.data?.groups, pendingCustomGroupIcons]);
  const conversationsById = useMemo(() => {
    const map = new Map<string, ChatConversation>();
    for (const conversation of chatsQuery.data ?? []) {
      map.set(conversation.id, conversation);
    }
    return map;
  }, [chatsQuery.data]);

  const agentsById = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agentsQuery.data ?? []) {
      map.set(agent.id, agent);
    }
    return map;
  }, [agentsQuery.data]);

  const projectsById = useMemo(() => {
    const map = new Map<string, Project>();
    for (const project of projectsQuery.data ?? []) {
      map.set(project.id, project);
    }
    return map;
  }, [projectsQuery.data]);

  const canRegenerateChatTitles = useMemo(() => {
    const profiles = intelligenceProfilesQuery.data ?? [];
    return profiles.some((profile) => profile?.purpose === "lightweight" && profile.status === "configured");
  }, [intelligenceProfilesQuery.data]);

  const customGroups = customGroupsQuery.data?.groups ?? [];
  const defaultCustomGroupLayout = threadOrganizationRule === "latest" || threadOrganizationRule === "custom";
  const effectiveThreadOrganizationRule: ThreadOrganizationRule = defaultCustomGroupLayout
    ? "custom"
    : threadOrganizationRule;
  useEffect(() => clearCollapsedGroupOpenTimer, [clearCollapsedGroupOpenTimer, effectiveThreadOrganizationRule, model.selectedOrganizationId]);
  useEffect(() => () => {
    if (selectedReadEmphasisTimerRef.current) {
      clearTimeout(selectedReadEmphasisTimerRef.current);
      selectedReadEmphasisTimerRef.current = null;
    }
  }, []);
  const customGroupBySectionKey = useMemo(() => {
    const map = new Map<string, MessengerCustomGroupWithEntries>();
    for (const group of customGroups) {
      map.set(customGroupSectionKey(group.id), group);
    }
    return map;
  }, [customGroups]);

  const visibleThreadSummaries = useMemo(() => {
    const unhiddenThreads = model.threadSummaries.filter((thread) => {
      const watermark = splitIssueThreadWatermark(thread);
      if (!watermark) return true;
      return hiddenIssueThreadWatermarks[thread.threadKey] !== watermark;
    });
    return dedupeThreadSummariesByKey(unhiddenThreads)
      .map((thread) => locallyReadThreadSummary(thread, locallyReadThreadWatermarks));
  }, [hiddenIssueThreadWatermarks, locallyReadThreadWatermarks, model.threadSummaries]);

  useEffect(() => {
    if (locallyReadThreadWatermarks.size === 0) return;
    setLocallyReadThreadWatermarks((current) => {
      const next = new Map(current);
      const sourceThreadsByKey = new Map<string, MessengerThreadSummaryItem[]>();
      for (const thread of model.threadSummaries) {
        sourceThreadsByKey.set(thread.threadKey, [...sourceThreadsByKey.get(thread.threadKey) ?? [], thread]);
      }
      for (const group of customGroups) {
        for (const entry of group.entries) {
          sourceThreadsByKey.set(entry.threadKey, [...sourceThreadsByKey.get(entry.threadKey) ?? [], entry.thread]);
        }
      }
      for (const [threadKey, watermark] of current) {
        const sourceThreads = sourceThreadsByKey.get(threadKey) ?? [];
        if (sourceThreads.length === 0) continue;
        const matchingSources = sourceThreads.filter((thread) => (thread.latestActivityAt ?? "none") === watermark);
        if (matchingSources.length === 0) {
          next.delete(threadKey);
          continue;
        }
        if (matchingSources.some((thread) => thread.unreadCount > 0 || thread.needsAttention)) continue;
        next.delete(threadKey);
      }
      return next.size === current.size ? current : next;
    });
  }, [customGroups, locallyReadThreadWatermarks.size, model.threadSummaries]);

  const organizedThreadSections = useMemo(() => {
    const threadSummaries = splitIssueNotifications
      ? visibleThreadSummaries.filter((thread) => thread.threadKey !== "issues")
      : visibleThreadSummaries;
    if (effectiveThreadOrganizationRule === "custom") {
      const groupInputs = customGroups.map((group) => ({
        id: group.id,
        name: group.name,
        icon: group.icon,
        pinned: Boolean(group.pinnedAt),
        entries: group.entries.map((entry) => {
          const conversationId = threadConversationId(entry.threadKey);
          const pendingTitle = conversationId ? pendingChatRenameTitles[conversationId] : undefined;
          const readThread = locallyReadThreadSummary(entry.thread, locallyReadThreadWatermarks);
          const displayThread = pendingTitle ? { ...readThread, title: pendingTitle } : readThread;
          return {
            thread: displayThread,
            conversation: model.selectedOrganizationId
              ? chatConversationForThreadSummary(displayThread, model.selectedOrganizationId, conversationsById.get(conversationId ?? "") ?? null)
              : null,
            customGroupId: group.id,
          } satisfies OrganizedThreadEntry;
        }),
      }));
      const looseEntries = threadSummaries.map((thread) => {
          const conversationId = threadConversationId(thread.threadKey);
          const loadedConversation = conversationId ? conversationsById.get(conversationId) ?? null : null;
          const pendingTitle = conversationId ? pendingChatRenameTitles[conversationId] : undefined;
          const displayThread = pendingTitle ? { ...thread, title: pendingTitle } : thread;
          return {
            thread: displayThread,
            conversation: model.selectedOrganizationId
              ? chatConversationForThreadSummary(displayThread, model.selectedOrganizationId, loadedConversation)
              : null,
            customGroupId: null,
          } satisfies OrganizedThreadEntry;
        });
      return organizeCustomThreadDirectory(looseEntries, groupInputs, defaultThreadOrderKeys);
    }
    const entries = threadSummaries.map((thread) => {
      const conversationId = threadConversationId(thread.threadKey);
      const loadedConversation = conversationId ? conversationsById.get(conversationId) ?? null : null;
      const pendingTitle = conversationId ? pendingChatRenameTitles[conversationId] : undefined;
      const displayThread = pendingTitle ? { ...thread, title: pendingTitle } : thread;
      return {
        thread: displayThread,
        conversation: model.selectedOrganizationId
          ? chatConversationForThreadSummary(displayThread, model.selectedOrganizationId, loadedConversation)
          : null,
      };
    });
    const sections = organizeThreadEntries(
      entries,
      effectiveThreadOrganizationRule,
      agentsById,
      projectsById,
      messengerThreadKindLabel,
    );
    return isManagedThreadGroupRule(effectiveThreadOrganizationRule)
      ? sortManagedThreadSections(sections, effectiveThreadOrganizationRule, projectOrderIds, threadSectionOrderIds)
      : sections;
  }, [agentsById, conversationsById, customGroups, defaultThreadOrderKeys, effectiveThreadOrganizationRule, locallyReadThreadWatermarks, model.selectedOrganizationId, pendingChatRenameTitles, projectOrderIds, projectsById, threadSectionOrderIds, splitIssueNotifications, visibleThreadSummaries]);
  const customEntryGroupByThreadKey = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const group of customGroups) {
      for (const entry of group.entries) {
        map.set(entry.threadKey, group.id);
      }
    }
    if (effectiveThreadOrganizationRule === "custom") {
      for (const section of organizedThreadSections) {
        for (const entry of flattenThreadSectionEntries([section])) {
          if (entry.customGroupId === null) map.set(entry.thread.threadKey, null);
        }
      }
    }
    return map;
  }, [customGroups, effectiveThreadOrganizationRule, organizedThreadSections]);
  const renderedThreadCount = useMemo(() => (
    flattenThreadSectionEntries(organizedThreadSections).length
  ), [organizedThreadSections]);
  const shouldAutoLoadMoreThreadSummaries = renderedThreadCount < MESSENGER_AUTO_LOAD_RENDERED_THREAD_LIMIT;
  const resolveCustomDragIntent = useCallback((activeId: string, overId: string | null): MessengerDragIntent => {
    if (effectiveThreadOrganizationRule !== "custom" || !overId || activeId === overId) return null;
    const activeIsThread = customEntryGroupByThreadKey.has(activeId);
    if (!activeIsThread) {
      return customGroupIdFromSectionKey(activeId) && customGroupIdFromSectionKey(overId)
        ? "reorder-group"
        : null;
    }
    const activeGroupId = customEntryGroupByThreadKey.get(activeId) ?? null;
    const overEntryGroupId = customEntryGroupByThreadKey.has(overId)
      ? customEntryGroupByThreadKey.get(overId) ?? null
      : undefined;
    const overGroupId = customGroupIdFromSectionKey(overId) ?? overEntryGroupId;
    if (activeGroupId && overEntryGroupId === null) return "move-out-of-group";
    if (overGroupId && activeGroupId !== overGroupId) return "move-into-group";
    if (activeGroupId && overEntryGroupId && activeGroupId === overEntryGroupId) return "reorder-entry";
    if (activeGroupId === null && overEntryGroupId === null) return "reorder-entry";
    return null;
  }, [customEntryGroupByThreadKey, effectiveThreadOrganizationRule]);
  const unreadThreadTargets = useMemo<UnreadThreadTarget[]>(() => {
    const targets: UnreadThreadTarget[] = [];
    for (const section of flattenThreadSections(organizedThreadSections)) {
      for (const [index, entry] of section.entries.entries()) {
        if (entry.thread.unreadCount > 0) {
          targets.push({
            threadKey: entry.thread.threadKey,
            groupKey: isManagedThreadGroupRule(effectiveThreadOrganizationRule) ? section.key : null,
            entryIndex: isManagedThreadGroupRule(effectiveThreadOrganizationRule) ? index : null,
          });
        }
      }
    }
    return targets;
  }, [effectiveThreadOrganizationRule, organizedThreadSections]);
  const unreadScrollTarget = useMemo<UnreadThreadTarget | null>(() => {
    if (unreadScrollRequestId <= 0 || unreadThreadTargets.length === 0) return null;
    const cursorKey = unreadScrollCursorRef.current;
    const cursorIndex = cursorKey
      ? unreadThreadTargets.findIndex((target) => target.threadKey === cursorKey)
      : -1;
    if (cursorIndex === unreadThreadTargets.length - 1 && model.hasMoreThreadSummaries) {
      return null;
    }
    return unreadThreadTargets[(cursorIndex + 1) % unreadThreadTargets.length] ?? null;
  }, [model.hasMoreThreadSummaries, unreadScrollRequestId, unreadThreadTargets]);
  const shouldLoadMoreForUnreadScroll = unreadScrollRequestId > 0
    && handledUnreadScrollRequestIdRef.current !== unreadScrollRequestId
    && model.hasMoreThreadSummaries
    && !model.isFetchingMoreThreadSummaries
    && !model.isLoading
    && (
      unreadThreadTargets.length === 0
      || (
        Boolean(unreadScrollCursorRef.current)
        && unreadThreadTargets.findIndex((target) => target.threadKey === unreadScrollCursorRef.current) === unreadThreadTargets.length - 1
      )
    );
  const firstUnreadThreadKey = unreadThreadTargets[0]?.threadKey ?? null;
  const setSidebarScrollRef = useCallback((element: HTMLElement | null) => {
    sidebarScrollElementRef.current = element;
    sidebarScrollbarActivityRef(element);
  }, [sidebarScrollbarActivityRef]);

  const activeThreadKey = useMemo(() => {
    if (route.kind === "chat" && route.conversationId) return `chat:${route.conversationId}`;
    if (route.kind === "issue") {
      return visibleThreadSummaries.find((thread) => threadMatchesMessengerIssueRoute(thread, route.issueId))?.threadKey ?? `issue:${route.issueId}`;
    }
    if (route.kind === "issues") return "issues";
    if (route.kind === "approvals") return "approvals";
    if (route.kind === "system") return route.threadKind;
    return null;
  }, [route, visibleThreadSummaries]);
  const sortableThreadSectionKeys = useMemo(() => (
    organizedThreadSections
      .filter((section) => effectiveThreadOrganizationRule !== "custom" || section.key !== "custom:pinned")
      .filter((section) => effectiveThreadOrganizationRule !== "project" || !section.isPinned)
      .map((section) => section.key)
  ), [effectiveThreadOrganizationRule, organizedThreadSections]);
  const threadSectionRequiredVisibleCounts = useMemo(() => {
    if (!isManagedThreadGroupRule(effectiveThreadOrganizationRule) || !activeThreadKey) return new Map<string, number>();
    const required = new Map<string, number>();
    for (const section of flattenThreadSections(organizedThreadSections)) {
      const index = section.entries.findIndex((entry) => entry.thread.threadKey === activeThreadKey);
      if (index !== -1) required.set(section.key, index + 1);
    }
    return required;
  }, [activeThreadKey, effectiveThreadOrganizationRule, organizedThreadSections]);
  const activeThread = useMemo(
    () => visibleThreadSummaries.find((thread) => thread.threadKey === activeThreadKey) ?? null,
    [activeThreadKey, visibleThreadSummaries],
  );
  const activeThreadDetailReady = useMemo(() => {
    if (route.kind === "issue") return !!activeThread;
    if (route.kind === "issues") return !!model.issueThreadDetail;
    if (route.kind === "approvals") return !!model.approvalThreadDetail;
    if (route.kind === "system") return !!model.systemThreadDetail;
    return false;
  }, [activeThread, model.approvalThreadDetail, model.issueThreadDetail, model.systemThreadDetail, route]);
  const activeThreadReadAt = useMemo(() => {
    if (route.kind === "issue") return activeThread?.latestActivityAt ?? null;
    if (route.kind === "issues") return model.issueThreadDetail?.latestActivityAt ?? null;
    if (route.kind === "approvals") return model.approvalThreadDetail?.latestActivityAt ?? null;
    if (route.kind === "system") return model.systemThreadDetail?.latestActivityAt ?? null;
    return activeThread?.latestActivityAt ?? null;
  }, [
    activeThread?.latestActivityAt,
    model.approvalThreadDetail?.latestActivityAt,
    model.issueThreadDetail?.latestActivityAt,
    model.systemThreadDetail?.latestActivityAt,
    route,
  ]);

  const closeMobileSidebar = () => {
    if (isMobile) setSidebarOpen(false);
  };

  const handleMessengerEntrySelect = (href: string) => {
    if (model.selectedOrganizationId) {
      rememberMessengerPath(model.selectedOrganizationId, href);
    }
    closeMobileSidebar();
  };

  const handleMessengerThreadSelect = (thread: MessengerThreadSummaryItem) => {
    const orgId = model.selectedOrganizationId;
    handleMessengerEntrySelect(thread.href);
    if (!orgId || (thread.unreadCount === 0 && !thread.needsAttention)) return;

    const readAt = thread.latestActivityAt ?? null;
    const marker = `${orgId}:${thread.threadKey}:${readAt ?? "none"}`;
    if (markedThreadRef.current === marker) return;
    markedThreadRef.current = marker;
    holdSelectedReadEmphasis(thread.threadKey);

    setLocallyReadThreadWatermarks((current) => {
      const nextWatermark = readAt instanceof Date ? readAt.toISOString() : readAt ?? "none";
      if (current.get(thread.threadKey) === nextWatermark) return current;
      const next = new Map(current);
      next.set(thread.threadKey, nextWatermark);
      return next;
    });
    markMessengerThreadReadInCache(queryClient, orgId, thread.threadKey, readAt);

    void messengerApi.markThreadRead(
      orgId,
      thread.threadKey,
      readAt ? new Date(readAt).toISOString() : null,
    ).then(async () => {
      await invalidateMessengerThreadSummaryQueries(queryClient, orgId);
      await queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(orgId) });
      if (thread.kind === "issues") {
        await queryClient.invalidateQueries({ queryKey: queryKeys.messenger.issues(orgId) });
      }
      if (thread.kind === "approvals") {
        await queryClient.invalidateQueries({ queryKey: queryKeys.messenger.approvals(orgId) });
      }
      if (isMessengerSystemThreadKind(thread.kind)) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.messenger.system(orgId, thread.kind),
        });
      }
    }).catch(() => {
      markedThreadRef.current = null;
      setLocallyReadThreadWatermarks((current) => {
        if (!current.has(thread.threadKey)) return current;
        const next = new Map(current);
        next.delete(thread.threadKey);
        return next;
      });
      void invalidateMessengerThreadSummaryQueries(queryClient, orgId);
    });
  };

  const handleThreadOrganizationRuleChange = (rule: ThreadOrganizationRule) => {
    setThreadOrganizationRule(rule);
    if (model.selectedOrganizationId) {
      writeThreadOrganizationRule(model.selectedOrganizationId, rule);
    }
  };

  const handleThreadDensityChange = (density: MessengerThreadDensity) => {
    setThreadDensity(density);
    if (model.selectedOrganizationId) {
      writeThreadDensity(model.selectedOrganizationId, density);
    }
  };

  const handleSplitIssueNotificationsChange = (enabled: boolean) => {
    setSplitIssueNotifications(enabled);
    if (model.selectedOrganizationId) {
      writeSplitIssueNotifications(model.selectedOrganizationId, enabled);
    }
  };

  const refreshCustomGroups = async () => {
    if (!model.selectedOrganizationId) return;
    await queryClient.invalidateQueries({ queryKey: queryKeys.messenger.customGroups(model.selectedOrganizationId) });
  };

  const createCustomGroupMutation = useMutation({
    mutationFn: async ({ name, icon, threadKey }: { name: string; icon: string | null; threadKey?: string }) => {
      if (!model.selectedOrganizationId) throw new Error("Organization is required to create a Messenger group");
      const group = await messengerApi.createCustomGroup(model.selectedOrganizationId, { name, icon });
      if (threadKey) {
        await messengerApi.assignCustomGroupEntry(model.selectedOrganizationId, group.id, threadKey);
      }
      return group;
    },
    onSuccess: async () => {
      if (model.selectedOrganizationId) {
        handleThreadOrganizationRuleChange("latest");
      }
      await refreshCustomGroups();
    },
  });

  const updateCustomGroupMutation = useMutation({
    mutationFn: ({ groupId, data }: { groupId: string; data: { name?: string; icon?: string | null; collapsed?: boolean; pinned?: boolean; sortOrder?: number } }) => {
      if (!model.selectedOrganizationId) throw new Error("Organization is required to update a Messenger group");
      return messengerApi.updateCustomGroup(model.selectedOrganizationId, groupId, data);
    },
    onSuccess: refreshCustomGroups,
  });

  const regenerateCustomGroupTitleMutation = useMutation({
    mutationFn: (groupId: string) => {
      if (!model.selectedOrganizationId) throw new Error("Organization is required to regenerate a Messenger group title");
      return messengerApi.regenerateCustomGroupTitle(model.selectedOrganizationId, groupId);
    },
    onMutate: (groupId) => {
      setGeneratingGroupTitleIds((current) => {
        const next = new Set(current);
        next.add(groupId);
        return next;
      });
    },
    onSettled: async (_data, _error, groupId) => {
      setGeneratingGroupTitleIds((current) => {
        const next = new Set(current);
        next.delete(groupId);
        return next;
      });
      await refreshCustomGroups();
    },
  });

  const separateCustomGroupMutation = useMutation({
    mutationFn: (groupId: string) => {
      if (!model.selectedOrganizationId) throw new Error("Organization is required to separate a Messenger group");
      return messengerApi.separateCustomGroup(model.selectedOrganizationId, groupId);
    },
    onSuccess: refreshCustomGroups,
  });

  const reorderCustomGroupsMutation = useMutation({
    mutationFn: (groupIds: string[]) => {
      if (!model.selectedOrganizationId) throw new Error("Organization is required to reorder Messenger groups");
      return messengerApi.reorderCustomGroups(model.selectedOrganizationId, groupIds);
    },
    onSuccess: refreshCustomGroups,
  });

  const reorderCustomGroupEntriesMutation = useMutation({
    mutationFn: ({ groupId, threadKeys }: { groupId: string; threadKeys: string[] }) => {
      if (!model.selectedOrganizationId) throw new Error("Organization is required to reorder Messenger group entries");
      return messengerApi.reorderCustomGroupEntries(model.selectedOrganizationId, groupId, threadKeys);
    },
    onSuccess: refreshCustomGroups,
  });

  const assignCustomGroupEntryMutation = useMutation({
    mutationFn: ({ groupId, threadKey }: { groupId: string; threadKey: string }) => {
      if (!model.selectedOrganizationId) throw new Error("Organization is required to move a Messenger thread");
      return messengerApi.assignCustomGroupEntry(model.selectedOrganizationId, groupId, threadKey);
    },
    onSuccess: async () => {
      handleThreadOrganizationRuleChange("latest");
      await refreshCustomGroups();
    },
  });

  const removeCustomGroupEntryMutation = useMutation({
    mutationFn: (threadKey: string) => {
      if (!model.selectedOrganizationId) throw new Error("Organization is required to move a Messenger thread");
      return messengerApi.removeCustomGroupEntry(model.selectedOrganizationId, threadKey);
    },
    onSuccess: refreshCustomGroups,
  });

  const handleThreadSectionDragOver = useCallback((event: DragOverEvent) => {
    const overId = event.over ? String(event.over.id) : null;
    updateDragOverId(overId);
    const activeId = String(event.active.id);
    const nextIntent = resolveCustomDragIntent(activeId, overId);
    updateDragIntent(nextIntent);

    if (nextIntent !== "move-into-group" || !overId || effectiveThreadOrganizationRule !== "custom") {
      clearCollapsedGroupOpenTimer();
      return;
    }

    const overGroupId = customGroupIdFromSectionKey(overId) ?? customEntryGroupByThreadKey.get(overId) ?? null;
    const group = overGroupId ? customGroups.find((candidate) => candidate.id === overGroupId) : null;
    if (!group?.collapsed) {
      clearCollapsedGroupOpenTimer();
      return;
    }
    if (collapsedGroupOpenTargetRef.current === group.id && collapsedGroupOpenTimerRef.current) return;
    clearCollapsedGroupOpenTimer();
    collapsedGroupOpenTargetRef.current = group.id;
    collapsedGroupOpenTimerRef.current = setTimeout(() => {
      collapsedGroupOpenTimerRef.current = null;
      collapsedGroupOpenTargetRef.current = null;
      updateCustomGroupMutation.mutate({ groupId: group.id, data: { collapsed: false } });
    }, 500);
  }, [clearCollapsedGroupOpenTimer, customEntryGroupByThreadKey, customGroups, effectiveThreadOrganizationRule, resolveCustomDragIntent, updateCustomGroupMutation, updateDragIntent, updateDragOverId]);

  const handleThreadGroupToggle = (groupKey: string) => {
    if (effectiveThreadOrganizationRule === "custom") {
      const group = customGroupBySectionKey.get(groupKey);
      if (group) {
        updateCustomGroupMutation.mutate({ groupId: group.id, data: { collapsed: !group.collapsed } });
        return;
      }
    }
    if (!isLocallyCollapsedThreadGroupRule(effectiveThreadOrganizationRule)) return;
    setCollapsedThreadGroupKeys((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      if (model.selectedOrganizationId) {
        writeCollapsedThreadGroups(model.selectedOrganizationId, effectiveThreadOrganizationRule, next);
      }
      return next;
    });
  };

  const handleThreadSectionDragEnd = useCallback((event: DragEndEvent) => {
    resetThreadDragState();
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    if (!isManagedThreadGroupRule(effectiveThreadOrganizationRule)) return;

    if (effectiveThreadOrganizationRule === "custom") {
      const activeThreadKey = String(active.id);
      const overThreadKey = String(over.id);
      const topLevelSectionKeys = organizedThreadSections
        .filter((section) => section.key !== "custom:pinned")
        .map((section) => section.key);
      const pinnedThreadKeys = organizedThreadSections
        .find((section) => section.key === "custom:pinned")
        ?.childSections?.flatMap((childSection) => childSection.entries.map((entry) => entry.thread.threadKey)) ?? [];
      const persistTopLevelOrder = (sectionKeys: string[], oldIndex: number, newIndex: number) => {
        if (!defaultThreadOrderStorageKey) return;
        const nextOrderKeys = nextDefaultThreadOrderKeysAfterMove(sectionKeys, defaultThreadOrderKeys, oldIndex, newIndex);
        setDefaultThreadOrderKeys(nextOrderKeys);
        writeStringList(defaultThreadOrderStorageKey, nextOrderKeys);
      };
      const activeIsThread = customEntryGroupByThreadKey.has(activeThreadKey);
      const overIsThread = customEntryGroupByThreadKey.has(overThreadKey);
      const activeGroupId = customEntryGroupByThreadKey.get(activeThreadKey) ?? null;
      const overEntryGroupId = overIsThread ? customEntryGroupByThreadKey.get(overThreadKey) ?? null : undefined;
      const overGroupId = customGroupIdFromSectionKey(overThreadKey) ?? overEntryGroupId;
      const activeSectionGroupId = customGroupIdFromSectionKey(activeThreadKey);
      const overSectionGroupId = customGroupIdFromSectionKey(overThreadKey);
      if (activeSectionGroupId && overSectionGroupId) {
        const activeGroup = customGroups.find((group) => group.id === activeSectionGroupId);
        const overGroup = customGroups.find((group) => group.id === overSectionGroupId);
        if (!activeGroup || !overGroup || Boolean(activeGroup.pinnedAt) !== Boolean(overGroup.pinnedAt)) return;
        const domainSectionKeys = activeGroup.pinnedAt
          ? organizedThreadSections
            .find((section) => section.key === "custom:pinned")
            ?.childSections?.map((section) => section.key).filter((key) => Boolean(customGroupIdFromSectionKey(key))) ?? []
          : organizedThreadSections
            .map((section) => section.key)
            .filter((key) => Boolean(customGroupIdFromSectionKey(key)));
        const oldIndex = domainSectionKeys.indexOf(activeThreadKey);
        const newIndex = domainSectionKeys.indexOf(overThreadKey);
        if (oldIndex !== -1 && newIndex !== -1) {
          const movedSectionKeys = arrayMove(domainSectionKeys, oldIndex, newIndex);
          if (defaultThreadOrderStorageKey) {
            const nextOrderKeys = nextDefaultThreadOrderKeysAfterMove(
              domainSectionKeys,
              defaultThreadOrderKeys,
              oldIndex,
              newIndex,
            );
            setDefaultThreadOrderKeys(nextOrderKeys);
            writeStringList(defaultThreadOrderStorageKey, nextOrderKeys);
          }
          reorderCustomGroupsMutation.mutate(
            movedSectionKeys.map(customGroupIdFromSectionKey).filter((id): id is string => Boolean(id)),
          );
        }
        return;
      }
      if (
        activeIsThread
        && overIsThread
        && activeGroupId === null
        && overEntryGroupId === null
        && activeThreadKey !== overThreadKey
      ) {
        const sectionKeys = pinnedThreadKeys.includes(activeThreadKey) && pinnedThreadKeys.includes(overThreadKey)
          ? pinnedThreadKeys
          : topLevelSectionKeys;
        const oldIndex = sectionKeys.indexOf(activeThreadKey);
        const newIndex = sectionKeys.indexOf(overThreadKey);
        if (oldIndex !== -1 && newIndex !== -1) persistTopLevelOrder(sectionKeys, oldIndex, newIndex);
        return;
      }
      if (
        activeIsThread
        && overIsThread
        && activeGroupId
        && overEntryGroupId === null
        && activeThreadKey !== overThreadKey
      ) {
        const insertionIndex = topLevelSectionKeys.indexOf(overThreadKey);
        if (insertionIndex !== -1) {
          const sectionKeysWithActive = topLevelSectionKeys.includes(activeThreadKey)
            ? topLevelSectionKeys
            : [
              ...topLevelSectionKeys.slice(0, insertionIndex),
              activeThreadKey,
              ...topLevelSectionKeys.slice(insertionIndex),
            ];
          const oldIndex = sectionKeysWithActive.indexOf(activeThreadKey);
          const newIndex = sectionKeysWithActive.indexOf(overThreadKey);
          if (oldIndex !== -1 && newIndex !== -1) persistTopLevelOrder(sectionKeysWithActive, oldIndex, newIndex);
        }
        removeCustomGroupEntryMutation.mutate(activeThreadKey);
        return;
      }
      if (activeIsThread && overGroupId !== undefined) {
        const activeGroupId = customEntryGroupByThreadKey.get(activeThreadKey) ?? null;
        if (activeGroupId !== overGroupId) {
          if (!overGroupId) {
            const insertionIndex = topLevelSectionKeys.indexOf(overThreadKey);
            if (insertionIndex !== -1) {
              const sectionKeysWithActive = topLevelSectionKeys.includes(activeThreadKey)
                ? topLevelSectionKeys
                : [
                  ...topLevelSectionKeys.slice(0, insertionIndex),
                  activeThreadKey,
                  ...topLevelSectionKeys.slice(insertionIndex),
                ];
              const oldIndex = sectionKeysWithActive.indexOf(activeThreadKey);
              const newIndex = sectionKeysWithActive.indexOf(overThreadKey);
              if (oldIndex !== -1 && newIndex !== -1) persistTopLevelOrder(sectionKeysWithActive, oldIndex, newIndex);
            }
          }
          if (overGroupId) {
            assignCustomGroupEntryMutation.mutate({ groupId: overGroupId, threadKey: activeThreadKey });
          } else {
            removeCustomGroupEntryMutation.mutate(activeThreadKey);
          }
          return;
        }
        if (activeGroupId === null) {
          const oldIndex = topLevelSectionKeys.indexOf(activeThreadKey);
          const newIndex = topLevelSectionKeys.indexOf(overThreadKey);
          if (oldIndex !== -1 && newIndex !== -1) persistTopLevelOrder(topLevelSectionKeys, oldIndex, newIndex);
          return;
        }
      }
      if (activeGroupId && overEntryGroupId && activeGroupId === overEntryGroupId) {
        const groupSectionKey = customGroupSectionKey(activeGroupId);
        const section = organizedThreadSections.find((candidate) => candidate.key === groupSectionKey);
        const sectionKeys = section?.entries.map((entry) => entry.thread.threadKey) ?? [];
        const oldIndex = sectionKeys.indexOf(activeThreadKey);
        const newIndex = sectionKeys.indexOf(overThreadKey);
        if (oldIndex !== -1 && newIndex !== -1) {
          reorderCustomGroupEntriesMutation.mutate({
            groupId: activeGroupId,
            threadKeys: arrayMove(sectionKeys, oldIndex, newIndex),
          });
        }
        return;
      }
    }

    const sectionKeys = effectiveThreadOrganizationRule === "custom"
      ? organizedThreadSections
        .filter((section) => section.key !== "custom:pinned")
        .map((section) => section.key)
      : organizedThreadSections
        .filter((section) => effectiveThreadOrganizationRule !== "project" || !section.isPinned)
        .map((section) => section.key);
    const oldIndex = sectionKeys.indexOf(active.id as string);
    const newIndex = sectionKeys.indexOf(over.id as string);
    if (oldIndex === -1 || newIndex === -1) return;

    if (effectiveThreadOrganizationRule === "custom") {
      const movedSectionKeys = arrayMove(sectionKeys, oldIndex, newIndex);
      if (defaultThreadOrderStorageKey) {
        const nextOrderKeys = nextDefaultThreadOrderKeysAfterMove(sectionKeys, defaultThreadOrderKeys, oldIndex, newIndex);
        setDefaultThreadOrderKeys(nextOrderKeys);
        writeStringList(defaultThreadOrderStorageKey, nextOrderKeys);
      }
      const movedGroupIds = movedSectionKeys
        .map(customGroupIdFromSectionKey)
        .filter((id): id is string => Boolean(id));
      if (movedGroupIds.length > 0) {
        reorderCustomGroupsMutation.mutate(movedGroupIds);
      }
      return;
    }

    if (!messengerThreadGroupOrderStorageKey || !isLocalManagedThreadGroupRule(effectiveThreadOrganizationRule)) return;

    const movedSectionIds = arrayMove(sectionKeys, oldIndex, newIndex)
      .map((sectionKey) => threadSectionKeyToStoredId(effectiveThreadOrganizationRule, sectionKey));
    setThreadSectionOrderIds(movedSectionIds);
    writeStringList(messengerThreadGroupOrderStorageKey, movedSectionIds);

    if (effectiveThreadOrganizationRule !== "project") return;
    const movedProjectIds = movedSectionIds
      .map((id) => storedThreadSectionIdToKey(effectiveThreadOrganizationRule, id))
      .map((key) => projectIdFromSectionKey(key))
      .filter((id): id is string => Boolean(id));
    const movedProjectIdSet = new Set(movedProjectIds);
    const nextProjectOrderIds = [
      ...movedProjectIds,
      ...projectOrderIds.filter((id) => !movedProjectIdSet.has(id)),
    ];
    setProjectOrderIds(nextProjectOrderIds);
    if (projectOrderStorageKey) {
      writeProjectOrder(projectOrderStorageKey, nextProjectOrderIds);
    }
  }, [assignCustomGroupEntryMutation, customEntryGroupByThreadKey, customGroups, defaultThreadOrderKeys, defaultThreadOrderStorageKey, effectiveThreadOrganizationRule, messengerThreadGroupOrderStorageKey, organizedThreadSections, projectOrderIds, projectOrderStorageKey, removeCustomGroupEntryMutation, reorderCustomGroupEntriesMutation, reorderCustomGroupsMutation, resetThreadDragState]);

  const handleShowMoreThreadSection = (section: OrganizedThreadSection, visibleCount: number) => {
    if (visibleCount < section.entries.length) {
      setVisibleThreadGroupEntryLimits((current) => ({
        ...current,
        [section.key]: Math.min(section.entries.length, visibleCount + MANAGED_GROUP_VISIBLE_INCREMENT),
      }));
      return;
    }
    if (model.hasMoreThreadSummaries && !model.isFetchingMoreThreadSummaries) {
      void model.loadMoreThreadSummaries?.();
    }
  };

  const handleCollapseThreadSectionEntries = (sectionKey: string) => {
    setVisibleThreadGroupEntryLimits((current) => ({
      ...current,
      [sectionKey]: MANAGED_GROUP_INITIAL_VISIBLE_COUNT,
    }));
  };

  const handleHideIssueThread = (thread: MessengerThreadSummaryItem) => {
    const watermark = splitIssueThreadWatermark(thread);
    if (!watermark || !hiddenIssueThreadsStorageKey) return;
    setHiddenIssueThreadWatermarks((current) => {
      const next = {
        ...current,
        [thread.threadKey]: watermark,
      };
      writeHiddenIssueThreadWatermarks(hiddenIssueThreadsStorageKey, next);
      return next;
    });
  };

  const openCreateCustomGroupEditor = (
    anchor: HTMLElement,
    invoker: HTMLButtonElement,
    threadKey?: string,
  ) => {
    customGroupEditorAnchorRef.current = anchor;
    customGroupEditorInvokerRef.current = invoker;
    customGroupEditorRestoreFocusRef.current = true;
    setCustomGroupRename(null);
    setCustomGroupEditor({ mode: "create", threadKey });
    setCustomGroupNameDraft("");
    setCustomGroupIconDraft("folder");
    setCustomGroupColorDraft("amber");
  };

  const closeCustomGroupEditor = useCallback(() => {
    setCustomGroupEditor(null);
    setCustomGroupNameDraft("");
    setCustomGroupIconDraft("folder");
    setCustomGroupColorDraft("amber");
  }, []);

  const submitCustomGroupEditor = () => {
    if (!customGroupEditor) return;
    const name = customGroupNameDraft.trim();
    if (!name) return;
    const icon = composeCustomGroupIconValue(customGroupIconDraft, customGroupColorDraft);
    createCustomGroupMutation.mutate({
      name,
      icon: icon || null,
      threadKey: customGroupEditor.threadKey,
    });
    closeCustomGroupEditor();
  };

  const handleCreateCustomGroup = (
    anchor: HTMLElement,
    invoker: HTMLButtonElement,
    threadKey?: string,
  ) => {
    window.setTimeout(() => {
      if (anchor.isConnected && invoker.isConnected) {
        openCreateCustomGroupEditor(anchor, invoker, threadKey);
      }
    }, 0);
  };

  useEffect(() => {
    if (!customGroupEditor) return undefined;
    const anchor = customGroupEditorAnchorRef.current;
    const sidebarScrollElement = sidebarScrollElementRef.current;
    if (!anchor?.isConnected || !sidebarScrollElement?.contains(anchor)) return undefined;
    const closeWhenAnchorLeavesSidebar = () => {
      const anchorRect = anchor.getBoundingClientRect();
      const sidebarRect = sidebarScrollElement.getBoundingClientRect();
      if (anchorRect.bottom > sidebarRect.top && anchorRect.top < sidebarRect.bottom) return;
      customGroupEditorRestoreFocusRef.current = false;
      closeCustomGroupEditor();
    };
    sidebarScrollElement.addEventListener("scroll", closeWhenAnchorLeavesSidebar, { passive: true });
    return () => sidebarScrollElement.removeEventListener("scroll", closeWhenAnchorLeavesSidebar);
  }, [closeCustomGroupEditor, customGroupEditor]);

  const handleRenameCustomGroup = (group: MessengerCustomGroupWithEntries) => {
    setCustomGroupEditor(null);
    setCustomGroupRename({ group, name: group.name });
  };

  const closeCustomGroupRename = () => {
    setCustomGroupRename(null);
  };

  const submitCustomGroupRename = () => {
    if (!customGroupRename) return;
    const name = customGroupRename.name.trim();
    if (!name) return;
    updateCustomGroupMutation.mutate({
      groupId: customGroupRename.group.id,
      data: { name },
    });
    closeCustomGroupRename();
  };

  const queueCustomGroupIconUpdate = (groupId: string, icon: string | null) => {
    const orgId = model.selectedOrganizationId;
    if (!orgId) return;
    const previous = customGroupIconUpdateQueuesRef.current[groupId] ?? Promise.resolve();
    const update = previous.catch(() => undefined).then(async () => {
      try {
        await messengerApi.updateCustomGroup(orgId, groupId, { icon });
        await refreshCustomGroups();
      } catch (error) {
        setPendingCustomGroupIcons((current) => {
          if (current[groupId] !== icon) return current;
          const nextPending = { ...current };
          delete nextPending[groupId];
          return nextPending;
        });
      }
    });
    const queued = update.finally(() => {
      if (customGroupIconUpdateQueuesRef.current[groupId] === queued) {
        delete customGroupIconUpdateQueuesRef.current[groupId];
      }
    });
    customGroupIconUpdateQueuesRef.current[groupId] = queued;
  };

  const updateCustomGroupIcon = (group: MessengerCustomGroupWithEntries, glyph: string) => {
    const currentIcon = pendingCustomGroupIcons[group.id] ?? group.icon;
    const parsedIcon = splitCustomGroupIconValue(currentIcon);
    const color = parsedIcon.color ?? customGroupColorFor(group);
    const icon = composeCustomGroupIconValue(glyph, color) || null;
    setPendingCustomGroupIcons((current) => ({ ...current, [group.id]: icon }));
    queueCustomGroupIconUpdate(group.id, icon);
  };

  const updateCustomGroupColor = (group: MessengerCustomGroupWithEntries, color: CustomGroupColor | null) => {
    const currentIcon = pendingCustomGroupIcons[group.id] ?? group.icon;
    const parsedIcon = splitCustomGroupIconValue(currentIcon);
    const icon = composeCustomGroupIconValue(parsedIcon.glyph, color) || null;
    setPendingCustomGroupIcons((current) => ({ ...current, [group.id]: icon }));
    queueCustomGroupIconUpdate(group.id, icon);
  };

  const handleSeparateCustomGroup = async (group: MessengerCustomGroupWithEntries) => {
    const confirmed = await confirm({
      title: "Separate items",
      description: `Move the items in "${group.name}" back into the main list? The Messenger threads will stay intact.`,
      confirmLabel: "Separate items",
      tone: "default",
    });
    if (!confirmed) return;
    separateCustomGroupMutation.mutate(group.id);
  };

  const renderThreadEntry = (
    entry: OrganizedThreadEntry,
    dragHandleProps?: SortableDragHandleProps,
    dragging = false,
  ) => {
    const { thread, conversation } = entry;
    const active = activeThreadKey === thread.threadKey;
    const preserveUnreadEmphasis = selectedReadEmphasisKey === thread.threadKey;
    if (thread.kind === "chat" && conversation) {
      const agentId = resolveChatAgentId(conversation);
      const archiveDeleteAllowed = !isFeishuBackedConversation(conversation);
      return (
        <ChatThreadRow
          key={thread.threadKey}
          conversation={conversation}
          agent={agentId ? agentsById.get(agentId) ?? null : null}
          agentId={agentId}
          sourceBadge={resolveSourceBadge(conversation, thread.metadata)}
          href={thread.href}
          active={active}
          generating={isChatGenerationActive(conversation.id)}
          density={threadDensity}
          renaming={renamingConversationId === conversation.id}
          renameDraft={renameDraft}
          onRenameDraftChange={setRenameDraft}
          onCommitRename={submitRename}
          onCancelRename={() => {
            setRenameDraft("");
            setRenamingConversationId(null);
          }}
          onStartRename={() => {
            setRenamingConversationId(conversation.id);
            setRenameDraft(conversation.title);
          }}
          onRegenerateTitle={canRegenerateChatTitles ? () => regenerateTitleMutation.mutate(conversation.id) : undefined}
          titleGenerating={generatingChatTitleIds.has(conversation.id)}
          onFork={() => forkConversationMutation.mutate(conversation.id)}
          onArchive={() => {
            if (model.selectedOrganizationId) {
              archiveMessengerChatInCache(queryClient, model.selectedOrganizationId, conversation.id);
            }
            updateConversationMutation.mutate({
              chatId: conversation.id,
              data: { status: "archived" },
            });
          }}
          onDelete={async () => {
            const confirmed = await confirm({
              title: "Delete chat",
              description: `Delete "${conversationDisplayTitle(conversation)}"? This cannot be undone.`,
              confirmLabel: "Delete",
              tone: "destructive",
            });
            if (!confirmed) return;
            deleteConversationMutation.mutate({
              chatId: conversation.id,
              generating: isChatGenerationActive(conversation.id),
            });
          }}
          archiveDeleteAllowed={archiveDeleteAllowed}
          onTogglePin={() => {
            if (model.selectedOrganizationId) {
              markMessengerChatPinnedInCache(queryClient, model.selectedOrganizationId, conversation.id, !conversation.isPinned);
            }
            updateConversationUserStateMutation.mutate({
              chatId: conversation.id,
              pinned: !conversation.isPinned,
            });
          }}
          onToggleUnread={() => {
            updateConversationUserStateMutation.mutate({
              chatId: conversation.id,
              unread: !conversation.isUnread,
            });
          }}
          onCopyConversationLink={() => void copyConversationLink(conversation)}
          customGroups={customGroups}
          customGroupId={entry.customGroupId}
          customGroupPending={entry.customGroupId ? !customGroups.some((group) => group.id === entry.customGroupId) : false}
          onMoveToCustomGroup={(groupId) => assignCustomGroupEntryMutation.mutate({ groupId, threadKey: thread.threadKey })}
          onRemoveFromCustomGroup={() => removeCustomGroupEntryMutation.mutate(thread.threadKey)}
          onCreateCustomGroup={(anchor, invoker) => handleCreateCustomGroup(anchor, invoker, thread.threadKey)}
          dragHandleProps={dragHandleProps}
          dragging={dragging}
          onSelect={handleMessengerEntrySelect}
        />
      );
    }

    return (
      <ThreadRow
        key={thread.threadKey}
        thread={thread}
        active={active}
        density={threadDensity}
        preserveUnreadEmphasis={preserveUnreadEmphasis}
        onTogglePin={() => {
          if (model.selectedOrganizationId) {
            markMessengerThreadPinnedInCache(queryClient, model.selectedOrganizationId, thread.threadKey, !thread.isPinned);
          }
          updateThreadUserStateMutation.mutate({
            threadKey: thread.threadKey,
            pinned: !thread.isPinned,
          });
        }}
        onHideIssue={() => handleHideIssueThread(thread)}
        customGroups={customGroups}
        customGroupId={entry.customGroupId}
        customGroupPending={entry.customGroupId ? !customGroups.some((group) => group.id === entry.customGroupId) : false}
        onMoveToCustomGroup={(groupId) => assignCustomGroupEntryMutation.mutate({ groupId, threadKey: thread.threadKey })}
        onRemoveFromCustomGroup={() => removeCustomGroupEntryMutation.mutate(thread.threadKey)}
        onCreateCustomGroup={(anchor, invoker) => handleCreateCustomGroup(anchor, invoker, thread.threadKey)}
        dragHandleProps={dragHandleProps}
        dragging={dragging}
        onSelect={handleMessengerThreadSelect}
      />
    );
  };

  const renderThreadSection = (
    section: OrganizedThreadSection,
    dragHandleProps?: SortableDragHandleProps,
    draggingSection = false,
  ) => {
    const isManagedSection = isManagedThreadGroupRule(effectiveThreadOrganizationRule);
    const customGroup = effectiveThreadOrganizationRule === "custom" ? customGroupBySectionKey.get(section.key) ?? null : null;
    const customGroupTitleGenerating = Boolean(customGroup && generatingGroupTitleIds.has(customGroup.id));
    const displayedCustomGroup = customGroup;
    const collapsed = customGroup ? customGroup.collapsed : isManagedSection && collapsedThreadGroupKeys.has(section.key);
    const draggingEntryGroupId = draggingThreadId ? customEntryGroupByThreadKey.get(draggingThreadId) : undefined;
    const dragOverThisSection = dragOverId === section.key || section.entries.some((entry) => entry.thread.threadKey === dragOverId);
    const isMoveIntoGroupTarget = effectiveThreadOrganizationRule === "custom"
      && Boolean(displayedCustomGroup)
      && Boolean(draggingThreadId)
      && draggingEntryGroupId !== undefined
      && draggingEntryGroupId !== customGroup?.id
      && dragIntent === "move-into-group"
      && dragOverThisSection;
    const isStandaloneDropTarget = effectiveThreadOrganizationRule === "custom"
      && !customGroup
      && section.label === null
      && dragOverThisSection
      && draggingThreadId !== section.key
      && dragIntent === "move-out-of-group";
    const resolveEntryInsertionPlacement = (threadKey: string): MessengerInsertionPlacement => {
      if (!draggingThreadId || dragOverId !== threadKey || dragIntent !== "reorder-entry") return null;
      if (!customGroup && section.label === null && section.entries.length === 1) {
        const sectionKeys = organizedThreadSections
          .filter((candidate) => candidate.key !== "custom:pinned")
          .map((candidate) => candidate.key);
        const activeIndex = sectionKeys.indexOf(draggingThreadId);
        const overIndex = sectionKeys.indexOf(threadKey);
        if (activeIndex === -1 || overIndex === -1 || activeIndex === overIndex) return null;
        return activeIndex < overIndex ? "after" : "before";
      }
      const sectionKeys = section.entries.map((entry) => entry.thread.threadKey);
      const activeIndex = sectionKeys.indexOf(draggingThreadId);
      const overIndex = sectionKeys.indexOf(threadKey);
      if (activeIndex === -1 || overIndex === -1 || activeIndex === overIndex) return null;
      return activeIndex < overIndex ? "after" : "before";
    };
    const sectionInsertionPlacement: MessengerInsertionPlacement = (() => {
      if (!draggingThreadId || dragOverId !== section.key || dragIntent !== "reorder-group") return null;
      const activeGroupId = customGroupIdFromSectionKey(draggingThreadId);
      const activeGroup = activeGroupId ? customGroups.find((group) => group.id === activeGroupId) : null;
      const sectionKeys = activeGroup?.pinnedAt
        ? organizedThreadSections
          .find((candidate) => candidate.key === "custom:pinned")
          ?.childSections?.map((candidate) => candidate.key).filter((key) => Boolean(customGroupIdFromSectionKey(key))) ?? []
        : organizedThreadSections
          .filter((candidate) => candidate.key !== "custom:pinned")
          .map((candidate) => candidate.key);
      const activeIndex = sectionKeys.indexOf(draggingThreadId);
      const overIndex = sectionKeys.indexOf(section.key);
      if (activeIndex === -1 || overIndex === -1 || activeIndex === overIndex) return null;
      return activeIndex < overIndex ? "after" : "before";
    })();
    const visibleCount = isManagedSection
      ? Math.max(
        visibleThreadGroupEntryLimits[section.key] ?? MANAGED_GROUP_INITIAL_VISIBLE_COUNT,
        threadSectionRequiredVisibleCounts.get(section.key) ?? MANAGED_GROUP_INITIAL_VISIBLE_COUNT,
      )
      : section.entries.length;
    const visibleEntries = isManagedSection ? section.entries.slice(0, visibleCount) : section.entries;
    const hasHiddenLoadedEntries = isManagedSection && visibleCount < section.entries.length;
    const canFetchMoreForSection = isManagedSection
      && Boolean(model.hasMoreThreadSummaries)
      && visibleCount >= section.entries.length
      && section.entries.length >= MANAGED_GROUP_INITIAL_VISIBLE_COUNT;
    const showMoreControl = !collapsed && (hasHiddenLoadedEntries || canFetchMoreForSection || Boolean(model.isFetchingMoreThreadSummaries && canFetchMoreForSection));
    const showCollapseControl = !collapsed && isManagedSection && visibleCount > MANAGED_GROUP_INITIAL_VISIBLE_COUNT;
    const sectionContentTestId = isManagedSection ? `messenger-thread-section-${sanitizeThreadKey(section.key)}-content` : undefined;
    const isPinnedCustomSection = effectiveThreadOrganizationRule === "custom" && section.key === "custom:pinned";
    const isLoosePinnedCustomSection = effectiveThreadOrganizationRule === "custom" && section.key === "custom:pinned:loose";
    const hideSectionHeading = isPinnedCustomSection;
    const canSortCustomEntries = effectiveThreadOrganizationRule === "custom"
      && (Boolean(customGroup) || isPinnedCustomSection || isLoosePinnedCustomSection)
      && visibleEntries.length > 0;
    const canDragStandaloneCustomEntry = effectiveThreadOrganizationRule === "custom"
      && !customGroup
      && (section.label === null || isPinnedCustomSection)
      && visibleEntries.length === 1;
    const childSectionKeys = section.childSections
      ?.filter((childSection) => Boolean(customGroupIdFromSectionKey(childSection.key)))
      .map((childSection) => childSection.key) ?? [];
    const renderedChildSections = section.childSections?.length ? (
      <SortableContext items={childSectionKeys} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-1">
          {section.childSections.map((childSection) => (
            childSectionKeys.includes(childSection.key) ? (
              <SortableThreadSection key={childSection.key} id={childSection.key}>
                {(childDragHandleProps, childDragging) => renderThreadSection(childSection, childDragHandleProps, childDragging)}
              </SortableThreadSection>
            ) : (
              <div key={childSection.key} className="flex shrink-0 flex-col gap-1">
                {renderThreadSection(childSection)}
              </div>
            )
          ))}
        </div>
      </SortableContext>
    ) : null;
    const renderedEntries = canSortCustomEntries ? (
      <SortableContext
        items={visibleEntries.map((entry) => entry.thread.threadKey)}
        strategy={verticalListSortingStrategy}
      >
        {visibleEntries.map((entry) => (
          <SortableCustomThreadEntry
            key={entry.thread.threadKey}
            id={entry.thread.threadKey}
            insertionPlacement={resolveEntryInsertionPlacement(entry.thread.threadKey)}
          >
            {(dragHandlePropsForEntry, dragging) => renderThreadEntry(entry, dragHandlePropsForEntry, dragging)}
          </SortableCustomThreadEntry>
        ))}
      </SortableContext>
    ) : (
      visibleEntries.map((entry) => (
        <div key={entry.thread.threadKey} className="relative">
          <MessengerInsertionLine placement={resolveEntryInsertionPlacement(entry.thread.threadKey)} />
          {renderThreadEntry(entry, canDragStandaloneCustomEntry ? dragHandleProps : undefined)}
        </div>
      ))
    );
    const sectionBody = (
      <>
        {renderedChildSections}
        <div className="flex flex-col gap-1">
          {renderedEntries}
        </div>
        {showMoreControl || showCollapseControl ? (
          <div className="mx-1.5 flex items-center gap-1.5 px-2 py-1">
            {showMoreControl ? (
              <button
                type="button"
                data-testid={`messenger-thread-section-${sanitizeThreadKey(section.key)}-show-more`}
                className="inline-flex h-7 items-center rounded-[calc(var(--radius-sm)-1px)] px-2 text-[11px] font-medium text-muted-foreground transition-[background-color,color] hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={model.isFetchingMoreThreadSummaries}
                onClick={() => handleShowMoreThreadSection(section, visibleCount)}
              >
                {model.isFetchingMoreThreadSummaries && canFetchMoreForSection ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                    Loading
                  </span>
                ) : (
                  "Show more"
                )}
              </button>
            ) : null}
            {showCollapseControl ? (
              <button
                type="button"
                data-testid={`messenger-thread-section-${sanitizeThreadKey(section.key)}-collapse`}
                className="inline-flex h-7 items-center rounded-[calc(var(--radius-sm)-1px)] px-2 text-[11px] font-medium text-muted-foreground transition-[background-color,color] hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
                onClick={() => handleCollapseThreadSectionEntries(section.key)}
              >
                Collapse
              </button>
            ) : null}
          </div>
        ) : null}
      </>
    );

    if (section.label && displayedCustomGroup) {
      const attentionCount = sectionAttentionCount(section);
      return (
        <div
          data-testid={`messenger-thread-section-${sanitizeThreadKey(section.key)}`}
          data-drag-move-target={isMoveIntoGroupTarget ? "true" : undefined}
          data-drag-intent={isMoveIntoGroupTarget ? "move-into-group" : undefined}
          className={cn(
            "group/custom-group relative mx-0.5 rounded-[calc(var(--radius-md)-1px)] border p-1 text-[color:var(--messenger-group-text)] shadow-[0_8px_20px_-18px_rgba(15,23,42,0.45)] transition-[background-color,border-color] duration-150 bg-[color:var(--messenger-group-bg)] border-[color:var(--messenger-group-border)] hover:bg-[color:var(--messenger-group-bg-hover)] dark:bg-[color:var(--messenger-group-bg-dark)] dark:text-[color:var(--messenger-group-text-dark)] dark:border-[color:var(--messenger-group-border-dark)] dark:hover:bg-[color:var(--messenger-group-bg-hover-dark)]",
            isMoveIntoGroupTarget && "bg-[color:var(--messenger-group-bg-hover)] ring-2 ring-[color:color-mix(in_oklab,var(--messenger-group-text)_34%,transparent)]",
          )}
          style={customGroupStyle(displayedCustomGroup)}
        >
          <MessengerInsertionLine placement={sectionInsertionPlacement} tone="group" />
          <div className="flex min-h-8 items-center gap-1.5">
            <MessengerDragHandle
              dragHandleProps={dragHandleProps}
              label={`Drag group ${section.label}`}
              compact
            />
            <button
              type="button"
              aria-expanded={!collapsed}
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[calc(var(--radius-sm)-2px)] px-0.5 text-left text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
              onClick={() => handleThreadGroupToggle(section.key)}
            >
              {collapsed ? (
                <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />
              ) : (
                <ChevronDown className="h-3 w-3 shrink-0" aria-hidden />
              )}
              <CustomGroupIcon icon={displayedCustomGroup.icon} />
              <span className="min-w-0 flex-1 truncate">{section.label}</span>
              {customGroupTitleGenerating ? (
                <span
                  data-testid={`messenger-thread-section-${sanitizeThreadKey(section.key)}-title-generating`}
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-white/35 px-1.5 py-0.5 text-[10px] font-semibold text-current/75"
                  aria-label="Generating group title"
                >
                  <Loader2 className="h-2.5 w-2.5 animate-spin" aria-hidden />
                  Naming
                </span>
              ) : null}
              {attentionCount > 0 ? (
                <span
                  data-testid={`messenger-thread-section-${sanitizeThreadKey(section.key)}-attention-count`}
                  className="shrink-0 rounded-full bg-white/45 px-1.5 py-0.5 text-[10px] font-semibold"
                >
                  {attentionCount}
                </span>
              ) : null}
            </button>
            {isMoveIntoGroupTarget ? (
              <span
                data-testid={`messenger-thread-section-${sanitizeThreadKey(section.key)}-drop-intent`}
                className="shrink-0 rounded-full bg-white/45 px-1.5 py-0.5 text-[10px] font-semibold text-current/80"
              >
                Move into group
              </span>
            ) : null}
            {customGroup ? (
              <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Group actions"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] text-current/70 opacity-0 transition-[opacity,background-color,color] hover:bg-white/45 hover:text-current focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25 group-hover/custom-group:opacity-100 group-focus-within/custom-group:opacity-100 data-[state=open]:opacity-100"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="messenger-thread-actions-menu morph-popover morph-popover--from-right surface-overlay text-foreground">
                <DropdownMenuItem onClick={() => handleRenameCustomGroup(customGroup)}>
                  <PencilLine className="h-4 w-4" />
                  Rename...
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={customGroupTitleGenerating}
                  onClick={() => regenerateCustomGroupTitleMutation.mutate(customGroup.id)}
                >
                  {customGroupTitleGenerating ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  Regenerate title
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => updateCustomGroupMutation.mutate({
                    groupId: customGroup.id,
                    data: { pinned: !customGroup.pinnedAt },
                  })}
                >
                  {customGroup.pinnedAt ? (
                    <>
                      <PinOff className="h-4 w-4" />
                      Unpin
                    </>
                  ) : (
                    <>
                      <Pin className="h-4 w-4" />
                      Pin
                    </>
                  )}
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Folder className="h-4 w-4" />
                    Change icon
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent
                    className="morph-popover morph-popover--from-left surface-overlay w-auto p-2 text-foreground"
                    style={customGroupProjectColorCssVars(customGroupColorFor({
                      id: customGroup.id,
                      icon: pendingCustomGroupIcons[customGroup.id] ?? customGroup.icon,
                      sortOrder: customGroup.sortOrder,
                    }))}
                  >
                    <CustomGroupIconPicker
                      icon={pendingCustomGroupIcons[customGroup.id] ?? customGroup.icon}
                      ariaLabel="Group icons"
                      onIconChange={(option) => updateCustomGroupIcon(customGroup, option)}
                    />
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Palette className="h-4 w-4" />
                    Pick color
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="morph-popover morph-popover--from-left surface-overlay text-foreground">
                    {CUSTOM_GROUP_COLOR_OPTIONS.map((option) => {
                      const tone = CUSTOM_GROUP_TONES[option];
                      return (
                        <DropdownMenuItem key={option} onClick={() => updateCustomGroupColor(customGroup, option)}>
                          <span
                            className="inline-flex h-3.5 w-3.5 rounded-full border border-[color:color-mix(in_oklab,var(--border-strong)_42%,transparent)]"
                            style={{ backgroundColor: tone.swatch }}
                            aria-hidden
                          />
                          {option[0].toUpperCase() + option.slice(1)}
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => void handleSeparateCustomGroup(customGroup)}>
                  <FolderInput className="h-4 w-4" />
                  Separate items
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            ) : null}
          </div>
          <div
            data-testid={sectionContentTestId}
            className={cn(
              "grid transition-[grid-template-rows,opacity,margin-top] duration-200 ease-out",
              collapsed || draggingSection ? "mt-0 grid-rows-[0fr] opacity-0" : "mt-1 grid-rows-[1fr] opacity-100",
            )}
            aria-hidden={collapsed || draggingSection ? "true" : undefined}
            inert={collapsed || draggingSection ? true : undefined}
          >
            <div className="min-h-0 overflow-hidden">
              {sectionBody}
            </div>
          </div>
        </div>
      );
    }

    if (!section.label && isStandaloneDropTarget) {
      return (
        <div
          data-drag-drop-target="true"
          data-drag-intent="move-out-of-group"
          className="relative rounded-[calc(var(--radius-md)-1px)] ring-2 ring-[color:color-mix(in_oklab,var(--accent-strong)_30%,transparent)] ring-offset-1 ring-offset-[color:var(--surface-page)] transition-[background-color,border-color] duration-150"
        >
          <div className="pointer-events-none absolute -top-1 left-3 right-3 h-0.5 rounded-full bg-[color:var(--accent-strong)]" />
          <div
            data-testid={`messenger-thread-section-${sanitizeThreadKey(section.key)}-drop-intent`}
            className="pointer-events-none absolute right-2 top-1 z-10 rounded-full bg-[color:color-mix(in_oklab,var(--surface-elevated)_94%,transparent)] px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--accent-strong)] shadow-sm"
          >
            Move out of group
          </div>
          {sectionBody}
        </div>
      );
    }

    return (
      <>
        {section.label && !hideSectionHeading ? (
          isManagedSection ? (() => {
            const attentionCount = sectionAttentionCount(section);
            return (
              <button
                type="button"
                {...dragHandleProps?.attributes}
                {...dragHandleProps?.listeners}
                data-testid={`messenger-thread-section-${sanitizeThreadKey(section.key)}`}
                aria-expanded={!collapsed}
                className="relative mx-1.5 flex min-h-8 items-center gap-1.5 rounded-[calc(var(--radius-sm)-1px)] px-1.5 py-1.5 text-left text-[11px] font-semibold text-muted-foreground/72 transition-[background-color,color] hover:bg-[color:color-mix(in_oklab,var(--surface-active)_54%,transparent)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
                onClick={() => handleThreadGroupToggle(section.key)}
              >
                <MessengerInsertionLine placement={sectionInsertionPlacement} />
                {collapsed ? (
                  <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />
                ) : (
                  <ChevronDown className="h-3 w-3 shrink-0" aria-hidden />
                )}
                {projectIdFromSectionKey(section.key) && section.projectIcon ? (
                  <ProjectIcon
                    color={section.projectColor}
                    icon={section.projectIcon}
                    size="xs"
                    iconClassName="h-3.5 w-3.5"
                    testId={`messenger-thread-section-${sanitizeThreadKey(section.key)}-project-icon`}
                  />
                ) : null}
                <span className="min-w-0 flex-1 truncate">{section.label}</span>
                {attentionCount > 0 ? (
                  <span
                    data-testid={`messenger-thread-section-${sanitizeThreadKey(section.key)}-attention-count`}
                    className="shrink-0 rounded-full bg-[color:color-mix(in_oklab,var(--accent-info)_16%,transparent)] px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--accent-info)]"
                  >
                    {attentionCount}
                  </span>
                ) : null}
              </button>
            );
          })() : (
            <div
              data-testid={`messenger-thread-section-${sanitizeThreadKey(section.key)}`}
              className="px-3 pb-1 pt-2 text-[11px] font-semibold text-muted-foreground/72"
            >
              {section.label}
            </div>
          )
        ) : null}
        <div
          data-testid={hideSectionHeading ? `messenger-thread-section-${sanitizeThreadKey(section.key)}` : sectionContentTestId}
          className={cn(
            "grid transition-[grid-template-rows,opacity,margin-top] duration-200 ease-out",
            collapsed ? "mt-0 grid-rows-[0fr] opacity-0" : hideSectionHeading ? "mt-0 grid-rows-[1fr] opacity-100" : "mt-1 grid-rows-[1fr] opacity-100",
          )}
          aria-hidden={collapsed ? "true" : undefined}
          inert={collapsed ? true : undefined}
        >
          <div className="min-h-0 overflow-hidden">
            {sectionBody}
          </div>
        </div>
      </>
    );
  };

  const refreshChatViews = async (chatId?: string) => {
    if (!model.selectedOrganizationId) return;
    await Promise.all([
      invalidateMessengerThreadSummaryQueries(queryClient, model.selectedOrganizationId),
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(model.selectedOrganizationId, "all") }),
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(model.selectedOrganizationId, "active") }),
    ]);
    if (chatId) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(model.selectedOrganizationId, chatId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.chats.messages(model.selectedOrganizationId, chatId) }),
      ]);
    }
  };

  const updateConversationMutation = useMutation({
    mutationFn: ({ chatId, data }: { chatId: string; data: Parameters<typeof chatsApi.update>[1] }) =>
      chatsApi.update(chatId, data),
    onSuccess: async (conversation) => {
      if (conversation.status === "archived" && route.kind === "chat" && route.conversationId === conversation.id) {
        navigate("/messenger");
      }
      setRenamingConversationId((current) => (current === conversation.id ? null : current));
      await refreshChatViews(conversation.id);
    },
    onError: async (_error, variables) => {
      await refreshChatViews(variables.chatId);
    },
  });

  const renameConversationMutation = useMutation({
    mutationFn: ({ chatId, title }: { chatId: string; title: string }) =>
      chatsApi.update(chatId, { title }),
    onMutate: async ({ chatId, title }) => {
      if (!model.selectedOrganizationId) return;
      setPendingChatRenameTitles((current) => ({ ...current, [chatId]: title }));
      await cancelMessengerChatRenameQueries(queryClient, model.selectedOrganizationId);
      renameMessengerChatInCache(queryClient, model.selectedOrganizationId, chatId, title);
    },
    onSuccess: async (conversation) => {
      if (model.selectedOrganizationId) {
        renameMessengerChatInCache(queryClient, model.selectedOrganizationId, conversation.id, conversation.title);
      }
      await refreshChatViews(conversation.id);
      setPendingChatRenameTitles((current) => {
        if (!(conversation.id in current)) return current;
        const next = { ...current };
        delete next[conversation.id];
        return next;
      });
    },
    onError: async (_error, variables) => {
      await refreshChatViews(variables.chatId);
      setPendingChatRenameTitles((current) => {
        if (!(variables.chatId in current)) return current;
        const next = { ...current };
        delete next[variables.chatId];
        return next;
      });
    },
  });

  const deleteConversationMutation = useMutation({
    mutationFn: async ({ chatId, generating }: { chatId: string; generating: boolean }) => {
      if (generating) {
        abortChatStream(chatId);
        await chatsApi.stopMessageStream(chatId).catch(() => undefined);
        setStreamDraftForChat(chatId, null);
        setChatSendInFlight(chatId, false);
      }

      let lastError: unknown = null;
      for (let attempt = 0; attempt <= DELETE_AFTER_STOP_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
          return generating
            ? await chatsApi.remove(chatId, { cancelActive: true })
            : await chatsApi.remove(chatId);
        } catch (error) {
          lastError = error;
          const shouldRetry = generating && error instanceof ApiError && error.status === 409;
          if (!shouldRetry || attempt >= DELETE_AFTER_STOP_RETRY_DELAYS_MS.length) {
            throw error;
          }
          await sleep(DELETE_AFTER_STOP_RETRY_DELAYS_MS[attempt]!);
        }
      }

      throw lastError;
    },
    onSuccess: async (conversation) => {
      if (route.kind === "chat" && route.conversationId === conversation.id) {
        navigate("/messenger/chat");
      }
      await refreshChatViews(conversation.id);
    },
  });

  const updateConversationUserStateMutation = useMutation({
    mutationFn: ({
      chatId,
      pinned,
      unread,
    }: {
      chatId: string;
      pinned?: boolean;
      unread?: boolean;
    }) =>
      chatsApi.updateUserState(chatId, { pinned, unread }),
    onSuccess: async (conversation) => {
      await refreshChatViews(conversation.id);
    },
    onError: async (_error, variables) => {
      await refreshChatViews(variables.chatId);
    },
  });

  const regenerateTitleMutation = useMutation({
    mutationFn: (chatId: string) => chatsApi.regenerateTitle(chatId),
    onMutate: (chatId) => {
      setGeneratingChatTitleIds((current) => {
        const next = new Set(current);
        next.add(chatId);
        return next;
      });
    },
    onSuccess: async (conversation) => {
      if (model.selectedOrganizationId) {
        renameMessengerChatInCache(queryClient, model.selectedOrganizationId, conversation.id, conversation.title);
      }
    },
    onSettled: async (_data, _error, chatId) => {
      setGeneratingChatTitleIds((current) => {
        const next = new Set(current);
        next.delete(chatId);
        return next;
      });
      await refreshChatViews(chatId);
    },
  });

  const forkConversationMutation = useMutation({
    mutationFn: (chatId: string) => chatsApi.fork(chatId, {}),
    onSuccess: async (conversation) => {
      await Promise.all([
        refreshChatViews(conversation.id),
        model.selectedOrganizationId
          ? queryClient.invalidateQueries({ queryKey: queryKeys.messenger.customGroups(model.selectedOrganizationId) })
          : Promise.resolve(),
      ]);
      navigate(`/messenger/chat/${conversation.id}`);
    },
    onError: async (_error, chatId) => {
      await refreshChatViews(chatId);
    },
  });

  const updateThreadUserStateMutation = useMutation({
    mutationFn: ({
      threadKey,
      pinned,
    }: {
      threadKey: string;
      pinned?: boolean;
    }) => {
      if (!model.selectedOrganizationId) throw new Error("Organization is required to update Messenger thread state");
      return messengerApi.updateThreadUserState(model.selectedOrganizationId, threadKey, { pinned });
    },
    onSuccess: async () => {
      await refreshChatViews();
    },
    onError: async () => {
      await refreshChatViews();
    },
  });

  const submitRename = () => {
    const trimmed = renameDraft.trim();
    if (!renamingConversationId || !trimmed) {
      setRenamingConversationId(null);
      return;
    }
    setRenamingConversationId(null);
    renameConversationMutation.mutate({
      chatId: renamingConversationId,
      title: trimmed,
    });
  };

  const copyConversationLink = async (conversation: ChatConversation) => {
    try {
      await navigator.clipboard.writeText(chatReferenceMarkdown(conversation));
    } catch {
      // Ignore clipboard failures in restricted environments.
    }
  };

  useEffect(() => {
    if (!model.selectedOrganizationId) return;
    if (!activeThreadKey) return;
    if (route.kind === "chat") return;
    if (!activeThread || (activeThread.unreadCount === 0 && !activeThread.needsAttention)) return;
    if (!activeThreadDetailReady) return;

    const orgId = model.selectedOrganizationId;
    const watermark = activeThreadReadAt ?? activeThread.latestActivityAt ?? "none";
    const marker = `${orgId}:${activeThreadKey}:${watermark}`;
    if (markedThreadRef.current === marker) return;
    markedThreadRef.current = marker;

    setLocallyReadThreadWatermarks((current) => {
      const nextWatermark = activeThread.latestActivityAt instanceof Date
        ? activeThread.latestActivityAt.toISOString()
        : activeThread.latestActivityAt ?? "none";
      if (current.get(activeThreadKey) === nextWatermark) return current;
      const next = new Map(current);
      next.set(activeThreadKey, nextWatermark);
      return next;
    });
    markMessengerThreadReadInCache(queryClient, orgId, activeThreadKey, activeThreadReadAt);

    void messengerApi.markThreadRead(
      orgId,
      activeThreadKey,
      activeThreadReadAt ? new Date(activeThreadReadAt).toISOString() : null,
    ).then(async () => {
      await invalidateMessengerThreadSummaryQueries(queryClient, orgId);
      await queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(orgId) });
      if (route.kind === "issues") {
        await queryClient.invalidateQueries({ queryKey: queryKeys.messenger.issues(orgId) });
      }
      if (route.kind === "approvals") {
        await queryClient.invalidateQueries({ queryKey: queryKeys.messenger.approvals(orgId) });
      }
      if (route.kind === "system") {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.messenger.system(orgId, route.threadKind),
        });
      }
    }).catch(() => {
      markedThreadRef.current = null;
      setLocallyReadThreadWatermarks((current) => {
        if (!current.has(activeThreadKey)) return current;
        const next = new Map(current);
        next.delete(activeThreadKey);
        return next;
      });
    });
  }, [activeThread, activeThreadDetailReady, activeThreadKey, activeThreadReadAt, model.selectedOrganizationId, queryClient, route]);

  useEffect(() => {
    if (typeof document === "undefined") return;

    const handleUnreadScrollRequest = () => {
      const currentRequestId = getUnhandledMessengerUnreadScrollRequestId();
      if (currentRequestId > 0) {
        setUnreadScrollRequestId(currentRequestId);
      }
    };

    const currentRequestId = getUnhandledMessengerUnreadScrollRequestId();
    if (currentRequestId > 0) {
      setUnreadScrollRequestId(currentRequestId);
    }

    document.addEventListener(MESSENGER_SCROLL_TO_UNREAD_EVENT, handleUnreadScrollRequest);
    return () => {
      document.removeEventListener(MESSENGER_SCROLL_TO_UNREAD_EVENT, handleUnreadScrollRequest);
    };
  }, []);

  useEffect(() => {
    unreadScrollCursorRef.current = null;
  }, [model.selectedOrganizationId, splitIssueNotifications, threadOrganizationRule]);

  useEffect(() => {
    if (unreadThreadTargets.length > 0) return;
    unreadScrollCursorRef.current = null;
  }, [unreadThreadTargets.length]);

  useEffect(() => {
    if (!shouldLoadMoreForUnreadScroll) return;
    const marker = {
      requestId: unreadScrollRequestId,
      loadedCount: visibleThreadSummaries.length,
    };
    const previous = unreadLoadMoreRequestRef.current;
    if (
      previous
      && previous.requestId === marker.requestId
      && previous.loadedCount === marker.loadedCount
    ) {
      return;
    }
    unreadLoadMoreRequestRef.current = marker;
    void model.loadMoreThreadSummaries();
  }, [
    model.loadMoreThreadSummaries,
    shouldLoadMoreForUnreadScroll,
    unreadScrollRequestId,
    visibleThreadSummaries.length,
  ]);

  useEffect(() => {
    if (unreadScrollRequestId <= 0) return;
    if (handledUnreadScrollRequestIdRef.current === unreadScrollRequestId) return;
    if (unreadScrollTarget) return;
    if (shouldLoadMoreForUnreadScroll) return;
    if (model.isFetchingMoreThreadSummaries || model.isLoading) return;
    if (model.hasMoreThreadSummaries) return;
    if (unreadThreadTargets.length > 0) return;

    handledUnreadScrollRequestIdRef.current = unreadScrollRequestId;
    markMessengerUnreadScrollRequestHandled(unreadScrollRequestId);
    unreadLoadMoreRequestRef.current = null;
  }, [
    model.hasMoreThreadSummaries,
    model.isFetchingMoreThreadSummaries,
    model.isLoading,
    shouldLoadMoreForUnreadScroll,
    unreadScrollRequestId,
    unreadScrollTarget,
    unreadThreadTargets.length,
  ]);

  useEffect(() => {
    if (!unreadScrollTarget) return;
    if (unreadScrollRequestId <= 0) return;
    if (handledUnreadScrollRequestIdRef.current === unreadScrollRequestId) return;

    if (
      unreadScrollTarget.groupKey
      && collapsedThreadGroupKeys.has(unreadScrollTarget.groupKey)
    ) {
      setCollapsedThreadGroupKeys((current) => {
        const groupKey = unreadScrollTarget.groupKey;
        if (!groupKey || !current.has(groupKey)) return current;
        const next = new Set(current);
        next.delete(groupKey);
        if (model.selectedOrganizationId && isManagedThreadGroupRule(effectiveThreadOrganizationRule)) {
          writeCollapsedThreadGroups(model.selectedOrganizationId, effectiveThreadOrganizationRule, next);
        }
        return next;
      });
      return;
    }

    if (
      unreadScrollTarget.groupKey
      && unreadScrollTarget.entryIndex !== null
    ) {
      const requiredVisibleCount = unreadScrollTarget.entryIndex + 1;
      const currentVisibleCount = visibleThreadGroupEntryLimits[unreadScrollTarget.groupKey]
        ?? MANAGED_GROUP_INITIAL_VISIBLE_COUNT;
      if (requiredVisibleCount > currentVisibleCount) {
        setVisibleThreadGroupEntryLimits((current) => ({
          ...current,
          [unreadScrollTarget.groupKey!]: requiredVisibleCount,
        }));
        return;
      }
    }

    const scrollFirstUnreadThreadIntoView = () => {
      const container = sidebarScrollElementRef.current;
      if (!container) return;

      const unreadRow = Array.from(container.querySelectorAll<HTMLElement>("[data-messenger-thread-key]"))
        .find((row) => row.dataset.messengerThreadKey === unreadScrollTarget.threadKey);

      unreadRow?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      if (unreadRow) {
        unreadScrollCursorRef.current = unreadScrollTarget.threadKey;
        handledUnreadScrollRequestIdRef.current = unreadScrollRequestId;
        markMessengerUnreadScrollRequestHandled(unreadScrollRequestId);
        unreadLoadMoreRequestRef.current = null;
      }
    };

    const frame = requestAnimationFrame(scrollFirstUnreadThreadIntoView);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [collapsedThreadGroupKeys, model.selectedOrganizationId, threadOrganizationRule, unreadScrollRequestId, unreadScrollTarget, visibleThreadGroupEntryLimits]);

  useEffect(() => {
    const sentinel = loadMoreThreadSummariesRef.current;
    const root = sidebarScrollElementRef.current;
    if (!sentinel || !root) return;
    if (!shouldAutoLoadMoreThreadSummaries) return;
    if (!model.hasMoreThreadSummaries || model.isFetchingMoreThreadSummaries || model.isLoading) return;
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      if (!visible || !model.hasMoreThreadSummaries || model.isFetchingMoreThreadSummaries) return;
      void model.loadMoreThreadSummaries();
    }, { root, rootMargin: "720px 0px 960px 0px" });

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    model.hasMoreThreadSummaries,
    model.isFetchingMoreThreadSummaries,
    model.isLoading,
    model.loadMoreThreadSummaries,
    shouldAutoLoadMoreThreadSummaries,
    visibleThreadSummaries.length,
  ]);

  if (!model.selectedOrganizationId) return null;

  return (
    <aside
      data-testid="workspace-sidebar"
      className="workspace-context-sidebar flex min-h-0 w-full min-w-0 shrink-0 flex-col"
    >
      <ContextColumnHeader
        title="Messenger"
        description={effectiveThreadOrganizationRule === "custom"
          ? "Threads sorted by latest activity"
          : `Threads organized by ${threadOrganizationLabel(effectiveThreadOrganizationRule).toLowerCase()}`}
      />
      <MessengerThreadSectionHeader
        rule={threadOrganizationRule}
        density={threadDensity}
        splitIssueNotifications={splitIssueNotifications}
        onRuleChange={handleThreadOrganizationRuleChange}
        onDensityChange={handleThreadDensityChange}
        onSplitIssueNotificationsChange={handleSplitIssueNotificationsChange}
        onCreateCustomGroup={(anchor, invoker) => handleCreateCustomGroup(anchor, invoker)}
      />
      <Popover
        open={Boolean(customGroupEditor)}
        onOpenChange={(open) => {
          if (!open) closeCustomGroupEditor();
        }}
      >
        <PopoverAnchor virtualRef={customGroupEditorAnchorRef} />
        {customGroupEditor ? (
          <PopoverContent
            ref={customGroupEditorScrollbarActivityRef}
            side={isMobile ? "bottom" : "right"}
            align="center"
            sideOffset={8}
            collisionPadding={12}
            hideWhenDetached
            onInteractOutside={() => {
              customGroupEditorRestoreFocusRef.current = false;
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (
                customGroupEditorRestoreFocusRef.current
                && customGroupEditorInvokerRef.current?.isConnected
              ) {
                customGroupEditorInvokerRef.current.focus();
              }
            }}
            aria-label="Create Messenger group"
            data-testid="messenger-custom-group-popover"
            className="scrollbar-auto-hide surface-overlay z-[70] max-h-[min(34rem,var(--radix-popover-content-available-height))] w-[min(25rem,calc(100vw-2rem))] overflow-y-auto p-0 text-foreground"
          >
            <CustomGroupEditor
              name={customGroupNameDraft}
              icon={customGroupIconDraft}
              color={customGroupColorDraft}
              pending={createCustomGroupMutation.isPending || updateCustomGroupMutation.isPending}
              onNameChange={setCustomGroupNameDraft}
              onIconChange={setCustomGroupIconDraft}
              onColorChange={setCustomGroupColorDraft}
              onCancel={closeCustomGroupEditor}
              onSubmit={submitCustomGroupEditor}
            />
          </PopoverContent>
        ) : null}
      </Popover>
      {customGroupRename ? (
        <CustomGroupRenameForm
          name={customGroupRename.name}
          pending={updateCustomGroupMutation.isPending}
          onNameChange={(name) => setCustomGroupRename((current) => current ? { ...current, name } : current)}
          onCancel={closeCustomGroupRename}
          onSubmit={submitCustomGroupRename}
        />
      ) : null}
      <nav
        ref={setSidebarScrollRef}
        className="scrollbar-auto-hide mt-2 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1.5 pb-3.5"
      >
        <Link
          to="/messenger/chat"
          onClick={() => handleMessengerEntrySelect("/messenger/chat")}
          className={cn(
            "mx-0.5 flex items-center rounded-[calc(var(--radius-md)-2px)] border border-transparent text-sm transition-[background-color,border-color,color]",
            threadDensity === "compact" ? "gap-2 px-2 py-1.5" : "gap-3 px-3 py-2.5",
            route.kind === "chat" && !route.conversationId
              ? "chat-conversation-active border-[color:var(--border-strong)] bg-[color:color-mix(in_oklab,var(--surface-active)_90%,var(--surface-elevated))] font-medium text-foreground"
              : "text-foreground/78 hover:border-[color:color-mix(in_oklab,var(--border-soft)_52%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_68%,transparent)] hover:text-foreground",
          )}
        >
          <span className={cn(
            "flex shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)+1px)] border border-[color:color-mix(in_oklab,var(--border-soft)_88%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-active)_82%,transparent)] text-[color:var(--accent-strong)]",
            threadDensity === "compact" ? "h-7 w-7" : "h-10 w-10",
          )}>
            <Plus className={cn(threadDensity === "compact" ? "h-3.5 w-3.5" : "h-4.5 w-4.5")} />
          </span>
          <span className="truncate text-[13px] font-medium leading-tight">New chat</span>
        </Link>
        {model.isLoading && visibleThreadSummaries.length === 0 ? (
          <div className="space-y-1 px-1.5">
            {Array.from({ length: 5 }).map((_, index) => (
              <div
                key={index}
                className={cn(
                  "animate-pulse rounded-[calc(var(--radius-md)-2px)] border border-transparent bg-[color:color-mix(in_oklab,var(--surface-elevated)_60%,transparent)]",
                  threadDensity === "compact" ? "h-10" : "h-[72px]",
                )}
              />
            ))}
          </div>
        ) : null}
        {isManagedThreadGroupRule(effectiveThreadOrganizationRule) ? (
          <>
            <DndContext
              sensors={sensors}
              collisionDetection={messengerThreadCollisionDetection}
              measuring={MESSENGER_THREAD_DND_MEASURING}
              onDragStart={handleThreadSectionDragStart}
              onDragOver={handleThreadSectionDragOver}
              onDragCancel={resetThreadDragState}
              onDragEnd={handleThreadSectionDragEnd}
            >
              <SortableContext
                items={sortableThreadSectionKeys}
                strategy={verticalListSortingStrategy}
              >
                {organizedThreadSections.map((section) => (
                  sortableThreadSectionKeys.includes(section.key) ? (
                    <SortableThreadSection key={section.key} id={section.key}>
                      {(dragHandleProps, draggingSection) => renderThreadSection(section, dragHandleProps, draggingSection)}
                    </SortableThreadSection>
                  ) : (
                    <div key={section.key} className="flex shrink-0 flex-col gap-1">
                      {renderThreadSection(section)}
                    </div>
                  )
                ))}
              </SortableContext>
            </DndContext>
          </>
        ) : (
          organizedThreadSections.map((section) => (
            <div key={section.key} className="flex shrink-0 flex-col gap-1">
              {renderThreadSection(section)}
            </div>
          ))
        )}
        {model.hasMoreThreadSummaries || model.isFetchingMoreThreadSummaries ? (
          <div
            ref={loadMoreThreadSummariesRef}
            data-testid="messenger-thread-page-sentinel"
            className="flex min-h-10 items-center justify-center px-3 py-2 text-[12px] text-muted-foreground"
          >
            {model.isFetchingMoreThreadSummaries ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                Loading more threads
              </span>
            ) : !shouldAutoLoadMoreThreadSummaries ? (
              <button
                type="button"
                data-testid="messenger-thread-page-load-more"
                className="inline-flex h-7 items-center rounded-[calc(var(--radius-sm)-1px)] px-2 text-[11px] font-medium text-muted-foreground transition-[background-color,color] hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
                onClick={() => void model.loadMoreThreadSummaries()}
              >
                Load more threads
              </button>
            ) : null}
          </div>
        ) : null}
      </nav>
    </aside>
  );
}
