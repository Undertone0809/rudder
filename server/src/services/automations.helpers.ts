import { automations } from "@rudderhq/db";
import type { Automation } from "@rudderhq/shared";

type AutomationRow = typeof automations.$inferSelect;

export function toAutomation(row: AutomationRow): Automation {
  return {
    ...row,
    outputMode: row.outputMode as Automation["outputMode"],
  };
}

export function automationRuntimeConfig(automation: AutomationRow): Record<string, unknown> {
  const overrides = automation.assigneeAgentRuntimeOverrides;
  const value = overrides && typeof overrides === "object" && !Array.isArray(overrides)
    ? (overrides as Record<string, unknown>).agentRuntimeConfig
    : null;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
