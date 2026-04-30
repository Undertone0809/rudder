import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginDetailTabProps, PluginPageProps } from "@rudderhq/plugin-sdk/ui";
import { LinearIssueTab, LinearPluginPage, LinearPluginSettingsPage } from "../src/ui/index.js";

const mockedUsePluginData = vi.fn();
const mockedUsePluginAction = vi.fn();
const mockedUsePluginToast = vi.fn();

vi.mock("@rudderhq/plugin-sdk/ui", () => ({
  usePluginData: (...args: unknown[]) => mockedUsePluginData(...args),
  usePluginAction: (...args: unknown[]) => mockedUsePluginAction(...args),
  usePluginToast: () => mockedUsePluginToast,
}));

function makePageProps(): PluginPageProps {
  return {
    context: {
      orgId: "org-1",
      companyPrefix: "ACME",
      entityId: null,
      entityType: null,
      projectId: null,
      userId: "user-1",
    },
  };
}

function makeIssueTabProps(): PluginDetailTabProps {
  return {
    context: {
      orgId: "org-1",
      companyPrefix: "ACME",
      entityId: "issue-1",
      entityType: "issue",
      projectId: "project-1",
      userId: "user-1",
    },
  };
}

let container: HTMLDivElement;
let root: Root | null = null;
const originalFetch = globalThis.fetch;

function render(element: ReactNode) {
  act(() => {
    root = createRoot(container);
    root.render(element);
  });
}

function cleanup() {
  act(() => {
    root?.unmount();
    root = null;
  });
  container.remove();
}

function findText(text: string): HTMLElement | null {
  return [...container.querySelectorAll<HTMLElement>("*")].find((element) => element.textContent?.includes(text)) ?? null;
}

function findLink(text: string): HTMLAnchorElement | null {
  return [...container.querySelectorAll<HTMLAnchorElement>("a")].find((element) => element.textContent?.includes(text)) ?? null;
}

function click(element: HTMLElement) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function clickAsync(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

async function flushAsync(turns = 8) {
  await act(async () => {
    for (let index = 0; index < turns; index += 1) {
      await Promise.resolve();
    }
  });
}

function changeValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  act(() => {
    const proto = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("@rudderhq/plugin-linear UI", () => {
  beforeEach(() => {
    mockedUsePluginData.mockReset();
    mockedUsePluginAction.mockReset();
    mockedUsePluginToast.mockReset();
    mockedUsePluginToast.mockImplementation(() => null);
    mockedUsePluginAction.mockReturnValue(vi.fn().mockResolvedValue({
      importedCount: 1,
      duplicateCount: 0,
      fallbackCount: 0,
      adjustedCount: 0,
      importedIssues: [],
      duplicateIssueIds: [],
    }));
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch;
    window.history.replaceState({}, "", "/instance/settings/plugins/plugin-linear");
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it("requires a target project before import and shows imported deep links", () => {
    mockedUsePluginData.mockImplementation((key: string) => {
      if (key === "page-bootstrap") {
        return {
          data: {
            configured: true,
            message: null,
            projects: [{ id: "project-1", name: "Imported Work" }],
            teamMappings: [],
          },
          loading: false,
          error: null,
          refresh: vi.fn(),
        };
      }
      if (key === "linear-catalog") {
        return {
          data: {
            orgId: "org-1",
            teams: [{ id: "team-1", name: "Engineering", key: "ENG", states: [{ id: "state-1", name: "Backlog" }] }],
            projects: [],
            users: [],
          },
          loading: false,
          error: null,
          refresh: vi.fn(),
        };
      }
      return {
        data: {
          rows: [
            {
              id: "lin-1",
              identifier: "ENG-101",
              title: "Imported already",
              description: "desc",
              url: "https://linear.app/example/ENG-101",
              updatedAt: "2026-04-22T00:00:00.000Z",
              createdAt: "2026-04-20T00:00:00.000Z",
              team: { id: "team-1", name: "Engineering", key: "ENG", states: [] },
              state: { id: "state-1", name: "Backlog" },
              project: null,
              assignee: null,
              imported: true,
              importedRudderIssueId: "issue-100",
              importedRudderIssueIdentifier: "ACME-1",
              importedOrgId: "org-1",
            },
            {
              id: "lin-2",
              identifier: "ENG-102",
              title: "Ready to import",
              description: "desc",
              url: "https://linear.app/example/ENG-102",
              updatedAt: "2026-04-22T00:00:00.000Z",
              createdAt: "2026-04-20T00:00:00.000Z",
              team: { id: "team-1", name: "Engineering", key: "ENG", states: [] },
              state: { id: "state-1", name: "Backlog" },
              project: null,
              assignee: null,
              imported: false,
              importedRudderIssueId: null,
              importedRudderIssueIdentifier: null,
              importedOrgId: null,
            },
          ],
          endCursor: null,
          hasNextPage: false,
          totalShown: 2,
        },
        loading: false,
        error: null,
        refresh: vi.fn(),
      };
    });

    render(<LinearPluginPage {...makePageProps()} />);

    expect(container.textContent).toContain("Choose a target Rudder project");
    const deepLink = findLink("Open Rudder issue");
    expect(deepLink?.getAttribute("href")).toBe("/ACME/issues/issue-100");

    const importAll = container.querySelector<HTMLButtonElement>("[data-testid='linear-import-all']");
    expect(importAll?.disabled).toBe(true);

    const projectSelect = container.querySelector<HTMLSelectElement>("[data-testid='linear-target-project']");
    expect(projectSelect).not.toBeNull();
    changeValue(projectSelect!, "project-1");

    const checkboxes = [...container.querySelectorAll<HTMLInputElement>("input[type='checkbox']")];
    click(checkboxes[1]!);

    expect(importAll?.disabled).toBe(false);
    const importSelected = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Import selected"),
    );
    expect(importSelected?.disabled).toBe(false);
  });

  it("renders the token-first settings page instead of exposing raw mappings", async () => {
    mockedUsePluginData.mockReturnValue({
      data: {
        config: {
          apiTokenSecretRef: "linear-api-token",
          organizationMappings: [
            {
              orgId: "org-1",
              teamMappings: [
                {
                  teamId: "team-1",
                  teamName: "Engineering",
                  stateMappings: [
                    {
                      linearStateId: "state-1",
                      linearStateName: "Backlog",
                      rudderStatus: "backlog",
                    },
                  ],
                },
              ],
            },
          ],
        },
        organizations: [{ id: "org-1", name: "Acme", issuePrefix: "ACME" }],
        fixtureMode: false,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/plugins/plugin-linear/data/settings-catalog")) {
        return new Response(JSON.stringify({
          data: {
            orgId: "org-1",
            teams: [
              {
                id: "team-1",
                key: "ENG",
                name: "Engineering",
                states: [{ id: "state-1", name: "Backlog", type: "backlog" }],
              },
            ],
            projects: [],
            users: [],
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    render(<LinearPluginSettingsPage {...makePageProps()} />);
    await flushAsync();

    expect(container.textContent).toContain("Paste a Linear token once");
    expect(container.textContent).not.toContain("Secret Ref");
    expect(container.textContent).not.toContain("Linear team id");
    expect(container.textContent).not.toContain("Linear state id");
    expect(container.textContent).not.toContain("Add team mapping");
    expect(container.querySelector<HTMLInputElement>("[data-testid='linear-token-input']")?.value).toBe("");
    expect(container.querySelector<HTMLInputElement>("[data-testid='linear-token-input']")?.placeholder).toContain("Token saved");
    expect(findLink("Create a Linear token")?.getAttribute("href")).toBe("https://linear.app/settings/account/security");
    expect(container.textContent).toContain("Connected. 1 Linear team found; 1 selected for import.");
    expect(container.textContent).toContain("Teams to import");
    expect(container.textContent).toContain("Engineering");
    expect(container.textContent).toContain("Status rules (optional)");
    expect(container.querySelector<HTMLDetailsElement>("details")?.open).toBe(false);
    expect(container.textContent).toContain("Save choices");
  });

  it("lets operators choose Linear teams by name and saves generated config", async () => {
    mockedUsePluginData.mockReturnValue({
      data: {
        config: {
          apiTokenSecretRef: "linear-api-token",
          organizationMappings: [
            {
              orgId: "org-1",
              teamMappings: [
                {
                  teamId: "team-1",
                  teamName: "Engineering",
                  stateMappings: [
                    {
                      linearStateId: "state-backlog",
                      linearStateName: "Backlog",
                      rudderStatus: "backlog",
                    },
                  ],
                },
              ],
            },
          ],
        },
        organizations: [{ id: "org-1", name: "Acme", issuePrefix: "ACME" }],
        fixtureMode: false,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/plugins/plugin-linear/data/settings-catalog")) {
        return new Response(JSON.stringify({
          data: {
            orgId: "org-1",
            teams: [
              {
                id: "team-1",
                key: "ENG",
                name: "Engineering",
                states: [{ id: "state-backlog", name: "Backlog", type: "backlog" }],
              },
              {
                id: "team-2",
                key: "DES",
                name: "Design",
                states: [{ id: "state-done", name: "Done", type: "completed" }],
              },
            ],
            projects: [],
            users: [],
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/plugins/plugin-linear/config")) {
        return new Response(JSON.stringify({ id: "config-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    render(<LinearPluginSettingsPage {...makePageProps()} />);
    await flushAsync();

    expect(container.textContent).toContain("Engineering");
    expect(container.textContent).toContain("Design");
    await clickAsync(container.querySelector<HTMLInputElement>("[data-testid='linear-team-choice-team-2']")!);
    await clickAsync(container.querySelector<HTMLButtonElement>("[data-testid='linear-save-team-choices']")!);

    const saveCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/api/plugins/plugin-linear/config"));
    const body = JSON.parse(String((saveCall?.[1] as RequestInit | undefined)?.body ?? "{}"));
    expect(body.configJson.organizationMappings[0].teamMappings).toEqual([
      expect.objectContaining({ teamId: "team-1", teamName: "Engineering" }),
      expect.objectContaining({ teamId: "team-2", teamName: "Design" }),
    ]);
  });

  it("creates a secret and fills mappings from Linear catalog", async () => {
    const refresh = vi.fn();
    mockedUsePluginData.mockReturnValue({
      data: {
        config: {
          apiTokenSecretRef: "",
          organizationMappings: [],
        },
        organizations: [{ id: "org-1", name: "Acme", issuePrefix: "ACME" }],
        fixtureMode: false,
      },
      loading: false,
      error: null,
      refresh,
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/orgs/org-1/secrets")) {
        return new Response(JSON.stringify({ id: "secret-1" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/plugins/plugin-linear/config")) {
        return new Response(JSON.stringify({ id: "config-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/plugins/plugin-linear/data/settings-catalog")) {
        return new Response(JSON.stringify({
          data: {
            orgId: "org-1",
            teams: [
              {
                id: "team-1",
                key: "ENG",
                name: "Engineering",
                states: [
                  { id: "state-backlog", name: "Backlog", type: "backlog" },
                  { id: "state-done", name: "Done", type: "completed" },
                ],
              },
            ],
            projects: [],
            users: [],
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url} ${init?.method}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    render(<LinearPluginSettingsPage {...makePageProps()} />);

    changeValue(container.querySelector<HTMLInputElement>("[data-testid='linear-token-input']")!, "lin_api_test");
    await clickAsync(container.querySelector<HTMLButtonElement>("[data-testid='linear-connect']")!);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/orgs/org-1/secrets",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const finalConfigCall = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith("/api/plugins/plugin-linear/config"))
      .at(-1);
    const finalBody = JSON.parse(String((finalConfigCall?.[1] as RequestInit | undefined)?.body ?? "{}"));
    expect(finalBody.configJson).toMatchObject({
      apiTokenSecretRef: "secret-1",
      organizationMappings: [
        {
          orgId: "org-1",
          teamMappings: [
            {
              teamId: "team-1",
              teamName: "Engineering",
              stateMappings: [
                { linearStateId: "state-backlog", rudderStatus: "backlog" },
                { linearStateId: "state-done", rudderStatus: "done" },
              ],
            },
          ],
        },
      ],
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("refreshes a stale plugin worker when the settings catalog handler is missing", async () => {
    const refresh = vi.fn();
    mockedUsePluginData.mockReturnValue({
      data: {
        config: {
          apiTokenSecretRef: "",
          organizationMappings: [],
        },
        organizations: [{ id: "org-1", name: "Acme", issuePrefix: "ACME" }],
        fixtureMode: false,
      },
      loading: false,
      error: null,
      refresh,
    });

    let catalogAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/orgs/org-1/secrets")) {
        return new Response(JSON.stringify({ id: "secret-1" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/plugins/plugin-linear/config")) {
        return new Response(JSON.stringify({ id: "config-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/plugins/plugin-linear/data/settings-catalog")) {
        catalogAttempts += 1;
        if (catalogAttempts === 1) {
          return new Response(JSON.stringify({
            message: "No data handler registered for key \"settings-catalog\"",
          }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({
          data: {
            orgId: "org-1",
            teams: [
              {
                id: "team-1",
                key: "ENG",
                name: "Engineering",
                states: [{ id: "state-done", name: "Done", type: "completed" }],
              },
            ],
            projects: [],
            users: [],
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/plugins/plugin-linear/disable")) {
        return new Response(JSON.stringify({ id: "plugin-linear", status: "disabled" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/plugins/plugin-linear/enable")) {
        return new Response(JSON.stringify({ id: "plugin-linear", status: "ready" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    render(<LinearPluginSettingsPage {...makePageProps()} />);

    changeValue(container.querySelector<HTMLInputElement>("[data-testid='linear-token-input']")!, "lin_api_test");
    await clickAsync(container.querySelector<HTMLButtonElement>("[data-testid='linear-connect']")!);
    await flushAsync();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/plugins/plugin-linear/disable",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/plugins/plugin-linear/enable",
      expect.objectContaining({ method: "POST" }),
    );
    const finalConfigCall = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith("/api/plugins/plugin-linear/config"))
      .at(-1);
    const finalBody = JSON.parse(String((finalConfigCall?.[1] as RequestInit | undefined)?.body ?? "{}"));
    expect(finalBody.configJson.organizationMappings[0].teamMappings[0].stateMappings[0]).toMatchObject({
      linearStateId: "state-done",
      rudderStatus: "done",
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("shows the unlinked issue state with a deep link back to the plugin page", () => {
    mockedUsePluginData.mockReturnValue({
      data: {
        linked: false,
        issueTitle: "Missing link issue",
        searchQuery: "Missing link issue",
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<LinearIssueTab {...makeIssueTabProps()} />);

    const link = findLink("Open Linear intake");
    expect(link?.getAttribute("href")).toBe("/ACME/linear?q=Missing+link+issue");
  });

  it("renders the linked Linear issue details in the issue tab", () => {
    mockedUsePluginData.mockReturnValue({
      data: {
        linked: true,
        issueTitle: "Imported issue",
        link: {
          externalId: "lin-2",
          linearIdentifier: "ENG-102",
          linearTitle: "Status mapped issue",
          linearUrl: "https://linear.app/example/ENG-102",
          orgId: "org-1",
          rudderIssueId: "issue-1",
          rudderIssueIdentifier: "ACME-1",
          teamId: "team-1",
          teamName: "Engineering",
          projectId: "project-1",
          projectName: "Roadmap",
          stateId: "state-2",
          stateName: "In Progress",
          importedAt: "2026-04-22T00:00:00.000Z",
          updatedAt: "2026-04-22T00:00:00.000Z",
        },
        latestIssue: {
          id: "lin-2",
          identifier: "ENG-102",
          title: "Status mapped issue",
          description: "Fresh description from Linear.",
          url: "https://linear.app/example/ENG-102",
          updatedAt: "2026-04-22T00:00:00.000Z",
          createdAt: "2026-04-20T00:00:00.000Z",
          team: { id: "team-1", key: "ENG", name: "Engineering", states: [] },
          state: { id: "state-2", name: "In Progress" },
          project: { id: "project-1", name: "Roadmap" },
          assignee: { id: "user-1", name: "Amy Zhang" },
        },
        staleReason: null,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<LinearIssueTab {...makeIssueTabProps()} />);

    expect(findText("ENG-102 maps to this Rudder issue.")).not.toBeNull();
    expect(findText("Fresh description from Linear.")).not.toBeNull();
    const link = findLink("Open in Linear");
    expect(link?.getAttribute("href")).toBe("https://linear.app/example/ENG-102");
  });
});
