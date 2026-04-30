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

function normalizeSkillCandidate(value: string | null | undefined) {
  return value
    ?.trim()
    .replace(/^\$/u, "")
    .replace(/[?#].*$/u, "")
    .replace(/\/+$/u, "")
    .toLowerCase() || "";
}

function addSkillCandidate(candidates: Set<string>, value: string | null | undefined) {
  const normalized = normalizeSkillCandidate(value);
  if (!normalized) return;
  candidates.add(normalized);
  const lastSegment = normalized.split(/[/:]/u).filter(Boolean).at(-1);
  if (lastSegment) candidates.add(lastSegment);
}

function readSkillReferenceSlug(href: string) {
  const normalized = href.trim().replace(/[?#].*$/u, "").replace(/\/+$/u, "");
  if (!normalized) return null;
  if (normalized.endsWith("/SKILL.md")) {
    return normalized.slice(0, -"/SKILL.md".length).split("/").filter(Boolean).at(-1) ?? null;
  }
  if (normalized.toLowerCase().endsWith(".md")) {
    const fileName = normalized.split("/").filter(Boolean).at(-1) ?? "";
    return fileName.replace(/\.md$/iu, "") || null;
  }
  return null;
}

function collectSkillReferences(prompt: string) {
  const references: Array<{ key: string; label: string; candidates: Set<string> }> = [];
  const pattern = /\[([^\]\n]+)\]\(([^)\n]+(?:\/SKILL\.md|\.md)(?:[?#][^)\n]*)?)\)/giu;
  for (const match of prompt.matchAll(pattern)) {
    const rawLabel = match[1]?.trim() ?? "";
    const href = match[2]?.trim() ?? "";
    if (!rawLabel || !href) continue;
    const labelWithoutPrefix = rawLabel.replace(/^\$/u, "").trim();
    const slug = readSkillReferenceSlug(href);
    const isExplicitSkillToken = rawLabel.startsWith("$") || href.replace(/[?#].*$/u, "").endsWith("/SKILL.md");
    if (!isExplicitSkillToken) continue;

    const key = labelWithoutPrefix || slug;
    if (!key) continue;
    const label = slug ?? fallbackSkillLabel(key);
    const candidates = new Set<string>();
    addSkillCandidate(candidates, labelWithoutPrefix);
    addSkillCandidate(candidates, slug);
    addSkillCandidate(candidates, href);
    references.push({ key, label, candidates });
  }
  return references;
}

export function inferUsedSkillsFromPrompt(
  prompt: unknown,
  loadedSkills: unknown[],
): Array<{ key: string; label: string }> {
  const promptText = readNonEmptyString(prompt);
  if (!promptText) return [];

  const references = collectSkillReferences(promptText);
  if (references.length === 0) return [];

  const loaded = loadedSkills
    .map((entry) => normalizeLoadedSkill(entry))
    .filter((entry): entry is { key: string; label: string } => Boolean(entry))
    .map((entry) => {
      const candidates = new Set<string>();
      addSkillCandidate(candidates, entry.key);
      addSkillCandidate(candidates, entry.label);
      return { ...entry, candidates };
    });

  const used = new Map<string, { key: string; label: string }>();
  for (const reference of references) {
    const matched = loaded.find((entry) => {
      for (const candidate of reference.candidates) {
        if (entry.candidates.has(candidate)) return true;
      }
      return false;
    });
    const normalized = matched ?? { key: reference.key, label: reference.label };
    if (!used.has(normalized.key)) used.set(normalized.key, normalized);
  }

  return Array.from(used.values());
}
