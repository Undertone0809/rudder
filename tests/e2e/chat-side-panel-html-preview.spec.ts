import { expect, test, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

async function expectPreviewFillsFileView(sidePanel: Locator, preview: Locator) {
  const [fileViewBox, toolbarBox, previewBox] = await Promise.all([
    sidePanel.getByTestId("chat-side-panel-library-file-view").boundingBox(),
    sidePanel.getByTestId("chat-side-panel-library-file-toolbar").boundingBox(),
    preview.boundingBox(),
  ]);
  expect(fileViewBox).not.toBeNull();
  expect(toolbarBox).not.toBeNull();
  expect(previewBox).not.toBeNull();
  expect(Math.abs(previewBox!.width - fileViewBox!.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(previewBox!.y - (toolbarBox!.y + toolbarBox!.height))).toBeLessThanOrEqual(2);
  expect(Math.abs((previewBox!.y + previewBox!.height) - (fileViewBox!.y + fileViewBox!.height))).toBeLessThanOrEqual(2);
}

function createSimplePdf() {
  const stream = "BT /F1 18 Tf 36 96 Td (Rendered Messenger PDF) Tj ET";
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
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer << /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return body;
}

test("renders a Library HTML report in the Messenger Side Panel by default", async ({ page }) => {
  let externalAssetRequested = false;
  await page.route("https://example.invalid/**", async (route) => {
    externalAssetRequested = true;
    await route.fulfill({ status: 204, body: "" });
  });

  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name: `Chat-Side-Panel-HTML-${Date.now()}`,
      issuePrefix: `H${randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}`,
    },
  });
  expect(orgRes.ok(), await orgRes.text()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const htmlFilePath = `artifacts/reports/rendered-report-${Date.now()}.html`;
  const fileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, {
    data: {
      filePath: htmlFilePath,
      content: [
        "<!-- <head> in untrusted prose must not capture the preview policy. -->",
        "<!doctype html>",
        "<html><head><title>Messenger report</title>",
        "<style>body{font-family:system-ui,sans-serif}main{padding:24px}h1{color:rgb(24,96,78)}</style>",
        "</head><body>",
        "<main><h1>Rendered Messenger report</h1>",
        "<p>The report should open as a webpage instead of source code.</p>",
        "<img src=\"https://example.invalid/tracker.png\" alt=\"External tracker\">",
        "<script>document.body.dataset.scriptRan = 'yes';</script>",
        "</main></body></html>",
      ].join(""),
    },
  });
  expect(fileRes.ok(), await fileRes.text()).toBe(true);
  const libraryFile = await fileRes.json() as { markdownLink: string };

  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "HTML report preview host chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    },
  });
  expect(chatRes.ok(), await chatRes.text()).toBe(true);
  const chat = await chatRes.json() as { id: string };
  await e2eDb.insert(chatMessages).values({
    id: randomUUID(),
    orgId: organization.id,
    conversationId: chat.id,
    role: "assistant",
    kind: "message",
    status: "completed",
    body: `Open ${libraryFile.markdownLink} beside this chat.`,
    structuredPayload: null,
    replyingAgentId: null,
    chatTurnId: randomUUID(),
    turnVariant: 0,
  });

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

  const fileName = htmlFilePath.split("/").at(-1) ?? htmlFilePath;
  const assistantMessage = page.getByTestId("chat-assistant-message").last();
  await expect(assistantMessage).toContainText(fileName, { timeout: 15_000 });
  await assistantMessage.getByRole("link", { name: fileName }).click();

  const sidePanel = page.getByTestId("chat-side-panel");
  await expect(sidePanel).toBeVisible({ timeout: 15_000 });
  const preview = sidePanel.getByTestId("chat-side-panel-library-html-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute("sandbox", "allow-scripts");
  await expect(preview).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(preview).toHaveAttribute("src", /http:\/\/preview\.localhost:\d+\/workspace-preview\//);
  await expect(preview).not.toHaveAttribute("srcdoc", /.+/);
  const networkMode = sidePanel.getByRole("group", { name: "Website preview network mode" });
  const connectedButton = networkMode.getByRole("radio", { name: /^Connected/ });
  const offlineButton = networkMode.getByRole("radio", { name: "Offline" });
  await expect(connectedButton).toHaveAttribute("aria-checked", "true");
  await expect(offlineButton).toHaveAttribute("aria-checked", "false");
  const [offlineRadii, connectedRadii] = await Promise.all([
    offlineButton.evaluate((element) => {
      const style = getComputedStyle(element);
      return { left: style.borderTopLeftRadius, right: style.borderTopRightRadius };
    }),
    connectedButton.evaluate((element) => {
      const style = getComputedStyle(element);
      return { left: style.borderTopLeftRadius, right: style.borderTopRightRadius };
    }),
  ]);
  expect(offlineRadii.left).not.toBe("0px");
  expect(offlineRadii.right).toBe("0px");
  expect(connectedRadii.left).toBe("0px");
  expect(connectedRadii.right).not.toBe("0px");
  await expect(preview.contentFrame().getByRole("heading", { name: "Rendered Messenger report" })).toBeVisible();
  await expect(preview.contentFrame().getByRole("heading", { name: "Rendered Messenger report" })).toHaveCSS("color", "rgb(24, 96, 78)");
  await expect(preview.contentFrame().getByText("The report should open as a webpage instead of source code.")).toBeVisible();
  await expect(preview.contentFrame().locator("body")).toHaveAttribute("data-script-ran", "yes");
  await expectPreviewFillsFileView(sidePanel, sidePanel.getByTestId("chat-side-panel-library-html-preview-frame"));
  await page.waitForTimeout(500);
  expect(externalAssetRequested).toBe(true);
  await page.screenshot({ path: "/tmp/rudder-messenger-html-preview.png", fullPage: false });

  externalAssetRequested = false;
  await offlineButton.click();
  await expect(preview).toHaveAttribute("sandbox", "");
  await expect(connectedButton).toHaveAttribute("aria-checked", "false");
  await expect(offlineButton).toHaveAttribute("aria-checked", "true");
  await expect(preview.contentFrame().locator("body")).not.toHaveAttribute("data-script-ran", "yes");
  await page.waitForTimeout(500);
  expect(externalAssetRequested).toBe(false);

  const modeToggle = sidePanel.getByTestId("chat-side-panel-library-file-mode-toggle");
  await expect(modeToggle).toHaveCount(1);
  await expect(modeToggle).toHaveAccessibleName("Show source");
  await modeToggle.click();
  await expect(preview).toHaveCount(0);
  const source = sidePanel.getByTestId("chat-side-panel-library-code-preview");
  await expect(source).toHaveAttribute("data-workspace-code-read-only", "true");
  await expect(source).toContainText("Rendered Messenger report");

  await expect(modeToggle).toHaveAccessibleName("Show webpage");
  await modeToggle.click();
  await expect(sidePanel.getByTestId("chat-side-panel-library-html-preview").contentFrame()
    .getByRole("heading", { name: "Rendered Messenger report" })).toBeVisible();
  await expect(sidePanel.getByTestId("chat-side-panel-library-html-preview")).toHaveAttribute("sandbox", "allow-scripts");
  await expect(page).toHaveURL(new RegExp(`/messenger/chat/${chat.id}$`));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(assistantMessage).toContainText(fileName, { timeout: 15_000 });
  await assistantMessage.getByRole("link", { name: fileName }).click();
  const mobilePreview = sidePanel.getByTestId("chat-side-panel-library-html-preview");
  await expect(mobilePreview.contentFrame().getByRole("heading", { name: "Rendered Messenger report" })).toBeVisible();
  await expect(mobilePreview).toHaveAttribute("sandbox", "allow-scripts");
  await expectPreviewFillsFileView(sidePanel, sidePanel.getByTestId("chat-side-panel-library-html-preview-frame"));
  await expect.poll(async () => {
    const box = await sidePanel.boundingBox();
    if (!box) return Number.POSITIVE_INFINITY;
    return Math.max(0, -box.x, box.x + box.width - 390);
  }).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "/tmp/rudder-messenger-html-preview-mobile.png", fullPage: false });
});

test("uses full preview surfaces for JSON, CSV, and PDF Library files", async ({ page }) => {
  const orgRes = await page.request.post("/api/orgs", {
    data: {
      name: `Chat-Side-Panel-Data-${Date.now()}`,
      issuePrefix: `D${randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}`,
    },
  });
  expect(orgRes.ok(), await orgRes.text()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };

  const timestamp = Date.now();
  const files = [
    {
      filePath: `artifacts/data/raw-data-${timestamp}.json`,
      content: JSON.stringify({ startedAt: "2026-07-14T10:00:00Z", keywords: [["category", "AI agent orchestration"]] }, null, 2),
    },
    {
      filePath: `artifacts/data/keywords-${timestamp}.csv`,
      content: "category,keyword,score\ncomparison,AI agent orchestration,92\ncategory,agent management,84\n",
    },
    {
      filePath: `artifacts/reports/brief-${timestamp}.pdf`,
      content: createSimplePdf(),
    },
  ];
  const libraryFiles: Array<{ filePath: string; markdownLink: string }> = [];
  for (const file of files) {
    const fileRes = await page.request.post(`/api/orgs/${organization.id}/workspace/file`, { data: file });
    expect(fileRes.ok(), await fileRes.text()).toBe(true);
    const created = await fileRes.json() as { markdownLink: string };
    libraryFiles.push({ filePath: file.filePath, markdownLink: created.markdownLink });
  }

  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Data preview host chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    },
  });
  expect(chatRes.ok(), await chatRes.text()).toBe(true);
  const chat = await chatRes.json() as { id: string };
  await e2eDb.insert(chatMessages).values({
    id: randomUUID(),
    orgId: organization.id,
    conversationId: chat.id,
    role: "assistant",
    kind: "message",
    status: "completed",
    body: `Inspect these outputs:\n\n${libraryFiles.map((file) => `- ${file.markdownLink}`).join("\n")}`,
    structuredPayload: null,
    replyingAgentId: null,
    chatTurnId: randomUUID(),
    turnVariant: 0,
  });

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

  const assistantMessage = page.getByTestId("chat-assistant-message").last();
  await expect(assistantMessage).toContainText("Inspect these outputs", { timeout: 15_000 });
  const sidePanel = page.getByTestId("chat-side-panel");

  const jsonName = libraryFiles[0]!.filePath.split("/").at(-1)!;
  await assistantMessage.getByRole("link", { name: jsonName }).click();
  const codePreview = sidePanel.getByTestId("chat-side-panel-library-code-preview");
  await expect(codePreview).toBeVisible({ timeout: 15_000 });
  await expect(codePreview).toHaveAttribute("data-workspace-code-language", "JSON");
  await expect(codePreview).toHaveAttribute("data-workspace-code-read-only", "true");
  await expect(codePreview.locator(".cm-content")).toHaveAttribute("contenteditable", "false");
  await expect(codePreview).toContainText("AI agent orchestration");
  await expectPreviewFillsFileView(sidePanel, codePreview);
  await page.screenshot({ path: "/tmp/rudder-messenger-json-preview.png", fullPage: false });

  const csvName = libraryFiles[1]!.filePath.split("/").at(-1)!;
  await assistantMessage.getByRole("link", { name: csvName }).click();
  const csvPreview = sidePanel.getByTestId("chat-side-panel-library-csv-preview");
  await expect(csvPreview).toBeVisible();
  await expect(csvPreview.getByRole("columnheader", { name: "keyword" })).toBeVisible();
  await expect(csvPreview.getByRole("cell", { name: "agent management" })).toBeVisible();
  const csvModeToggle = sidePanel.getByTestId("chat-side-panel-library-file-mode-toggle");
  await expect(csvModeToggle).toHaveCount(1);
  await expect(csvModeToggle).toHaveAccessibleName("Show source");
  await expectPreviewFillsFileView(sidePanel, csvPreview);
  await page.screenshot({ path: "/tmp/rudder-messenger-csv-preview.png", fullPage: false });
  await csvModeToggle.click();
  await expect(csvModeToggle).toHaveAccessibleName("Show table");
  await expect(sidePanel.getByTestId("chat-side-panel-library-code-preview")).toContainText("category,keyword,score");

  const pdfName = libraryFiles[2]!.filePath.split("/").at(-1)!;
  await assistantMessage.getByRole("link", { name: pdfName }).click();
  const pdfPreview = sidePanel.getByTestId("chat-side-panel-library-pdf-preview");
  await expect(pdfPreview).toBeVisible();
  await expect(pdfPreview).toHaveAttribute("data-pdf-src", new RegExp(`/api/orgs/${organization.id}/workspace/file/content`));
  const pdfSrc = await pdfPreview.getAttribute("data-pdf-src");
  expect(pdfSrc).not.toBeNull();
  const pdfResponse = await page.request.get(pdfSrc!);
  expect(pdfResponse.ok(), await pdfResponse.text()).toBe(true);
  expect(pdfResponse.headers()["content-type"]).toContain("application/pdf");
  await expectPreviewFillsFileView(sidePanel, pdfPreview);
  await expect(page).toHaveURL(new RegExp(`/messenger/chat/${chat.id}$`));
});
