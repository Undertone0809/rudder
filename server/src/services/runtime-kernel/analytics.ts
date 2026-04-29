import { parseObject } from "../../agent-runtimes/utils.js";
import { readNonEmptyString } from "./common.js";

export function buildRecentDateKeys(windowDays: number, now: Date): string[] {
  return Array.from({ length: windowDays }, (_, index) => {
    const next = new Date(now);
    next.setUTCDate(next.getUTCDate() - (windowDays - 1 - index));
    return next.toISOString().slice(0, 10);
  });
}

export function buildDateKeysBetween(startDate: string, endDate: string): string[] {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start.getTime() > end.getTime()) {
    return [];
  }

  const days: string[] = [];
  const cursor = new Date(start);
  while (cursor.getTime() <= end.getTime()) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function fallbackSkillLabel(key: string) {
  const trimmed = key.trim();
  if (!trimmed) return "unknown";
  const slashSegments = trimmed.split("/").filter(Boolean);
  const lastSlashSegment = slashSegments.at(-1);
  if (lastSlashSegment) return lastSlashSegment;
  const colonSegments = trimmed.split(":").filter(Boolean);
  return colonSegments.at(-1) ?? trimmed;
}

export function normalizeLoadedSkill(value: unknown): { key: string; label: string } | null {
  const skill = parseObject(value);
  const rawKey = readNonEmptyString(skill.key);
  const rawRuntimeName = readNonEmptyString(skill.runtimeName);
  const rawName = readNonEmptyString(skill.name);
  const key = rawKey ?? rawRuntimeName ?? rawName;
  if (!key) return null;
  const label = rawRuntimeName ?? rawName ?? fallbackSkillLabel(key);
  return { key, label };
}
