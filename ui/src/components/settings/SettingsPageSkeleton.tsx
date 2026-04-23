import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function SettingsPageSkeleton({
  dense = false,
  className,
}: {
  dense?: boolean;
  className?: string;
}) {
  return (
    <div
      data-testid="settings-page-skeleton"
      className={cn("mx-auto max-w-4xl space-y-6 px-1 pb-6", className)}
      aria-hidden="true"
    >
      <div className="space-y-3">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-9 w-52" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>

      <Skeleton className="h-px w-full" />

      <div className={cn("space-y-4", dense ? "space-y-3" : "space-y-4")}>
        <div className="space-y-2">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-3 w-full max-w-lg" />
        </div>
        <div className="space-y-3 rounded-[var(--radius-md)] border border-border/70 bg-card/45 p-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          {!dense ? <Skeleton className="h-24 w-full" /> : null}
        </div>
      </div>

      <Skeleton className="h-px w-full" />

      <div className="space-y-4">
        <div className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-full max-w-md" />
        </div>
        <div className="space-y-3 rounded-[var(--radius-md)] border border-border/70 bg-card/45 p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-2">
              <Skeleton className="h-4 w-44" />
              <Skeleton className="h-3 w-64 max-w-full" />
            </div>
            <Skeleton className="h-7 w-12 rounded-full" />
          </div>
          {dense ? null : <Skeleton className="h-10 w-40" />}
        </div>
      </div>
    </div>
  );
}
