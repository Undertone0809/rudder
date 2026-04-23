import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function ApprovalPanel({ className, ...props }: ComponentPropsWithoutRef<"section">) {
  return <section className={cn("surface-panel rounded-[var(--radius-md)] px-4 py-4", className)} {...props} />;
}

export function ApprovalInset<T extends ElementType = "div">({
  as,
  className,
  ...props
}: { as?: T; className?: string } & Omit<ComponentPropsWithoutRef<T>, "as" | "className">) {
  const Component = as ?? "div";
  return <Component className={cn("surface-inset rounded-[calc(var(--radius-sm)-1px)]", className)} {...props} />;
}

export function ApprovalField({
  label,
  children,
  className,
  align = "center",
}: {
  label: string;
  children: ReactNode;
  className?: string;
  align?: "center" | "start";
}) {
  return (
    <div className={cn("flex gap-2", align === "center" ? "items-center" : "items-start", className)}>
      <span className="w-20 shrink-0 text-xs text-muted-foreground sm:w-24">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function ApprovalTag({ className, ...props }: ComponentPropsWithoutRef<"span">) {
  return (
    <span
      className={cn(
        "rounded-[calc(var(--radius-sm)-1px)] bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function ApprovalInlineCode({ className, ...props }: ComponentPropsWithoutRef<"span">) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[calc(var(--radius-sm)-1px)] bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function ApprovalCodeBlock({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        "rounded-[calc(var(--radius-sm)-1px)] border border-border/60 bg-background/70 px-3 py-2 text-xs text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
