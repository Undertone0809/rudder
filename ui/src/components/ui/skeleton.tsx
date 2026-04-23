import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("rounded-[var(--radius-sm)] bg-[color:color-mix(in_oklab,var(--surface-active)_82%,transparent)] animate-pulse", className)}
      {...props}
    />
  )
}

export { Skeleton }
