import { expect, test, type Page } from "@playwright/test";

async function createOrganization(page: Page, name: string) {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `${name}-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  return orgRes.json() as Promise<{ id: string; urlKey: string }>;
}

test("organization skill links land in Library instead of the legacy Skills detail page", async ({ page }) => {
  const organization = await createOrganization(page, "Skill-Library-Navigation");
  const skillsRes = await page.request.get(`/api/orgs/${organization.id}/skills`);
  expect(skillsRes.ok()).toBe(true);
  const skills = await skillsRes.json() as Array<{
    id: string;
    name: string;
    sourceBadge: string;
  }>;
  const bundledSkill = skills.find((skill) => skill.sourceBadge === "rudder") ?? skills[0];
  expect(bundledSkill).toBeTruthy();

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.urlKey}/skills/${bundledSkill!.id}`);
  await expect(page).toHaveURL(
    new RegExp(`/${organization.urlKey}/library\\?skill=${bundledSkill!.id}&skillFile=SKILL\\.md$`),
  );
  await expect(page.getByTestId("org-workspaces-virtual-skill-readonly")).toContainText("Read-only skill");
  const metadata = page.getByTestId("org-workspaces-virtual-skill-metadata");
  await expect(metadata).toBeVisible();
  await metadata.locator("summary").click();
  await expect(metadata.getByLabel("Skill metadata")).toContainText("name:");

  await page.goto(`/${organization.urlKey}/dashboard`);
  await page.getByRole("link", { name: "Skills" }).click();
  await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/library\\?directory=skills$`));
  await expect(page.getByTestId("org-workspaces-files-scroll")).toContainText("skills");
});

test("legacy skill visits do not hijack the Organization rail destination", async ({ page }) => {
  const organization = await createOrganization(page, "Skill-Organization-Rail");
  const skillsRes = await page.request.get(`/api/orgs/${organization.id}/skills`);
  expect(skillsRes.ok()).toBe(true);
  const skills = await skillsRes.json() as Array<{
    id: string;
    name: string;
    sourceBadge: string;
  }>;
  const bundledSkill = skills.find((skill) => skill.sourceBadge === "rudder") ?? skills[0];
  expect(bundledSkill).toBeTruthy();

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  await page.goto(`/${organization.urlKey}/dashboard`);
  await expect(
    page.getByTestId("dashboard-calendar-switcher").getByRole("link", { name: "Dashboard", exact: true }),
  ).toBeVisible();

  await page.goto(`/${organization.urlKey}/skills/${bundledSkill!.id}`);
  await expect(page).toHaveURL(
    new RegExp(`/${organization.urlKey}/library\\?skill=${bundledSkill!.id}&skillFile=SKILL\\.md$`),
  );
  await expect(page.getByTestId("org-workspaces-virtual-skill-readonly")).toContainText("Read-only skill");

  await page.getByTestId("primary-rail").getByRole("link", { name: "Organization" }).click();
  await expect(page).toHaveURL(new RegExp(`/${organization.urlKey}/dashboard$`));
  await expect(
    page.getByTestId("dashboard-calendar-switcher").getByRole("link", { name: "Dashboard", exact: true }),
  ).toBeVisible();
});
