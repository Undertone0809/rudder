import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB, E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

test("keeps a rendered Mermaid diagram stable while typing in the Messenger composer", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
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
  });
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Mermaid-Stability-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: "Diagram Agent",
    command: E2E_CODEX_STUB,
  });
  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Stable Mermaid diagram",
      preferredAgentId: agent.id,
      issueCreationMode: "manual_approval",
      planMode: false,
      initialMessage: { body: "Seed the visual inspection chat." },
    },
  });
  expect(chatRes.ok()).toBe(true);
  const chat = await chatRes.json() as { id: string };

  await e2eDb.insert(chatMessages).values({
    id: randomUUID(),
    orgId: organization.id,
    conversationId: chat.id,
    role: "assistant",
    kind: "message",
    status: "completed",
    body: "Stable diagram\n\n```mermaid\ngraph TD\n  A[Request] --> B{Ready?}\n  B -->|Yes| C[Ship]\n  B -->|No| D[Revise]\n```\n\n![Reference image](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X8dZ1AAAAABJRU5ErkJggg==)",
    structuredPayload: null,
    replyingAgentId: agent.id,
    chatTurnId: randomUUID(),
    turnVariant: 0,
  });

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

  const assistantMessage = page.getByTestId("chat-assistant-message").filter({ hasText: "Stable diagram" });
  const diagram = assistantMessage.locator(".rudder-mermaid");
  const svg = diagram.locator("svg.flowchart");
  await expect(svg).toBeVisible({ timeout: 15_000 });
  await expect(diagram.locator(".rudder-mermaid-source")).toHaveCount(0);

  await page.evaluate(() => {
    const diagramElement = document.querySelector(".rudder-mermaid");
    const svgElement = diagramElement?.querySelector("svg") ?? null;
    const state = {
      diagramElement,
      svgElement,
      fallbackInsertions: 0,
      observer: null as MutationObserver | null,
    };
    state.observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches(".rudder-mermaid-source") || node.querySelector(".rudder-mermaid-source")) {
            state.fallbackInsertions += 1;
          }
        }
      }
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
    (window as typeof window & { __rudderMermaidStability?: typeof state }).__rudderMermaidStability = state;
  });

  await diagram.hover();
  const diagramActions = diagram.getByTestId("mermaid-visual-actions");
  const previewButton = diagramActions.getByRole("button", { name: "Open image preview" });
  const copyButton = diagramActions.getByRole("button", { name: "Copy Image" });
  await expect(previewButton).toBeVisible();
  const svgSize = await svg.evaluate((element) => {
    const viewBox = element.viewBox.baseVal;
    return {
      height: viewBox.height || element.getBoundingClientRect().height,
      width: viewBox.width || element.getBoundingClientRect().width,
    };
  });
  await previewButton.focus();
  await expect(previewButton).toBeFocused();
  await expect(diagramActions).toBeVisible();
  await previewButton.press("Enter");
  const preview = page.getByTestId("mermaid-image-preview-dialog");
  await expect(preview).toBeVisible();
  const previewImage = preview.locator("img");
  await expect(previewImage).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect.poll(() => previewImage.evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);
  const previewSize = await previewImage.evaluate((image) => ({
    height: image.naturalHeight,
    width: image.naturalWidth,
  }));
  expect(previewSize.height).toBeGreaterThanOrEqual(Math.floor(svgSize.height));
  expect(previewSize.height).toBeLessThanOrEqual(Math.ceil(svgSize.height * 2));
  expect(previewSize.width).toBeGreaterThanOrEqual(Math.floor(svgSize.width));
  expect(previewSize.width).toBeLessThanOrEqual(Math.ceil(svgSize.width * 2));
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);

  await copyButton.focus();
  await expect(copyButton).toBeFocused();
  await copyButton.press("Space");
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & {
      __rudderCopiedImage?: { filename: string; contentType: string; base64: string } | null;
    }
  ).__rudderCopiedImage)).toMatchObject({
    filename: "Mermaid diagram.png",
    contentType: "image/png",
  });

  const markdownImage = assistantMessage.locator(".rudder-inspectable-image");
  await expect(markdownImage).toBeVisible();
  await markdownImage.hover();
  const markdownImageActions = markdownImage.getByTestId("markdown-image-actions");
  await expect(markdownImageActions.getByRole("button", { name: "Open image preview" })).toBeVisible();
  const markdownCopyButton = markdownImageActions.getByRole("button", { name: "Copy Image" });
  await markdownCopyButton.focus();
  await expect(markdownCopyButton).toBeFocused();
  await markdownCopyButton.press("Enter");
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & {
      __rudderCopiedImage?: { filename: string; contentType: string; base64: string } | null;
    }
  ).__rudderCopiedImage)).toMatchObject({
    filename: "Reference image.png",
    contentType: "image/png",
  });

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible();
  await composer.pressSequentially("Typing must not remount the diagram", { delay: 20 });

  await expect.poll(() => page.evaluate(() => {
    const state = (window as typeof window & {
      __rudderMermaidStability?: {
        diagramElement: Element | null;
        svgElement: Element | null;
        fallbackInsertions: number;
      };
    }).__rudderMermaidStability;
    return {
      sameDiagram: state?.diagramElement === document.querySelector(".rudder-mermaid"),
      sameSvg: state?.svgElement === document.querySelector(".rudder-mermaid svg"),
      fallbackInsertions: state?.fallbackInsertions ?? -1,
    };
  })).toEqual({ sameDiagram: true, sameSvg: true, fallbackInsertions: 0 });
  await expect(diagram.locator(".rudder-mermaid-source")).toHaveCount(0);
});
