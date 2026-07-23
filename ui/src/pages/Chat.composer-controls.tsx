import { AgentIcon } from "@/components/AgentIconPicker";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { SkillMentionOption } from "@/lib/agent-skill-mentions";
import { cn } from "@/lib/utils";
import type { Agent } from "@rudderhq/shared";
import { Boxes, Loader2, Paperclip, Plus } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { ChatPlanModeMenuToggle } from "./Chat.plan-mode-controls";

export function ChatComposerOptionsMenu({
  open,
  onOpenChange,
  onAddFiles,
  planMode,
  onPlanModeChange,
  planModeDisabled = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAddFiles: () => void;
  planMode: boolean;
  onPlanModeChange: (active: boolean) => void;
  planModeDisabled?: boolean;
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        type="button"
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-active)_52%,transparent)] text-sm font-medium text-foreground transition-colors hover:bg-[color:var(--surface-active)] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40"
        aria-label="Add files and options"
      >
        <Plus className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={8}
        className="surface-overlay w-80 max-w-[calc(100vw-2rem)] rounded-[var(--radius-lg)] border p-1.5 text-foreground"
      >
        <DropdownMenuItem
          className="rounded-[var(--radius-md)] px-3 py-2.5"
          onSelect={(event) => {
            event.preventDefault();
            onOpenChange(false);
            window.setTimeout(onAddFiles, 0);
          }}
        >
          <Paperclip className="mr-2 h-4 w-4" />
          Add files
        </DropdownMenuItem>
        <ChatPlanModeMenuToggle
          active={planMode}
          disabled={planModeDisabled}
          onChange={onPlanModeChange}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ChatLockedContextChip({
  ariaLabel,
  icon,
  label,
  testId,
  title,
}: {
  ariaLabel: string;
  icon?: ReactNode;
  label: string;
  testId?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      className="chat-chip inline-flex max-w-[min(100%,16rem)] min-w-0 cursor-default items-center gap-1.5 rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium"
      data-testid={testId}
      disabled
      title={title}
    >
      {icon}
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

export function ChatLockedAgentChip({
  agent,
  fallbackSeed,
  iconTestId,
  label,
  testId,
}: {
  agent: Pick<Agent, "icon" | "role"> | null | undefined;
  fallbackSeed?: string | null;
  iconTestId?: string;
  label: string;
  testId?: string;
}) {
  return (
    <ChatLockedContextChip
      ariaLabel={`Agent: ${label}`}
      icon={(
        <span
          aria-hidden="true"
          className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted-foreground"
          data-testid={iconTestId}
        >
          <AgentIcon
            icon={agent?.icon}
            role={agent?.role}
            fallbackSeed={fallbackSeed}
            className="h-3.5 w-3.5"
          />
        </span>
      )}
      label={label}
      testId={testId}
      title="Agent is inherited from the conversation."
    />
  );
}

export function ChatSkillsButton({
  open,
  onClick,
}: {
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "chat-chip inline-flex max-w-[min(100%,16rem)] min-w-0 items-center gap-1.5 rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[color:var(--surface-active)]",
        open && "bg-[color:var(--surface-active)]",
      )}
      aria-label="Skills"
      aria-expanded={open}
      onClick={onClick}
    >
      <span className="min-w-0 truncate">Skills</span>
    </button>
  );
}

export function ChatSkillPickerMenuContent({
  error,
  filteredItems,
  items,
  onSearchQueryChange,
  onSelect,
  pending,
  searchInputRef,
  searchQuery,
}: {
  error?: unknown;
  filteredItems: SkillMentionOption[];
  items: SkillMentionOption[];
  onSearchQueryChange: (query: string) => void;
  onSelect: (entry: SkillMentionOption) => void;
  pending: boolean;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
}) {
  return (
    <>
      <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">Skills</div>
      {pending ? (
        <div
          className="flex items-center gap-2 rounded-[var(--radius-md)] px-3 py-2 text-sm text-muted-foreground"
          role="status"
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading skills...</span>
        </div>
      ) : error ? (
        <div className="rounded-[var(--radius-md)] px-3 py-2 text-sm leading-6 text-destructive" role="alert">
          Could not load this agent&apos;s skills.
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-[var(--radius-md)] px-3 py-2 text-sm leading-6 text-muted-foreground">
          This agent has no enabled skills.
        </div>
      ) : (
        <>
          <div className="px-2 pb-2">
            <input
              ref={searchInputRef}
              aria-label="Search skills"
              className="w-full rounded-[var(--radius-md)] border border-border bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-ring"
              placeholder="Search skills..."
              value={searchQuery}
              onChange={(event) => onSearchQueryChange(event.target.value)}
              onKeyDown={(event) => event.stopPropagation()}
            />
          </div>
          <div>
            {filteredItems.length === 0 ? (
              <div className="rounded-[var(--radius-md)] px-3 py-2 text-sm leading-6 text-muted-foreground">
                No skills match search.
              </div>
            ) : filteredItems.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="menuitem"
                data-chat-composer-menu-item
                className="chat-composer-menu-row"
                onClick={() => onSelect(entry)}
              >
                <Boxes className="h-4 w-4 shrink-0 text-[#2f80ed]" />
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="min-w-0 shrink truncate font-medium text-foreground">
                    {entry.skillDisplayName}
                  </span>
                  {entry.skillCategoryLabel ? (
                    <span className="inline-flex shrink-0 items-center rounded-[var(--radius-sm)] border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground">
                      {entry.skillCategoryLabel}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {entry.skillDescription ?? entry.skillLocationLabel ?? entry.skillRefLabel}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}
