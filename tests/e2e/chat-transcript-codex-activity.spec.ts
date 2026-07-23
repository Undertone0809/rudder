import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { chatMessages, createDb } from "../../packages/db/src/index.ts";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB, E2E_DATABASE_URL } from "./support/e2e-env";

const e2eDb = createDb(E2E_DATABASE_URL);

test.afterAll(async () => {
  await (e2eDb as unknown as { $client?: { end: () => Promise<void> } }).$client?.end();
});

test("matches Codex activity disclosure in collapsed and expanded Messenger states", async ({ page }) => {
  test.setTimeout(120_000);
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Chat-Transcript-Codex-Activity-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string; urlKey: string };
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: "Codex Activity Agent",
    command: E2E_CODEX_STUB,
  });
  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Codex activity disclosure",
      preferredAgentId: agent.id,
      issueCreationMode: "manual_approval",
      planMode: false,
      initialMessage: { body: "Show compact process activity." },
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
    body: "The compact activity is ready.",
    structuredPayload: {
      __chatTranscript: [
        { kind: "system", ts: "2026-07-23T00:00:00.000Z", text: "turn started" },
        {
          kind: "tool_call",
          ts: "2026-07-23T00:00:01.000Z",
          name: "Skill",
          toolUseId: "skill-1",
          input: { skill: "systematic-debugging" },
        },
        {
          kind: "tool_result",
          ts: "2026-07-23T00:00:01.010Z",
          toolUseId: "skill-1",
          content: "Loaded skill",
          isError: false,
        },
        {
          kind: "tool_call",
          ts: "2026-07-23T00:00:02.000Z",
          name: "command_execution",
          toolUseId: "command-1",
          input: { command: "pnpm test:run" },
        },
        {
          kind: "tool_result",
          ts: "2026-07-23T00:00:03.000Z",
          toolUseId: "command-1",
          content: "Tests passed",
          isError: false,
        },
      ],
    },
    replyingAgentId: agent.id,
    chatTurnId: randomUUID(),
    turnVariant: 0,
  });

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.urlKey}/messenger/chat/${chat.id}`);

  const transcript = page.getByTestId("chat-transcript-item");
  await transcript.getByRole("button", { name: /Worked for/i }).click();
  const activityButton = transcript.getByRole("button", { name: "Expand tool activity" });
  await expect(activityButton).toContainText("Used 1 skill, ran 1 command");

  const [activityBox, transcriptBox] = await Promise.all([
    activityButton.boundingBox(),
    transcript.boundingBox(),
  ]);
  expect(activityBox).not.toBeNull();
  expect(transcriptBox).not.toBeNull();
  expect(activityBox!.width).toBeLessThan(transcriptBox!.width * 0.75);

  const groupDisclosure = transcript.locator("[data-transcript-disclosure-chevron]").first();
  await expect(groupDisclosure).toHaveCSS("opacity", "0");
  await page.keyboard.press("Tab");
  await activityButton.focus();
  await expect(activityButton).toBeFocused();
  await expect(groupDisclosure).toHaveCSS("opacity", "1");
  await activityButton.click();
  await expect(groupDisclosure).toHaveCSS("opacity", "1");

  const rowDisclosures = transcript.locator("[data-transcript-action-row-disclosure]");
  await expect(rowDisclosures).toHaveCount(2);
  await expect(rowDisclosures.first()).toHaveCSS("opacity", "0");
  await expect(transcript).not.toContainText("10ms");
  await expect(transcript).not.toContainText("1.0s");

  const iconOffsets = await transcript.evaluate((element) => {
    const summary = element.querySelector<HTMLElement>("[data-transcript-action-summary-icon]");
    const rows = [...element.querySelectorAll<HTMLElement>("[data-transcript-action-icon-slot]")];
    return {
      summaryX: summary?.getBoundingClientRect().x ?? null,
      rowXs: rows.map((row) => row.getBoundingClientRect().x),
      skillColor: rows[0] ? getComputedStyle(rows[0].querySelector("[data-transcript-action-icon]")!).color : null,
    };
  });
  expect(iconOffsets.summaryX).not.toBeNull();
  expect(iconOffsets.rowXs.length).toBeGreaterThanOrEqual(2);
  for (const rowX of iconOffsets.rowXs) {
    expect(Math.abs(rowX - iconOffsets.summaryX!)).toBeLessThanOrEqual(1);
  }
  expect(iconOffsets.skillColor).not.toBe("rgb(47, 128, 237)");

  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.screenshot({ path: "/tmp/rudder-codex-activity-expanded.png", fullPage: true });
});

test("inspects recorded images and independent historical diffs in a real Messenger conversation", async ({ page }) => {
  test.setTimeout(120_000);
  const imagePath = "/workspace/rudder/tmp/transcript-preview.png";
  const editedPath = "/workspace/rudder/ui/src/repeated.ts";
  const missingDiffPath = "/workspace/rudder/ui/src/missing-diff.ts";
  const failedDiffPath = "/workspace/rudder/ui/src/failed-diff.ts";
  const readPath = "/workspace/rudder/ui/src/components/transcript/RunTranscriptView.tsx";
  const skillPath = "/workspace/rudder/.agents/skills/systematic-debugging/SKILL.md";
  await page.addInitScript(({ expectedImagePath, expectedTextPaths }) => {
    const previewCalls: string[] = [];
    Object.defineProperty(window, "__rudderTranscriptPreviewCalls", {
      configurable: true,
      value: previewCalls,
    });
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: {
        openPath: async () => {},
        previewLocalFile: async (filePath: string) => {
          previewCalls.push(filePath);
          if (filePath !== expectedImagePath && !expectedTextPaths.includes(filePath)) {
            throw new Error(`Historical diffs must not read the current file: ${filePath}`);
          }
          if (filePath !== expectedImagePath) {
            const fileName = filePath.split("/").at(-1) ?? filePath;
            return {
              canonicalPath: filePath,
              fileName,
              parentPath: filePath.slice(0, filePath.lastIndexOf("/")),
              contentType: "text/plain; charset=utf-8",
              previewKind: "text",
              content: fileName === "SKILL.md"
                ? "# systematic-debugging\n\nUse evidence before fixes."
                : "export function RunTranscriptView() {}",
              base64: null,
              sizeBytes: 48,
              modifiedAt: "2026-07-24T00:00:00.000Z",
              truncated: false,
            };
          }
          return {
            canonicalPath: expectedImagePath,
            fileName: "transcript-preview.png",
            parentPath: expectedImagePath.slice(0, expectedImagePath.lastIndexOf("/")),
            contentType: "image/png",
            previewKind: "image",
            content: null,
            base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            sizeBytes: 68,
            modifiedAt: "2026-07-24T00:00:00.000Z",
            truncated: false,
          };
        },
        setSidePanelCloseShortcutActive: async () => {},
      },
    });
  }, {
    expectedImagePath: imagePath,
    expectedTextPaths: [readPath, skillPath],
  });

  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Chat-Transcript-Artifacts-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string; urlKey: string };
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: "Transcript Artifact Agent",
    command: E2E_CODEX_STUB,
  });
  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Transcript artifact inspection",
      preferredAgentId: agent.id,
      issueCreationMode: "manual_approval",
      planMode: false,
      initialMessage: { body: "Show the immutable transcript artifacts." },
    },
  });
  expect(chatRes.ok()).toBe(true);
  const chat = await chatRes.json() as { id: string };
  const firstChange = {
    status: "completed",
    changes: [{
      path: editedPath,
      kind: { type: "update", move_path: null },
      diff: "@@ -1,2 +1,2 @@\n-export const version = \"old-one\";\n+export const version = \"new-one\";\n unchangedOne();",
    }],
  };
  const secondChange = {
    status: "completed",
    changes: [{
      path: editedPath,
      kind: { type: "update", move_path: null },
      diff: "@@ -8 +8 @@\n-export const phase = \"old-two\";\n+export const phase = \"new-two\";",
    }],
  };
  const missingChange = {
    status: "completed",
    changes: [{
      path: missingDiffPath,
      kind: { type: "update", move_path: null },
    }],
  };
  const failedChange = {
    status: "failed",
    changes: [{
      path: failedDiffPath,
      kind: { type: "update", move_path: null },
      diff: "@@ -1 +1 @@\n-current\n+unapplied",
    }],
  };
  const imageEvidence = {
    status: "completed",
    path: imagePath,
  };
  await e2eDb.insert(chatMessages).values({
    id: randomUUID(),
    orgId: organization.id,
    conversationId: chat.id,
    role: "assistant",
    kind: "message",
    status: "completed",
    body: "The recorded image and file changes are ready to inspect.",
    structuredPayload: {
      __chatTranscript: [
        { kind: "system", ts: "2026-07-24T00:00:00.000Z", text: "turn started" },
        {
          kind: "tool_call",
          ts: "2026-07-24T00:00:01.000Z",
          name: "image_view",
          toolUseId: "image-1",
          input: imageEvidence,
        },
        {
          kind: "tool_result",
          ts: "2026-07-24T00:00:01.010Z",
          toolUseId: "image-1",
          content: JSON.stringify(imageEvidence),
          isError: false,
        },
        {
          kind: "tool_call",
          ts: "2026-07-24T00:00:02.000Z",
          name: "file_change",
          toolUseId: "edit-1",
          input: firstChange,
        },
        {
          kind: "tool_result",
          ts: "2026-07-24T00:00:02.010Z",
          toolUseId: "edit-1",
          content: JSON.stringify(firstChange),
          isError: false,
        },
        {
          kind: "tool_call",
          ts: "2026-07-24T00:00:03.000Z",
          name: "file_change",
          toolUseId: "edit-2",
          input: secondChange,
        },
        {
          kind: "tool_result",
          ts: "2026-07-24T00:00:03.010Z",
          toolUseId: "edit-2",
          content: JSON.stringify(secondChange),
          isError: false,
        },
        {
          kind: "tool_call",
          ts: "2026-07-24T00:00:04.000Z",
          name: "file_change",
          toolUseId: "edit-missing",
          input: missingChange,
        },
        {
          kind: "tool_result",
          ts: "2026-07-24T00:00:04.010Z",
          toolUseId: "edit-missing",
          content: JSON.stringify(missingChange),
          isError: false,
        },
        {
          kind: "tool_call",
          ts: "2026-07-24T00:00:05.000Z",
          name: "file_change",
          toolUseId: "edit-failed",
          input: failedChange,
        },
        {
          kind: "tool_result",
          ts: "2026-07-24T00:00:05.010Z",
          toolUseId: "edit-failed",
          content: JSON.stringify(failedChange),
          isError: true,
        },
        {
          kind: "tool_call",
          ts: "2026-07-24T00:00:06.000Z",
          name: "read",
          toolUseId: "read-source",
          input: { path: readPath, cwd: "/workspace/rudder" },
        },
        {
          kind: "tool_result",
          ts: "2026-07-24T00:00:06.010Z",
          toolUseId: "read-source",
          content: "export function RunTranscriptView() {}",
          isError: false,
        },
        {
          kind: "tool_call",
          ts: "2026-07-24T00:00:07.000Z",
          name: "command_execution",
          toolUseId: "read-skill",
          input: {
            command: "sed -n '1,240p' .agents/skills/systematic-debugging/SKILL.md",
            cwd: "/workspace/rudder",
          },
        },
        {
          kind: "tool_result",
          ts: "2026-07-24T00:00:07.010Z",
          toolUseId: "read-skill",
          content: "# systematic-debugging",
          isError: false,
        },
      ],
    },
    replyingAgentId: agent.id,
    chatTurnId: randomUUID(),
    turnVariant: 0,
  });

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.urlKey}/messenger/chat/${chat.id}`);
  const routeBeforeInspection = page.url();

  const transcript = page.getByTestId("chat-transcript-item");
  await transcript.getByRole("button", { name: /Worked for/i }).click();
  const previewCalls = async () => page.evaluate(
    () => [...((window as typeof window & { __rudderTranscriptPreviewCalls?: string[] }).__rudderTranscriptPreviewCalls ?? [])],
  );
  await expect.poll(previewCalls).toEqual([]);

  const activityButton = transcript.getByRole("button", { name: "Expand tool activity" });
  await expect(activityButton).toContainText(/viewed an image/i);
  await activityButton.click();
  await expect.poll(previewCalls).toEqual([]);

  const imageTarget = transcript.locator(`[data-transcript-image-target="${imagePath}"]`);
  await expect(imageTarget).toHaveText("Viewed an image");
  const imageDisclosure = imageTarget.locator("..").locator("[data-transcript-action-row-disclosure]");
  await expect(imageDisclosure).toHaveCSS("opacity", "0");
  await imageTarget.hover();
  await expect(imageDisclosure).toHaveCSS("opacity", "1");
  await page.mouse.move(0, 0);
  await expect(imageDisclosure).toHaveCSS("opacity", "0");
  await imageTarget.focus();
  await expect(imageDisclosure).toHaveCSS("opacity", "1");
  await imageTarget.blur();

  await imageTarget.click();
  await expect.poll(previewCalls).toEqual([imagePath]);
  const thumbnail = transcript.getByRole("img", { name: "Preview of transcript-preview.png" });
  await expect(thumbnail).toBeVisible();
  await page.screenshot({
    path: "/tmp/rudder-messenger-transcript-image.png",
    fullPage: true,
  });
  await thumbnail.click();
  const imageDialog = page.getByTestId("transcript-image-preview-dialog");
  await expect(imageDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(imageDialog).toBeHidden();
  await expect(transcript).toBeVisible();
  await expect(page).toHaveURL(routeBeforeInspection);

  const diffTargets = transcript.locator(`[data-transcript-diff-target="${editedPath}"]`);
  await expect(diffTargets).toHaveCount(2);
  await expect(transcript.locator(`[data-transcript-diff-target="${missingDiffPath}"]`)).toHaveCount(0);
  await expect(transcript.locator(`[data-transcript-diff-target="${failedDiffPath}"]`)).toHaveCount(0);
  await expect(transcript.getByTitle(missingDiffPath)).toContainText("Edited missing-diff.ts");
  await expect(transcript.getByTitle(failedDiffPath)).toContainText("Edited failed-diff.ts +1 -1");

  await diffTargets.nth(0).click();
  const firstDiff = transcript.locator("[data-transcript-unified-diff]").filter({ hasText: "old-one" });
  await expect(firstDiff).toContainText("new-one");
  await expect(firstDiff).not.toContainText("old-two");
  await diffTargets.nth(0).click();
  await expect(firstDiff).toBeHidden();

  await diffTargets.nth(1).click();
  const secondDiff = transcript.locator("[data-transcript-unified-diff]").filter({ hasText: "old-two" });
  await expect(secondDiff).toContainText("new-two");
  await expect(secondDiff).not.toContainText("old-one");
  await expect(secondDiff).toHaveCSS("opacity", "1");
  await expect.poll(previewCalls).toEqual([imagePath]);
  await expect(page).toHaveURL(routeBeforeInspection);
  await page.screenshot({
    path: "/tmp/rudder-messenger-transcript-diff.png",
    fullPage: true,
  });

  const readTarget = transcript.locator(`[data-transcript-file-target="${readPath}"]`);
  const skillTarget = transcript.locator(`[data-transcript-file-target="${skillPath}"]`);
  await expect(readTarget).toHaveText("RunTranscriptView.tsx");
  await expect(skillTarget).toHaveText("systematic-debugging");
  await expect(transcript.getByText(readPath, { exact: true })).toHaveCount(0);
  await expect(transcript.getByText(skillPath, { exact: true })).toHaveCount(0);

  await readTarget.click();
  await expect(page).toHaveURL(routeBeforeInspection);
  const sidePanel = page.getByRole("complementary", { name: "Side Panel" });
  await expect(sidePanel.getByRole("tab", { name: "RunTranscriptView.tsx" })).toBeVisible();
  await expect(sidePanel.getByTestId("chat-side-panel-local-file-view").getByText("RunTranscriptView.tsx", { exact: true })).toBeVisible();
  await skillTarget.click();
  await expect(page).toHaveURL(routeBeforeInspection);
  await expect(sidePanel.getByRole("tab", { name: "systematic-debugging" })).toBeVisible();
  await expect(sidePanel.getByTestId("chat-side-panel-local-file-view").getByText("SKILL.md", { exact: true })).toBeVisible();
  await expect.poll(previewCalls).toEqual([imagePath, readPath, skillPath]);
  expect(await previewCalls()).not.toContain(editedPath);
  expect(await previewCalls()).not.toContain(missingDiffPath);
  expect(await previewCalls()).not.toContain(failedDiffPath);
});

test("keeps Messenger process activity inside the reading column on wide screens", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const orgRes = await page.request.post("/api/orgs", {
    data: { name: `Chat-Transcript-Reading-Column-${Date.now()}` },
  });
  expect(orgRes.ok()).toBe(true);
  const organization = await orgRes.json() as { id: string; issuePrefix: string };
  const agent = await createE2EChatAgent(page.request, organization.id, {
    name: "Reading Column Agent",
    command: E2E_CODEX_STUB,
  });
  const chatRes = await page.request.post(`/api/orgs/${organization.id}/chats`, {
    data: {
      title: "Transcript reading column",
      preferredAgentId: agent.id,
      issueCreationMode: "manual_approval",
      planMode: false,
      initialMessage: { body: "Check wide process activity." },
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
    body: "The reading column is ready.",
    structuredPayload: {
      __chatTranscript: [
        {
          kind: "assistant",
          ts: "2026-07-23T00:00:01.000Z",
          text: "Inspecting a wide Messenger layout before rendering the final response.",
        },
        {
          kind: "tool_call",
          ts: "2026-07-23T00:00:02.000Z",
          name: "command_execution",
          toolUseId: "command-wide-1",
          input: { command: "pnpm test:run" },
        },
        {
          kind: "tool_result",
          ts: "2026-07-23T00:00:03.000Z",
          toolUseId: "command-wide-1",
          content: "Tests passed",
          isError: false,
        },
      ],
    },
    replyingAgentId: agent.id,
    chatTurnId: randomUUID(),
    turnVariant: 0,
  });

  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organization.id);
  await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);

  const transcript = page.getByTestId("chat-transcript-item");
  await transcript.getByRole("button", { name: /Worked for/i }).click();
  const readingColumns = transcript.locator('[data-transcript-chat-column="reading"]');
  await expect(readingColumns).toHaveCount(2);

  const [transcriptBox, firstColumnBox, secondColumnBox] = await Promise.all([
    transcript.boundingBox(),
    readingColumns.nth(0).boundingBox(),
    readingColumns.nth(1).boundingBox(),
  ]);
  expect(transcriptBox).not.toBeNull();
  expect(firstColumnBox).not.toBeNull();
  expect(secondColumnBox).not.toBeNull();
  expect(transcriptBox!.width).toBeGreaterThan(820);
  for (const columnBox of [firstColumnBox!, secondColumnBox!]) {
    expect(columnBox.width).toBeLessThanOrEqual(770);
    expect(columnBox.width).toBeLessThan(transcriptBox!.width - 100);
    expect(columnBox.x).toBeGreaterThanOrEqual(transcriptBox!.x);
  }

  await page.screenshot({ path: "/tmp/rudder-chat-transcript-reading-column.png", fullPage: true });
});
