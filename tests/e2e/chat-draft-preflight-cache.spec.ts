import { expect, test } from "@playwright/test";
import { E2E_CODEX_STUB } from "./support/e2e-env";

test("keeps new-chat preflight silent and reuses it after leaving Messenger", async ({ page }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Chat-Preflight-Cache-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const agentRes = await page.request.post(`/api/orgs/${organization.id}/agents`, {
    data: {
      name: "Cached Chat Agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        model: "gpt-5.4",
        command: E2E_CODEX_STUB,
      },
    },
  });
  expect(agentRes.ok()).toBe(true);

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);

  let releasePreflight!: () => void;
  const preflightGate = new Promise<void>((resolve) => {
    releasePreflight = resolve;
  });
  let signalPreflightStarted!: () => void;
  const preflightStarted = new Promise<void>((resolve) => {
    signalPreflightStarted = resolve;
  });
  let preflightRequestCount = 0;
  await page.route("**/api/orgs/*/chats/preflight", async (route) => {
    preflightRequestCount += 1;
    signalPreflightStarted();
    const response = await route.fetch();
    await preflightGate;
    await route.fulfill({ response });
  });

  await page.goto(`/${organization.issuePrefix}/messenger/chat`);
  await preflightStarted;

  await expect(page.locator(".rudder-mdxeditor-content").first()).toBeVisible();
  await expect(page.getByText("Checking the selected chat configuration.")).toHaveCount(0);
  await expect(page.locator(".chat-warning")).toHaveCount(0);

  const preflightComplete = page.waitForResponse((response) =>
    response.request().method() === "POST"
      && response.url().includes(`/api/orgs/${organization.id}/chats/preflight`),
  );
  releasePreflight();
  await preflightComplete;

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await composer.fill("Keep this draft while checking the cache");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();

  const primaryRail = page.getByTestId("primary-rail");
  await primaryRail.getByRole("link", { name: "Agents" }).click();
  await expect(page).toHaveURL(/\/agents(?:\/.*)?$/);
  await primaryRail.getByRole("link", { name: "Messenger" }).click();
  await expect(page).toHaveURL(/\/messenger\/chat$/);
  await expect(composer).toHaveText("Keep this draft while checking the cache");
  await page.waitForTimeout(250);

  expect(preflightRequestCount).toBe(1);
  await expect(page.getByText("Checking the selected chat configuration.")).toHaveCount(0);
  await expect(page.locator(".chat-warning")).toHaveCount(0);
});
