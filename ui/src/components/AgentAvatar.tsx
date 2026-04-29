import { AGENT_ICON_NAMES, type AgentIconName } from "@rudderhq/shared";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { getAgentIcon } from "../lib/agent-icons";

type IdentitySize = "xs" | "sm" | "default" | "lg";

const AGENT_ASSET_ICON_RE =
  /^asset:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

const textSize: Record<IdentitySize, string> = {
  xs: "text-sm",
  sm: "text-xs",
  default: "text-sm",
  lg: "text-sm",
};

const iconSize: Record<IdentitySize, string> = {
  xs: "h-3 w-3 text-[10px]",
  sm: "h-3 w-3 text-xs",
  default: "h-4 w-4 text-sm",
  lg: "h-4.5 w-4.5 text-base",
};

function deriveInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function normalizeIconValue(icon: string | null | undefined) {
  const normalized = icon?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

export function getAgentAvatarImageSrc(icon: string | null | undefined): string | null {
  const normalized = normalizeIconValue(icon);
  const assetId = normalized?.match(AGENT_ASSET_ICON_RE)?.[1] ?? null;
  return assetId ? `/api/assets/${assetId}/content` : null;
}

function isNamedAgentIcon(icon: string | null | undefined): icon is AgentIconName {
  return Boolean(icon && AGENT_ICON_NAMES.includes(icon as AgentIconName));
}

interface AgentIconProps {
  icon: string | null | undefined;
  className?: string;
}

export function AgentIcon({ icon, className }: AgentIconProps) {
  const normalized = normalizeIconValue(icon);
  const imageSrc = getAgentAvatarImageSrc(normalized);
  if (imageSrc) {
    return (
      <img
        src={imageSrc}
        alt=""
        className={cn("inline-flex rounded-full object-cover", className)}
        loading="lazy"
      />
    );
  }
  if (normalized && !isNamedAgentIcon(normalized)) {
    return (
      <span className={cn("inline-flex items-center justify-center leading-none", className)}>
        {normalized}
      </span>
    );
  }
  const Icon = getAgentIcon(normalized);
  return <Icon className={className} />;
}

export interface AgentIdentityProps {
  name: string;
  icon?: string | null;
  initials?: string;
  size?: IdentitySize;
  className?: string;
}

export function AgentIdentity({
  name,
  icon,
  initials,
  size = "default",
  className,
}: AgentIdentityProps) {
  const normalizedIcon = normalizeIconValue(icon);
  const imageSrc = getAgentAvatarImageSrc(normalizedIcon);
  const displayInitials = initials ?? deriveInitials(name);

  return (
    <span
      className={cn(
        "inline-flex gap-1.5",
        size === "xs" ? "items-baseline gap-1" : "items-center",
        size === "lg" && "gap-2",
        className,
      )}
    >
      <Avatar size={size} className={size === "xs" ? "relative -top-px" : undefined}>
        {imageSrc ? (
          <AgentIcon icon={normalizedIcon} className="size-full" />
        ) : normalizedIcon ? (
          <AvatarFallback>
            <AgentIcon icon={normalizedIcon} className={iconSize[size]} />
          </AvatarFallback>
        ) : (
          <AvatarFallback>{displayInitials}</AvatarFallback>
        )}
      </Avatar>
      <span className={cn("truncate", textSize[size])}>{name}</span>
    </span>
  );
}
