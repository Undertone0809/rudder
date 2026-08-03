import { expect, test } from "@playwright/test";
import { E2E_BASE_URL } from "./support/e2e-env";

test("opens Messenger by default and keeps it as the first mobile tab", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  const organizationResponse = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
    data: { name: `Mobile-Navigation-${Date.now()}` },
  });
  expect(organizationResponse.ok(), await organizationResponse.text()).toBe(true);
  const organization = await organizationResponse.json() as {
    id: string;
    issuePrefix: string;
    urlKey?: string | null;
  };
  const organizationPath = organization.urlKey ?? organization.issuePrefix;

  await page.addInitScript((organizationId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", organizationId);
  }, organization.id);
  await page.goto(E2E_BASE_URL);

  const messengerUrl = new RegExp(`/${organizationPath}/messenger(?:/chat)?$`);
  await expect(page).toHaveURL(messengerUrl);
  const navigation = page.getByRole("navigation", { name: "Mobile navigation" });
  await expect(navigation).toBeVisible();
  await expect.poll(async () => navigation.locator("a, button").allTextContents()).toEqual([
    "Messenger",
    "Issues",
    "Create",
    "Agents",
  ]);
  await expect(navigation.getByText("Home", { exact: true })).toHaveCount(0);

  await navigation.getByRole("link", { name: "Issues" }).click();
  await expect(page).toHaveURL(new RegExp(`/${organizationPath}/issues$`));
  await navigation.getByRole("link", { name: "Messenger" }).click();
  await expect(page).toHaveURL(messengerUrl);
});
