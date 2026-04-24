import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import type { InstanceLocale } from "@rudderhq/shared";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";
import { en, type TranslationKey } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import { LegacyI18nBridge } from "./LegacyI18nBridge";

type TranslationParams = Record<string, string | number>;

type I18nContextValue = {
  locale: InstanceLocale;
  t: (key: TranslationKey, params?: TranslationParams) => string;
};

const dictionaries = {
  en,
  "zh-CN": zhCN,
} as const;

const I18nContext = createContext<I18nContextValue | null>(null);

function interpolate(template: string, params?: TranslationParams) {
  if (!params) return template;
  return template.replaceAll(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = params[key];
    return value == null ? match : String(value);
  });
}

export function translateMessage(locale: InstanceLocale, key: TranslationKey, params?: TranslationParams) {
  const template = dictionaries[locale][key] ?? en[key];
  return interpolate(template, params);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });

  const locale: InstanceLocale = healthQuery.data?.uiLocale ?? "en";

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.lang = locale;
  }, [locale]);

  const t = useCallback((key: TranslationKey, params?: TranslationParams) => translateMessage(locale, key, params), [locale]);

  const value = useMemo(() => ({ locale, t }), [locale, t]);

  return (
    <I18nContext.Provider value={value}>
      <LegacyI18nBridge locale={locale} />
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return context;
}
