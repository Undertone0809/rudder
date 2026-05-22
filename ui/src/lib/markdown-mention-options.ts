import type { Agent, Issue, Project } from "@rudderhq/shared";
import type { MentionOption } from "../components/MarkdownEditor";
import { formatChatAgentLabel } from "./agent-labels";
import { formatAssigneeUserLabel } from "./assignees";

type MentionAgent = Pick<Agent, "id" | "name" | "role" | "title" | "icon" | "status">;
type MentionProject = Pick<Project, "id" | "name" | "description" | "color">;
type MentionIssue = Pick<
  Issue,
  "id" | "identifier" | "title" | "status" | "projectId" | "assigneeAgentId" | "assigneeUserId"
> & {
  project?: MentionProject | null;
};

function issueAssigneeLabel(
  issue: MentionIssue,
  agentById: Map<string, MentionAgent>,
  currentUserId?: string | null,
) {
  if (issue.assigneeAgentId) {
    return agentById.get(issue.assigneeAgentId)?.name ?? issue.assigneeAgentId.slice(0, 8);
  }
  if (issue.assigneeUserId) {
    return formatAssigneeUserLabel(issue.assigneeUserId, currentUserId) ?? issue.assigneeUserId.slice(0, 8);
  }
  return "Unassigned";
}

export function buildMarkdownMentionOptions(params: {
  agents?: MentionAgent[] | null;
  projects?: MentionProject[] | null;
  issues?: MentionIssue[] | null;
  skillMentionOptions?: MentionOption[] | null;
  excludeIssueId?: string | null;
  currentUserId?: string | null;
}) {
  const options: MentionOption[] = [];
  const activeAgents = [...(params.agents ?? [])]
    .filter((agent) => agent.status !== "terminated")
    .sort((a, b) => a.name.localeCompare(b.name));
  const agentById = new Map(activeAgents.map((agent) => [agent.id, agent]));
  const projectById = new Map((params.projects ?? []).map((project) => [project.id, project]));

  for (const agent of activeAgents) {
    options.push({
      id: `agent:${agent.id}`,
      name: formatChatAgentLabel(agent),
      kind: "agent",
      agentId: agent.id,
      agentIcon: agent.icon,
      agentRole: agent.role,
    });
  }

  for (const project of params.projects ?? []) {
    options.push({
      id: `project:${project.id}`,
      name: project.name,
      kind: "project",
      searchText: [project.name, project.description].filter(Boolean).join(" "),
      projectId: project.id,
      projectColor: project.color,
    });
  }

  for (const issue of params.issues ?? []) {
    if (issue.id === params.excludeIssueId) continue;
    const issueProject = issue.projectId
      ? projectById.get(issue.projectId) ?? issue.project ?? null
      : issue.project ?? null;
    const assigneeAgent = issue.assigneeAgentId ? agentById.get(issue.assigneeAgentId) ?? null : null;
    const assigneeName = issueAssigneeLabel(issue, agentById, params.currentUserId);
    options.push({
      id: `issue:${issue.id}`,
      name: issue.identifier ? `${issue.identifier} ${issue.title}` : issue.title,
      kind: "issue",
      searchText: [
        issue.identifier,
        issue.title,
        issue.status,
        issueProject?.name,
        assigneeName,
      ].filter(Boolean).join(" "),
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      issueStatus: issue.status,
      issueProjectName: issueProject?.name ?? null,
      issueProjectColor: issueProject?.color ?? null,
      issueAssigneeName: assigneeName,
      issueAssigneeIcon: assigneeAgent?.icon ?? null,
      issueAssigneeRole: assigneeAgent?.role ?? null,
    });
  }

  options.push(...(params.skillMentionOptions ?? []));
  return options;
}
