import type { MessengerThreadDensity } from "@/lib/messenger-preferences";
import { messengerSavedViewRoute } from "@/lib/messenger-saved-views";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import type {
  MessengerCustomGroupHydratedSavedViewEntry,
  MessengerCustomGroupWithEntries,
  MessengerSavedView,
} from "@rudderhq/shared";
import {
  AppWindow,
  BookOpenText,
  File,
  Folder,
  FolderInput,
  Globe2,
  MoreHorizontal,
  Trash2,
  Workflow,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  MessengerDragHandle,
  type SortableDragHandleProps,
} from "./MessengerThreadListViews";

const MAX_SAVED_VIEW_FAVICON_LENGTH = 8_192;

function acceptedBrowserFavicon(value: string | null) {
  if (!value || value.length > MAX_SAVED_VIEW_FAVICON_LENGTH) return null;
  if (/^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(value)) return value;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function browserTitleWithoutUrls(value: string) {
  const withoutSchemeUrls = value.replace(
    /(?:https?:\/\/|file:\/\/\/|(?:data|javascript):)[^\s<>"']+/gi,
    (token) => {
      if (/^file:/i.test(token)) return "Local file";
      if (/^(?:data|javascript):/i.test(token)) return "Web page";
      try {
        return new URL(token).host || "Web page";
      } catch {
        return "Web page";
      }
    },
  );
  const withoutProtocolRelativeUrls = withoutSchemeUrls.replace(
    /\/\/((?:localhost|(?:\d{1,3}\.){3}\d{1,3}|(?:[a-z0-9-]+\.)+[a-z0-9-]{2,})(?::\d+)?)(?:[/?#][^\s<>"']*)?/gi,
    "$1",
  );
  return withoutProtocolRelativeUrls.replace(
    /\b((?:localhost|(?:\d{1,3}\.){3}\d{1,3}|(?:[a-z0-9-]+\.)+[a-z0-9-]{2,})(?::\d+)?)(?:[/?#][^\s<>"']*)?/gi,
    "$1",
  );
}

export function savedViewDisplayTitle(
  source: MessengerCustomGroupHydratedSavedViewEntry | MessengerSavedView,
) {
  const savedView = "item" in source ? source.item.savedView : source;
  const rawTitle = savedView.title.trim();
  if (savedView.targetPayload.kind !== "browser") {
    return rawTitle || "Saved View";
  }
  try {
    const titleUrl = new URL(rawTitle);
    if (titleUrl.protocol === "http:" || titleUrl.protocol === "https:") {
      return titleUrl.hostname || "Web page";
    }
  } catch {
    // A normal page title is preferred as-is.
  }
  const safeTitle = browserTitleWithoutUrls(rawTitle).trim();
  if (safeTitle) return safeTitle;
  try {
    return new URL(savedView.targetPayload.url).hostname || "Web page";
  } catch {
    return "Web page";
  }
}

function SavedViewIcon({ savedView }: { savedView: MessengerSavedView }) {
  const kind = savedView.targetPayload.kind;
  const acceptedFavicon = kind === "browser" ? acceptedBrowserFavicon(savedView.favicon) : null;
  const [faviconFailed, setFaviconFailed] = useState(false);

  useEffect(() => {
    setFaviconFailed(false);
  }, [acceptedFavicon]);

  if (kind === "browser" && acceptedFavicon && !faviconFailed) {
    return (
      <img
        alt=""
        className="h-4 w-4 rounded-[3px] object-contain"
        data-testid="messenger-saved-view-browser-favicon"
        referrerPolicy="no-referrer"
        src={acceptedFavicon}
        onError={() => setFaviconFailed(true)}
      />
    );
  }
  if (kind === "browser") {
    return (
      <Globe2
        className="h-3.5 w-3.5"
        data-testid="messenger-saved-view-browser-fallback-icon"
        aria-hidden
      />
    );
  }
  if (kind === "automation") {
    return (
      <Workflow
        className="h-3.5 w-3.5"
        data-testid="messenger-saved-view-automation-icon"
        aria-hidden
      />
    );
  }
  if (kind === "local_app") {
    return <AppWindow className="h-3.5 w-3.5" data-testid="messenger-saved-view-local-app-icon" aria-hidden />;
  }
  if (kind === "library_directory") {
    return (
      <Folder
        className="h-3.5 w-3.5"
        data-testid="messenger-saved-view-folder-icon"
        aria-hidden
      />
    );
  }
  if (kind === "library_document") {
    return (
      <BookOpenText
        className="h-3.5 w-3.5"
        data-testid="messenger-saved-view-document-icon"
        aria-hidden
      />
    );
  }
  return (
    <File
      className="h-3.5 w-3.5"
      data-testid="messenger-saved-view-file-icon"
      aria-hidden
    />
  );
}

export function MessengerSavedViewRow({
  active = false,
  currentGroupId,
  density,
  dragHandleProps,
  dragging = false,
  entry,
  itemKey,
  savedView: looseSavedView,
  groups,
  onMove,
  onMoveToSidebar,
  onRemove,
  placementPending = false,
}: {
  active?: boolean;
  currentGroupId: string | null;
  density: MessengerThreadDensity;
  dragHandleProps?: SortableDragHandleProps;
  dragging?: boolean;
  entry?: MessengerCustomGroupHydratedSavedViewEntry;
  itemKey?: string;
  savedView?: MessengerSavedView;
  groups: MessengerCustomGroupWithEntries[];
  onMove: (groupId: string, itemKey: string) => void;
  onMoveToSidebar?: (itemKey: string) => void;
  onRemove: (savedViewId: string) => void;
  placementPending?: boolean;
}) {
  const savedView = entry?.item.savedView ?? looseSavedView;
  if (!savedView) return null;
  const resolvedItemKey = entry?.itemKey ?? itemKey ?? `saved-view:${savedView.id}`;
  const rowId = entry?.id ?? `loose-${savedView.id}`;
  const otherGroups = groups.filter((group) => group.id !== currentGroupId);
  const compact = density === "compact";
  const browser = savedView.targetPayload.kind === "browser";
  const displayTitle = savedViewDisplayTitle(savedView);

  return (
    <div
      data-testid={`messenger-saved-view-${rowId.replace(/[^a-zA-Z0-9_-]/g, "-")}`}
      data-messenger-saved-view-id={savedView.id}
      data-active={active ? "true" : "false"}
      aria-busy={placementPending || undefined}
      aria-label={displayTitle}
      title={displayTitle}
      className={cn(
        "group relative flex min-w-0 [contain-intrinsic-size:auto_44px] [content-visibility:auto] rounded-[calc(var(--radius-md)-2px)] border text-[color:var(--messenger-group-entry-text)] transition-[background-color,border-color,color] dark:text-[color:var(--messenger-group-entry-text-dark)]",
        compact ? "items-center gap-2 px-1.5 py-1.5" : "items-start gap-3 px-2 py-2.5",
        active
          ? "chat-conversation-active border-[color:var(--border-strong)] bg-[color:color-mix(in_oklab,var(--surface-active)_90%,var(--surface-elevated))]"
          : "border-transparent hover:border-[color:color-mix(in_oklab,var(--border-soft)_70%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-active)_62%,transparent)]",
        dragging && "opacity-80 shadow-sm ring-1 ring-border/70",
      )}
    >
      <MessengerDragHandle
        compact={compact}
        dragHandleProps={placementPending ? undefined : dragHandleProps}
        label={`Drag ${displayTitle}`}
      />
      <Link
        to={messengerSavedViewRoute(savedView.id)}
        aria-current={active ? "page" : undefined}
        aria-label={displayTitle}
        title={displayTitle}
        className={cn(
          "flex min-w-0 flex-1 pr-7 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25",
          compact ? "items-center gap-2" : "items-start gap-3",
        )}
      >
        <span
          className={cn(
            "flex shrink-0 items-center justify-center rounded-full border border-[color:color-mix(in_oklab,var(--border-soft)_88%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-active)_82%,transparent)] text-current/75",
            compact ? "h-7 w-7" : "mt-0.5 h-10 w-10",
          )}
        >
          <SavedViewIcon savedView={savedView} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium leading-tight text-current/88">
            {displayTitle}
          </span>
          {!compact && !browser && savedView.subtitle ? (
            <span className="mt-0.5 block truncate text-[12px] text-current/62">{savedView.subtitle}</span>
          ) : null}
        </span>
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Saved View actions for ${displayTitle}`}
            disabled={placementPending}
            className={cn(
              "absolute top-1/2 right-1.5 z-10 flex -translate-y-1/2 items-center justify-center rounded-md p-1 text-current/65 opacity-0 transition-[opacity,background-color,color] hover:bg-white/40 hover:text-current focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100 dark:hover:bg-white/10",
              compact ? "h-5 w-5" : "h-6 w-6",
            )}
          >
            <MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="surface-overlay text-foreground">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={otherGroups.length === 0}>
              <FolderInput className="h-4 w-4" />
              Move to group
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="surface-overlay text-foreground">
              {otherGroups.map((group) => (
                <DropdownMenuItem key={group.id} onClick={() => onMove(group.id, resolvedItemKey)}>
                  {group.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {currentGroupId && onMoveToSidebar ? (
            <DropdownMenuItem onClick={() => onMoveToSidebar(resolvedItemKey)}>
              <FolderInput className="h-4 w-4" />
              Move to Messenger sidebar
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => onRemove(savedView.id)}
          >
            <Trash2 className="h-4 w-4" />
            Remove from Messenger
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
