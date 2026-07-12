import { expect, test } from "@playwright/test";

test.describe("Agent instructions Library redirect", () => {
  test("opens instructions in Library from the tab and legacy URL", async ({ page, request }) => {
    const organizationRes = await request.post("/api/orgs", {
      data: { name: `Agent-Instructions-Redirect-${Date.now()}` },
    });
    expect(organizationRes.ok()).toBe(true);
    const organization = await organizationRes.json() as { id: string; issuePrefix: string };

    const agentRes = await request.post(`/api/orgs/${organization.id}/agents`, {
      data: {
        name: "Instructions Redirect Agent",
        role: "engineer",
        agentRuntimeType: "codex_local",
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json() as { id: string };

    const detailRes = await request.get(`/api/agents/${agent.id}`);
    expect(detailRes.ok()).toBe(true);
    const detail = await detailRes.json() as { instructionsLibraryPath: string | null };
    expect(detail.instructionsLibraryPath).toBeTruthy();

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/dashboard`);
    await page.getByRole("tab", { name: "Instructions" }).click();
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/library\\?directory=`));
    expect(new URL(page.url()).searchParams.get("directory")).toBe(detail.instructionsLibraryPath);

    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/instructions`);
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/library\\?directory=`));
    expect(new URL(page.url()).searchParams.get("directory")).toBe(detail.instructionsLibraryPath);
    await expect(page.getByRole("tab", { name: "Instructions" })).toHaveCount(0);

    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/prompts`);
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/library\\?directory=`));
    expect(new URL(page.url()).searchParams.get("directory")).toBe(detail.instructionsLibraryPath);

    const externalBundleRes = await request.patch(`/api/agents/${agent.id}/instructions-bundle`, {
      data: {
        mode: "external",
        rootPath: "/tmp/rudder-external-instructions",
        entryFile: "SOUL.md",
      },
    });
    expect(externalBundleRes.ok()).toBe(true);

    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/dashboard`);
    await expect(page.getByRole("tab", { name: "Instructions" })).toHaveCount(0);
    await page.goto(`/${organization.issuePrefix}/agents/${agent.id}/instructions`);
    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/agents/[^/]+/dashboard$`));
  });
});
