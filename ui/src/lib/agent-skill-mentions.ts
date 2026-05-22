import {
  buildOrganizationSkillSearchText,
  formatOrganizationSkillPublicRef,
  type Agent,
  type AgentSkillEntry,
  type AgentSkillSnapshot,
  type OrganizationSkillListItem,
} from "@rudderhq/shared";
import { organizationSkillMarkdownTarget } from "./organization-skill-picker";
import { formatSkillReferenceDisplayLabel } from "./skill-reference";

export interface SkillMentionOption {
  id: string;
  name: string;
  kind: "skill";
  searchText: string;
  skillRefLabel: string;
  skillMarkdownTarget: string;
  skillDisplayName: string;
  skillDescription: string | null;
  skillCategoryLabel: string | null;
  skillLocationLabel: string | null;
  skillDetailsHref: string | null;
}

function normalizeMarkdownTarget(candidate: string | null | undefined) {
  if (!candidate) return null;
  const trimmed = candidate.replace(/\/$/, "");
  if (trimmed.endsWith("/SKILL.md") || trimmed.toLowerCase().endsWith(".md")) {
    return trimmed;
  }
  return `${trimmed}/SKILL.md`;
}

function isActiveSkillEntry(entry: AgentSkillEntry) {
  return (entry.alwaysEnabled || entry.desired) && entry.state !== "missing";
}

function parseOrganizationSkillKey(selectionKey: string) {
  if (selectionKey.startsWith("bundled:")) {
    return selectionKey.slice("bundled:".length);
  }
  if (selectionKey.startsWith("org:")) {
    return selectionKey.slice("org:".length);
  }
  return null;
}

function fallbackOrganizationSkillSearchText(publicRef: string, entry: AgentSkillEntry) {
  return [
    publicRef,
    entry.key,
    entry.runtimeName ?? "",
    entry.description ?? "",
    entry.originLabel ?? "",
    entry.locationLabel ?? "",
    entry.selectionKey,
  ]
    .join(" ")
    .toLowerCase();
}

function buildExternalSkillPublicRef(agent: Pick<Agent, "urlKey">, entry: AgentSkillEntry) {
  return `agent/${agent.urlKey}/${entry.key}`;
}

function buildSkillMentionLabel(entry: AgentSkillEntry, fallbackRef: string) {
  return formatSkillReferenceDisplayLabel(entry.runtimeName ?? entry.key ?? fallbackRef);
}

function normalizeOptionalText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function buildExternalSkillSearchText(publicRef: string, entry: AgentSkillEntry) {
  return [
    publicRef,
    entry.key,
    entry.runtimeName ?? "",
    entry.description ?? "",
    entry.detail ?? "",
    entry.originLabel ?? "",
    entry.locationLabel ?? "",
    entry.selectionKey,
  ]
    .join(" ")
    .toLowerCase();
}

export function buildAgentSkillMentionOptions(params: {
  agent: Pick<Agent, "id" | "urlKey"> | null | undefined;
  orgUrlKey: string | null | undefined;
  organizationSkills: OrganizationSkillListItem[] | null | undefined;
  skillSnapshot: AgentSkillSnapshot | null | undefined;
}) {
  const agent = params.agent;
  const skillSnapshot = params.skillSnapshot;
  if (!agent || !skillSnapshot || !Array.isArray(skillSnapshot.entries)) return [];

  const orgUrlKey = params.orgUrlKey ?? "organization";
  const organizationSkillByKey = new Map(
    (params.organizationSkills ?? []).map((skill) => [skill.key, skill]),
  );
  const options = new Map<string, SkillMentionOption>();

  for (const entry of skillSnapshot.entries) {
    if (!isActiveSkillEntry(entry)) continue;

    const organizationSkillKey = parseOrganizationSkillKey(entry.selectionKey);
    if (organizationSkillKey) {
      const organizationSkill = organizationSkillByKey.get(organizationSkillKey) ?? null;
      const publicRef = organizationSkill
        ? formatOrganizationSkillPublicRef(organizationSkill, {
            orgUrlKey,
            agentUrlKey: agent.urlKey,
            scope: "agent",
          })
        : organizationSkillKey;
      const markdownTarget = organizationSkill
        ? organizationSkillMarkdownTarget(organizationSkill)
        : normalizeMarkdownTarget(entry.sourcePath ?? entry.targetPath);
      if (!markdownTarget) continue;

      const mentionLabel = organizationSkill?.slug ?? buildSkillMentionLabel(entry, organizationSkillKey);
      options.set(entry.selectionKey, {
        id: `skill:${entry.selectionKey}`,
        name: mentionLabel,
        kind: "skill",
        searchText: organizationSkill
          ? buildOrganizationSkillSearchText(organizationSkill, {
              orgUrlKey,
              agentUrlKey: agent.urlKey,
              scope: "agent",
            })
          : fallbackOrganizationSkillSearchText(publicRef, entry),
        skillRefLabel: mentionLabel,
        skillMarkdownTarget: markdownTarget,
        skillDisplayName: organizationSkill?.name ?? entry.runtimeName ?? entry.key,
        skillDescription: normalizeOptionalText(organizationSkill?.description ?? entry.description ?? entry.detail),
        skillCategoryLabel: null,
        skillLocationLabel: null,
        skillDetailsHref: organizationSkill ? `/skills/${organizationSkill.id}` : null,
      });
      continue;
    }

    const publicRef = buildExternalSkillPublicRef(agent, entry);
    const markdownTarget = normalizeMarkdownTarget(entry.sourcePath ?? entry.targetPath);
    if (!markdownTarget) continue;
    const mentionLabel = buildSkillMentionLabel(entry, publicRef);

    options.set(entry.selectionKey, {
      id: `skill:${entry.selectionKey}`,
      name: mentionLabel,
      kind: "skill",
      searchText: buildExternalSkillSearchText(publicRef, entry),
      skillRefLabel: mentionLabel,
      skillMarkdownTarget: markdownTarget,
      skillDisplayName: normalizeOptionalText(entry.runtimeName) ?? entry.key ?? mentionLabel,
      skillDescription: normalizeOptionalText(entry.description ?? entry.detail),
      skillCategoryLabel: normalizeOptionalText(entry.originLabel) ?? "Agent skill",
      skillLocationLabel: normalizeOptionalText(entry.locationLabel),
      skillDetailsHref: null,
    });
  }

  return Array.from(options.values()).sort((left, right) => left.name.localeCompare(right.name));
}
