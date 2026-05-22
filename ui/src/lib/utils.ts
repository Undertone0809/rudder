import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { deriveAgentUrlKey, deriveProjectUrlKey } from "@rudderhq/shared";
import type { BillingType, FinanceDirection, FinanceEventKind, InstanceLocale } from "@rudderhq/shared";
import { translateLegacyString } from "@/i18n/legacyPhrases";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function getUiLocale(): InstanceLocale {
  if (typeof document !== "undefined") {
    const lang = document.documentElement.lang?.trim().toLowerCase() ?? "";
    if (lang.startsWith("zh")) return "zh-CN";
  }
  return "en";
}

function localizeLegacyLabel(label: string) {
  return translateLegacyString(getUiLocale(), label);
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function formatDate(date: Date | string): string {
  const locale = getUiLocale();
  const resolvedLocale = locale === "zh-CN" ? "zh-CN" : "en-US";
  return new Intl.DateTimeFormat(resolvedLocale, locale === "zh-CN"
    ? {
        year: "numeric",
        month: "numeric",
        day: "numeric",
      }
    : {
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(new Date(date));
}

export function formatDateTime(date: Date | string): string {
  const locale = getUiLocale();
  const resolvedLocale = locale === "zh-CN" ? "zh-CN" : "en-US";
  return new Intl.DateTimeFormat(resolvedLocale, locale === "zh-CN"
    ? {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }
    : {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(date));
}

export function formatTime(date: Date | string, options: { seconds?: boolean; timeZoneName?: "short" } = {}): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    ...(options.seconds ? { second: "2-digit" } : {}),
    ...(options.timeZoneName ? { timeZoneName: options.timeZoneName } : {}),
    hourCycle: "h23",
  }).format(new Date(date));
}

export function formatDateTimeSeconds(date: Date | string): string {
  const timestamp = new Date(date);
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    timestamp.getFullYear(),
    pad(timestamp.getMonth() + 1),
    pad(timestamp.getDate()),
  ].join("-") + ` ${pad(timestamp.getHours())}:${pad(timestamp.getMinutes())}:${pad(timestamp.getSeconds())}`;
}

export function relativeTime(date: Date | string): string {
  const locale = getUiLocale();
  const now = Date.now();
  const then = new Date(date).getTime();
  const diffSec = Math.round((now - then) / 1000);
  if (diffSec < 60) return locale === "zh-CN" ? "刚刚" : "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return locale === "zh-CN" ? `${diffMin} 分钟前` : `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return locale === "zh-CN" ? `${diffHr} 小时前` : `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return locale === "zh-CN" ? `${diffDay} 天前` : `${diffDay}d ago`;
  return formatDate(date);
}

export function formatElapsedDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 1000) return "under 1s";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remainingSec = sec % 60;
  if (min < 60) return remainingSec > 0 ? `${min}m ${remainingSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remainingMin = min % 60;
  if (hr < 24) return remainingMin > 0 ? `${hr}h ${remainingMin}m` : `${hr}h`;
  const days = Math.floor(hr / 24);
  const remainingHr = hr % 24;
  return remainingHr > 0 ? `${days}d ${remainingHr}h` : `${days}d`;
}

export function formatRunElapsedDuration(
  startedAt: Date | string | null | undefined,
  endedAt?: Date | string | null,
  now = Date.now(),
): string | null {
  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : now;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return formatElapsedDuration(end - start);
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Map a raw provider slug to a display-friendly name. */
export function providerDisplayName(provider: string): string {
  const map: Record<string, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    openrouter: "OpenRouter",
    chatgpt: "ChatGPT",
    google: "Google",
    cursor: "Cursor",
    jetbrains: "JetBrains AI",
  };
  return map[provider.toLowerCase()] ?? provider;
}

export function billingTypeDisplayName(billingType: BillingType): string {
  const map: Record<BillingType, string> = {
    metered_api: "Metered API",
    subscription_included: "Subscription",
    subscription_overage: "Subscription overage",
    credits: "Credits",
    fixed: "Fixed",
    unknown: "Unknown",
  };
  return localizeLegacyLabel(map[billingType]);
}

export function quotaSourceDisplayName(source: string): string {
  const map: Record<string, string> = {
    "anthropic-oauth": "Anthropic OAuth",
    "claude-cli": "Claude CLI",
    "codex-rpc": "Codex app server",
    "codex-wham": "ChatGPT WHAM",
  };
  return localizeLegacyLabel(map[source] ?? source);
}

function coerceBillingType(value: unknown): BillingType | null {
  if (
    value === "metered_api" ||
    value === "subscription_included" ||
    value === "subscription_overage" ||
    value === "credits" ||
    value === "fixed" ||
    value === "unknown"
  ) {
    return value;
  }
  return null;
}

function readRunCostUsd(payload: Record<string, unknown> | null): number {
  if (!payload) return 0;
  for (const key of ["costUsd", "cost_usd", "total_cost_usd"] as const) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

export function visibleRunCostUsd(
  usage: Record<string, unknown> | null,
  result: Record<string, unknown> | null = null,
): number {
  const billingType = coerceBillingType(usage?.billingType) ?? coerceBillingType(result?.billingType);
  if (billingType === "subscription_included") return 0;
  return readRunCostUsd(usage) || readRunCostUsd(result);
}

export function financeEventKindDisplayName(eventKind: FinanceEventKind): string {
  const map: Record<FinanceEventKind, string> = {
    inference_charge: "Inference charge",
    platform_fee: "Platform fee",
    credit_purchase: "Credit purchase",
    credit_refund: "Credit refund",
    credit_expiry: "Credit expiry",
    byok_fee: "BYOK fee",
    gateway_overhead: "Gateway overhead",
    log_storage_charge: "Log storage",
    logpush_charge: "Logpush",
    provisioned_capacity_charge: "Provisioned capacity",
    training_charge: "Training",
    custom_model_import_charge: "Custom model import",
    custom_model_storage_charge: "Custom model storage",
    manual_adjustment: "Manual adjustment",
  };
  return localizeLegacyLabel(map[eventKind]);
}

export function financeDirectionDisplayName(direction: FinanceDirection): string {
  return localizeLegacyLabel(direction === "credit" ? "Credit" : "Debit");
}

/** Build an issue URL using the human-readable identifier when available. */
export function issueUrl(issue: { id: string; identifier?: string | null }): string {
  return `/issues/${issue.identifier ?? issue.id}`;
}

/** Build an agent route URL using the short URL key when available. */
export function agentRouteRef(agent: { id: string; urlKey?: string | null; name?: string | null }): string {
  return agent.urlKey ?? deriveAgentUrlKey(agent.name, agent.id);
}

/** Build an agent URL using the short URL key when available. */
export function agentUrl(agent: { id: string; urlKey?: string | null; name?: string | null }): string {
  return `/agents/${agentRouteRef(agent)}`;
}

/** Build a project route reference using the short URL key when available. */
export function projectRouteRef(project: { id: string; urlKey?: string | null; name?: string | null }): string {
  return project.urlKey ?? deriveProjectUrlKey(project.name, project.id);
}

/** Build a project URL using the short URL key when available. */
export function projectUrl(project: { id: string; urlKey?: string | null; name?: string | null }): string {
  return `/projects/${projectRouteRef(project)}`;
}
