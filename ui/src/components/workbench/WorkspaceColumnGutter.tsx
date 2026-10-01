import { cn } from "@/lib/utils";
import type { ComponentPropsWithRef } from "react";

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
