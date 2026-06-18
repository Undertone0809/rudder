import { expect, test, type Page } from "@playwright/test";

test.use({ serviceWorkers: "block" });

async function createOrganization(request: Page["request"], name: string) {
  const organizationRes = await request.post("/api/orgs", {
    data: { name: `${name}-${Date.now()}` },
  });
  expect(organizationRes.ok()).toBe(true);
  return await organizationRes.json() as { id: string; issuePrefix: string };
}

async function selectOrganization(page: Page, orgId: string) {
  await page.goto("/");
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

async function writeWorkspaceFile(
  request: Page["request"],
  organizationId: string,
  filePath: string,
  content: string,
) {
  const fileRes = await request.post(`/api/orgs/${organizationId}/workspace/file`, {
    data: { filePath, content },
  });
  expect(fileRes.ok()).toBe(true);
}

async function readWorkspaceFile(request: Page["request"], organizationId: string, filePath: string) {
  const fileRes = await request.get(`/api/orgs/${organizationId}/workspace/file?path=${encodeURIComponent(filePath)}`);
  expect(fileRes.ok()).toBe(true);
  return await fileRes.json() as { content: string };
}

test("Library renders JSON files in the code editor and persists edits", async ({ page, request }) => {
  const suffix = Date.now();
  const organization = await createOrganization(request, "Library-Code-Editor");
  const filePath = `projects/code-editor-${suffix}/evals.json`;
  await writeWorkspaceFile(
    request,
    organization.id,
    filePath,
    JSON.stringify({
      skill_name: "debug-run-transcript",
      evals: [{ id: 1, prompt: "Debug failed run" }],
    }, null, 2),
  );

  await selectOrganization(page, organization.id);
  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(filePath)}`);

  const editorHost = page.getByTestId("org-workspaces-editor-textarea");
  await expect(page.getByTestId("org-workspaces-editor-tabs")).toContainText("evals.json", { timeout: 15_000 });
  await expect(editorHost).toBeVisible();
  await expect(editorHost).toHaveAttribute("data-workspace-code-language", "JSON");
  await expect(editorHost.locator(".cm-editor")).toBeVisible();
  await expect(editorHost.locator(".cm-line").filter({ hasText: "skill_name" })).toBeVisible();
  await expect(page.getByTestId("org-workspaces-editor-status-bar")).toContainText("JSON");

  await page.screenshot({ path: "/tmp/rudder-library-code-editor-proof.png", fullPage: false });

  const nextContent = JSON.stringify({
    skill_name: "debug-run-transcript",
    evals: [{ id: 2, prompt: "Inspect highlighted JSON" }],
    status: "reviewed",
  }, null, 2);
  const saveResponse = page.waitForResponse((response) =>
    response.url().includes(`/api/orgs/${organization.id}/workspace/file`)
    && response.url().includes(encodeURIComponent(filePath))
    && response.request().method() === "PATCH",
  );
  await editorHost.locator(".cm-content").click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.type(nextContent);
  await saveResponse;

  const savedFile = await readWorkspaceFile(request, organization.id, filePath);
  expect(savedFile.content).toContain("\"status\": \"reviewed\"");
  expect(savedFile.content).toContain("Inspect highlighted JSON");
});
