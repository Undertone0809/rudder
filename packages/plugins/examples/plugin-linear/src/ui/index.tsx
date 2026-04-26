import {
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
  type CSSProperties,
} from "react";
import {
  usePluginAction,
  usePluginData,
  usePluginToast,
  type PluginDetailTabProps,
  type PluginPageProps,
  type PluginSettingsPageProps,
} from "@rudderhq/plugin-sdk/ui";
import {
  ACTION_KEYS,
  DATA_KEYS,
  LINEAR_IMPORT_ALL_LIMIT,
  LINEAR_PAGE_SIZE,
  LINEAR_TOKEN_SETTINGS_URL,
  RUDDER_STATUS_OPTIONS,
} from "../constants.js";
import type {
  ImportLinearIssuesActionResult,
  IssueLinkData,
  LinearIssueRow,
  LinearCatalogData,
  LinearOrganizationMapping,
  LinearPluginConfig,
  LinearStateSummary,
  LinearStateMapping,
  LinearTeamMapping,
  LinearIssuesData,
  PageBootstrapData,
  SettingsCatalogData,
  SettingsBootstrapData,
} from "../types.js";

const layoutStyles: Record<string, CSSProperties> = {
  shell: {
    display: "grid",
    gap: 16,
    color: "var(--foreground, #111827)",
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
  },
  card: {
    border: "1px solid var(--border, rgba(15, 23, 42, 0.14))",
    borderRadius: 8,
    padding: 16,
    background: "var(--card, var(--background, #fff))",
  },
  title: {
    fontSize: 22,
    fontWeight: 700,
    margin: 0,
  },
  subtitle: {
    margin: "6px 0 0",
    color: "var(--muted-foreground, rgba(15, 23, 42, 0.68))",
    fontSize: 14,
    lineHeight: 1.5,
  },
  row: {
    display: "flex",
    gap: 12,
    flexWrap: "wrap",
    alignItems: "center",
  },
  connectionGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 12,
    alignItems: "end",
  },
  field: {
    display: "grid",
    gap: 6,
    minWidth: 180,
    flex: "1 1 180px",
  },
  label: {
    fontSize: 12,
    fontWeight: 700,
    color: "var(--muted-foreground, rgba(15, 23, 42, 0.66))",
    letterSpacing: 0,
  },
  input: {
    width: "100%",
    border: "1px solid var(--border, rgba(15, 23, 42, 0.18))",
    borderRadius: 6,
    padding: "10px 12px",
    fontSize: 14,
    background: "var(--background, #fff)",
    color: "var(--foreground, #111827)",
    boxSizing: "border-box",
  },
  select: {
    width: "100%",
    border: "1px solid var(--border, rgba(15, 23, 42, 0.18))",
    borderRadius: 6,
    padding: "10px 12px",
    fontSize: 14,
    background: "var(--background, #fff)",
    color: "var(--foreground, #111827)",
    boxSizing: "border-box",
  },
  button: {
    border: "1px solid var(--border, rgba(15, 23, 42, 0.18))",
    borderRadius: 6,
    padding: "10px 14px",
    fontSize: 14,
    fontWeight: 600,
    background: "var(--background, #fff)",
    color: "var(--foreground, #111827)",
    cursor: "pointer",
  },
  primaryButton: {
    border: "1px solid var(--primary, #0f172a)",
    borderRadius: 6,
    padding: "10px 14px",
    fontSize: 14,
    fontWeight: 700,
    background: "var(--primary, #0f172a)",
    color: "var(--primary-foreground, #fff)",
    cursor: "pointer",
  },
  subtleButton: {
    border: "1px solid var(--border, rgba(15, 23, 42, 0.12))",
    borderRadius: 6,
    padding: "8px 12px",
    fontSize: 13,
    fontWeight: 600,
    background: "var(--secondary, rgba(15, 23, 42, 0.04))",
    color: "var(--secondary-foreground, var(--foreground, #111827))",
    cursor: "pointer",
  },
  warning: {
    border: "1px solid rgba(217, 119, 6, 0.24)",
    background: "rgba(251, 191, 36, 0.12)",
    borderRadius: 8,
    padding: 14,
    fontSize: 14,
    lineHeight: 1.5,
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 14,
  },
  th: {
    textAlign: "left",
    fontSize: 12,
    letterSpacing: 0,
    color: "var(--muted-foreground, rgba(15, 23, 42, 0.62))",
    padding: "10px 12px",
    borderBottom: "1px solid var(--border, rgba(15, 23, 42, 0.1))",
  },
  td: {
    padding: "12px",
    borderBottom: "1px solid var(--border, rgba(15, 23, 42, 0.08))",
    verticalAlign: "top",
  },
  pill: {
    display: "inline-flex",
    alignItems: "center",
    borderRadius: 999,
    padding: "4px 10px",
    background: "var(--secondary, rgba(15, 23, 42, 0.06))",
    color: "var(--secondary-foreground, var(--foreground, #111827))",
    fontSize: 12,
    fontWeight: 600,
  },
  monoLink: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 12,
  },
  helpText: {
    fontSize: 13,
    lineHeight: 1.5,
    color: "var(--muted-foreground, rgba(15, 23, 42, 0.68))",
  },
  statusLine: {
    marginTop: 14,
    paddingTop: 14,
    borderTop: "1px solid var(--border, rgba(15, 23, 42, 0.1))",
    fontSize: 13,
    lineHeight: 1.5,
    color: "var(--muted-foreground, rgba(15, 23, 42, 0.68))",
  },
  sectionHeader: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "flex-start",
    flexWrap: "wrap",
  },
  teamGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 10,
    marginTop: 14,
  },
  teamChoice: {
    display: "flex",
    gap: 10,
    alignItems: "flex-start",
    border: "1px solid var(--border, rgba(15, 23, 42, 0.14))",
    borderRadius: 8,
    padding: 12,
    cursor: "pointer",
    background: "var(--background, transparent)",
  },
  checkbox: {
    marginTop: 3,
  },
  statusRuleGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: 10,
    alignItems: "center",
  },
};

function normalizeConfig(config: LinearPluginConfig | null | undefined): LinearPluginConfig {
  return {
    apiTokenSecretRef: config?.apiTokenSecretRef ?? "",
    organizationMappings: Array.isArray(config?.organizationMappings) ? config.organizationMappings : [],
    ...(config?.fixtureMode === true ? { fixtureMode: true } : {}),
  };
}

function getOrgPrefix(context: Record<string, unknown>): string | null {
  const orgPrefix = typeof context["orgPrefix"] === "string" ? context["orgPrefix"] : null;
  const companyPrefix = typeof context["companyPrefix"] === "string" ? context["companyPrefix"] : null;
  return orgPrefix ?? companyPrefix;
}

function getPluginIdFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  const match = window.location.pathname.match(/\/instance\/settings\/plugins\/([^/?#]+)/);
  return match?.[1] ?? null;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  if (!response.ok) {
    const payload = await response.json().catch(async () => ({ error: await response.text() }));
    const message = typeof payload?.error === "string"
      ? payload.error
      : typeof payload?.message === "string"
        ? payload.message
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return await response.json() as T;
}

function formatRudderStatus(status: LinearStateMapping["rudderStatus"]): string {
  return status.replaceAll("_", " ");
}

function inferRudderStatus(state: LinearStateSummary): LinearStateMapping["rudderStatus"] {
  const type = (state.type ?? "").toLowerCase();
  const name = state.name.toLowerCase();
  if (type.includes("completed") || name.includes("done") || name.includes("complete")) return "done";
  if (type.includes("cancel") || name.includes("cancel")) return "cancelled";
  if (name.includes("review")) return "in_review";
  if (type.includes("backlog") || type.includes("triage") || name.includes("backlog") || name.includes("triage")) return "backlog";
  if (type.includes("started") || type.includes("unstarted") || name.includes("progress") || name.includes("todo")) return "todo";
  return "backlog";
}

function buildMappingFromCatalog(orgId: string, catalog: SettingsCatalogData): LinearOrganizationMapping {
  return {
    orgId,
    teamMappings: catalog.teams.map((team) => buildTeamMappingFromCatalog(team)),
  };
}

function buildTeamMappingFromCatalog(
  team: SettingsCatalogData["teams"][number],
  existing?: LinearTeamMapping | null,
): LinearTeamMapping {
  const existingStatusByStateId = new Map(
    (existing?.stateMappings ?? []).map((state) => [state.linearStateId, state.rudderStatus]),
  );
  return {
    teamId: team.id,
    teamName: team.name,
    stateMappings: team.states.map((state) => ({
      linearStateId: state.id,
      linearStateName: state.name,
      rudderStatus: existingStatusByStateId.get(state.id) ?? inferRudderStatus(state),
    })),
  };
}

function buildMappingForSelectedTeams(
  orgId: string,
  catalog: SettingsCatalogData,
  selectedTeamIds: string[],
  existingMapping: LinearOrganizationMapping | null | undefined,
): LinearOrganizationMapping {
  const selected = new Set(selectedTeamIds);
  const existingByTeamId = new Map((existingMapping?.teamMappings ?? []).map((team) => [team.teamId, team]));
  return {
    orgId,
    teamMappings: catalog.teams
      .filter((team) => selected.has(team.id))
      .map((team) => buildTeamMappingFromCatalog(team, existingByTeamId.get(team.id))),
  };
}

function countMappedStates(mapping: LinearOrganizationMapping | null | undefined): number {
  return mapping?.teamMappings.reduce((sum, team) => sum + team.stateMappings.length, 0) ?? 0;
}

function summarizeMapping(mapping: LinearOrganizationMapping | null | undefined): string {
  if (!mapping) return "No Linear workspace loaded yet.";
  const teamCount = mapping.teamMappings.length;
  const stateCount = countMappedStates(mapping);
  return `${teamCount} team${teamCount === 1 ? "" : "s"} and ${stateCount} workflow state${stateCount === 1 ? "" : "s"} ready.`;
}

function isMissingSettingsCatalogHandler(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /No data handler registered/i.test(message) && /settings-catalog/i.test(message);
}

function prepareConfigForSubmit(config: LinearPluginConfig): LinearPluginConfig {
  return {
    apiTokenSecretRef: config.apiTokenSecretRef?.trim() ?? "",
    ...(config.fixtureMode === true ? { fixtureMode: true } : {}),
    organizationMappings: config.organizationMappings
      .map((mapping) => ({
        orgId: mapping.orgId.trim(),
        teamMappings: mapping.teamMappings
          .map((team) => ({
            teamId: team.teamId.trim(),
            teamName: team.teamName?.trim() || undefined,
            stateMappings: team.stateMappings
              .map((state) => ({
                linearStateId: state.linearStateId.trim(),
                linearStateName: state.linearStateName?.trim() || undefined,
                rudderStatus: state.rudderStatus,
              }))
              .filter((state) => state.linearStateId),
          }))
          .filter((team) => team.teamId),
      }))
      .filter((mapping) => mapping.orgId),
  };
}

function summarizeImportResult(result: ImportLinearIssuesActionResult): string {
  const parts = [`Imported ${result.importedCount}`];
  if (result.duplicateCount > 0) parts.push(`${result.duplicateCount} duplicate`);
  if (result.fallbackCount > 0) parts.push(`${result.fallbackCount} fallback`);
  if (result.adjustedCount > 0) parts.push(`${result.adjustedCount} adjusted`);
  return parts.join(" / ");
}

function formatRelativeTime(timestamp: string | null | undefined): string {
  if (!timestamp) return "Unknown";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleString();
}

function issueHref(orgPrefix: string | null, issueId: string): string {
  return orgPrefix ? `/${orgPrefix}/issues/${issueId}` : `/issues/${issueId}`;
}

function pageHref(orgPrefix: string | null, query?: string): string {
  if (!orgPrefix) return "/linear";
  const url = new URL(`/${orgPrefix}/linear`, "https://local.invalid");
  if (query) url.searchParams.set("q", query);
  return `${url.pathname}${url.search}`;
}

type FilterState = {
  teamId: string;
  stateId: string;
  projectId: string;
  assigneeId: string;
  query: string;
};

function useLinearFilters(initialQuery: string): [FilterState, Dispatch<SetStateAction<FilterState>>] {
  const [filters, setFilters] = useState<FilterState>({
    teamId: "",
    stateId: "",
    projectId: "",
    assigneeId: "",
    query: initialQuery,
  });
  return [filters, setFilters];
}

export function LinearPluginPage({ context }: PluginPageProps) {
  const toast = usePluginToast();
  const importIssues = usePluginAction(ACTION_KEYS.importIssues) as (
    params?: Record<string, unknown>,
  ) => Promise<ImportLinearIssuesActionResult>;
  const orgId = context.orgId ?? "__missing__";
  const orgPrefix = getOrgPrefix(context as unknown as Record<string, unknown>);
  const initialQuery = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("q") ?? ""
    : "";

  const bootstrap = usePluginData<PageBootstrapData>(DATA_KEYS.pageBootstrap, { orgId });
  const catalog = usePluginData<LinearCatalogData>(DATA_KEYS.catalog, { orgId });
  const [filters, setFilters] = useLinearFilters(initialQuery);
  const [targetProjectId, setTargetProjectId] = useState("");
  const [afterCursor, setAfterCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [selectedIssueIds, setSelectedIssueIds] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);

  const issues = usePluginData<LinearIssuesData>(DATA_KEYS.issues, {
    orgId,
    limit: LINEAR_PAGE_SIZE,
    after: afterCursor ?? undefined,
    teamId: filters.teamId || undefined,
    stateId: filters.stateId || undefined,
    projectId: filters.projectId || undefined,
    assigneeId: filters.assigneeId || undefined,
    query: filters.query || undefined,
  });

  const stateOptions = useMemo(() => {
    if (!catalog.data?.teams?.length) return [];
    const sourceTeams = filters.teamId
      ? catalog.data.teams.filter((team: LinearCatalogData["teams"][number]) => team.id === filters.teamId)
      : catalog.data.teams;
    const deduped = new Map<string, { id: string; name: string }>();
    for (const team of sourceTeams) {
      for (const state of team.states) {
        deduped.set(state.id, { id: state.id, name: state.name });
      }
    }
    return [...deduped.values()];
  }, [catalog.data?.teams, filters.teamId]);

  useEffect(() => {
    setAfterCursor(null);
    setCursorHistory([]);
    setSelectedIssueIds([]);
  }, [filters.teamId, filters.stateId, filters.projectId, filters.assigneeId, filters.query]);

  useEffect(() => {
    const visibleIds = new Set(issues.data?.rows.map((row: LinearIssueRow) => row.id) ?? []);
    setSelectedIssueIds((current) => {
      const next = current.filter((id) => visibleIds.has(id));
      if (next.length === current.length && next.every((id, index) => id === current[index])) {
        return current;
      }
      return next;
    });
  }, [issues.data?.rows]);

  async function handleImport(mode: "single" | "selected" | "allMatching", issueIds?: string[]) {
    if (!targetProjectId) {
      toast({
        title: "Choose a target project",
        body: "Imports are disabled until a Rudder project is selected.",
        tone: "warn",
      });
      return;
    }
    setImporting(true);
    try {
      const result = await importIssues({
        orgId,
        targetProjectId,
        mode,
        issueIds,
        filters: {
          teamId: filters.teamId || undefined,
          stateId: filters.stateId || undefined,
          projectId: filters.projectId || undefined,
          assigneeId: filters.assigneeId || undefined,
          query: filters.query || undefined,
        },
      });
      toast({
        title: "Linear import complete",
        body: summarizeImportResult(result),
        tone: "success",
      });
      issues.refresh();
      setSelectedIssueIds([]);
    } catch (error) {
      toast({
        title: "Linear import failed",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      setImporting(false);
    }
  }

  return (
    <div style={layoutStyles.shell}>
      <section style={layoutStyles.card}>
        <h1 style={layoutStyles.title}>Linear intake</h1>
        <p style={layoutStyles.subtitle}>
          Import Linear issues into a chosen Rudder project. This page is the bulk workspace; the issue tab is the linked detail view.
        </p>
      </section>

      {bootstrap.loading ? (
        <section style={layoutStyles.card}>Loading Linear import context…</section>
      ) : !bootstrap.data?.configured ? (
        <section style={{ ...layoutStyles.card, ...layoutStyles.warning }}>
          <strong>Linear is not configured yet.</strong>
          <div style={{ marginTop: 8 }}>{bootstrap.data?.message ?? "Connect Linear and choose teams in plugin settings."}</div>
          <div style={{ marginTop: 12 }}>
            <a href="/instance/settings/plugins" style={layoutStyles.monoLink}>Open plugin settings</a>
          </div>
        </section>
      ) : (
        <>
          <section style={layoutStyles.card}>
            <div style={layoutStyles.row}>
              <div style={layoutStyles.field}>
                <label style={layoutStyles.label} htmlFor="target-project">Target Rudder project</label>
                <select
                  id="target-project"
                  data-testid="linear-target-project"
                  style={layoutStyles.select}
                  value={targetProjectId}
                  onChange={(event) => setTargetProjectId(event.target.value)}
                >
                  <option value="">Choose a project</option>
                  {(bootstrap.data?.projects ?? []).map((project: PageBootstrapData["projects"][number]) => (
                    <option key={project.id} value={project.id}>{project.name}</option>
                  ))}
                </select>
              </div>
              <div style={layoutStyles.field}>
                <label style={layoutStyles.label} htmlFor="linear-team-filter">Linear team</label>
                <select
                  id="linear-team-filter"
                  style={layoutStyles.select}
                  value={filters.teamId}
                  onChange={(event) => setFilters((current) => ({ ...current, teamId: event.target.value, stateId: "" }))}
                >
                  <option value="">All allowed teams</option>
                  {(catalog.data?.teams ?? []).map((team: LinearCatalogData["teams"][number]) => (
                    <option key={team.id} value={team.id}>{team.name}</option>
                  ))}
                </select>
              </div>
              <div style={layoutStyles.field}>
                <label style={layoutStyles.label} htmlFor="linear-state-filter">Workflow state</label>
                <select
                  id="linear-state-filter"
                  style={layoutStyles.select}
                  value={filters.stateId}
                  onChange={(event) => setFilters((current) => ({ ...current, stateId: event.target.value }))}
                >
                  <option value="">All states</option>
                  {stateOptions.map((state) => (
                    <option key={state.id} value={state.id}>{state.name}</option>
                  ))}
                </select>
              </div>
              <div style={layoutStyles.field}>
                <label style={layoutStyles.label} htmlFor="linear-project-filter">Linear project</label>
                <select
                  id="linear-project-filter"
                  style={layoutStyles.select}
                  value={filters.projectId}
                  onChange={(event) => setFilters((current) => ({ ...current, projectId: event.target.value }))}
                >
                  <option value="">All projects</option>
                  {(catalog.data?.projects ?? []).map((project: LinearCatalogData["projects"][number]) => (
                    <option key={project.id} value={project.id}>{project.name}</option>
                  ))}
                </select>
              </div>
              <div style={layoutStyles.field}>
                <label style={layoutStyles.label} htmlFor="linear-assignee-filter">Assignee</label>
                <select
                  id="linear-assignee-filter"
                  style={layoutStyles.select}
                  value={filters.assigneeId}
                  onChange={(event) => setFilters((current) => ({ ...current, assigneeId: event.target.value }))}
                >
                  <option value="">Anyone</option>
                  {(catalog.data?.users ?? []).map((user: LinearCatalogData["users"][number]) => (
                    <option key={user.id} value={user.id}>{user.name}</option>
                  ))}
                </select>
              </div>
              <div style={layoutStyles.field}>
                <label style={layoutStyles.label} htmlFor="linear-query-filter">Search</label>
                <input
                  id="linear-query-filter"
                  style={layoutStyles.input}
                  value={filters.query}
                  onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
                  placeholder="Identifier, title, or description"
                />
              </div>
            </div>
          </section>

          <section style={layoutStyles.card}>
            <div style={{ ...layoutStyles.row, justifyContent: "space-between" }}>
              <div style={layoutStyles.row}>
                <button
                  type="button"
                  style={layoutStyles.button}
                  onClick={() => {
                    const rows = issues.data?.rows ?? [];
                    const selectableIds = rows
                      .filter((row: LinearIssueRow) => !row.imported)
                      .map((row: LinearIssueRow) => row.id);
                    setSelectedIssueIds(selectableIds);
                  }}
                  disabled={issues.loading}
                >
                  Select current page
                </button>
                <button
                  type="button"
                  style={layoutStyles.button}
                  onClick={() => setSelectedIssueIds([])}
                  disabled={selectedIssueIds.length === 0}
                >
                  Clear selection
                </button>
              </div>
              <div style={layoutStyles.row}>
                <button
                  type="button"
                  style={layoutStyles.button}
                  disabled={!targetProjectId || selectedIssueIds.length === 0 || importing}
                  onClick={() => void handleImport("selected", selectedIssueIds)}
                >
                  Import selected
                </button>
                <button
                  type="button"
                  style={layoutStyles.primaryButton}
                  data-testid="linear-import-all"
                  disabled={!targetProjectId || importing}
                  onClick={() => void handleImport("allMatching")}
                  title={`Imports up to ${LINEAR_IMPORT_ALL_LIMIT} matching issues.`}
                >
                  Import all matching
                </button>
              </div>
            </div>
            {!targetProjectId && (
              <div style={{ marginTop: 12, ...layoutStyles.warning }}>
                Choose a target Rudder project to enable per-row, selected, or all-matching import actions.
              </div>
            )}
          </section>

          <section style={layoutStyles.card}>
            {issues.loading ? (
              <div>Loading Linear issues…</div>
            ) : issues.error ? (
              <div style={layoutStyles.warning}>{issues.error.message}</div>
            ) : (
              <>
                <table style={layoutStyles.table}>
                  <thead>
                    <tr>
                      <th style={layoutStyles.th}></th>
                      <th style={layoutStyles.th}>Issue</th>
                      <th style={layoutStyles.th}>State</th>
                      <th style={layoutStyles.th}>Project</th>
                      <th style={layoutStyles.th}>Assignee</th>
                      <th style={layoutStyles.th}>Status</th>
                      <th style={layoutStyles.th}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(issues.data?.rows ?? []).map((row: LinearIssueRow) => {
                      const checked = selectedIssueIds.includes(row.id);
                      const sameOrgLink = row.imported && (!row.importedOrgId || row.importedOrgId === context.orgId);
                      return (
                        <tr key={row.id}>
                          <td style={layoutStyles.td}>
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={row.imported}
                              onChange={(event) => {
                                setSelectedIssueIds((current) => {
                                  if (event.target.checked) return [...current, row.id];
                                  return current.filter((id) => id !== row.id);
                                });
                              }}
                            />
                          </td>
                          <td style={layoutStyles.td}>
                            <div style={{ display: "grid", gap: 6 }}>
                              <a href={row.url} target="_blank" rel="noreferrer">
                                <strong>{row.identifier}</strong> {row.title}
                              </a>
                              <span style={layoutStyles.pill}>{row.team.name}</span>
                            </div>
                          </td>
                          <td style={layoutStyles.td}>{row.state.name}</td>
                          <td style={layoutStyles.td}>{row.project?.name ?? "None"}</td>
                          <td style={layoutStyles.td}>{row.assignee?.name ?? "Unassigned"}</td>
                          <td style={layoutStyles.td}>
                            {row.imported ? (
                              <span data-testid={`linear-imported-${row.id}`} style={layoutStyles.pill}>
                                Imported
                              </span>
                            ) : (
                              <span style={layoutStyles.pill}>Ready</span>
                            )}
                          </td>
                          <td style={layoutStyles.td}>
                            {row.imported ? (
                              sameOrgLink && row.importedRudderIssueId ? (
                                <a href={issueHref(orgPrefix, row.importedRudderIssueId)}>Open Rudder issue</a>
                              ) : (
                                <span>Imported elsewhere</span>
                              )
                            ) : (
                              <button
                                type="button"
                                style={layoutStyles.subtleButton}
                                disabled={!targetProjectId || importing}
                                onClick={() => void handleImport("single", [row.id])}
                              >
                                Import
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                {(issues.data?.rows.length ?? 0) === 0 && (
                  <div style={{ marginTop: 16, color: "rgba(15, 23, 42, 0.68)" }}>
                    No Linear issues matched the current filters.
                  </div>
                )}

                <div style={{ ...layoutStyles.row, justifyContent: "space-between", marginTop: 16 }}>
                  <span style={{ fontSize: 13, color: "rgba(15, 23, 42, 0.68)" }}>
                    Showing {issues.data?.totalShown ?? 0} issue(s).
                  </span>
                  <div style={layoutStyles.row}>
                    <button
                      type="button"
                      style={layoutStyles.button}
                      disabled={cursorHistory.length === 0 || importing}
                      onClick={() => {
                        setCursorHistory((current) => {
                          const nextHistory = [...current];
                          const previousCursor = nextHistory.pop() ?? null;
                          setAfterCursor(previousCursor);
                          return nextHistory;
                        });
                      }}
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      style={layoutStyles.button}
                      disabled={!issues.data?.hasNextPage || importing}
                      onClick={() => {
                        if (!issues.data?.endCursor) return;
                        setCursorHistory((current) => [...current, afterCursor ?? ""]);
                        setAfterCursor(issues.data.endCursor);
                      }}
                    >
                      Next
                    </button>
                  </div>
                </div>
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}

export function LinearIssueTab({ context }: PluginDetailTabProps) {
  const orgId = context.orgId ?? "__missing__";
  const orgPrefix = getOrgPrefix(context as unknown as Record<string, unknown>);
  const data = usePluginData<IssueLinkData>(DATA_KEYS.issueLink, {
    orgId,
    issueId: context.entityId,
  });

  if (data.loading) {
    return <div style={layoutStyles.card}>Loading Linear issue details…</div>;
  }

  if (data.error) {
    return <div style={{ ...layoutStyles.card, ...layoutStyles.warning }}>{data.error.message}</div>;
  }

  if (!data.data || !data.data.linked) {
    return (
      <div style={layoutStyles.card}>
        <h2 style={{ marginTop: 0 }}>No linked Linear issue</h2>
        <p style={layoutStyles.subtitle}>
          This Rudder issue has not been imported from Linear yet.
        </p>
        <a href={pageHref(orgPrefix, data.data?.searchQuery ?? "")}>Open Linear intake with this issue title as the search query</a>
      </div>
    );
  }

  const latest = data.data.latestIssue;
  const link = data.data.link;

  return (
    <div style={layoutStyles.shell}>
      <section style={layoutStyles.card}>
        <h2 style={{ marginTop: 0 }}>Linked Linear issue</h2>
        <p style={layoutStyles.subtitle}>
          {link.linearIdentifier} maps to this Rudder issue.
        </p>
        <div style={{ ...layoutStyles.row, marginTop: 12 }}>
          <a href={link.linearUrl} target="_blank" rel="noreferrer">Open in Linear</a>
          <span style={layoutStyles.pill}>{latest?.team.name ?? link.teamName}</span>
          <span style={layoutStyles.pill}>{latest?.state.name ?? link.stateName}</span>
          {latest?.project?.name ? <span style={layoutStyles.pill}>{latest.project.name}</span> : null}
        </div>
      </section>

      {data.data.staleReason ? (
        <section style={{ ...layoutStyles.card, ...layoutStyles.warning }}>
          {data.data.staleReason}
        </section>
      ) : null}

      <section style={layoutStyles.card}>
        <h3 style={{ marginTop: 0 }}>
          {(latest?.identifier ?? link.linearIdentifier)} {latest?.title ?? link.linearTitle}
        </h3>
        <div style={{ ...layoutStyles.row, marginBottom: 12 }}>
          <span style={layoutStyles.pill}>Updated {formatRelativeTime(latest?.updatedAt ?? link.updatedAt)}</span>
          <span style={layoutStyles.pill}>Imported {formatRelativeTime(link.importedAt)}</span>
          <span style={layoutStyles.pill}>{latest?.assignee?.name ?? "Unassigned"}</span>
        </div>
        <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
          {latest?.description?.trim() || "This Linear issue has no description."}
        </div>
      </section>
    </div>
  );
}

export function LinearPluginSettingsPage(_props: PluginSettingsPageProps) {
  const toast = usePluginToast();
  const bootstrap = usePluginData<SettingsBootstrapData>(DATA_KEYS.settingsBootstrap);
  const [draft, setDraft] = useState<LinearPluginConfig>(normalizeConfig(null));
  const [selectedOrgId, setSelectedOrgId] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [settingsCatalog, setSettingsCatalog] = useState<SettingsCatalogData | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const pluginId = getPluginIdFromLocation();

  useEffect(() => {
    if (!bootstrap.data) return;
    const nextDraft = normalizeConfig(bootstrap.data.config);
    const firstOrganizationId = bootstrap.data.organizations[0]?.id ?? "";
    setDraft(nextDraft);
    setSelectedOrgId((current) =>
      current || nextDraft.organizationMappings[0]?.orgId || firstOrganizationId,
    );
  }, [bootstrap.data]);

  useEffect(() => {
    if (!pluginId || !selectedOrgId || !draft.apiTokenSecretRef) {
      setSettingsCatalog(null);
      setCatalogError(null);
      setCatalogLoading(false);
      return;
    }

    let cancelled = false;
    setCatalogLoading(true);
    setCatalogError(null);

    void fetchSettingsCatalog(selectedOrgId)
      .then((catalog) => {
        if (cancelled) return;
        setSettingsCatalog(catalog);
        setDraft((current) => {
          const normalized = normalizeConfig(current);
          const existingMapping = normalized.organizationMappings.find((mapping) => mapping.orgId === selectedOrgId) ?? null;
          const selectedTeamIds = (existingMapping?.teamMappings ?? [])
            .map((team) => team.teamId)
            .filter(Boolean);
          const nextMapping = selectedTeamIds.length > 0
            ? buildMappingForSelectedTeams(selectedOrgId, catalog, selectedTeamIds, existingMapping)
            : buildMappingFromCatalog(selectedOrgId, catalog);
          return {
            ...normalized,
            organizationMappings: [
              ...normalized.organizationMappings.filter((mapping) => mapping.orgId !== selectedOrgId),
              nextMapping,
            ],
          };
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setSettingsCatalog(null);
        setCatalogError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [draft.apiTokenSecretRef, pluginId, selectedOrgId]);

  const selectedMapping = draft.organizationMappings.find((mapping) => mapping.orgId === selectedOrgId) ?? null;
  const selectedTeamIds = (selectedMapping?.teamMappings ?? [])
    .map((team) => team.teamId)
    .filter(Boolean);
  const selectedTeamIdSet = new Set(selectedTeamIds);
  const selectedTeamCount = selectedTeamIds.length;
  const catalogTeamCount = settingsCatalog?.teams.length ?? 0;

  async function savePluginConfig(config: LinearPluginConfig) {
    if (!pluginId) throw new Error("Unable to resolve plugin id");
    return await apiFetch(`/api/plugins/${encodeURIComponent(pluginId)}/config`, {
      method: "POST",
      body: JSON.stringify({ configJson: prepareConfigForSubmit(config) }),
    });
  }

  async function fetchPluginData<T>(key: string, orgId: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!pluginId) throw new Error("Unable to resolve plugin id");
    const payload = await apiFetch<{ data: T }>(`/api/plugins/${encodeURIComponent(pluginId)}/data/${key}`, {
      method: "POST",
      body: JSON.stringify({
        orgId,
        params: {
          orgId,
          ...params,
        },
      }),
    });
    return payload.data;
  }

  async function fetchSettingsCatalogWithRetry(orgId: string): Promise<SettingsCatalogData> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await fetchPluginData<SettingsCatalogData>(DATA_KEYS.settingsCatalog, orgId);
      } catch (error) {
        if (isMissingSettingsCatalogHandler(error)) throw error;
        lastError = error;
        await new Promise((resolve) => window.setTimeout(resolve, 350 + attempt * 250));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async function refreshPluginRuntime() {
    if (!pluginId) throw new Error("Unable to resolve plugin id");
    await apiFetch(`/api/plugins/${encodeURIComponent(pluginId)}/disable`, {
      method: "POST",
      body: JSON.stringify({ reason: "Refresh Linear plugin after settings update" }),
    });
    await apiFetch(`/api/plugins/${encodeURIComponent(pluginId)}/enable`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  async function fetchSettingsCatalog(orgId: string): Promise<SettingsCatalogData> {
    try {
      return await fetchSettingsCatalogWithRetry(orgId);
    } catch (error) {
      if (!isMissingSettingsCatalogHandler(error)) throw error;
      await refreshPluginRuntime();
      return await fetchSettingsCatalogWithRetry(orgId);
    }
  }

  function setMappingForSelectedOrg(nextMapping: LinearOrganizationMapping) {
    setDraft((current) => {
      const normalized = normalizeConfig(current);
      return {
        ...normalized,
        organizationMappings: [
          ...normalized.organizationMappings.filter((mapping) => mapping.orgId !== nextMapping.orgId),
          nextMapping,
        ],
      };
    });
  }

  function toggleTeam(teamId: string) {
    if (!settingsCatalog || !selectedOrgId) return;
    setDraft((current) => {
      const normalized = normalizeConfig(current);
      const existingMapping = normalized.organizationMappings.find((mapping) => mapping.orgId === selectedOrgId) ?? null;
      const nextTeamIds = new Set((existingMapping?.teamMappings ?? []).map((team) => team.teamId).filter(Boolean));
      if (nextTeamIds.has(teamId)) {
        nextTeamIds.delete(teamId);
      } else {
        nextTeamIds.add(teamId);
      }
      const nextMapping = buildMappingForSelectedTeams(selectedOrgId, settingsCatalog, [...nextTeamIds], existingMapping);
      return {
        ...normalized,
        organizationMappings: [
          ...normalized.organizationMappings.filter((mapping) => mapping.orgId !== selectedOrgId),
          nextMapping,
        ],
      };
    });
  }

  function selectAllTeams() {
    if (!settingsCatalog || !selectedOrgId) return;
    setMappingForSelectedOrg(buildMappingForSelectedTeams(
      selectedOrgId,
      settingsCatalog,
      settingsCatalog.teams.map((team) => team.id),
      selectedMapping,
    ));
  }

  function setStatusRule(teamId: string, stateId: string, rudderStatus: LinearStateMapping["rudderStatus"]) {
    setDraft((current) => ({
      ...current,
      organizationMappings: current.organizationMappings.map((mapping) => {
        if (mapping.orgId !== selectedOrgId) return mapping;
        return {
          ...mapping,
          teamMappings: mapping.teamMappings.map((team) => {
            if (team.teamId !== teamId) return team;
            return {
              ...team,
              stateMappings: team.stateMappings.map((state) =>
                state.linearStateId === stateId ? { ...state, rudderStatus } : state,
              ),
            };
          }),
        };
      }),
    }));
  }

  async function connectLinear() {
    const orgId = selectedOrgId || bootstrap.data?.organizations[0]?.id || "";
    if (!orgId) {
      toast({ title: "Choose a Rudder organization", tone: "warn" });
      return;
    }
    if (!pluginId) {
      toast({ title: "Unable to resolve plugin id", tone: "error" });
      return;
    }

    setConnecting(true);
    try {
      let apiTokenSecretRef = draft.apiTokenSecretRef?.trim() ?? "";
      const trimmedToken = tokenInput.trim();
      if (trimmedToken) {
        const secret = await apiFetch<{ id: string }>(`/api/orgs/${encodeURIComponent(orgId)}/secrets`, {
          method: "POST",
          body: JSON.stringify({
            name: "Linear token",
            value: trimmedToken,
            description: "Used by the Linear plugin to read issues for import.",
          }),
        });
        apiTokenSecretRef = secret.id;
      }
      if (!apiTokenSecretRef) {
        toast({
          title: "Paste a Linear token",
          body: "Create one in Linear, paste it here, then connect.",
          tone: "warn",
        });
        return;
      }

      const seedConfig = {
        ...draft,
        apiTokenSecretRef,
        organizationMappings: draft.organizationMappings,
      };
      await savePluginConfig(seedConfig);

      const catalog = await fetchSettingsCatalog(orgId);
      if (catalog.teams.length === 0) {
        throw new Error("Linear returned no teams for this token.");
      }
      const generatedMapping = buildMappingFromCatalog(orgId, catalog);
      const nextConfig = prepareConfigForSubmit({
        ...seedConfig,
        organizationMappings: [
          ...draft.organizationMappings.filter((mapping) => mapping.orgId !== orgId),
          generatedMapping,
        ],
      });
      await savePluginConfig(nextConfig);
      setSettingsCatalog(catalog);
      setCatalogError(null);
      setDraft(nextConfig);
      setTokenInput("");
      bootstrap.refresh();
      toast({
        title: "Linear is ready",
        body: summarizeMapping(generatedMapping),
        tone: "success",
      });
    } catch (error) {
      toast({
        title: "Linear connection failed",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      setConnecting(false);
    }
  }

  async function saveConfig() {
    if (!pluginId) {
      toast({ title: "Unable to resolve plugin id", tone: "error" });
      return;
    }
    if (draft.apiTokenSecretRef && settingsCatalog && selectedOrgId && selectedTeamCount === 0) {
      toast({
        title: "Choose at least one Linear team",
        body: "The import page needs one or more teams to show Linear issues.",
        tone: "warn",
      });
      return;
    }
    setSaving(true);
    try {
      await savePluginConfig(draft);
      bootstrap.refresh();
      toast({
        title: "Linear settings saved",
        tone: "success",
      });
    } catch (error) {
      toast({
        title: "Failed to save Linear settings",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  function connectionStatusText(): string {
    if (bootstrap.loading) return "Loading plugin settings…";
    if (catalogLoading) return "Reading teams and workflow states from Linear…";
    if (catalogError) return `Linear could not be loaded: ${catalogError}`;
    if (settingsCatalog) {
      return `Connected. ${catalogTeamCount} Linear team${catalogTeamCount === 1 ? "" : "s"} found; ${selectedTeamCount} selected for import.`;
    }
    if (draft.apiTokenSecretRef) return "Token saved. Refresh from Linear to load teams.";
    return "Paste a Linear token to connect this Rudder organization.";
  }

  return (
    <div style={layoutStyles.shell}>
      <section key="linear-settings-intro" style={layoutStyles.card}>
        <h2 style={{ marginTop: 0 }}>Linear</h2>
        <p style={layoutStyles.subtitle}>
          Paste a Linear token once. Rudder will read your teams and workflow states, then prepare the import settings automatically.
        </p>
        {bootstrap.data?.fixtureMode ? (
          <div style={{ marginTop: 12, ...layoutStyles.warning }}>
            Fixture mode is enabled in this environment. Linear reads use deterministic test data.
          </div>
        ) : null}
      </section>

      <section key="linear-settings-connect" style={layoutStyles.card}>
        <div style={layoutStyles.sectionHeader}>
          <div>
            <h3 style={{ margin: 0 }}>Connect Linear</h3>
            <p style={layoutStyles.subtitle}>
              Pick a Rudder organization, paste a token, and Rudder will prepare the import setup from Linear.
            </p>
          </div>
        </div>
        <div style={{ ...layoutStyles.connectionGrid, marginTop: 14 }}>
          <div style={layoutStyles.field}>
            <label style={layoutStyles.label} htmlFor="linear-rudder-org">Rudder organization</label>
            <select
              id="linear-rudder-org"
              data-testid="linear-rudder-org"
              style={layoutStyles.select}
              value={selectedOrgId}
              onChange={(event) => setSelectedOrgId(event.target.value)}
            >
              <option value="">Choose an organization</option>
              {(bootstrap.data?.organizations ?? []).map((organization: SettingsBootstrapData["organizations"][number], index) => (
                <option key={`${organization.id}-${index}`} value={organization.id}>
                  {organization.name} ({organization.issuePrefix})
                </option>
              ))}
            </select>
          </div>
          <div style={layoutStyles.field}>
            <label style={layoutStyles.label} htmlFor="linear-token">Linear token</label>
            <input
              id="linear-token"
              data-testid="linear-token-input"
              style={layoutStyles.input}
              type="password"
              autoComplete="off"
              value={tokenInput}
              onChange={(event) => setTokenInput(event.target.value)}
              placeholder={draft.apiTokenSecretRef ? "Token saved. Paste a new token to replace it." : "Paste a Linear token"}
            />
            <div style={layoutStyles.helpText}>
              <a href={LINEAR_TOKEN_SETTINGS_URL} target="_blank" rel="noreferrer">
                Create a Linear token
              </a>
              {" "}and paste it here.
            </div>
          </div>
          <div style={{ display: "grid", gap: 6, justifySelf: "start" }}>
            <span aria-hidden="true" style={{ ...layoutStyles.label, visibility: "hidden" }}>Action</span>
            <button
              type="button"
              style={layoutStyles.primaryButton}
              data-testid="linear-connect"
              onClick={() => void connectLinear()}
              disabled={connecting}
            >
              {connecting ? "Connecting…" : draft.apiTokenSecretRef ? "Refresh from Linear" : "Connect Linear"}
            </button>
          </div>
        </div>
        <div style={layoutStyles.statusLine}>{connectionStatusText()}</div>
      </section>

      {draft.apiTokenSecretRef ? (
        <section key="linear-settings-teams" style={layoutStyles.card}>
          <div style={layoutStyles.sectionHeader}>
            <div>
              <h3 style={{ margin: 0 }}>Teams to import</h3>
              <p style={layoutStyles.subtitle}>
                Choose the Linear teams that should appear on the import page. Rudder stores the technical details for you.
              </p>
            </div>
            <button
              type="button"
              style={layoutStyles.subtleButton}
              onClick={selectAllTeams}
              disabled={!settingsCatalog || catalogLoading || catalogTeamCount === selectedTeamCount}
            >
              Select all teams
            </button>
          </div>

          {catalogLoading ? (
            <p style={layoutStyles.helpText}>Loading teams from Linear…</p>
          ) : catalogError ? (
            <div style={{ marginTop: 14, ...layoutStyles.warning }}>
              <strong>Linear could not be loaded.</strong>
              <div style={{ marginTop: 6 }}>{catalogError}</div>
            </div>
          ) : settingsCatalog ? (
            <>
              <div style={layoutStyles.teamGrid}>
                {settingsCatalog.teams.map((team, index) => {
                  const checked = selectedTeamIdSet.has(team.id);
                  return (
                    <label
                      key={`${team.id}-${index}`}
                      style={{
                        ...layoutStyles.teamChoice,
                        borderColor: checked ? "var(--primary, #2563eb)" : "var(--border, rgba(15, 23, 42, 0.14))",
                        background: checked ? "rgba(37, 99, 235, 0.08)" : "var(--background, transparent)",
                      }}
                    >
                      <input
                        data-testid={`linear-team-choice-${team.id}`}
                        style={layoutStyles.checkbox}
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleTeam(team.id)}
                      />
                      <span>
                        <strong>{team.name}</strong>
                        <span style={{ display: "block", marginTop: 3, ...layoutStyles.helpText }}>
                          {team.key} · {team.states.length} workflow state{team.states.length === 1 ? "" : "s"}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
              <div style={{ ...layoutStyles.row, justifyContent: "space-between", marginTop: 14 }}>
                <span style={layoutStyles.helpText}>
                  {selectedTeamCount === 0
                    ? "Choose at least one team before saving."
                    : `${selectedTeamCount} team${selectedTeamCount === 1 ? "" : "s"} selected for import.`}
                </span>
                <button
                  type="button"
                  style={layoutStyles.primaryButton}
                  data-testid="linear-save-team-choices"
                  onClick={() => void saveConfig()}
                  disabled={saving || selectedTeamCount === 0}
                >
                  {saving ? "Saving…" : "Save choices"}
                </button>
              </div>
            </>
          ) : (
            <p style={layoutStyles.helpText}>Refresh from Linear to load teams for this token.</p>
          )}
        </section>
      ) : null}

      {settingsCatalog && selectedMapping && selectedMapping.teamMappings.length > 0 ? (
        <section key="linear-settings-status-rules" style={layoutStyles.card}>
          <details>
            <summary style={{ cursor: "pointer", fontWeight: 700 }}>Status rules (optional)</summary>
            <p style={layoutStyles.subtitle}>
              Rudder applies smart defaults from Linear. Change these only if imported issues land in the wrong Rudder status.
            </p>
            <div style={{ display: "grid", gap: 18, marginTop: 14 }}>
              {selectedMapping.teamMappings.map((teamMapping, teamIndex) => {
                const catalogTeam = settingsCatalog.teams.find((team) => team.id === teamMapping.teamId);
                const states = catalogTeam?.states ?? teamMapping.stateMappings.map((state) => ({
                  id: state.linearStateId,
                  name: state.linearStateName ?? "Linear status",
                  type: null,
                }));
                const statusByStateId = new Map(teamMapping.stateMappings.map((state) => [state.linearStateId, state.rudderStatus]));
                return (
                  <div key={`${teamMapping.teamId}-${teamIndex}`} style={{ borderTop: "1px solid var(--border, rgba(15, 23, 42, 0.1))", paddingTop: 14 }}>
                    <h4 style={{ margin: "0 0 10px" }}>{teamMapping.teamName ?? catalogTeam?.name ?? "Linear team"}</h4>
                    <div style={{ display: "grid", gap: 8 }}>
                      {states.map((state, stateIndex) => (
                        <div key={`${teamMapping.teamId}-${state.id}-${stateIndex}`} style={layoutStyles.statusRuleGrid}>
                          <div>
                            <strong>{state.name}</strong>
                            <div style={layoutStyles.helpText}>{state.type ? `${state.type} in Linear` : "Linear workflow state"}</div>
                          </div>
                          <select
                            style={layoutStyles.select}
                            value={statusByStateId.get(state.id) ?? inferRudderStatus(state)}
                            onChange={(event) =>
                              setStatusRule(teamMapping.teamId, state.id, event.target.value as LinearStateMapping["rudderStatus"])}
                          >
                            {RUDDER_STATUS_OPTIONS.map((status) => (
                              <option key={`${teamMapping.teamId}-${state.id}-${status}`} value={status}>{formatRudderStatus(status)}</option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ marginTop: 14 }}>
              <button type="button" style={layoutStyles.primaryButton} onClick={() => void saveConfig()} disabled={saving}>
                {saving ? "Saving…" : "Save status rules"}
              </button>
            </div>
          </details>
        </section>
      ) : null}
    </div>
  );
}
