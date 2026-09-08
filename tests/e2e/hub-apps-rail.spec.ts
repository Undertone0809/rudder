import { expect, test } from "@playwright/test";

test("Hub Apps opens, switches, closes on hover, and restores organization-scoped entries", async ({ page, request }) => {
  const suffix = Date.now();
  const orgResponse = await request.post("/api/orgs", { data: { name: `Apps rail ${suffix}` } });
  expect(orgResponse.ok()).toBe(true);
  const org = await orgResponse.json();
  const otherResponse = await request.post("/api/orgs", { data: { name: `Other Apps rail ${suffix}` } });
  expect(otherResponse.ok()).toBe(true);
  const other = await otherResponse.json();
  const settings = await request.patch("/api/instance/settings/general", { data: { experimentalPluginsEnabled: true } });
  expect(settings.ok()).toBe(true);
  const apps = [];
  for (const name of ["Research desk", "Operations console with a long application name"]) {
    const response = await request.post(`/api/orgs/${org.id}/app-builder`, {
      data: { name, sourceRoot: `apps/rail-${apps.length}-${suffix}`, scaffoldVersion: "1" },
    });
    expect(response.ok(), await response.text()).toBe(true);
    apps.push(await response.json());
  }
  const binding = { desktopInstallationId: `desktop-${suffix}`, appPublicId: `app-${suffix}`, localBindingId: `binding-${suffix}` };
  const bound = await request.put(`/api/app-builder/${apps[0].id}/local-binding?orgId=${org.id}`, { data: binding });
  expect(bound.ok(), await bound.text()).toBe(true);
  const savedResponse = await request.post(`/api/orgs/${org.id}/messenger/saved-views/keep`, {
    data: {
      target: { kind: "local_app", ...binding, viewInstanceId: `view-${suffix}` },
      title: apps[0].name,
      clientMutationId: crypto.randomUUID(),
      primaryRailPinned: true,
      placement: { kind: "loose" },
    },
  });
  expect(savedResponse.ok(), await savedResponse.text()).toBe(true);
  const { savedView } = await savedResponse.json();
  await page.goto(`/${org.issuePrefix}/hub?tab=apps`);
  const rail = page.getByTestId("primary-rail");
  const appEntries = rail.getByTestId("primary-rail-app");
  for (const app of apps) {
    await page.getByRole("button", { name: `Open ${app.name}`, exact: true }).click();
    await expect(rail.getByRole("link", { name: app.name, exact: true })).toBeVisible();
    await rail.getByRole("link", { name: "Hub", exact: true }).click();
    await expect(page).toHaveURL(/hub\?tab=apps$/);
  }
  await expect(appEntries).toHaveCount(2);
  await page.getByRole("button", { name: "Open Research desk", exact: true }).click();
  await expect(appEntries).toHaveCount(2);
  await page.mouse.move(500, 300);
  const inactiveClose = rail.getByRole("button", { name: `Close ${apps[1].name}`, exact: true });
  await expect(inactiveClose).toHaveCSS("opacity", "0");
  await rail.getByRole("link", { name: apps[1].name, exact: true }).hover();
  await expect(inactiveClose).toHaveCSS("opacity", "1");
  await inactiveClose.click();
  await expect(appEntries).toHaveCount(1);
  await expect(page).toHaveURL(new RegExp(encodeURIComponent(`managed:${apps[0].id}`) + "$"));
  const activeClose = rail.getByRole("button", { name: `Close ${apps[0].name}`, exact: true });
  await activeClose.focus();
  await expect(activeClose).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/hub\?tab=apps$/);
  await expect(appEntries).toHaveCount(0);
  await page.getByRole("button", { name: "Open Research desk", exact: true }).click();
  await expect(appEntries).toHaveCount(1);
  await page.reload();
  await expect(appEntries).toHaveCount(1);
  await page.goto(`/${other.issuePrefix}/hub?tab=apps`);
  await expect(appEntries).toHaveCount(0);
  await page.goto(`/${org.issuePrefix}/hub?tab=apps`);
  await expect(appEntries).toHaveCount(1);
  const repinned = await request.patch(`/api/orgs/${org.id}/messenger/saved-views/${savedView.id}`, { data: { primaryRailPinned: true } });
  expect(repinned.ok()).toBe(true);
  await rail.getByRole("link", { name: apps[0].name, exact: true }).click();
  await page.getByRole("button", { name: `Close ${apps[0].name} tab`, exact: true }).click();
  await expect(page).toHaveURL(/hub\?tab=apps$/);
  await expect(appEntries).toHaveCount(0);
  const preservedView = await request.get(`/api/orgs/${org.id}/messenger/saved-views/${savedView.id}`);
  expect(preservedView.ok()).toBe(true);
  expect((await preservedView.json()).primaryRailPinnedAt).toBeNull();
  const remaining = await request.get(`/api/orgs/${org.id}/app-builder`);
  expect((await remaining.json()).map((app: { id: string }) => app.id).sort()).toEqual(apps.map((app) => app.id).sort());
});
