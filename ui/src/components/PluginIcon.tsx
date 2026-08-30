import { cn } from "@/lib/utils";
import { Blocks, type LucideIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

export function themedPluginIconUrl(
  iconUrl: string | null | undefined,
  resolvedTheme: "light" | "dark",
) {
  const normalized = iconUrl?.trim();
  if (!normalized) return null;
  if (!normalized.includes("/api/plugins/catalog/")) return normalized;
  return `${normalized}${normalized.includes("?") ? "&" : "?"}theme=${resolvedTheme}`;
}

export function PluginIconFrame({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-[4px] border border-[color:var(--border-soft)] bg-muted/40",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PluginIcon({
  src,
  fallback: Fallback = Blocks,
  className,
  fallbackClassName,
  testId,
}: {
  src?: string | null;
  fallback?: LucideIcon;
  className?: string;
  fallbackClassName?: string;
  testId?: string;
}) {
  const normalizedSrc = src?.trim() || null;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  useEffect(() => {
    setFailedSrc(null);
  }, [normalizedSrc]);

  if (normalizedSrc && failedSrc !== normalizedSrc) {
    return (
      <img
        src={normalizedSrc}
        alt=""
        aria-hidden
        className={cn("object-contain", className)}
        data-testid={testId}
        decoding="async"
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailedSrc(normalizedSrc)}
      />
    );
  }

  return (
    <Fallback
      aria-hidden
      className={cn(className, fallbackClassName)}
      data-testid={testId}
    />
  );
}
