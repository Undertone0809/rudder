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

async function expectNoChatConversations(page: Page, orgId: string) {
  const chatsRes = await page.request.get(`/api/orgs/${orgId}/chats?status=active&limit=40`);
  expect(chatsRes.ok()).toBe(true);
  expect(await chatsRes.json()).toEqual([]);

  const allChatsRes = await page.request.get(`/api/orgs/${orgId}/chats?status=all&limit=40`);
  expect(allChatsRes.ok()).toBe(true);
  expect(await allChatsRes.json()).toEqual([]);
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

  test("opens the new chat composer with the platform default modifier+Alt+S without creating a chat", async ({ page }) => {
    await resetShortcutSettings(page);
    const orgRes = await page.request.post("/api/orgs", {
      data: {
        name: `New Chat Shortcut ${Date.now()}`,
      },
    });
    expect(orgRes.ok()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    await gotoDashboardReady(page, organization.issuePrefix);
    const chatCreateRequests: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST"
        && request.url().includes("/api/orgs/")
        && request.url().includes("/chats")
      ) {
        chatCreateRequests.push(request.url());
      }
    });

    const shortcut = await dispatchFirstHandledShortcut(page, getCandidateNewChatShortcuts());
    expect(shortcut).not.toBeNull();

    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/messenger/chat$`));
    await expect(page.getByRole("heading", { name: /What can I help with/i })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "editable markdown" })).toBeVisible();
    await expect(page.getByRole("link", { name: "New chat" })).toHaveAttribute(
      "href",
      new RegExp(`/${organization.issuePrefix}/messenger/chat$`),
    );
    await page.waitForTimeout(250);
    expect(chatCreateRequests).toEqual([]);
    await expectNoChatConversations(page, organization.id);
  });

  test("opens the new chat composer with modifier+Alt+S when legacy chat shortcuts are persisted", async ({ page }) => {
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
    const organization = await orgRes.json() as { id: string; issuePrefix: string };

    await gotoDashboardReady(page, organization.issuePrefix);
    const chatCreateRequests: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST"
        && request.url().includes("/api/orgs/")
        && request.url().includes("/chats")
      ) {
        chatCreateRequests.push(request.url());
      }
    });

    const shortcut = await dispatchFirstHandledShortcut(page, getCandidateNewChatShortcuts());
    expect(shortcut).not.toBeNull();

    await expect(page).toHaveURL(new RegExp(`/${organization.issuePrefix}/messenger/chat$`));
    await expect(page.getByRole("textbox", { name: "editable markdown" })).toBeVisible();
    await page.waitForTimeout(250);
    expect(chatCreateRequests).toEqual([]);
    await expectNoChatConversations(page, organization.id);
  });
});
