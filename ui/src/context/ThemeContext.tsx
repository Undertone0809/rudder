import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type Theme = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";
type DesignStyle = "default" | "mira" | "luma";
type BaseColor = "neutral" | "stone" | "zinc" | "mauve" | "olive" | "mist" | "taupe";
type AccentTheme =
  | "neutral"
  | "amber"
  | "blue"
  | "cyan"
  | "emerald"
  | "fuchsia"
  | "green"
  | "indigo"
  | "lime"
  | "orange"
  | "pink";
type DesktopShellThemeBridge = {
  setAppearance?: (theme: Theme) => Promise<void> | void;
};

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  designStyle: DesignStyle;
  baseColor: BaseColor;
  accentTheme: AccentTheme;
  setTheme: (theme: Theme) => void;
  setDesignStyle: (style: DesignStyle) => void;
  setBaseColor: (baseColor: BaseColor) => void;
  setAccentTheme: (accentTheme: AccentTheme) => void;
  toggleTheme: () => void;
}

const THEME_STORAGE_KEY = "rudder.theme";
const DESIGN_STYLE_STORAGE_KEY = "rudder.designStyle";
const DEFAULT_DESIGN_STYLE: DesignStyle = "luma";
const BASE_COLOR_STORAGE_KEY = "rudder.baseColor";
const ACCENT_THEME_STORAGE_KEY = "rudder.accentTheme";
const DARK_THEME_COLOR = "#1f1f1d";
const LIGHT_THEME_COLOR = "#f1f0ef";
const LIGHT_BASE_THEME_COLORS: Record<BaseColor, string> = {
  neutral: LIGHT_THEME_COLOR,
  stone: "#f3f1ed",
  zinc: "#f2f2f4",
  mauve: "#f4eff3",
  olive: "#f2f1e7",
  mist: "#eef3f3",
  taupe: "#f1ece8",
};
const DARK_BASE_THEME_COLORS: Record<BaseColor, string> = {
  neutral: DARK_THEME_COLOR,
  stone: "#151412",
  zinc: "#141416",
  mauve: "#181316",
  olive: "#050604",
  mist: "#101617",
  taupe: "#1a1411",
};
const BASE_COLORS: BaseColor[] = ["neutral", "stone", "zinc", "mauve", "olive", "mist", "taupe"];
const ACCENT_THEMES: AccentTheme[] = [
  "neutral",
  "amber",
  "blue",
  "cyan",
  "emerald",
  "fuchsia",
  "green",
  "indigo",
  "lime",
  "orange",
  "pink",
];
const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function readDesktopShell(): DesktopShellThemeBridge | null {
  if (typeof window === "undefined") return null;
  return (window as typeof window & { desktopShell?: DesktopShellThemeBridge }).desktopShell ?? null;
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getStoredThemePreference(): Theme {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // Ignore local storage read failures in restricted environments.
  }
  return "system";
}

function getStoredDesignStylePreference(): DesignStyle {
  if (typeof window === "undefined") return DEFAULT_DESIGN_STYLE;
  try {
    const stored = window.localStorage.getItem(DESIGN_STYLE_STORAGE_KEY);
    if (stored === "default" || stored === "mira" || stored === "luma") {
      return stored;
    }
  } catch {
    // Ignore local storage read failures in restricted environments.
  }
  return DEFAULT_DESIGN_STYLE;
}

function getStoredBaseColorPreference(): BaseColor {
  if (typeof window === "undefined") return "neutral";
  try {
    const stored = window.localStorage.getItem(BASE_COLOR_STORAGE_KEY);
    if (BASE_COLORS.includes(stored as BaseColor)) {
      return stored as BaseColor;
    }
  } catch {
    // Ignore local storage read failures in restricted environments.
  }
  return "neutral";
}

function getStoredAccentThemePreference(): AccentTheme {
  if (typeof window === "undefined") return "neutral";
  try {
    const stored = window.localStorage.getItem(ACCENT_THEME_STORAGE_KEY);
    if (ACCENT_THEMES.includes(stored as AccentTheme)) {
      return stored as AccentTheme;
    }
  } catch {
    // Ignore local storage read failures in restricted environments.
  }
  return "neutral";
}

function resolveThemePreference(theme: Theme): ResolvedTheme {
  return theme === "system" ? getSystemTheme() : theme;
}

function resolveThemeColor(resolvedTheme: ResolvedTheme, baseColor: BaseColor) {
  return resolvedTheme === "dark" ? DARK_BASE_THEME_COLORS[baseColor] : LIGHT_BASE_THEME_COLORS[baseColor];
}

function applyTheme(theme: Theme, designStyle: DesignStyle, baseColor: BaseColor, accentTheme: AccentTheme) {
  if (typeof document === "undefined") return;
  const resolvedTheme = resolveThemePreference(theme);
  const isDark = resolvedTheme === "dark";
  const themeColor = resolveThemeColor(resolvedTheme, baseColor);
  const root = document.documentElement;
  root.classList.toggle("dark", isDark);
  root.dataset.style = designStyle;
  root.dataset.baseColor = baseColor;
  root.dataset.themeColor = accentTheme;
  root.style.colorScheme = isDark ? "dark" : "light";
  root.style.backgroundColor = root.classList.contains("desktop-shell-macos")
    ? "transparent"
    : themeColor;
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (themeColorMeta instanceof HTMLMetaElement) {
    themeColorMeta.setAttribute("content", themeColor);
  }
  void readDesktopShell()?.setAppearance?.(theme);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => getStoredThemePreference());
  const [designStyle, setDesignStyleState] = useState<DesignStyle>(() => getStoredDesignStylePreference());
  const [baseColor, setBaseColorState] = useState<BaseColor>(() => getStoredBaseColorPreference());
  const [accentTheme, setAccentThemeState] = useState<AccentTheme>(() => getStoredAccentThemePreference());
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveThemePreference(getStoredThemePreference()));

  const setTheme = useCallback((nextTheme: Theme) => {
    setThemeState(nextTheme);
  }, []);

  const setDesignStyle = useCallback((nextStyle: DesignStyle) => {
    setDesignStyleState(nextStyle);
  }, []);

  const setBaseColor = useCallback((nextBaseColor: BaseColor) => {
    setBaseColorState(nextBaseColor);
  }, []);

  const setAccentTheme = useCallback((nextAccentTheme: AccentTheme) => {
    setAccentThemeState(nextAccentTheme);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((current) => {
      const nextResolvedTheme = resolveThemePreference(current) === "dark" ? "light" : "dark";
      return nextResolvedTheme;
    });
  }, []);

  useEffect(() => {
    applyTheme(theme, designStyle, baseColor, accentTheme);
    setResolvedTheme(resolveThemePreference(theme));
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
      localStorage.setItem(DESIGN_STYLE_STORAGE_KEY, designStyle);
      localStorage.setItem(BASE_COLOR_STORAGE_KEY, baseColor);
      localStorage.setItem(ACCENT_THEME_STORAGE_KEY, accentTheme);
    } catch {
      // Ignore local storage write failures in restricted environments.
    }
  }, [theme, designStyle, baseColor, accentTheme]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      if (theme !== "system") return;
      const nextResolvedTheme = getSystemTheme();
      setResolvedTheme(nextResolvedTheme);
      applyTheme("system", designStyle, baseColor, accentTheme);
    };
    media.addEventListener("change", handleChange);
    return () => {
      media.removeEventListener("change", handleChange);
    };
  }, [theme, designStyle, baseColor, accentTheme]);

  const value = useMemo(
    () => ({
      theme,
      resolvedTheme,
      designStyle,
      baseColor,
      accentTheme,
      setTheme,
      setDesignStyle,
      setBaseColor,
      setAccentTheme,
      toggleTheme,
    }),
    [
      theme,
      resolvedTheme,
      designStyle,
      baseColor,
      accentTheme,
      setTheme,
      setDesignStyle,
      setBaseColor,
      setAccentTheme,
      toggleTheme,
    ],
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
