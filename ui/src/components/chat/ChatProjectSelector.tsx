import { ProjectIcon } from "@/components/ProjectIdentity";
import { cn } from "@/lib/utils";
import type { Project } from "@rudderhq/shared";
import { X } from "lucide-react";
import type { Ref } from "react";

export function ChatProjectSelectorButton({
  project,
  label,
  expanded,
  disabled,
  buttonRef,
  testId = "chat-project-selector",
  iconTestId = "chat-project-icon",
  clearTestId = "chat-project-clear",
  onClick,
  onClear,
}: {
  project: Project | null;
  label: string;
  expanded: boolean;
  disabled: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  testId?: string;
  iconTestId?: string;
  clearTestId?: string;
  onClick: () => void;
  onClear: () => void;
}) {
  return (
    <div className="group/project relative inline-flex max-w-[min(100%,15rem)] min-w-0">
      <button
        ref={buttonRef}
        type="button"
        data-testid={testId}
        aria-label={`Project context: ${label}`}
        aria-expanded={disabled ? false : expanded}
        disabled={disabled}
        title={disabled ? "Project context is locked after conversation starts." : undefined}
        className={cn(
          "chat-chip inline-flex w-full min-w-0 items-center gap-1.5 rounded-[var(--radius-md)] px-3 py-1.5 text-xs font-medium",
          disabled ? "cursor-default" : "transition-colors hover:bg-[color:var(--surface-active)]",
          expanded && "bg-[color:var(--surface-active)]",
        )}
        onClick={onClick}
      >
        {project ? (
          <ProjectIcon
            color={project.color}
            icon={project.icon}
            size="xs"
            testId={iconTestId}
            className={cn(
              "transition-opacity",
              !disabled && "group-focus-within/project:opacity-0 group-hover/project:opacity-0",
            )}
          />
        ) : null}
        <span className="min-w-0 truncate">{label}</span>
      </button>
      {project && !disabled ? (
        <button
          type="button"
          data-testid={clearTestId}
          aria-label={`Clear project context: ${label}`}
          title="Clear project context"
          className="pointer-events-none absolute left-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-[var(--radius-sm)] text-muted-foreground opacity-0 transition-[color,background-color,opacity] hover:bg-[color:var(--surface-inset)] hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40 group-focus-within/project:pointer-events-auto group-focus-within/project:opacity-100 group-hover/project:pointer-events-auto group-hover/project:opacity-100"
          onClick={(event) => {
            event.stopPropagation();
            onClear();
          }}
        >
          <X className="h-4 w-4" strokeWidth={2.4} />
        </button>
      ) : null}
    </div>
  );
}

export function ChatProjectMenuContent({
  projects,
  activeProjectId,
  onSelect,
}: {
  projects: readonly Project[];
  activeProjectId: string | null;
  onSelect: (projectId: string | null) => void;
}) {
  return (
    <>
      <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">Project context</div>
      <button
        type="button"
        role="menuitemradio"
        aria-checked={activeProjectId === null}
        data-chat-composer-menu-item
        className="chat-composer-menu-row project-context-menu-item"
        onClick={() => onSelect(null)}
      >
        <span className="project-context-empty-swatch h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">No project</span>
      </button>
      {projects.length > 0 ? (
        <div className="my-1 border-t border-[color:var(--border-soft)] pt-1">
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              role="menuitemradio"
              aria-checked={activeProjectId === project.id}
              data-chat-composer-menu-item
              className="chat-composer-menu-row project-context-menu-item"
              onClick={() => onSelect(project.id)}
            >
              <ProjectIcon color={project.color} icon={project.icon} size="xs" />
              <span className="min-w-0 flex-1 truncate font-medium">{project.name?.trim() || "Unknown project"}</span>
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
