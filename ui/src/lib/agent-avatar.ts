import { createAvatar } from "@dicebear/core";
import * as notionists from "@dicebear/notionists";
import {
  AGENT_AVATAR_BACKGROUND_PRESET_IDS,
  AGENT_DICEBEAR_NOTIONISTS_ICON_PREFIX,
  type AgentAvatarBackgroundPresetId,
} from "@rudderhq/shared";

const AGENT_ASSET_ICON_RE =
  /^asset:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\?bg=([a-z0-9-]+))?$/i;
const AGENT_DICEBEAR_NOTIONISTS_ICON_RE = new RegExp(
  `^${AGENT_DICEBEAR_NOTIONISTS_ICON_PREFIX}([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\\?bg=([a-z0-9-]+))?$`,
  "i",
);
const AGENT_AVATAR_BG_RE = /\?bg=([a-z0-9-]+)$/i;
const DEFAULT_BACKGROUND_ID: AgentAvatarBackgroundPresetId = "mist";

export const AGENT_AVATAR_BACKGROUND_PRESETS: Array<{
  id: AgentAvatarBackgroundPresetId;
  label: string;
  background: string;
}> = [
  {
    id: "mist",
    label: "Mist",
    background: "linear-gradient(135deg, #e5e7eb 0%, #f8fafc 100%)",
  },
  {
    id: "slate",
    label: "Slate",
    background: "linear-gradient(135deg, #cbd5e1 0%, #f1f5f9 100%)",
  },
  {
    id: "sky",
    label: "Sky",
    background: "linear-gradient(135deg, #bae6fd 0%, #e0f2fe 48%, #f8fafc 100%)",
  },
  {
    id: "mint",
    label: "Mint",
    background: "linear-gradient(135deg, #bbf7d0 0%, #ecfdf5 100%)",
  },
  {
    id: "peach",
    label: "Peach",
    background: "linear-gradient(135deg, #fed7aa 0%, #fff7ed 100%)",
  },
  {
    id: "violet",
    label: "Violet",
    background: "linear-gradient(135deg, #ddd6fe 0%, #f5f3ff 100%)",
  },
];

const diceBearAvatarCache = new Map<string, string>();

export function normalizeAgentAvatarIconValue(icon: string | null | undefined) {
  const normalized = icon?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

function isAgentAvatarBackgroundPresetId(
  value: string | null | undefined,
): value is AgentAvatarBackgroundPresetId {
  return AGENT_AVATAR_BACKGROUND_PRESET_IDS.includes(value as AgentAvatarBackgroundPresetId);
}

function readAgentAvatarBackgroundId(icon: string | null | undefined): AgentAvatarBackgroundPresetId | null {
  const backgroundId = normalizeAgentAvatarIconValue(icon)
    ?.match(AGENT_AVATAR_BG_RE)?.[1]
    ?.toLowerCase();
  return isAgentAvatarBackgroundPresetId(backgroundId) ? backgroundId : null;
}

function stripAgentAvatarBackground(icon: string) {
  return icon.replace(AGENT_AVATAR_BG_RE, "");
}

function appendAgentAvatarBackground(icon: string, backgroundId: AgentAvatarBackgroundPresetId) {
  return `${stripAgentAvatarBackground(icon)}?bg=${backgroundId}`;
}

export function createRandomAgentDiceBearIcon(backgroundId?: AgentAvatarBackgroundPresetId | null) {
  const uuid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (char) => {
          const random =
            typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function"
              ? crypto.getRandomValues(new Uint8Array(1))[0]!
              : Math.floor(Math.random() * 256);
          return (Number(char) ^ (random & (15 >> (Number(char) / 4)))).toString(16);
        });
  const icon = `${AGENT_DICEBEAR_NOTIONISTS_ICON_PREFIX}${uuid}`;
  return backgroundId ? appendAgentAvatarBackground(icon, backgroundId) : icon;
}

export function getAgentAvatarImageSrc(icon: string | null | undefined): string | null {
  const normalized = normalizeAgentAvatarIconValue(icon);
  const assetId = normalized?.match(AGENT_ASSET_ICON_RE)?.[1] ?? null;
  if (assetId) return `/api/assets/${assetId}/content`;

  const diceBearSeed = normalized?.match(AGENT_DICEBEAR_NOTIONISTS_ICON_RE)?.[1] ?? null;
  if (!diceBearSeed) return null;

  const cached = diceBearAvatarCache.get(diceBearSeed);
  if (cached) return cached;

  const dataUri = createAvatar(notionists, {
    seed: diceBearSeed,
    size: 256,
  }).toDataUri();
  diceBearAvatarCache.set(diceBearSeed, dataUri);
  return dataUri;
}

export function getAgentAvatarBackgroundPreset(icon: string | null | undefined) {
  const presetId = readAgentAvatarBackgroundId(icon) ?? DEFAULT_BACKGROUND_ID;
  return (
    AGENT_AVATAR_BACKGROUND_PRESETS.find((preset) => preset.id === presetId)
    ?? AGENT_AVATAR_BACKGROUND_PRESETS[0]!
  );
}

export function getAgentAvatarBackgroundStyle(icon: string | null | undefined) {
  if (!getAgentAvatarImageSrc(icon)) return undefined;
  return { background: getAgentAvatarBackgroundPreset(icon).background };
}

export function withAgentAvatarBackground(
  icon: string | null | undefined,
  backgroundId: AgentAvatarBackgroundPresetId,
) {
  const normalized = normalizeAgentAvatarIconValue(icon);
  if (!normalized || !getAgentAvatarImageSrc(normalized)) {
    return createRandomAgentDiceBearIcon(backgroundId);
  }
  return appendAgentAvatarBackground(normalized, backgroundId);
}
