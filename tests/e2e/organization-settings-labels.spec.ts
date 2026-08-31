import { expect, test } from "@playwright/test";

import { E2E_BASE_URL } from "./support/e2e-env";

test("requires explicit confirmation before deleting an organization label", async ({ page }) => {
  const orgResponse = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
    data: { name: `Label-Delete-Confirm-${Date.now()}` },
  });
  expect(orgResponse.ok()).toBe(true);
  const organization = await orgResponse.json() as { id: string; issuePrefix: string };

  const labelResponse = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/labels`, {
    data: { name: "Customer escalation", color: "#dc2626" },
  });
  expect(labelResponse.ok()).toBe(true);
  const label = await labelResponse.json() as { id: string };

  await page.goto(E2E_BASE_URL);
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/organization/settings`);
  await page.getByRole("tab", { name: "Workspace" }).click();

  const deleteButton = page.getByRole("button", { name: "Delete label Customer escalation" });
  await expect(deleteButton).toBeVisible({ timeout: 15_000 });

  let deleteRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "DELETE" && request.url().endsWith(`/api/labels/${label.id}`)) {
      deleteRequests += 1;
    }
  });

  await deleteButton.click();
  let dialog = page.getByRole("dialog", { name: 'Delete label "Customer escalation"?' });
  await expect(dialog).toContainText("permanently removes the label from the organization and from any issues that use it");
  await page.screenshot({ path: "/tmp/r6z-151-label-delete-confirmation-desktop.png", fullPage: false });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(deleteButton).toBeVisible();
  expect(deleteRequests).toBe(0);

  await deleteButton.click();
  dialog = page.getByRole("dialog", { name: 'Delete label "Customer escalation"?' });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(deleteButton).toBeVisible();
  expect(deleteRequests).toBe(0);

  await deleteButton.click();
  dialog = page.getByRole("dialog", { name: 'Delete label "Customer escalation"?' });
  const deleteResponse = page.waitForResponse((response) =>
    response.request().method() === "DELETE"
    && response.url().endsWith(`/api/labels/${label.id}`)
    && response.ok(),
  );
  await dialog.getByRole("button", { name: "Delete label" }).click({ clickCount: 2 });
  await deleteResponse;
  await expect(deleteButton).toHaveCount(0);
  expect(deleteRequests).toBe(1);
});
