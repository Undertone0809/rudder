import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { E2E_BASE_URL, E2E_DATABASE_URL } from "./support/e2e-env";
import { resolveE2EOrganizationWorkspaceRoot } from "./support/organization-storage";

const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X5p1sAAAAASUVORK5CYII=",
  "base64",
);

function createSimplePdf() {
  const stream = "BT /F1 18 Tf 36 96 Td (Rudder PDF preview) Tj /F1 10 Tf 0 -24 Td (Rendered in Library.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "utf8"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, "utf8");
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer << /Root 1 0 R /Size ${objects.length + 1} >>\n`;
  body += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "utf8");
}

const resolveOrganizationWorkspaceRoot = resolveE2EOrganizationWorkspaceRoot;
const e2eDb = createDb(E2E_DATABASE_URL);

function uniqueIssuePrefix(prefix: string) {
  return `${prefix}${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
}

async function selectOrganization(page: Page, orgId: string) {
  await page.goto("/");
  await page.evaluate((selectedOrgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", selectedOrgId);
  }, orgId);
}

test.describe("Organization workspaces image preview", () => {
  test("aligns the Library sidebar and active editor tab top edges", async ({ page, request }) => {
    await page.setViewportSize({ width: 1280, height: 800 });

    const organizationRes = await request.post("/api/orgs", {
      data: {
        name: `Organization-Workspaces-Chrome-Alignment-${Date.now()}`,
      },
    });
    expect(organizationRes.ok()).toBe(true);
    const organization = await organizationRes.json() as { id: string; issuePrefix: string };

    const jsonFilePath = "artifacts/chat-ui-review/evals.json";
    const fileRes = await request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: {
        filePath: jsonFilePath,
        content: JSON.stringify({ skill_name: "debug-run-transcript", evals: [] }, null, 2),
      },
    });
    expect(fileRes.ok()).toBe(true);

    await selectOrganization(page, organization.id);
    await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(jsonFilePath)}`);
    await expect(page.getByTestId("org-workspaces-editor-tabs")).toContainText("evals.json", { timeout: 15_000 });

    const [contextCardBox, mainCardBox, headerBox, tabStripBox, activeTabBox] = await Promise.all([
      page.getByTestId("workspace-context-card").boundingBox(),
      page.getByTestId("workspace-main-card").boundingBox(),
      page.getByTestId("workspace-context-header").boundingBox(),
      page.getByTestId("org-workspaces-editor-tabs").boundingBox(),
      page.getByTestId("org-workspaces-editor-tabs").locator(".rudder-doc-editor-tab--active").boundingBox(),
    ]);

    expect(contextCardBox).not.toBeNull();
    expect(mainCardBox).not.toBeNull();
    expect(headerBox).not.toBeNull();
    expect(tabStripBox).not.toBeNull();
    expect(activeTabBox).not.toBeNull();

    expect(Math.abs(contextCardBox!.y - mainCardBox!.y)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(contextCardBox!.y - tabStripBox!.y)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(contextCardBox!.y - activeTabBox!.y)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(headerBox!.height - tabStripBox!.height)).toBeLessThanOrEqual(0.5);
    expect(activeTabBox!.height - tabStripBox!.height).toBeCloseTo(1, 0);
  });

  test("renders image files inline in the workspace browser", async ({ page, request }) => {
    const organizationRes = await request.post("/api/orgs", {
      data: {
        name: `Organization-Workspaces-Image-Preview-${Date.now()}`,
      },
    });
    expect(organizationRes.ok()).toBe(true);
    const organization = await organizationRes.json() as { id: string; issuePrefix: string };

    const imageFilePath = "artifacts/cost-trend.png";
    const imagePath = path.join(resolveOrganizationWorkspaceRoot(organization.id), imageFilePath);
    await fs.mkdir(path.dirname(imagePath), { recursive: true });
    await fs.writeFile(imagePath, ONE_BY_ONE_PNG);

    await selectOrganization(page, organization.id);
    await page.goto(`/${organization.issuePrefix}/workspaces?path=${encodeURIComponent(imageFilePath)}`);

    await expect(page.getByText(imageFilePath)).toBeVisible();
    await expect(page.getByTestId("org-workspaces-editor-tabs")).toContainText("cost-trend.png", { timeout: 15_000 });
    await expect(page.getByText("Binary files are not previewed")).toHaveCount(0);

    const preview = page.getByTestId("org-workspaces-image-preview");
    await expect(preview).toBeVisible();
    await expect(preview).toHaveAttribute(
      "src",
      new RegExp(`/api/orgs/${organization.id}/workspace/file/content\\?path=artifacts%2Fcost-trend\\.png`),
    );
    await expect(preview).toHaveJSProperty("naturalWidth", 1);
    await expect(preview).toHaveJSProperty("naturalHeight", 1);
  });

  test("renders PDF files inline in the workspace browser", async ({ page, request }) => {
    const organizationRes = await request.post("/api/orgs", {
      data: {
        name: `Organization-Workspaces-PDF-Preview-${Date.now()}`,
      },
    });
    expect(organizationRes.ok()).toBe(true);
    const organization = await organizationRes.json() as { id: string; issuePrefix: string };

    const pdfFilePath = "reports/brief.pdf";
    const fileRes = await request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: {
        filePath: pdfFilePath,
        content: createSimplePdf().toString("utf8"),
      },
    });
    expect(fileRes.ok()).toBe(true);

    await selectOrganization(page, organization.id);
    await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(pdfFilePath)}`);

    await expect(page.getByText(pdfFilePath)).toBeVisible();
    await expect(page.getByTestId("org-workspaces-editor-tabs")).toContainText("brief.pdf", { timeout: 15_000 });
    await expect(page.getByText("Binary files are not previewed")).toHaveCount(0);

    const preview = page.getByTestId("org-workspaces-pdf-preview");
    await expect(preview).toBeVisible();
    await expect(preview).toHaveAttribute(
      "data-pdf-src",
      new RegExp(`/api/orgs/${organization.id}/workspace/file/content\\?path=reports%2Fbrief\\.pdf`),
    );
    const previewCanvas = page.getByTestId("org-workspaces-pdf-preview-canvas");
    await expect(previewCanvas).toHaveAttribute("data-rendered-page", "1", { timeout: 15_000 });
    await expect(page.getByTestId("org-workspaces-pdf-preview-text-content"))
      .toContainText("Rendered in Library.");
    const contentResponse = await request.get(`/api/orgs/${organization.id}/workspace/file/content?path=${encodeURIComponent(pdfFilePath)}`);
    expect(contentResponse.ok()).toBe(true);
    expect(contentResponse.headers()["content-type"]).toBe("application/pdf");
    await expect(page.getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      new RegExp(`/api/orgs/${organization.id}/workspace/file/content\\?path=reports%2Fbrief\\.pdf`),
    );
    await page.waitForTimeout(1_000);
    await page.screenshot({ path: "/tmp/rudder-pdf-preview-proof.png", fullPage: false });
  });

  test("renders a multi-file website in Connected by default and Offline modes", async ({ page, request }) => {
    const externalRequests: string[] = [];
    const blockedRequests: string[] = [];
    const completedRudderMutationRequests: string[] = [];
    const blockedWebsocketRequests: string[] = [];
    page.on("websocket", (websocket) => {
      if (websocket.url() === "wss://blocked.invalid/socket") {
        blockedWebsocketRequests.push(websocket.url());
      }
    });
    await page.route("https://example.invalid/**", async (route) => {
      const url = new URL(route.request().url());
      externalRequests.push(url.pathname);
      if (url.pathname.endsWith(".png")) {
        await route.fulfill({ status: 200, contentType: "image/png", body: ONE_BY_ONE_PNG });
        return;
      }
      if (url.pathname.endsWith(".js")) {
        await route.fulfill({
          status: 200,
          contentType: "text/javascript",
          body: "document.body.dataset.externalScript = 'ready';",
        });
        return;
      }
      await route.fulfill({ status: 204, body: "" });
    });
    await page.route("https://blocked.invalid/**", async (route) => {
      blockedRequests.push(route.request().url());
      await route.fulfill({ status: 204, body: "" });
    });

    const organizationRes = await request.post("/api/orgs", {
      data: {
        name: `Organization-Workspaces-Html-Preview-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix("WHP"),
      },
    });
    expect(organizationRes.ok()).toBe(true);
    const organization = await organizationRes.json() as { id: string; issuePrefix: string };

    const artifactRoot = "artifacts/website-preview";
    const htmlFilePath = `${artifactRoot}/index.html`;
    const blockedMutationPath = `${artifactRoot}/preview-mutation.txt`;
    const rudderMutationUrl = `${E2E_BASE_URL}/api/orgs/${organization.id}/workspace/file`;
    page.on("requestfinished", (pageRequest) => {
      if (pageRequest.url() === rudderMutationUrl && pageRequest.method() === "POST") {
        completedRudderMutationRequests.push(pageRequest.url());
      }
    });
    const htmlContent = [
      "<!doctype html>",
      "<html><head>",
      "<meta charset=\"utf-8\">",
      "<link rel=\"stylesheet\" href=\"styles.css\">",
      "<script src=\"script.js\" defer></script>",
      "<script type=\"module\" src=\"module.mjs\"></script>",
      "<script src=\"https://example.invalid/external.js\" defer></script>",
      "</head><body>",
      "<main><h1>Rendered website artifact</h1>",
      "<p id=\"script-state\">Scripts blocked</p>",
      "<img id=\"local-image\" src=\"assets/pixel.png\" alt=\"Local pixel\">",
      "<img id=\"external-image\" src=\"https://example.invalid/external.png\" alt=\"External pixel\">",
      "<iframe id=\"blocked-frame\" src=\"https://blocked.invalid/frame\"></iframe>",
      "<form id=\"blocked-form\" action=\"https://blocked.invalid/form\" method=\"post\" target=\"_top\"><button>Submit</button></form>",
      "<a id=\"blocked-link\" href=\"https://blocked.invalid/top\" ping=\"https://blocked.invalid/ping\" target=\"_top\">Leave</a>",
      "<a id=\"blocked-download\" href=\"https://blocked.invalid/download\" download>Download</a>",
      "</main></body></html>",
    ].join("");
    const adversarialScript = [
      "document.querySelector('#script-state').textContent = 'Classic script ready';",
      "try { void window.parent.document.body; document.body.dataset.parentAccess = 'leaked'; } catch { document.body.dataset.parentAccess = 'blocked'; }",
      `fetch(${JSON.stringify(rudderMutationUrl)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(JSON.stringify({ filePath: blockedMutationPath, content: "preview escaped" }))} })`,
      "  .then(() => { document.body.dataset.fetchState = 'reached'; })",
      "  .catch(() => { document.body.dataset.fetchState = 'blocked'; });",
      `const xhr = new XMLHttpRequest(); xhr.open('POST', ${JSON.stringify(rudderMutationUrl)});`,
      "xhr.onload = () => { document.body.dataset.xhrState = 'reached'; };",
      "xhr.onerror = () => { document.body.dataset.xhrState = 'blocked'; };",
      `try { xhr.send(${JSON.stringify(JSON.stringify({ filePath: blockedMutationPath, content: "xhr escaped" }))}); } catch { document.body.dataset.xhrState = 'blocked'; }`,
      "document.body.dataset.websocketState = 'attempted';",
      "try {",
      "  const socket = new WebSocket('wss://blocked.invalid/socket');",
      "  socket.onopen = () => { document.body.dataset.websocketState = 'opened'; socket.close(); };",
      "  socket.onerror = () => { document.body.dataset.websocketState = 'blocked'; };",
      "} catch { document.body.dataset.websocketState = 'blocked'; }",
      "window.addEventListener('load', () => {",
      "  try { navigator.sendBeacon('https://blocked.invalid/beacon', 'preview'); } catch {}",
      "  try { document.body.dataset.popupState = window.open('https://blocked.invalid/popup', '_blank') ? 'opened' : 'blocked'; } catch { document.body.dataset.popupState = 'blocked'; }",
      "  try { document.querySelector('#blocked-form').requestSubmit(); } catch {}",
      "  try { document.querySelector('#blocked-link').click(); document.querySelector('#blocked-download').click(); } catch {}",
      "});",
    ].join("\n");
    for (const [filePath, content] of [
      [htmlFilePath, htmlContent],
      [`${artifactRoot}/styles.css`, "body { background: rgb(241, 244, 239); } h1 { color: rgb(19, 91, 76); }"],
      [`${artifactRoot}/script.js`, adversarialScript],
      [`${artifactRoot}/module-helper.mjs`, "export const moduleState = 'ready';"],
      [`${artifactRoot}/module.mjs`, "import { moduleState } from './module-helper.mjs'; document.body.dataset.moduleState = moduleState;"],
    ]) {
      const fileRes = await request.post(`/api/orgs/${organization.id}/workspace/file`, {
        data: { filePath, content },
      });
      expect(fileRes.ok(), await fileRes.text()).toBe(true);
    }
    const imagePath = path.join(resolveOrganizationWorkspaceRoot(organization.id), artifactRoot, "assets/pixel.png");
    await fs.mkdir(path.dirname(imagePath), { recursive: true });
    await fs.writeFile(imagePath, ONE_BY_ONE_PNG);

    await selectOrganization(page, organization.id);
    await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(htmlFilePath)}`);
    const libraryUrl = page.url();

    await expect(page.getByTestId("org-workspaces-editor-tabs")).toContainText("index.html", { timeout: 15_000 });
    await expect(page.getByTestId("org-workspaces-editor-textarea")).toHaveCount(0);

    const preview = page.getByTestId("org-workspaces-html-preview");
    await expect(preview).toBeVisible();
    await expect(preview).toHaveAttribute("sandbox", "allow-scripts");
    await expect(preview).toHaveAttribute("referrerpolicy", "no-referrer");
    await expect(preview).toHaveAttribute("src", /http:\/\/preview\.localhost:\d+\/workspace-preview\//);
    const networkMode = page.getByRole("group", { name: "Website preview network mode" });
    const connectedButton = networkMode.getByRole("radio", { name: /^Connected/ });
    const offlineButton = networkMode.getByRole("radio", { name: "Offline" });
    await expect(connectedButton).toHaveAttribute("aria-checked", "true");
    await expect(offlineButton).toHaveAttribute("aria-checked", "false");
    const frame = preview.contentFrame();
    const heading = frame.getByRole("heading", { name: "Rendered website artifact" });
    await expect(heading).toBeVisible();
    await expect(heading).toHaveCSS("color", "rgb(19, 91, 76)");
    await expect(frame.locator("body")).toHaveCSS("background-color", "rgb(241, 244, 239)");
    await expect(frame.locator("#local-image")).toHaveJSProperty("naturalWidth", 1);
    await expect(frame.locator("#script-state")).toHaveText("Classic script ready");
    await expect(frame.locator("body")).toHaveAttribute("data-module-state", "ready");
    await expect(frame.locator("body")).toHaveAttribute("data-external-script", "ready");
    await expect(frame.locator("body")).toHaveAttribute("data-parent-access", "blocked");
    await expect(frame.locator("body")).toHaveAttribute("data-fetch-state", "blocked");
    await expect(frame.locator("body")).toHaveAttribute("data-xhr-state", "blocked");
    await expect(frame.locator("body")).toHaveAttribute("data-websocket-state", "blocked");
    await expect(frame.locator("body")).toHaveAttribute("data-popup-state", "blocked");
    await expect(frame.locator("#external-image")).toHaveJSProperty("naturalWidth", 1);
    expect(externalRequests).toEqual(expect.arrayContaining(["/external.js", "/external.png"]));
    await page.waitForTimeout(500);
    expect(blockedRequests).toEqual([]);
    expect(blockedWebsocketRequests).toEqual([]);
    expect(completedRudderMutationRequests).toEqual([]);
    await expect(page).toHaveURL(libraryUrl);
    const blockedMutationResponse = await request.get(
      `/api/orgs/${organization.id}/workspace/file?path=${encodeURIComponent(blockedMutationPath)}`,
    );
    expect(blockedMutationResponse.status()).toBe(404);
    await page.screenshot({ path: "/tmp/rudder-website-preview-library.png", fullPage: false });

    externalRequests.length = 0;
    await offlineButton.click();
    await expect(preview).toHaveAttribute("sandbox", "");
    await expect(connectedButton).toHaveAttribute("aria-checked", "false");
    await expect(offlineButton).toHaveAttribute("aria-checked", "true");
    await expect(frame.locator("#script-state")).toHaveText("Scripts blocked");
    await expect(frame.locator("body")).not.toHaveAttribute("data-module-state", "ready");
    await expect(frame.locator("body")).not.toHaveAttribute("data-external-script", "ready");
    await page.waitForTimeout(500);
    expect(externalRequests).toEqual([]);

    const offlinePreviewUrl = new URL(await preview.getAttribute("src") ?? "");
    const previewHostApiResponse = await request.get(`${offlinePreviewUrl.origin}/api/health`);
    expect(previewHostApiResponse.status()).toBe(404);
    const mainHostCapabilityResponse = await request.get(offlinePreviewUrl.pathname);
    expect(mainHostCapabilityResponse.status()).toBe(404);

    await page.getByRole("group", { name: "HTML file mode" }).getByRole("radio", { name: "Source" }).click();
    const sourceEditor = page.getByTestId("org-workspaces-editor-textarea");
    await expect(sourceEditor).toBeVisible();
    await expect(sourceEditor).toHaveValue(/Rendered website artifact/);

    const updatedHtml = [
      "<!doctype html>",
      "<html>",
      "<body>",
      "<main>",
      "<h1>Updated website artifact</h1>",
      "<p>The editable source path should still work.</p>",
      "</main>",
      "</body>",
      "</html>",
    ].join("");
    const saveResponse = page.waitForResponse((response) =>
      response.url().includes(`/api/orgs/${organization.id}/workspace/file`)
      && response.url().includes(encodeURIComponent(htmlFilePath))
      && response.request().method() === "PATCH",
    );
    await sourceEditor.fill(updatedHtml);
    await saveResponse;

    await page.getByRole("group", { name: "HTML file mode" }).getByRole("radio", { name: "Preview" }).click();
    await expect(preview.contentFrame().getByRole("heading", { name: "Updated website artifact" })).toBeVisible();
    await expect(preview).toHaveAttribute("sandbox", "allow-scripts");
  });

  test("keeps the static Offline fallback from navigating externally", async ({ page, request }) => {
    const externalRequests: string[] = [];
    await page.route("https://blocked.invalid/**", async (route) => {
      externalRequests.push(route.request().url());
      await route.fulfill({ status: 204, body: "" });
    });

    const organizationRes = await request.post("/api/orgs", {
      data: {
        name: `Workspace-Static-Fallback-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix("WSF"),
      },
    });
    expect(organizationRes.ok()).toBe(true);
    const organization = await organizationRes.json() as { id: string; issuePrefix: string };
    const htmlFilePath = "artifacts/static-fallback/index.html";
    const fileRes = await request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: {
        filePath: htmlFilePath,
        content: [
          "<!doctype html><html><head>",
          "<meta http-equiv='refresh' content='0;url=https://blocked.invalid/refresh'>",
          "<base href='https://blocked.invalid/'>",
          "</head><body><h1>Static Offline fallback</h1>",
          "<a id='external-link' href='https://blocked.invalid/link' ping='https://blocked.invalid/ping'>Leave</a>",
          "<a id='encoded-external-link' href='h&#x09;ttps://blocked.invalid/encoded'>Encoded leave</a>",
          "<a id='c0-external-link' href='&#x01;https://blocked.invalid/c0'>C0 leave</a>",
          "<a id='download-link' href='https://blocked.invalid/download' download>Download</a>",
          "</body></html>",
        ].join(""),
      },
    });
    expect(fileRes.ok(), await fileRes.text()).toBe(true);

    await page.route("**/workspace/web-preview-sessions", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Stable file verification is unavailable." }),
      });
    });
    await selectOrganization(page, organization.id);
    await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(htmlFilePath)}`);

    const fallback = page.getByTestId("org-workspaces-html-preview");
    await expect(fallback).toHaveAttribute("data-preview-fallback", "static");
    await expect(fallback).toHaveAttribute("sandbox", "");
    const fallbackUrl = page.url();
    const frame = fallback.contentFrame();
    await expect(frame.getByRole("heading", { name: "Static Offline fallback" })).toBeVisible();
    await expect(frame.locator("meta[http-equiv='refresh']")).toHaveCount(0);
    await expect(frame.locator("base")).toHaveCount(0);
    await expect(frame.locator("#external-link")).not.toHaveAttribute("href");
    await expect(frame.locator("#external-link")).not.toHaveAttribute("ping");
    await expect(frame.locator("#encoded-external-link")).not.toHaveAttribute("href");
    await expect(frame.locator("#c0-external-link")).not.toHaveAttribute("href");
    await expect(frame.locator("#download-link")).not.toHaveAttribute("href");
    await expect(frame.locator("#download-link")).not.toHaveAttribute("download");
    await frame.locator("#external-link").click();
    await frame.locator("#encoded-external-link").click();
    await frame.locator("#c0-external-link").click();
    await frame.locator("#download-link").click();
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(fallbackUrl);
    expect(externalRequests).toEqual([]);

    const networkMode = page.getByRole("group", { name: "Website preview network mode" });
    await expect(networkMode.getByRole("radio", { name: "Offline", exact: true })).toHaveAttribute("aria-checked", "true");
    await expect(networkMode.getByRole("radio", { name: /^Connected/ })).toBeDisabled();
  });

  test("renders the same website preview in the Messenger Side Panel", async ({ page, request }) => {
    const organizationRes = await request.post("/api/orgs", {
      data: {
        name: `Messenger-Website-Preview-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix("MWP"),
      },
    });
    expect(organizationRes.ok()).toBe(true);
    const organization = await organizationRes.json() as { id: string; issuePrefix: string };
    const artifactRoot = `artifacts/messenger-site-${Date.now()}`;
    const htmlFilePath = `${artifactRoot}/index.html`;
    const htmlResponse = await request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: {
        filePath: htmlFilePath,
        content: "<!doctype html><html><head><link rel=\"stylesheet\" href=\"styles.css\"></head><body><main><h1>Messenger website preview</h1><p>Responsive artifact output.</p></main></body></html>",
      },
    });
    expect(htmlResponse.ok(), await htmlResponse.text()).toBe(true);
    const libraryFile = await htmlResponse.json() as { markdownLink: string };
    const cssResponse = await request.post(`/api/orgs/${organization.id}/workspace/file`, {
      data: {
        filePath: `${artifactRoot}/styles.css`,
        content: "body { margin: 0; background: rgb(248, 244, 235); } main { padding: 32px; } h1 { color: rgb(148, 57, 49); }",
      },
    });
    expect(cssResponse.ok(), await cssResponse.text()).toBe(true);

    const chatResponse = await request.post(`/api/orgs/${organization.id}/chats`, {
      data: { title: "Website preview host chat", issueCreationMode: "manual_approval", planMode: false },
    });
    expect(chatResponse.ok(), await chatResponse.text()).toBe(true);
    const chat = await chatResponse.json() as { id: string };
    await e2eDb.insert(chatMessages).values({
      id: randomUUID(),
      orgId: organization.id,
      conversationId: chat.id,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: `Review ${libraryFile.markdownLink} beside this chat.`,
      structuredPayload: null,
      replyingAgentId: null,
      chatTurnId: randomUUID(),
      turnVariant: 0,
    });

    await selectOrganization(page, organization.id);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);
    const assistantMessage = page.getByTestId("chat-assistant-message").last();
    await expect(assistantMessage).toContainText("index.html", { timeout: 15_000 });
    await assistantMessage.getByRole("link", { name: "index.html" }).click();

    const sidePanel = page.getByTestId("chat-side-panel");
    await expect(sidePanel).toBeVisible({ timeout: 15_000 });
    const preview = sidePanel.getByTestId("chat-side-panel-library-html-preview");
    await expect(preview).toBeVisible();
    await expect(preview).toHaveAttribute("sandbox", "allow-scripts");
    await expect(sidePanel.getByRole("group", { name: "Website preview network mode" })
      .getByRole("radio", { name: /^Connected/ })).toHaveAttribute("aria-checked", "true");
    const heading = preview.contentFrame().getByRole("heading", { name: "Messenger website preview" });
    await expect(heading).toBeVisible();
    await expect(heading).toHaveCSS("color", "rgb(148, 57, 49)");
    await page.screenshot({ path: "/tmp/rudder-website-preview-messenger.png", fullPage: false });
  });
});
