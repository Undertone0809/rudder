import {
  SettingsChoiceCard,
  SettingsDivider,
  SettingsPageHeader,
  SettingsSection,
} from "@/components/settings/SettingsScaffold";
import { Palette } from "lucide-react";
import { useEffect } from "react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useI18n } from "../context/I18nContext";
import { useTheme } from "../context/ThemeContext";

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

const BASE_COLOR_OPTIONS: BaseColor[] = ["neutral", "stone", "zinc", "mauve", "olive", "mist", "taupe"];
const ACCENT_THEME_OPTIONS: AccentTheme[] = [
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

function ThemePreview({ mode }: { mode: "light" | "system" | "dark" }) {
  return (
    <div className="grid gap-2">
      <div
        className="h-14 rounded-[calc(var(--radius-md)-4px)] border border-white/8"
        style={{
          background:
            mode === "light"
              ? "linear-gradient(180deg, #f4efe7 0%, #ece6dd 100%)"
              : mode === "dark"
                ? "linear-gradient(180deg, #312c28 0%, #262220 100%)"
                : "linear-gradient(90deg, #f1ece5 0%, #f1ece5 50%, #2b2724 50%, #2b2724 100%)",
        }}
      >
        <div className="flex h-full flex-col justify-between p-2.5">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <div
                className="h-1.5 w-10 rounded-full"
                style={{ background: mode === "dark" ? "rgb(255 255 255 / 0.28)" : "rgb(50 45 40 / 0.14)" }}
              />
              <div
                className="h-1.5 w-7 rounded-full"
                style={{ background: mode === "dark" ? "rgb(255 255 255 / 0.18)" : "rgb(50 45 40 / 0.10)" }}
              />
            </div>
            <div
              className="rounded-full px-2 py-1"
              style={{ background: mode === "dark" ? "rgb(0 0 0 / 0.38)" : "rgb(255 255 255 / 0.52)" }}
            >
              <div
                className="h-1.5 w-6 rounded-full"
                style={{ background: mode === "dark" ? "rgb(255 255 255 / 0.28)" : "rgb(50 45 40 / 0.14)" }}
              />
            </div>
          </div>
          <div
            className="flex items-center justify-between rounded-[12px] border px-2 py-1.5"
            style={{
              background: mode === "dark" ? "rgb(255 255 255 / 0.10)" : "rgb(255 255 255 / 0.68)",
              borderColor: mode === "dark" ? "rgb(255 255 255 / 0.10)" : "rgb(50 45 40 / 0.08)",
            }}
          >
            <div
              className="h-1.5 w-12 rounded-full"
              style={{ background: mode === "dark" ? "rgb(255 255 255 / 0.20)" : "rgb(50 45 40 / 0.12)" }}
            />
            <div className="h-2.5 w-2.5 rounded-full bg-[color:var(--accent-base)]" />
          </div>
        </div>
      </div>
    </div>
  );
}

function DesignStylePreview({ style }: { style: DesignStyle }) {
  const tokens: Record<DesignStyle, {
    background: string;
    surface: string;
    inset: string;
    border: string;
    chart: string;
    radius: string;
    buttonHeight: string;
    gap: string;
  }> = {
    default: {
      background: "#1f1f1d",
      surface: "#282826",
      inset: "#343431",
      border: "rgb(255 255 255 / 0.10)",
      chart: "#9c978b",
      radius: "8px",
      buttonHeight: "10px",
      gap: "6px",
    },
    mira: {
      background: "#050604",
      surface: "#1a1b15",
      inset: "#24251d",
      border: "#313229",
      chart: "#8b8b76",
      radius: "6px",
      buttonHeight: "8px",
      gap: "4px",
    },
    luma: {
      background: "#050604",
      surface: "#191a14",
      inset: "#26271f",
      border: "#2d2e27",
      chart: "#878772",
      radius: "18px",
      buttonHeight: "13px",
      gap: "8px",
    },
  };
  const token = tokens[style];

  return (
    <div
      className="grid h-14 grid-cols-[0.52fr_1fr] p-2"
      style={{
        background: token.background,
        borderRadius: token.radius,
        gap: token.gap,
      }}
    >
      <div
        className="space-y-1.5 border"
        style={{
          background: token.surface,
          borderColor: token.border,
          borderRadius: `calc(${token.radius} - 2px)`,
          padding: token.gap,
        }}
      >
        <div className="h-1.5 w-8 rounded-full" style={{ background: "rgb(255 255 255 / 0.42)" }} />
        <div className="h-1.5 w-5 rounded-full" style={{ background: "rgb(255 255 255 / 0.20)" }} />
        <div className="h-1.5 w-7 rounded-full" style={{ background: token.chart }} />
      </div>
      <div
        className="flex flex-col justify-between border p-1.5"
        style={{
          background: token.surface,
          borderColor: token.border,
          borderRadius: token.radius,
        }}
      >
        <div className="grid grid-cols-3 items-end gap-1">
          <div className="h-4 rounded-[3px]" style={{ background: token.chart }} />
          <div className="h-6 rounded-[3px]" style={{ background: token.chart }} />
          <div className="h-3 rounded-[3px]" style={{ background: token.chart }} />
        </div>
        <div
          className="flex items-center justify-between border px-1.5 py-1"
          style={{
            background: token.inset,
            borderColor: token.border,
            borderRadius: `calc(${token.radius} - 3px)`,
          }}
        >
          <div className="h-1.5 w-10 rounded-full" style={{ background: "rgb(255 255 255 / 0.26)" }} />
          <div
            className="w-8 border"
            style={{
              height: token.buttonHeight,
              background: "rgb(255 255 255 / 0.18)",
              borderColor: "rgb(255 255 255 / 0.20)",
              borderRadius: token.radius,
            }}
          />
        </div>
      </div>
    </div>
  );
}

function BaseColorPreview({ baseColor }: { baseColor: BaseColor }) {
  const tokens: Record<BaseColor, {
    page: string;
    shell: string;
    inset: string;
    border: string;
    ink: string;
    chart: string;
  }> = {
    neutral: {
      page: "#f1f0ef",
      shell: "#e9e7e4",
      inset: "#dedbd6",
      border: "#c9c5bd",
      ink: "#383632",
      chart: "#7b776e",
    },
    stone: {
      page: "#f3f1ed",
      shell: "#e9e5de",
      inset: "#ddd8cf",
      border: "#c2baae",
      ink: "#3d3832",
      chart: "#776f63",
    },
    zinc: {
      page: "#f2f2f4",
      shell: "#e7e7eb",
      inset: "#dbdbe2",
      border: "#bcbcc6",
      ink: "#39393f",
      chart: "#70707b",
    },
    mauve: {
      page: "#f4eff3",
      shell: "#ebe2e9",
      inset: "#ded3dc",
      border: "#c3b5bf",
      ink: "#40363d",
      chart: "#7b6974",
    },
    olive: {
      page: "#f2f1e7",
      shell: "#e5e4d4",
      inset: "#d7d6c0",
      border: "#b9b89f",
      ink: "#303328",
      chart: "#76785f",
    },
    mist: {
      page: "#eef3f3",
      shell: "#e0eaea",
      inset: "#d0dddd",
      border: "#b0c1c1",
      ink: "#344041",
      chart: "#668083",
    },
    taupe: {
      page: "#f1ece8",
      shell: "#e8ddd6",
      inset: "#d9cbc1",
      border: "#c0b1a5",
      ink: "#40362f",
      chart: "#7d695b",
    },
  };
  const token = tokens[baseColor];

  return (
    <div className="grid h-14 gap-1.5 rounded-[var(--settings-choice-preview-radius)] border p-2" style={{ background: token.page, borderColor: token.border }}>
      <div className="flex items-center gap-1.5">
        <div className="h-3 w-3 rounded-full" style={{ background: token.ink }} />
        <div className="h-1.5 w-14 rounded-full" style={{ background: token.ink, opacity: 0.38 }} />
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        <div className="h-6 rounded-[6px] border" style={{ background: token.shell, borderColor: token.border }} />
        <div className="h-6 rounded-[6px] border" style={{ background: token.inset, borderColor: token.border }} />
        <div className="h-6 rounded-[6px]" style={{ background: token.chart }} />
      </div>
    </div>
  );
}

function AccentThemePreview({ accentTheme }: { accentTheme: AccentTheme }) {
  const tokens: Record<AccentTheme, {
    primary: string;
    soft: string;
    ring: string;
    foreground: string;
  }> = {
    neutral: {
      primary: "#2d2c29",
      soft: "#dedbd6",
      ring: "#8c887f",
      foreground: "#f6f5f2",
    },
    amber: {
      primary: "#d97706",
      soft: "#fef3c7",
      ring: "#f59e0b",
      foreground: "#fffbeb",
    },
    blue: {
      primary: "#2563eb",
      soft: "#dbeafe",
      ring: "#3b82f6",
      foreground: "#eff6ff",
    },
    cyan: {
      primary: "#0891b2",
      soft: "#cffafe",
      ring: "#06b6d4",
      foreground: "#ecfeff",
    },
    emerald: {
      primary: "#047857",
      soft: "#d6efe5",
      ring: "#10b981",
      foreground: "#ecfdf5",
    },
    fuchsia: {
      primary: "#c026d3",
      soft: "#fae8ff",
      ring: "#d946ef",
      foreground: "#fdf4ff",
    },
    green: {
      primary: "#15803d",
      soft: "#dcfce7",
      ring: "#22c55e",
      foreground: "#f0fdf4",
    },
    indigo: {
      primary: "#4f46e5",
      soft: "#e0e7ff",
      ring: "#6366f1",
      foreground: "#eef2ff",
    },
    lime: {
      primary: "#65a30d",
      soft: "#ecfccb",
      ring: "#84cc16",
      foreground: "#f7fee7",
    },
    orange: {
      primary: "#ea580c",
      soft: "#ffedd5",
      ring: "#f97316",
      foreground: "#fff7ed",
    },
    pink: {
      primary: "#db2777",
      soft: "#fce7f3",
      ring: "#ec4899",
      foreground: "#fdf2f8",
    },
  };
  const token = tokens[accentTheme];

  return (
    <div className="grid h-14 gap-2 rounded-[var(--settings-choice-preview-radius)] border border-[color:var(--border-soft)] bg-[color:var(--surface-inset)] p-2">
      <div className="flex items-center gap-1.5">
        <div className="h-3 w-3 rounded-full" style={{ background: token.primary }} />
        <div className="h-3 w-3 rounded-full" style={{ background: token.ring }} />
        <div className="h-3 w-3 rounded-full" style={{ background: token.soft }} />
      </div>
      <div className="flex items-center justify-between rounded-[var(--control-radius)] border px-2" style={{ background: token.primary, borderColor: token.ring, color: token.foreground, height: "var(--control-height-sm)" }}>
        <div className="h-1.5 w-12 rounded-full" style={{ background: token.foreground, opacity: 0.78 }} />
        <div className="h-1.5 w-4 rounded-full" style={{ background: token.foreground, opacity: 0.46 }} />
      </div>
    </div>
  );
}

export function InstanceAppearanceSettings() {
  const { t } = useI18n();
  const { setBreadcrumbs } = useBreadcrumbs();
  const {
    theme,
    designStyle,
    baseColor,
    accentTheme,
    setTheme,
    setDesignStyle,
    setBaseColor,
    setAccentTheme,
  } = useTheme();

  useEffect(() => {
    setBreadcrumbs([
      { label: t("common.systemSettings") },
      { label: t("general.appearance.title") },
    ]);
  }, [setBreadcrumbs, t]);

  return (
    <div className="mx-auto max-w-4xl space-y-7 px-1 pb-6">
      <SettingsPageHeader
        icon={Palette}
        title={t("general.appearance.title")}
        description={t("general.appearance.description")}
      />

      <SettingsDivider />

      <SettingsSection title={t("general.appearance.colorMode")}>
        <div className="flex flex-wrap gap-2.5">
          <SettingsChoiceCard
            label={t("general.appearance.light.label")}
            description={t("general.appearance.light.description")}
            selected={theme === "light"}
            onClick={() => setTheme("light")}
            preview={<ThemePreview mode="light" />}
          />
          <SettingsChoiceCard
            label={t("general.appearance.system.label")}
            description={t("general.appearance.system.description")}
            selected={theme === "system"}
            onClick={() => setTheme("system")}
            preview={<ThemePreview mode="system" />}
          />
          <SettingsChoiceCard
            label={t("general.appearance.dark.label")}
            description={t("general.appearance.dark.description")}
            selected={theme === "dark"}
            onClick={() => setTheme("dark")}
            preview={<ThemePreview mode="dark" />}
          />
        </div>
      </SettingsSection>

      <SettingsSection title={t("general.appearance.designStyle")}>
        <div className="flex flex-wrap gap-2.5">
          <SettingsChoiceCard
            label={t("general.appearance.defaultStyle.label")}
            description={t("general.appearance.defaultStyle.description")}
            selected={designStyle === "default"}
            onClick={() => setDesignStyle("default")}
            preview={<DesignStylePreview style="default" />}
          />
          <SettingsChoiceCard
            label={t("general.appearance.mira.label")}
            description={t("general.appearance.mira.description")}
            selected={designStyle === "mira"}
            onClick={() => setDesignStyle("mira")}
            preview={<DesignStylePreview style="mira" />}
          />
          <SettingsChoiceCard
            label={t("general.appearance.luma.label")}
            description={t("general.appearance.luma.description")}
            selected={designStyle === "luma"}
            onClick={() => setDesignStyle("luma")}
            preview={<DesignStylePreview style="luma" />}
          />
        </div>
      </SettingsSection>

      <SettingsSection title={t("general.appearance.baseColor")}>
        <div className="flex flex-wrap gap-2.5">
          {BASE_COLOR_OPTIONS.map((option) => (
            <SettingsChoiceCard
              key={option}
              label={t(`general.appearance.base.${option}.label`)}
              description={t(`general.appearance.base.${option}.description`)}
              selected={baseColor === option}
              onClick={() => setBaseColor(option)}
              preview={<BaseColorPreview baseColor={option} />}
            />
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title={t("general.appearance.themeColor")}>
        <div className="flex flex-wrap gap-2.5">
          {ACCENT_THEME_OPTIONS.map((option) => (
            <SettingsChoiceCard
              key={option}
              label={t(`general.appearance.theme.${option}.label`)}
              description={t(`general.appearance.theme.${option}.description`)}
              selected={accentTheme === option}
              onClick={() => setAccentTheme(option)}
              preview={<AccentThemePreview accentTheme={option} />}
            />
          ))}
        </div>
      </SettingsSection>
    </div>
  );
}
