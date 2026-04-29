import {
  buildIssueMentionHref,
  buildProjectMentionHref,
} from "@rudderhq/shared";

type IssuePrefillSource = {
  id: string;
  identifier: string | null;
  title: string;
};

type ProjectPrefillSource = {
  id: string;
  name: string;
  color: string | null;
};

function mentionLabel(value: string) {
  return value.replace(/[\[\]\n\r]+/g, " ").replace(/\s+/g, " ").trim();
}

function messengerChatPrefillHref(prefill: string) {
  return {
    pathname: "/messenger/chat",
    search: `?prefill=${encodeURIComponent(prefill)}`,
  };
}

export function buildIssueChatPrefill(issue: IssuePrefillSource): string {
  const label = mentionLabel(issue.identifier ?? issue.title) || issue.id.slice(0, 8);
  return `[@${label}](${buildIssueMentionHref(issue.id, issue.identifier)}) `;
}

export function buildProjectChatPrefill(project: ProjectPrefillSource): string {
  const label = mentionLabel(project.name) || project.id.slice(0, 8);
  return `[@${label}](${buildProjectMentionHref(project.id, project.color)}) `;
}

export function buildIssueChatPrefillHref(issue: IssuePrefillSource) {
  return messengerChatPrefillHref(buildIssueChatPrefill(issue));
}

export function buildProjectChatPrefillHref(project: ProjectPrefillSource) {
  return messengerChatPrefillHref(buildProjectChatPrefill(project));
}
