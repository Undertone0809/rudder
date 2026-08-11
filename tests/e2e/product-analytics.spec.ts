import { expect, test } from "@playwright/test";

test.describe("product analytics privacy controls", () => {
  test("keeps Privacy & Telemetry controls available without a sidebar destination", async ({ page }) => {
    await page.request.patch("/api/instance/settings/product-analytics", { data: { mode: "off" } });
    const organizationResponse = await page.request.post("/api/orgs", {
      data: { name: `Analytics Settings UI ${Date.now()}` },
    });
    expect(organizationResponse.ok()).toBe(true);
    const organization = await organizationResponse.json() as { issuePrefix?: string; urlKey?: string };
    await page.goto(`/${organization.urlKey ?? organization.issuePrefix}/dashboard`);
    await page.goto("/instance/settings/privacy");
    const settings = page.getByTestId("product-analytics-settings");
    await expect(settings).toBeVisible();
    await expect(settings.getByRole("heading", { name: "Privacy & Telemetry", level: 1 })).toBeVisible();
    await expect(settings).toContainText("Masked installation ID");
    await expect(settings).toContainText("Not collected");
    await expect(page.locator('a[href$="/instance/settings/privacy"]')).toHaveCount(0);
    const anonymousToggle = settings.getByRole("switch", { name: "Enable anonymous telemetry" });
    await expect(anonymousToggle).toBeVisible();
    await anonymousToggle.click();
    await expect.poll(async () => {
      const response = await page.request.get("/api/instance/settings/product-analytics");
      return (await response.json() as { mode?: string }).mode;
    }).toBe("anonymous");
    await expect(settings).toContainText("Current mode: Anonymous");
    await page.request.patch("/api/instance/settings/product-analytics", { data: { mode: "off" } });
  });

  test("keeps telemetry off by default and records explicit anonymous consent", async ({ page }) => {
    const orgResponse = await page.request.post("/api/orgs", {
      data: { name: `Analytics Privacy E2E ${Date.now()}` },
    });
    expect(orgResponse.ok()).toBe(true);
    const organization = await orgResponse.json() as { id: string };
    const installationId = `e2e-installation-${Date.now()}`;
    const installationSecret = `e2e-secret-${Date.now()}`;

    const registration = await page.request.post(`/api/orgs/${organization.id}/analytics/product/installation`, {
      data: { installationId, installationSecret },
    });
    expect(registration.status()).toBe(201);
    expect(await registration.json()).toMatchObject({ installationId, mode: "off" });

    const before = await page.request.get(`/api/orgs/${organization.id}/analytics/product/installation/${installationId}`);
    expect(before.ok()).toBe(true);
    expect(await before.json()).toMatchObject({ installation: { mode: "off" }, pendingCount: 0 });

    const consent = await page.request.post(`/api/orgs/${organization.id}/analytics/product/installation/${installationId}/consent`, {
      data: { scope: "anonymous_installation", decision: "granted", policyVersion: "v1", installationSecret },
    });
    expect(consent.status()).toBe(201);
    expect(await consent.json()).toMatchObject({ scope: "anonymous_installation", decision: "granted", consentEpoch: 1 });

    const after = await page.request.get(`/api/orgs/${organization.id}/analytics/product/installation/${installationId}`);
    expect(await after.json()).toMatchObject({ installation: { mode: "anonymous" }, pendingCount: 0 });

    const secondOrgResponse = await page.request.post("/api/orgs", {
      data: { name: `Analytics Privacy E2E post-consent ${Date.now()}` },
    });
    expect(secondOrgResponse.ok()).toBe(true);
    const pendingAfterConsent = await page.request.get(`/api/orgs/${organization.id}/analytics/product/installation/${installationId}`);
    expect((await pendingAfterConsent.json()).pendingCount).toBeGreaterThanOrEqual(0);

    const revoke = await page.request.post(`/api/orgs/${organization.id}/analytics/product/installation/${installationId}/consent`, {
      data: { scope: "anonymous_installation", decision: "revoked", policyVersion: "v1", installationSecret },
    });
    expect(revoke.status()).toBe(201);
    const afterRevoke = await page.request.get(`/api/orgs/${organization.id}/analytics/product/installation/${installationId}`);
    expect(await afterRevoke.json()).toMatchObject({ installation: { mode: "off" } });
  });
});
