import { agentsApi } from "@/api/agents";
import { authApi } from "@/api/auth";
import { chatsApi } from "@/api/chats";
import { ApiError } from "@/api/client";
import { messengerApi } from "@/api/messenger";
import { organizationsApi } from "@/api/orgs";
import { AgentIcon } from "@/components/AgentAvatar";
import { StatusIcon } from "@/components/StatusIcon";
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
import { useChatGenerations } from "@/context/ChatGenerationContext";
import { useDialog } from "@/context/DialogContext";
import { useOrganization } from "@/context/OrganizationContext";
import { useSidebar } from "@/context/SidebarContext";
import { messengerThreadKindLabel, resolveMessengerRoute, useMessengerModel } from "@/hooks/useMessenger";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import { displayChatTitle } from "@/lib/chat-title";
import { rememberMessengerPath } from "@/lib/messenger-memory";
import {
  archiveMessengerChatInCache,
  cancelMessengerChatRenameQueries,
  invalidateMessengerThreadSummaryQueries,
  markMessengerChatPinnedInCache,
  markMessengerThreadPinnedInCache,
  markMessengerThreadReadInCache,
  renameMessengerChatInCache,
} from "@/lib/messenger-query-cache";
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
import { cn, relativeTime } from "@/lib/utils";
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { buildChatMentionHref, formatMessengerPreview, formatMessengerTitle, type Agent, type ChatConversation, type MessengerCustomGroupWithEntries } from "@rudderhq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  ChevronDown,
  ChevronRight,
  CircleCheckBig,
  Copy,
  DollarSign,
  EyeOff,
  Folder,
  FolderInput,
  FolderPlus,
  ListFilter,
  Loader2,
  Mail,
  MailOpen,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  PencilLine,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserPlus,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

type ThreadOrganizationRule = "latest" | "project" | "agent" | "kind" | "attention" | "custom";
type MessengerThreadDensity = "comfortable" | "compact";
type CustomGroupEditorState =
  | { mode: "create"; threadKey?: string }
  | { mode: "edit"; group: MessengerCustomGroupWithEntries };

const THREAD_ORGANIZATION_STORAGE_KEY = "rudder.messengerThreadOrganizationByOrg";
const THREAD_DENSITY_STORAGE_KEY = "rudder.messengerThreadDensityByOrg";
const SPLIT_ISSUE_NOTIFICATIONS_STORAGE_KEY = "rudder.messengerSplitIssueNotificationsByOrg";
const COLLAPSED_PROJECT_GROUPS_STORAGE_KEY = "rudder.messengerCollapsedProjectGroupsByOrg";
const COLLAPSED_THREAD_GROUPS_STORAGE_KEY = "rudder.messengerCollapsedThreadGroupsByOrg";
const MESSENGER_PROJECT_GROUP_ORDER_STORAGE_PREFIX = "rudder.messengerProjectGroupOrder";
const MESSENGER_THREAD_GROUP_ORDER_STORAGE_PREFIX = "rudder.messengerThreadGroupOrder";
// Legacy storage name retained so existing local tab layouts survive; the value now stores Arc-style top-level layout order.
const MESSENGER_DEFAULT_THREAD_ORDER_STORAGE_PREFIX = "rudder.messengerDefaultThreadOrder";
const HIDDEN_ISSUE_THREADS_STORAGE_PREFIX = "rudder.messengerHiddenIssueThreads";
const DEFAULT_THREAD_ORGANIZATION_RULE: ThreadOrganizationRule = "latest";
const DEFAULT_THREAD_DENSITY: MessengerThreadDensity = "compact";
const DEFAULT_SPLIT_ISSUE_NOTIFICATIONS = true;
const MANAGED_GROUP_INITIAL_VISIBLE_COUNT = 6;
const MANAGED_GROUP_VISIBLE_INCREMENT = 10;
const DELETE_AFTER_STOP_RETRY_DELAYS_MS = [120, 300, 700] as const;
const CUSTOM_GROUP_ICON_OPTIONS = ["folder"] as const;
const CUSTOM_GROUP_EMOJI_OPTIONS = ["😀", "🚀", "💡", "🧠", "📌", "✨", "🛠️", "🔥"] as const;
const CUSTOM_GROUP_COLOR_OPTIONS = ["slate", "teal", "sky", "indigo", "amber", "rose", "red", "orange"] as const;
type CustomGroupColor = (typeof CUSTOM_GROUP_COLOR_OPTIONS)[number];
const CUSTOM_GROUP_ICON_SEPARATOR = "::";
const CUSTOM_GROUP_TONES: Record<CustomGroupColor, {
  bg: string;
  bgDark: string;
  bgHover: string;
  bgHoverDark: string;
  border: string;
  borderDark: string;
  text: string;
  textDark: string;
  entryText: string;
  entryTextDark: string;
  swatch: string;
}> = {
  slate: { bg: "#eef1ef", bgDark: "#313633", bgHover: "#e0e5e2", bgHoverDark: "#3b423e", border: "#d1d8d3", borderDark: "#545d58", text: "#26302a", textDark: "#f0f4f1", entryText: "#26302a", entryTextDark: "#eef2ef", swatch: "#242827" },
  teal: { bg: "#dff4ed", bgDark: "#143f36", bgHover: "#ccebe2", bgHoverDark: "#185247", border: "#a9d9cc", borderDark: "#2a7668", text: "#126454", textDark: "#d9fff5", entryText: "#173c35", entryTextDark: "#effffb", swatch: "#08a88a" },
  sky: { bg: "#dff1fb", bgDark: "#13394c", bgHover: "#c9e8f8", bgHoverDark: "#174b64", border: "#a9d7ee", borderDark: "#28708f", text: "#096287", textDark: "#dff7ff", entryText: "#153747", entryTextDark: "#f0fbff", swatch: "#0c8fca" },
  indigo: { bg: "#e6e5f8", bgDark: "#2d2c58", bgHover: "#d8d6f1", bgHoverDark: "#393873", border: "#c1bee6", borderDark: "#5b58a8", text: "#4c4695", textDark: "#f0efff", entryText: "#302e56", entryTextDark: "#f4f3ff", swatch: "#6259b5" },
  amber: { bg: "#f7edc2", bgDark: "#4a3914", bgHover: "#eee0a8", bgHoverDark: "#604a18", border: "#deca80", borderDark: "#9b7b2c", text: "#885900", textDark: "#ffeec2", entryText: "#4b3812", entryTextDark: "#fff8e5", swatch: "#f2a900" },
  rose: { bg: "#f3d5da", bgDark: "#4d252d", bgHover: "#eac3ca", bgHoverDark: "#63303a", border: "#dba8b2", borderDark: "#9b5664", text: "#7f2634", textDark: "#ffe9ee", entryText: "#51242c", entryTextDark: "#fff4f6", swatch: "#df6f83" },
  red: { bg: "#f0cdd1", bgDark: "#542126", bgHover: "#e7bac0", bgHoverDark: "#6a2a30", border: "#d59aa3", borderDark: "#a34d58", text: "#84242e", textDark: "#ffe8eb", entryText: "#552126", entryTextDark: "#fff1f2", swatch: "#d24b58" },
  orange: { bg: "#f4ddce", bgDark: "#552e1d", bgHover: "#edcbb7", bgHoverDark: "#6d3b25", border: "#dda98c", borderDark: "#a8623d", text: "#793816", textDark: "#ffeadf", entryText: "#512b1c", entryTextDark: "#fff4ee", swatch: "#ec6c3b" },
};
const THREAD_ORGANIZATION_OPTIONS: Array<{ value: ThreadOrganizationRule; label: string }> = [
  { value: "latest", label: "Latest activity" },
  { value: "project", label: "Project" },
  { value: "agent", label: "Agent" },
  { value: "kind", label: "Thread type" },
  { value: "attention", label: "Needs attention" },
];

function isLocalManagedThreadGroupRule(rule: ThreadOrganizationRule): rule is "project" | "agent" | "kind" {
  return rule === "project" || rule === "agent" || rule === "kind";
}

function isLocallyCollapsedThreadGroupRule(rule: ThreadOrganizationRule): rule is "project" | "agent" | "kind" | "custom" {
  return isLocalManagedThreadGroupRule(rule) || rule === "custom";
}

function isManagedThreadGroupRule(rule: ThreadOrganizationRule): rule is "project" | "agent" | "kind" | "custom" {
  return isLocalManagedThreadGroupRule(rule) || rule === "custom";
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

function sortableTranslateTransform(transform: { x: number; y: number } | null) {
  if (!transform) return undefined;
  return `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)`;
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
          <PanelLeftClose className="h-4 w-4" />
        </button>
      ) : null}
    </header>
  );
}

function threadIcon(kind: string) {
  switch (kind) {
    case "chat":
      return MessageSquare;
    case "issues":
      return CircleCheckBig;
    case "approvals":
      return ShieldCheck;
    case "failed-runs":
      return XCircle;
    case "budget-alerts":
      return DollarSign;
    case "join-requests":
      return UserPlus;
    default:
      return AlertTriangle;
  }
}

function sanitizeThreadKey(threadKey: string) {
  return threadKey.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function threadConversationId(threadKey: string) {
  return threadKey.startsWith("chat:") ? threadKey.slice("chat:".length) : null;
}

function readThreadOrganizationRule(orgId: string | null | undefined): ThreadOrganizationRule {
  if (!orgId || typeof window === "undefined") return DEFAULT_THREAD_ORGANIZATION_RULE;
  try {
    const raw = window.localStorage.getItem(THREAD_ORGANIZATION_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const value = parsed[orgId];
    if (value === "latest" || value === "project" || value === "agent" || value === "kind" || value === "attention" || value === "custom") return value;
  } catch {
    // Ignore storage failures; the default latest-activity list remains usable.
  }
  return DEFAULT_THREAD_ORGANIZATION_RULE;
}

function readThreadDensity(orgId: string | null | undefined): MessengerThreadDensity {
  if (!orgId || typeof window === "undefined") return DEFAULT_THREAD_DENSITY;
  try {
    const raw = window.localStorage.getItem(THREAD_DENSITY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const value = parsed[orgId];
    if (value === "comfortable" || value === "compact") return value;
  } catch {
    // Ignore storage failures; the default comfortable list remains usable.
  }
  return DEFAULT_THREAD_DENSITY;
}

function readSplitIssueNotifications(orgId: string | null | undefined): boolean {
  if (!orgId || typeof window === "undefined") return DEFAULT_SPLIT_ISSUE_NOTIFICATIONS;
  try {
    const raw = window.localStorage.getItem(SPLIT_ISSUE_NOTIFICATIONS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const value = parsed[orgId];
    if (typeof value === "boolean") return value;
  } catch {
    // Ignore storage failures; split issue notifications remain the default.
  }
  return DEFAULT_SPLIT_ISSUE_NOTIFICATIONS;
}

function readCollapsedProjectGroups(orgId: string | null | undefined): Set<string> {
  if (!orgId || typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(COLLAPSED_PROJECT_GROUPS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const values = parsed[orgId];
    if (Array.isArray(values)) {
      return new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0));
    }
  } catch {
    // Ignore storage failures; project sections stay expanded.
  }
  return new Set();
}

function readCollapsedThreadGroups(orgId: string | null | undefined, rule: ThreadOrganizationRule): Set<string> {
  if (!isLocallyCollapsedThreadGroupRule(rule)) return new Set();
  if (rule === "project") return readCollapsedProjectGroups(orgId);
  if (!orgId || typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(COLLAPSED_THREAD_GROUPS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const orgValue = parsed[orgId];
    const values = orgValue && typeof orgValue === "object" && !Array.isArray(orgValue)
      ? (orgValue as Record<string, unknown>)[rule]
      : undefined;
    if (Array.isArray(values)) {
      return new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0));
    }
  } catch {
    // Ignore storage failures; managed sections stay expanded.
  }
  return new Set();
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function messengerUserStorageId(userId: string | null | undefined) {
  const trimmed = userId?.trim();
  return trimmed || "anonymous";
}

function getMessengerProjectGroupOrderStorageKey(orgId: string, userId: string | null | undefined) {
  return `${MESSENGER_PROJECT_GROUP_ORDER_STORAGE_PREFIX}:${orgId}:${messengerUserStorageId(userId)}`;
}

function getMessengerThreadGroupOrderStorageKey(orgId: string, userId: string | null | undefined, rule: ThreadOrganizationRule) {
  if (rule === "project") return getMessengerProjectGroupOrderStorageKey(orgId, userId);
  return `${MESSENGER_THREAD_GROUP_ORDER_STORAGE_PREFIX}:${rule}:${orgId}:${messengerUserStorageId(userId)}`;
}

function getMessengerDefaultThreadOrderStorageKey(orgId: string, userId: string | null | undefined) {
  return `${MESSENGER_DEFAULT_THREAD_ORDER_STORAGE_PREFIX}:${orgId}:${messengerUserStorageId(userId)}`;
}

function getHiddenIssueThreadsStorageKey(orgId: string, userId: string | null | undefined) {
  return `${HIDDEN_ISSUE_THREADS_STORAGE_PREFIX}:${orgId}:${messengerUserStorageId(userId)}`;
}

function readStringList(storageKey: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey);
    return raw ? normalizeStringList(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function writeStringList(storageKey: string, values: string[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(normalizeStringList(values)));
  } catch {
    // Ignore storage failures; the in-memory order still applies for this view.
  }
}

function readHiddenIssueThreadWatermarks(storageKey: string): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, string] =>
          typeof entry[0] === "string" && entry[0].length > 0 && typeof entry[1] === "string",
        ),
    );
  } catch {
    return {};
  }
}

function writeHiddenIssueThreadWatermarks(storageKey: string, watermarks: Record<string, string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(watermarks));
  } catch {
    // Ignore storage failures; the in-memory hidden state still applies.
  }
}

function writeThreadOrganizationRule(orgId: string, rule: ThreadOrganizationRule) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(THREAD_ORGANIZATION_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    window.localStorage.setItem(THREAD_ORGANIZATION_STORAGE_KEY, JSON.stringify({ ...parsed, [orgId]: rule }));
  } catch {
    // Ignore storage failures; the in-memory selection still applies for this view.
  }
}

function writeThreadDensity(orgId: string, density: MessengerThreadDensity) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(THREAD_DENSITY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    window.localStorage.setItem(THREAD_DENSITY_STORAGE_KEY, JSON.stringify({ ...parsed, [orgId]: density }));
  } catch {
    // Ignore storage failures; the in-memory density still applies for this view.
  }
}

function writeSplitIssueNotifications(orgId: string, enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(SPLIT_ISSUE_NOTIFICATIONS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    window.localStorage.setItem(SPLIT_ISSUE_NOTIFICATIONS_STORAGE_KEY, JSON.stringify({ ...parsed, [orgId]: enabled }));
  } catch {
    // Ignore storage failures; the in-memory toggle still applies for this view.
  }
}

function writeCollapsedProjectGroups(orgId: string, groups: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(COLLAPSED_PROJECT_GROUPS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    window.localStorage.setItem(COLLAPSED_PROJECT_GROUPS_STORAGE_KEY, JSON.stringify({
      ...parsed,
      [orgId]: Array.from(groups),
    }));
  } catch {
    // Ignore storage failures; the in-memory section state still applies.
  }
}

function writeCollapsedThreadGroups(orgId: string, rule: ThreadOrganizationRule, groups: Set<string>) {
  if (!isLocallyCollapsedThreadGroupRule(rule)) return;
  if (rule === "project") {
    writeCollapsedProjectGroups(orgId, groups);
    return;
  }
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(COLLAPSED_THREAD_GROUPS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const orgValue = parsed[orgId];
    const orgGroups = orgValue && typeof orgValue === "object" && !Array.isArray(orgValue)
      ? orgValue as Record<string, unknown>
      : {};
    window.localStorage.setItem(COLLAPSED_THREAD_GROUPS_STORAGE_KEY, JSON.stringify({
      ...parsed,
      [orgId]: {
        ...orgGroups,
        [rule]: Array.from(groups),
      },
    }));
  } catch {
    // Ignore storage failures; the in-memory section state still applies.
  }
}

function threadOrganizationLabel(rule: ThreadOrganizationRule) {
  if (rule === "custom") return "Latest activity";
  return THREAD_ORGANIZATION_OPTIONS.find((option) => option.value === rule)?.label ?? "Latest activity";
}

function isCustomGroupColor(value: string | null | undefined): value is CustomGroupColor {
  return CUSTOM_GROUP_COLOR_OPTIONS.includes(value as CustomGroupColor);
}

function splitCustomGroupIconValue(value: string | null | undefined): { glyph: string; color: CustomGroupColor | null } {
  const trimmed = value?.trim();
  if (!trimmed) return { glyph: "folder", color: null };
  const [rawGlyph, rawColor] = trimmed.split(CUSTOM_GROUP_ICON_SEPARATOR);
  return {
    glyph: rawGlyph?.trim() || "folder",
    color: isCustomGroupColor(rawColor) ? rawColor : null,
  };
}

function composeCustomGroupIconValue(glyph: string, color: CustomGroupColor | null) {
  const normalizedGlyph = glyph.trim() || "folder";
  return color ? `${normalizedGlyph}${CUSTOM_GROUP_ICON_SEPARATOR}${color}` : normalizedGlyph;
}

function customGroupColorFor(group: Pick<MessengerCustomGroupWithEntries, "id" | "icon" | "sortOrder">): CustomGroupColor {
  const parsed = splitCustomGroupIconValue(group.icon);
  if (parsed.color) return parsed.color;
  return CUSTOM_GROUP_COLOR_OPTIONS[Math.abs(group.sortOrder ?? group.id.length) % CUSTOM_GROUP_COLOR_OPTIONS.length] ?? "slate";
}

function customGroupStyle(group: Pick<MessengerCustomGroupWithEntries, "id" | "icon" | "sortOrder">): CSSProperties {
  const tone = CUSTOM_GROUP_TONES[customGroupColorFor(group)];
  return {
    "--messenger-group-bg": tone.bg,
    "--messenger-group-bg-dark": tone.bgDark,
    "--messenger-group-bg-hover": tone.bgHover,
    "--messenger-group-bg-hover-dark": tone.bgHoverDark,
    "--messenger-group-border": tone.border,
    "--messenger-group-border-dark": tone.borderDark,
    "--messenger-group-text": tone.text,
    "--messenger-group-text-dark": tone.textDark,
    "--messenger-group-entry-text": tone.entryText,
    "--messenger-group-entry-text-dark": tone.entryTextDark,
  } as CSSProperties;
}

function customGroupIconLabel(icon: string | null | undefined) {
  const { glyph } = splitCustomGroupIconValue(icon);
  const trimmed = glyph.trim();
  return trimmed || null;
}

function isCustomGroupEmojiGlyph(value: string) {
  return CUSTOM_GROUP_EMOJI_OPTIONS.includes(value as (typeof CUSTOM_GROUP_EMOJI_OPTIONS)[number]) || /[^\x00-\x7F]/.test(value);
}

function CustomGroupIcon({ icon }: { icon?: string | null }) {
  const label = customGroupIconLabel(icon);
  if (!label || label.toLowerCase() === "folder") {
    return <Folder className="h-3.5 w-3.5 shrink-0" aria-hidden />;
  }
  if (isCustomGroupEmojiGlyph(label)) {
    return (
      <span
        aria-hidden
        className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center text-[14px] leading-none"
      >
        {label}
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)-2px)] bg-[color:color-mix(in_oklab,var(--surface-active)_72%,transparent)] px-0.5 text-[10px] font-semibold leading-none text-muted-foreground"
    >
      {label.slice(0, 2)}
    </span>
  );
}

function CustomGroupEditor({
  state,
  name,
  icon,
  color,
  pending,
  onNameChange,
  onIconChange,
  onColorChange,
  onCancel,
  onSubmit,
}: {
  state: CustomGroupEditorState;
  name: string;
  icon: string;
  color: CustomGroupColor | null;
  pending: boolean;
  onNameChange: (value: string) => void;
  onIconChange: (value: string) => void;
  onColorChange: (value: CustomGroupColor | null) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const title = state.mode === "create" ? "New group" : "Edit group";
  const submitLabel = state.mode === "create" ? "Create" : "Save";
  return (
    <form
      data-testid="messenger-custom-group-editor"
      className="mx-3 mt-2 rounded-md border border-[color:color-mix(in_oklab,var(--border-soft)_86%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_96%,transparent)] p-2.5 shadow-sm"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="mb-2 flex items-center gap-2">
        <CustomGroupIcon icon={icon} />
        <div className="min-w-0 flex-1 text-[12px] font-semibold text-foreground">{title}</div>
      </div>
      <input
        autoFocus
        aria-label="Group name"
        value={name}
        onChange={(event) => onNameChange(event.currentTarget.value)}
        className="h-8 w-full rounded-[calc(var(--radius-sm)-1px)] border border-[color:var(--border-base)] bg-[color:var(--surface-page)] px-2.5 text-[13px] outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
      />
      <div className="mt-2 flex items-center gap-1.5" aria-label="Group icon">
        {CUSTOM_GROUP_ICON_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            aria-label={`Use ${option} group icon`}
            aria-pressed={(icon || "folder") === option}
            className={cn(
              "inline-flex h-7 w-7 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] border text-[11px] font-semibold transition-[background-color,border-color,color]",
              (icon || "folder") === option
                ? "border-[color:var(--border-strong)] bg-[color:var(--surface-active)] text-foreground"
                : "border-transparent text-muted-foreground hover:bg-[color:var(--surface-active)] hover:text-foreground",
            )}
            onClick={() => onIconChange(option)}
          >
            <CustomGroupIcon icon={option} />
          </button>
        ))}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5" aria-label="Group emoji">
        {CUSTOM_GROUP_EMOJI_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            aria-label={`Use ${option} group emoji`}
            aria-pressed={icon === option}
            className={cn(
              "inline-flex h-7 w-7 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] border text-[14px] leading-none transition-[background-color,border-color,transform]",
              icon === option
                ? "border-[color:var(--border-strong)] bg-[color:var(--surface-active)]"
                : "border-transparent hover:bg-[color:var(--surface-active)] hover:scale-[1.04]",
            )}
            onClick={() => onIconChange(option)}
          >
            {option}
          </button>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1.5" aria-label="Group color">
        {CUSTOM_GROUP_COLOR_OPTIONS.map((option) => {
          const tone = CUSTOM_GROUP_TONES[option];
          return (
            <button
              key={option}
              type="button"
              aria-label={`Use ${option} group color`}
              aria-pressed={color === option}
              className={cn(
                "inline-flex h-6 w-6 items-center justify-center rounded-full border transition-[border-color,box-shadow,transform] hover:scale-105",
                color === option
                  ? "border-[color:var(--border-strong)] shadow-[0_0_0_2px_var(--surface-elevated),0_0_0_4px_color-mix(in_oklab,var(--border-strong)_70%,transparent)]"
                  : "border-transparent",
              )}
              style={{ backgroundColor: tone.swatch }}
              onClick={() => onColorChange(option)}
            />
          );
        })}
      </div>
      <div className="mt-2.5 flex justify-end gap-1.5">
        <button
          type="button"
          className="inline-flex h-7 items-center rounded-[calc(var(--radius-sm)-1px)] px-2 text-[12px] font-medium text-muted-foreground transition-[background-color,color] hover:bg-[color:var(--surface-active)] hover:text-foreground"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={pending || !name.trim()}
          className="inline-flex h-7 items-center rounded-[calc(var(--radius-sm)-1px)] bg-[color:var(--accent-strong)] px-2.5 text-[12px] font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function conversationSubtitle(conversation: ChatConversation) {
  return (
    formatMessengerPreview(conversation.latestReplyPreview) ||
    formatMessengerPreview(conversation.summary) ||
    (conversation.primaryIssue
      ? `${conversation.primaryIssue.identifier ?? conversation.primaryIssue.id} · ${conversation.primaryIssue.title}`
      : null) ||
    "Start the conversation"
  );
}

function conversationDisplayTitle(conversation: Pick<ChatConversation, "title" | "summary" | "latestUserMessagePreview" | "latestReplyPreview">) {
  return displayChatTitle(conversation);
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function resolveChatAgentId(conversation: Pick<ChatConversation, "preferredAgentId" | "routedAgentId" | "chatRuntime">) {
  return (
    conversation.chatRuntime?.runtimeAgentId
    ?? conversation.routedAgentId
    ?? conversation.preferredAgentId
    ?? null
  );
}

function threadDisplayTitle(title: string) {
  return formatMessengerTitle(title, { max: 80 }) ?? title;
}

interface ThreadGroup {
  key: string;
  label: string;
  sortLabel?: string;
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

function projectIdFromSectionKey(sectionKey: string) {
  return sectionKey.startsWith("project:") && sectionKey !== "project:none"
    ? sectionKey.slice("project:".length)
    : null;
}

function syntheticProjectSectionIdFromKey(sectionKey: string) {
  return projectIdFromSectionKey(sectionKey) ? null : `messenger-section:${sectionKey}`;
}

function projectSectionKeyToStoredId(sectionKey: string) {
  return projectIdFromSectionKey(sectionKey) ?? syntheticProjectSectionIdFromKey(sectionKey) ?? sectionKey;
}

function storedProjectSectionIdToKey(storedId: string) {
  if (storedId.startsWith("messenger-section:")) return storedId.slice("messenger-section:".length);
  if (storedId.startsWith("project:")) return storedId;
  return `project:${storedId}`;
}

function threadSectionKeyToStoredId(rule: ThreadOrganizationRule, sectionKey: string) {
  return rule === "project" ? projectSectionKeyToStoredId(sectionKey) : sectionKey;
}

function storedThreadSectionIdToKey(rule: ThreadOrganizationRule, storedId: string) {
  return rule === "project" ? storedProjectSectionIdToKey(storedId) : storedId;
}

function customGroupSectionKey(groupId: string) {
  return `custom-group:${groupId}`;
}

function customGroupIdFromSectionKey(sectionKey: string) {
  return sectionKey.startsWith("custom-group:") ? sectionKey.slice("custom-group:".length) : null;
}

function sortProjectThreadSections(
  sections: OrganizedThreadSection[],
  orderedProjectIds: string[],
  orderedSectionIds: string[] = [],
) {
  if (sections.length === 0) return sections;
  const orderIndex = new Map(orderedProjectIds.map((id, index) => [id, index]));
  const realProjectSections: OrganizedThreadSection[] = [];
  const fixedSections: OrganizedThreadSection[] = [];

  for (const section of sections) {
    if (projectIdFromSectionKey(section.key)) {
      realProjectSections.push(section);
    } else {
      fixedSections.push(section);
    }
  }

  realProjectSections.sort((a, b) => {
    const aProjectId = projectIdFromSectionKey(a.key);
    const bProjectId = projectIdFromSectionKey(b.key);
    const aIndex = aProjectId ? orderIndex.get(aProjectId) : undefined;
    const bIndex = bProjectId ? orderIndex.get(bProjectId) : undefined;
    if (aIndex !== undefined || bIndex !== undefined) {
      return (aIndex ?? Number.MAX_SAFE_INTEGER) - (bIndex ?? Number.MAX_SAFE_INTEGER);
    }
    return (a.label ?? "").localeCompare(b.label ?? "");
  });

  const projectSortedSections = [...realProjectSections, ...fixedSections];
  if (orderedSectionIds.length === 0) return projectSortedSections;

  const sectionOrderIndex = new Map(
    orderedSectionIds.map((id, index) => [storedProjectSectionIdToKey(id), index]),
  );
  const baseIndex = new Map(projectSortedSections.map((section, index) => [section.key, index]));
  return [...projectSortedSections].sort((a, b) => {
    const aIndex = sectionOrderIndex.get(a.key);
    const bIndex = sectionOrderIndex.get(b.key);
    if (aIndex !== undefined || bIndex !== undefined) {
      return (aIndex ?? Number.MAX_SAFE_INTEGER) - (bIndex ?? Number.MAX_SAFE_INTEGER);
    }
    return (baseIndex.get(a.key) ?? 0) - (baseIndex.get(b.key) ?? 0);
  });
}

function sortManagedThreadSections(
  sections: OrganizedThreadSection[],
  rule: ThreadOrganizationRule,
  orderedProjectIds: string[],
  orderedSectionIds: string[] = [],
) {
  if (!isLocalManagedThreadGroupRule(rule)) return sections;
  if (rule === "project") return sortProjectThreadSections(sections, orderedProjectIds, orderedSectionIds);
  if (orderedSectionIds.length === 0) return sections;

  const sectionOrderIndex = new Map(
    orderedSectionIds.map((id, index) => [storedThreadSectionIdToKey(rule, id), index]),
  );
  const baseIndex = new Map(sections.map((section, index) => [section.key, index]));
  return [...sections].sort((a, b) => {
    const aIndex = sectionOrderIndex.get(a.key);
    const bIndex = sectionOrderIndex.get(b.key);
    if (aIndex !== undefined || bIndex !== undefined) {
      return (aIndex ?? Number.MAX_SAFE_INTEGER) - (bIndex ?? Number.MAX_SAFE_INTEGER);
    }
    return (baseIndex.get(a.key) ?? 0) - (baseIndex.get(b.key) ?? 0);
  });
}

function chatProjectGroup(conversation: ChatConversation | null): ThreadGroup {
  const projectLink = conversation?.contextLinks?.find((link) => link.entityType === "project") ?? null;
  const projectId = typeof projectLink?.entityId === "string" && projectLink.entityId.trim()
    ? projectLink.entityId.trim()
    : null;
  const label = projectLink?.entity?.label || projectLink?.entity?.identifier || (projectLink ? "Unknown project" : "No project");
  return projectId
    ? { key: `project:${projectId}`, label, sortLabel: label }
    : { key: "project:none", label };
}

function splitIssueProjectGroup(thread: MessengerThreadSummaryItem): ThreadGroup | null {
  if (thread.metadata?.splitIssue !== true) return null;
  const metadata = thread.metadata as Record<string, unknown>;
  const projectId = metadataString(metadata, "projectId");
  const label = metadataString(metadata, "projectName") ?? (projectId ? "Unknown project" : "No project");
  return projectId
    ? { key: `project:${projectId}`, label, sortLabel: label }
    : { key: "project:none", label };
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string) {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function entryAgentGroup(entry: OrganizedThreadEntry, agentsById: Map<string, Agent>): ThreadGroup {
  if (entry.thread.kind === "chat") {
    const agentId = entry.conversation ? resolveChatAgentId(entry.conversation) : null;
    if (!agentId) return { key: "agent:none", label: "No agent" };
    const label = agentsById.get(agentId)?.name ?? "Unknown agent";
    return { key: `agent:${agentId}`, label, sortLabel: label };
  }

  if (entry.thread.metadata?.splitIssue === true) {
    const metadata = entry.thread.metadata as Record<string, unknown>;
    const agentId =
      metadataString(metadata, "assigneeAgentId")
      ?? metadataString(metadata, "agentId")
      ?? metadataString(metadata, "runtimeAgentId")
      ?? metadataString(metadata, "preferredAgentId");
    if (!agentId) return { key: "agent:none", label: "No agent" };
    const label =
      agentsById.get(agentId)?.name
      ?? metadataString(metadata, "assigneeAgentName")
      ?? metadataString(metadata, "agentName")
      ?? "Unknown agent";
    return { key: `agent:${agentId}`, label, sortLabel: label };
  }

  return { key: "system", label: "System" };
}

function ThreadAvatar({
  icon: Icon,
  unreadCount,
  needsAttention,
  density = "comfortable",
  shape = "circle",
  testId,
}: {
  icon: typeof MessageSquare;
  unreadCount: number;
  needsAttention: boolean;
  density?: MessengerThreadDensity;
  shape?: "circle" | "rounded";
  testId?: string;
}) {
  const compact = density === "compact";
  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center border border-[color:color-mix(in_oklab,var(--border-soft)_86%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-active)_78%,transparent)] text-[color:var(--accent-strong)]",
        compact ? "h-7 w-7" : "mt-0.5 h-10 w-10",
        shape === "rounded" ? "rounded-[calc(var(--radius-sm)+1px)]" : "rounded-full",
      )}
    >
      <Icon className={cn(compact ? "h-3.5 w-3.5" : "h-4.5 w-4.5")} />
      {unreadCount > 0 ? (
        <span
          data-testid={testId}
          className="absolute -right-1.5 -top-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full border border-[color:var(--surface-elevated)] bg-red-500 px-1 text-[10px] font-semibold leading-none text-white shadow-[0_4px_12px_-6px_rgba(220,38,38,0.85)]"
        >
          {unreadCount > 99 ? "99+" : unreadCount}
        </span>
      ) : needsAttention ? (
        <span className="absolute -right-0.5 -top-0.5 h-3.5 w-3.5 rounded-full border-2 border-[color:var(--surface-elevated)] bg-red-500" />
      ) : null}
    </span>
  );
}

function ChatAgentThreadAvatar({
  agent,
  agentId,
  unreadCount,
  needsAttention,
  density,
  testId,
}: {
  agent: Agent | null;
  agentId: string | null;
  unreadCount: number;
  needsAttention: boolean;
  density: MessengerThreadDensity;
  testId: string;
}) {
  if (!agent && !agentId) {
    return (
      <ThreadAvatar
        icon={MessageSquare}
        unreadCount={unreadCount}
        needsAttention={needsAttention}
        density={density}
        shape="rounded"
        testId={`${testId}-unread-badge`}
      />
    );
  }

  const compact = density === "compact";
  return (
    <span
      data-testid={testId}
      title={agent?.name ? `Chat agent: ${agent.name}` : "Chat agent"}
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-visible rounded-full border border-[color:color-mix(in_oklab,var(--border-soft)_86%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-active)_78%,transparent)]",
        compact ? "h-7 w-7" : "mt-0.5 h-10 w-10",
      )}
    >
      <AgentIcon
        icon={agent?.icon}
        role={agent?.role}
        fallbackSeed={agent?.id ?? agentId}
        className="h-full w-full rounded-full"
      />
      {unreadCount > 0 ? (
        <span
          data-testid={`${testId}-unread-badge`}
          className="absolute -right-1.5 -top-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full border border-[color:var(--surface-elevated)] bg-red-500 px-1 text-[10px] font-semibold leading-none text-white shadow-[0_4px_12px_-6px_rgba(220,38,38,0.85)]"
        >
          {unreadCount > 99 ? "99+" : unreadCount}
        </span>
      ) : needsAttention ? (
        <span className="absolute -right-0.5 -top-0.5 h-3.5 w-3.5 rounded-full border-2 border-[color:var(--surface-elevated)] bg-red-500" />
      ) : null}
    </span>
  );
}

function IssueStatusThreadAvatar({
  status,
  unreadCount,
  needsAttention,
  density = "comfortable",
  testId,
}: {
  status: string;
  unreadCount: number;
  needsAttention: boolean;
  density?: MessengerThreadDensity;
  testId?: string;
}) {
  const compact = density === "compact";
  return (
    <span
      title={`Issue status: ${status.replace(/_/g, " ")}`}
      className={cn(
        "relative flex shrink-0 items-center justify-center rounded-full border border-[color:color-mix(in_oklab,var(--border-soft)_86%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-active)_78%,transparent)]",
        compact ? "h-7 w-7" : "mt-0.5 h-10 w-10",
      )}
    >
      <StatusIcon status={status} className={cn(compact ? "h-3.5 w-3.5" : "h-4.5 w-4.5")} />
      {unreadCount > 0 ? (
        <span
          data-testid={testId}
          className="absolute -right-1.5 -top-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full border border-[color:var(--surface-elevated)] bg-red-500 px-1 text-[10px] font-semibold leading-none text-white shadow-[0_4px_12px_-6px_rgba(220,38,38,0.85)]"
        >
          {unreadCount > 99 ? "99+" : unreadCount}
        </span>
      ) : needsAttention ? (
        <span className="absolute -right-0.5 -top-0.5 h-3.5 w-3.5 rounded-full border-2 border-[color:var(--surface-elevated)] bg-red-500" />
      ) : null}
    </span>
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
  onCreateCustomGroup: () => void;
}) {
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
        <DropdownMenuContent align="end" className="surface-overlay w-48 text-foreground">
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
          <DropdownMenuItem onClick={() => onCreateCustomGroup()}>
            <FolderPlus className="h-4 w-4" />
            New group
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ChatThreadRow({
  conversation,
  agent,
  agentId,
  href,
  active,
  generating,
  density,
  renaming,
  renameDraft,
  onRenameDraftChange,
  onCommitRename,
  onStartRename,
  onRegenerateTitle,
  onArchive,
  onDelete,
  onTogglePin,
  onToggleUnread,
  onCopyConversationLink,
  customGroups,
  customGroupId,
  onMoveToCustomGroup,
  onRemoveFromCustomGroup,
  onCreateCustomGroup,
  dragHandleProps,
  dragging,
  onSelect,
}: {
  conversation: ChatConversation;
  agent: Agent | null;
  agentId: string | null;
  href: string;
  active: boolean;
  generating: boolean;
  density: MessengerThreadDensity;
  renaming: boolean;
  renameDraft: string;
  onRenameDraftChange: (value: string) => void;
  onCommitRename: () => void;
  onStartRename: () => void;
  onRegenerateTitle?: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
  onToggleUnread: () => void;
  onCopyConversationLink: () => void;
  customGroups?: MessengerCustomGroupWithEntries[];
  customGroupId?: string | null;
  onMoveToCustomGroup?: (groupId: string) => void;
  onRemoveFromCustomGroup?: () => void;
  onCreateCustomGroup?: () => void;
  dragHandleProps?: Pick<ReturnType<typeof useSortable>, "attributes" | "listeners">;
  dragging?: boolean;
  onSelect: (href: string) => void;
}) {
  const timeLabel = relativeTime(conversation.lastMessageAt ?? conversation.updatedAt, { compactDate: true });
  const [actionsOpen, setActionsOpen] = useState(false);
  const compact = density === "compact";
  const rightActionClass = compact ? "right-1.5" : "right-2";
  const secondaryActionClass = compact ? "right-7" : "right-8";

  useEffect(() => {
    if (generating) setActionsOpen(false);
  }, [generating]);

  return (
    <div
      {...dragHandleProps?.attributes}
      {...dragHandleProps?.listeners}
      data-testid={`messenger-thread-${sanitizeThreadKey(`chat:${conversation.id}`)}`}
      data-messenger-thread-key={`chat:${conversation.id}`}
      className={cn(
        "group relative mx-1.5 flex rounded-[calc(var(--radius-md)-2px)] border transition-[background-color,border-color,color]",
        compact ? "items-center gap-2 px-2 py-1.5" : "items-start gap-3 px-3 py-2.5",
        dragHandleProps && "touch-none cursor-grab active:cursor-grabbing",
        active
          ? "chat-conversation-active border-[color:var(--border-strong)] bg-[color:color-mix(in_oklab,var(--surface-active)_90%,var(--surface-elevated))]"
          : "border-transparent hover:border-[color:color-mix(in_oklab,var(--border-soft)_70%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-active)_62%,transparent)]",
        customGroupId && "text-[color:var(--messenger-group-entry-text)] dark:text-[color:var(--messenger-group-entry-text-dark)]",
        dragging && "shadow-sm ring-1 ring-border/70",
      )}
    >
      <ChatAgentThreadAvatar
        agent={agent}
        agentId={agentId}
        unreadCount={conversation.unreadCount}
        needsAttention={conversation.needsAttention}
        density={density}
        testId={`messenger-thread-${sanitizeThreadKey(`chat:${conversation.id}`)}-agent-avatar`}
      />
      {renaming ? (
        <div className="min-w-0 flex-1">
          <input
            autoFocus
            value={renameDraft}
            onChange={(event) => onRenameDraftChange(event.target.value)}
            onBlur={onCommitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onCommitRename();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onRenameDraftChange(conversation.title);
                onCommitRename();
              }
            }}
            className="min-h-0 w-full rounded-[calc(var(--radius-sm)-1px)] border border-[color:var(--border-base)] bg-[color:var(--surface-elevated)] px-3 py-2 text-sm outline-none"
          />
        </div>
      ) : (
        <>
          <Link to={href} onClick={() => onSelect(href)} className="block min-w-0 flex-1">
            <div className={cn(
              "grid min-w-0 gap-x-2",
              compact ? "grid-cols-[minmax(0,1fr)_2.75rem] items-center" : "grid-cols-[minmax(0,1fr)_3rem] items-start",
            )}>
              <div className="min-w-0">
                <div
                  className={cn(
                    "flex items-center gap-2 text-[13px] leading-tight",
                    customGroupId
                      ? conversation.isUnread ? "font-semibold text-current" : "font-medium text-current/88"
                      : conversation.isUnread ? "font-semibold text-foreground" : "font-medium text-foreground/92",
                  )}
                >
                  <span className="truncate">{conversationDisplayTitle(conversation)}</span>
                </div>
                {!compact ? (
                  <div
                    className={cn(
                      "mt-0.5 truncate text-[12px]",
                      customGroupId
                        ? conversation.isUnread ? "text-current/78" : "text-current/62"
                        : conversation.isUnread ? "text-foreground/76" : "text-muted-foreground",
                    )}
                  >
                    {conversationSubtitle(conversation)}
                  </div>
                ) : null}
              </div>
              <span
                data-testid={`messenger-time-${sanitizeThreadKey(`chat:${conversation.id}`)}`}
                className={cn(
                  "block shrink-0 whitespace-nowrap text-right text-[10px] leading-none tabular-nums text-muted-foreground transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0",
                  compact ? "w-11" : "mt-0.5 w-12",
                  (actionsOpen || generating) && "opacity-0",
                )}
              >
                {timeLabel}
              </span>
            </div>
          </Link>

          {generating ? (
            <span
              data-testid={`messenger-generating-${sanitizeThreadKey(`chat:${conversation.id}`)}`}
              aria-label="Chat reply in progress"
              className={cn(
                "pointer-events-none absolute top-1/2 z-10 inline-flex -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0",
                compact ? "right-1.5 h-5 w-5" : "right-2 h-6 w-6",
                actionsOpen && "opacity-0",
              )}
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2.25} aria-hidden />
            </span>
          ) : null}

          {conversation.isPinned ? (
            <button
              type="button"
              data-testid={`messenger-pin-toggle-${sanitizeThreadKey(`chat:${conversation.id}`)}`}
              className={cn(
                "absolute top-1/2 z-10 -translate-y-1/2 rounded-md p-1 text-[color:var(--accent-strong)] opacity-0 transition-[opacity,background-color,color] duration-150 hover:bg-[color:var(--surface-page)] hover:text-[color:var(--accent-strong)] focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100",
                rightActionClass,
                (actionsOpen || generating) && "pointer-events-none opacity-0",
              )}
              aria-label="Unpin chat"
              title="Unpin chat"
              onClick={onTogglePin}
            >
              <Pin className="h-3.5 w-3.5" strokeWidth={2.25} />
            </button>
          ) : null}

          <DropdownMenu open={actionsOpen} onOpenChange={setActionsOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  "absolute top-1/2 z-10 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-[opacity,background-color,color] duration-150 hover:bg-[color:var(--surface-page)] hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100",
                  conversation.isPinned ? secondaryActionClass : rightActionClass,
                  actionsOpen ? "opacity-100" : "opacity-0",
                )}
                aria-label="Chat actions"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="surface-overlay text-foreground">
              <DropdownMenuItem onClick={onStartRename}>
                <PencilLine className="h-4 w-4" />
                Rename
              </DropdownMenuItem>
              {onRegenerateTitle ? (
                <DropdownMenuItem onClick={onRegenerateTitle}>
                  <RefreshCw className="h-4 w-4" />
                  Regenerate title
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onClick={onTogglePin}>
                {conversation.isPinned ? (
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
              <DropdownMenuItem onClick={onToggleUnread}>
                {conversation.isUnread ? (
                  <>
                    <MailOpen className="h-4 w-4" />
                    Mark as Read
                  </>
                ) : (
                  <>
                    <Mail className="h-4 w-4" />
                    Mark as Unread
                  </>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onCopyConversationLink}>
                <Copy className="h-4 w-4" />
                Copy Chat Link
              </DropdownMenuItem>
              {customGroups ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onCreateCustomGroup}>
                    <FolderPlus className="h-4 w-4" />
                    New group
                  </DropdownMenuItem>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <FolderInput className="h-4 w-4" />
                      Move to group
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="surface-overlay text-foreground">
                      {customGroupId ? (
                        <DropdownMenuItem onClick={onRemoveFromCustomGroup}>
                          <Folder className="h-4 w-4" />
                          Move out of group
                        </DropdownMenuItem>
                      ) : null}
                      {customGroups.length > 0 ? (
                        customGroups.map((group) => (
                          <DropdownMenuItem
                            key={group.id}
                            disabled={group.id === customGroupId}
                            onClick={() => onMoveToCustomGroup?.(group.id)}
                          >
                            <CustomGroupIcon icon={group.icon} />
                            {group.name}
                          </DropdownMenuItem>
                        ))
                      ) : (
                        <DropdownMenuItem disabled>No groups</DropdownMenuItem>
                      )}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </>
              ) : null}
              <DropdownMenuItem onClick={onArchive}>
                <Archive className="h-4 w-4" />
                Archive
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={onDelete}
                title={generating ? "Stops the active reply before deleting this chat." : undefined}
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  );
}

function ThreadRow({
  thread,
  active,
  density,
  onTogglePin,
  onHideIssue,
  customGroupsEnabled,
  dragHandleProps,
  dragging,
  onSelect,
}: {
  thread: ReturnType<typeof useMessengerModel>["threadSummaries"][number];
  active: boolean;
  density: MessengerThreadDensity;
  onTogglePin: () => void;
  onHideIssue?: () => void;
  customGroupsEnabled?: boolean;
  dragHandleProps?: Pick<ReturnType<typeof useSortable>, "attributes" | "listeners">;
  dragging?: boolean;
  onSelect: (href: string) => void;
}) {
  const Icon = threadIcon(thread.kind);
  const preview = formatMessengerPreview(thread.preview) || formatMessengerPreview(thread.subtitle) || messengerThreadKindLabel(thread.kind);
  const compact = density === "compact";
  const [actionsOpen, setActionsOpen] = useState(false);
  const rightActionClass = compact ? "right-1.5" : "right-2";
  const secondaryActionClass = compact ? "right-7" : "right-8";
  const canTogglePin = thread.metadata?.splitIssue === true;
  const canHideIssue = thread.metadata?.splitIssue === true && Boolean(onHideIssue);
  const showActions = canTogglePin || canHideIssue || customGroupsEnabled;
  const issueStatus =
    thread.metadata?.splitIssue === true && typeof thread.metadata.status === "string"
      ? thread.metadata.status
      : null;
  const activeExecutionRunId =
    thread.metadata?.splitIssue === true && typeof thread.metadata.activeExecutionRunId === "string"
      ? thread.metadata.activeExecutionRunId
      : null;

  useEffect(() => {
    if (activeExecutionRunId) setActionsOpen(false);
  }, [activeExecutionRunId]);

  return (
    <div
      {...dragHandleProps?.attributes}
      {...dragHandleProps?.listeners}
      data-testid={`messenger-thread-${sanitizeThreadKey(thread.threadKey)}`}
      data-messenger-thread-key={thread.threadKey}
      className={cn(
        "group relative mx-1.5 flex rounded-[calc(var(--radius-md)-2px)] border transition-[background-color,border-color,color]",
        compact ? "items-center gap-2 px-2 py-1.5" : "items-start gap-3 px-3 py-2.5",
        dragHandleProps && "touch-none cursor-grab active:cursor-grabbing",
        active
          ? "chat-conversation-active border-[color:var(--border-strong)] bg-[color:color-mix(in_oklab,var(--surface-active)_90%,var(--surface-elevated))]"
          : "border-transparent hover:border-[color:color-mix(in_oklab,var(--border-soft)_70%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-active)_62%,transparent)]",
        dragging && "opacity-80 shadow-sm ring-1 ring-border/70",
      )}
    >
      {issueStatus ? (
        <IssueStatusThreadAvatar
          status={issueStatus}
          unreadCount={thread.unreadCount}
          needsAttention={thread.needsAttention}
          density={density}
          testId={`${sanitizeThreadKey(thread.threadKey)}-unread-badge`}
        />
      ) : (
        <ThreadAvatar
          icon={Icon}
          unreadCount={thread.unreadCount}
          needsAttention={thread.needsAttention}
          density={density}
          testId={`${sanitizeThreadKey(thread.threadKey)}-unread-badge`}
        />
      )}
      <Link to={thread.href} onClick={() => onSelect(thread.href)} className="block min-w-0 flex-1">
        <span className="min-w-0">
          <span className={cn(
            "grid min-w-0 gap-x-2",
            compact ? "grid-cols-[minmax(0,1fr)_2.75rem] items-center" : "grid-cols-[minmax(0,1fr)_3rem] items-start",
          )}>
            <span
              className={cn(
                "flex min-w-0 items-center gap-2 text-[13px] leading-tight",
                thread.unreadCount > 0 ? "font-semibold text-foreground" : "font-medium text-foreground/92",
              )}
            >
              <span className="truncate">{threadDisplayTitle(thread.title)}</span>
            </span>
            <span
              data-testid={`messenger-time-${sanitizeThreadKey(thread.threadKey)}`}
              className={cn(
                "block shrink-0 whitespace-nowrap text-right text-[10px] leading-none tabular-nums text-muted-foreground transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0",
                compact ? "w-11" : "mt-0.5 w-12",
                (actionsOpen || activeExecutionRunId) && "opacity-0",
              )}
            >
              {thread.latestActivityAt ? relativeTime(new Date(thread.latestActivityAt), { compactDate: true }) : "No activity"}
            </span>
          </span>
          {!compact ? (
            <span
              className={cn(
                "mt-0.5 block truncate text-[12px]",
                thread.unreadCount > 0 ? "text-foreground/76" : "text-muted-foreground",
              )}
            >
              {preview}
            </span>
          ) : null}
        </span>
      </Link>

      {activeExecutionRunId ? (
        <span
          data-testid={`messenger-active-run-${sanitizeThreadKey(thread.threadKey)}`}
          aria-label="Issue run in progress"
          title="Issue run in progress"
          className={cn(
            "pointer-events-none absolute top-1/2 z-10 inline-flex -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0",
            compact ? "right-1.5 h-5 w-5" : "right-2 h-6 w-6",
            actionsOpen && "opacity-0",
          )}
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2.25} aria-hidden />
        </span>
      ) : null}

      {canTogglePin && thread.isPinned ? (
        <button
          type="button"
          data-testid={`messenger-pin-toggle-${sanitizeThreadKey(thread.threadKey)}`}
          className={cn(
            "absolute top-1/2 z-10 -translate-y-1/2 rounded-md p-1 text-[color:var(--accent-strong)] opacity-0 transition-[opacity,background-color,color] duration-150 hover:bg-[color:var(--surface-page)] hover:text-[color:var(--accent-strong)] focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100",
            rightActionClass,
            (actionsOpen || activeExecutionRunId) && "pointer-events-none opacity-0",
          )}
          aria-label="Unpin thread"
          title="Unpin thread"
          onClick={onTogglePin}
        >
          <Pin className="h-3.5 w-3.5" strokeWidth={2.25} />
        </button>
      ) : null}

      {showActions ? (
        <DropdownMenu open={actionsOpen} onOpenChange={setActionsOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                "absolute top-1/2 z-10 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-[opacity,background-color,color] duration-150 hover:bg-[color:var(--surface-page)] hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100",
                canTogglePin && thread.isPinned ? secondaryActionClass : rightActionClass,
                actionsOpen ? "opacity-100" : "opacity-0",
              )}
              aria-label="Thread actions"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="surface-overlay text-foreground">
            {canTogglePin ? (
              <DropdownMenuItem onClick={onTogglePin}>
                {thread.isPinned ? (
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
            ) : null}
            {canHideIssue ? (
              <DropdownMenuItem onClick={onHideIssue}>
                <EyeOff className="h-4 w-4" />
                Hide
              </DropdownMenuItem>
            ) : null}
            {customGroupsEnabled ? (
              <>
                {(canTogglePin || canHideIssue) ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem disabled>
                  <FolderInput className="h-4 w-4" />
                  Chat threads only
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

function SortableThreadSection({
  id,
  children,
}: {
  id: string;
  children: (dragHandleProps: Pick<ReturnType<typeof useSortable>, "attributes" | "listeners">) => ReactNode;
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
      {children({ attributes, listeners })}
    </div>
  );
}

function SortableCustomThreadEntry({
  id,
  children,
}: {
  id: string;
  children: (
    dragHandleProps: Pick<ReturnType<typeof useSortable>, "attributes" | "listeners">,
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
      className={cn("touch-none", isDragging && "relative")}
    >
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
  if (conversation) {
    return {
      ...conversation,
      title: thread.title,
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
    title: thread.title,
    summary: null,
    latestReplyPreview: preview,
    latestUserMessagePreview,
    userMessageCount: 0,
    preferredAgentId,
    routedAgentId,
    primaryIssueId: null,
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
    createdAt: activityAt,
    updatedAt: activityAt,
  };
}

interface OrganizedThreadEntry {
  thread: MessengerThreadSummaryItem;
  conversation: ChatConversation | null;
  customGroupId?: string | null;
}

interface OrganizedThreadSection {
  key: string;
  label: string | null;
  icon?: string | null;
  entries: OrganizedThreadEntry[];
}

function isPinnedEntry(entry: OrganizedThreadEntry) {
  return typeof entry.thread.isPinned === "boolean" ? entry.thread.isPinned : Boolean(entry.conversation?.isPinned);
}

function dedupeThreadSummariesByKey(threadSummaries: MessengerThreadSummaryItem[]) {
  const seen = new Set<string>();
  return threadSummaries.filter((thread) => {
    if (seen.has(thread.threadKey)) return false;
    seen.add(thread.threadKey);
    return true;
  });
}

function dedupeOrganizedThreadEntriesByKey(entries: OrganizedThreadEntry[]) {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.thread.threadKey)) return false;
    seen.add(entry.thread.threadKey);
    return true;
  });
}

function splitIssueThreadWatermark(thread: MessengerThreadSummaryItem) {
  if (thread.metadata?.splitIssue !== true) return null;
  const metadata = thread.metadata as Record<string, unknown>;
  return [
    thread.latestActivityAt ? new Date(thread.latestActivityAt).toISOString() : "none",
    metadataString(metadata, "status") ?? "unknown",
    metadataString(metadata, "activeExecutionRunId") ?? "idle",
    String(thread.unreadCount),
    thread.needsAttention ? "attention" : "settled",
  ].join("|");
}

function threadMatchesMessengerIssueRoute(thread: MessengerThreadSummaryItem, issueRef: string) {
  if (thread.metadata?.splitIssue !== true) return false;
  const metadata = thread.metadata as Record<string, unknown>;
  if (metadata.issueId === issueRef || metadata.issueIdentifier === issueRef) return true;
  const normalizedHref = thread.href.split("?")[0]?.split("#")[0] ?? thread.href;
  return normalizedHref === `/messenger/issues/${issueRef}`;
}

function entryActivityTime(entry: OrganizedThreadEntry) {
  const value = entry.thread.latestActivityAt ?? (entry.conversation?.lastMessageAt ?? entry.conversation?.updatedAt ?? null);
  return value ? new Date(value).getTime() : Number.NEGATIVE_INFINITY;
}

function compareThreadEntries(a: OrganizedThreadEntry, b: OrganizedThreadEntry) {
  if (isPinnedEntry(a) !== isPinnedEntry(b)) return isPinnedEntry(a) ? -1 : 1;
  const timeDiff = entryActivityTime(b) - entryActivityTime(a);
  if (timeDiff !== 0) return timeDiff;
  return a.thread.title.localeCompare(b.thread.title);
}

function sectionActivityTime(section: OrganizedThreadSection) {
  return section.entries.reduce((latest, entry) => Math.max(latest, entryActivityTime(entry)), Number.NEGATIVE_INFINITY);
}

function compareCustomLayoutSections(a: OrganizedThreadSection, b: OrganizedThreadSection) {
  const timeDiff = sectionActivityTime(b) - sectionActivityTime(a);
  if (timeDiff !== 0) return timeDiff;
  return (a.label ?? a.entries[0]?.thread.title ?? a.key).localeCompare(b.label ?? b.entries[0]?.thread.title ?? b.key);
}

function sortCustomLayoutSections(sections: OrganizedThreadSection[], orderedSectionKeys: string[]) {
  if (orderedSectionKeys.length === 0) return sections;
  const sectionByKey = new Map(sections.map((section) => [section.key, section]));
  const manualSections = orderedSectionKeys
    .map((sectionKey) => sectionByKey.get(sectionKey) ?? null)
    .filter((section): section is OrganizedThreadSection => Boolean(section));
  if (manualSections.length === 0) return sections;

  const manualSectionKeys = new Set(manualSections.map((section) => section.key));
  const firstManualBaseIndex = sections.findIndex((section) => manualSectionKeys.has(section.key));
  if (firstManualBaseIndex === -1) return sections;
  return [
    ...sections.slice(0, firstManualBaseIndex).filter((section) => !manualSectionKeys.has(section.key)),
    ...manualSections,
    ...sections.slice(firstManualBaseIndex).filter((section) => !manualSectionKeys.has(section.key)),
  ];
}

function nextDefaultThreadOrderKeysAfterMove(
  sectionKeys: string[],
  currentOrderKeys: string[],
  oldIndex: number,
  newIndex: number,
) {
  const movedThreadKeys = arrayMove(sectionKeys, oldIndex, newIndex);
  const start = Math.min(oldIndex, newIndex);
  const end = Math.max(oldIndex, newIndex);
  const affectedThreadKeys = new Set(movedThreadKeys.slice(start, end + 1));
  const visibleThreadKeys = new Set(sectionKeys);
  const currentOrderKeySet = new Set(currentOrderKeys);
  return [
    ...currentOrderKeys.filter((threadKey) => !visibleThreadKeys.has(threadKey)),
    ...movedThreadKeys.filter((threadKey) => affectedThreadKeys.has(threadKey) || currentOrderKeySet.has(threadKey)),
  ];
}

function entryActivityIsToday(entry: OrganizedThreadEntry, now = new Date()) {
  const activityTime = entryActivityTime(entry);
  if (!Number.isFinite(activityTime)) return false;
  const activityDate = new Date(activityTime);
  return (
    activityDate.getFullYear() === now.getFullYear()
    && activityDate.getMonth() === now.getMonth()
    && activityDate.getDate() === now.getDate()
  );
}

function groupEntries(
  entries: OrganizedThreadEntry[],
  groupForEntry: (entry: OrganizedThreadEntry) => ThreadGroup,
) {
  const sections = new Map<string, { group: ThreadGroup; entries: OrganizedThreadEntry[] }>();
  for (const entry of entries) {
    const group = groupForEntry(entry);
    const existing = sections.get(group.key);
    if (existing) {
      existing.entries.push(entry);
    } else {
      sections.set(group.key, { group, entries: [entry] });
    }
  }
  return Array.from(sections.values())
    .sort((a, b) => {
      if (a.group.key === "attention:needs") return -1;
      if (b.group.key === "attention:needs") return 1;
      if (a.group.key === "project:none") return 1;
      if (b.group.key === "project:none") return -1;
      if (a.group.key === "agent:none") return 1;
      if (b.group.key === "agent:none") return -1;
      if (a.group.key === "system") return 1;
      if (b.group.key === "system") return -1;
      return (a.group.sortLabel ?? a.group.label).localeCompare(b.group.sortLabel ?? b.group.label);
    })
    .map(({ group, entries: sectionEntries }) => ({
      key: group.key,
      label: group.label,
      entries: [...sectionEntries].sort(compareThreadEntries),
    }));
}

function organizeThreadEntries(
  entries: OrganizedThreadEntry[],
  rule: ThreadOrganizationRule,
  agentsById: Map<string, Agent>,
): OrganizedThreadSection[] {
  const sorted = [...entries].sort(compareThreadEntries);
  if (rule === "latest") {
    const pinned = sorted.filter(isPinnedEntry);
    const unpinned = sorted.filter((entry) => !isPinnedEntry(entry));
    const now = new Date();
    const today = unpinned.filter((entry) => entryActivityIsToday(entry, now));
    const recent = unpinned.filter((entry) => !entryActivityIsToday(entry, now));
    const sections = [
      { key: "pinned", label: "Pinned", entries: pinned },
      { key: "today", label: "Today", entries: today },
      { key: "recent", label: "Recent", entries: recent },
    ].filter((section) => section.entries.length > 0);
    if (sections.length === 1 && sections[0]?.key === "recent") return [{ ...sections[0], key: "latest", label: null }];
    return sections;
  }
  if (rule === "project") {
    return groupEntries(sorted, (entry) => {
      const splitIssueProject = splitIssueProjectGroup(entry.thread);
      if (splitIssueProject) return splitIssueProject;
      if (entry.thread.kind !== "chat") return { key: "system", label: "System" };
      return chatProjectGroup(entry.conversation);
    });
  }
  if (rule === "agent") {
    return groupEntries(sorted, (entry) => entryAgentGroup(entry, agentsById));
  }
  if (rule === "kind") {
    return groupEntries(sorted, (entry) => ({
      key: `kind:${entry.thread.kind}`,
      label: messengerThreadKindLabel(entry.thread.kind),
    }));
  }
  return groupEntries(sorted, (entry) => entry.thread.unreadCount > 0 || entry.thread.needsAttention
    ? { key: "attention:needs", label: "Needs attention" }
    : { key: "attention:other", label: "Other threads" });
}

function sectionAttentionCount(section: OrganizedThreadSection) {
  return section.entries.filter((entry) => entry.thread.unreadCount > 0 || entry.thread.needsAttention).length;
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
  const sidebarScrollElementRef = useRef<HTMLElement | null>(null);
  const loadMoreThreadSummariesRef = useRef<HTMLDivElement | null>(null);
  const unreadScrollCursorRef = useRef<string | null>(null);
  const handledUnreadScrollRequestIdRef = useRef(0);
  const unreadLoadMoreRequestRef = useRef<{ requestId: number; loadedCount: number } | null>(null);
  const [renamingConversationId, setRenamingConversationId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [pendingChatRenameTitles, setPendingChatRenameTitles] = useState<Record<string, string>>({});
  const [customGroupEditor, setCustomGroupEditor] = useState<CustomGroupEditorState | null>(null);
  const [customGroupNameDraft, setCustomGroupNameDraft] = useState("");
  const [customGroupIconDraft, setCustomGroupIconDraft] = useState("folder");
  const [customGroupColorDraft, setCustomGroupColorDraft] = useState<CustomGroupColor | null>("amber");
  const [draggingThreadId, setDraggingThreadId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
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
      activationConstraint: { distance: 8 },
    }),
  );

  useEffect(() => {
    setThreadOrganizationRule(readThreadOrganizationRule(model.selectedOrganizationId));
    setThreadDensity(readThreadDensity(model.selectedOrganizationId));
    setSplitIssueNotifications(readSplitIssueNotifications(model.selectedOrganizationId));
    const rule = readThreadOrganizationRule(model.selectedOrganizationId);
    setCollapsedThreadGroupKeys(readCollapsedThreadGroups(model.selectedOrganizationId, rule));
    setVisibleThreadGroupEntryLimits({});
    setPendingChatRenameTitles({});
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

  const chatsQuery = useQuery({
    queryKey: queryKeys.chats.list(model.selectedOrganizationId ?? "__none__", "all"),
    queryFn: () => chatsApi.list(model.selectedOrganizationId!, "all"),
    enabled: !!model.selectedOrganizationId && shouldLoadSidebarConversations,
  });

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(model.selectedOrganizationId ?? "__none__"),
    queryFn: () => agentsApi.list(model.selectedOrganizationId!),
    enabled: !!model.selectedOrganizationId,
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

  const canRegenerateChatTitles = useMemo(() => {
    const profiles = intelligenceProfilesQuery.data ?? [];
    return profiles.some((profile) => profile?.purpose === "lightweight" && profile.status === "configured");
  }, [intelligenceProfilesQuery.data]);

  const customGroups = customGroupsQuery.data?.groups ?? [];
  const defaultCustomGroupLayout = threadOrganizationRule === "latest" || threadOrganizationRule === "custom";
  const effectiveThreadOrganizationRule: ThreadOrganizationRule = defaultCustomGroupLayout
    ? "custom"
    : threadOrganizationRule;
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
    return dedupeThreadSummariesByKey(unhiddenThreads);
  }, [hiddenIssueThreadWatermarks, model.threadSummaries]);

  const customGroupedThreadKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const group of customGroups) {
      for (const entry of group.entries) {
        keys.add(entry.threadKey);
      }
    }
    return keys;
  }, [customGroups]);

  const organizedThreadSections = useMemo(() => {
    const threadSummaries = splitIssueNotifications
      ? visibleThreadSummaries.filter((thread) => thread.threadKey !== "issues")
      : visibleThreadSummaries;
    if (effectiveThreadOrganizationRule === "custom") {
      const customEntriesByThreadKey = new Map<string, OrganizedThreadEntry>();
      const groupSections = customGroups.map((group) => {
        const entries = group.entries.map((entry) => {
          const conversationId = threadConversationId(entry.threadKey);
          const pendingTitle = conversationId ? pendingChatRenameTitles[conversationId] : undefined;
          const displayThread = pendingTitle ? { ...entry.thread, title: pendingTitle } : entry.thread;
          const organizedEntry = {
            thread: displayThread,
            conversation: model.selectedOrganizationId
              ? chatConversationForThreadSummary(displayThread, model.selectedOrganizationId, conversationsById.get(conversationId ?? "") ?? null)
              : null,
            customGroupId: group.id,
          } satisfies OrganizedThreadEntry;
          customEntriesByThreadKey.set(entry.threadKey, organizedEntry);
          return organizedEntry;
        });
        return {
          key: customGroupSectionKey(group.id),
          label: group.name,
          icon: group.icon,
          entries,
        } satisfies OrganizedThreadSection;
      });
      const ungroupedEntries = threadSummaries
        .filter((thread) => !customGroupedThreadKeys.has(thread.threadKey))
        .map((thread) => {
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
        })
        .sort(compareThreadEntries);
      const allCustomEntries = dedupeOrganizedThreadEntriesByKey([
        ...customEntriesByThreadKey.values(),
        ...ungroupedEntries,
      ]);
      const pinnedEntries = allCustomEntries
        .filter((entry) => isPinnedEntry(entry) && entry.customGroupId === null)
        .sort(compareThreadEntries);
      const ungroupedSections = ungroupedEntries
        .filter((entry) => !isPinnedEntry(entry))
        .map((entry) => ({
          key: entry.thread.threadKey,
          label: null,
          entries: [entry],
        }) satisfies OrganizedThreadSection);
      const topLevelSections = sortCustomLayoutSections(
        [...groupSections, ...ungroupedSections].sort(compareCustomLayoutSections),
        defaultThreadOrderKeys,
      );
      return [
        ...(pinnedEntries.length > 0 ? [{ key: "custom:pinned", label: "Pinned", entries: pinnedEntries }] : []),
        ...topLevelSections,
      ];
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
    const sections = organizeThreadEntries(entries, effectiveThreadOrganizationRule, agentsById);
    return isManagedThreadGroupRule(effectiveThreadOrganizationRule)
      ? sortManagedThreadSections(sections, effectiveThreadOrganizationRule, projectOrderIds, threadSectionOrderIds)
      : sections;
  }, [agentsById, conversationsById, customGroupedThreadKeys, customGroups, defaultThreadOrderKeys, effectiveThreadOrganizationRule, model.selectedOrganizationId, pendingChatRenameTitles, projectOrderIds, threadSectionOrderIds, splitIssueNotifications, visibleThreadSummaries]);
  const customEntryGroupByThreadKey = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const group of customGroups) {
      for (const entry of group.entries) {
        map.set(entry.threadKey, group.id);
      }
    }
    if (effectiveThreadOrganizationRule === "custom") {
      for (const section of organizedThreadSections) {
        for (const entry of section.entries) {
          if (entry.customGroupId === null) map.set(entry.thread.threadKey, null);
        }
      }
    }
    return map;
  }, [customGroups, effectiveThreadOrganizationRule, organizedThreadSections]);
  const unreadThreadTargets = useMemo<UnreadThreadTarget[]>(() => {
    const targets: UnreadThreadTarget[] = [];
    for (const section of organizedThreadSections) {
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
      .map((section) => section.key)
  ), [effectiveThreadOrganizationRule, organizedThreadSections]);
  const threadSectionRequiredVisibleCounts = useMemo(() => {
    if (!isManagedThreadGroupRule(effectiveThreadOrganizationRule) || !activeThreadKey) return new Map<string, number>();
    const required = new Map<string, number>();
    for (const section of organizedThreadSections) {
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
    mutationFn: ({ name, icon }: { name: string; icon: string | null; threadKey?: string; threadKeys?: string[] }) => {
      if (!model.selectedOrganizationId) throw new Error("Organization is required to create a Messenger group");
      return messengerApi.createCustomGroup(model.selectedOrganizationId, { name, icon });
    },
    onSuccess: async (group, variables) => {
      if (model.selectedOrganizationId) {
        handleThreadOrganizationRuleChange("latest");
        const threadKeys = variables.threadKeys ?? (variables.threadKey ? [variables.threadKey] : []);
        for (const threadKey of [...new Set(threadKeys)]) {
          await messengerApi.assignCustomGroupEntry(model.selectedOrganizationId, group.id, threadKey);
        }
      }
      await refreshCustomGroups();
    },
  });

  const updateCustomGroupMutation = useMutation({
    mutationFn: ({ groupId, data }: { groupId: string; data: { name?: string; icon?: string | null; collapsed?: boolean; sortOrder?: number } }) => {
      if (!model.selectedOrganizationId) throw new Error("Organization is required to update a Messenger group");
      return messengerApi.updateCustomGroup(model.selectedOrganizationId, groupId, data);
    },
    onSuccess: refreshCustomGroups,
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
    setDraggingThreadId(null);
    setDragOverId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    if (!isManagedThreadGroupRule(effectiveThreadOrganizationRule)) return;

    if (effectiveThreadOrganizationRule === "custom") {
      const activeThreadKey = String(active.id);
      const overThreadKey = String(over.id);
      const topLevelSectionKeys = organizedThreadSections
        .filter((section) => section.key !== "custom:pinned")
        .map((section) => section.key);
      const persistTopLevelOrder = (sectionKeys: string[], oldIndex: number, newIndex: number) => {
        if (!defaultThreadOrderStorageKey) return;
        const nextOrderKeys = nextDefaultThreadOrderKeysAfterMove(sectionKeys, defaultThreadOrderKeys, oldIndex, newIndex);
        setDefaultThreadOrderKeys(nextOrderKeys);
        writeStringList(defaultThreadOrderStorageKey, nextOrderKeys);
      };
      const activeIsThread = customEntryGroupByThreadKey.has(activeThreadKey);
      const overIsThread = customEntryGroupByThreadKey.has(overThreadKey);
      const overSection = organizedThreadSections.find((section) => section.key === overThreadKey);
      const activeEntry = organizedThreadSections
        .flatMap((section) => section.entries)
        .find((entry) => entry.thread.threadKey === activeThreadKey) ?? null;
      const overEntry = organizedThreadSections
        .flatMap((section) => section.entries)
        .find((entry) => entry.thread.threadKey === overThreadKey) ?? null;
      const activeGroupId = customEntryGroupByThreadKey.get(activeThreadKey) ?? null;
      const overEntryGroupId = overIsThread ? customEntryGroupByThreadKey.get(overThreadKey) ?? null : undefined;
      const overGroupId = customGroupIdFromSectionKey(overThreadKey) ?? overEntryGroupId;
      if (
        activeIsThread
        && overIsThread
        && activeGroupId === null
        && overEntryGroupId === null
        && activeEntry?.thread.kind === "chat"
        && overEntry?.thread.kind === "chat"
        && activeThreadKey !== overThreadKey
      ) {
        createCustomGroupMutation.mutate({
          name: overEntry?.thread.title ? threadDisplayTitle(overEntry.thread.title) : "New group",
          icon: composeCustomGroupIconValue("folder", "amber"),
          threadKeys: [overThreadKey, activeThreadKey],
        });
        return;
      }
      if (
        activeIsThread
        && overIsThread
        && activeGroupId
        && overEntryGroupId === null
        && activeEntry?.thread.kind === "chat"
        && overEntry?.thread.kind === "chat"
        && activeThreadKey !== overThreadKey
      ) {
        assignCustomGroupEntryMutation.mutate({ groupId: activeGroupId, threadKey: overThreadKey });
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
            if (activeEntry?.thread.kind !== "chat") return;
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
      if (
        !activeIsThread
        && overEntry?.thread.kind === "chat"
        && (overSection?.entries.length === 1 || overEntryGroupId === null)
      ) {
        const activeGroupId = customGroupIdFromSectionKey(activeThreadKey);
        if (activeGroupId) {
          assignCustomGroupEntryMutation.mutate({ groupId: activeGroupId, threadKey: overEntry.thread.threadKey });
          return;
        }
      }
    }

    const sectionKeys = effectiveThreadOrganizationRule === "custom"
      ? organizedThreadSections
        .filter((section) => section.key !== "custom:pinned")
        .map((section) => section.key)
      : organizedThreadSections.map((section) => section.key);
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
  }, [assignCustomGroupEntryMutation, createCustomGroupMutation, customEntryGroupByThreadKey, defaultThreadOrderKeys, defaultThreadOrderStorageKey, effectiveThreadOrganizationRule, messengerThreadGroupOrderStorageKey, organizedThreadSections, projectOrderIds, projectOrderStorageKey, removeCustomGroupEntryMutation, reorderCustomGroupEntriesMutation, reorderCustomGroupsMutation]);

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

  const openCreateCustomGroupEditor = (threadKey?: string) => {
    setCustomGroupEditor({ mode: "create", threadKey });
    setCustomGroupNameDraft("");
    setCustomGroupIconDraft("folder");
    setCustomGroupColorDraft("amber");
  };

  const openEditCustomGroupEditor = (group: MessengerCustomGroupWithEntries) => {
    const parsedIcon = splitCustomGroupIconValue(group.icon);
    setCustomGroupEditor({ mode: "edit", group });
    setCustomGroupNameDraft(group.name);
    setCustomGroupIconDraft(parsedIcon.glyph);
    setCustomGroupColorDraft(parsedIcon.color ?? customGroupColorFor(group));
  };

  const closeCustomGroupEditor = () => {
    setCustomGroupEditor(null);
    setCustomGroupNameDraft("");
    setCustomGroupIconDraft("folder");
    setCustomGroupColorDraft("amber");
  };

  const submitCustomGroupEditor = () => {
    if (!customGroupEditor) return;
    const name = customGroupNameDraft.trim();
    if (!name) return;
    const icon = composeCustomGroupIconValue(customGroupIconDraft, customGroupColorDraft);
    if (customGroupEditor.mode === "create") {
      createCustomGroupMutation.mutate({
        name,
        icon: icon || null,
        threadKey: customGroupEditor.threadKey,
      });
    } else {
      updateCustomGroupMutation.mutate({
        groupId: customGroupEditor.group.id,
        data: { name, icon: icon || null },
      });
    }
    closeCustomGroupEditor();
  };

  const handleCreateCustomGroup = (threadKey?: string) => {
    openCreateCustomGroupEditor(threadKey);
  };

  const handleEditCustomGroup = (group: MessengerCustomGroupWithEntries) => {
    openEditCustomGroupEditor(group);
  };

  const handleSeparateCustomGroup = async (group: MessengerCustomGroupWithEntries) => {
    const confirmed = await confirm({
      title: "Separate tabs",
      description: `Move the tabs in "${group.name}" back into the main list? The chats will stay intact.`,
      confirmLabel: "Separate tabs",
      tone: "default",
    });
    if (!confirmed) return;
    separateCustomGroupMutation.mutate(group.id);
  };

  const renderThreadEntry = (
    entry: OrganizedThreadEntry,
    dragHandleProps?: Pick<ReturnType<typeof useSortable>, "attributes" | "listeners">,
    dragging = false,
  ) => {
    const { thread, conversation } = entry;
    const active = activeThreadKey === thread.threadKey;
    if (thread.kind === "chat" && conversation) {
      const agentId = resolveChatAgentId(conversation);
      return (
        <ChatThreadRow
          key={thread.threadKey}
          conversation={conversation}
          agent={agentId ? agentsById.get(agentId) ?? null : null}
          agentId={agentId}
          href={thread.href}
          active={active}
          generating={isChatGenerationActive(conversation.id)}
          density={threadDensity}
          renaming={renamingConversationId === conversation.id}
          renameDraft={renameDraft}
          onRenameDraftChange={setRenameDraft}
          onCommitRename={submitRename}
          onStartRename={() => {
            setRenamingConversationId(conversation.id);
            setRenameDraft(conversation.title);
          }}
          onRegenerateTitle={canRegenerateChatTitles ? () => regenerateTitleMutation.mutate(conversation.id) : undefined}
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
          onMoveToCustomGroup={(groupId) => assignCustomGroupEntryMutation.mutate({ groupId, threadKey: thread.threadKey })}
          onRemoveFromCustomGroup={() => removeCustomGroupEntryMutation.mutate(thread.threadKey)}
          onCreateCustomGroup={() => handleCreateCustomGroup(thread.threadKey)}
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
        customGroupsEnabled={false}
        dragHandleProps={dragHandleProps}
        dragging={dragging}
        onSelect={handleMessengerEntrySelect}
      />
    );
  };

  const renderThreadSection = (
    section: OrganizedThreadSection,
    dragHandleProps?: Pick<ReturnType<typeof useSortable>, "attributes" | "listeners">,
  ) => {
    const isManagedSection = isManagedThreadGroupRule(effectiveThreadOrganizationRule);
    const customGroup = effectiveThreadOrganizationRule === "custom" ? customGroupBySectionKey.get(section.key) ?? null : null;
    const collapsed = customGroup ? customGroup.collapsed : isManagedSection && collapsedThreadGroupKeys.has(section.key);
    const draggingEntryGroupId = draggingThreadId ? customEntryGroupByThreadKey.get(draggingThreadId) : undefined;
    const dragOverThisSection = dragOverId === section.key || section.entries.some((entry) => entry.thread.threadKey === dragOverId);
    const isMergeTarget = effectiveThreadOrganizationRule === "custom"
      && Boolean(customGroup)
      && Boolean(draggingThreadId)
      && draggingEntryGroupId !== undefined
      && draggingEntryGroupId !== customGroup?.id
      && dragOverThisSection;
    const isStandaloneDropTarget = effectiveThreadOrganizationRule === "custom"
      && !customGroup
      && section.label === null
      && dragOverThisSection
      && draggingThreadId !== section.key;
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
    const canSortCustomEntries = effectiveThreadOrganizationRule === "custom"
      && (Boolean(customGroup) || isPinnedCustomSection)
      && (visibleEntries.length > 1 || isPinnedCustomSection);
    const canDragStandaloneCustomEntry = effectiveThreadOrganizationRule === "custom"
      && !customGroup
      && (section.label === null || isPinnedCustomSection)
      && visibleEntries.length === 1;
    const renderedEntries = canSortCustomEntries ? (
      <SortableContext
        items={visibleEntries.map((entry) => entry.thread.threadKey)}
        strategy={verticalListSortingStrategy}
      >
        {visibleEntries.map((entry) => (
          <SortableCustomThreadEntry key={entry.thread.threadKey} id={entry.thread.threadKey}>
            {(dragHandlePropsForEntry, dragging) => renderThreadEntry(entry, dragHandlePropsForEntry, dragging)}
          </SortableCustomThreadEntry>
        ))}
      </SortableContext>
    ) : (
      visibleEntries.map((entry) => renderThreadEntry(entry, canDragStandaloneCustomEntry ? dragHandleProps : undefined))
    );
    const sectionBody = (
      <>
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

    if (section.label && customGroup) {
      const attentionCount = sectionAttentionCount(section);
      return (
        <div
          data-testid={`messenger-thread-section-${sanitizeThreadKey(section.key)}`}
          data-drag-merge-target={isMergeTarget ? "true" : undefined}
          className={cn(
            "mx-1.5 rounded-[calc(var(--radius-md)-1px)] border p-1.5 text-[color:var(--messenger-group-text)] shadow-[0_8px_20px_-18px_rgba(15,23,42,0.45)] transition-[background-color,border-color,box-shadow] duration-200 bg-[color:var(--messenger-group-bg)] border-[color:var(--messenger-group-border)] hover:bg-[color:var(--messenger-group-bg-hover)] hover:shadow-[0_12px_24px_-18px_rgba(15,23,42,0.62)] dark:bg-[color:var(--messenger-group-bg-dark)] dark:text-[color:var(--messenger-group-text-dark)] dark:border-[color:var(--messenger-group-border-dark)] dark:hover:bg-[color:var(--messenger-group-bg-hover-dark)]",
            isMergeTarget && "bg-[color:var(--messenger-group-bg-hover)] shadow-[0_16px_30px_-18px_rgba(15,23,42,0.75)] ring-2 ring-[color:color-mix(in_oklab,var(--messenger-group-text)_34%,transparent)]",
          )}
          style={customGroupStyle(customGroup)}
        >
          <div className="flex min-h-7 items-center gap-1.5">
            <button
              type="button"
              {...dragHandleProps?.attributes}
              {...dragHandleProps?.listeners}
              aria-expanded={!collapsed}
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[calc(var(--radius-sm)-2px)] px-0.5 text-left text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
              onClick={() => handleThreadGroupToggle(section.key)}
            >
              {collapsed ? (
                <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />
              ) : (
                <ChevronDown className="h-3 w-3 shrink-0" aria-hidden />
              )}
              <CustomGroupIcon icon={customGroup.icon} />
              <span className="min-w-0 flex-1 truncate">{section.label}</span>
              {attentionCount > 0 ? (
                <span
                  data-testid={`messenger-thread-section-${sanitizeThreadKey(section.key)}-attention-count`}
                  className="shrink-0 rounded-full bg-white/45 px-1.5 py-0.5 text-[10px] font-semibold"
                >
                  {attentionCount}
                </span>
              ) : null}
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Group actions"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] text-current/70 transition-[background-color,color] hover:bg-white/45 hover:text-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="surface-overlay text-foreground">
                <DropdownMenuItem onClick={() => handleEditCustomGroup(customGroup)}>
                  <PencilLine className="h-4 w-4" />
                  Edit group
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void handleSeparateCustomGroup(customGroup)}>
                  <FolderInput className="h-4 w-4" />
                  Separate tabs
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {collapsed ? (
            <div
              data-testid={sectionContentTestId}
              className="grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] duration-150 ease-out"
              aria-hidden="true"
              inert
            >
              <div className="min-h-0 overflow-hidden">
                {sectionBody}
              </div>
            </div>
          ) : (
            <div
              data-testid={sectionContentTestId}
              className="mt-1 block opacity-100 transition-opacity duration-150 ease-out"
            >
              {sectionBody}
            </div>
          )}
        </div>
      );
    }

    if (!section.label && isStandaloneDropTarget) {
      return (
        <div
          data-drag-drop-target="true"
          className="rounded-[calc(var(--radius-md)-1px)] ring-2 ring-[color:color-mix(in_oklab,var(--accent-strong)_30%,transparent)] ring-offset-1 ring-offset-[color:var(--surface-page)] transition-[box-shadow,transform] duration-150"
        >
          {sectionBody}
        </div>
      );
    }

    return (
      <>
        {section.label ? (
          isManagedSection ? (() => {
            const attentionCount = sectionAttentionCount(section);
            return (
              <button
                type="button"
                {...dragHandleProps?.attributes}
                {...dragHandleProps?.listeners}
                data-testid={`messenger-thread-section-${sanitizeThreadKey(section.key)}`}
                aria-expanded={!collapsed}
                className="mx-1.5 flex min-h-8 items-center gap-1.5 rounded-[calc(var(--radius-sm)-1px)] px-1.5 py-1.5 text-left text-[11px] font-semibold text-muted-foreground/72 transition-[background-color,color] hover:bg-[color:color-mix(in_oklab,var(--surface-active)_54%,transparent)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
                onClick={() => handleThreadGroupToggle(section.key)}
              >
                {collapsed ? (
                  <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />
                ) : (
                  <ChevronDown className="h-3 w-3 shrink-0" aria-hidden />
                )}
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
        {collapsed ? (
          <div
            data-testid={sectionContentTestId}
            className="grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] duration-150 ease-out"
            aria-hidden="true"
            inert
          >
            <div className="min-h-0 overflow-hidden">
              {sectionBody}
            </div>
          </div>
        ) : (
          <div
            data-testid={sectionContentTestId}
            className="block opacity-100 transition-opacity duration-150 ease-out"
          >
            {sectionBody}
          </div>
        )}
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
    onSuccess: async (conversation) => {
      if (model.selectedOrganizationId) {
        renameMessengerChatInCache(queryClient, model.selectedOrganizationId, conversation.id, conversation.title);
      }
      await refreshChatViews(conversation.id);
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
    if (!activeThread || activeThread.unreadCount === 0) return;
    if (!activeThreadDetailReady) return;

    const orgId = model.selectedOrganizationId;
    const watermark = activeThreadReadAt ?? activeThread.latestActivityAt ?? "none";
    const marker = `${orgId}:${activeThreadKey}:${watermark}`;
    if (markedThreadRef.current === marker) return;
    markedThreadRef.current = marker;

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
        onCreateCustomGroup={handleCreateCustomGroup}
      />
      {customGroupEditor ? (
        <CustomGroupEditor
          state={customGroupEditor}
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
      ) : null}
      <nav
        ref={setSidebarScrollRef}
        className="scrollbar-auto-hide mt-2 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1.5 pb-3.5"
      >
        <Link
          to="/messenger/chat"
          onClick={() => handleMessengerEntrySelect("/messenger/chat")}
          className={cn(
            "mx-1.5 flex items-center rounded-[calc(var(--radius-md)-2px)] border border-transparent text-sm transition-[background-color,border-color,color]",
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
              collisionDetection={closestCenter}
              onDragStart={(event) => {
                setDraggingThreadId(String(event.active.id));
                setDragOverId(null);
              }}
              onDragOver={(event) => {
                setDragOverId(event.over ? String(event.over.id) : null);
              }}
              onDragCancel={() => {
                setDraggingThreadId(null);
                setDragOverId(null);
              }}
              onDragEnd={handleThreadSectionDragEnd}
            >
              <SortableContext
                items={sortableThreadSectionKeys}
                strategy={verticalListSortingStrategy}
              >
                {organizedThreadSections.map((section) => (
                  sortableThreadSectionKeys.includes(section.key) ? (
                    <SortableThreadSection key={section.key} id={section.key}>
                      {(dragHandleProps) => renderThreadSection(section, dragHandleProps)}
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
            ) : null}
          </div>
        ) : null}
      </nav>
    </aside>
  );
}
