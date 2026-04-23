export type DesktopAppearance = "light" | "dark";
export type DesktopThemePreference = DesktopAppearance | "system";

type NativeThemeLike = {
  shouldUseDarkColors: boolean;
  themeSource: DesktopThemePreference;
};

export function resolveAppearanceForThemePreference(
  preference: DesktopThemePreference,
  shouldUseDarkColors: boolean,
): DesktopAppearance {
  if (preference === "system") {
    return shouldUseDarkColors ? "dark" : "light";
  }
  return preference;
}

export function applyThemePreferenceToNativeTheme(
  nativeThemeLike: NativeThemeLike,
  preference: DesktopThemePreference,
): DesktopAppearance {
  nativeThemeLike.themeSource = preference;
  return resolveAppearanceForThemePreference(preference, nativeThemeLike.shouldUseDarkColors);
}
