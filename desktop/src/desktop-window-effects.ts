import type { DesktopAppearance } from "./theme-preference.js";

export type DesktopWindowEffectMode = "opaque" | "transparent" | "transparent_vibrant";

export type DesktopWindowEffectOptions = {
  backgroundColor: string;
  titleBarStyle?: "hiddenInset";
  transparent?: boolean;
  vibrancy?: "under-window";
  visualEffectState?: "active";
  backgroundMaterial?: "mica";
};

export type DesktopWindowChromeOptions = {
  frame?: boolean;
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

export function resolveDesktopWindowEffectMode(env: NodeJS.ProcessEnv): DesktopWindowEffectMode {
  const value = env.RUDDER_DESKTOP_WINDOW_EFFECT_MODE ?? env.RUDDER_DESKTOP_MAC_WINDOW_MODE;
  const override = normalizeDesktopWindowEffectMode(value);
  if (override) return override;
  return "transparent_vibrant";
}

export function resolveDesktopWindowChromeOptions(platform: NodeJS.Platform): DesktopWindowChromeOptions {
  return platform === "win32" ? { frame: false } : {};
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
      backgroundColor: transparentBackground,
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
    if (platform === "win32") {
      return {
        transparent: true,
        backgroundColor: transparentBackground,
        backgroundMaterial: "mica",
      };
    }
    return {
      transparent: true,
      backgroundColor: transparentBackground,
    };
  }
  return {
    ...(titleBarStyle ? { titleBarStyle } : {}),
    backgroundColor: desktopWindowBackground[appearance],
    ...(platform === "darwin" ? { vibrancy: "under-window", visualEffectState: "active" } : {}),
  };
}
