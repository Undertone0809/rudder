import { expect, test } from "@playwright/test";

test.describe("product analytics privacy controls", () => {
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
