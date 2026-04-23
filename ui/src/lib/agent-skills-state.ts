import type { AgentSkillEntry } from "@rudder/shared";

export interface AgentSkillDraftState {
  draft: string[];
  lastSaved: string[];
  hasHydratedSnapshot: boolean;
}

export interface AgentSkillSnapshotApplyResult extends AgentSkillDraftState {
  shouldSkipAutosave: boolean;
}

export function arraysEqual(a: string[], b: string[]) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

export function sortUnique(values: string[]) {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

export interface SortableSkillRow {
  selectionKey: string;
  name: string;
  alwaysEnabled?: boolean;
}

export function sortSkillRowsByPinnedSelectionKey<T extends SortableSkillRow>(
  rows: T[],
  pinnedSelectionKeys: Iterable<string>,
) {
  const pinnedSelectionKeySet = pinnedSelectionKeys instanceof Set
    ? pinnedSelectionKeys
    : new Set(pinnedSelectionKeys);

  return [...rows].sort((left, right) => {
    const leftPinned = Boolean(left.alwaysEnabled) || pinnedSelectionKeySet.has(left.selectionKey);
    const rightPinned = Boolean(right.alwaysEnabled) || pinnedSelectionKeySet.has(right.selectionKey);
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
    return left.name.localeCompare(right.name) || left.selectionKey.localeCompare(right.selectionKey);
  });
}

export function applyAgentSkillSnapshot(
  state: AgentSkillDraftState,
  desiredSkills: string[],
): AgentSkillSnapshotApplyResult {
  const normalizedDesiredSkills = sortUnique(desiredSkills);
  const shouldReplaceDraft = !state.hasHydratedSnapshot || arraysEqual(state.draft, state.lastSaved);

  return {
    draft: shouldReplaceDraft ? normalizedDesiredSkills : state.draft,
    lastSaved: normalizedDesiredSkills,
    hasHydratedSnapshot: true,
    shouldSkipAutosave: shouldReplaceDraft,
  };
}

export function isExternalSkillEntry(entry: AgentSkillEntry) {
  return entry.sourceClass === "agent_home" || entry.sourceClass === "global" || entry.sourceClass === "adapter_home";
}

export function canManageSkillEntry(entry: AgentSkillEntry) {
  return entry.configurable;
}

export function toggleSkillSelection(
  currentDraft: string[],
  targetEntry: AgentSkillEntry,
  enabled: boolean,
  entries: AgentSkillEntry[],
) {
  if (!targetEntry.configurable) return sortUnique(currentDraft);

  const entryBySelectionKey = new Map(entries.map((entry) => [entry.selectionKey, entry]));
  const filteredCurrentDraft = currentDraft.filter((selectionKey) => {
    const existing = entryBySelectionKey.get(selectionKey);
    if (!existing) return selectionKey !== targetEntry.selectionKey;
    if (!enabled) return selectionKey !== targetEntry.selectionKey;
    if (selectionKey === targetEntry.selectionKey) return false;
    return existing.key !== targetEntry.key;
  });

  return sortUnique(
    enabled
      ? [...filteredCurrentDraft, targetEntry.selectionKey]
      : filteredCurrentDraft,
  );
}
