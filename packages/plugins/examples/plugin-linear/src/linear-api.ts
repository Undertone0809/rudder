import { DEFAULT_LINEAR_API_URL } from "./constants.js";
import type {
  LinearCatalog,
  LinearIssueConnection,
  LinearIssueListFilters,
  LinearIssueSummary,
  LinearProjectSummary,
  LinearTeamSummary,
  LinearUserSummary,
} from "./types.js";

const FIXTURE_TEAMS: LinearTeamSummary[] = [
  {
    id: "team-eng",
    key: "ENG",
    name: "Engineering",
    states: [
      { id: "state-backlog", name: "Backlog", type: "backlog" },
      { id: "state-progress", name: "In Progress", type: "started" },
      { id: "state-triage", name: "Triage", type: "unstarted" },
      { id: "state-done", name: "Done", type: "completed" },
    ],
  },
];

const FIXTURE_PROJECTS: LinearProjectSummary[] = [
  { id: "proj-roadmap", name: "Roadmap" },
  { id: "proj-growth", name: "Growth" },
];

const FIXTURE_USERS: LinearUserSummary[] = [
  { id: "user-amy", name: "Amy Zhang", email: "amy@example.com" },
  { id: "user-ben", name: "Ben Ford", email: "ben@example.com" },
];

const FIXTURE_ISSUES: LinearIssueSummary[] = [
  {
    id: "lin-1",
    identifier: "ENG-101",
    title: "Backlog intake issue",
    description: "Imported from the Linear fixture backlog.",
    url: "https://linear.app/example/issue/ENG-101",
    updatedAt: "2026-04-20T09:00:00.000Z",
    createdAt: "2026-04-10T09:00:00.000Z",
    team: FIXTURE_TEAMS[0],
    state: FIXTURE_TEAMS[0].states[0]!,
    project: FIXTURE_PROJECTS[0]!,
    assignee: FIXTURE_USERS[0]!,
  },
  {
    id: "lin-2",
    identifier: "ENG-102",
    title: "Status mapped issue",
    description: "This item should map into an in-progress Rudder issue.",
    url: "https://linear.app/example/issue/ENG-102",
    updatedAt: "2026-04-21T08:30:00.000Z",
    createdAt: "2026-04-11T09:00:00.000Z",
    team: FIXTURE_TEAMS[0],
    state: FIXTURE_TEAMS[0].states[1]!,
    project: FIXTURE_PROJECTS[0]!,
    assignee: FIXTURE_USERS[1]!,
  },
  {
    id: "lin-3",
    identifier: "ENG-103",
    title: "Unmapped state fallback issue",
    description: "This item intentionally uses an unmapped state in some tests.",
    url: "https://linear.app/example/issue/ENG-103",
    updatedAt: "2026-04-22T07:15:00.000Z",
    createdAt: "2026-04-12T09:00:00.000Z",
    team: FIXTURE_TEAMS[0],
    state: { id: "state-triage", name: "Triage", type: "unstarted" },
    project: FIXTURE_PROJECTS[1]!,
    assignee: null,
  },
];

function readEnv(name: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  return process.env[name];
}

function getLinearApiUrl(): string {
  return readEnv("RUDDER_LINEAR_API_URL")?.trim() || DEFAULT_LINEAR_API_URL;
}

export function isFixtureMode(): boolean {
  return readEnv("RUDDER_LINEAR_FIXTURE_MODE") === "1";
}

export function buildLinearIssuesFilter(filters: LinearIssueListFilters): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = [];
  clauses.push({ team: { id: { in: filters.allowedTeamIds } } });
  if (filters.teamId) {
    clauses.push({ team: { id: { eq: filters.teamId } } });
  }
  if (filters.stateId) clauses.push({ state: { id: { eq: filters.stateId } } });
  if (filters.projectId) clauses.push({ project: { id: { eq: filters.projectId } } });
  if (filters.assigneeId) clauses.push({ assignee: { id: { eq: filters.assigneeId } } });
  if (filters.query?.trim()) {
    const query = filters.query.trim();
    clauses.push({
      or: [
        { title: { containsIgnoreCase: query } },
        { description: { containsIgnoreCase: query } },
        { identifier: { eqIgnoreCase: query } },
      ],
    });
  }
  if (clauses.length === 1) return clauses[0]!;
  return { and: clauses };
}

type GraphQLResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

type GraphQLFetcher = (query: string, variables?: Record<string, unknown>) => Promise<unknown>;

export type LinearApiClient = {
  getViewer(): Promise<{ id: string; name: string; email?: string | null }>;
  getCatalog(allowedTeamIds?: string[]): Promise<LinearCatalog>;
  listIssues(filters: LinearIssueListFilters, limit: number, after?: string): Promise<LinearIssueConnection>;
  getIssue(issueId: string): Promise<LinearIssueSummary | null>;
};

function normalizeIssue(issue: Record<string, any>): LinearIssueSummary {
  return {
    id: String(issue.id),
    identifier: String(issue.identifier),
    title: String(issue.title),
    description: typeof issue.description === "string" ? issue.description : null,
    url: String(issue.url),
    updatedAt: String(issue.updatedAt),
    createdAt: issue.createdAt ? String(issue.createdAt) : null,
    team: {
      id: String(issue.team.id),
      key: String(issue.team.key ?? issue.team.name ?? issue.team.id),
      name: String(issue.team.name),
      states: Array.isArray(issue.team.states?.nodes)
        ? issue.team.states.nodes.map((state: Record<string, any>) => ({
          id: String(state.id),
          name: String(state.name),
          type: typeof state.type === "string" ? state.type : null,
        }))
        : [],
    },
    state: {
      id: String(issue.state.id),
      name: String(issue.state.name),
      type: typeof issue.state.type === "string" ? issue.state.type : null,
    },
    project: issue.project
      ? {
        id: String(issue.project.id),
        name: String(issue.project.name),
      }
      : null,
    assignee: issue.assignee
      ? {
        id: String(issue.assignee.id),
        name: String(issue.assignee.name),
        email: typeof issue.assignee.email === "string" ? issue.assignee.email : null,
      }
      : null,
  };
}

async function postGraphQL<T>(
  fetcher: GraphQLFetcher,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await fetcher(query, variables) as GraphQLResponse<T>;
  if (response.errors?.length) {
    throw new Error(response.errors.map((error) => error.message || "Unknown Linear error").join("; "));
  }
  if (!response.data) throw new Error("Linear API returned no data");
  return response.data;
}

function applyFixtureFilters(filters: LinearIssueListFilters): LinearIssueSummary[] {
  const allowedTeamIds = new Set(filters.allowedTeamIds);
  const query = filters.query?.trim().toLowerCase() ?? "";
  return FIXTURE_ISSUES
    .filter((issue) => allowedTeamIds.has(issue.team.id))
    .filter((issue) => !filters.teamId || issue.team.id === filters.teamId)
    .filter((issue) => !filters.stateId || issue.state.id === filters.stateId)
    .filter((issue) => !filters.projectId || issue.project?.id === filters.projectId)
    .filter((issue) => !filters.assigneeId || issue.assignee?.id === filters.assigneeId)
    .filter((issue) => {
      if (!query) return true;
      const haystack = [
        issue.identifier,
        issue.title,
        issue.description ?? "",
        issue.project?.name ?? "",
        issue.assignee?.name ?? "",
      ].join(" ").toLowerCase();
      return haystack.includes(query);
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function createFixtureClient(): LinearApiClient {
  return {
    async getViewer() {
      return { id: "viewer-fixture", name: "Fixture Viewer", email: "fixture@example.com" };
    },
    async getCatalog(allowedTeamIds) {
      const allowed = allowedTeamIds?.length ? new Set(allowedTeamIds) : null;
      return {
        teams: allowed ? FIXTURE_TEAMS.filter((team) => allowed.has(team.id)) : FIXTURE_TEAMS,
        projects: FIXTURE_PROJECTS,
        users: FIXTURE_USERS,
      };
    },
    async listIssues(filters, limit, after) {
      const filtered = applyFixtureFilters(filters);
      const start = after ? filtered.findIndex((issue) => issue.id === after) + 1 : 0;
      const slice = filtered.slice(Math.max(start, 0), Math.max(start, 0) + limit);
      const last = slice[slice.length - 1] ?? null;
      const endIndex = last ? filtered.findIndex((issue) => issue.id === last.id) : -1;
      return {
        nodes: slice,
        endCursor: last?.id ?? null,
        hasNextPage: endIndex !== -1 && endIndex < filtered.length - 1,
      };
    },
    async getIssue(issueId) {
      return FIXTURE_ISSUES.find((issue) => issue.id === issueId) ?? null;
    },
  };
}

export function createLinearApiClient(
  token: string,
  fetchImpl?: typeof fetch,
  options?: { fixtureMode?: boolean },
): LinearApiClient {
  if (options?.fixtureMode || isFixtureMode()) {
    return createFixtureClient();
  }

  const effectiveFetch = fetchImpl ?? fetch;
  const apiUrl = getLinearApiUrl();
  const fetcher: GraphQLFetcher = async (query, variables) => {
    const response = await effectiveFetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Linear API request failed (${response.status}): ${text}`);
    }
    return await response.json();
  };

  return {
    async getViewer() {
      const data = await postGraphQL<{ viewer: { id: string; name: string; email?: string | null } }>(
        fetcher,
        `query LinearViewer {
          viewer {
            id
            name
            email
          }
        }`,
      );
      return data.viewer;
    },
    async getCatalog(allowedTeamIds) {
      const hasTeamFilter = Boolean(allowedTeamIds?.length);
      const data = await postGraphQL<{
        teams: { nodes: Array<Record<string, any>> };
        projects: { nodes: Array<Record<string, any>> };
        users: { nodes: Array<Record<string, any>> };
      }>(
        fetcher,
        `query LinearCatalog${hasTeamFilter ? "($teamIds: [String!])" : ""} {
          teams${hasTeamFilter ? "(filter: { id: { in: $teamIds } }, first: 50)" : "(first: 50)"} {
            nodes {
              id
              key
              name
              states(first: 100) {
                nodes {
                  id
                  name
                  type
                }
              }
            }
          }
          projects(first: 100) {
            nodes {
              id
              name
            }
          }
          users(first: 100) {
            nodes {
              id
              name
              email
              active
            }
          }
        }`,
        hasTeamFilter ? { teamIds: allowedTeamIds } : undefined,
      );

      return {
        teams: data.teams.nodes.map((team) => ({
          id: String(team.id),
          key: String(team.key ?? team.name ?? team.id),
          name: String(team.name),
          states: Array.isArray(team.states?.nodes)
            ? team.states.nodes.map((state: Record<string, any>) => ({
              id: String(state.id),
              name: String(state.name),
              type: typeof state.type === "string" ? state.type : null,
            }))
            : [],
        })),
        projects: data.projects.nodes.map((project) => ({
          id: String(project.id),
          name: String(project.name),
        })),
        users: data.users.nodes
          .filter((user) => user.active !== false)
          .map((user) => ({
            id: String(user.id),
            name: String(user.name),
            email: typeof user.email === "string" ? user.email : null,
          })),
      };
    },
    async listIssues(filters, limit, after) {
      const data = await postGraphQL<{
        issues: {
          nodes: Array<Record<string, any>>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      }>(
        fetcher,
        `query LinearIssues($first: Int!, $after: String, $filter: IssueFilter) {
          issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) {
            nodes {
              id
              identifier
              title
              description
              url
              updatedAt
              createdAt
              team {
                id
                key
                name
                states(first: 100) {
                  nodes {
                    id
                    name
                    type
                  }
                }
              }
              state {
                id
                name
                type
              }
              project {
                id
                name
              }
              assignee {
                id
                name
                email
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }`,
        {
          first: limit,
          after: after ?? null,
          filter: buildLinearIssuesFilter(filters),
        },
      );

      return {
        nodes: data.issues.nodes.map(normalizeIssue),
        endCursor: data.issues.pageInfo.endCursor,
        hasNextPage: data.issues.pageInfo.hasNextPage,
      };
    },
    async getIssue(issueId) {
      const data = await postGraphQL<{ issue: Record<string, any> | null }>(
        fetcher,
        `query LinearIssue($id: String!) {
          issue(id: $id) {
            id
            identifier
            title
            description
            url
            updatedAt
            createdAt
            team {
              id
              key
              name
              states(first: 100) {
                nodes {
                  id
                  name
                  type
                }
              }
            }
            state {
              id
              name
              type
            }
            project {
              id
              name
            }
            assignee {
              id
              name
              email
            }
          }
        }`,
        { id: issueId },
      );

      return data.issue ? normalizeIssue(data.issue) : null;
    },
  };
}
