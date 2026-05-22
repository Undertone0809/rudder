import { type CSSProperties } from "react";
import { type AgentRole } from "@rudderhq/shared";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { getAgentIcon, getDefaultAgentIconForRole } from "../lib/agent-icons";
import {
  getAgentAvatarBackgroundStyle,
  getAgentAvatarImageSrc,
  normalizeAgentAvatarIconValue,
} from "../lib/agent-avatar";

type IdentitySize = "xs" | "sm" | "default" | "lg";

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

interface AgentIconProps {
  icon: string | null | undefined;
  role?: AgentRole | null;
  className?: string;
  style?: CSSProperties;
}

export function AgentIcon({ icon, role, className, style }: AgentIconProps) {
  const normalized = normalizeAgentAvatarIconValue(icon);
  const effectiveIcon = normalized ?? getDefaultAgentIconForRole(role);
  const imageSrc = getAgentAvatarImageSrc(effectiveIcon);
  if (imageSrc) {
    return (
      <img
        src={imageSrc}
        alt=""
        className={cn("inline-flex rounded-full object-cover", className)}
        style={{ ...getAgentAvatarBackgroundStyle(effectiveIcon), ...style }}
        loading="lazy"
      />
    );
  }
  const Icon = getAgentIcon(effectiveIcon);
  return <Icon className={className} />;
}

export interface AgentIdentityProps {
  name: string;
  icon?: string | null;
  role?: AgentRole | null;
  size?: IdentitySize;
  className?: string;
}

export function AgentIdentity({
  name,
  icon,
  role,
  size = "default",
  className,
}: AgentIdentityProps) {
  const normalizedIcon = normalizeAgentAvatarIconValue(icon) ?? getDefaultAgentIconForRole(role);
  const imageSrc = getAgentAvatarImageSrc(normalizedIcon);

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
        ) : (
          <AvatarFallback>
            <AgentIcon icon={normalizedIcon} className={iconSize[size]} />
          </AvatarFallback>
        )}
      </Avatar>
      <span className={cn("truncate", textSize[size])}>{name}</span>
    </span>
  );
}
