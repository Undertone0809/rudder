import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { KeyboardShortcutSettings } from "@rudderhq/shared";

async function resetShortcutSettings(page: Page) {
  const resetRes = await page.request.patch("/api/instance/settings/shortcuts", {
    data: { shortcuts: [] },
  });
  expect(resetRes.ok()).toBe(true);
  const readback = await getShortcutSettings(page);
  expect(readback.shortcuts).toEqual([]);
}

async function getShortcutSettings(page: Page): Promise<KeyboardShortcutSettings> {
  const res = await page.request.get("/api/instance/settings/shortcuts");
  expect(res.ok()).toBe(true);
  return await res.json() as KeyboardShortcutSettings;
}

async function gotoDashboardReady(page: Page, issuePrefix: string) {
  const shortcutsReady = page.waitForResponse((response) =>
    response.request().method() === "GET"
    && response.url().includes("/api/instance/settings/shortcuts")
    && response.ok(),
  );

  await page.goto(`/${issuePrefix}/dashboard`);
  await expect(page).toHaveURL(new RegExp(`/${issuePrefix}/dashboard$`));
  await shortcutsReady;
  await expect(page.getByRole("button", { name: "Create", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "System settings" })).toBeVisible();
  await expect(page.locator('[data-shortcut-settings-ready="true"]')).toBeVisible();
}

async function dispatchShortcut(
  page: Page,
  shortcut: { key: string; init: KeyboardEventInit },
) {
  return await page.evaluate(({ key, init }) => {
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  }, shortcut);
}

function getCandidateNewIssueShortcuts() {
  return [
    { key: "n", init: { code: "KeyN", metaKey: true } },
    { key: "n", init: { code: "KeyN", ctrlKey: true } },
  ];
}

function getCandidateNewChatShortcuts() {
  return [
    { key: "s", init: { code: "KeyS", metaKey: true, altKey: true } },
    { key: "s", init: { code: "KeyS", ctrlKey: true, altKey: true } },
  ];
}

async function dispatchFirstHandledShortcut<T extends { key: string; init: KeyboardEventInit }>(
  page: Page,
  shortcuts: T[],
) {
  for (const shortcut of shortcuts) {
    if (await dispatchShortcut(page, shortcut)) return shortcut;
  }
  return null;
}

test.describe("Global create shortcuts", () => {
  test.describe.configure({ mode: "serial" });

  test("opens the new issue dialog with the platform default modifier+N", async ({ page }) => {
    await resetShortcutSettings(page);
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `New Issue Shortcut ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    await gotoDashboardReady(page, organization.issuePrefix);
    const shortcut = await dispatchFirstHandledShortcut(page, getCandidateNewIssueShortcuts());
    expect(shortcut).not.toBeNull();

    const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByPlaceholder("Issue title")).toBeFocused();
  });

  test("does not open the new issue dialog from the removed single-key C shortcut", async ({ page }) => {
    await resetShortcutSettings(page);
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Removed C Shortcut ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    await gotoDashboardReady(page, organization.issuePrefix);
    expect(await getShortcutSettings(page)).toEqual({ shortcuts: [] });

    expect(await dispatchShortcut(page, { key: "c", init: {} })).toBe(false);
    await expect(page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") })).toHaveCount(0);

    const shortcut = await dispatchFirstHandledShortcut(page, getCandidateNewIssueShortcuts());
    expect(shortcut).not.toBeNull();
    const dialog = page.locator('[data-slot="dialog-content"]').filter({ has: page.getByText("New issue") }).first();
    await expect(dialog).toBeVisible();
  });

  test("creates and opens a new chat with the platform default modifier+Alt+S", async ({ page }) => {
    await resetShortcutSettings(page);
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `New Chat Shortcut ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    await gotoDashboardReady(page, organization.issuePrefix);
    const createChatResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes("/api/orgs/")
      && response.url().includes("/chats")
      && response.ok(),
    );

    const shortcut = await dispatchFirstHandledShortcut(page, getCandidateNewChatShortcuts());
    expect(shortcut).not.toBeNull();
    const chat = await (await createChatResponse).json() as { id: string; title: string };

    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/messenger/chat/${chat.id}$`));
    await expect(page.getByText("No messages yet. Start by describing the work and Rudder will clarify it first.")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "editable markdown" })).toBeVisible();
    await expect(page.getByRole("link", { name: /New chat just now/ })).toHaveAttribute(
      "href",
      new RegExp(`/${organization.issuePrefix}/messenger/chat/${chat.id}$`),
    );
  });

  test("creates a new chat with modifier+Alt+S when legacy chat shortcuts are persisted", async ({ page }) => {
    const legacyRes = await page.request.patch("/api/instance/settings/shortcuts", {
      data: {
        shortcuts: [
          {
            actionId: "chat.create",
            bindings: [
              { key: "n", metaKey: true },
              { key: "o", metaKey: true, shiftKey: true },
            ],
          },
        ],
      },
    });
    expect(legacyRes.ok()).toBe(true);
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `Legacy New Chat Shortcut ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { issuePrefix: string };

    await gotoDashboardReady(page, organization.issuePrefix);
    const createChatResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes("/api/orgs/")
      && response.url().includes("/chats")
      && response.ok(),
    );

    const shortcut = await dispatchFirstHandledShortcut(page, getCandidateNewChatShortcuts());
    expect(shortcut).not.toBeNull();
    const chat = await (await createChatResponse).json() as { id: string };

    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/messenger/chat/${chat.id}$`));
  });
});
