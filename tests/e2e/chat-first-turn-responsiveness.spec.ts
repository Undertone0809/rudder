import { expect, test, type Page, type Request } from "@playwright/test";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB } from "./support/e2e-env";

type WireEvent = {
  type: string;
  conversation?: { id: string };
};

type ObservedWindow = Window & { firstTurnWireEvents: WireEvent[] };

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

/** Observe a clone of the real NDJSON response, without replacing ack or output. */
async function observeFirstTurn(page: Page, orgId: string) {
  await page.addInitScript((path) => {
    const observed = window as ObservedWindow;
    observed.firstTurnWireEvents = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (new URL(response.url).pathname === path && response.ok) {
        const reader = response.clone().body!.getReader();
        void (async () => {
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const { value, done } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            if (done && buffer.trim()) lines.push(buffer);
            for (const line of lines) {
              if (line.trim()) observed.firstTurnWireEvents.push(JSON.parse(line));
            }
            if (done) break;
          }
        })().catch(() => undefined); // Browser teardown may abort the observer.
      }
      return response;
    };
  }, `/api/orgs/${orgId}/chats/messages/stream`);
}

async function wireEvents(page: Page) {
  return page.evaluate(() => (window as ObservedWindow).firstTurnWireEvents);
}

async function createFixture(page: Page, suffix: string) {
  const orgResponse = await page.request.post("/api/orgs", {
    data: { name: `First-turn-responsiveness-${suffix}-${Date.now()}` },
  });
  expect(orgResponse.ok()).toBe(true);
  const organization = await orgResponse.json();
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: "Responsiveness Agent",
    command: E2E_CODEX_STUB,
  });
  const existingResponse = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Existing conversation stays selected",
      preferredAgentId: agent.id,
      issueCreationMode: "manual_approval",
      planMode: false,
      initialMessage: { body: "This is the existing conversation." },
    },
  });
  expect(existingResponse.ok(), await existingResponse.text()).toBe(true);
  const existing = await existingResponse.json();
  await observeFirstTurn(page, organization.id);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.issuePrefix}/messenger/chat?agentId=${agent.id}`);
  await expect(page.locator(".rudder-mdxeditor-content").first()).toBeVisible({ timeout: 20_000 });
  const existingLink = page.locator(`a[href$="/messenger/chat/${existing.id}"]`).first();
  await expect(existingLink).toBeVisible({ timeout: 15_000 });
  return { organization, existing, existingLink };
}

/** Gate only real sidebar GETs, after initial data is already on screen. */
async function holdSidebar(page: Page, orgId: string, kind: "lists" | "groups" | "both") {
  const gate = deferred();
  const held: string[] = [];
  const heldRequests = new Set<Request>();
  let released = false;
  let completed = 0;
  const matches = (url: URL) => {
    const base = `/api/orgs/${orgId}`;
    return (kind !== "groups" && [
      `${base}/chats`, `${base}/messenger/threads`,
    ].includes(url.pathname)) || (kind !== "lists" && url.pathname === `${base}/messenger/groups`);
  };
  await page.route(matches, async (route) => {
    if (route.request().method() === "GET" && !released) {
      held.push(route.request().url());
      heldRequests.add(route.request());
      await gate.promise;
    }
    await route.continue();
  });
  page.on("response", (response) => {
    if (heldRequests.has(response.request())) completed += 1;
  });
  return {
    held,
    isReleased: () => released,
    completed: () => completed,
    release: () => { released = true; gate.release(); },
    dispose: async () => {
      released = true;
      gate.release();
      await page.unrouteAll({ behavior: "wait" });
    },
  };
}

async function acceptedChatId(page: Page) {
  await expect.poll(async () => (await wireEvents(page)).some((event) => event.type === "ack"), {
    message: "the real first-turn stream must acknowledge the persisted chat",
    timeout: 15_000,
  }).toBe(true);
  const ack = (await wireEvents(page)).find((event) => event.type === "ack");
  expect(ack?.conversation?.id).toBeTruthy();
  return ack!.conversation!.id;
}

async function assertPersistedTurn(page: Page, chatId: string, body: string) {
  const response = await page.request.get(`/api/chats/${chatId}/messages`);
  expect(response.ok()).toBe(true);
  const messages = await response.json() as Array<{ role: string; body: string }>;
  expect(messages.filter((message) => message.role === "user" && message.body === body)).toHaveLength(1);
}

for (const kind of ["lists", "groups"] as const) {
  test(`accepted first chat navigates and renders stream progress while sidebar ${kind} GETs are held`, async ({ page }, testInfo) => {
    const { organization } = await createFixture(page, kind);
    const sidebar = await holdSidebar(page, organization.id, kind);
    const cdp = kind === "lists" ? await page.context().newCDPSession(page) : null;
    // Exercise a slow renderer without making startup/module compilation the benchmark.
    if (cdp) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const body = `Accepted turn must not wait for sidebar ${kind}`;
    try {
      await page.locator(".rudder-mdxeditor-content").first().fill(body);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const chatId = await acceptedChatId(page);
      await expect.poll(() => sidebar.held.length, { timeout: 10_000 }).toBeGreaterThan(0);
      await assertPersistedTurn(page, chatId, body);
      await expect.poll(async () => (await wireEvents(page)).some((event) =>
        event.type === "assistant_delta" || event.type === "transcript_entry"), {
        message: "real runtime progress must reach the browser independently of sidebar GETs",
        timeout: 15_000,
      }).toBe(true);

      // Soft assertions collect both symptoms of the same blocked acknowledgement.
      await expect.soft(page, "accepted conversation navigation must not await sidebar refresh").toHaveURL(
        new RegExp(`/messenger/chat/${chatId}$`), { timeout: 3_000 },
      );
      await expect.soft(page.getByTestId("chat-user-message-bubble").filter({ hasText: body })).toHaveCount(1, {
        timeout: 2_000,
      });
      await expect.soft(page.getByTestId("chat-main-workspace-card"),
        "received assistant progress must render while sidebar GETs remain blocked").toContainText("Streaming reply", {
        timeout: 3_000,
      });
      expect(sidebar.isReleased()).toBe(false);
      expect(sidebar.completed()).toBe(0);
      await page.screenshot({ path: testInfo.outputPath(`sidebar-${kind}-held.png`), fullPage: true });
      await testInfo.attach("held-sidebar-wire-evidence", {
        body: JSON.stringify({ url: page.url(), held: sidebar.held, events: await wireEvents(page), cpuRate: cdp ? 4 : 1 }),
        contentType: "application/json",
      });

      sidebar.release();
      await expect(page).toHaveURL(new RegExp(`/messenger/chat/${chatId}$`), { timeout: 15_000 });
      await expect(page.getByTestId("chat-assistant-message").last()).toContainText("Streaming reply for chat.", {
        timeout: 30_000,
      });
      await assertPersistedTurn(page, chatId, body);
    } finally {
      await sidebar.dispose();
      if (cdp) { await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }); await cdp.detach(); }
    }
  });
}

test("selecting an existing conversation before first ack is not stolen by late ack or sidebar completion", async ({ page }, testInfo) => {
  const { organization, existing, existingLink } = await createFixture(page, "navigation");
  const streamGate = deferred();
  let streamReached = false;
  const streamPath = `**/api/orgs/${organization.id}/chats/messages/stream`;
  await page.route(streamPath, async (route) => {
    streamReached = true;
    await streamGate.promise;
    await route.continue();
  });
  const sidebar = await holdSidebar(page, organization.id, "both");
  const body = "Finish this turn without taking me away from my selected conversation";
  try {
    await page.locator(".rudder-mdxeditor-content").first().fill(body);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => streamReached).toBe(true);
    await expect(page.getByTestId("chat-pending-first-turn")).toContainText(body);
    expect((await wireEvents(page)).some((event) => event.type === "ack")).toBe(false);
    // A real SPA link keeps the in-flight component callback alive, unlike page.goto.
    await existingLink.click();
    const selectedUrl = page.url();
    expect(selectedUrl).toMatch(new RegExp(`/messenger/chat/${existing.id}$`));
    await expect(page.locator(".rudder-mdxeditor-content").first()).toBeVisible();
    const nextDraft = "Keep the draft I typed after switching conversations";
    await page.locator(".rudder-mdxeditor-content").first().fill(nextDraft);
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
    streamGate.release();
    const acceptedId = await acceptedChatId(page);
    expect(acceptedId).not.toBe(existing.id);
    await expect.poll(() => sidebar.held.length).toBeGreaterThan(0);
    await assertPersistedTurn(page, acceptedId, body);
    await expect.poll(async () => (await wireEvents(page)).some((event) => event.type === "final"), {
      timeout: 30_000,
    }).toBe(true);
    await expect.soft(page, "late acknowledgement must preserve the user's selected chat").toHaveURL(selectedUrl);
    await page.screenshot({ path: testInfo.outputPath("existing-chat-before-sidebar-release.png"), fullPage: true });
    sidebar.release();
    await expect.poll(() => sidebar.completed(), { timeout: 15_000 }).toBeGreaterThan(0);
    // Observe the callback continuation, not an immediate URL assertion that passes before it runs.
    await page.waitForTimeout(2_000);
    await expect.soft(page, "sidebar completion must never navigate back to the background accepted chat").toHaveURL(selectedUrl);
    await expect(page.locator(".rudder-mdxeditor-content").first()).toContainText(nextDraft);
    expect.soft(navigations.filter((url) => url !== selectedUrl), "no transient route theft after explicit selection").toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("existing-chat-after-sidebar-release.png"), fullPage: true });
    await testInfo.attach("late-ack-navigation-evidence", {
      body: JSON.stringify({ selectedUrl, acceptedId, finalUrl: page.url(), navigations, held: sidebar.held, events: await wireEvents(page) }),
      contentType: "application/json",
    });
    await assertPersistedTurn(page, acceptedId, body);
  } finally {
    streamGate.release();
    await sidebar.dispose();
    await page.unroute(streamPath);
  }
});
