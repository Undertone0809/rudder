import { messengerSavedViewRoute } from "@/lib/messenger-saved-views";
import { Link } from "@/lib/router";
import type {
  MessengerCustomGroupHydratedSavedViewEntry,
  MessengerCustomGroupWithEntries,
} from "@rudderhq/shared";
import { FileText, FolderInput, Globe2, MoreHorizontal, Trash2, Workflow } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

function SavedViewIcon({ entry }: { entry: MessengerCustomGroupHydratedSavedViewEntry }) {
  const kind = entry.item.savedView.targetPayload.kind;
  if (kind === "browser") return <Globe2 className="h-3.5 w-3.5" aria-hidden />;
  if (kind === "automation") return <Workflow className="h-3.5 w-3.5" aria-hidden />;
  return <FileText className="h-3.5 w-3.5" aria-hidden />;
}

export function MessengerSavedViewRow({
  currentGroupId,
  entry,
  groups,
  onMove,
  onRemove,
}: {
  currentGroupId: string;
  entry: MessengerCustomGroupHydratedSavedViewEntry;
  groups: MessengerCustomGroupWithEntries[];
  onMove: (groupId: string, itemKey: string) => void;
  onRemove: (savedViewId: string) => void;
}) {
  const savedView = entry.item.savedView;
  const otherGroups = groups.filter((group) => group.id !== currentGroupId);

  return (
    <div
      data-testid={`messenger-saved-view-${entry.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`}
      className="group/saved-view flex min-w-0 items-center gap-1 rounded-[calc(var(--radius-md)-2px)] px-1 py-0.5 text-[color:var(--messenger-group-entry-text)] dark:text-[color:var(--messenger-group-entry-text-dark)]"
    >
      <Link
        to={messengerSavedViewRoute(savedView.id)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-[calc(var(--radius-sm)-1px)] px-1.5 py-1.5 text-left transition-colors hover:bg-white/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25 dark:hover:bg-white/10"
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] bg-white/45 text-current/75 dark:bg-white/10">
          <SavedViewIcon entry={entry} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-medium leading-4">{savedView.title}</span>
          {savedView.subtitle ? (
            <span className="block truncate text-[10px] leading-3.5 text-current/60">{savedView.subtitle}</span>
          ) : null}
        </span>
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Saved View actions for ${savedView.title}`}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] text-current/65 opacity-0 transition-[opacity,background-color] hover:bg-white/40 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25 group-hover/saved-view:opacity-100 group-focus-within/saved-view:opacity-100 data-[state=open]:opacity-100 dark:hover:bg-white/10"
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
                <DropdownMenuItem key={group.id} onClick={() => onMove(group.id, entry.itemKey)}>
                  {group.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
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
