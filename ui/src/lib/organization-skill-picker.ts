import {
  buildOrganizationSkillSearchText,
  formatOrganizationSkillPublicRef,
  isCanonicalBundledRudderSkillKey,
  type OrganizationSkillListItem,
  type OrganizationSkillPublicRefContext,
} from "@rudderhq/shared";
import { buildOrganizationSkillReferenceHref } from "./skill-reference";

export interface OrganizationSkillPickerItem extends OrganizationSkillListItem {
  publicRef: string;
  searchText: string;
  markdownTarget: string | null;
}

export function organizationSkillMarkdownTarget(skill: OrganizationSkillListItem) {
  return buildOrganizationSkillReferenceHref(skill.id, skill.slug || skill.key || skill.name);
}

export function buildOrganizationSkillPickerItems(
  skills: OrganizationSkillListItem[],
  context: OrganizationSkillPublicRefContext,
) {
  return skills
    .map((skill) => ({
      ...skill,
      publicRef: formatOrganizationSkillPublicRef(skill, context),
      searchText: buildOrganizationSkillSearchText(skill, context),
      markdownTarget: organizationSkillMarkdownTarget(skill),
    }))
    .sort((left, right) => left.publicRef.localeCompare(right.publicRef));
}

export function filterOrganizationSkillPickerItems(
  items: OrganizationSkillPickerItem[],
  query: string,
) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return items;
  return items.filter((item) => item.searchText.includes(normalizedQuery));
}

export function filterSelectableNewAgentOrganizationSkillItems(
  items: OrganizationSkillPickerItem[],
) {
  return items.filter((item) => !isCanonicalBundledRudderSkillKey(item.key));
}

export function appendSkillReferencesToDraft(draft: string, references: string[]) {
  const normalizedDraft = draft.replace(/\r\n/g, "\n");
  const uniqueReferences = Array.from(
    new Set(references.map((reference) => reference.trim()).filter((reference) => reference.length > 0)),
  );
  if (uniqueReferences.length === 0) return draft;

  const remainingReferences = uniqueReferences.filter((reference) => !normalizedDraft.includes(reference));
  if (remainingReferences.length === 0) return draft;

  const trimmedDraft = normalizedDraft.replace(/\s+$/u, "");
  const [lastReference, ...leadingReferences] = [...remainingReferences].reverse();
  const nextInline = [...leadingReferences.reverse(), `${lastReference}\u00A0`].join(" ");
  if (trimmedDraft.length === 0) return nextInline;
  return `${trimmedDraft} ${nextInline}`;
}
