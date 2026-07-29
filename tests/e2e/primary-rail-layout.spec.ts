import { expect, test } from "@playwright/test";

test.describe("Primary rail layout", () => {
  for (const platform of [
    {
      name: "macOS desktop",
      expectedPlatform: "macos",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/537.36 Chrome/131 Safari/537.36",
      desktopShell: true,
    },
    {
      name: "Windows desktop",
      expectedPlatform: "windows",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
      desktopShell: true,
    },
    {
      name: "browser",
      expectedPlatform: null,
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
      desktopShell: false,
    },
  ] as const) {
    test(
      `keeps ${platform.name} navigation labels inside the vertical scroll viewport`,
      async ({ page }, testInfo) => {
        await page.addInitScript(({ userAgent, desktopShell }) => {
          Object.defineProperty(window.navigator, "userAgent", {
            configurable: true,
            get: () => userAgent,
          });
          if (desktopShell) {
            Object.defineProperty(window, "desktopShell", {
              configurable: true,
              value: {
                setBadgeCount: async () => {},
              },
            });
          }
        }, platform);

        const orgRes = await page.request.post("/api/orgs", {
          data: {
            name: `Primary-Rail-Layout-${platform.expectedPlatform ?? "browser"}-${Date.now()}`,
          },
        });
        expect(orgRes.ok()).toBe(true);
        const organization = await orgRes.json() as { id: string; urlKey: string };

        await page.goto("/");
        await page.evaluate((orgId) => {
          window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
        }, organization.id);
        await page.goto(`/${organization.urlKey}/messenger`);

        const rail = page.getByTestId("primary-rail");
        const nav = rail.getByRole("navigation", { name: "Primary navigation" });
        if (platform.expectedPlatform) {
          await expect(rail).toHaveAttribute("data-desktop-platform", platform.expectedPlatform);
        } else {
          await expect(rail).not.toHaveAttribute("data-desktop-platform");
        }
        await expect(nav).toBeVisible();

        const navBox = await nav.boundingBox();
        expect(navBox).not.toBeNull();
        expect(navBox!.width).toBeGreaterThanOrEqual(61);

        for (const label of ["Messenger", "Organization", "Automations"]) {
          const item = nav.getByRole("link", { name: label, exact: true });
          await expect(item).toBeVisible();
          const textBox = await item.evaluate((element) => {
            const labelElement = element.lastElementChild;
            if (!labelElement?.textContent?.trim()) {
              throw new Error("Primary rail label element not found");
            }
            const range = document.createRange();
            range.selectNodeContents(labelElement);
            const rect = range.getBoundingClientRect();
            return { left: rect.left, right: rect.right };
          });
          expect(textBox.left).toBeGreaterThanOrEqual(navBox!.x - 0.5);
          expect(textBox.right).toBeLessThanOrEqual(navBox!.x + navBox!.width + 0.5);
        }

        await testInfo.attach(`primary-rail-labels-${platform.expectedPlatform ?? "browser"}`, {
          body: await page.screenshot({
            fullPage: true,
          }),
          contentType: "image/png",
        });
      },
    );
  }
});
