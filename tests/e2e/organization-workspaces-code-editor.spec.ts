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

test("Library code selection keeps syntax text readable across themes", async ({ page, request }) => {
  const suffix = Date.now();
  const organization = await createOrganization(request, "Library-Selection-Contrast");
  const filePath = `projects/selection-contrast-${suffix}/packet.json`;
  await writeWorkspaceFile(
    request,
    organization.id,
    filePath,
    JSON.stringify({
      authorized: true,
      mode: "isolated_risk",
      target_ref: "refs/heads/codex/selection-contrast",
      base_sha: "d29be293f6266a1b6a9b5d9aec441c4d6bc41d84",
      remote_ref: "refs/remotes/origin/codex/selection-contrast",
      observed_remote_sha: "d29be293f6266a1b6a9b5d9aec441c4d6bc41d84",
      branch_refs: ["refs/heads/codex/selection-contrast"],
    }, null, 2),
  );

  await selectOrganization(page, organization.id);
  await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(filePath)}`);
  const editor = page.getByTestId("org-workspaces-editor-textarea");
  const content = editor.locator(".cm-content");
  await expect(content).toBeVisible();
  await page.locator("html").evaluate((element) => element.classList.add("dark"));

  const contentBox = await content.boundingBox();
  expect(contentBox).not.toBeNull();
  await page.mouse.move(contentBox!.x + 20, contentBox!.y + 28);
  await page.mouse.down();
  await page.mouse.move(contentBox!.x + 520, contentBox!.y + 172, { steps: 8 });
  await page.mouse.up();

  const readSelectionStyle = () => editor.locator(".cm-selectionBackground").first().evaluate((element) => {
    const contentElement = element.closest(".cm-editor")?.querySelector(".cm-content");
    return {
      backgroundColor: getComputedStyle(element).backgroundColor,
      selectionColor: contentElement ? getComputedStyle(contentElement, "::selection").color : "",
      selectedText: window.getSelection()?.toString() ?? "",
    };
  });
  const darkSelectionStyle = await readSelectionStyle();
  const darkSelectionIsReadable = darkSelectionStyle.backgroundColor.startsWith("oklab(")
    ? Number(darkSelectionStyle.backgroundColor.match(/^oklab\(([-\d.]+)/)?.[1] ?? Number.POSITIVE_INFINITY) < 0.6
    : darkSelectionStyle.backgroundColor
      .match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/)
      ?.slice(1)
      .map(Number)
      .every((channel) => channel < 180) ?? false;
  expect(darkSelectionStyle.selectedText).toContain('"authorized": true');
  expect(darkSelectionStyle.selectionColor).toMatch(/^oklch\(0\.955/);
  expect(darkSelectionIsReadable).toBe(true);

  await page.locator("html").evaluate((element) => element.classList.remove("dark"));
  const lightSelectionStyle = await readSelectionStyle();
  expect(lightSelectionStyle.selectedText).toContain('"authorized": true');
  expect(lightSelectionStyle.selectionColor).toMatch(/^oklch\(0\.205/);
  expect(lightSelectionStyle.backgroundColor).not.toBe("transparent");
});
