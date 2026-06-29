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

export function InstanceAppearanceSettings() {
  const { t } = useI18n();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { theme, setTheme } = useTheme();

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
    </div>
  );
}
