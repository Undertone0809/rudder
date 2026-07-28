import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { chatsApi } from "@/api/chats";
import { ApiError } from "@/api/client";
import { messengerApi } from "@/api/messenger";
import { organizationsApi } from "@/api/orgs";
import { projectsApi } from "@/api/projects";
import { AgentIcon } from "@/components/AgentAvatar";
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
  MessengerSavedViewRow,
  savedViewDisplayTitle,
} from "@/components/messenger/MessengerSavedViewRow";
import {
  ChatThreadRow,
  conversationDisplayTitle,
  MessengerDragHandle,
  sanitizeThreadKey,
  ThreadRow,
  type SortableDragHandleProps
} from "@/components/messenger/MessengerThreadListViews";
import { MessengerDiscordCta } from "@/components/MessengerDiscordCta";
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
import { VirtualizedActivityTimeline } from "@/components/VirtualizedActivityTimeline";
import { useChatGenerationActions } from "@/context/ChatGenerationContext";
import { useDialog } from "@/context/DialogContext";
import {
  useMainWorkbench,
} from "@/context/MainWorkbenchContext";
import { useOrganization } from "@/context/OrganizationContext";
import { useOptionalSavedViewPromotion } from "@/context/SavedViewPromotionContext";
import { useSidebar } from "@/context/SidebarContext";
import { useToast } from "@/context/ToastContext";
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
  removeMessengerSavedViewFromCustomGroupsCache,
  renameMessengerChatInCache,
} from "@/lib/messenger-query-cache";
import { messengerSavedViewRoute } from "@/lib/messenger-saved-views";
import { messengerThreadKindLabel } from "@/lib/messenger-thread-labels";
import {
  chatConversationForThreadSummary,
  customGroupIdFromSectionKey,
  customGroupSectionKey,
  dedupeThreadSummariesByKey,
  flattenThreadSectionEntries,
  flattenThreadSections,
  locallyReadThreadSummary,
  nextDefaultThreadOrderKeysAfterMove,
  organizeCustomThreadDirectory,
  organizeProjectThreadDirectory,
  organizeThreadEntries,
  projectIdFromSectionKey,
  resolveChatAgentId,
  sectionAttentionCount,
  sortManagedThreadSections,
  splitIssueThreadWatermark,
  storedThreadSectionIdToKey,
  threadConversationId,
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
  DragOverlay,
  KeyboardSensor,
  MeasuringFrequency,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type ScreenReaderInstructions,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { buildChatMentionHref, type Agent, type ChatConversation, type MessengerCustomGroupHydratedEntry, type MessengerCustomGroupHydratedSavedViewEntry, type MessengerCustomGroupHydratedThreadEntry, type MessengerCustomGroupWithEntries, type MessengerSavedView, type MessengerThreadSummary, type Project } from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
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

function isThreadCustomGroupEntry(
  entry: MessengerCustomGroupHydratedEntry,
): entry is MessengerCustomGroupHydratedThreadEntry {
  return entry.item.type === "thread";
}

function isSavedViewCustomGroupEntry(
  entry: MessengerCustomGroupHydratedEntry,
): entry is MessengerCustomGroupHydratedSavedViewEntry {
  return entry.item.type === "saved_view";
}

function customGroupEntryItemKey(entry: MessengerCustomGroupHydratedEntry) {
  if (entry.itemKey?.trim()) return entry.itemKey;
  if (isThreadCustomGroupEntry(entry)) return entry.threadKey;
  return entry.item.itemKey;
}

function messengerSidebarEntryItemKey(row: HTMLElement) {
  if (row.dataset.messengerSavedViewId) {
    return `saved-view:${row.dataset.messengerSavedViewId}`;
  }
  return row.dataset.messengerThreadKey ?? null;
}

type CustomGroupEditorState = { mode: "create"; threadKey?: string };
type CustomGroupRenameState = { group: MessengerCustomGroupWithEntries; name: string };
type MessengerDragIntent = "move-into-group" | "move-out-of-group" | "reorder-group" | "reorder-entry" | null;
type MessengerInsertionPlacement = "before" | "after" | null;
type MessengerTopLevelDirectoryItem =
  | { key: string; kind: "section"; section: OrganizedThreadSection }
  | { key: string; kind: "saved-view"; savedView: MessengerSavedView };

const MANAGED_GROUP_INITIAL_VISIBLE_COUNT = 6;
const MANAGED_GROUP_VISIBLE_INCREMENT = 10;
const MESSENGER_SAVED_VIEW_PAGE_LIMIT = 50;
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

function applyManualDirectoryOrder(
  items: MessengerTopLevelDirectoryItem[],
  orderedKeys: string[],
) {
  if (orderedKeys.length === 0) return items;
  const itemByKey = new Map(items.map((item) => [item.key, item]));
  const manualItems = orderedKeys
    .map((key) => itemByKey.get(key) ?? null)
    .filter((item): item is MessengerTopLevelDirectoryItem => Boolean(item));
  if (manualItems.length === 0) return items;
  const manualKeys = new Set(manualItems.map((item) => item.key));
  const firstManualIndex = items.findIndex((item) => manualKeys.has(item.key));
  return [
    ...items.slice(0, firstManualIndex).filter((item) => !manualKeys.has(item.key)),
    ...manualItems,
    ...items.slice(firstManualIndex).filter((item) => !manualKeys.has(item.key)),
  ];
}

function sortableTranslateTransform(transform: { x: number; y: number } | null) {
  if (!transform) return undefined;
  return `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)`;
}

function savedViewLooseDropPlacement(
  event: Pick<DragEndEvent, "active" | "over"> & {
    activatorEvent?: Event;
  },
): MessengerInsertionPlacement {
  if (
    typeof KeyboardEvent !== "undefined"
    && event.activatorEvent instanceof KeyboardEvent
  ) {
    if (event.activatorEvent.shiftKey) return null;
    const initial = event.active.rect?.current?.initial;
    const overRect = event.over?.rect;
    if (!initial || !overRect) return "before";
    const initialCenterY = initial.top + initial.height / 2;
    const overCenterY = overRect.top + overRect.height / 2;
    return initialCenterY < overCenterY ? "after" : "before";
  }
  const translated = event.active.rect?.current?.translated;
  const overRect = event.over?.rect;
  if (!translated || !overRect) return null;
  const activeCenterY = translated.top + translated.height / 2;
  const edgeSize = Math.max(8, overRect.height * 0.25);
  if (activeCenterY <= overRect.top + edgeSize) return "before";
  if (activeCenterY >= overRect.bottom - edgeSize) return "after";
  return null;
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

function threadOrganizationLabel(rule: ThreadOrganizationRule) {
  if (rule === "custom") return "Latest activity";
  return THREAD_ORGANIZATION_OPTIONS.find((option) => option.value === rule)?.label ?? "Latest activity";
}

interface UnreadThreadTarget {
  threadKey: string;
  groupKey: string | null;
  sectionPath: string[];
  entryIndex: number | null;
}

type ProjectOrderUpdatedDetail = {
  storageKey: string;
  orderedIds: string[];
};

function MessengerSectionAutoLoader({
  loading,
  onVisible,
  testId,
}: {
  loading: boolean;
  onVisible: () => void;
  testId: string;
}) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || loading || typeof IntersectionObserver === "undefined") return undefined;
    const root = sentinel.closest<HTMLElement>("nav");
    if (!root) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onVisible();
    }, { root, rootMargin: "0px 0px 320px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loading, onVisible]);

  return (
    <div
      ref={sentinelRef}
      data-testid={testId}
      className="flex min-h-7 items-center px-2 text-[11px] text-muted-foreground"
      aria-live="polite"
    >
      {loading ? (
        <span className="inline-flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          Loading
        </span>
      ) : null}
    </div>
  );
}

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
  disabled = false,
  children,
}: {
  id: string;
  insertionPlacement?: MessengerInsertionPlacement;
  disabled?: boolean;
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
  } = useSortable({ id, disabled });
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

export function MessengerContextSidebar() {
  const { pushToast } = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  const relativePath = toOrganizationRelativePath(location.pathname);
  const performanceBaselineMode = import.meta.env.MODE === "test"
    || new URLSearchParams(location.search).get("perfBaseline") === "1";
  const { selectedOrganizationId } = useOrganization();
  const [splitIssueNotifications, setSplitIssueNotifications] = useState(() =>
    readSplitIssueNotifications(selectedOrganizationId),
  );
  const model = useMessengerModel({ splitIssues: splitIssueNotifications });
  const mainWorkbench = useMainWorkbench();
  const savedViewPromotion = useOptionalSavedViewPromotion();
  const { isMobile, setSidebarOpen } = useSidebar();
  const { confirm } = useDialog();
  const {
    abortChatStream,
    isChatGenerationActive,
    setChatSendInFlight,
    setStreamDraftForChat,
  } = useChatGenerationActions();
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
  const unreadCustomGroupExpansionRequestIdsRef = useRef<Map<string, number>>(new Map());
  const pendingSavedViewPlacementItemKeysRef = useRef(new Set<string>());
  const [
    pendingSavedViewPlacementItemKeys,
    setPendingSavedViewPlacementItemKeys,
  ] = useState<Set<string>>(() => new Set());
  const [savedViewPageOffset, setSavedViewPageOffset] = useState(0);
  const [loadedSavedViewPages, setLoadedSavedViewPages] = useState<
    Record<number, MessengerSavedView[]>
  >({});
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
  const currentOrganizationIdRef = useRef(model.selectedOrganizationId);
  const relativePathRef = useRef(relativePath);
  currentOrganizationIdRef.current = model.selectedOrganizationId;
  relativePathRef.current = relativePath;
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
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
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
    setSavedViewPageOffset(0);
    setLoadedSavedViewPages({});
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
  const savedViewsQuery = useQuery({
    queryKey: queryKeys.messenger.savedViews(
      model.selectedOrganizationId ?? "__none__",
      "visible",
      MESSENGER_SAVED_VIEW_PAGE_LIMIT,
      savedViewPageOffset,
    ),
    queryFn: () => messengerApi.listSavedViews(model.selectedOrganizationId!, {
      visibility: "visible",
      limit: MESSENGER_SAVED_VIEW_PAGE_LIMIT,
      offset: savedViewPageOffset,
    }),
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
  const customGroupMembershipKnown = customGroupsQuery.data !== undefined;
  const loadedSavedViews = useMemo(() => {
    const byId = new Map<string, MessengerSavedView>();
    for (const offset of Object.keys(loadedSavedViewPages)
      .map(Number)
      .sort((left, right) => left - right)) {
      for (const savedView of loadedSavedViewPages[offset] ?? []) {
        if (savedView.orgId === model.selectedOrganizationId) {
          byId.set(savedView.id, savedView);
        }
      }
    }
    for (const savedView of savedViewsQuery.data?.items ?? []) {
      if (savedView.orgId === model.selectedOrganizationId) {
        byId.set(savedView.id, savedView);
      }
    }
    return Array.from(byId.values()).sort((left, right) => left.sortOrder - right.sortOrder);
  }, [
    loadedSavedViewPages,
    model.selectedOrganizationId,
    savedViewsQuery.data?.items,
  ]);
  const groupedSavedViewIds = useMemo(() => new Set(
    customGroups.flatMap((group) => group.entries)
      .filter(isSavedViewCustomGroupEntry)
      .map((entry) => entry.item.savedView.id),
  ), [customGroups]);
  const looseSavedViews = useMemo(
    () => customGroupMembershipKnown
      ? loadedSavedViews.filter((savedView) => !groupedSavedViewIds.has(savedView.id))
      : [],
    [customGroupMembershipKnown, groupedSavedViewIds, loadedSavedViews],
  );
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
      const sourceThreadsByKey = new Map<string, MessengerThreadSummary[]>();
      for (const thread of model.threadSummaries) {
        sourceThreadsByKey.set(thread.threadKey, [...sourceThreadsByKey.get(thread.threadKey) ?? [], thread]);
      }
      for (const group of customGroups) {
        for (const entry of group.entries) {
          if (!isThreadCustomGroupEntry(entry)) continue;
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
    const groupInputs = customGroups.map((group) => ({
      id: group.id,
      name: group.name,
      icon: group.icon,
      pinned: Boolean(group.pinnedAt),
      entries: group.entries.filter(isThreadCustomGroupEntry).map((entry) => {
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
    if (effectiveThreadOrganizationRule === "custom") {
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
    const baseSections = effectiveThreadOrganizationRule === "project"
      ? organizeProjectThreadDirectory(entries, groupInputs, projectsById)
      : organizeThreadEntries(
        entries,
        effectiveThreadOrganizationRule,
        agentsById,
        projectsById,
        messengerThreadKindLabel,
      );
    const savedViewGroupIds = new Set(
      customGroups
        .filter((group) => group.entries.some(isSavedViewCustomGroupEntry))
        .map((group) => group.id),
    );
    const supplementalSavedViewSections: OrganizedThreadSection[] = groupInputs
      .filter((group) => savedViewGroupIds.has(group.id))
      .map((group) => ({
        key: customGroupSectionKey(group.id),
        label: group.name,
        icon: group.icon,
        isPinned: group.pinned,
        entries: [],
      }));
    const sections: OrganizedThreadSection[] = effectiveThreadOrganizationRule === "agent"
      || effectiveThreadOrganizationRule === "kind"
      || effectiveThreadOrganizationRule === "attention"
      ? [
        ...baseSections,
        ...supplementalSavedViewSections,
      ]
      : baseSections;
    return isManagedThreadGroupRule(effectiveThreadOrganizationRule)
      ? sortManagedThreadSections(sections, effectiveThreadOrganizationRule, projectOrderIds, threadSectionOrderIds)
      : sections;
  }, [agentsById, conversationsById, customGroups, defaultThreadOrderKeys, effectiveThreadOrganizationRule, locallyReadThreadWatermarks, model.selectedOrganizationId, pendingChatRenameTitles, projectOrderIds, projectsById, threadSectionOrderIds, splitIssueNotifications, visibleThreadSummaries]);
  const customEntryGroupByThreadKey = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const group of customGroups) {
      for (const entry of group.entries) {
        if (!isThreadCustomGroupEntry(entry)) continue;
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
  const customEntryGroupByItemKey = useMemo(() => {
    const map = new Map(customEntryGroupByThreadKey);
    for (const group of customGroups) {
      for (const entry of group.entries) {
        map.set(customGroupEntryItemKey(entry), group.id);
      }
    }
    for (const savedView of looseSavedViews) {
      map.set(`saved-view:${savedView.id}`, null);
    }
    return map;
  }, [customEntryGroupByThreadKey, customGroups, looseSavedViews]);
  const savedViewEntryByItemKey = useMemo(() => {
    const map = new Map<string, {
      entry: MessengerCustomGroupHydratedSavedViewEntry | null;
      groupId: string | null;
      savedView: MessengerSavedView;
    }>();
    for (const group of customGroups) {
      for (const entry of group.entries) {
        if (!isSavedViewCustomGroupEntry(entry)) continue;
        map.set(customGroupEntryItemKey(entry), {
          entry,
          groupId: group.id,
          savedView: entry.item.savedView,
        });
      }
    }
    for (const savedView of looseSavedViews) {
      map.set(`saved-view:${savedView.id}`, {
        entry: null,
        groupId: null,
        savedView,
      });
    }
    return map;
  }, [customGroups, looseSavedViews]);
  const messengerDndAccessibility = useMemo(() => {
    const itemLabel = (id: string) => {
      const savedView = savedViewEntryByItemKey.get(id);
      if (savedView) {
        return `Saved View ${savedViewDisplayTitle(savedView.savedView)}`;
      }
      const group = customGroupBySectionKey.get(id);
      if (group) return `Messenger group ${group.name}`;
      return "Messenger item";
    };
    const destinationLabel = (id: string | null) => {
      if (!id) return "the Messenger list";
      const groupId = customGroupIdFromSectionKey(id)
        ?? customEntryGroupByItemKey.get(id)
        ?? null;
      const group = groupId
        ? customGroups.find((candidate) => candidate.id === groupId)
        : null;
      return group ? `Messenger group ${group.name}` : "a Messenger item";
    };
    const savedViewDropValidity = (
      activeId: string,
      overId: string | null,
    ): "busy" | "invalid" | "valid" => {
      const activeSavedView = savedViewEntryByItemKey.get(activeId);
      if (!activeSavedView) {
        return overId && overId !== activeId ? "valid" : "invalid";
      }
      if (pendingSavedViewPlacementItemKeys.has(activeId)) return "busy";
      if (!overId || overId === activeId) return "invalid";
      const overSectionGroupId = customGroupIdFromSectionKey(overId);
      if (overSectionGroupId) {
        return overSectionGroupId === activeSavedView.groupId
          ? "invalid"
          : "valid";
      }
      if (customEntryGroupByItemKey.has(overId)) {
        if (customEntryGroupByItemKey.get(overId) !== null) return "valid";
        if (savedViewEntryByItemKey.has(overId)) return "valid";
        const looseThreadKind = flattenThreadSectionEntries(
          organizedThreadSections,
        ).find(
          (entry) => entry.thread.threadKey === overId,
        )?.thread.kind;
        return looseThreadKind === "chat" || looseThreadKind === "issues"
          ? "valid"
          : "invalid";
      }
      return "invalid";
    };
    const announcements: Announcements = {
      onDragStart: ({ active }) => (
        `Picked up ${itemLabel(String(active.id))}.`
      ),
      onDragOver: ({ active, over }) => (
        `Moving ${itemLabel(String(active.id))} over ${destinationLabel(
          over ? String(over.id) : null,
        )}.`
      ),
      onDragEnd: ({ active, over }) => {
        const activeId = String(active.id);
        const validity = savedViewDropValidity(
          activeId,
          over ? String(over.id) : null,
        );
        if (validity === "busy") {
          return `${itemLabel(activeId)} already has a move in progress.`;
        }
        if (validity === "invalid") {
          return `Move canceled for ${itemLabel(activeId)}. That is not a valid destination.`;
        }
        const activeSavedView = savedViewEntryByItemKey.get(activeId);
        const overId = over ? String(over.id) : null;
        const looseThread = overId
          ? flattenThreadSectionEntries(organizedThreadSections)
            .find((entry) => entry.thread.threadKey === overId)
          : null;
        if (
          activeSavedView?.groupId === null
          && looseThread?.customGroupId === null
          && (
            looseThread.thread.kind === "chat"
            || looseThread.thread.kind === "issues"
          )
        ) {
          return savedViewLooseDropPlacement({
            active,
            over,
          })
            ? `Reorder requested for ${itemLabel(activeId)}.`
            : `Group requested for ${itemLabel(activeId)}.`;
        }
        return `Move requested for ${itemLabel(activeId)}. Messenger will announce when the server saves the change.`;
      },
      onDragCancel: ({ active }) => (
        `Move canceled for ${itemLabel(String(active.id))}.`
      ),
    };
    const screenReaderInstructions: ScreenReaderInstructions = {
      draggable: "Press Space to pick up a Messenger item. Use the arrow keys to choose a destination, then press Space again to reorder. Hold Shift while picking up to group with a loose Chat or Issue. Press Escape to cancel.",
    };
    return { announcements, screenReaderInstructions };
  }, [
    customEntryGroupByItemKey,
    customGroupBySectionKey,
    customGroups,
    organizedThreadSections,
    pendingSavedViewPlacementItemKeys,
    savedViewEntryByItemKey,
  ]);
  const draggingOverlayLabel = useMemo(() => {
    if (!draggingThreadId) return null;
    const savedView = savedViewEntryByItemKey.get(draggingThreadId);
    if (savedView) return savedViewDisplayTitle(savedView.savedView);
    const group = customGroupBySectionKey.get(draggingThreadId);
    if (group) return group.name;
    return flattenThreadSectionEntries(organizedThreadSections)
      .find((entry) => entry.thread.threadKey === draggingThreadId)
      ?.thread.title
      ?? "Messenger item";
  }, [
    customGroupBySectionKey,
    draggingThreadId,
    organizedThreadSections,
    savedViewEntryByItemKey,
  ]);
  const resolveCustomDragIntent = useCallback((activeId: string, overId: string | null): MessengerDragIntent => {
    if (effectiveThreadOrganizationRule !== "custom" || !overId || activeId === overId) return null;
    const activeIsEntry = customEntryGroupByItemKey.has(activeId);
    if (!activeIsEntry) {
      return customGroupIdFromSectionKey(activeId) && customGroupIdFromSectionKey(overId)
        ? "reorder-group"
        : null;
    }
    const activeGroupId = customEntryGroupByItemKey.get(activeId) ?? null;
    const overEntryGroupId = customEntryGroupByItemKey.has(overId)
      ? customEntryGroupByItemKey.get(overId) ?? null
      : undefined;
    const overGroupId = customGroupIdFromSectionKey(overId) ?? overEntryGroupId;
    if (savedViewEntryByItemKey.has(activeId) && overEntryGroupId === null) {
      return activeGroupId ? "move-out-of-group" : "reorder-entry";
    }
    if (activeGroupId && overEntryGroupId === null) return "move-out-of-group";
    if (overGroupId && activeGroupId !== overGroupId) return "move-into-group";
    if (activeGroupId && overEntryGroupId && activeGroupId === overEntryGroupId) return "reorder-entry";
    if (activeGroupId === null && overEntryGroupId === null) return "reorder-entry";
    return null;
  }, [
    customEntryGroupByItemKey,
    effectiveThreadOrganizationRule,
    savedViewEntryByItemKey,
  ]);
  const unreadThreadTargets = useMemo<UnreadThreadTarget[]>(() => {
    const targets: UnreadThreadTarget[] = [];
    const isManaged = isManagedThreadGroupRule(effectiveThreadOrganizationRule);
    const collectTargets = (sections: OrganizedThreadSection[] | undefined, ancestorPath: string[]) => {
      for (const section of sections ?? []) {
        const sectionPath = isManaged ? [...ancestorPath, section.key] : [];
        for (const [index, entry] of section.entries.entries()) {
          if (entry.thread.unreadCount > 0) {
            targets.push({
              threadKey: entry.thread.threadKey,
              groupKey: isManaged ? section.key : null,
              sectionPath,
              entryIndex: isManaged ? index : null,
            });
          }
        }
        collectTargets(section.childSections, sectionPath);
      }
    };
    collectTargets(organizedThreadSections, []);
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
  const activeSavedViewId =
    route.kind === "saved_view" ? route.savedViewId : null;
  const topLevelDirectoryItems = useMemo(() => {
    const sectionItems = organizedThreadSections.map((section) => ({
      key: section.key,
      kind: "section" as const,
      section,
    }));
    const looseSavedViewItems = looseSavedViews.map((savedView) => ({
      key: `saved-view:${savedView.id}`,
      kind: "saved-view" as const,
      savedView,
    }));
    const items = [...sectionItems, ...looseSavedViewItems];
    return effectiveThreadOrganizationRule === "custom"
      ? applyManualDirectoryOrder(items, defaultThreadOrderKeys)
      : items;
  }, [
    defaultThreadOrderKeys,
    effectiveThreadOrganizationRule,
    looseSavedViews,
    organizedThreadSections,
  ]);
  const directoryVirtualizer = useVirtualizer({
    count: topLevelDirectoryItems.length,
    getScrollElement: () => sidebarScrollElementRef.current,
    estimateSize: () => threadDensity === "compact" ? 46 : 74,
    getItemKey: (index) => topLevelDirectoryItems[index]?.key ?? index,
    overscan: draggingThreadId ? 20 : 8,
    useFlushSync: false,
  });
  const virtualDirectoryItems = directoryVirtualizer.getVirtualItems();
  const sortableThreadSectionKeys = useMemo(() => (
    topLevelDirectoryItems
      .filter((item) => item.kind === "saved-view"
        ? effectiveThreadOrganizationRule === "custom"
        : (
          (effectiveThreadOrganizationRule !== "custom" || item.section.key !== "custom:pinned")
          && (effectiveThreadOrganizationRule !== "project" || !item.section.isPinned)
        ))
      .map((item) => item.key)
  ), [effectiveThreadOrganizationRule, topLevelDirectoryItems]);
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

  const handleMessengerThreadSelect = (thread: MessengerThreadSummary) => {
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

  const beginSavedViewPlacement = useCallback((itemKey: string) => {
    if (pendingSavedViewPlacementItemKeysRef.current.has(itemKey)) return false;
    pendingSavedViewPlacementItemKeysRef.current.add(itemKey);
    setPendingSavedViewPlacementItemKeys(
      new Set(pendingSavedViewPlacementItemKeysRef.current),
    );
    return true;
  }, []);

  const finishSavedViewPlacement = useCallback((itemKey: string) => {
    pendingSavedViewPlacementItemKeysRef.current.delete(itemKey);
    setPendingSavedViewPlacementItemKeys(
      new Set(pendingSavedViewPlacementItemKeysRef.current),
    );
  }, []);

  const refreshCustomGroups = async () => {
    if (!model.selectedOrganizationId) return;
    await queryClient.invalidateQueries({ queryKey: queryKeys.messenger.customGroups(model.selectedOrganizationId) });
  };
  const refreshSavedViewPlacements = useCallback(async (organizationId: string) => {
    const offsets = new Set([
      0,
      savedViewPageOffset,
      ...Object.keys(loadedSavedViewPages).map(Number),
    ]);
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.messenger.customGroups(organizationId),
      }),
      ...Array.from(offsets).map((offset) => queryClient.invalidateQueries({
        queryKey: queryKeys.messenger.savedViews(
          organizationId,
          "visible",
          MESSENGER_SAVED_VIEW_PAGE_LIMIT,
          offset,
        ),
      })),
    ]);
    if (currentOrganizationIdRef.current === organizationId) {
      setLoadedSavedViewPages({});
      setSavedViewPageOffset(0);
    }
  }, [loadedSavedViewPages, queryClient, savedViewPageOffset]);

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
    onSuccess: async () => {
      if (model.selectedOrganizationId) {
        await refreshSavedViewPlacements(model.selectedOrganizationId);
      }
    },
    onError: (error) => {
      pushToast({
        title: "Could not separate Messenger group",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      });
    },
  });

  const reorderCustomGroupsMutation = useMutation({
    mutationFn: (groupIds: string[]) => {
      if (!model.selectedOrganizationId) throw new Error("Organization is required to reorder Messenger groups");
      return messengerApi.reorderCustomGroups(model.selectedOrganizationId, groupIds);
    },
    onSuccess: refreshCustomGroups,
  });

  const reorderCustomGroupEntriesMutation = useMutation({
    mutationFn: ({ groupId, itemKeys }: { groupId: string; itemKeys: string[] }) => {
      if (!model.selectedOrganizationId) throw new Error("Organization is required to reorder Messenger group entries");
      return messengerApi.reorderCustomGroupEntries(model.selectedOrganizationId, groupId, itemKeys);
    },
    onSuccess: refreshCustomGroups,
  });

  const reorderSavedViewMutation = useMutation({
    mutationFn: ({
      groupId,
      itemKey: _itemKey,
      itemKeys,
      organizationId,
    }: {
      groupId: string;
      itemKey: string;
      itemKeys: string[];
      organizationId: string;
    }) => {
      return messengerApi.reorderCustomGroupEntries(
        organizationId,
        groupId,
        itemKeys,
      );
    },
    onSuccess: async (_data, { organizationId }) => {
      await refreshSavedViewPlacements(organizationId);
      pushToast({
        title: "Saved View moved",
        body: "The Messenger group order was updated.",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Could not move Saved View",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      });
    },
    onSettled: (_data, _error, { itemKey }) => {
      finishSavedViewPlacement(itemKey);
    },
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

  const moveSavedViewMutation = useMutation({
    mutationFn: ({
      groupId,
      itemKey,
      organizationId,
    }: {
      groupId: string;
      itemKey: string;
      organizationId: string;
    }) => {
      return messengerApi.assignCustomGroupEntry(
        organizationId,
        groupId,
        itemKey,
      );
    },
    onSuccess: async (_data, { organizationId }) => {
      await refreshSavedViewPlacements(organizationId);
      pushToast({
        title: "Saved View moved",
        body: "The Messenger group was updated.",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Could not move Saved View",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      });
    },
    onSettled: (_data, _error, { itemKey }) => {
      finishSavedViewPlacement(itemKey);
    },
  });
  const requestMoveSavedView = useCallback((
    groupId: string,
    itemKey: string,
  ) => {
    const organizationId = model.selectedOrganizationId;
    if (!organizationId || !beginSavedViewPlacement(itemKey)) return;
    moveSavedViewMutation.mutate({
      groupId,
      itemKey,
      organizationId,
    });
  }, [
    beginSavedViewPlacement,
    model.selectedOrganizationId,
    moveSavedViewMutation,
  ]);

  const releaseSavedViewMutation = useMutation({
    mutationFn: ({
      itemKey,
      organizationId,
      nextOrderKeys: _nextOrderKeys,
      orderStorageKey: _orderStorageKey,
    }: {
      itemKey: string;
      organizationId: string;
      nextOrderKeys?: string[];
      orderStorageKey?: string | null;
    }) => messengerApi.removeCustomGroupEntry(organizationId, itemKey),
    onSuccess: async (_data, {
      nextOrderKeys,
      orderStorageKey,
      organizationId,
    }) => {
      await refreshSavedViewPlacements(organizationId);
      if (
        nextOrderKeys
        && orderStorageKey
        && currentOrganizationIdRef.current === organizationId
      ) {
        setDefaultThreadOrderKeys(nextOrderKeys);
        writeStringList(orderStorageKey, nextOrderKeys);
      }
      pushToast({
        title: "Saved View moved",
        body: "The Saved View is now in the Messenger sidebar.",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Could not move Saved View",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      });
    },
    onSettled: (_data, _error, { itemKey }) => {
      finishSavedViewPlacement(itemKey);
    },
  });
  const requestReleaseSavedView = useCallback((itemKey: string) => {
    const organizationId = model.selectedOrganizationId;
    if (!organizationId || !beginSavedViewPlacement(itemKey)) return;
    releaseSavedViewMutation.mutate({ itemKey, organizationId });
  }, [
    beginSavedViewPlacement,
    model.selectedOrganizationId,
    releaseSavedViewMutation,
  ]);

  const createGroupForSavedViewMutation = useMutation({
    mutationFn: ({
      anchorItemKey,
      itemKeys,
      name,
      organizationId,
      savedViewItemKey: _savedViewItemKey,
    }: {
      anchorItemKey: string;
      itemKeys: string[];
      name: string;
      organizationId: string;
      savedViewItemKey: string;
    }) => {
      return messengerApi.createCustomGroupWithEntries(
        organizationId,
        {
          anchorItemKey,
          autoGenerateName: false,
          itemKeys,
          name,
        },
      );
    },
    onSuccess: async (_data, { organizationId }) => {
      writeThreadOrganizationRule(organizationId, "latest");
      if (currentOrganizationIdRef.current === organizationId) {
        setThreadOrganizationRule("latest");
      }
      await refreshSavedViewPlacements(organizationId);
      pushToast({
        title: "Saved View grouped",
        body: "Created or reused the Chat or Issue group.",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Could not group Saved View",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      });
    },
    onSettled: (_data, _error, { savedViewItemKey }) => {
      finishSavedViewPlacement(savedViewItemKey);
    },
  });

  const rememberAdjacentSavedViewFocus = useCallback((savedViewId: string) => {
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>(
        "[data-messenger-thread-key],[data-messenger-saved-view-id]",
      ),
    );
    const currentIndex = rows.findIndex(
      (row) => row.dataset.messengerSavedViewId === savedViewId,
    );
    if (currentIndex === -1) return null;
    const adjacent = rows[currentIndex + 1] ?? rows[currentIndex - 1] ?? null;
    return adjacent
      ? messengerSidebarEntryItemKey(adjacent)
      : null;
  }, []);

  const completeSavedViewRemoval = useCallback(async ({
    focusItemKey,
    organizationId,
    savedViewId,
  }: {
    focusItemKey: string | null;
    organizationId: string;
    savedViewId: string;
  }) => {
    savedViewPromotion?.finalizeSavedViewRemoval(
      organizationId,
      savedViewId,
    );
    const organizationState =
      mainWorkbench.getState().organizations[organizationId];
    for (const tab of Object.values(
      organizationState?.tabsByViewInstanceId ?? {},
    )) {
      if (tab.savedViewId !== savedViewId) continue;
      mainWorkbench.unbindSavedViewForOrganization(
        organizationId,
        tab.viewInstanceId,
        savedViewId,
      );
    }
    if (
      currentOrganizationIdRef.current === organizationId
      && relativePathRef.current === messengerSavedViewRoute(savedViewId)
    ) {
      navigate("/messenger/workbench", { replace: true });
    }
    removeMessengerSavedViewFromCustomGroupsCache(
      queryClient,
      organizationId,
      savedViewId,
    );
    await refreshSavedViewPlacements(organizationId);
    await queryClient.invalidateQueries({
      queryKey: queryKeys.messenger.primaryRailPins(organizationId),
    });
    if (
      focusItemKey
      && currentOrganizationIdRef.current === organizationId
    ) {
      const adjacentRow = Array.from(
        document.querySelectorAll<HTMLElement>(
          "[data-messenger-thread-key],[data-messenger-saved-view-id]",
        ),
      ).find(
        (row) => messengerSidebarEntryItemKey(row) === focusItemKey,
      );
      (
        adjacentRow?.querySelector<HTMLElement>("a[href]")
        ?? adjacentRow?.querySelector<HTMLElement>("button,[tabindex]")
        ?? adjacentRow
      )?.focus();
    }
    pushToast({
      title: "Removed from Messenger",
      body: "The open Main tab remains available for this session.",
      tone: "success",
    });
  }, [
    mainWorkbench,
    navigate,
    pushToast,
    queryClient,
    refreshSavedViewPlacements,
    savedViewPromotion,
  ]);

  const removeSavedViewMutation = useMutation({
    mutationFn: async ({
      organizationId,
      savedViewId,
      focusItemKey,
    }: {
      organizationId: string;
      savedViewId: string;
      focusItemKey: string | null;
    }) => {
      await messengerApi.deleteSavedView(organizationId, savedViewId);
      return { focusItemKey, organizationId, savedViewId };
    },
    onMutate: ({ organizationId, savedViewId }) => {
      savedViewPromotion?.setSavedViewRemovalPending(
        organizationId,
        savedViewId,
        true,
      );
    },
    onSuccess: completeSavedViewRemoval,
    onError: async (
      error,
      { focusItemKey, organizationId, savedViewId },
    ) => {
      let removed = error instanceof ApiError && error.status === 404;
      let confirmedPresent = false;
      if (!removed) {
        try {
          await messengerApi.getSavedView(organizationId, savedViewId);
          confirmedPresent = true;
        } catch (reconcileError) {
          removed = reconcileError instanceof ApiError
            && reconcileError.status === 404;
        }
      }
      if (removed) {
        await completeSavedViewRemoval({
          focusItemKey,
          organizationId,
          savedViewId,
        });
        return;
      }
      if (confirmedPresent) {
        savedViewPromotion?.setSavedViewRemovalPending(
          organizationId,
          savedViewId,
          false,
        );
      }
      pushToast({
        title: confirmedPresent
          ? "Could not remove Saved View"
          : "Could not confirm Saved View removal",
        body: confirmedPresent
          ? error instanceof Error ? error.message : "Try again."
          : "The move remains paused. Retry Remove to reconcile it.",
        tone: "error",
      });
    },
  });
  const requestRemoveSavedView = useCallback((savedViewId: string) => {
    const organizationId = model.selectedOrganizationId;
    if (!organizationId) return;
    removeSavedViewMutation.mutate({
      focusItemKey: rememberAdjacentSavedViewFocus(savedViewId),
      organizationId,
      savedViewId,
    });
  }, [
    model.selectedOrganizationId,
    rememberAdjacentSavedViewFocus,
    removeSavedViewMutation,
  ]);

  const handleThreadSectionDragOver = useCallback((event: DragOverEvent) => {
    const overId = event.over ? String(event.over.id) : null;
    updateDragOverId(overId);
    const activeId = String(event.active.id);
    let nextIntent = resolveCustomDragIntent(activeId, overId);
    const activeSavedView = savedViewEntryByItemKey.get(activeId);
    const looseThread = overId
      ? flattenThreadSectionEntries(organizedThreadSections)
        .find((entry) => entry.thread.threadKey === overId)
      : null;
    if (
      activeSavedView?.groupId === null
      && looseThread?.customGroupId === null
      && (
        looseThread.thread.kind === "chat"
        || looseThread.thread.kind === "issues"
      )
    ) {
      nextIntent = savedViewLooseDropPlacement(event)
        ? "reorder-entry"
        : "move-into-group";
    }
    updateDragIntent(nextIntent);

    if (nextIntent !== "move-into-group" || !overId || effectiveThreadOrganizationRule !== "custom") {
      clearCollapsedGroupOpenTimer();
      return;
    }

    const overGroupId = customGroupIdFromSectionKey(overId)
      ?? customEntryGroupByItemKey.get(overId)
      ?? null;
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
  }, [clearCollapsedGroupOpenTimer, customEntryGroupByItemKey, customGroups, effectiveThreadOrganizationRule, organizedThreadSections, resolveCustomDragIntent, savedViewEntryByItemKey, updateCustomGroupMutation, updateDragIntent, updateDragOverId]);

  const handleThreadGroupToggle = (groupKey: string) => {
    const group = customGroupBySectionKey.get(groupKey);
    if (group) {
      updateCustomGroupMutation.mutate({ groupId: group.id, data: { collapsed: !group.collapsed } });
      return;
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
    const dragOrganizationId = model.selectedOrganizationId;
    if (!dragOrganizationId) return;

    if (effectiveThreadOrganizationRule === "custom") {
      const activeThreadKey = String(active.id);
      const overThreadKey = String(over.id);
      const activeSavedView = savedViewEntryByItemKey.get(activeThreadKey) ?? null;
      if (activeSavedView) {
        const topLevelKeys = topLevelDirectoryItems
          .filter((item) => item.key !== "custom:pinned")
          .map((item) => item.key);
        const nextSavedViewTopLevelOrder = (
          placement: Exclude<MessengerInsertionPlacement, null>,
        ) => {
          if (!defaultThreadOrderStorageKey) return null;
          const keysWithActive = topLevelKeys.includes(activeThreadKey)
            ? topLevelKeys
            : [...topLevelKeys, activeThreadKey];
          const oldIndex = keysWithActive.indexOf(activeThreadKey);
          const keysWithoutActive = keysWithActive.filter(
            (key) => key !== activeThreadKey,
          );
          const overIndex = keysWithoutActive.indexOf(overThreadKey);
          if (oldIndex === -1 || overIndex === -1) return null;
          const newIndex = Math.min(
            keysWithActive.length - 1,
            overIndex + (placement === "after" ? 1 : 0),
          );
          return nextDefaultThreadOrderKeysAfterMove(
            keysWithActive,
            defaultThreadOrderKeys,
            oldIndex,
            newIndex,
          );
        };
        const persistSavedViewTopLevelOrder = (nextOrderKeys: string[] | null) => {
          if (!defaultThreadOrderStorageKey || !nextOrderKeys) return;
          setDefaultThreadOrderKeys(nextOrderKeys);
          writeStringList(defaultThreadOrderStorageKey, nextOrderKeys);
        };
        const overSectionGroupId = customGroupIdFromSectionKey(overThreadKey);
        const overHasEntryGroup = customEntryGroupByItemKey.has(overThreadKey);
        const overEntryGroupId = overHasEntryGroup
          ? customEntryGroupByItemKey.get(overThreadKey) ?? null
          : undefined;
        const overGroupId = overSectionGroupId ?? overEntryGroupId;

        if (
          overEntryGroupId === null
          && customEntryGroupByThreadKey.has(overThreadKey)
        ) {
          const looseThread = flattenThreadSectionEntries(
            organizedThreadSections,
          ).find((entry) => entry.thread.threadKey === overThreadKey);
          const loosePlacement = savedViewLooseDropPlacement(event);
          if (
            looseThread
            && (
              looseThread.thread.kind === "chat"
              || looseThread.thread.kind === "issues"
            )
            && loosePlacement === null
            && beginSavedViewPlacement(activeThreadKey)
          ) {
            createGroupForSavedViewMutation.mutate({
              anchorItemKey: overThreadKey,
              itemKeys: [overThreadKey, activeThreadKey],
              name: looseThread.thread.title.trim() || "New group",
              organizationId: dragOrganizationId,
              savedViewItemKey: activeThreadKey,
            });
            return;
          }
          if (!looseThread || loosePlacement === null) return;
        }

        if (
          overGroupId
          && overGroupId !== activeSavedView.groupId
          && beginSavedViewPlacement(activeThreadKey)
        ) {
          moveSavedViewMutation.mutate({
            groupId: overGroupId,
            itemKey: activeThreadKey,
            organizationId: dragOrganizationId,
          });
          return;
        }

        if (overGroupId && overGroupId === activeSavedView.groupId) {
          const group = customGroups.find(
            (candidate) => candidate.id === activeSavedView.groupId,
          );
          const itemKeys = group?.entries
            .slice()
            .sort((left, right) => left.sortOrder - right.sortOrder)
            .map(customGroupEntryItemKey) ?? [];
          const oldIndex = itemKeys.indexOf(activeThreadKey);
          const newIndex = itemKeys.indexOf(overThreadKey);
          if (
            oldIndex !== -1
            && newIndex !== -1
            && oldIndex !== newIndex
            && beginSavedViewPlacement(activeThreadKey)
          ) {
            reorderSavedViewMutation.mutate({
              groupId: activeSavedView.groupId,
              itemKey: activeThreadKey,
              itemKeys: arrayMove(itemKeys, oldIndex, newIndex),
              organizationId: dragOrganizationId,
            });
          }
          return;
        }
        if (overEntryGroupId === null) {
          const measuredPlacement = savedViewLooseDropPlacement(event);
          const activeIndex = topLevelKeys.indexOf(activeThreadKey);
          const overIndex = topLevelKeys.indexOf(overThreadKey);
          const placement = measuredPlacement
            ?? (
              activeSavedView.groupId
                ? "after"
                : activeIndex < overIndex ? "after" : "before"
            );
          const nextOrderKeys = nextSavedViewTopLevelOrder(placement);
          if (
            activeSavedView.groupId
            && beginSavedViewPlacement(activeThreadKey)
          ) {
            releaseSavedViewMutation.mutate({
              itemKey: activeThreadKey,
              nextOrderKeys: nextOrderKeys ?? undefined,
              orderStorageKey: defaultThreadOrderStorageKey,
              organizationId: dragOrganizationId,
            });
          } else if (!activeSavedView.groupId) {
            persistSavedViewTopLevelOrder(nextOrderKeys);
          }
        }
        return;
      }
      const topLevelSectionKeys = topLevelDirectoryItems
        .filter((item) => item.key !== "custom:pinned")
        .map((item) => item.key);
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
        const group = customGroups.find((candidate) => candidate.id === activeGroupId);
        const itemKeys = group?.entries
          .slice()
          .sort((left, right) => left.sortOrder - right.sortOrder)
          .map(customGroupEntryItemKey) ?? [];
        const oldIndex = itemKeys.indexOf(activeThreadKey);
        const newIndex = itemKeys.indexOf(overThreadKey);
        if (oldIndex !== -1 && newIndex !== -1) {
          reorderCustomGroupEntriesMutation.mutate({
            groupId: activeGroupId,
            itemKeys: arrayMove(itemKeys, oldIndex, newIndex),
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
  }, [assignCustomGroupEntryMutation, beginSavedViewPlacement, createGroupForSavedViewMutation, customEntryGroupByItemKey, customEntryGroupByThreadKey, customGroups, defaultThreadOrderKeys, defaultThreadOrderStorageKey, effectiveThreadOrganizationRule, messengerThreadGroupOrderStorageKey, model.selectedOrganizationId, moveSavedViewMutation, organizedThreadSections, projectOrderIds, projectOrderStorageKey, releaseSavedViewMutation, removeCustomGroupEntryMutation, reorderCustomGroupEntriesMutation, reorderCustomGroupsMutation, reorderSavedViewMutation, resetThreadDragState, savedViewEntryByItemKey, topLevelDirectoryItems]);

  const handleShowMoreThreadSection = (section: OrganizedThreadSection, visibleCount: number) => {
    if (visibleCount < section.entries.length) {
      setVisibleThreadGroupEntryLimits((current) => ({
        ...current,
        [section.key]: Math.min(section.entries.length, visibleCount + MANAGED_GROUP_VISIBLE_INCREMENT),
      }));
      return;
    }
    if (customGroupBySectionKey.has(section.key)) return;
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

  const handleLoadMoreSavedViews = () => {
    const page = savedViewsQuery.data;
    const nextOffset = page?.pageInfo.nextOffset;
    if (!page?.pageInfo.hasMore || nextOffset === null || nextOffset === undefined) return;
    setLoadedSavedViewPages((current) => ({
      ...current,
      [page.pageInfo.offset]: page.items,
    }));
    setSavedViewPageOffset(nextOffset);
  };

  const handleHideIssueThread = (thread: MessengerThreadSummary) => {
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

  const renderLooseSavedView = (
    savedView: MessengerSavedView,
    dragHandleProps?: SortableDragHandleProps,
    dragging = false,
  ) => {
    const itemKey = `saved-view:${savedView.id}`;
    return (
      <MessengerSavedViewRow
        active={activeSavedViewId === savedView.id}
        currentGroupId={null}
        density={threadDensity}
        dragHandleProps={dragHandleProps}
        dragging={dragging}
        itemKey={itemKey}
        savedView={savedView}
        groups={customGroups}
        onMove={requestMoveSavedView}
        onRemove={requestRemoveSavedView}
        placementPending={pendingSavedViewPlacementItemKeys.has(itemKey)}
      />
    );
  };

  const renderThreadSection = (
    section: OrganizedThreadSection,
    dragHandleProps?: SortableDragHandleProps,
    draggingSection = false,
  ) => {
    const isManagedSection = isManagedThreadGroupRule(effectiveThreadOrganizationRule);
    const sectionAgentId = effectiveThreadOrganizationRule === "agent"
      && section.key.startsWith("agent:")
      ? section.key.slice("agent:".length)
      : null;
    const sectionAgent = sectionAgentId ? agentsById.get(sectionAgentId) ?? null : null;
    const customGroup = customGroupBySectionKey.get(section.key) ?? null;
    const customGroupTitleGenerating = Boolean(customGroup && generatingGroupTitleIds.has(customGroup.id));
    const displayedCustomGroup = customGroup;
    const collapsed = customGroup ? customGroup.collapsed : isManagedSection && collapsedThreadGroupKeys.has(section.key);
    const draggingEntryGroupId = draggingThreadId
      ? customEntryGroupByItemKey.get(draggingThreadId)
      : undefined;
    const dragOverThisSection = dragOverId === section.key
      || section.entries.some((entry) => entry.thread.threadKey === dragOverId)
      || Boolean(customGroup?.entries.some(
        (entry) => customGroupEntryItemKey(entry) === dragOverId,
      ));
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
      && !customGroup
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
      && (customGroup ? customGroup.entries.length > 0 : visibleEntries.length > 0);
    const canDragStandaloneCustomEntry = effectiveThreadOrganizationRule === "custom"
      && !customGroup
      && (section.label === null || isPinnedCustomSection)
      && visibleEntries.length === 1;
    const childSectionKeys = effectiveThreadOrganizationRule === "custom"
      ? section.childSections
        ?.filter((childSection) => Boolean(customGroupIdFromSectionKey(childSection.key)))
        .map((childSection) => childSection.key) ?? []
      : [];
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
    const visibleEntryByThreadKey = new Map(
      visibleEntries.map((entry) => [entry.thread.threadKey, entry]),
    );
    const renderVisibleThreadEntry = (entry: OrganizedThreadEntry) => canSortCustomEntries ? (
      <SortableCustomThreadEntry
        key={entry.thread.threadKey}
        id={entry.thread.threadKey}
        insertionPlacement={resolveEntryInsertionPlacement(entry.thread.threadKey)}
      >
        {(dragHandlePropsForEntry, dragging) => renderThreadEntry(entry, dragHandlePropsForEntry, dragging)}
      </SortableCustomThreadEntry>
    ) : (
      <div key={entry.thread.threadKey} className="relative">
        <MessengerInsertionLine placement={resolveEntryInsertionPlacement(entry.thread.threadKey)} />
        {renderThreadEntry(entry, canDragStandaloneCustomEntry ? dragHandleProps : undefined)}
      </div>
    );
    const orderedCustomEntries = customGroup?.entries
      .slice()
      .sort((left, right) => left.sortOrder - right.sortOrder) ?? [];
    const renderedEntryNodes = customGroup
      ? orderedCustomEntries.map((entry) => {
        if (isSavedViewCustomGroupEntry(entry)) {
          const itemKey = customGroupEntryItemKey(entry);
          const placementPending =
            pendingSavedViewPlacementItemKeys.has(itemKey);
          const row = (
            <MessengerSavedViewRow
              active={activeSavedViewId === entry.item.savedView.id}
              currentGroupId={customGroup.id}
              density={threadDensity}
              entry={entry}
              groups={customGroups}
              onMove={requestMoveSavedView}
              onMoveOutOfGroup={requestReleaseSavedView}
              onRemove={requestRemoveSavedView}
              placementPending={placementPending}
            />
          );
          return canSortCustomEntries ? (
            <SortableCustomThreadEntry
              key={itemKey}
              id={itemKey}
              disabled={placementPending}
            >
              {(savedDragHandleProps, dragging) => (
                <MessengerSavedViewRow
                  active={activeSavedViewId === entry.item.savedView.id}
                  currentGroupId={customGroup.id}
                  density={threadDensity}
                  dragHandleProps={savedDragHandleProps}
                  dragging={dragging}
                  entry={entry}
                  groups={customGroups}
                  onMove={requestMoveSavedView}
                  onMoveOutOfGroup={requestReleaseSavedView}
                  onRemove={requestRemoveSavedView}
                  placementPending={placementPending}
                />
              )}
            </SortableCustomThreadEntry>
          ) : <div key={itemKey}>{row}</div>;
        }
        const visibleEntry = visibleEntryByThreadKey.get(entry.threadKey);
        return visibleEntry ? renderVisibleThreadEntry(visibleEntry) : null;
      })
      : visibleEntries.map(renderVisibleThreadEntry);
    const renderedEntryKeys = customGroup
      ? orderedCustomEntries.map(customGroupEntryItemKey)
      : visibleEntries.map((entry) => entry.thread.threadKey);
    const renderedEntryItems = renderedEntryNodes.flatMap((node, index) => (
      node === null || node === undefined
        ? []
        : [{
          key: renderedEntryKeys[index] ?? `${section.key}:${index}`,
          node,
        }]
    ));
    const unreadTargetKey = unreadScrollTarget?.sectionPath.includes(section.key)
      ? unreadScrollTarget.threadKey
      : null;
    const renderedEntryContent = renderedEntryItems.length > 30 ? (
      <VirtualizedActivityTimeline
        items={renderedEntryItems}
        getItemKey={(item) => item.key}
        estimateSize={() => threadDensity === "compact" ? 34 : 42}
        itemGap={4}
        overscan={draggingThreadId ? 20 : 8}
        scrollElementRef={sidebarScrollElementRef}
        targetKey={unreadTargetKey}
        onTargetMounted={(targetKey) => {
          if (
            !unreadScrollTarget
            || targetKey !== unreadScrollTarget.threadKey
            || unreadScrollRequestId <= 0
          ) return;
          const row = Array.from(
            sidebarScrollElementRef.current?.querySelectorAll<HTMLElement>("[data-messenger-thread-key]") ?? [],
          ).find((candidate) => candidate.dataset.messengerThreadKey === targetKey);
          if (!row) return;
          row.scrollIntoView({ block: "nearest", behavior: "smooth" });
          unreadScrollCursorRef.current = targetKey;
          handledUnreadScrollRequestIdRef.current = unreadScrollRequestId;
          markMessengerUnreadScrollRequestHandled(unreadScrollRequestId);
          unreadLoadMoreRequestRef.current = null;
        }}
        testId={`messenger-section-virtual-entries-${sanitizeThreadKey(section.key)}`}
      >
        {(item) => item.node}
      </VirtualizedActivityTimeline>
    ) : renderedEntryItems.map((item) => (
      <div key={item.key}>{item.node}</div>
    ));
    const renderedEntries = canSortCustomEntries ? (
      <SortableContext
        items={customGroup
          ? orderedCustomEntries.map(customGroupEntryItemKey)
          : visibleEntries.map((entry) => entry.thread.threadKey)}
        strategy={verticalListSortingStrategy}
      >
        {renderedEntryContent}
      </SortableContext>
    ) : renderedEntryContent;
    const sectionBody = (
      <>
        {renderedChildSections}
        <div className="flex flex-col gap-1">
          {renderedEntries}
        </div>
        {showMoreControl || showCollapseControl ? (
          <div className="mx-1.5 flex items-center gap-1.5 px-2 py-1">
            {showMoreControl ? (
              <MessengerSectionAutoLoader
                testId={`messenger-thread-section-${sanitizeThreadKey(section.key)}-auto-loader`}
                loading={Boolean(model.isFetchingMoreThreadSummaries && canFetchMoreForSection)}
                onVisible={() => handleShowMoreThreadSection(section, visibleCount)}
              />
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
          data-collapsed={collapsed ? "true" : "false"}
          data-drag-move-target={isMoveIntoGroupTarget ? "true" : undefined}
          data-drag-intent={isMoveIntoGroupTarget ? "move-into-group" : undefined}
          className={cn(
            "group/custom-group relative mx-0.5 rounded-[calc(var(--radius-md)-1px)] border p-1 text-[color:var(--messenger-group-text)] transition-[background-color,border-color,box-shadow] duration-150 dark:text-[color:var(--messenger-group-text-dark)]",
            collapsed && !isMoveIntoGroupTarget
              ? "border-transparent bg-transparent shadow-none hover:border-[color:var(--messenger-group-border)] hover:bg-[color:var(--messenger-group-bg-hover)] has-[:focus-visible]:border-[color:var(--messenger-group-border)] has-[:focus-visible]:bg-[color:var(--messenger-group-bg-hover)] dark:border-transparent dark:bg-transparent dark:hover:border-[color:var(--messenger-group-border-dark)] dark:hover:bg-[color:var(--messenger-group-bg-hover-dark)] dark:has-[:focus-visible]:border-[color:var(--messenger-group-border-dark)] dark:has-[:focus-visible]:bg-[color:var(--messenger-group-bg-hover-dark)]"
              : "border-[color:var(--messenger-group-border)] bg-[color:var(--messenger-group-bg)] shadow-[0_8px_20px_-18px_rgba(15,23,42,0.45)] hover:bg-[color:var(--messenger-group-bg-hover)] dark:border-[color:var(--messenger-group-border-dark)] dark:bg-[color:var(--messenger-group-bg-dark)] dark:hover:bg-[color:var(--messenger-group-bg-hover-dark)]",
            isMoveIntoGroupTarget && "ring-2 ring-[color:color-mix(in_oklab,var(--messenger-group-text)_34%,transparent)]",
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
              <CustomGroupIcon
                icon={displayedCustomGroup.icon}
                color={customGroupColorFor(displayedCustomGroup)}
              />
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
                <DropdownMenuItem
                  onClick={() => void handleSeparateCustomGroup(customGroup)}
                >
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
                {sectionAgent ? (
                  <span
                    data-testid={`messenger-thread-section-${sanitizeThreadKey(section.key)}-agent-avatar`}
                    aria-hidden="true"
                    className="flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[color:color-mix(in_oklab,var(--border-soft)_86%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-active)_78%,transparent)]"
                  >
                    <AgentIcon
                      icon={sectionAgent?.icon}
                      role={sectionAgent?.role}
                      fallbackSeed={sectionAgent.id}
                      className="h-full w-full rounded-full"
                    />
                  </span>
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

  const renderManagedDirectoryItem = (item: (typeof topLevelDirectoryItems)[number]) => {
    if (item.kind === "saved-view") {
      return sortableThreadSectionKeys.includes(item.key) ? (
        <SortableCustomThreadEntry
          id={item.key}
          disabled={pendingSavedViewPlacementItemKeys.has(item.key)}
        >
          {(dragHandleProps, dragging) => (
            renderLooseSavedView(item.savedView, dragHandleProps, dragging)
          )}
        </SortableCustomThreadEntry>
      ) : renderLooseSavedView(item.savedView);
    }
    return sortableThreadSectionKeys.includes(item.key) ? (
      <SortableThreadSection id={item.key}>
        {(dragHandleProps, draggingSection) => renderThreadSection(item.section, dragHandleProps, draggingSection)}
      </SortableThreadSection>
    ) : (
      <div className="flex shrink-0 flex-col gap-1">
        {renderThreadSection(item.section)}
      </div>
    );
  };

  const renderPlainDirectoryItem = (item: (typeof topLevelDirectoryItems)[number]) => (
    item.kind === "saved-view" ? (
      renderLooseSavedView(item.savedView)
    ) : (
      <div className="flex shrink-0 flex-col gap-1">
        {renderThreadSection(item.section)}
      </div>
    )
  );

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

    const collapsedLocalSectionKeys = unreadScrollTarget.sectionPath.filter((sectionKey) => (
      collapsedThreadGroupKeys.has(sectionKey)
    ));
    if (collapsedLocalSectionKeys.length > 0) {
      setCollapsedThreadGroupKeys((current) => {
        if (!collapsedLocalSectionKeys.some((sectionKey) => current.has(sectionKey))) return current;
        const next = new Set(current);
        for (const sectionKey of collapsedLocalSectionKeys) next.delete(sectionKey);
        if (model.selectedOrganizationId && isManagedThreadGroupRule(effectiveThreadOrganizationRule)) {
          writeCollapsedThreadGroups(model.selectedOrganizationId, effectiveThreadOrganizationRule, next);
        }
        return next;
      });
      return;
    }

    const collapsedCustomGroup = unreadScrollTarget.sectionPath
      .map((sectionKey) => customGroupBySectionKey.get(sectionKey) ?? null)
      .find((group) => group?.collapsed) ?? null;
    if (collapsedCustomGroup) {
      if (
        unreadCustomGroupExpansionRequestIdsRef.current.get(collapsedCustomGroup.id)
        !== unreadScrollRequestId
      ) {
        unreadCustomGroupExpansionRequestIdsRef.current.set(
          collapsedCustomGroup.id,
          unreadScrollRequestId,
        );
        updateCustomGroupMutation.mutate({
          groupId: collapsedCustomGroup.id,
          data: { collapsed: false },
        });
      }
      return;
    }
    for (const sectionKey of unreadScrollTarget.sectionPath) {
      const customGroupId = customGroupIdFromSectionKey(sectionKey);
      if (customGroupId) unreadCustomGroupExpansionRequestIdsRef.current.delete(customGroupId);
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

    const topLevelSectionKey = unreadScrollTarget.sectionPath[0] ?? null;
    if (topLevelSectionKey) {
      const sectionIndex = topLevelDirectoryItems.findIndex((item) => item.key === topLevelSectionKey);
      if (sectionIndex !== -1) {
        directoryVirtualizer.scrollToIndex(sectionIndex, { align: "center" });
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
  }, [collapsedThreadGroupKeys, customGroupBySectionKey, directoryVirtualizer, effectiveThreadOrganizationRule, model.selectedOrganizationId, topLevelDirectoryItems, unreadScrollRequestId, unreadScrollTarget, updateCustomGroupMutation, visibleThreadGroupEntryLimits]);

  useEffect(() => {
    const sentinel = loadMoreThreadSummariesRef.current;
    const root = sidebarScrollElementRef.current;
    if (!sentinel || !root) return;
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
              accessibility={messengerDndAccessibility}
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
                {performanceBaselineMode ? (
                  <div data-testid="messenger-directory-baseline" className="flex flex-col gap-1">
                    {topLevelDirectoryItems.map((item) => (
                      <div key={item.key}>{renderManagedDirectoryItem(item)}</div>
                    ))}
                  </div>
                ) : (
                  <div
                  data-testid="messenger-virtual-directory"
                  style={{
                    height: `${directoryVirtualizer.getTotalSize()}px`,
                    position: "relative",
                    width: "100%",
                  }}
                >
                  {virtualDirectoryItems.map((virtualItem) => {
                    const item = topLevelDirectoryItems[virtualItem.index];
                    if (!item) return null;
                    return (
                      <div
                        key={item.key}
                        ref={directoryVirtualizer.measureElement}
                        data-index={virtualItem.index}
                        style={{
                          left: 0,
                          position: "absolute",
                          top: 0,
                          transform: `translateY(${virtualItem.start}px)`,
                          width: "100%",
                        }}
                      >
                        {renderManagedDirectoryItem(item)}
                      </div>
                    );
                  })}
                  </div>
                )}
              </SortableContext>
              <DragOverlay dropAnimation={null}>
                {draggingOverlayLabel ? (
                  <div
                    data-testid="messenger-drag-overlay"
                    className="surface-overlay max-w-[18rem] rounded-[var(--radius-md)] border border-[color:var(--border-strong)] px-3 py-2 text-sm font-medium text-foreground shadow-[var(--shadow-lg)]"
                  >
                    <span className="block truncate">{draggingOverlayLabel}</span>
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          </>
        ) : (
          performanceBaselineMode ? (
            <div data-testid="messenger-directory-baseline" className="flex flex-col gap-1">
              {topLevelDirectoryItems.map((item) => (
                <div key={item.key}>{renderPlainDirectoryItem(item)}</div>
              ))}
            </div>
          ) : (
            <div
            data-testid="messenger-virtual-directory"
            style={{
              height: `${directoryVirtualizer.getTotalSize()}px`,
              position: "relative",
              width: "100%",
            }}
          >
            {virtualDirectoryItems.map((virtualItem) => {
              const item = topLevelDirectoryItems[virtualItem.index];
              if (!item) return null;
              return (
                <div
                  key={item.key}
                  ref={directoryVirtualizer.measureElement}
                  data-index={virtualItem.index}
                  style={{
                    left: 0,
                    position: "absolute",
                    top: 0,
                    transform: `translateY(${virtualItem.start}px)`,
                    width: "100%",
                  }}
                >
                  {renderPlainDirectoryItem(item)}
                </div>
              );
            })}
            </div>
          )
        )}
        {savedViewsQuery.data?.pageInfo?.hasMore ? (
          <div className="flex min-h-9 items-center justify-center px-3 py-1">
            <button
              type="button"
              data-testid="messenger-saved-view-page-load-more"
              className="inline-flex h-7 items-center rounded-[calc(var(--radius-sm)-1px)] px-2 text-[11px] font-medium text-muted-foreground transition-[background-color,color] hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={savedViewsQuery.isFetching}
              onClick={handleLoadMoreSavedViews}
            >
              {savedViewsQuery.isFetching ? "Loading Saved Views" : "Load more Saved Views"}
            </button>
          </div>
        ) : null}
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
            ) : null}
          </div>
        ) : null}
      </nav>
      <MessengerDiscordCta />
    </aside>
  );
}
