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
} from "@rudder/plugin-sdk/ui";
import { ACTION_KEYS, DATA_KEYS, LINEAR_IMPORT_ALL_LIMIT, LINEAR_PAGE_SIZE, RUDDER_STATUS_OPTIONS } from "../constants.js";
import type {
  ImportLinearIssuesActionResult,
  IssueLinkData,
  LinearIssueRow,
  LinearOrganizationMapping,
  LinearPluginConfig,
  LinearStateMapping,
  LinearTeamMapping,
  LinearIssuesData,
  PageBootstrapData,
  SettingsBootstrapData,
  LinearCatalogData,
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
    textTransform: "uppercase",
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
    textTransform: "uppercase",
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
};

function normalizeConfig(config: LinearPluginConfig | null | undefined): LinearPluginConfig {
  return {
    apiTokenSecretRef: config?.apiTokenSecretRef ?? "",
    organizationMappings: Array.isArray(config?.organizationMappings) ? config.organizationMappings : [],
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

function emptyOrgMapping(): LinearOrganizationMapping {
  return {
    orgId: "",
    teamMappings: [emptyTeamMapping()],
  };
}

function emptyTeamMapping(): LinearTeamMapping {
  return {
    teamId: "",
    teamName: "",
    stateMappings: [],
  };
}

function emptyStateMapping(): LinearStateMapping {
  return {
    linearStateId: "",
    linearStateName: "",
    rudderStatus: "backlog",
  };
}

function prepareConfigForSubmit(config: LinearPluginConfig): LinearPluginConfig {
  return {
    apiTokenSecretRef: config.apiTokenSecretRef?.trim() ?? "",
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
        <h1 style={layoutStyles.title}>Linear Intake</h1>
        <p style={layoutStyles.subtitle}>
          Import Linear issues into a chosen Rudder project. This page is the bulk workspace; the issue tab is the linked detail view.
        </p>
      </section>

      {bootstrap.loading ? (
        <section style={layoutStyles.card}>Loading Linear import context…</section>
      ) : !bootstrap.data?.configured ? (
        <section style={{ ...layoutStyles.card, ...layoutStyles.warning }}>
          <strong>Linear is not configured yet.</strong>
          <div style={{ marginTop: 8 }}>{bootstrap.data?.message ?? "Add a token and organization mapping in plugin settings."}</div>
          <div style={{ marginTop: 12 }}>
            <a href="/instance/settings/plugins" style={layoutStyles.monoLink}>Open plugin settings</a>
          </div>
        </section>
      ) : (
        <>
          <section style={layoutStyles.card}>
            <div style={layoutStyles.row}>
              <div style={layoutStyles.field}>
                <label style={layoutStyles.label} htmlFor="target-project">Target Rudder Project</label>
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
                <label style={layoutStyles.label} htmlFor="linear-team-filter">Linear Team</label>
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
                <label style={layoutStyles.label} htmlFor="linear-state-filter">Workflow State</label>
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
                <label style={layoutStyles.label} htmlFor="linear-project-filter">Linear Project</label>
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
        <h2 style={{ marginTop: 0 }}>Linked Linear Issue</h2>
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
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!bootstrap.data) return;
    setDraft(normalizeConfig(bootstrap.data.config));
  }, [bootstrap.data]);

  const pluginId = getPluginIdFromLocation();

  async function testConfig() {
    if (!pluginId) {
      toast({ title: "Unable to resolve plugin id", tone: "error" });
      return;
    }
    setTesting(true);
    try {
      const result = await apiFetch<{ valid: boolean; message?: string }>(`/api/plugins/${encodeURIComponent(pluginId)}/config/test`, {
        method: "POST",
        body: JSON.stringify({ configJson: prepareConfigForSubmit(draft) }),
      });
      toast({
        title: result.valid ? "Linear configuration looks valid" : "Linear configuration needs changes",
        body: result.message,
        tone: result.valid ? "success" : "warn",
      });
    } catch (error) {
      toast({
        title: "Config test failed",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      setTesting(false);
    }
  }

  async function saveConfig() {
    if (!pluginId) {
      toast({ title: "Unable to resolve plugin id", tone: "error" });
      return;
    }
    setSaving(true);
    try {
      await apiFetch(`/api/plugins/${encodeURIComponent(pluginId)}/config`, {
        method: "POST",
        body: JSON.stringify({ configJson: prepareConfigForSubmit(draft) }),
      });
      bootstrap.refresh();
      toast({
        title: "Linear configuration saved",
        tone: "success",
      });
    } catch (error) {
      toast({
        title: "Failed to save Linear configuration",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={layoutStyles.shell}>
      <section style={layoutStyles.card}>
        <h2 style={{ marginTop: 0 }}>Linear plugin settings</h2>
        <p style={layoutStyles.subtitle}>
          Configure the Linear API token, per-organization team allow-list, and state mappings used during import.
        </p>
        {bootstrap.data?.fixtureMode ? (
          <div style={{ marginTop: 12, ...layoutStyles.warning }}>
            Fixture mode is enabled in this environment. Linear API reads are served from deterministic test data.
          </div>
        ) : null}
      </section>

      <section style={layoutStyles.card}>
        <div style={layoutStyles.field}>
          <label style={layoutStyles.label} htmlFor="linear-token-ref">Linear API Token Secret Ref</label>
          <input
            id="linear-token-ref"
            data-testid="linear-token-ref"
            style={layoutStyles.input}
            value={draft.apiTokenSecretRef ?? ""}
            onChange={(event) => setDraft((current) => ({ ...current, apiTokenSecretRef: event.target.value }))}
            placeholder="secret id or external ref"
          />
        </div>
      </section>

      {(draft.organizationMappings ?? []).map((mapping, orgIndex) => (
        <section key={`org-${orgIndex}`} style={layoutStyles.card}>
          <div style={{ ...layoutStyles.row, justifyContent: "space-between" }}>
            <h3 style={{ margin: 0 }}>Organization mapping #{orgIndex + 1}</h3>
            <button
              type="button"
              style={layoutStyles.subtleButton}
              onClick={() => {
                setDraft((current) => ({
                  ...current,
                  organizationMappings: current.organizationMappings.filter((_, index) => index !== orgIndex),
                }));
              }}
            >
              Remove organization mapping
            </button>
          </div>

          <div style={{ ...layoutStyles.field, marginTop: 12 }}>
            <label style={layoutStyles.label}>Rudder Organization</label>
            <select
              style={layoutStyles.select}
              value={mapping.orgId}
              onChange={(event) => {
                const value = event.target.value;
                setDraft((current) => ({
                  ...current,
                  organizationMappings: current.organizationMappings.map((entry, index) =>
                    index === orgIndex ? { ...entry, orgId: value } : entry,
                  ),
                }));
              }}
            >
              <option value="">Choose an organization</option>
              {(bootstrap.data?.organizations ?? []).map((organization: SettingsBootstrapData["organizations"][number]) => (
                <option key={organization.id} value={organization.id}>
                  {organization.name} ({organization.issuePrefix})
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: "grid", gap: 16, marginTop: 16 }}>
            {mapping.teamMappings.map((team, teamIndex) => (
              <div key={`team-${teamIndex}`} style={{ borderTop: "1px solid rgba(15, 23, 42, 0.08)", paddingTop: 16 }}>
                <div style={{ ...layoutStyles.row, justifyContent: "space-between" }}>
                  <strong>Linear team #{teamIndex + 1}</strong>
                  <button
                    type="button"
                    style={layoutStyles.subtleButton}
                    onClick={() => {
                      setDraft((current) => ({
                        ...current,
                        organizationMappings: current.organizationMappings.map((entry, index) => {
                          if (index !== orgIndex) return entry;
                          return {
                            ...entry,
                            teamMappings: entry.teamMappings.filter((_, nestedIndex) => nestedIndex !== teamIndex),
                          };
                        }),
                      }));
                    }}
                  >
                    Remove team
                  </button>
                </div>

                <div style={{ ...layoutStyles.row, marginTop: 12 }}>
                  <div style={layoutStyles.field}>
                    <label style={layoutStyles.label}>Linear Team ID</label>
                    <input
                      style={layoutStyles.input}
                      value={team.teamId}
                      onChange={(event) => {
                        const value = event.target.value;
                        setDraft((current) => ({
                          ...current,
                          organizationMappings: current.organizationMappings.map((entry, index) => {
                            if (index !== orgIndex) return entry;
                            return {
                              ...entry,
                              teamMappings: entry.teamMappings.map((nestedTeam, nestedIndex) =>
                                nestedIndex === teamIndex ? { ...nestedTeam, teamId: value } : nestedTeam,
                              ),
                            };
                          }),
                        }));
                      }}
                    />
                  </div>
                  <div style={layoutStyles.field}>
                    <label style={layoutStyles.label}>Linear Team Name</label>
                    <input
                      style={layoutStyles.input}
                      value={team.teamName ?? ""}
                      onChange={(event) => {
                        const value = event.target.value;
                        setDraft((current) => ({
                          ...current,
                          organizationMappings: current.organizationMappings.map((entry, index) => {
                            if (index !== orgIndex) return entry;
                            return {
                              ...entry,
                              teamMappings: entry.teamMappings.map((nestedTeam, nestedIndex) =>
                                nestedIndex === teamIndex ? { ...nestedTeam, teamName: value } : nestedTeam,
                              ),
                            };
                          }),
                        }));
                      }}
                    />
                  </div>
                </div>

                <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
                  {team.stateMappings.map((stateMapping, stateIndex) => (
                    <div key={`state-${stateIndex}`} style={{ ...layoutStyles.row, alignItems: "flex-end" }}>
                      <div style={layoutStyles.field}>
                        <label style={layoutStyles.label}>Linear State ID</label>
                        <input
                          style={layoutStyles.input}
                          value={stateMapping.linearStateId}
                          onChange={(event) => {
                            const value = event.target.value;
                            setDraft((current) => ({
                              ...current,
                              organizationMappings: current.organizationMappings.map((entry, index) => {
                                if (index !== orgIndex) return entry;
                                return {
                                  ...entry,
                                  teamMappings: entry.teamMappings.map((nestedTeam, nestedIndex) => {
                                    if (nestedIndex !== teamIndex) return nestedTeam;
                                    return {
                                      ...nestedTeam,
                                      stateMappings: nestedTeam.stateMappings.map((nestedState, nestedStateIndex) =>
                                        nestedStateIndex === stateIndex ? { ...nestedState, linearStateId: value } : nestedState,
                                      ),
                                    };
                                  }),
                                };
                              }),
                            }));
                          }}
                        />
                      </div>
                      <div style={layoutStyles.field}>
                        <label style={layoutStyles.label}>Linear State Name</label>
                        <input
                          style={layoutStyles.input}
                          value={stateMapping.linearStateName ?? ""}
                          onChange={(event) => {
                            const value = event.target.value;
                            setDraft((current) => ({
                              ...current,
                              organizationMappings: current.organizationMappings.map((entry, index) => {
                                if (index !== orgIndex) return entry;
                                return {
                                  ...entry,
                                  teamMappings: entry.teamMappings.map((nestedTeam, nestedIndex) => {
                                    if (nestedIndex !== teamIndex) return nestedTeam;
                                    return {
                                      ...nestedTeam,
                                      stateMappings: nestedTeam.stateMappings.map((nestedState, nestedStateIndex) =>
                                        nestedStateIndex === stateIndex ? { ...nestedState, linearStateName: value } : nestedState,
                                      ),
                                    };
                                  }),
                                };
                              }),
                            }));
                          }}
                        />
                      </div>
                      <div style={layoutStyles.field}>
                        <label style={layoutStyles.label}>Rudder Status</label>
                        <select
                          style={layoutStyles.select}
                          value={stateMapping.rudderStatus}
                          onChange={(event) => {
                            const value = event.target.value as LinearStateMapping["rudderStatus"];
                            setDraft((current) => ({
                              ...current,
                              organizationMappings: current.organizationMappings.map((entry, index) => {
                                if (index !== orgIndex) return entry;
                                return {
                                  ...entry,
                                  teamMappings: entry.teamMappings.map((nestedTeam, nestedIndex) => {
                                    if (nestedIndex !== teamIndex) return nestedTeam;
                                    return {
                                      ...nestedTeam,
                                      stateMappings: nestedTeam.stateMappings.map((nestedState, nestedStateIndex) =>
                                        nestedStateIndex === stateIndex ? { ...nestedState, rudderStatus: value } : nestedState,
                                      ),
                                    };
                                  }),
                                };
                              }),
                            }));
                          }}
                        >
                          {RUDDER_STATUS_OPTIONS.map((status) => (
                            <option key={status} value={status}>{status}</option>
                          ))}
                        </select>
                      </div>
                      <button
                        type="button"
                        style={layoutStyles.subtleButton}
                        onClick={() => {
                          setDraft((current) => ({
                            ...current,
                            organizationMappings: current.organizationMappings.map((entry, index) => {
                              if (index !== orgIndex) return entry;
                              return {
                                ...entry,
                                teamMappings: entry.teamMappings.map((nestedTeam, nestedIndex) => {
                                  if (nestedIndex !== teamIndex) return nestedTeam;
                                  return {
                                    ...nestedTeam,
                                    stateMappings: nestedTeam.stateMappings.filter((_, nestedStateIndex) => nestedStateIndex !== stateIndex),
                                  };
                                }),
                              };
                            }),
                          }));
                        }}
                      >
                        Remove state
                      </button>
                    </div>
                  ))}
                </div>

                <div style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    style={layoutStyles.button}
                    onClick={() => {
                      setDraft((current) => ({
                        ...current,
                        organizationMappings: current.organizationMappings.map((entry, index) => {
                          if (index !== orgIndex) return entry;
                          return {
                            ...entry,
                            teamMappings: entry.teamMappings.map((nestedTeam, nestedIndex) =>
                              nestedIndex === teamIndex
                                ? { ...nestedTeam, stateMappings: [...nestedTeam.stateMappings, emptyStateMapping()] }
                                : nestedTeam,
                            ),
                          };
                        }),
                      }));
                    }}
                  >
                    Add state mapping
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 16 }}>
            <button
              type="button"
              style={layoutStyles.button}
              onClick={() => {
                setDraft((current) => ({
                  ...current,
                  organizationMappings: current.organizationMappings.map((entry, index) =>
                    index === orgIndex
                      ? { ...entry, teamMappings: [...entry.teamMappings, emptyTeamMapping()] }
                      : entry,
                  ),
                }));
              }}
            >
              Add team mapping
            </button>
          </div>
        </section>
      ))}

      <section style={layoutStyles.card}>
        <div style={layoutStyles.row}>
          <button
            type="button"
            style={layoutStyles.button}
            onClick={() => setDraft((current) => ({
              ...current,
              organizationMappings: [...current.organizationMappings, emptyOrgMapping()],
            }))}
          >
            Add organization mapping
          </button>
          <button type="button" style={layoutStyles.button} onClick={() => void testConfig()} disabled={testing}>
            {testing ? "Testing…" : "Test connection"}
          </button>
          <button type="button" style={layoutStyles.primaryButton} onClick={() => void saveConfig()} disabled={saving}>
            {saving ? "Saving…" : "Save settings"}
          </button>
        </div>
      </section>
    </div>
  );
}
