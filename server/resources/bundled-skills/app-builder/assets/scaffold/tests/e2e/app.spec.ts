import { expect, test } from "@playwright/test";

test("creates a contact and keeps it after reload", async ({ page }) => {
  const suffix = crypto.randomUUID();
  const name = `Avery ${suffix.slice(0, 8)}`;
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Contacts", exact: true })).toBeVisible();
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(`${suffix}@example.test`);
  await page.getByLabel("Company").fill("Acme");
  await page.getByRole("button", { name: "Add contact" }).click();
  await expect(page.getByText(name)).toBeVisible();
  await page.reload();
  await expect(page.getByText(name)).toBeVisible();
});

test("ships the Rudder UI preset in system light and dark modes", async ({ browser }) => {
  const lightPage = await browser.newPage({ colorScheme: "light" });
  await lightPage.goto("/");
  await expect(lightPage.getByText("Pipeline Desk")).toBeVisible();
  const lightStyle = await lightPage.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      background: getComputedStyle(document.body).backgroundColor,
      radius: style.getPropertyValue("--radius"),
    };
  });
  expect(Number.parseFloat(lightStyle.radius)).toBe(0.375);

  const darkPage = await browser.newPage({ colorScheme: "dark" });
  await darkPage.goto("/");
  const darkBackground = await darkPage.evaluate(() => (
    getComputedStyle(document.body).backgroundColor
  ));
  expect(darkBackground).not.toBe(lightStyle.background);
  await lightPage.close();
  await darkPage.close();
});

test("keeps the primary workflow usable at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Contacts", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Add contact" })).toBeVisible();
  await expect(page.getByLabel("Search contacts")).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete Maya Chen" })).toBeVisible();
  await expect(page.getByText("Northwind").first()).toBeVisible();
  await expect(page.locator("nextjs-portal")).toBeHidden();
});

test("shows the empty-search state", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Search contacts").fill("no matching record");
  await expect(page.getByRole("heading", { name: "No matching contacts" })).toBeVisible();
});

test("restores representative records from a JSON export", async ({ page, request }) => {
  const email = `restore-${crypto.randomUUID()}@example.test`;
  const createdResponse = await request.post("/api/contacts", {
    data: {
      name: "Restore Example",
      email,
      company: "Recovery Co",
    },
  });
  expect(createdResponse.status()).toBe(201);
  const created = await createdResponse.json() as { contact: { id: string } };

  const exportResponse = await request.get("/api/data/export");
  expect(exportResponse.status()).toBe(200);
  const exported = await exportResponse.json();

  const deleteResponse = await request.delete(`/api/contacts/${created.contact.id}`);
  expect(deleteResponse.status()).toBe(204);
  await page.goto("/");
  await page.getByLabel("Search contacts").fill(email);
  await expect(page.getByRole("heading", { name: "No matching contacts" })).toBeVisible();

  const importResponse = await request.post("/api/data/import", { data: exported });
  expect(importResponse.status()).toBe(200);
  await page.reload();
  await page.getByLabel("Search contacts").fill(email);
  await expect(page.getByText("Restore Example")).toBeVisible();
});
