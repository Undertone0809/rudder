import { useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  ImageUp,
  RotateCcw,
  Smile,
  type LucideIcon,
} from "lucide-react";
import { AGENT_ICON_NAMES, type AgentIconName } from "@rudderhq/shared";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { AgentIcon, getAgentAvatarImageSrc } from "./AgentAvatar";
import { AGENT_ICONS } from "../lib/agent-icons";

const DEFAULT_ICON: AgentIconName = "bot";
const MAX_CUSTOM_ICON_LENGTH = 24;

function normalizeIconValue(icon: string | null | undefined) {
  const normalized = icon?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

function isNamedAgentIcon(icon: string | null | undefined): icon is AgentIconName {
  return Boolean(icon && AGENT_ICON_NAMES.includes(icon as AgentIconName));
}

function isCustomTextIcon(icon: string | null | undefined) {
  const normalized = normalizeIconValue(icon);
  return Boolean(normalized && !isNamedAgentIcon(normalized) && !getAgentAvatarImageSrc(normalized));
}

interface AgentIconPickerProps {
  value: string | null | undefined;
  onChange: (icon: string) => void;
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
  const [search, setSearch] = useState("");
  const [emojiValue, setEmojiValue] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const filtered = useMemo(() => {
    const entries = AGENT_ICON_NAMES.map((name) => [name, AGENT_ICONS[name]] as const);
    if (!search) return entries;
    const q = search.toLowerCase();
    return entries.filter(([name]) => name.includes(q));
  }, [search]);

  const trimmedEmoji = emojiValue.trim();
  const emojiDisabled =
    trimmedEmoji.length === 0 ||
    trimmedEmoji.length > MAX_CUSTOM_ICON_LENGTH ||
    /[<>\u0000-\u001f\u007f]/u.test(trimmedEmoji);

  function selectIcon(icon: string) {
    onChange(icon);
    setOpen(false);
    setSearch("");
  }

  function handleEmojiApply() {
    if (emojiDisabled) return;
    selectIcon(trimmedEmoji);
    setEmojiValue("");
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
        if (nextOpen) {
          setEmojiValue(isCustomTextIcon(value) ? normalizeIconValue(value) ?? "" : "");
        }
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-80 p-3" align="start">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium text-foreground">Avatar</div>
            <button
              type="button"
              onClick={() => selectIcon(DEFAULT_ICON)}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset
            </button>
          </div>

          <div className="space-y-2">
            <Input
              placeholder="Search icons..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 text-sm"
              autoFocus
            />
            <div className="grid max-h-40 grid-cols-7 gap-1 overflow-y-auto">
              {filtered.map(([name, Icon]: readonly [AgentIconName, LucideIcon]) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => selectIcon(name)}
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-accent",
                    (value ?? DEFAULT_ICON) === name && "bg-accent ring-1 ring-primary",
                  )}
                  title={name}
                >
                  <Icon className="h-4 w-4" />
                </button>
              ))}
              {filtered.length === 0 && (
                <p className="col-span-7 py-2 text-center text-xs text-muted-foreground">No icons match</p>
              )}
            </div>
          </div>

          <div className="grid gap-2 border-t border-border pt-3">
            <label htmlFor="agent-avatar-emoji" className="text-xs font-medium text-muted-foreground">
              Emoji
            </label>
            <div className="flex min-w-0 items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Smile className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="agent-avatar-emoji"
                  value={emojiValue}
                  onChange={(event) => setEmojiValue(event.target.value)}
                  maxLength={MAX_CUSTOM_ICON_LENGTH}
                  className="h-8 pl-7 text-sm"
                  placeholder="😀"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      handleEmojiApply();
                    }
                  }}
                />
              </div>
              <button
                type="button"
                onClick={handleEmojiApply}
                disabled={emojiDisabled}
                className="h-8 rounded-md border border-border px-2 text-xs text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                Apply
              </button>
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

export { AgentIcon, getAgentAvatarImageSrc } from "./AgentAvatar";
