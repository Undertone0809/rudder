import { priorityColor, priorityColorDefault } from "./status-colors";

export type PriorityValue = "critical" | "high" | "medium" | "low";

export type PriorityVisualConfig = {
  value: PriorityValue;
  label: string;
  level: number;
  color: string;
  menuLabelClassName: string;
};

export const priorityConfig: Record<PriorityValue, PriorityVisualConfig> = {
  critical: {
    value: "critical",
    label: "Urgent",
    level: 4,
    color: priorityColor.critical ?? priorityColorDefault,
    menuLabelClassName: "font-medium text-orange-700 dark:text-orange-300",
  },
  high: {
    value: "high",
    label: "High",
    level: 3,
    color: priorityColor.high ?? priorityColorDefault,
    menuLabelClassName: "font-medium text-orange-600 dark:text-orange-300",
  },
  medium: {
    value: "medium",
    label: "Medium",
    level: 2,
    color: priorityColor.medium ?? priorityColorDefault,
    menuLabelClassName: "font-medium text-foreground",
  },
  low: {
    value: "low",
    label: "Low",
    level: 1,
    color: priorityColor.low ?? priorityColorDefault,
    menuLabelClassName: "font-medium text-muted-foreground",
  },
};

export const priorityValues: PriorityValue[] = ["critical", "high", "medium", "low"];
export const priorityOptions = priorityValues.map((priority) => priorityConfig[priority]);

function titleCasePriority(priority: string): string {
  return priority.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function getPriorityConfig(priority: string): PriorityVisualConfig {
  return priorityConfig[priority as PriorityValue] ?? priorityConfig.medium;
}

export function formatPriorityLabel(priority: string): string {
  return priorityConfig[priority as PriorityValue]?.label ?? titleCasePriority(priority);
}
