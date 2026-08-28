import { expect, test, type APIRequestContext, type Page, type Route } from "@playwright/test";
import type {
  RudderInstalledPlugin,
  RudderPluginCatalog,
  RudderPluginDetail,
  RudderPluginImportReport,
  RudderPluginPackageFileInput,
} from "@rudderhq/shared";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { E2E_BASE_URL } from "./support/e2e-env";

const icon = readFileSync(fileURLToPath(new URL("../../docs/favicon.png", import.meta.url)));
const commitShaV1 = "a".repeat(40);
const commitShaV2 = "b".repeat(40);

async function createOrganization(request: APIRequestContext) {
  const response = await request.post(`${E2E_BASE_URL}/api/orgs`, {
    data: { name: `Plugin Discovery ${Date.now()}` },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<{ id: string; issuePrefix: string }>;
}

async function selectOrganization(page: Page, orgId: string) {
  await page.goto(E2E_BASE_URL);
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

function pluginFiles(input: {
  name: string;
  displayName: string;
  version: string;
  skillCount: number;
  includeUnsupportedApp?: boolean;
  changedSkill?: number;
  extraFileCount?: number;
}): RudderPluginPackageFileInput[] {
  const manifest: Record<string, unknown> = {
    name: input.name,
    version: input.version,
    description: `${input.displayName} capabilities for deterministic E2E coverage.`,
    author: { name: "Rudder E2E" },
    skills: "./skills/",
    interface: {
      displayName: input.displayName,
      shortDescription: `${input.skillCount} installable Skills.`,
      developerName: "Rudder E2E",
      category: "Developer Tools",
    },
  };
  if (input.includeUnsupportedApp) manifest.apps = "./.app.json";
  return [
    { path: ".codex-plugin/plugin.json", content: JSON.stringify(manifest), encoding: "utf8" },
    ...Array.from({ length: input.skillCount }, (_, index) => {
      const number = String(index + 1).padStart(2, "0");
      return {
        path: `skills/workflow-${number}/SKILL.md`,
        content: `---\nname: Workflow ${number}\ndescription: Execute workflow ${number}.\n---\n\n# Workflow ${number}\n${input.changedSkill === index + 1 ? "\nUse the revised immutable workflow.\n" : ""}`,
        encoding: "utf8" as const,
      };
    }),
    ...(input.includeUnsupportedApp
      ? [{ path: ".app.json", content: JSON.stringify({ studio: "asdk_app_e2e" }), encoding: "utf8" as const }]
      : []),
    ...Array.from({ length: input.extraFileCount ?? 0 }, (_, index) => ({
      path: `skills/workflow-01/references/reference-${String(index + 1).padStart(3, "0")}.md`,
      content: `Reference ${index + 1}.`,
      encoding: "utf8" as const,
    })),
  ];
}

async function inspectPlugin(
  request: APIRequestContext,
  orgId: string,
  sourceLabel: string,
  files: RudderPluginPackageFileInput[],
) {
  const response = await request.post(`${E2E_BASE_URL}/api/orgs/${orgId}/plugins/imports/inspect`, {
    data: { sourceType: "local_upload", sourceLabel, files },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<RudderPluginImportReport>;
}

function detailFromReport(
  slug: string,
  displayName: string,
  report: RudderPluginImportReport,
  options: {
    sourceKind: "codex_plugin" | "skills_add";
    installed?: RudderInstalledPlugin | null;
    commitSha?: string;
  } = { sourceKind: "codex_plugin" },
): RudderPluginDetail {
  const components = report.components;
  const groups = {
    skills: components.filter((component) => component.type === "skill"),
    mcps: components.filter((component) => component.type === "mcp"),
    apps: components.filter((component) => component.type === "app"),
    unsupported: components.filter((component) => component.type === "unsupported"),
  };
  return {
    slug,
    displayName,
    developer: slug === "marketing-skills" ? "Corey Haines" : slug === "scientific-agent-skills" ? "K-Dense" : "Jesse Vincent",
    category: slug === "marketing-skills" ? "Marketing" : slug === "scientific-agent-skills" ? "Education & Research" : "Developer Tools",
    shortDescription: `${components.filter((component) => component.type === "skill").length} installable Skills in one immutable Plugin.`,
    longDescription: `A production-shaped ${displayName} Preview used to verify the complete Rudder Plugin journey.`,
    capabilities: ["Read", "Write"],
    websiteUrl: `https://github.com/example/${slug}`,
    privacyPolicyUrl: "https://example.com/privacy",
    termsOfServiceUrl: "https://example.com/terms",
    license: { spdx: "MIT", sourceUrl: "https://example.com/license", note: "E2E fixture" },
    sourceKind: options.sourceKind,
    iconUrl: `/api/plugins/catalog/${slug}/icon`,
    previewId: report.id,
    packageId: report.packageId!,
    action: report.operation === "update" ? "update" : options.installed ? "installed" : report.operation,
    installedPluginId: options.installed?.id ?? report.installedPluginId,
    resolution: {
      repositoryUrl: `https://github.com/example/${slug}`,
      source: `example/${slug}`,
      subdirectory: "",
      strategy: "stable_release",
      version: String(report.manifest?.version ?? "1.0.0"),
      commitSha: options.commitSha ?? commitShaV1,
    },
    components,
    groups,
    warnings: report.warnings,
    capabilityDiff: report.capabilityDiff,
    skillConflicts: report.skillConflicts,
  };
}

const catalogRows = [
  ["scientific-agent-skills", "Scientific Agent Skills", "K-Dense", "Education & Research", "skills_add"],
  ["superpowers", "Superpowers", "obra", "Developer Tools", "codex_plugin"],
  ["marketing-skills", "Marketing Skills", "Corey Haines", "Marketing", "skills_add"],
  ["vercel", "Vercel", "Vercel", "Developer Tools", "codex_plugin"],
  ["base44", "Base44", "Base44", "Developer Tools", "codex_plugin"],
  ["canva", "Canva", "Canva", "Design", "codex_plugin"],
  ["remotion", "Remotion", "Remotion", "Video", "codex_plugin"],
  ["zotero", "Zotero", "Zotero", "Research", "codex_plugin"],
] as const;

test("discovers, reopens, installs, updates, assigns, and uninstalls immutable Plugin Previews", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const organization = await createOrganization(page.request);
  const agentResponse = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
    data: { name: "Plugin Agent", role: "general", adapterType: "claude_local", adapterConfig: {} },
  });
  expect(agentResponse.ok(), await agentResponse.text()).toBe(true);
  const agent = await agentResponse.json() as { id: string };

  const superpowersV1 = await inspectPlugin(page.request, organization.id, "Superpowers v1", pluginFiles({
    name: "superpowers-e2e",
    displayName: "Superpowers",
    version: "1.0.0",
    skillCount: 14,
  }));
  const marketing = await inspectPlugin(page.request, organization.id, "Marketing Skills", pluginFiles({
    name: "marketing-skills-e2e",
    displayName: "Marketing Skills",
    version: "2.10.0",
    skillCount: 49,
    includeUnsupportedApp: true,
  }));
  const scientific = await inspectPlugin(page.request, organization.id, "Scientific Agent Skills", pluginFiles({
    name: "scientific-agent-skills-e2e",
    displayName: "Scientific Agent Skills",
    version: "2.64.0",
    skillCount: 163,
    extraFileCount: 400,
  }));
  expect(scientific.limits.fileCount).toBeGreaterThan(500);
  const details = new Map<string, RudderPluginDetail>([
    ["scientific-agent-skills", detailFromReport("scientific-agent-skills", "Scientific Agent Skills", scientific, { sourceKind: "skills_add" })],
    ["superpowers", detailFromReport("superpowers", "Superpowers", superpowersV1)],
    ["marketing-skills", detailFromReport("marketing-skills", "Marketing Skills", marketing, { sourceKind: "skills_add" })],
  ]);
  const installations = new Map<string, RudderInstalledPlugin>();
  let catalogPreviewPosts = 0;
  const requestedIconThemes: string[] = [];
  const uninstalledPluginIds = new Set<string>();
  const staleInstalledReads: string[] = [];
  let catalogFreshness: RudderPluginCatalog["freshness"] = "fresh";

  const catalog = (): RudderPluginCatalog => ({
    freshness: catalogFreshness,
    updatedAt: "2026-08-14T00:00:00.000Z",
    entries: catalogRows.map(([slug, displayName, developer, category, sourceKind]) => {
      const installed = installations.get(slug);
      const detail = details.get(slug);
      return {
        slug,
        displayName,
        developer,
        category,
        shortDescription: detail?.shortDescription ?? `${displayName} curated Plugin.`,
        sourceKind,
        iconUrl: `/api/plugins/catalog/${slug}/icon`,
        installedPluginId: installed?.id ?? null,
        installedVersion: installed?.version ?? null,
        installedSourceSha: installed ? commitShaV1 : null,
        latestVersion: detail?.resolution.version ?? null,
        latestSourceSha: detail?.resolution.commitSha ?? null,
        updateAvailable: detail?.action === "update",
      };
    }),
  });

  await page.route("**/api/plugins/catalog/*/icon*", async (route) => {
    requestedIconThemes.push(new URL(route.request().url()).searchParams.get("theme") ?? "missing");
    await route.fulfill({ status: 200, contentType: "image/png", body: icon });
  });
  await page.route(`**/api/orgs/${organization.id}/plugins/catalog`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(catalog()) });
  });
  await page.route(`**/api/orgs/${organization.id}/plugins/catalog/*/preview`, async (route) => {
    catalogPreviewPosts += 1;
    const slug = new URL(route.request().url()).pathname.split("/").at(-2)!;
    const detail = details.get(slug);
    if (!detail) {
      await route.fulfill({ status: 404, json: { error: "Fixture Preview not found" } });
      return;
    }
    await route.fulfill({ status: 201, json: detail });
  });
  await page.route(`**/api/orgs/${organization.id}/plugins/imports/preview-source`, async (route) => {
    await route.fulfill({ status: 201, json: details.get("marketing-skills")! });
  });
  await page.route(`**/api/orgs/${organization.id}/plugins/previews/*`, async (route) => {
    const previewId = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const found = [...details.entries()].find(([, detail]) => detail.previewId === previewId);
    if (!found) {
      await route.fulfill({ status: 404, json: { error: "Fixture Preview not found" } });
      return;
    }
    const [slug, detail] = found;
    await route.fulfill({ status: 200, json: { ...detail, ...(installations.get(slug) ? { action: "installed", installedPluginId: installations.get(slug)!.id } : {}) } });
  });
  await page.route(`**/api/orgs/${organization.id}/plugins/imports/*/install`, async (route: Route) => {
    const response = await route.fetch();
    const plugin = await response.json() as RudderInstalledPlugin;
    const slug = plugin.name === "superpowers-e2e" ? "superpowers" : "marketing-skills";
    installations.set(slug, plugin);
    details.set(slug, { ...details.get(slug)!, action: "installed", installedPluginId: plugin.id });
    await route.fulfill({ response, json: plugin });
  });
  await page.route(new RegExp(`/api/orgs/${organization.id}/plugins/[0-9a-f-]+$`), async (route) => {
    const pluginId = new URL(route.request().url()).pathname.split("/").at(-1)!;
    if (route.request().method() !== "DELETE") {
      if (uninstalledPluginIds.has(pluginId)) staleInstalledReads.push(pluginId);
      await route.continue();
      return;
    }
    const response = await route.fetch();
    uninstalledPluginIds.add(pluginId);
    for (const [slug, plugin] of installations) {
      if (plugin.id !== pluginId) continue;
      installations.delete(slug);
      details.set(slug, { ...details.get(slug)!, action: "install", installedPluginId: null });
    }
    await route.fulfill({ response });
  });

  await selectOrganization(page, organization.id);
  await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/hub?tab=plugins`);
  for (const [, displayName] of catalogRows) {
    await expect(page.getByText(displayName, { exact: true }).first()).toBeVisible();
  }

  await page.getByText("Scientific Agent Skills", { exact: true }).first().click();
  await expect(page).toHaveURL(/\/hub\/plugins\/scientific-agent-skills\?preview=/);
  await expect(page.getByRole("heading", { name: "Scientific Agent Skills", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Skills 163/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("scientific-agent-skills-detail-desktop-light.png"), fullPage: true });
  await page.getByRole("button", { name: "Plugins", exact: true }).click();

  await page.getByText("Superpowers", { exact: true }).first().click();
  await expect(page).toHaveURL(/\/hub\/plugins\/superpowers\?preview=/);
  await expect(page.getByRole("heading", { name: "Superpowers", exact: true })).toBeVisible();
  expect(requestedIconThemes).toContain("light");
  await expect(page.getByRole("heading", { name: /Skills 14/ })).toBeVisible();
  await page.getByRole("textbox", { name: "Search Plugin components" }).fill("Workflow 14");
  await expect(page.getByRole("heading", { name: /Skills 1 \/ 14/ })).toBeVisible();
  await expect(page.getByText("Workflow 14", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Search Plugin components" }).fill("");
  await page.screenshot({ path: testInfo.outputPath("superpowers-detail-desktop-light.png"), fullPage: true });

  const previewPostsBeforeReload = catalogPreviewPosts;
  await page.reload();
  await expect(page.getByRole("heading", { name: /Skills 14/ })).toBeVisible();
  expect(catalogPreviewPosts).toBe(previewPostsBeforeReload);
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await expect(page.getByRole("button", { name: "Installed", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add to Agent", exact: true }).click();
  await page.getByText("Plugin Agent", { exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();

  catalogFreshness = "stale";
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await expect(page.getByTestId("plugin-catalog-stale")).toContainText("Showing cached catalog");
  const staleDiscoverSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Discover plugins" }) });
  await expect(staleDiscoverSection.getByText("Superpowers", { exact: true })).toBeVisible();
  await expect(staleDiscoverSection.getByText("Installed", { exact: true })).toBeVisible();
  catalogFreshness = "fresh";

  const superpowersV2 = await inspectPlugin(page.request, organization.id, "Superpowers v2", pluginFiles({
    name: "superpowers-e2e",
    displayName: "Superpowers",
    version: "1.1.0",
    skillCount: 15,
    changedSkill: 1,
  }));
  expect(superpowersV2.operation).toBe("update");
  details.set("superpowers", detailFromReport("superpowers", "Superpowers", superpowersV2, {
    sourceKind: "codex_plugin",
    installed: installations.get("superpowers"),
    commitSha: commitShaV2,
  }));

  await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/hub?tab=plugins`);
  const discoverSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Discover plugins" }) });
  const superpowersCard = discoverSection.getByRole("button").filter({ hasText: "Superpowers" });
  await expect(superpowersCard.getByText("Update available", { exact: true })).toBeVisible();
  await superpowersCard.click();
  await expect(page.getByRole("heading", { name: /Skills 15/ })).toBeVisible();
  await expect(page.getByText("Update available", { exact: true })).toBeVisible();
  await expect(page.getByText(commitShaV2, { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Capability changes", exact: true })).toBeVisible();
  await expect(page.getByLabel("Capability changes").getByText("Workflow 15", { exact: true })).toBeVisible();
  await expect(page.getByText("added", { exact: true })).toBeVisible();
  await expect(page.getByText("changed", { exact: true })).toBeVisible();
  await expect(page.getByText("Before execution surface", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("After execution surface", { exact: true }).first()).toBeVisible();
  const approveExpandedAccess = page.getByText("Approve expanded access", { exact: true });
  if (await approveExpandedAccess.isVisible()) await approveExpandedAccess.click();
  await page.getByRole("button", { name: "Update", exact: true }).click();
  await expect(page.getByRole("button", { name: "Installed", exact: true })).toBeVisible();
  await expect(page.getByText("Approve expanded access", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Capability changes", exact: true })).toHaveCount(0);

  const updatedPlugin = await page.request.get(`${E2E_BASE_URL}/api/orgs/${organization.id}/plugins/${installations.get("superpowers")!.id}`);
  expect(updatedPlugin.ok(), await updatedPlugin.text()).toBe(true);
  const updatedPluginBody = await updatedPlugin.json() as RudderInstalledPlugin;
  expect(updatedPluginBody.version).toBe("1.1.0");
  const updatedSkills = updatedPluginBody.components.filter((component) => component.type === "skill");
  expect(updatedSkills).toHaveLength(15);
  expect(updatedSkills.every((component) => (
    Array.isArray(component.metadata.enabledAgentIds)
    && component.metadata.enabledAgentIds.includes(agent.id)
  ))).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.localStorage.setItem("rudder.theme", "dark"));
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.getByRole("button", { name: "Installed", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeHidden();
  expect(requestedIconThemes).toContain("dark");
  await page.screenshot({ path: testInfo.outputPath("superpowers-detail-mobile-dark.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => window.localStorage.setItem("rudder.theme", "light"));

  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page.getByRole("button", { name: "URL Import", exact: true }).click();
  await page.getByPlaceholder("coreyhaines31/marketingskills").fill("coreyhaines31/marketingskills");
  await page.getByRole("dialog").getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page).toHaveURL(/\/hub\/plugins\/marketing-skills\?preview=/);
  await expect(page.getByRole("heading", { name: "Marketing Skills", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Skills 49/ })).toBeVisible();
  await page.getByRole("textbox", { name: "Search Plugin components" }).fill("Workflow 49");
  await expect(page.getByRole("heading", { name: /Skills 1 \/ 49/ })).toBeVisible();
  await expect(page.getByText("Workflow 49", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Search Plugin components" }).fill("");
  await expect(page.getByRole("heading", { name: /Apps 1/ })).toBeVisible();
  await expect(page.getByText("Unsupported", { exact: true }).last()).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Marketing Skills", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await expect(page.getByRole("button", { name: "Installed", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add to Agent", exact: true }).click();
  await page.getByText("Plugin Agent", { exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Uninstall", exact: true }).click();
  const uninstallDialog = page.getByRole("dialog", { name: "Uninstall Marketing Skills?" });
  await uninstallDialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(uninstallDialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Installed", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Uninstall", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(uninstallDialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Installed", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Uninstall", exact: true }).click();
  await uninstallDialog.getByRole("button", { name: "Uninstall", exact: true }).click();
  await expect(page).toHaveURL(/\/hub\?tab=plugins$/);
  await expect.poll(() => staleInstalledReads).toEqual([]);
});
