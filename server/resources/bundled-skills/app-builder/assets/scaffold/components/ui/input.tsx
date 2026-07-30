import { cn } from "@/lib/utils";
import * as React from "react";

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        "flex h-10 w-full rounded-lg border bg-white px-3 py-2 text-sm outline-none placeholder:text-[var(--muted-foreground)] focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
