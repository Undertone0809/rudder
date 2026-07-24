import { expect, test } from "@playwright/test";
import { E2E_BASE_URL } from "./support/e2e-env";

test("reveals exact Markdown source when a New Issue description image is activated", async ({ page }) => {
  const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
    data: {
      name: `Markdown-Image-Preview-${Date.now()}`,
    },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  await page.goto(E2E_BASE_URL);
  const wideImageDataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = 900;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Failed to create canvas context for image preview test");
    }
    context.fillStyle = "#f3f4f6";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#111827";
    context.fillRect(72, 72, canvas.width - 144, canvas.height - 144);
    context.fillStyle = "#60a5fa";
    context.fillRect(120, 132, 460, 220);
    context.fillStyle = "#f9fafb";
    context.font = "bold 88px sans-serif";
    context.fillText("1600 x 900", 660, 490);
    return canvas.toDataURL("image/png");
  });

  await page.evaluate(({ orgId, dataUrl }) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    window.localStorage.setItem("rudder:issue-autosave", JSON.stringify({
      title: "Markdown image preview draft",
      description: `![Wide image](${dataUrl})`,
      status: "todo",
      priority: "medium",
      labelIds: [],
      assigneeValue: "",
      projectId: "",
      projectWorkspaceId: "",
      assigneeModelOverride: "",
      assigneeThinkingEffort: "",
      assigneeChrome: false,
    }));
  }, { orgId: organization.id, dataUrl: wideImageDataUrl });

  await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/issues`);
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.getByTestId("workspace-main-header").getByRole("button", { name: "Create Issue" }).click();

  const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
  await expect(dialog).toBeVisible();

  const editor = dialog.locator('[data-editor-engine="codemirror-live-preview"]');
  const inlineImage = editor.locator('img[alt="Wide image"]').first();
  await expect(inlineImage).toBeVisible();
  await inlineImage.dispatchEvent("mousedown", { button: 0 });

  await expect(
    editor.locator('[data-markdown-preview-state="source"]').filter({
      hasText: "![Wide image](data:image/png;base64,",
    }),
  ).toBeVisible();
  await expect(editor.locator('img[alt="Wide image"]')).toHaveCount(0);
  await expect(page.getByTestId("markdown-editor-image-preview-dialog")).toHaveCount(0);
});
