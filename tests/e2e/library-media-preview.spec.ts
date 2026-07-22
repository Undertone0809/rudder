import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createE2EChatAgent } from "./support/chat-agent";
import { resolveE2EOrganizationWorkspaceRoot } from "./support/organization-storage";

const TEST_MP4 = Buffer.from(
  "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",
  "base64",
);

function createTestWav() {
  const sampleRate = 8_000;
  const sampleCount = Math.floor(sampleRate * 0.8);
  const dataSize = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    wav.writeInt16LE(Math.round(Math.sin((index / sampleRate) * Math.PI * 2 * 440) * 2_000), 44 + index * 2);
  }
  return wav;
}

function uniqueIssuePrefix() {
  return `M${randomUUID().replaceAll("-", "").slice(0, 9).toUpperCase()}`;
}

async function selectOrganization(page: Page, organizationId: string) {
  await page.goto("/");
  await page.evaluate((orgId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", orgId);
  }, organizationId);
}

async function readLibraryFile(request: APIRequestContext, organizationId: string, filePath: string) {
  const response = await request.get(
    `/api/orgs/${organizationId}/workspace/file?path=${encodeURIComponent(filePath)}`,
  );
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as { markdownLink: string; previewKind: string; contentPath: string };
}

test.describe("shared Library media preview", () => {
  test("plays, seeks, switches surfaces, and recovers from unsupported codecs", async ({ page, request }, testInfo) => {
    const organizationResponse = await request.post("/api/orgs", {
      data: {
        name: `Library-Media-Preview-${Date.now()}`,
        issuePrefix: uniqueIssuePrefix(),
      },
    });
    expect(organizationResponse.ok(), await organizationResponse.text()).toBe(true);
    const organization = await organizationResponse.json() as { id: string; issuePrefix: string };
    await createE2EChatAgent(request, organization.id, { name: "Media Preview Agent" });

    const videoPath = "media/demo.mp4";
    const audioPath = "media/tone.wav";
    const unsupportedPath = "media/unsupported.mov";
    const workspaceRoot = resolveE2EOrganizationWorkspaceRoot(organization.id);
    await fs.mkdir(path.join(workspaceRoot, "media"), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(workspaceRoot, videoPath), TEST_MP4),
      fs.writeFile(path.join(workspaceRoot, audioPath), createTestWav()),
      fs.writeFile(path.join(workspaceRoot, unsupportedPath), Buffer.from("not-a-decodable-mov", "utf8")),
    ]);

    const videoFile = await readLibraryFile(request, organization.id, videoPath);
    const audioFile = await readLibraryFile(request, organization.id, audioPath);
    const unsupportedFile = await readLibraryFile(request, organization.id, unsupportedPath);
    expect(videoFile.previewKind).toBe("video");
    expect(audioFile.previewKind).toBe("audio");
    expect(unsupportedFile.previewKind).toBe("video");

    await selectOrganization(page, organization.id);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(videoPath)}`);
    const libraryVideo = page.getByTestId("org-workspaces-video-preview");
    await expect(libraryVideo).toBeVisible({ timeout: 15_000 });
    await expect(libraryVideo).toHaveAttribute("controls", "");
    await expect(libraryVideo).toHaveAttribute("preload", "metadata");
    await expect(libraryVideo).not.toHaveAttribute("autoplay", "");
    await expect.poll(() => libraryVideo.evaluate((element) => (element as HTMLVideoElement).duration || 0))
      .toBeGreaterThan(0);
    await expect.poll(async () => {
      const frame = page.locator("[data-workspace-media-preview='video']");
      const [videoBox, frameBox] = await Promise.all([libraryVideo.boundingBox(), frame.boundingBox()]);
      if (!videoBox || !frameBox) return 0;
      return videoBox.width / frameBox.width;
    }).toBeGreaterThan(0.75);
    await expect(libraryVideo.evaluate(async (element) => {
      const video = element as HTMLVideoElement;
      video.muted = true;
      await video.play();
      return video.paused;
    })).resolves.toBe(false);
    await expect(libraryVideo.evaluate(async (element) => {
      const video = element as HTMLVideoElement;
      video.pause();
      const seeked = new Promise<void>((resolve) => video.addEventListener("seeked", () => resolve(), { once: true }));
      video.currentTime = Math.min(0.2, video.duration / 3);
      await seeked;
      return video.currentTime;
    })).resolves.toBeGreaterThan(0);
    await page.screenshot({ path: testInfo.outputPath("library-video-preview.png"), fullPage: true });

    const rangeResponse = await request.get(videoFile.contentPath, { headers: { Range: "bytes=100-299" } });
    expect(rangeResponse.status()).toBe(206);
    expect(rangeResponse.headers()["content-range"]).toBe(`bytes 100-299/${TEST_MP4.byteLength}`);
    expect((await rangeResponse.body()).byteLength).toBe(200);

    await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(audioPath)}`);
    const libraryAudio = page.getByTestId("org-workspaces-audio-preview");
    await expect(libraryAudio).toBeVisible({ timeout: 15_000 });
    await expect(libraryAudio).toHaveAttribute("preload", "metadata");
    await expect(libraryAudio).not.toHaveAttribute("autoplay", "");
    await expect.poll(() => libraryAudio.evaluate((element) => (element as HTMLAudioElement).duration || 0))
      .toBeGreaterThan(0);
    await libraryAudio.evaluate(async (element) => {
      const audio = element as HTMLAudioElement;
      audio.muted = true;
      await audio.play();
    });
    await expect.poll(() => libraryAudio.evaluate((element) => (element as HTMLAudioElement).currentTime))
      .toBeGreaterThan(0);
    await libraryAudio.evaluate((element) => (element as HTMLAudioElement).pause());

    await page.goto(`/${organization.issuePrefix}/library?path=${encodeURIComponent(unsupportedPath)}`);
    const libraryFallback = page.getByTestId("org-workspaces-video-preview-fallback");
    await expect(libraryFallback).toContainText("This video can’t be played in this browser.", { timeout: 15_000 });
    await expect(libraryFallback.getByRole("link", { name: "Download" })).toHaveAttribute("href", unsupportedFile.contentPath);

    const chatResponse = await request.post(`/api/orgs/${organization.id}/chats`, {
      data: {
        title: "Shared media preview host",
        issueCreationMode: "manual_approval",
        planMode: false,
        initialMessage: {
          body: `Inspect ${videoFile.markdownLink}, ${audioFile.markdownLink}, and ${unsupportedFile.markdownLink}.`,
        },
      },
    });
    expect(chatResponse.ok(), await chatResponse.text()).toBe(true);
    const chat = await chatResponse.json() as { id: string };

    await page.setViewportSize({ width: 1180, height: 820 });
    await page.goto(`/${organization.issuePrefix}/messenger/chat/${chat.id}`);
    const mediaMessage = page.getByTestId("chat-user-message").last();
    await expect(mediaMessage).toContainText("demo.mp4", { timeout: 15_000 });
    await mediaMessage.getByRole("link", { name: "demo.mp4" }).click();
    const sidePanel = page.getByTestId("chat-side-panel");
    const sidePanelVideo = sidePanel.getByTestId("chat-side-panel-library-video-preview");
    const sidePanelVideoFrame = sidePanel.locator("[data-workspace-media-preview='video']");
    await expect(sidePanelVideo).toBeVisible({ timeout: 15_000 });
    await expect(sidePanelVideoFrame).toBeVisible();
    await expect.poll(async () => {
      const [videoBox, frameBox] = await Promise.all([sidePanelVideo.boundingBox(), sidePanelVideoFrame.boundingBox()]);
      if (!videoBox || !frameBox) return 0;
      return videoBox.width / frameBox.width;
    }).toBeGreaterThan(0.75);
    await expect(page).toHaveURL(new RegExp(`/messenger/chat/${chat.id}$`));
    await page.mouse.move(30, 700);
    await page.waitForTimeout(500);
    await page.screenshot({ path: testInfo.outputPath("messenger-side-panel-video-preview.png"), fullPage: true });

    await mediaMessage.getByRole("link", { name: "tone.wav" }).click();
    await expect(sidePanel.getByTestId("chat-side-panel-library-audio-preview")).toBeVisible({ timeout: 15_000 });
    await expect(sidePanel.locator("[data-workspace-media-preview='audio']")).toBeVisible();

    await mediaMessage.getByRole("link", { name: "unsupported.mov" }).click();
    const sidePanelFallback = sidePanel.getByTestId("chat-side-panel-library-video-preview-fallback");
    await expect(sidePanelFallback).toContainText("This video can’t be played in this browser.", { timeout: 15_000 });
    await expect(sidePanelFallback.getByRole("link", { name: "Download" })).toHaveAttribute("href", unsupportedFile.contentPath);
    await expect(sidePanelFallback.getByRole("button", { name: "Open file options" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/messenger/chat/${chat.id}$`));
    await expect(sidePanel.getByRole("tab", { name: /unsupported\.mov/i })).toHaveAttribute("aria-selected", "true");
    await page.mouse.move(30, 700);
    await page.waitForTimeout(500);
    await page.screenshot({ path: testInfo.outputPath("messenger-side-panel-media-fallback.png"), fullPage: true });
  });
});
