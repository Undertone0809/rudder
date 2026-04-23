import { describe, expect, it } from "vitest";
import {
  applyThemePreferenceToNativeTheme,
  resolveAppearanceForThemePreference,
  type DesktopThemePreference,
} from "./theme-preference.js";

describe("resolveAppearanceForThemePreference", () => {
  it("keeps explicit light and dark preferences fixed", () => {
    expect(resolveAppearanceForThemePreference("light", true)).toBe("light");
    expect(resolveAppearanceForThemePreference("dark", false)).toBe("dark");
  });

  it("follows the system appearance when the preference is system", () => {
    expect(resolveAppearanceForThemePreference("system", false)).toBe("light");
    expect(resolveAppearanceForThemePreference("system", true)).toBe("dark");
  });
});

describe("applyThemePreferenceToNativeTheme", () => {
  it("updates the native theme source and resolves the active appearance", () => {
    const nativeThemeLike: { shouldUseDarkColors: boolean; themeSource: DesktopThemePreference } = {
      shouldUseDarkColors: true,
      themeSource: "system",
    };

    expect(applyThemePreferenceToNativeTheme(nativeThemeLike, "light")).toBe("light");
    expect(nativeThemeLike.themeSource).toBe("light");
  });

  it("keeps system preference aligned with the current system appearance", () => {
    const nativeThemeLike: { shouldUseDarkColors: boolean; themeSource: DesktopThemePreference } = {
      shouldUseDarkColors: false,
      themeSource: "dark",
    };

    expect(applyThemePreferenceToNativeTheme(nativeThemeLike, "system")).toBe("light");
    expect(nativeThemeLike.themeSource).toBe("system");
  });
});
