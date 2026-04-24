import { expect, test } from "@playwright/test";
import { E2E_BASE_URL } from "./support/e2e-env";

test.describe("Agents workspace entry", () => {
  test("opens the default agent overview from the rail and keeps only the team navigator in the context column", async ({ page }) => {
    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `Agents-Toolbar-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = (await orgRes.json()) as { id: string; issuePrefix: string };

    const engineerRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Toolbar Agent",
        role: "engineer",
        title: "Founding Engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
        },
      },
    });
    expect(engineerRes.ok()).toBe(true);
    const engineer = (await engineerRes.json()) as { id: string };

    const ceoRes = await page.request.post(`${E2E_BASE_URL}/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Nia",
        role: "ceo",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4",
        },
      },
    });
    expect(ceoRes.ok()).toBe(true);
    const ceo = (await ceoRes.json()) as { id: string };

    await page.goto(E2E_BASE_URL);
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/dashboard`);
    await page.getByTestId("primary-rail").getByRole("link", { name: "Agents" }).click();

    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/agents/[^/]+/dashboard$`));
    await expect(page.getByRole("heading", { name: "Nia", exact: true })).toBeVisible();
    await expect(page.getByTestId("workspace-context-header")).not.toHaveClass(/desktop-window-drag/);
    await expect(page.getByTestId("agents-views-section")).toHaveCount(0);
    await expect(page.getByTestId("agents-team-toggle")).toHaveCount(0);
    await expect(page.getByText("All Agents", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Toolbar Agent (Founding Engineer)", { exact: true })).toBeVisible();
    await expect(page.getByText("Nia (CEO)", { exact: true })).toBeVisible();

    await page.getByRole("link", { name: "Toolbar Agent (Founding Engineer)", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/agents/[^/]+/dashboard$`));
    await expect(page.getByRole("heading", { name: "Toolbar Agent", exact: true })).toBeVisible();

    const teamCreateButton = page.getByRole("button", { name: "New agent" });
    await expect(teamCreateButton).toBeVisible();
    await teamCreateButton.click();
    await expect(page.getByText("Add a new agent")).toBeVisible();
    await page.getByRole("button", { name: "I want advanced configuration myself" }).click();
    await page.getByRole("button", { name: /Codex Local Codex agent/i }).click();
    const promptTemplateHelper = page.getByTestId("prompt-template-helper");
    await expect(promptTemplateHelper).toBeVisible();
    await expect(promptTemplateHelper).toContainText("Prompt template is replayed on every heartbeat.");
    await expect(promptTemplateHelper).toHaveClass(/text-muted-foreground/);
    await expect(promptTemplateHelper).not.toHaveClass(/text-amber-100/);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/agents/${ceo.id}/configuration`);
    await expect(page.getByRole("heading", { name: "Nia", exact: true })).toBeVisible();
    await expect(page.getByTestId("workspace-main-header").getByText("Agents", { exact: true })).toHaveCount(0);

    await page.goto(`${E2E_BASE_URL}/${organization.issuePrefix}/agents/${engineer.id}/configuration`);
    await expect(page.getByRole("heading", { name: "Toolbar Agent", exact: true })).toBeVisible();
  });
});
