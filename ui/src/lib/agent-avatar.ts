import { createAvatar as createDiceBearAvatar } from "@dicebear/core";
import * as notionists from "@dicebear/notionists";
import {
  createAvatar as createOreoAvatar,
  palettes as oreoPalettes,
  shapes as oreoShapes,
} from "@oreo-design/avatar";
import {
  AGENT_AVATAR_BACKGROUND_PRESET_IDS,
  AGENT_DICEBEAR_NOTIONISTS_ICON_PREFIX,
  AGENT_OREO_DEFAULT_PALETTE_ID,
  AGENT_OREO_DEFAULT_SHAPE_ID,
  AGENT_OREO_ICON_PREFIX,
  AGENT_OREO_PALETTE_IDS,
  AGENT_OREO_SHAPE_IDS,
  type AgentAvatarBackgroundPresetId,
  type AgentOreoPaletteId,
  type AgentOreoShapeId,
} from "@rudderhq/shared";

const AGENT_ASSET_ICON_RE =
  /^asset:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\?bg=([a-z0-9-]+))?$/i;
const AGENT_DICEBEAR_NOTIONISTS_ICON_RE = new RegExp(
  `^${AGENT_DICEBEAR_NOTIONISTS_ICON_PREFIX}([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\\?bg=([a-z0-9-]+))?$`,
  "i",
);
const AGENT_OREO_ICON_RE = new RegExp(
  `^${AGENT_OREO_ICON_PREFIX}`
    + `(${AGENT_OREO_SHAPE_IDS.join("|")}):`
    + `(${AGENT_OREO_PALETTE_IDS.join("|")}):`
    + "([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$",
  "i",
);
const AGENT_AVATAR_BG_RE = /\?bg=([a-z0-9-]+)$/i;
const DEFAULT_BACKGROUND_ID: AgentAvatarBackgroundPresetId = "mist";

export type AgentAvatarStyle = "oreo" | "dicebear";

export interface AgentOreoAvatarReference {
  shape: AgentOreoShapeId;
  palette: AgentOreoPaletteId;
  variantId: string;
}

export const AGENT_OREO_SHAPES = oreoShapes.map((shape) => ({
  id: shape.id as AgentOreoShapeId,
  label: shape.name,
}));

export const AGENT_OREO_PALETTES = oreoPalettes.map((palette) => ({
  id: palette.id as AgentOreoPaletteId,
  label: palette.name,
  background: `linear-gradient(135deg, ${palette.colors.base} 0%, ${palette.colors.lobe} 52%, ${palette.colors.accent} 100%)`,
}));

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

const avatarImageCache = new Map<string, string>();

export function normalizeAgentAvatarIconValue(icon: string | null | undefined) {
  const normalized = icon?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

export function parseAgentOreoIcon(
  icon: string | null | undefined,
): AgentOreoAvatarReference | null {
  const match = normalizeAgentAvatarIconValue(icon)?.match(AGENT_OREO_ICON_RE);
  if (!match) return null;
  return {
    shape: match[1]!.toLowerCase() as AgentOreoShapeId,
    palette: match[2]!.toLowerCase() as AgentOreoPaletteId,
    variantId: match[3]!.toLowerCase(),
  };
}

export function getAgentAvatarStyle(
  icon: string | null | undefined,
): AgentAvatarStyle | null {
  if (parseAgentOreoIcon(icon)) return "oreo";
  if (normalizeAgentAvatarIconValue(icon)?.match(AGENT_DICEBEAR_NOTIONISTS_ICON_RE)) {
    return "dicebear";
  }
  return null;
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

function createBrowserUuid() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (char) => {
        const random =
          typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function"
            ? crypto.getRandomValues(new Uint8Array(1))[0]!
            : Math.floor(Math.random() * 256);
        return (Number(char) ^ (random & (15 >> (Number(char) / 4)))).toString(16);
      });
}

export function createAgentOreoIcon(
  shape: AgentOreoShapeId = AGENT_OREO_DEFAULT_SHAPE_ID,
  palette: AgentOreoPaletteId = AGENT_OREO_DEFAULT_PALETTE_ID,
  variantId = createBrowserUuid(),
) {
  return `${AGENT_OREO_ICON_PREFIX}${shape}:${palette}:${variantId}`;
}

export function createRandomAgentOreoIcon() {
  const shape = AGENT_OREO_SHAPE_IDS[
    Math.floor(Math.random() * AGENT_OREO_SHAPE_IDS.length)
  ] ?? AGENT_OREO_DEFAULT_SHAPE_ID;
  const palette = AGENT_OREO_PALETTE_IDS[
    Math.floor(Math.random() * AGENT_OREO_PALETTE_IDS.length)
  ] ?? AGENT_OREO_DEFAULT_PALETTE_ID;
  return createAgentOreoIcon(shape, palette);
}

export function withAgentOreoShape(
  icon: string | null | undefined,
  shape: AgentOreoShapeId,
) {
  const current = parseAgentOreoIcon(icon);
  return createAgentOreoIcon(
    shape,
    current?.palette ?? AGENT_OREO_DEFAULT_PALETTE_ID,
    current?.variantId ?? createBrowserUuid(),
  );
}

export function withAgentOreoPalette(
  icon: string | null | undefined,
  palette: AgentOreoPaletteId,
) {
  const current = parseAgentOreoIcon(icon);
  return createAgentOreoIcon(
    current?.shape ?? AGENT_OREO_DEFAULT_SHAPE_ID,
    palette,
    current?.variantId ?? createBrowserUuid(),
  );
}

export function createRandomAgentDiceBearIcon(backgroundId?: AgentAvatarBackgroundPresetId | null) {
  const icon = `${AGENT_DICEBEAR_NOTIONISTS_ICON_PREFIX}${createBrowserUuid()}`;
  return backgroundId ? appendAgentAvatarBackground(icon, backgroundId) : icon;
}

export function getAgentAvatarImageSrc(icon: string | null | undefined): string | null {
  const normalized = normalizeAgentAvatarIconValue(icon);
  const assetId = normalized?.match(AGENT_ASSET_ICON_RE)?.[1] ?? null;
  if (assetId) return `/api/assets/${assetId}/content`;

  const oreo = parseAgentOreoIcon(normalized);
  if (oreo) {
    const cacheKey = `oreo:${normalized!.toLowerCase()}`;
    const cached = avatarImageCache.get(cacheKey);
    if (cached) return cached;

    const dataUri = createOreoAvatar({
      shape: oreo.shape,
      palette: oreo.palette,
      variantId: oreo.variantId,
      size: 256,
    }).toDataUri();
    avatarImageCache.set(cacheKey, dataUri);
    return dataUri;
  }

  const diceBearSeed = normalized?.match(AGENT_DICEBEAR_NOTIONISTS_ICON_RE)?.[1] ?? null;
  if (!diceBearSeed) return null;

  const cacheKey = `dicebear:${normalized!.toLowerCase()}`;
  const cached = avatarImageCache.get(cacheKey);
  if (cached) return cached;

  const dataUri = createDiceBearAvatar(notionists, {
    seed: diceBearSeed,
    size: 256,
  }).toDataUri();
  avatarImageCache.set(cacheKey, dataUri);
  return dataUri;
}

export function getAgentFallbackAvatarImageSrc(seed: string | null | undefined): string | null {
  const normalizedSeed = seed?.trim();
  if (!normalizedSeed) return null;

  const cacheKey = `fallback:${normalizedSeed}`;
  const cached = avatarImageCache.get(cacheKey);
  if (cached) return cached;

  const dataUri = createDiceBearAvatar(notionists, {
    seed: normalizedSeed,
    size: 256,
  }).toDataUri();
  avatarImageCache.set(cacheKey, dataUri);
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
  if (parseAgentOreoIcon(icon)) return undefined;
  if (!getAgentAvatarImageSrc(icon)) return undefined;
  return { background: getAgentAvatarBackgroundPreset(icon).background };
}

export function withAgentAvatarBackground(
  icon: string | null | undefined,
  backgroundId: AgentAvatarBackgroundPresetId,
) {
  const normalized = normalizeAgentAvatarIconValue(icon);
  if (
    !normalized
    || (!normalized.match(AGENT_ASSET_ICON_RE)
      && !normalized.match(AGENT_DICEBEAR_NOTIONISTS_ICON_RE))
  ) {
    return createRandomAgentDiceBearIcon(backgroundId);
  }
  return appendAgentAvatarBackground(normalized, backgroundId);
}
