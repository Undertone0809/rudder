import { expect, test, type Page } from "@playwright/test";

test.use({ serviceWorkers: "block" });

async function selectOrganization(page: Page, orgId: string) {
  await page.goto("/");
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

async function createOrganization(request: Page["request"], name: string) {
  const organizationRes = await request.post("/api/orgs", {
    data: { name: `${name}-${Date.now()}` },
  });
  expect(organizationRes.ok()).toBe(true);
  return await organizationRes.json() as { id: string; issuePrefix: string };
}

async function writeWorkspaceFile(
  request: Page["request"],
  organizationId: string,
  filePath: string,
  content: string,
) {
  const createRes = await request.post(`/api/orgs/${organizationId}/workspace/file`, {
    data: { filePath, content },
  });
  expect(createRes.ok()).toBe(true);
}

async function readWorkspaceFile(request: Page["request"], organizationId: string, filePath: string) {
  const fileRes = await request.get(`/api/orgs/${organizationId}/workspace/file?path=${encodeURIComponent(filePath)}`);
  expect(fileRes.ok()).toBe(true);
  return await fileRes.json() as { content: string };
}

test("Library renders CSV files as an editable table and persists cell edits", async ({ page, request }) => {
  const suffix = Date.now();
  const organization = await createOrganization(request, "Library-CSV-Editor");

  const csvPath = `projects/csv-editor-${suffix}/outreach.csv`;
  await writeWorkspaceFile(
    request,
    organization.id,
    csvPath,
    [
      "sample_rank,github_handle,fit_reason",
      "1,daFailer,\"Public profile, no direct contact\"",
      "2,vyankateshpotdar,Manual site review",
    ].join("\n"),
  );

  await selectOrganization(page, organization.id);
  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(csvPath)}`);

  await expect(page.getByTestId("org-workspaces-editor-tabs")).toContainText("outreach.csv", { timeout: 15_000 });
  await expect(page.getByTestId("org-workspaces-csv-editor")).toBeVisible();
  await expect(page.getByTestId("org-workspaces-editor-textarea")).toHaveCount(0);
  await expect(page.getByTestId("org-workspaces-csv-cell-0-0")).toHaveValue("sample_rank");
  await expect(page.getByTestId("org-workspaces-csv-cell-1-2")).toHaveValue("Public profile, no direct contact");
  await page.screenshot({ path: "/tmp/rudder-csv-editor-proof.png", fullPage: false });

  const saveResponse = page.waitForResponse((response) =>
    response.url().includes(`/api/orgs/${organization.id}/workspace/file`)
    && response.url().includes(encodeURIComponent(csvPath))
    && response.request().method() === "PATCH",
  );
  await page.getByTestId("org-workspaces-csv-cell-2-2").fill("Needs \"review\", has comma");
  await saveResponse;

  await expect(page.getByTestId("org-workspaces-editor-status-bar")).toContainText("CSV");
  await expect(page.getByTestId("org-workspaces-editor-status-bar")).toContainText("3 rows");
  await expect(page.getByTestId("org-workspaces-editor-status-bar")).toContainText("3 columns");

  const file = await readWorkspaceFile(request, organization.id, csvPath);
  expect(file.content).toContain("2,vyankateshpotdar,\"Needs \"\"review\"\", has comma\"");
});

test("Library CSV editor keeps a source fallback and avoids padding untouched ragged rows", async ({ page, request }) => {
  const suffix = Date.now();
  const organization = await createOrganization(request, "Library-CSV-Source");
  const csvPath = `projects/csv-source-${suffix}/ragged.csv`;
  await writeWorkspaceFile(
    request,
    organization.id,
    csvPath,
    [
      "name,notes,priority",
      "Ava,\"quoted, unchanged\"",
      "",
      "Bea,manual",
    ].join("\n"),
  );

  await selectOrganization(page, organization.id);
  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(csvPath)}`);
  await expect(page.getByTestId("org-workspaces-csv-editor")).toBeVisible();
  await expect(page.getByTestId("org-workspaces-csv-cell-1-1")).toHaveValue("quoted, unchanged");

  const saveResponse = page.waitForResponse((response) =>
    response.url().includes(`/api/orgs/${organization.id}/workspace/file`)
    && response.url().includes(encodeURIComponent(csvPath))
    && response.request().method() === "PATCH",
  );
  await page.getByTestId("org-workspaces-csv-cell-3-1").fill("manual updated");
  await saveResponse;

  const tableSavedFile = await readWorkspaceFile(request, organization.id, csvPath);
  expect(tableSavedFile.content.split("\n")).toEqual([
    "name,notes,priority",
    "Ava,\"quoted, unchanged\"",
    "",
    "Bea,manual updated",
  ]);

  await page
    .getByTestId("org-workspaces-csv-editor")
    .getByRole("button", { name: "Source" })
    .click();
  const sourceEditor = page.getByTestId("org-workspaces-csv-source-textarea");
  await expect(sourceEditor).toBeVisible();
  await expect(sourceEditor).toHaveValue(tableSavedFile.content);

  const sourceSaveResponse = page.waitForResponse((response) =>
    response.url().includes(`/api/orgs/${organization.id}/workspace/file`)
    && response.url().includes(encodeURIComponent(csvPath))
    && response.request().method() === "PATCH",
  );
  await sourceEditor.fill(`${tableSavedFile.content}\nCara,\"source mode, exact\"`);
  await sourceSaveResponse;

  const sourceSavedFile = await readWorkspaceFile(request, organization.id, csvPath);
  expect(sourceSavedFile.content).toContain("Cara,\"source mode, exact\"");
});

test("Library CSV editor opens a production-shaped outreach file", async ({ page, request }) => {
  const suffix = Date.now();
  const organization = await createOrganization(request, "Library-CSV-Large");
  const csvPath = `projects/csv-large-${suffix}/outreach-large.csv`;
  const headers = [
    "sample_rank",
    "github_handle",
    "name",
    "profile_url",
    "starred_at",
    "contact_type",
    "send_mode",
    "bio_company_location_clue",
    "related_project_clues",
    "fit_for_outreach",
    "priority",
    "fit_reason",
    "notes",
    "followers",
  ];
  const rows = Array.from({ length: 260 }, (_, index) => {
    const rank = index + 1;
    return [
      String(rank),
      `user-${rank}`,
      `User ${rank}`,
      `https://github.com/user-${rank}`,
      "2026-06-18T07:30:05Z",
      rank % 3 === 0 ? "website" : "none",
      rank % 3 === 0 ? "manual_site_review" : "do_not_contact",
      `City ${rank}, JavaScript, Python`,
      `repo-${rank}, TypeScript, ${rank % 5} stars`,
      rank % 3 === 0 ? "Yes - manual contact" : "No - no public contact entry",
      rank % 4 === 0 ? "P2" : "P3",
      `Public profile signal ${rank}, repo relevance, needs careful personalization before outreach.`,
      `Long note ${rank}: review project evidence, do not infer private email, preserve commas, quotes, and reviewer context.`,
      String(rank * 7),
    ].map((field) => field.includes(",") ? `"${field.replaceAll("\"", "\"\"")}"` : field).join(",");
  });
  await writeWorkspaceFile(request, organization.id, csvPath, [headers.join(","), ...rows].join("\n"));

  await selectOrganization(page, organization.id);
  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(csvPath)}`);
  await expect(page.getByTestId("org-workspaces-csv-editor")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("org-workspaces-editor-status-bar")).toContainText("261 rows");
  await expect(page.getByTestId("org-workspaces-editor-status-bar")).toContainText("14 columns");
  await expect(page.getByTestId("org-workspaces-csv-cell-1-11")).toHaveValue(/Public profile signal 1/);

  const saveResponse = page.waitForResponse((response) =>
    response.url().includes(`/api/orgs/${organization.id}/workspace/file`)
    && response.url().includes(encodeURIComponent(csvPath))
    && response.request().method() === "PATCH",
  );
  await page.getByTestId("org-workspaces-csv-cell-1-12").fill("Reviewed in table mode, keep source available.");
  await saveResponse;

  const file = await readWorkspaceFile(request, organization.id, csvPath);
  expect(file.content).toContain("Reviewed in table mode");
});
