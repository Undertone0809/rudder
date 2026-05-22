import { expect, test } from "@playwright/test";

test.describe("Chat project empty heading", () => {
  test("updates the draft chat heading when the selected project changes", async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Project-Heading-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const alphaRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Alpha Console",
        description: "Primary chat heading test project.",
      },
    });
    const betaRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: "Beta Workspace",
        description: "Secondary chat heading test project.",
      },
    });
    expect(alphaRes.ok()).toBe(true);
    expect(betaRes.ok()).toBe(true);
    const alpha = await alphaRes.json() as { id: string; name: string };
    const beta = await betaRes.json() as { id: string; name: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat?projectId=${alpha.id}`);

    const heading = page.locator("h1.motion-chat-empty-heading");
    await expect(heading).toHaveText(`What should we build in ${alpha.name}?`, { timeout: 15_000 });
    await expect(heading).toHaveClass(/motion-chat-empty-heading/);
    await expect(page.getByTestId("chat-project-selector")).toContainText(alpha.name);

    await page.getByTestId("chat-project-selector").click();
    await page.getByRole("menuitemradio", { name: new RegExp(beta.name) }).click();

    await expect(heading).toHaveText(`What should we build in ${beta.name}?`, { timeout: 15_000 });
    await expect(page.getByTestId("chat-project-selector")).toContainText(beta.name);

    await page.getByTestId("chat-project-selector").click();
    await page.getByRole("menuitemradio", { name: "No project" }).click();

    await expect(heading).toHaveText(/What can I help with\?/);
    await expect(page.getByTestId("chat-project-selector")).toContainText("No project");
  });

  test("wraps long project names on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    const longProjectName = "SupercalifragilisticexpialidociousProjectWithoutNaturalBreakpoints";
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Chat-Project-Long-Heading-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json();

    const projectRes = await page.request.post(`/api/orgs/${organization.id}/projects`, {
      data: {
        name: longProjectName,
        description: "Long mobile chat heading test project.",
      },
    });
    expect(projectRes.ok()).toBe(true);
    const project = await projectRes.json() as { id: string; name: string };

    await page.goto("/");
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
    }, organization.id);

    await page.goto(`/${organization.issuePrefix}/messenger/chat?projectId=${project.id}`);

    const heading = page.locator("h1.motion-chat-empty-heading");
    await expect(heading).toHaveText(`What should we build in ${longProjectName}?`, { timeout: 15_000 });

    const headingMetrics = await heading.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      overflowWrap: window.getComputedStyle(element).overflowWrap,
      text: element.textContent,
    }));
    const pageMetrics = await page.evaluate(() => ({
      bodyWidth: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
    }));

    expect(headingMetrics.text).toBe(`What should we build in ${longProjectName}?`);
    expect(headingMetrics.overflowWrap).toBe("anywhere");
    expect(headingMetrics.scrollWidth).toBeLessThanOrEqual(headingMetrics.clientWidth);
    expect(pageMetrics.bodyWidth).toBeLessThanOrEqual(pageMetrics.viewportWidth);
  });
});
