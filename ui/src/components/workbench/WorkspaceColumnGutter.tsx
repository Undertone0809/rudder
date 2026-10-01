import { cn } from "@/lib/utils";
import type { ComponentPropsWithRef, PointerEventHandler } from "react";

type WorkspaceColumnGutterProps = ComponentPropsWithRef<"div"> & {
  visible: boolean;
};

/** Shared column spacing; callers may opt into resize interaction. */
export function WorkspaceColumnGutter({ visible, className, ...props }: WorkspaceColumnGutterProps) {
  return (
    <div
      {...props}
      className={cn(
        "shrink-0",
        visible ? "w-2 opacity-100 md:w-[9px]" : "w-0 overflow-hidden opacity-0",
        className,
      )}
    />
  );
}


type WorkspaceContextColumnGutterProps = {
  library: boolean;
  visible: boolean;
  resizing: boolean;
  onResizeStart: PointerEventHandler<HTMLDivElement>;
};

/** The Library gutter is inert; other context columns retain resize controls. */
export function WorkspaceContextColumnGutter({
  library,
  visible,
  resizing,
  onResizeStart,
}: WorkspaceContextColumnGutterProps) {
  if (library) {
    return <WorkspaceColumnGutter data-testid="workspace-column-gutter" aria-hidden visible={visible} className="motion-resize" />;
  }
  return (
    <WorkspaceColumnGutter
      data-testid="workspace-column-resizer"
      aria-hidden={!visible}
      visible={visible}
      className={cn(
        "workspace-column-resizer group flex shrink-0 cursor-col-resize items-stretch justify-center",
        !resizing && "motion-resize",
        resizing && "is-resizing",
      )}
      onPointerDown={onResizeStart}
      role={visible ? "separator" : undefined}
      aria-orientation="vertical"
      aria-label="Resize workspace columns"
    >
      <div className="workspace-column-resizer-line" />
    </WorkspaceColumnGutter>
  );
}
