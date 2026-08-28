import { expect, test } from "@playwright/test";
import { E2E_BASE_URL } from "./support/e2e-env";

test.describe("Issue draft empty state", () => {
  test("centers the wider empty state and omits the English helper message", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 720 });

    const orgRes = await page.request.post(`${E2E_BASE_URL}/api/orgs`, {
      data: {
        name: `Issue-Draft-Empty-State-${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string; urlKey?: string };
    const organizationRouteKey = organization.urlKey || organization.issuePrefix;

    const localeRes = await page.request.patch(`${E2E_BASE_URL}/api/instance/settings/general`, {
      data: { locale: "zh-CN" },
    });
    expect(localeRes.ok()).toBe(true);

    await page.goto(E2E_BASE_URL);
    await page.evaluate((orgId) => {
      window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
      window.localStorage.setItem("rudder:issue-drafts", JSON.stringify([]));
    }, organization.id);
    await page.goto(`${E2E_BASE_URL}/${organizationRouteKey}/issues?scope=drafts`);

    const view = page.getByTestId("issue-drafts-view");
    const emptyState = view.locator(".surface-panel");
    await expect(view).toBeVisible();
    await expect(view).toContainText("这里还没有内容");
    await expect(view).not.toContainText("No draft issues.");

    const desktopGeometry = await view.evaluate((element) => {
      const state = element.querySelector<HTMLElement>(".surface-panel");
      if (!state) return null;
      const viewRect = element.getBoundingClientRect();
      const stateRect = state.getBoundingClientRect();
      return {
        view: { width: viewRect.width, height: viewRect.height },
        state: { width: stateRect.width, height: stateRect.height },
        leftGap: stateRect.left - viewRect.left,
        rightGap: viewRect.right - stateRect.right,
        topGap: stateRect.top - viewRect.top,
        bottomGap: viewRect.bottom - stateRect.bottom,
      };
    });

    expect(desktopGeometry).not.toBeNull();
    expect(desktopGeometry!.state.width).toBeGreaterThanOrEqual(500);
    expect(Math.abs(desktopGeometry!.leftGap - desktopGeometry!.rightGap)).toBeLessThanOrEqual(2);
    expect(Math.abs(desktopGeometry!.topGap - desktopGeometry!.bottomGap)).toBeLessThanOrEqual(2);
    await page.screenshot({ path: testInfo.outputPath("issue-draft-empty-state-desktop.png"), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(view).toBeVisible();
    await expect(view).toContainText("这里还没有内容");

    const mobileGeometry = await view.evaluate((element) => {
      const state = element.querySelector<HTMLElement>(".surface-panel");
      if (!state) return null;
      const viewRect = element.getBoundingClientRect();
      const stateRect = state.getBoundingClientRect();
      return {
        view: { width: viewRect.width, height: viewRect.height },
        state: { width: stateRect.width, height: stateRect.height },
        leftGap: stateRect.left - viewRect.left,
        rightGap: viewRect.right - stateRect.right,
        topGap: stateRect.top - viewRect.top,
        bottomGap: viewRect.bottom - stateRect.bottom,
        overflow: state.scrollWidth > state.clientWidth || state.scrollHeight > state.clientHeight,
      };
    });

    expect(mobileGeometry).not.toBeNull();
    expect(mobileGeometry!.state.width).toBeLessThan(mobileGeometry!.view.width);
    expect(mobileGeometry!.overflow).toBe(false);
    expect(Math.abs(mobileGeometry!.leftGap - mobileGeometry!.rightGap)).toBeLessThanOrEqual(2);
    expect(Math.abs(mobileGeometry!.topGap - mobileGeometry!.bottomGap)).toBeLessThanOrEqual(2);
    await page.screenshot({ path: testInfo.outputPath("issue-draft-empty-state-mobile.png"), fullPage: true });

    await expect(emptyState).toBeVisible();
  });
});
