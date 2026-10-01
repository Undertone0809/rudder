import { cn } from "@/lib/utils";
import type { ComponentPropsWithRef } from "react";

type WorkspaceTabbedSurfaceRootTag = "aside" | "section";

type WorkspaceTabbedSurfaceProps = ComponentPropsWithRef<"section"> & {
  as: WorkspaceTabbedSurfaceRootTag;
};

export function WorkspaceTabbedSurface({
  as: Root,
  className,
  ...props
}: WorkspaceTabbedSurfaceProps) {
  return (
    <Root
      className={cn("flex flex-col gap-1.5 bg-transparent", className)}
      {...props}
    />
  );
}

type WorkspaceTabbedSurfaceHeaderProps = ComponentPropsWithRef<"div">;

export function WorkspaceTabbedSurfaceHeader({
  className,
  ...props
}: WorkspaceTabbedSurfaceHeaderProps) {
  return (
    <div
      className={cn(
        "workspace-tab-header-card workspace-main-card relative z-10 flex shrink-0 flex-col overflow-visible rounded-[var(--desktop-workspace-radius)]",
        className,
      )}
      {...props}
    />
  );
}

type WorkspaceTabbedSurfaceStripProps = ComponentPropsWithRef<"div">;

export function WorkspaceTabbedSurfaceStrip({
  className,
  ...props
}: WorkspaceTabbedSurfaceStripProps) {
  return (
    <div
      className={cn(
        "workspace-tab-strip flex shrink-0 items-center gap-1 px-2 py-1.5",
        className,
      )}
      {...props}
    />
  );
}

type WorkspaceTabbedSurfaceContentProps = ComponentPropsWithRef<"div">;

export function WorkspaceTabbedSurfaceContent({
  className,
  ...props
}: WorkspaceTabbedSurfaceContentProps) {
  return (
    <div
      className={cn(
        "workspace-tab-content-card workspace-main-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--desktop-workspace-radius)]",
        className,
      )}
      {...props}
    />
  );
}
