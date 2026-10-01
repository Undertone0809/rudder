import { cn } from "@/lib/utils";
import { PanelLeft } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef } from "react";

const WORKSPACE_CONTEXT_SIDEBAR_CLASS = "workspace-context-sidebar flex min-h-0 w-full min-w-0 shrink-0 flex-col";
const WORKSPACE_CONTEXT_HEADER_CLASS = "workspace-card-header workspace-context-header desktop-chrome flex shrink-0 items-center justify-between gap-3 px-4 py-3";
const WORKSPACE_SIDEBAR_COLLAPSE_BUTTON_CLASS = "desktop-window-no-drag inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] text-muted-foreground transition-[background-color,color] hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_68%,transparent)] hover:text-foreground";

export type WorkspaceContextSidebarProps = ComponentPropsWithoutRef<"aside"> & {
  "data-testid"?: string;
};

export const WorkspaceContextSidebar = forwardRef<HTMLElement, WorkspaceContextSidebarProps>(
  function WorkspaceContextSidebar({
    className,
    "data-testid": testId = "workspace-sidebar",
    ...props
  }, ref) {
    return (
      <aside
        {...props}
        ref={ref}
        data-testid={testId}
        className={cn(WORKSPACE_CONTEXT_SIDEBAR_CLASS, className)}
      />
    );
  },
);

export type WorkspaceContextHeaderProps = ComponentPropsWithoutRef<"header"> & {
  "data-testid"?: string;
};

export const WorkspaceContextHeader = forwardRef<HTMLElement, WorkspaceContextHeaderProps>(
  function WorkspaceContextHeader({
    className,
    "data-testid": testId = "workspace-context-header",
    ...props
  }, ref) {
    return (
      <header
        {...props}
        ref={ref}
        data-testid={testId}
        className={cn(WORKSPACE_CONTEXT_HEADER_CLASS, className)}
      />
    );
  },
);

export type WorkspaceSidebarCollapseButtonProps = Omit<
  ComponentPropsWithoutRef<"button">,
  "onClick"
> & {
  onClick: NonNullable<ComponentPropsWithoutRef<"button">["onClick"]>;
};

export const WorkspaceSidebarCollapseButton = forwardRef<
  HTMLButtonElement,
  WorkspaceSidebarCollapseButtonProps
>(function WorkspaceSidebarCollapseButton({
  className,
  children,
  type = "button",
  "aria-label": ariaLabel = "Collapse workspace sidebar",
  title = "Collapse workspace sidebar",
  ...props
}, ref) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      aria-label={ariaLabel}
      title={title}
      className={cn(WORKSPACE_SIDEBAR_COLLAPSE_BUTTON_CLASS, className)}
    >
      {children ?? <PanelLeft className="h-4 w-4" aria-hidden />}
    </button>
  );
});
