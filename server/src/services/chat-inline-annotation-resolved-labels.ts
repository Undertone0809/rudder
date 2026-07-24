import {
  agents,
  automations,
  chatConversations,
  documents,
  issues,
  libraryEntries,
  organizationSkills,
  projects,
} from "@rudderhq/db";
import {
  AGENT_ROLE_LABELS,
  createMarkdownSourceBoundaryMap,
  parseAgentMentionHref,
  parseAutomationMentionHref,
  parseChatMentionHref,
  parseIssueMentionHref,
  parseLibraryDirectoryMentionHref,
  parseLibraryDocMentionHref,
  parseLibraryEntryMentionHref,
  parseLibraryFileMentionHref,
  parseProjectMentionHref,
} from "@rudderhq/shared";
import { and, eq, or } from "drizzle-orm";
import { JSDOM } from "jsdom";
import { renderedMarkdownSelectionText } from "./chat-inline-annotation-rendering.js";
import type { ValidationQuery } from "./chat-inline-annotation-validation.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_RESOLVED_LABEL_LENGTH = 4_000;

type MarkdownLinkSpan = {
  start: number;
  end: number;
  href: string;
};

type ResolvedLinkReplacement = MarkdownLinkSpan & {
  label: string;
  marker: string;
  projectedStart: number;
  projectedEnd: number;
  renderedCharacterSpans: Array<{ start: number; end: number }>;
};

function findClosingMarkdownToken(source: string, token: string, fromIndex: number) {
  let escaped = false;
  for (let index = fromIndex; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (source.startsWith(token, index)) return index;
  }
  return null;
}

function findClosingMarkdownParen(source: string, fromIndex: number) {
  let escaped = false;
  let nested = 0;
  for (let index = fromIndex; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "(") {
      nested += 1;
      continue;
    }
    if (character !== ")") continue;
    if (nested === 0) return index;
    nested -= 1;
  }
  return null;
}

function markdownLinks(source: string) {
  const links: MarkdownLinkSpan[] = [];
  let fenceMarker: "`" | "~" | null = null;
  let fenceLength = 0;
  let inlineCodeLength = 0;
  let atLineStart = true;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "\n") {
      atLineStart = true;
      continue;
    }

    if (atLineStart) {
      const fence = source.slice(index).match(/^[ \t]{0,3}(`{3,}|~{3,})/u)?.[1];
      if (fence) {
        const marker = fence[0] as "`" | "~";
        if (!fenceMarker) {
          fenceMarker = marker;
          fenceLength = fence.length;
        } else if (marker === fenceMarker && fence.length >= fenceLength) {
          fenceMarker = null;
          fenceLength = 0;
        }
        index += fence.length - 1;
        atLineStart = false;
        continue;
      }
    }
    atLineStart = false;
    if (fenceMarker) continue;

    if (character === "`") {
      const codeFence = source.slice(index).match(/^`+/u)?.[0] ?? "`";
      if (inlineCodeLength === 0) {
        inlineCodeLength = codeFence.length;
      } else if (codeFence.length === inlineCodeLength) {
        inlineCodeLength = 0;
      }
      index += codeFence.length - 1;
      continue;
    }
    if (inlineCodeLength > 0 || character !== "[" || source[index - 1] === "!") continue;

    const closeBracket = findClosingMarkdownToken(source, "]", index + 1);
    if (closeBracket === null || source[closeBracket + 1] !== "(") continue;
    const closeParen = findClosingMarkdownParen(source, closeBracket + 2);
    if (closeParen === null) continue;
    const href = source.slice(closeBracket + 2, closeParen).trim();
    if (href) {
      links.push({
        start: index,
        end: closeParen + 1,
        href,
      });
    }
    index = closeParen;
  }
  return links;
}

function decodeHtmlEntityText(value: string) {
  if (!/[&][#a-z\d]+;/iu.test(value)) return value;
  const dom = new JSDOM("<textarea></textarea>");
  const textarea = dom.window.document.querySelector("textarea");
  if (!textarea) return value;
  textarea.innerHTML = value;
  return textarea.value;
}

function normalizeMentionLabel(value: string | null | undefined) {
  return decodeHtmlEntityText(value ?? "").replace(/\s+/gu, " ").trim();
}

function formatAgentLabel(agent: {
  name: string;
  role: string;
  title: string | null;
}) {
  const supportingLabel = agent.title?.trim()
    || AGENT_ROLE_LABELS[agent.role as keyof typeof AGENT_ROLE_LABELS]
    || agent.role;
  return normalizeMentionLabel(agent.name).toLocaleLowerCase()
      === normalizeMentionLabel(supportingLabel).toLocaleLowerCase()
    ? normalizeMentionLabel(agent.name)
    : normalizeMentionLabel(`${agent.name} (${supportingLabel})`);
}

function formatSkillLabel(value: string | null | undefined) {
  const normalized = value?.trim().replace(/^\$/u, "").trim() ?? "";
  return normalized.split("/").filter(Boolean).at(-1) ?? normalized;
}

function isUuid(value: string) {
  return UUID_PATTERN.test(value);
}

async function resolveSkillLabel(
  query: ValidationQuery,
  orgId: string,
  href: string,
) {
  if (!href.startsWith("skill://")) return null;
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return null;
  }

  const scope = parsed.hostname.toLowerCase();
  const pathParts = parsed.pathname
    .split("/")
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .filter(Boolean);
  if (scope === "org" && pathParts[0] && isUuid(pathParts[0])) {
    const skill = await query
      .select({
        slug: organizationSkills.slug,
      })
      .from(organizationSkills)
      .where(and(
        eq(organizationSkills.orgId, orgId),
        eq(organizationSkills.id, pathParts[0]),
      ))
      .limit(1)
      .for("share")
      .then((rows) => rows[0] ?? null);
    return formatSkillLabel(skill?.slug) || null;
  }

  const reference = parsed.searchParams.get("ref")?.trim() ?? "";
  const selectionKey = scope === "agent" ? pathParts[1]?.trim() ?? "" : "";
  const candidates = [selectionKey, reference]
    .flatMap((value) => {
      if (!value) return [];
      return value.startsWith("org:") || value.startsWith("bundled:")
        ? [value, value.slice(value.indexOf(":") + 1)]
        : [value];
    })
    .filter(Boolean);
  if (candidates.length > 0) {
    const skill = await query
      .select({
        slug: organizationSkills.slug,
      })
      .from(organizationSkills)
      .where(and(
        eq(organizationSkills.orgId, orgId),
        or(...candidates.flatMap((candidate) => [
          eq(organizationSkills.key, candidate),
          eq(organizationSkills.slug, candidate),
        ])),
      ))
      .limit(1)
      .for("share")
      .then((rows) => rows[0] ?? null);
    if (skill?.slug) return formatSkillLabel(skill.slug);
  }

  // Local and external skill references persist their runtime display identity
  // in the href's `ref`, so this fallback remains server-verifiable.
  return formatSkillLabel(reference) || null;
}

async function resolveCurrentLinkLabel(
  query: ValidationQuery,
  orgId: string,
  href: string,
) {
  const skillLabel = await resolveSkillLabel(query, orgId, href);
  if (skillLabel) return skillLabel;

  const agentMention = parseAgentMentionHref(href);
  if (agentMention && isUuid(agentMention.agentId)) {
    const agent = await query
      .select({
        name: agents.name,
        role: agents.role,
        title: agents.title,
        status: agents.status,
      })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.id, agentMention.agentId)))
      .limit(1)
      .for("share")
      .then((rows) => rows[0] ?? null);
    return agent && agent.status !== "terminated" ? formatAgentLabel(agent) : null;
  }

  const projectMention = parseProjectMentionHref(href);
  if (projectMention && isUuid(projectMention.projectId)) {
    return query
      .select({ label: projects.name })
      .from(projects)
      .where(and(eq(projects.orgId, orgId), eq(projects.id, projectMention.projectId)))
      .limit(1)
      .for("share")
      .then((rows) => normalizeMentionLabel(rows[0]?.label) || null);
  }

  const issueMention = parseIssueMentionHref(href);
  const appIssueRef = href.match(/(?:^|\/)issues\/([^/?#]+)/iu)?.[1] ?? null;
  let decodedAppIssueRef: string | null = null;
  if (appIssueRef) {
    try {
      decodedAppIssueRef = decodeURIComponent(appIssueRef);
    } catch {
      decodedAppIssueRef = null;
    }
  }
  const issueRef = issueMention?.issueId ?? decodedAppIssueRef;
  if (issueRef) {
    const issue = await query
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
      })
      .from(issues)
      .where(and(
        eq(issues.orgId, orgId),
        isUuid(issueRef)
          ? eq(issues.id, issueRef)
          : eq(issues.identifier, issueRef),
      ))
      .limit(1)
      .for("share")
      .then((rows) => rows[0] ?? null);
    if (issue) {
      return normalizeMentionLabel(
        issue.identifier ? `${issue.identifier} ${issue.title}` : issue.title,
      ) || null;
    }
  }

  const automationMention = parseAutomationMentionHref(href);
  if (automationMention && isUuid(automationMention.automationId)) {
    return query
      .select({ label: automations.title })
      .from(automations)
      .where(and(
        eq(automations.orgId, orgId),
        eq(automations.id, automationMention.automationId),
      ))
      .limit(1)
      .for("share")
      .then((rows) => normalizeMentionLabel(rows[0]?.label) || null);
  }

  const chatMention = parseChatMentionHref(href);
  if (chatMention && isUuid(chatMention.conversationId)) {
    return query
      .select({ label: chatConversations.title })
      .from(chatConversations)
      .where(and(
        eq(chatConversations.orgId, orgId),
        eq(chatConversations.id, chatMention.conversationId),
      ))
      .limit(1)
      .for("share")
      .then((rows) => normalizeMentionLabel(rows[0]?.label) || null);
  }

  const documentMention = parseLibraryDocMentionHref(href);
  if (documentMention && isUuid(documentMention.documentId)) {
    return query
      .select({ label: documents.title })
      .from(documents)
      .where(and(eq(documents.orgId, orgId), eq(documents.id, documentMention.documentId)))
      .limit(1)
      .for("share")
      .then((rows) => normalizeMentionLabel(rows[0]?.label) || null);
  }

  const entryMention = parseLibraryEntryMentionHref(href);
  if (entryMention && isUuid(entryMention.entryId)) {
    return query
      .select({ label: libraryEntries.title })
      .from(libraryEntries)
      .where(and(
        eq(libraryEntries.orgId, orgId),
        eq(libraryEntries.id, entryMention.entryId),
      ))
      .limit(1)
      .for("share")
      .then((rows) => normalizeMentionLabel(rows[0]?.label) || null);
  }

  const fileMention = parseLibraryFileMentionHref(href);
  const directoryMention = parseLibraryDirectoryMentionHref(href);
  const currentPath = fileMention?.filePath ?? directoryMention?.directoryPath ?? null;
  if (currentPath) {
    return query
      .select({ label: libraryEntries.title })
      .from(libraryEntries)
      .where(and(
        eq(libraryEntries.orgId, orgId),
        eq(libraryEntries.currentPath, currentPath),
      ))
      .limit(1)
      .for("share")
      .then((rows) => normalizeMentionLabel(rows[0]?.label) || null);
  }

  return null;
}

function decodedEntityAt(source: string, index: number) {
  if (source[index] !== "&") return null;
  const candidate = source.slice(index)
    .match(/^&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][a-zA-Z\d]+);/u)?.[0];
  if (!candidate) return null;
  const decoded = decodeHtmlEntityText(candidate);
  return decoded.length === 1 ? { decoded, length: candidate.length } : null;
}

function renderedTextToSourceSpans(
  renderedText: string,
  source: string,
  sourceBase: number,
) {
  const spans: Array<{ start: number; end: number }> = [];
  let sourceCursor = 0;
  for (let index = 0; index < renderedText.length; index += 1) {
    const character = renderedText[index]!;
    let sourceIndex = source.indexOf(character, sourceCursor);
    let sourceEnd = sourceIndex + 1;
    for (
      let entityIndex = source.indexOf("&", sourceCursor);
      entityIndex >= 0;
      entityIndex = source.indexOf("&", entityIndex + 1)
    ) {
      if (sourceIndex >= 0 && entityIndex > sourceIndex) break;
      const entity = decodedEntityAt(source, entityIndex);
      if (!entity || entity.decoded !== character) continue;
      sourceIndex = entityIndex;
      sourceEnd = entityIndex + entity.length;
      break;
    }
    if (sourceIndex < 0) {
      return proportionalRenderedTextSpans(renderedText, source, sourceBase);
    }
    spans.push({
      start: sourceBase + sourceIndex,
      end: sourceBase + sourceEnd,
    });
    sourceCursor = sourceEnd;
  }
  return spans;
}

function proportionalRenderedTextSpans(
  renderedText: string,
  source: string,
  sourceBase: number,
) {
  const mapping = createMarkdownSourceBoundaryMap(source, renderedText);
  return Array.from({ length: renderedText.length }, (_, index) => ({
    start: sourceBase + mapping.renderedBoundaryToRaw[index]!,
    end: sourceBase + mapping.renderedBoundaryToRaw[index + 1]!,
  }));
}

function uniqueProjectionMarker(source: string, used: ReadonlySet<string>) {
  for (let codePoint = 0xe000; codePoint <= 0xf8ff; codePoint += 1) {
    const marker = String.fromCodePoint(codePoint);
    if (!source.includes(marker) && !used.has(marker)) return marker;
  }
  return null;
}

function projectedBoundaryCandidates(
  rawBoundary: number,
  edge: "start" | "end",
  replacements: readonly ResolvedLinkReplacement[],
) {
  let shift = 0;
  for (const replacement of replacements) {
    if (rawBoundary < replacement.start) return [rawBoundary + shift];
    if (rawBoundary > replacement.end) {
      shift += (replacement.projectedEnd - replacement.projectedStart)
        - (replacement.end - replacement.start);
      continue;
    }
    if (rawBoundary === replacement.start) return [replacement.projectedStart];
    if (rawBoundary === replacement.end) return [replacement.projectedEnd];
    const candidates = replacement.renderedCharacterSpans.flatMap((span, index) => {
      if (edge === "start" && span.start === rawBoundary) {
        return [replacement.projectedStart + index];
      }
      if (edge === "end" && span.end === rawBoundary) {
        return [replacement.projectedStart + index + 1];
      }
      return [];
    });
    return [...new Set(candidates)];
  }
  return [rawBoundary + shift];
}

function restoreResolvedLabels(
  renderedSelection: string,
  projectedStart: number,
  projectedEnd: number,
  replacements: readonly ResolvedLinkReplacement[],
) {
  let restored = renderedSelection;
  for (const replacement of replacements) {
    const intersectionStart = Math.max(projectedStart, replacement.projectedStart);
    const intersectionEnd = Math.min(projectedEnd, replacement.projectedEnd);
    if (intersectionEnd <= intersectionStart) continue;
    let labelCursor = intersectionStart - replacement.projectedStart;
    restored = restored.replace(
      new RegExp(`${replacement.marker}+`, "gu"),
      (markers) => {
        const value = replacement.label.slice(labelCursor, labelCursor + markers.length);
        labelCursor += markers.length;
        return value;
      },
    );
  }
  return restored;
}

export async function renderedMarkdownSelectionTextWithResolvedLabels(
  query: ValidationQuery,
  input: {
    orgId: string;
    source: string;
    start: number;
    end: number;
  },
) {
  const overlappingLinks = markdownLinks(input.source)
    .filter((link) => link.start < input.end && link.end > input.start);
  if (overlappingLinks.length === 0) {
    return {
      overlapsResolvableDynamicLabel: false,
      selections: [],
    };
  }

  const replacements: ResolvedLinkReplacement[] = [];
  const usedMarkers = new Set<string>();
  let projectedCursor = 0;
  let rawCursor = 0;
  let projectedSource = "";
  for (const link of overlappingLinks) {
    const label = await resolveCurrentLinkLabel(query, input.orgId, link.href);
    if (!label) continue;
    if (label.length > MAX_RESOLVED_LABEL_LENGTH) {
      return {
        overlapsResolvableDynamicLabel: true,
        selections: [],
      };
    }
    const marker = uniqueProjectionMarker(input.source, usedMarkers);
    if (!marker) {
      return {
        overlapsResolvableDynamicLabel: true,
        selections: [],
      };
    }
    usedMarkers.add(marker);
    projectedSource += input.source.slice(rawCursor, link.start);
    projectedCursor += link.start - rawCursor;
    const projectedStart = projectedCursor;
    projectedSource += marker.repeat(label.length);
    projectedCursor += label.length;
    const projectedEnd = projectedCursor;
    replacements.push({
      ...link,
      label,
      marker,
      projectedStart,
      projectedEnd,
      renderedCharacterSpans: renderedTextToSourceSpans(
        label,
        input.source.slice(link.start, link.end),
        link.start,
      ),
    });
    rawCursor = link.end;
  }
  if (replacements.length === 0) {
    return {
      overlapsResolvableDynamicLabel: false,
      selections: [],
    };
  }
  projectedSource += input.source.slice(rawCursor);

  const startCandidates = projectedBoundaryCandidates(
    input.start,
    "start",
    replacements,
  );
  const endCandidates = projectedBoundaryCandidates(
    input.end,
    "end",
    replacements,
  );
  const candidates = new Set<string>();
  for (const projectedStart of startCandidates) {
    for (const projectedEnd of endCandidates) {
      if (projectedEnd <= projectedStart) continue;
      const rendered = renderedMarkdownSelectionText(
        projectedSource,
        projectedStart,
        projectedEnd,
      );
      if (rendered === null) continue;
      candidates.add(restoreResolvedLabels(
        rendered,
        projectedStart,
        projectedEnd,
        replacements,
      ));
    }
  }
  return {
    overlapsResolvableDynamicLabel: true,
    selections: [...candidates],
  };
}
