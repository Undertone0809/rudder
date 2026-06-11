import type { InstanceLocale } from "@rudderhq/shared";

type LocalizedCopy = {
  en: string;
  "zh-CN": string;
};

const policyLabels: Record<string, LocalizedCopy> = {
  coalesce_if_active: { en: "coalesce if active", "zh-CN": "有运行时合并" },
  always_enqueue: { en: "always enqueue", "zh-CN": "始终排队" },
  skip_if_active: { en: "skip if active", "zh-CN": "有运行时跳过" },
  skip_missed: { en: "skip missed", "zh-CN": "跳过错过窗口" },
  enqueue_missed_with_cap: { en: "enqueue missed with cap", "zh-CN": "限量补跑错过窗口" },
};

export const concurrencyPolicyDescriptions: Record<string, LocalizedCopy> = {
  coalesce_if_active: {
    en: "Keep one follow-up run queued while an active run is still working.",
    "zh-CN": "当前运行仍在执行时，只保留一个后续运行排队。",
  },
  always_enqueue: {
    en: "Queue every trigger occurrence, even if several runs stack up.",
    "zh-CN": "每次触发都进入队列，即使多个运行堆积。",
  },
  skip_if_active: {
    en: "Drop overlapping trigger occurrences while the automation is already active.",
    "zh-CN": "自动化已有运行时，丢弃重叠触发。",
  },
};

export const catchUpPolicyDescriptions: Record<string, LocalizedCopy> = {
  skip_missed: {
    en: "Ignore schedule windows that were missed while the automation or scheduler was paused.",
    "zh-CN": "忽略自动化或调度器暂停期间错过的计划窗口。",
  },
  enqueue_missed_with_cap: {
    en: "Catch up missed schedule windows in capped batches after recovery.",
    "zh-CN": "恢复后按上限分批补跑错过的计划窗口。",
  },
};

export function localizedCopy(copy: LocalizedCopy, locale: InstanceLocale) {
  return copy[locale] ?? copy.en;
}

export function automationPolicyLabel(value: string, locale: InstanceLocale) {
  return localizedCopy(policyLabels[value] ?? { en: value.replaceAll("_", " "), "zh-CN": value.replaceAll("_", " ") }, locale);
}

export function automationPolicyDescription(
  descriptions: Record<string, LocalizedCopy>,
  value: string,
  locale: InstanceLocale,
) {
  const copy = descriptions[value];
  return copy ? localizedCopy(copy, locale) : value.replaceAll("_", " ");
}

export function humanizeAutomationToken(value: string, locale: InstanceLocale) {
  const label = automationPolicyLabel(value, locale);
  return label === value.replaceAll("_", " ") ? label : label;
}
