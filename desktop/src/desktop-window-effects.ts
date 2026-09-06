import type { DesktopAppearance } from "./theme-preference.js";

export type DesktopWindowEffectMode = "opaque" | "transparent" | "transparent_vibrant";

export type DesktopWindowEffectOptions = {
  backgroundColor: string;
  titleBarStyle?: "hiddenInset";
  transparent?: boolean;
  vibrancy?: "under-window";
  visualEffectState?: "active";
};

export type DesktopWindowChromeOptions = {
  frame?: boolean;
  roundedCorners?: boolean;
};

const WINDOWS_TRANSPARENT_WINDOW_BACKGROUND = "#00000000";
export const WINDOWS_DESKTOP_WINDOW_CORNER_RADIUS = 10;

export type DesktopWindowShapeRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type DesktopWindowEffectInput = {
  platform: NodeJS.Platform;
  mode: DesktopWindowEffectMode;
  appearance: DesktopAppearance;
  desktopWindowBackground: Record<DesktopAppearance, string>;
  transparentWindowBackground: Record<DesktopAppearance, string>;
};

export function normalizeDesktopWindowEffectMode(value: string | null | undefined): DesktopWindowEffectMode | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "opaque") return "opaque";
  if (normalized === "transparent") return "transparent";
  if (normalized === "transparent_vibrant" || normalized === "transparent-vibrant") return "transparent_vibrant";
  return null;
}

export function resolveDesktopWindowEffectMode(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): DesktopWindowEffectMode {
  const value = env.RUDDER_DESKTOP_WINDOW_EFFECT_MODE
    ?? (platform === "darwin" ? env.RUDDER_DESKTOP_MAC_WINDOW_MODE : undefined);
  const override = normalizeDesktopWindowEffectMode(value);
  if (override) return override;
  return platform === "darwin" || platform === "win32" ? "transparent_vibrant" : "opaque";
}

export function resolveDesktopWindowChromeOptions(platform: NodeJS.Platform): DesktopWindowChromeOptions {
  return platform === "win32" ? { frame: false, roundedCorners: true } : {};
}

export function resolveRoundedWindowShapeRects(
  width: number,
  height: number,
  radius = WINDOWS_DESKTOP_WINDOW_CORNER_RADIUS,
): DesktopWindowShapeRect[] {
  const normalizedWidth = Math.max(0, Math.floor(width));
  const normalizedHeight = Math.max(0, Math.floor(height));
  const normalizedRadius = Math.max(0, Math.floor(radius));
  if (normalizedWidth <= 0 || normalizedHeight <= 0) return [];
  if (normalizedRadius <= 0) {
    return [{ x: 0, y: 0, width: normalizedWidth, height: normalizedHeight }];
  }

  const radiusForBounds = Math.min(
    normalizedRadius,
    Math.floor(normalizedWidth / 2),
    Math.floor(normalizedHeight / 2),
  );
  const rects: DesktopWindowShapeRect[] = [];
  let activeRect: DesktopWindowShapeRect | null = null;

  for (let y = 0; y < normalizedHeight; y += 1) {
    const distanceFromTop = y + 0.5;
    const distanceFromBottom = normalizedHeight - y - 0.5;
    const cornerDistanceY = Math.min(distanceFromTop, distanceFromBottom);
    let inset = 0;

    if (cornerDistanceY < radiusForBounds) {
      const dy = radiusForBounds - cornerDistanceY;
      inset = Math.ceil(radiusForBounds - Math.sqrt((radiusForBounds * radiusForBounds) - (dy * dy)));
    }

    const rowRect = {
      x: inset,
      y,
      width: Math.max(0, normalizedWidth - (inset * 2)),
      height: 1,
    };
    if (rowRect.width <= 0) continue;

    if (activeRect && activeRect.x === rowRect.x && activeRect.width === rowRect.width) {
      activeRect.height += 1;
    } else {
      activeRect = rowRect;
      rects.push(activeRect);
    }
  }

  return rects;
}

export function resolveDesktopWindowBackgroundColorForEffect({
  mode,
  appearance,
  desktopWindowBackground,
  transparentWindowBackground,
}: Pick<DesktopWindowEffectInput, "mode" | "appearance" | "desktopWindowBackground" | "transparentWindowBackground">): string {
  return mode === "opaque"
    ? desktopWindowBackground[appearance]
    : transparentWindowBackground[appearance];
}

export function resolveDesktopWindowEffects({
  platform,
  mode,
  appearance,
  desktopWindowBackground,
  transparentWindowBackground,
}: DesktopWindowEffectInput): DesktopWindowEffectOptions {
  const titleBarStyle = platform === "darwin" ? "hiddenInset" : undefined;
  const transparentBackground = transparentWindowBackground[appearance];
  if (mode === "transparent") {
    return {
      ...(titleBarStyle ? { titleBarStyle } : {}),
      transparent: true,
      backgroundColor: platform === "win32" ? WINDOWS_TRANSPARENT_WINDOW_BACKGROUND : transparentBackground,
    };
  }
  if (mode === "transparent_vibrant") {
    if (platform === "darwin") {
      return {
        titleBarStyle: "hiddenInset",
        transparent: true,
        backgroundColor: transparentBackground,
        vibrancy: "under-window",
        visualEffectState: "active",
      };
    }
    return {
      transparent: true,
      backgroundColor: platform === "win32" ? WINDOWS_TRANSPARENT_WINDOW_BACKGROUND : transparentBackground,
    };
  }
  return {
    ...(titleBarStyle ? { titleBarStyle } : {}),
    backgroundColor: desktopWindowBackground[appearance],
    ...(platform === "darwin" ? { vibrancy: "under-window", visualEffectState: "active" } : {}),
  };
}
