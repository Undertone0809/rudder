import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import { cn } from "@/lib/utils";
import { type AgentRole } from "@rudderhq/shared";
import { ImageUp, Shuffle } from "lucide-react";
import { useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import {
  AGENT_AVATAR_BACKGROUND_PRESETS,
  AGENT_OREO_PALETTES,
  AGENT_OREO_SHAPES,
  createAgentOreoIcon,
  createRandomAgentDiceBearIcon,
  createRandomAgentOreoIcon,
  getAgentAvatarBackgroundPreset,
  getAgentAvatarBackgroundStyle,
  getAgentAvatarImageSrc,
  getAgentAvatarStyle,
  getAgentFallbackAvatarImageSrc,
  normalizeAgentAvatarIconValue,
  parseAgentOreoIcon,
  withAgentAvatarBackground,
  withAgentOreoPalette,
  withAgentOreoShape,
  type AgentAvatarStyle,
} from "../lib/agent-avatar";
import { getAgentIcon, getDefaultAgentIconForRole } from "../lib/agent-icons";

export { getAgentAvatarImageSrc } from "../lib/agent-avatar";

interface AgentIconProps {
  icon: string | null | undefined;
  role?: AgentRole | null;
  fallbackSeed?: string | null;
  className?: string;
  style?: CSSProperties;
}

export function AgentIcon({ icon, role, fallbackSeed, className, style }: AgentIconProps) {
  const normalized = normalizeAgentAvatarIconValue(icon);
  const effectiveIcon = normalized ?? getDefaultAgentIconForRole(role);
  const imageSrc = getAgentAvatarImageSrc(effectiveIcon) ?? getAgentFallbackAvatarImageSrc(fallbackSeed);
  if (imageSrc) {
    const avatarStyle = getAgentAvatarStyle(effectiveIcon);
    return (
      <img
        src={imageSrc}
        alt=""
        className={cn("inline-flex rounded-full object-cover", className)}
        style={{
          background:
            avatarStyle === "oreo"
              ? undefined
              : getAgentAvatarBackgroundPreset(effectiveIcon).background,
          ...getAgentAvatarBackgroundStyle(effectiveIcon),
          ...style,
        }}
        loading="lazy"
      />
    );
  }
  const Icon = getAgentIcon(effectiveIcon);
  return <Icon className={className} />;
}

interface AgentIconPickerProps {
  value: string | null | undefined;
  onChange: (icon: string | null) => void;
  onUpload?: (file: File) => void;
  uploadPending?: boolean;
  uploadError?: string | null;
  children: React.ReactNode;
}

export function AgentIconPicker({
  value,
  onChange,
  onUpload,
  uploadPending = false,
  uploadError = null,
  children,
}: AgentIconPickerProps) {
  const [open, setOpen] = useState(false);
  const [activeStyle, setActiveStyle] = useState<AgentAvatarStyle>("oreo");
  const [oreoDraft, setOreoDraft] = useState(() => (
    parseAgentOreoIcon(value)
      ? normalizeAgentAvatarIconValue(value)!
      : createAgentOreoIcon()
  ));
  const [diceBearDraft, setDiceBearDraft] = useState(() => (
    getAgentAvatarStyle(value) === "dicebear"
      ? normalizeAgentAvatarIconValue(value)!
      : createRandomAgentDiceBearIcon(getAgentAvatarBackgroundPreset(value).id)
  ));
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const paletteScrollRef = useScrollbarActivityRef("rudder:agent-avatar:oreo-palettes");
  const currentOreo = parseAgentOreoIcon(oreoDraft)!;
  const currentBackground = getAgentAvatarBackgroundPreset(diceBearDraft);

  function selectIcon(icon: string | null) {
    onChange(icon);
    setOpen(false);
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file || !onUpload) return;
    onUpload(file);
  }

  function selectRandomIcon() {
    if (activeStyle === "oreo") {
      const nextIcon = createRandomAgentOreoIcon();
      setOreoDraft(nextIcon);
      selectIcon(nextIcon);
      return;
    }
    const nextIcon = createRandomAgentDiceBearIcon(currentBackground.id);
    setDiceBearDraft(nextIcon);
    selectIcon(nextIcon);
  }

  function selectOreoShape(shape: (typeof AGENT_OREO_SHAPES)[number]["id"]) {
    const nextIcon = withAgentOreoShape(oreoDraft, shape);
    setOreoDraft(nextIcon);
    onChange(nextIcon);
  }

  function selectOreoPalette(palette: (typeof AGENT_OREO_PALETTES)[number]["id"]) {
    const nextIcon = withAgentOreoPalette(oreoDraft, palette);
    setOreoDraft(nextIcon);
    onChange(nextIcon);
  }

  function selectDiceBearBackground(backgroundId: (typeof AGENT_AVATAR_BACKGROUND_PRESETS)[number]["id"]) {
    const nextIcon = withAgentAvatarBackground(diceBearDraft, backgroundId);
    setDiceBearDraft(nextIcon);
    onChange(nextIcon);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setActiveStyle("oreo");
          setOreoDraft(
            parseAgentOreoIcon(value)
              ? normalizeAgentAvatarIconValue(value)!
              : createAgentOreoIcon(),
          );
          setDiceBearDraft(
            getAgentAvatarStyle(value) === "dicebear"
              ? normalizeAgentAvatarIconValue(value)!
              : createRandomAgentDiceBearIcon(getAgentAvatarBackgroundPreset(value).id),
          );
        }
        setOpen(nextOpen);
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        className="flex max-h-[calc(100dvh-1rem)] w-[min(22rem,calc(100vw-1rem))] flex-col overflow-hidden p-3"
        align="start"
        data-testid="agent-avatar-picker"
      >
        <div className="flex min-h-0 flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium text-foreground">Avatar</div>
            <button
              type="button"
              onClick={selectRandomIcon}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Shuffle className="h-3.5 w-3.5" />
              Random
            </button>
          </div>

          <Tabs
            value={activeStyle}
            onValueChange={(style) => setActiveStyle(style as AgentAvatarStyle)}
            className="min-h-0 gap-3"
          >
            <TabsList
              className="grid h-8 w-full grid-cols-2 rounded-[var(--control-radius)] p-0.5"
              aria-label="Avatar style"
            >
              <TabsTrigger value="oreo" className="h-7 rounded-[var(--control-radius)] py-0 text-xs">
                Oreo
              </TabsTrigger>
              <TabsTrigger value="dicebear" className="h-7 rounded-[var(--control-radius)] py-0 text-xs">
                DiceBear
              </TabsTrigger>
            </TabsList>

            <TabsContent value="oreo" className="mt-0 min-h-0 space-y-3">
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">Shape</div>
                <div className="grid grid-cols-3 gap-2">
                  {AGENT_OREO_SHAPES.map((shape) => {
                    const previewIcon = createAgentOreoIcon(
                      shape.id,
                      currentOreo.palette,
                      currentOreo.variantId,
                    );
                    return (
                      <button
                        key={shape.id}
                        type="button"
                        onClick={() => selectOreoShape(shape.id)}
                        aria-label={`Oreo shape ${shape.label}`}
                        aria-pressed={currentOreo.shape === shape.id}
                        className={cn(
                          "flex h-11 items-center gap-2 rounded-md border border-border px-2 text-xs text-foreground transition-colors hover:bg-accent",
                          currentOreo.shape === shape.id && "border-primary ring-1 ring-primary",
                        )}
                      >
                        <AgentIcon icon={previewIcon} className="size-5 shrink-0" />
                        <span className="truncate">{shape.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="min-h-0 space-y-2">
                <div className="text-xs font-medium text-muted-foreground">Palette</div>
                <div
                  ref={paletteScrollRef}
                  className="scrollbar-auto-hide max-h-[min(15rem,calc(100dvh-19rem))] min-h-24 overflow-y-auto overscroll-contain pr-1"
                  data-testid="agent-avatar-oreo-palettes"
                >
                  <div className="grid grid-cols-2 gap-2">
                    {AGENT_OREO_PALETTES.map((palette) => (
                      <button
                        key={palette.id}
                        type="button"
                        onClick={() => selectOreoPalette(palette.id)}
                        aria-label={`Oreo palette ${palette.label}`}
                        aria-pressed={currentOreo.palette === palette.id}
                        className={cn(
                          "flex h-9 min-w-0 items-center gap-2 rounded-md border border-border px-2 text-xs text-foreground transition-colors hover:bg-accent",
                          currentOreo.palette === palette.id && "border-primary ring-1 ring-primary",
                        )}
                      >
                        <span
                          className="size-4 shrink-0 rounded-full border border-border"
                          style={{ background: palette.background }}
                        />
                        <span className="truncate">{palette.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="dicebear" className="mt-0 space-y-2">
              <div className="text-xs font-medium text-muted-foreground">Background</div>
              <div className="grid grid-cols-3 gap-2">
                {AGENT_AVATAR_BACKGROUND_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => selectDiceBearBackground(preset.id)}
                    aria-label={`DiceBear background ${preset.label}`}
                    aria-pressed={currentBackground.id === preset.id}
                    className={cn(
                      "flex h-9 items-center gap-2 rounded-md border border-border px-2 text-xs text-foreground transition-colors hover:bg-accent",
                      currentBackground.id === preset.id && "border-primary ring-1 ring-primary",
                    )}
                    title={preset.label}
                  >
                    <span
                      className="size-4 shrink-0 rounded-full border border-border"
                      style={{ background: preset.background }}
                    />
                    <span className="truncate">{preset.label}</span>
                  </button>
                ))}
              </div>
            </TabsContent>
          </Tabs>

          {onUpload ? (
            <div className="grid gap-2 border-t border-border pt-3">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={handleFileChange}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadPending}
                className="flex h-9 items-center justify-center gap-2 rounded-md border border-border px-3 text-sm text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
              >
                <ImageUp className="h-4 w-4" />
                {uploadPending ? "Uploading..." : "Upload image"}
              </button>
              {uploadError ? <p className="text-xs text-destructive">{uploadError}</p> : null}
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
