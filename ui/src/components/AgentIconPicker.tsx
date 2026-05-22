import { useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import { ImageUp, Shuffle } from "lucide-react";
import { type AgentRole } from "@rudderhq/shared";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { getAgentIcon, getDefaultAgentIconForRole } from "../lib/agent-icons";
import {
  AGENT_AVATAR_BACKGROUND_PRESETS,
  createRandomAgentDiceBearIcon,
  getAgentAvatarBackgroundPreset,
  getAgentAvatarBackgroundStyle,
  getAgentAvatarImageSrc,
  normalizeAgentAvatarIconValue,
  withAgentAvatarBackground,
} from "../lib/agent-avatar";

export { getAgentAvatarImageSrc } from "../lib/agent-avatar";

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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const currentBackground = getAgentAvatarBackgroundPreset(value);

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

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="start">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium text-foreground">Avatar</div>
            <button
              type="button"
              onClick={() => selectIcon(createRandomAgentDiceBearIcon(currentBackground.id))}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Shuffle className="h-3.5 w-3.5" />
              Random
            </button>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">Background</div>
            <div className="grid grid-cols-3 gap-2">
              {AGENT_AVATAR_BACKGROUND_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => onChange(withAgentAvatarBackground(value, preset.id))}
                  className={cn(
                    "flex h-9 items-center gap-2 rounded-md border border-border px-2 text-xs text-foreground transition-colors hover:bg-accent",
                    currentBackground.id === preset.id && "border-primary ring-1 ring-primary",
                  )}
                  title={preset.label}
                >
                  <span
                    className="h-4 w-4 shrink-0 rounded-full border border-border"
                    style={{ background: preset.background }}
                  />
                  <span className="truncate">{preset.label}</span>
                </button>
              ))}
            </div>
          </div>

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
