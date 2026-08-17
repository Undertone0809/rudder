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

async function createRuntimeNeutralVisualProcessStub() {
  const stubDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-e2e-inline-visual-v1-"));
  cleanupPaths.add(stubDirectory);
  const stubPath = path.join(stubDirectory, "runtime-neutral-inline-visual");
  await fs.writeFile(stubPath, `#!/usr/bin/env node
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  if (
    !prompt.includes(":::rudder-inline-visual:v1")
    || !prompt.includes(":::rudder-inline-visual:end")
    || !prompt.includes("Do not emit an iframe, file path, attachment id, or provider-specific directive")
    || prompt.includes("::codex-inline-vis")
  ) {
    throw new Error("Rudder runtime-neutral visual contract is missing from the Chat prompt");
  }
  const fragment = [
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
    '#widget .weekly-bars{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));align-items:end;gap:10px;min-height:142px;padding:6px 4px 0;border-bottom:1px solid var(--border)}',
    '#widget .week{display:grid;grid-template-rows:auto 1fr auto;align-items:end;gap:4px;height:136px;min-width:0;text-align:center}',
    '#widget .bar-track{display:flex;height:96px;align-items:end;justify-content:center}',
    '#widget .week-bar{width:min(48px,72%);min-height:10px;border-radius:4px 4px 0 0;background:var(--viz-series-1)}',
    '#widget .week-bar-jul-6{height:60%}',
    '#widget .week-bar-jul-13{height:80%}',
    '#widget .week-bar-jul-20{height:70%}',
    '#widget .week-bar-jul-27{height:100%}',
    '#widget .outcomes{display:grid;gap:9px}',
    '#widget .outcome-row{display:grid;gap:5px}',
    '#widget .outcome-label{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--muted-foreground);font-size:11px}',
    '#widget .outcome-track{height:6px;overflow:hidden;border-radius:999px;background:var(--muted)}',
    '#widget .outcome-fill{height:100%;border-radius:999px}',
    '#widget .outcome-completed{width:91%;background:var(--viz-series-1)}',
    '#widget .outcome-review{width:6%;background:var(--viz-series-2)}',
    '#widget .outcome-failed{width:3%;background:var(--destructive)}',
    '@media (max-width:560px){#widget .metric-grid{grid-template-columns:1fr}#widget .report-grid{grid-template-columns:1fr}}',
    '</style>',
    '<div id="widget">',
    '<header class="report-header"><div><span class="report-period">Jul 6 - Jul 27</span><h2 class="report-title">Execution health</h2></div><span class="viz-badge">On track</span></header>',
    '<section class="metric-grid" aria-label="Key agent operations metrics">',
    '<div class="metric"><span class="metric-label">Completed loops</span><strong id="completed-total" class="metric-value">93</strong><span class="metric-note metric-note-positive">+16 vs prior period</span></div>',
    '<div class="metric"><span class="metric-label">Success rate</span><strong id="success-rate" class="metric-value">91%</strong><span class="metric-note metric-note-positive">+4.2 points</span></div>',
    '<div class="metric"><span class="metric-label">Budget used</span><strong id="budget-used" class="metric-value">$4.6k</strong><span class="metric-note">77% of $6k</span></div>',
    '</section>',
    '<section class="report-grid">',
    '<figure><figcaption>Weekly completed loops</figcaption><div class="weekly-bars" role="img" aria-label="Weekly completed loops: Jul 6, 18; Jul 13, 24; Jul 20, 21; Jul 27, 30.">',
    '<div class="week"><strong>18</strong><div class="bar-track"><div class="week-bar week-bar-jul-6"></div></div><span>Jul 6</span></div>',
    '<div class="week"><strong>24</strong><div class="bar-track"><div class="week-bar week-bar-jul-13"></div></div><span>Jul 13</span></div>',
    '<div class="week"><strong>21</strong><div class="bar-track"><div class="week-bar week-bar-jul-20"></div></div><span>Jul 20</span></div>',
    '<div class="week"><strong>30</strong><div class="bar-track"><div class="week-bar week-bar-jul-27"></div></div><span>Jul 27</span></div>',
    '</div></figure>',
    '<section class="outcomes"><h3>Run outcomes</h3>',
    '<div class="outcome-row"><div class="outcome-label"><span>Completed</span><strong>91%</strong></div><div class="outcome-track"><div class="outcome-fill outcome-completed"></div></div></div>',
    '<div class="outcome-row"><div class="outcome-label"><span>Needs review</span><strong>6%</strong></div><div class="outcome-track"><div class="outcome-fill outcome-review"></div></div></div>',
    '<div class="outcome-row"><div class="outcome-label"><span>Failed</span><strong>3%</strong></div><div class="outcome-track"><div class="outcome-fill outcome-failed"></div></div></div>',
    '</section></section>',
    '<details><summary data-tooltip="Show methodology">Methodology</summary><p>Completed loops count only persisted final results.</p></details>',
    '</div>',
  ].join("");
  process.stdout.write([
    "RUDDER_RESULT_BEGIN",
    "Agent operations snapshot. Throughput is above target and the failure rate remains below 4%.",
    "",
    ":::rudder-inline-visual:v1",
    fragment,
    ":::rudder-inline-visual:end",
    "RUDDER_RESULT_END",
  ].join("\\n"));
});
`, "utf8");
  await fs.chmod(stubPath, 0o755);
  return stubPath;
}

test("runtime-neutral visual stays inside Chat and outside manifest and Library", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const darkScreenshotPath = process.env.RUDDER_INLINE_VIS_DARK_SCREENSHOT?.trim();
  await page.addInitScript(() => {
    Object.defineProperty(window, "__rudderCopiedImage", {
      configurable: true,
      value: null,
      writable: true,
    });
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: {
        copyImage: async (payload: { filename: string; contentType: string; base64: string }) => {
          (window as typeof window & { __rudderCopiedImage: typeof payload | null }).__rudderCopiedImage = payload;
        },
      },
    });
    if (window.location.origin !== "null" && window.localStorage.getItem("rudder.captureInlineVisualDark") === "true") {
      window.localStorage.setItem("rudder.theme", "dark");
    }
  });
  if (darkScreenshotPath) {
    await page.addInitScript(() => {
      window.localStorage.setItem("rudder.captureInlineVisualDark", "true");
    });
  }
  const stubPath = await createRuntimeNeutralVisualProcessStub();
  const orgResponse = await page.request.post("/api/orgs", {
    data: { name: `Inline-Visual-V1-${Date.now()}` },
  });
  expect(orgResponse.ok()).toBe(true);
  const organization = await orgResponse.json() as { id: string; issuePrefix: string };
  const libraryBeforeResponse = await page.request.get(`/api/orgs/${organization.id}/library/documents`);
  expect(libraryBeforeResponse.ok()).toBe(true);
  const libraryBefore = await libraryBeforeResponse.json();
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: "Runtime-neutral Operations Analyst",
    agentRuntimeType: "process",
    agentRuntimeConfig: {
      command: stubPath,
      timeoutSec: 30,
    },
  }) as { id: string };

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.issuePrefix}/messenger/chat?agentId=${agent.id}`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.fill("Show agent operations health for the last four weeks");
  await page.getByRole("button", { name: "Send" }).click();

  const assistant = page.getByTestId("chat-assistant-message").last();
  await expect(assistant).toContainText("Agent operations snapshot.", { timeout: 20_000 });
  await expect(assistant).not.toContainText("::rudder-inline-vis");
  await expect(assistant).not.toContainText("inline-visual-1.html");
  const iframe = assistant.locator("iframe");
  await expect(iframe).toHaveAttribute("sandbox", "allow-same-origin");
  await expect(iframe).not.toHaveAttribute("sandbox", /allow-scripts/);
  const frame = iframe.contentFrame();
  await expect(frame.locator("#completed-total")).toHaveText("93", { timeout: 15_000 });
  await expect(frame.locator("#success-rate")).toHaveText("91%");
  await expect(frame.locator("#budget-used")).toHaveText("$4.6k");
  await expect(frame.getByRole("img", { name: "Weekly completed loops: Jul 6, 18; Jul 13, 24; Jul 20, 21; Jul 27, 30." })).toBeVisible();
  await expect(frame.locator("script, link, img, iframe, object, form, input, button, a")).toHaveCount(0);

  const visual = assistant.locator(".rudder-inline-visual");
  const prose = assistant.locator(".rudder-markdown > p").first();
  await expect.poll(async () => {
    const visualBox = await visual.boundingBox();
    const proseBox = await prose.boundingBox();
    return visualBox && proseBox ? visualBox.width - proseBox.width : 0;
  }).toBeGreaterThan(150);

  await visual.hover();
  const visualActions = visual.getByTestId("inline-visual-actions");
  const previewButton = visualActions.getByRole("button", { name: "Open image preview" });
  const copyButton = visualActions.getByRole("button", { name: "Copy Image" });
  await expect(previewButton).toBeVisible();
  await expect(copyButton).toBeVisible();
  const collapsedHeight = await iframe.evaluate((element) => element.clientHeight);
  await frame.locator("summary").click();
  await expect(frame.locator("details")).toHaveAttribute("open", "");
  await expect.poll(() => iframe.evaluate((element) => element.clientHeight)).toBeGreaterThan(collapsedHeight);
  const expandedSize = await iframe.evaluate((element) => ({
    height: element.clientHeight,
    width: element.clientWidth,
  }));
  await previewButton.focus();
  await expect(previewButton).toBeFocused();
  await expect(visualActions).toBeVisible();
  await previewButton.press("Enter");
  const preview = page.getByTestId("inline-visual-image-preview-dialog");
  await expect(preview).toBeVisible();
  const previewImage = preview.locator("img");
  await expect(previewImage).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect.poll(() => previewImage.evaluate((image) => (
    image.naturalHeight > 0 && image.naturalWidth > 0
  ))).toBe(true);
  const previewSize = await previewImage.evaluate((image) => ({
    height: image.naturalHeight,
    width: image.naturalWidth,
  }));
  expect(previewSize.height).toBeGreaterThanOrEqual(expandedSize.height);
  expect(previewSize.height).toBeLessThanOrEqual(expandedSize.height * 2 + 2);
  expect(previewSize.width).toBeGreaterThanOrEqual(expandedSize.width);
  expect(previewSize.width).toBeLessThanOrEqual(expandedSize.width * 2 + 2);
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await expect(frame.locator("details")).toHaveAttribute("open", "");

  await copyButton.focus();
  await expect(copyButton).toBeFocused();
  await copyButton.press("Space");
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & {
      __rudderCopiedImage?: { filename: string; contentType: string; base64: string } | null;
    }
  ).__rudderCopiedImage)).toMatchObject({
    filename: "inline-visual-1.png",
    contentType: "image/png",
  });

  const chatId = new URL(page.url()).pathname.split("/").pop()!;
  const messagesResponse = await page.request.get(`/api/chats/${chatId}/messages?includeTranscript=true`);
  expect(messagesResponse.ok()).toBe(true);
  const persistedMessages = await messagesResponse.json() as Array<{
    id: string;
    role: string;
    body: string;
    structuredPayload: Record<string, unknown> | null;
    attachments: Array<{
      id: string;
      messageId: string;
      assetId: string;
      contentType: string;
      provider?: unknown;
      objectKey?: unknown;
    }>;
    transcript?: unknown[];
  }>;
  const persistedAssistant = persistedMessages.find((message) => message.role === "assistant")!;
  expect(persistedAssistant.body).toBe('Agent operations snapshot. Throughput is above target and the failure rate remains below 4%.\n\n::rudder-inline-vis{slot="0"}');
  expect(persistedAssistant).toMatchObject({
    structuredPayload: {
      inlineVisualsV1: [{
        version: 1,
        slot: 0,
        file: "inline-visual-1.html",
        status: "ready",
        attachmentId: expect.any(String),
        contentType: "text/html",
        byteSize: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }],
    },
    attachments: [expect.objectContaining({ contentType: "text/html" })],
  });
  expect(persistedAssistant.attachments[0]?.provider).toBeUndefined();
  expect(persistedAssistant.attachments[0]?.objectKey).toBeUndefined();
  expect(JSON.stringify(persistedMessages)).not.toContain('<div id="widget"');
  expect(JSON.stringify(persistedMessages)).not.toContain(":::rudder-inline-visual:v1");

  const manifestResponse = await page.request.get(`/api/chats/${chatId}/work-manifest`);
  expect(manifestResponse.ok()).toBe(true);
  expect(await manifestResponse.json()).toMatchObject({
    totalCount: 0,
    outputs: [],
    sources: [],
    references: [],
  });
  const workManifestPanel = page.getByTestId("chat-work-manifest-wide-panel");
  await expect(workManifestPanel).toHaveCount(0);
  await expect(page.getByText("inline-visual-1.html", { exact: true })).toHaveCount(0);

  const libraryAfterResponse = await page.request.get(`/api/orgs/${organization.id}/library/documents`);
  expect(libraryAfterResponse.ok()).toBe(true);
  expect(await libraryAfterResponse.json()).toEqual(libraryBefore);

  await page.reload();
  const reopenedAssistant = page.getByTestId("chat-assistant-message").last();
  const reopenedFrame = reopenedAssistant.locator("iframe").contentFrame();
  await expect(reopenedFrame.locator("#completed-total")).toHaveText("93", { timeout: 15_000 });
  await expect(reopenedAssistant).not.toContainText("inline-visual-1.html");

  const screenshotPath = process.env.RUDDER_INLINE_VIS_SCREENSHOT?.trim();
  if (screenshotPath) {
    await reopenedAssistant.scrollIntoViewIfNeeded();
    await page.screenshot({ path: screenshotPath, fullPage: false, animations: "disabled" });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(reopenedAssistant).toBeVisible();
  await expect(reopenedAssistant.getByTestId("inline-visual-actions")).toBeVisible();
  await expect.poll(() => reopenedFrame.locator(".report-grid").evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length
  )).toBe(1);
  if (screenshotPath) {
    await page.screenshot({
      path: screenshotPath.replace(/\.png$/i, "-mobile.png"),
      fullPage: false,
      animations: "disabled",
    });
  }
  if (darkScreenshotPath) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => window.localStorage.setItem("rudder.theme", "dark"));
    await page.reload();
    const darkAssistant = page.getByTestId("chat-assistant-message").last();
    await expect(darkAssistant.locator("iframe").contentFrame().locator("#completed-total")).toHaveText("93", { timeout: 15_000 });
    await darkAssistant.scrollIntoViewIfNeeded();
    await page.screenshot({ path: darkScreenshotPath, fullPage: false, animations: "disabled" });
  }

  await page.setViewportSize({ width: 1280, height: 720 });
  const firstForkResponse = await page.request.post(`/api/chats/${chatId}/fork`, {
    data: { sourceMessageId: persistedAssistant.id, title: "Visual fork" },
  });
  expect(firstForkResponse.ok()).toBe(true);
  const firstFork = await firstForkResponse.json() as { id: string };
  const forkManifestResponse = await page.request.get(`/api/chats/${firstFork.id}/work-manifest`);
  expect(forkManifestResponse.ok()).toBe(true);
  expect(await forkManifestResponse.json()).toMatchObject({ totalCount: 0, outputs: [] });
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${firstFork.id}`);
  const forkedAssistant = page.getByTestId("chat-assistant-message").filter({
    hasText: "Agent operations snapshot.",
  }).last();
  await expect(forkedAssistant.locator("iframe").contentFrame().locator("#completed-total"))
    .toHaveText("93", { timeout: 15_000 });

  const deleteForkResponse = await page.request.delete(`/api/chats/${firstFork.id}`);
  expect(deleteForkResponse.ok()).toBe(true);
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chatId}`);
  await expect(page.getByTestId("chat-assistant-message").last().locator("iframe").contentFrame().locator("#completed-total"))
    .toHaveText("93", { timeout: 15_000 });

  const secondForkResponse = await page.request.post(`/api/chats/${chatId}/fork`, {
    data: { sourceMessageId: persistedAssistant.id, title: "Visual durability fork" },
  });
  expect(secondForkResponse.ok()).toBe(true);
  const secondFork = await secondForkResponse.json() as { id: string };
  const deleteSourceResponse = await page.request.delete(`/api/chats/${chatId}`);
  expect(deleteSourceResponse.ok()).toBe(true);
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${secondFork.id}`);
  await expect(page.getByTestId("chat-assistant-message").last().locator("iframe").contentFrame().locator("#completed-total"))
    .toHaveText("93", { timeout: 15_000 });
});
