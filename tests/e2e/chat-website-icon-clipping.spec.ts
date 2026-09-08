import { expect, test, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatConversations, chatMessages, createDb } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

// Visibility alone passes for a decoded image outside an overflow:hidden link.
async function expectIconInsideLink(link: Locator) {
  const icon = link.locator(".rudder-website-link-icon");
  const isUnavailable = (await link.getAttribute("href"))?.includes("icon-clipping-failure");
  await expect(icon).toHaveAttribute("data-website-icon", isUnavailable ? "generic" : "metadata");
  await expect(icon).toBeVisible();
  const image = icon.locator("img");
  if (await image.count()) {
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  }
  const geometry = await icon.evaluate((element) => {
    const glyph = element.querySelector("img, svg")!;
    const glyphRect = glyph.getBoundingClientRect();
    const hostRect = element.getBoundingClientRect();
    const linkRect = element.closest("a")!.getBoundingClientRect();
    return {
      hostDelta: Math.abs(glyphRect.top - hostRect.top),
      clippedTop: linkRect.top - glyphRect.top,
      clippedBottom: glyphRect.bottom - linkRect.bottom,
      clippedLeft: linkRect.left - glyphRect.left,
      clippedRight: glyphRect.right - linkRect.right,
    };
  });
  expect(geometry.hostDelta).toBeLessThanOrEqual(1);
  expect(geometry.clippedTop).toBeLessThanOrEqual(1);
  expect(geometry.clippedBottom).toBeLessThanOrEqual(1);
  expect(geometry.clippedLeft).toBeLessThanOrEqual(1);
  expect(geometry.clippedRight).toBeLessThanOrEqual(1);
}

for (const theme of ["dark", "light"] as const) {
  test(`keeps website logos inside chat markdown links in ${theme} theme`, async ({ page }) => {
    const orgRes = await page.request.post("/api/orgs", {
      data: { name: `Website icon regression ${randomUUID()}` },
    });
    expect(orgRes.ok(), await orgRes.text()).toBe(true);
    const organization = await orgRes.json() as { id: string; issuePrefix: string };
    const agent = await createE2EChatAgent(page.request, organization.id, { name: "Noah" });
    // Seed completed conversation history without launching a paid agent run.
    const [chat] = await e2eDb.insert(chatConversations).values({
      orgId: organization.id,
      title: "Daily new · Website icon regression",
      preferredAgentId: agent.id,
      status: "active",
      messengerVisible: true,
    }).returning();
    const body = [
      "## 产品动态（网站图标回归样例）",
      "",
      "- **Codex：** 版本更新说明；[GitHub Releases](https://github.com/openai/codex/releases)。",
      "- **网站图标：** [Changelog](https://icon-clipping.example.test/changelog) 应显示网站图标。",
      "- **加载失败：** [Unavailable website](https://icon-clipping-failure.example.test/) 应显示地球兜底。",
      "",
      "## 指定 X 账号",
      "",
      "- [@thsottiaux](https://x.com/thsottiaux)：订阅用量更新。",
      "- [@papercliping](https://x.com/papercliping)：产品发布动态。",
      "- [@dotta](https://x.com/dotta)：技能安全与质量。",
      "- [@merlindotcom_](https://x.com/merlindotcom_)：稳定性反馈。",
    ].join("\n");
    await e2eDb.insert(chatMessages).values([
      { orgId: organization.id, conversationId: chat.id, role: "user", status: "completed", body: "请检查 [GitHub](https://github.com/openai/codex) 和 [X](https://x.com/papercliping) 的网站图标。", createdAt: new Date("2026-09-08T00:00:00Z") },
      { orgId: organization.id, conversationId: chat.id, role: "assistant", replyingAgentId: agent.id, status: "completed", body, createdAt: new Date("2026-09-08T00:00:01Z") },
    ]);
    await page.route("**/api/website-metadata?**", async (route) => {
      const url = new URL(route.request().url()).searchParams.get("url")!;
      if (url.includes("icon-clipping-failure")) {
        await route.fulfill({ status: 503, body: "Unavailable" });
      } else {
        await route.fulfill({ json: { url, siteName: "Regression fixture", iconUrl: "/api/website-metadata/icon?url=https%3A%2F%2Ficon-clipping.example.test%2Ffavicon.svg" } });
      }
    });
    await page.route("**/api/website-metadata/icon?**", (route) => route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#16a085"/><path d="M4 8h8M8 4v8" stroke="white" stroke-width="2"/></svg>',
    }));
    await page.goto("/");
    await page.evaluate(({ orgId, theme }) => {
      localStorage.setItem("rudder.selectedOrganizationId", orgId);
      localStorage.setItem("rudder.theme", theme);
    }, { orgId: organization.id, theme });
    const chatPath = `/${organization.issuePrefix}/messenger/chat/${chat.id}`;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(chatPath);

    await expect(page.locator("html")).toHaveCSS("color-scheme", theme);
    const links = page.locator("a.rudder-website-link");
    await expect(links).toHaveCount(9);
    for (const link of await links.all()) await expectIconInsideLink(link);
    await expect(links.filter({ hasText: "Unavailable website" }).locator('[data-website-icon="generic"]')).toBeVisible();
    await page.screenshot({ path: `/tmp/rudder-website-icon-chat-${theme}.png` });

    await page.reload();
    await page.setViewportSize({ width: 720, height: 1000 });
    await expect(links).toHaveCount(9);
    for (const link of await links.all()) await expectIconInsideLink(link);
    await page.screenshot({ path: `/tmp/rudder-website-icon-chat-${theme}-constrained.png` });
  });
}
