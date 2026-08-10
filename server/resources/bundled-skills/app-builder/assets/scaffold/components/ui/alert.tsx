import { cn } from "@/lib/utils";
import * as React from "react";

export function Alert({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="alert"
      className={cn("rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive", className)}
      {...props}
    />
  );
}
