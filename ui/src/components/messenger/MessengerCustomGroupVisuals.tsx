import { ProjectIcon } from "@/components/ProjectIdentity";
import { projectColorCssVars } from "@/lib/project-colors";
import { getProjectIconComponent } from "@/lib/project-icons";
import { cn } from "@/lib/utils";
import { DEFAULT_PROJECT_ICON, MESSENGER_CUSTOM_GROUP_EMOJI_ICONS, PROJECT_ICONS, type MessengerCustomGroupWithEntries, type ProjectIconName } from "@rudderhq/shared";
import { PencilLine } from "lucide-react";
import type { CSSProperties } from "react";

export const CUSTOM_GROUP_COLOR_OPTIONS = ["slate", "teal", "sky", "indigo", "amber", "rose", "red", "orange"] as const;
export type CustomGroupColor = (typeof CUSTOM_GROUP_COLOR_OPTIONS)[number];
const CUSTOM_GROUP_ICON_SEPARATOR = "::";
const PROJECT_ICON_VALUES = new Set<string>(PROJECT_ICONS);
export const CUSTOM_GROUP_TONES: Record<CustomGroupColor, {
  bg: string;
  bgDark: string;
  bgHover: string;
  bgHoverDark: string;
  border: string;
  borderDark: string;
  text: string;
  textDark: string;
  entryText: string;
  entryTextDark: string;
  swatch: string;
}> = {
  slate: { bg: "#eef1ef", bgDark: "#313633", bgHover: "#e0e5e2", bgHoverDark: "#3b423e", border: "#d1d8d3", borderDark: "#545d58", text: "#26302a", textDark: "#f0f4f1", entryText: "#26302a", entryTextDark: "#eef2ef", swatch: "#242827" },
  teal: { bg: "#dff4ed", bgDark: "#143f36", bgHover: "#ccebe2", bgHoverDark: "#185247", border: "#a9d9cc", borderDark: "#2a7668", text: "#126454", textDark: "#d9fff5", entryText: "#173c35", entryTextDark: "#effffb", swatch: "#08a88a" },
  sky: { bg: "#dff1fb", bgDark: "#13394c", bgHover: "#c9e8f8", bgHoverDark: "#174b64", border: "#a9d7ee", borderDark: "#28708f", text: "#096287", textDark: "#dff7ff", entryText: "#153747", entryTextDark: "#f0fbff", swatch: "#0c8fca" },
  indigo: { bg: "#e6e5f8", bgDark: "#2d2c58", bgHover: "#d8d6f1", bgHoverDark: "#393873", border: "#c1bee6", borderDark: "#5b58a8", text: "#4c4695", textDark: "#f0efff", entryText: "#302e56", entryTextDark: "#f4f3ff", swatch: "#6259b5" },
  amber: { bg: "#f7edc2", bgDark: "#4a3914", bgHover: "#eee0a8", bgHoverDark: "#604a18", border: "#deca80", borderDark: "#9b7b2c", text: "#885900", textDark: "#ffeec2", entryText: "#4b3812", entryTextDark: "#fff8e5", swatch: "#f2a900" },
  rose: { bg: "#f3d5da", bgDark: "#4d252d", bgHover: "#eac3ca", bgHoverDark: "#63303a", border: "#dba8b2", borderDark: "#9b5664", text: "#7f2634", textDark: "#ffe9ee", entryText: "#51242c", entryTextDark: "#fff4f6", swatch: "#df6f83" },
  red: { bg: "#f0cdd1", bgDark: "#542126", bgHover: "#e7bac0", bgHoverDark: "#6a2a30", border: "#d59aa3", borderDark: "#a34d58", text: "#84242e", textDark: "#ffe8eb", entryText: "#552126", entryTextDark: "#fff1f2", swatch: "#d24b58" },
  orange: { bg: "#f4ddce", bgDark: "#552e1d", bgHover: "#edcbb7", bgHoverDark: "#6d3b25", border: "#dda98c", borderDark: "#a8623d", text: "#793816", textDark: "#ffeadf", entryText: "#512b1c", entryTextDark: "#fff4ee", swatch: "#ec6c3b" },
};

function isCustomGroupColor(value: string | null | undefined): value is CustomGroupColor {
  return CUSTOM_GROUP_COLOR_OPTIONS.includes(value as CustomGroupColor);
}

export function splitCustomGroupIconValue(value: string | null | undefined): { glyph: string; color: CustomGroupColor | null } {
  const trimmed = value?.trim();
  if (!trimmed) return { glyph: "folder", color: null };
  const [rawGlyph, rawColor] = trimmed.split(CUSTOM_GROUP_ICON_SEPARATOR);
  return {
    glyph: rawGlyph?.trim() || "folder",
    color: isCustomGroupColor(rawColor) ? rawColor : null,
  };
}

export function composeCustomGroupIconValue(glyph: string, color: CustomGroupColor | null) {
  const normalizedGlyph = glyph.trim() || "folder";
  return color ? `${normalizedGlyph}${CUSTOM_GROUP_ICON_SEPARATOR}${color}` : normalizedGlyph;
}

export function customGroupColorFor(group: Pick<MessengerCustomGroupWithEntries, "id" | "icon" | "sortOrder">): CustomGroupColor {
  const parsed = splitCustomGroupIconValue(group.icon);
  if (parsed.color) return parsed.color;
  return CUSTOM_GROUP_COLOR_OPTIONS[Math.abs(group.sortOrder ?? group.id.length) % CUSTOM_GROUP_COLOR_OPTIONS.length] ?? "slate";
}

export function customGroupStyle(group: Pick<MessengerCustomGroupWithEntries, "id" | "icon" | "sortOrder">): CSSProperties {
  const tone = CUSTOM_GROUP_TONES[customGroupColorFor(group)];
  return {
    "--messenger-group-bg": tone.bg,
    "--messenger-group-bg-dark": tone.bgDark,
    "--messenger-group-bg-hover": tone.bgHover,
    "--messenger-group-bg-hover-dark": tone.bgHoverDark,
    "--messenger-group-border": tone.border,
    "--messenger-group-border-dark": tone.borderDark,
    "--messenger-group-text": tone.text,
    "--messenger-group-text-dark": tone.textDark,
    "--messenger-group-entry-text": tone.entryText,
    "--messenger-group-entry-text-dark": tone.entryTextDark,
  } as CSSProperties;
}

export function customGroupIconLabel(icon: string | null | undefined) {
  const { glyph } = splitCustomGroupIconValue(icon);
  const trimmed = glyph.trim();
  return trimmed || null;
}

export function isProjectIconName(value: string | null | undefined): value is ProjectIconName {
  return PROJECT_ICON_VALUES.has((value ?? "").trim().toLowerCase());
}

function customGroupProjectIconName(icon: string | null | undefined): ProjectIconName {
  const label = customGroupIconLabel(icon)?.toLowerCase();
  return isProjectIconName(label) ? label : DEFAULT_PROJECT_ICON;
}

export function customGroupProjectColorCssVars(color: CustomGroupColor | null | undefined): CSSProperties {
  return projectColorCssVars(CUSTOM_GROUP_TONES[color ?? "slate"].swatch);
}

function isCustomGroupEmojiGlyph(value: string) {
  return !isProjectIconName(value) && /[^\x00-\x7F]/.test(value);
}

export function CustomGroupIcon({
  icon,
  color,
}: {
  icon?: string | null;
  color?: CustomGroupColor | null;
}) {
  const label = customGroupIconLabel(icon);
  if (!label || isProjectIconName(label)) {
    const resolvedColor = color ?? customGroupColorFor({
      id: label ?? DEFAULT_PROJECT_ICON,
      icon: icon ?? null,
      sortOrder: 0,
    });
    return (
      <ProjectIcon
        color={CUSTOM_GROUP_TONES[resolvedColor].swatch}
        icon={customGroupProjectIconName(icon)}
        size="xs"
        className="h-4 w-4"
        iconClassName="h-4 w-4"
        testId="messenger-custom-group-icon"
      />
    );
  }
  if (isCustomGroupEmojiGlyph(label)) {
    return (
      <span
        aria-hidden
        className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center text-[14px] leading-none"
      >
        {label}
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)-2px)] bg-[color:color-mix(in_oklab,var(--surface-active)_72%,transparent)] px-0.5 text-[10px] font-semibold leading-none text-muted-foreground"
    >
      {label.slice(0, 2)}
    </span>
  );
}

export function CustomGroupIconPicker({
  icon,
  ariaLabel,
  onIconChange,
}: {
  icon: string | null | undefined;
  ariaLabel: string;
  onIconChange: (icon: string) => void;
}) {
  const currentIcon = customGroupIconLabel(icon);
  return (
    <div className="space-y-1.5" aria-label={ariaLabel}>
      <div className="grid grid-cols-6 gap-1.5" aria-label={`${ariaLabel} options`}>
        {PROJECT_ICONS.map((candidate) => {
          const Icon = getProjectIconComponent(candidate);
          const selected = currentIcon && isProjectIconName(currentIcon) ? candidate === currentIcon : false;
          return (
            <button
              key={candidate}
              type="button"
              className={cn(
                "relative inline-flex h-9 w-9 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] border text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                selected
                  ? "border-[color:color-mix(in_oklab,var(--project-accent-color)_54%,var(--border-base))] bg-muted/55 text-[color:var(--project-accent-color)]"
                  : "border-border/70 bg-transparent",
              )}
              aria-label={`Select ${candidate} project icon`}
              aria-pressed={selected}
              onClick={() => onIconChange(candidate)}
            >
              <Icon className="h-5 w-5" strokeWidth={2.2} />
            </button>
          );
        })}
        {MESSENGER_CUSTOM_GROUP_EMOJI_ICONS.map((candidate) => {
          const selected = candidate === currentIcon;
          return (
            <button
              key={candidate}
              type="button"
              className={cn(
                "relative inline-flex h-9 w-9 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] border text-[18px] leading-none outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                selected
                  ? "border-[color:color-mix(in_oklab,var(--project-accent-color)_54%,var(--border-base))] bg-muted/55"
                  : "border-border/70 bg-transparent",
              )}
              aria-label={`Select ${candidate} group emoji`}
              aria-pressed={selected}
              onClick={() => onIconChange(candidate)}
            >
              <span aria-hidden>{candidate}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function CustomGroupEditor({
  name,
  icon,
  color,
  pending,
  onNameChange,
  onIconChange,
  onColorChange,
  onCancel,
  onSubmit,
}: {
  name: string;
  icon: string;
  color: CustomGroupColor | null;
  pending: boolean;
  onNameChange: (value: string) => void;
  onIconChange: (value: string) => void;
  onColorChange: (value: CustomGroupColor | null) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <form
      data-testid="messenger-custom-group-editor"
      className="p-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="mb-2 flex items-center gap-2">
        <CustomGroupIcon icon={icon} color={color} />
        <div className="min-w-0 flex-1 text-[12px] font-semibold text-foreground">New group</div>
      </div>
      <input
        autoFocus
        aria-label="Group name"
        value={name}
        onChange={(event) => onNameChange(event.currentTarget.value)}
        className="h-8 w-full rounded-[calc(var(--radius-sm)-1px)] border border-[color:var(--border-base)] bg-[color:var(--surface-page)] px-2.5 text-[13px] outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
      />
      <div
        className="mt-1.5 rounded-[calc(var(--radius-sm)-1px)] border border-[color:color-mix(in_oklab,var(--border-soft)_74%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-page)_72%,transparent)] p-1.5"
        style={customGroupProjectColorCssVars(color)}
      >
        <CustomGroupIconPicker
          icon={icon}
          ariaLabel="Group icons"
          onIconChange={onIconChange}
        />
      </div>
      <div className="mt-2 flex items-center gap-1.5" aria-label="Group color">
        {CUSTOM_GROUP_COLOR_OPTIONS.map((option) => {
          const tone = CUSTOM_GROUP_TONES[option];
          return (
            <button
              key={option}
              type="button"
              aria-label={`Use ${option} group color`}
              aria-pressed={color === option}
              className={cn(
                "inline-flex h-6 w-6 items-center justify-center rounded-full border transition-[border-color,box-shadow,transform] hover:scale-105",
                color === option
                  ? "border-[color:var(--border-strong)] shadow-[0_0_0_2px_var(--surface-elevated),0_0_0_4px_color-mix(in_oklab,var(--border-strong)_70%,transparent)]"
                  : "border-transparent",
              )}
              style={{ backgroundColor: tone.swatch }}
              onClick={() => onColorChange(option)}
            />
          );
        })}
      </div>
      <div className="mt-2.5 flex justify-end gap-1.5">
        <button
          type="button"
          className="inline-flex h-7 items-center rounded-[calc(var(--radius-sm)-1px)] px-2 text-[12px] font-medium text-muted-foreground transition-[background-color,color] hover:bg-[color:var(--surface-active)] hover:text-foreground"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={pending || !name.trim()}
          className="inline-flex h-7 items-center rounded-[calc(var(--radius-sm)-1px)] bg-[color:var(--accent-strong)] px-2.5 text-[12px] font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
        >
          Create
        </button>
      </div>
    </form>
  );
}

export function CustomGroupRenameForm({
  name,
  pending,
  onNameChange,
  onCancel,
  onSubmit,
}: {
  name: string;
  pending: boolean;
  onNameChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <form
      data-testid="messenger-custom-group-rename"
      className="mx-3 mt-2 rounded-md border border-[color:color-mix(in_oklab,var(--border-soft)_86%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_96%,transparent)] p-2.5 shadow-sm"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="mb-2 flex items-center gap-2">
        <PencilLine className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 text-[12px] font-semibold text-foreground">Rename group</div>
      </div>
      <input
        autoFocus
        aria-label="Group name"
        value={name}
        onChange={(event) => onNameChange(event.currentTarget.value)}
        className="h-8 w-full rounded-[calc(var(--radius-sm)-1px)] border border-[color:var(--border-base)] bg-[color:var(--surface-page)] px-2.5 text-[13px] outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
      />
      <div className="mt-2.5 flex justify-end gap-1.5">
        <button
          type="button"
          className="inline-flex h-7 items-center rounded-[calc(var(--radius-sm)-1px)] px-2 text-[12px] font-medium text-muted-foreground transition-[background-color,color] hover:bg-[color:var(--surface-active)] hover:text-foreground"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={pending || !name.trim()}
          className="inline-flex h-7 items-center rounded-[calc(var(--radius-sm)-1px)] bg-[color:var(--accent-strong)] px-2.5 text-[12px] font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </form>
  );
}
