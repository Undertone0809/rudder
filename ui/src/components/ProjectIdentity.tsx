import { projectColorBackgroundStyle } from "@/lib/project-colors";
import { getProjectIconComponent, normalizeProjectIconName } from "@/lib/project-icons";
import { cn } from "@/lib/utils";
import { DEFAULT_PROJECT_ICON, PROJECT_COLORS, PROJECT_ICONS, type ProjectIconName } from "@rudderhq/shared";
import { Check } from "lucide-react";
import type { CSSProperties } from "react";

type ProjectIdentityShape = {
  name?: string | null;
  color?: string | null;
  icon?: string | null;
};

const iconSizeClass = {
  xs: "h-3.5 w-3.5 rounded-[calc(var(--radius-sm)-3px)]",
  sm: "h-4 w-4 rounded-[calc(var(--radius-sm)-3px)]",
  md: "h-5 w-5 rounded-[calc(var(--radius-sm)-2px)]",
  lg: "h-7 w-7 rounded-[calc(var(--radius-sm)-1px)]",
} as const;

const glyphSizeClass = {
  xs: "h-2.5 w-2.5",
  sm: "h-3 w-3",
  md: "h-3.5 w-3.5",
  lg: "h-4 w-4",
} as const;

export function ProjectIcon({
  color,
  icon,
  size = "sm",
  className,
  iconClassName,
  label,
  testId,
}: {
  color?: string | null;
  icon?: string | null;
  size?: keyof typeof iconSizeClass;
  className?: string;
  iconClassName?: string;
  label?: string;
  testId?: string;
}) {
  const Icon = getProjectIconComponent(icon);
  return (
    <span
      data-testid={testId}
      className={cn(
        "inline-flex shrink-0 items-center justify-center text-white shadow-[inset_0_0_0_1px_color-mix(in_oklab,white_24%,transparent),0_0_0_1px_color-mix(in_oklab,var(--border-base)_72%,transparent)]",
        iconSizeClass[size],
        className,
      )}
      style={projectColorBackgroundStyle(color)}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <Icon className={cn(glyphSizeClass[size], iconClassName)} strokeWidth={2.3} />
    </span>
  );
}

export function ProjectIdentity({
  project,
  size = "sm",
  className,
  labelClassName,
  iconClassName,
  testId,
}: {
  project: ProjectIdentityShape;
  size?: keyof typeof iconSizeClass;
  className?: string;
  labelClassName?: string;
  iconClassName?: string;
  testId?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <ProjectIcon
        color={project.color}
        icon={project.icon}
        size={size}
        iconClassName={iconClassName}
        testId={testId}
      />
      <span className={cn("min-w-0 truncate", labelClassName)}>{project.name}</span>
    </span>
  );
}

export function ProjectIdentityPicker({
  color,
  icon,
  onColorChange,
  onIconChange,
  className,
}: {
  color: string | null | undefined;
  icon: string | null | undefined;
  onColorChange: (color: string) => void;
  onIconChange: (icon: ProjectIconName) => void;
  className?: string;
}) {
  const currentIcon = normalizeProjectIconName(icon);
  return (
    <div className={cn("w-72 space-y-3 p-2", className)}>
      <div className="grid grid-cols-6 gap-1.5" aria-label="Project colors">
        {PROJECT_COLORS.map((candidate) => {
          const selected = candidate === color;
          return (
            <button
              key={candidate}
              type="button"
              className={cn(
                "relative h-7 w-7 rounded-[calc(var(--radius-sm)-1px)] outline-none transition-[box-shadow,transform] hover:scale-[1.04] focus-visible:ring-2 focus-visible:ring-ring",
                selected
                  ? "ring-2 ring-foreground ring-offset-1 ring-offset-background"
                  : "ring-1 ring-[color:color-mix(in_oklab,var(--border-base)_72%,transparent)]",
              )}
              style={projectColorBackgroundStyle(candidate) as CSSProperties}
              aria-label="Select project color"
              aria-pressed={selected}
              onClick={() => onColorChange(candidate)}
            />
          );
        })}
      </div>
      <div className="grid grid-cols-8 gap-1.5" aria-label="Project icons">
        {PROJECT_ICONS.map((candidate) => {
          const Icon = getProjectIconComponent(candidate);
          const selected = candidate === currentIcon;
          return (
            <button
              key={candidate}
              type="button"
              className={cn(
                "relative inline-flex h-8 w-8 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] border text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                selected
                  ? "border-[color:var(--project-accent-color,var(--accent-base))] bg-accent text-foreground"
                  : "border-border/70 bg-transparent",
              )}
              aria-label={`Select ${candidate} project icon`}
              aria-pressed={selected}
              onClick={() => onIconChange(candidate)}
            >
              <Icon className="h-4 w-4" />
              {selected ? <Check className="absolute h-2.5 w-2.5 translate-x-2.5 translate-y-2.5 text-foreground" /> : null}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2 rounded-[calc(var(--radius-sm)-1px)] border border-border/70 bg-muted/35 px-2 py-1.5">
        <ProjectIcon color={color} icon={currentIcon || DEFAULT_PROJECT_ICON} size="lg" />
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {currentIcon}
        </span>
      </div>
    </div>
  );
}
