import type { McpConnectionProvider } from "@rudderhq/shared";
import { Server } from "lucide-react";
import { cn } from "../lib/utils";

const MCP_PROVIDER_LOGOS: Partial<Record<McpConnectionProvider, string>> = {
  supabase: "/brands/supabase-logo.svg",
  notion: "/brands/notion-logo.svg",
  linear: "/brands/linear-logo.svg",
  github: "/brands/github-logo.svg",
};

export function mcpProviderLogoSrc(provider: McpConnectionProvider): string | undefined {
  return MCP_PROVIDER_LOGOS[provider];
}

export function McpProviderIcon({
  provider,
  className,
}: {
  provider: McpConnectionProvider;
  className?: string;
}) {
  const logoSrc = mcpProviderLogoSrc(provider);

  return (
    <span
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted",
        className,
      )}
    >
      {logoSrc ? (
        <img
          src={logoSrc}
          alt=""
          className={cn("size-5", provider === "notion" ? "dark:invert" : undefined)}
        />
      ) : (
        <Server className="size-5" />
      )}
    </span>
  );
}
