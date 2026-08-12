import { expect, test } from "@playwright/test";
import { E2E_CODEX_STUB } from "./support/e2e-env";

test.describe("Agent Skill creation entry points", () => {
  test("routes Agent Skill creation through Hub, Chat, or upload", async ({ page }) => {
    const organizationName = `Org-Agent-Skill-Create-${Date.now()}`;
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: organizationName,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as {
      id: string;
      urlKey: string;
    };

    const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Skill Author",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
          command: E2E_CODEX_STUB,
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.urlKey}/agents/${agent.id}/skills`);
    const agentMain = page.locator("#main-content");
    await agentMain.getByRole("button", { name: "Add Skill" }).click();
    await expect(page.getByRole("menuitem", { name: "Browse Hub" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Upload Skill" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Create via Chat" }).click();
    await expect.poll(() => new URL(page.url()).pathname).toMatch(/\/messenger\/chat$/);
    await expect(page.getByRole("combobox", { name: "editable markdown" }))
      .toContainText("Use the skill-creator skill");
    await expect(page.getByRole("button", { name: /Chat agent: Skill Author/ })).toBeVisible();

    await page.goto(`/${organization.urlKey}/agents/${agent.id}/skills`);
    await agentMain.getByRole("button", { name: "Add Skill" }).click();
    await page.getByRole("menuitem", { name: "Upload Skill" }).click();
    await expect.poll(() => `${new URL(page.url()).pathname}${new URL(page.url()).search}`)
      .toMatch(/\/hub\?tab=skills&create=upload$/);
    const uploadDialog = page.getByRole("dialog", { name: "Upload Skill" });
    await expect(uploadDialog).toBeVisible();

    const uploadResponse = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && response.url().endsWith(`/api/orgs/${organization.id}/skills/upload`)
    ));
    await page.getByTestId("skill-file-input").evaluate((input) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([
        "---\nname: Hub Uploaded Skill\ndescription: Root-level upload acceptance.\n---\n\n# Hub Uploaded Skill\n",
      ], "SKILL.md", { type: "text/markdown" }));
      const fileInput = input as HTMLInputElement;
      fileInput.files = transfer.files;
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect((await uploadResponse).ok()).toBe(true);
    await expect(uploadDialog.getByText("Added Hub Uploaded Skill.", { exact: true })).toBeVisible();
    await uploadDialog.getByRole("button", { name: "Close" }).first().click();
    await expect(page.getByText("Hub Uploaded Skill", { exact: true })).toBeVisible();
  });
});
