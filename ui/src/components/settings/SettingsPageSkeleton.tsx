import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { SettingsPage } from "./SettingsScaffold";

export function SettingsPageSkeleton({
  dense = false,
  className,
}: {
  dense?: boolean;
  className?: string;
}) {
  return (
    <SettingsPage
      data-testid="settings-page-skeleton"
      className={cn("gap-7", className)}
      aria-hidden="true"
    >
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-9 w-52" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>

      <div className={cn("flex flex-col", dense ? "gap-3" : "gap-4")}>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-3 w-full max-w-lg" />
        </div>
        <div className="flex flex-col gap-3 rounded-lg border border-[color:var(--border-soft)] bg-[color:var(--surface-inset)] p-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          {!dense ? <Skeleton className="h-24 w-full" /> : null}
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-full max-w-md" />
        </div>
        <div className="flex flex-col gap-3 rounded-lg border border-[color:var(--border-soft)] bg-[color:var(--surface-inset)] p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-44" />
              <Skeleton className="h-3 w-64 max-w-full" />
            </div>
            <Skeleton className="h-7 w-12 rounded-full" />
          </div>
          {dense ? null : <Skeleton className="h-10 w-40" />}
        </div>
      </div>
    </SettingsPage>
  );
}
