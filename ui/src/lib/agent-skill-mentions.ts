import {
  buildOrganizationSkillSearchText,
  formatOrganizationSkillPublicRef,
  type Agent,
  type AgentSkillEntry,
  type AgentSkillSnapshot,
  type OrganizationSkillListItem,
} from "@rudderhq/shared";
import { organizationSkillMarkdownTarget } from "./organization-skill-picker";

export interface SkillMentionOption {
  id: string;
  name: string;
  kind: "skill";
  searchText: string;
  skillRefLabel: string;
  skillMarkdownTarget: string;
  skillDisplayName: string;
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

function buildExternalSkillDisplayName(entry: AgentSkillEntry) {
  const origin = entry.originLabel?.trim() || "Agent skill";
  const location = entry.locationLabel?.trim();
  return location ? `${origin} · ${location}` : origin;
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
  if (!agent || !skillSnapshot) return [];

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

      options.set(entry.selectionKey, {
        id: `skill:${entry.selectionKey}`,
        name: publicRef,
        kind: "skill",
        searchText: organizationSkill
          ? buildOrganizationSkillSearchText(organizationSkill, {
              orgUrlKey,
              agentUrlKey: agent.urlKey,
              scope: "agent",
            })
          : fallbackOrganizationSkillSearchText(publicRef, entry),
        skillRefLabel: publicRef,
        skillMarkdownTarget: markdownTarget,
        skillDisplayName: organizationSkill?.name ?? entry.runtimeName ?? entry.key,
      });
      continue;
    }

    const publicRef = buildExternalSkillPublicRef(agent, entry);
    const markdownTarget = normalizeMarkdownTarget(entry.sourcePath ?? entry.targetPath);
    if (!markdownTarget) continue;

    options.set(entry.selectionKey, {
      id: `skill:${entry.selectionKey}`,
      name: publicRef,
      kind: "skill",
      searchText: buildExternalSkillSearchText(publicRef, entry),
      skillRefLabel: publicRef,
      skillMarkdownTarget: markdownTarget,
      skillDisplayName: buildExternalSkillDisplayName(entry),
    });
  }

  return Array.from(options.values()).sort((left, right) => left.name.localeCompare(right.name));
}
