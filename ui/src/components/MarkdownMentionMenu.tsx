import {
  Boxes,
  FileText,
  Folder,
  MessageSquare,
  Repeat,
} from "lucide-react";
import { useMemo, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useScrollbarActivityRef } from "../hooks/useScrollbarActivityRef";
import { cn } from "../lib/utils";
import { AgentIcon } from "./AgentIconPicker";
import type { MentionOption } from "./MarkdownEditor";
import { ProjectIcon } from "./ProjectIdentity";
import { StatusIcon } from "./StatusIcon";

interface MarkdownMentionMenuProps {
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onSelect: (option: MentionOption) => void;
  options: MentionOption[];
  placement: "caret" | "container";
  style: CSSProperties;
}

function statusLabel(status: string) {
  return status
    .replace(/_/gu, " ")
    .replace(/\b\w/gu, (character) => character.toUpperCase());
}

function groupLabel(option: MentionOption) {
  if (option.kind === "skill") return "Skills";
  if (option.kind === "project") return "Projects";
  if (option.kind === "issue") return "Issues";
  if (option.kind === "chat") return "Chats";
  if (
    option.kind === "library_doc"
    || option.kind === "library_entry"
    || option.kind === "library_file"
    || option.kind === "library_directory"
  ) {
    return "Library";
  }
  return "Agents";
}

function OptionIcon({ option }: { option: MentionOption }) {
  if (option.kind === "skill") {
    return <Boxes className="h-4 w-4 shrink-0 text-[#2f80ed]" />;
  }
  if (option.kind === "project" && option.projectId) {
    return (
      <ProjectIcon
        color={option.projectColor}
        icon={option.projectIcon}
        size="xs"
      />
    );
  }
  if (option.kind === "issue" && option.issueId) {
    const label = option.issueStatus ? statusLabel(option.issueStatus) : "Issue";
    return (
      <span
        className="inline-flex shrink-0"
        aria-label={`Status: ${label}`}
        title={label}
      >
        <StatusIcon status={option.issueStatus ?? "default"} />
      </span>
    );
  }
  if (option.kind === "automation") {
    return <Repeat className="h-4 w-4 shrink-0 text-muted-foreground" />;
  }
  if (option.kind === "chat") {
    return <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />;
  }
  if (option.kind === "library_directory") {
    return <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />;
  }
  if (
    option.kind === "library_doc"
    || option.kind === "library_entry"
    || option.kind === "library_file"
  ) {
    return <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />;
  }
  return (
    <AgentIcon
      icon={option.agentIcon}
      role={option.agentRole}
      className="h-4 w-4 shrink-0 text-muted-foreground"
    />
  );
}

function OptionContent({
  option,
  containerMenu,
}: {
  option: MentionOption;
  containerMenu: boolean;
}) {
  const skillDescription = option.skillDescription
    ?? option.skillLocationLabel
    ?? option.skillDisplayName
    ?? option.name;
  if (option.kind === "skill" && containerMenu) {
    return (
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 shrink truncate font-medium text-foreground">
          {option.skillDisplayName ?? option.name}
        </span>
        {option.skillCategoryLabel ? (
          <span className="inline-flex shrink-0 items-center rounded-[var(--radius-sm)] border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground">
            {option.skillCategoryLabel}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {skillDescription}
        </span>
      </span>
    );
  }

  const title = option.kind === "automation"
    ? option.automationTitle ?? option.name
    : option.name;
  const libraryPath = option.libraryDirectoryPath
    ?? option.libraryFilePath
    ?? option.libraryDocumentPath;
  return (
    <div className="min-w-0 flex-1">
      <div className="truncate font-medium text-foreground">{title}</div>
      {option.kind === "skill" ? (
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          {option.skillCategoryLabel ? (
            <span className="inline-flex shrink-0 items-center rounded-[var(--radius-sm)] border border-border/70 bg-muted/50 px-1.5 py-0.5 leading-none">
              {option.skillCategoryLabel}
            </span>
          ) : null}
          <span className="min-w-0 truncate">{skillDescription}</span>
        </div>
      ) : null}
      {libraryPath ? (
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {libraryPath}
        </div>
      ) : null}
    </div>
  );
}

export function MarkdownMentionMenu({
  activeIndex,
  onActiveIndexChange,
  onSelect,
  options,
  placement,
  style,
}: MarkdownMentionMenuProps) {
  const scrollbarRef = useScrollbarActivityRef();
  const groups = useMemo(() => {
    const grouped: Array<{ label: string; options: MentionOption[] }> = [];
    for (const option of options) {
      const label = groupLabel(option);
      const existing = grouped.find((group) => group.label === label);
      if (existing) existing.options.push(option);
      else grouped.push({ label, options: [option] });
    }
    return grouped;
  }, [options]);
  const containerMenu = placement === "container";

  let optionIndex = 0;
  const menu = (
    <div
      ref={scrollbarRef}
      role={containerMenu ? "menu" : "listbox"}
      data-testid="markdown-mention-menu"
      className={cn(
        "pointer-events-auto scrollbar-auto-hide fixed z-[70] overflow-y-auto rounded-lg border border-border p-1.5 shadow-lg",
        containerMenu
          ? "chat-composer-context-menu motion-chat-composer-menu-pop surface-overlay text-foreground"
          : "bg-popover text-popover-foreground",
      )}
      style={style}
    >
      {groups.map((group) => (
        <div key={group.label} className="py-0.5">
          {containerMenu ? (
            <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
              {group.label}
            </div>
          ) : null}
          {group.options.map((option) => {
            const index = optionIndex;
            optionIndex += 1;
            const libraryOption = option.kind === "library_doc"
              || option.kind === "library_entry"
              || option.kind === "library_file"
              || option.kind === "library_directory";
            return (
              <button
                key={option.id}
                type="button"
                role={containerMenu ? "menuitem" : "option"}
                aria-selected={containerMenu ? undefined : index === activeIndex}
                data-testid={`markdown-mention-option-${option.id}`}
                data-mention-option-index={index}
                data-chat-composer-menu-item={containerMenu ? true : undefined}
                className={cn(
                  containerMenu
                    ? "chat-composer-menu-row"
                    : "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                  index === activeIndex
                    ? containerMenu
                      ? "bg-[color:var(--surface-active)] text-foreground"
                      : "bg-accent text-accent-foreground"
                    : "hover:bg-accent/60",
                )}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelect(option);
                }}
                onMouseEnter={() => onActiveIndexChange(index)}
              >
                <OptionIcon option={option} />
                <OptionContent option={option} containerMenu={containerMenu} />
                {option.kind === "chat" && option.chatConversationId ? (
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    Chat
                  </span>
                ) : null}
                {libraryOption ? (
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    {option.kind === "library_directory" ? "Folder" : "Doc"}
                  </span>
                ) : null}
                {option.kind === "skill" && !containerMenu ? (
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    Skill
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );

  return typeof document === "undefined" ? menu : createPortal(menu, document.body);
}
