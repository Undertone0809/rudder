import { expect, test, type Page } from "@playwright/test";
import { createE2EChatAgent } from "./support/chat-agent";
import { E2E_CODEX_STUB } from "./support/e2e-env";

async function createChatOrg(page: Page, name: string) {
  const organizationResponse = await page.request.post("/api/orgs", {
    data: { name },
  });
  expect(organizationResponse.ok()).toBe(true);
  const organization = await organizationResponse.json();
  const chatAgent = await createE2EChatAgent(page.request, organization.id, {
    name: "Voice Chat Agent",
    command: E2E_CODEX_STUB,
  });
  return { organization, chatAgent };
}

test("keeps the voice entry hidden on the web Chat surface", async ({ page }) => {
  const { organization, chatAgent } = await createChatOrg(page, `Voice-Web-${Date.now()}`);
  await page.goto("/");
  await page.evaluate((organizationId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", organizationId);
  }, organization.id);
  await page.goto(`/chat?agentId=${chatAgent.id}`);

  await expect(page.locator(".rudder-mdxeditor-content").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("chat-voice-input")).toHaveCount(0);
});

test("uses the mocked Desktop bridge to record, stop, and insert local transcription", async ({ page }) => {
  await page.addInitScript(() => {
    const bridge = {
      speech: {
        supported: true,
        getStatus: async () => ({
          enabled: true,
          available: true,
          reason: "ready",
          maxDurationSeconds: 60,
          maxBytes: 48_000 * 60 * 4,
          minSampleRate: 8_000,
          maxSampleRate: 48_000,
        }),
        requestMicrophoneAccess: async () => "authorized",
        transcribe: async () => ({ text: "local desktop words", language: "en" }),
        cancel: async () => undefined,
      },
    };
    Object.defineProperty(window, "desktopShell", { configurable: true, value: bridge });

    class FakeNode {
      connect() { return this; }
      disconnect() {}
    }
    class FakeAudioContext {
      sampleRate = 48_000;
      destination = {};
      audioWorklet = { addModule: async () => undefined };
      createMediaStreamSource() { return new FakeNode(); }
      createGain() { return Object.assign(new FakeNode(), { gain: { value: 1 } }); }
      async resume() {}
      async close() {}
    }
    class FakeAudioWorkletNode extends FakeNode {
      port = { onmessage: null };
      constructor() {
        super();
        (window as typeof window & { __rudderVoiceProcessor?: unknown }).__rudderVoiceProcessor = this;
      }
    }
    Object.defineProperty(window, "AudioContext", { configurable: true, value: FakeAudioContext });
    Object.defineProperty(window, "AudioWorkletNode", { configurable: true, value: FakeAudioWorkletNode });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:voice" });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
      },
    });
  });

  const { organization, chatAgent } = await createChatOrg(page, `Voice-Desktop-${Date.now()}`);
  await page.goto("/");
  await page.evaluate((organizationId) => {
    window.localStorage.setItem("rudder.selectedOrganizationId", organizationId);
  }, organization.id);
  await page.goto(`/chat?agentId=${chatAgent.id}`);

  const composer = page.locator(".rudder-mdxeditor-content").first();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  const voiceButton = page.getByTestId("chat-voice-input");
  await expect(voiceButton).toBeVisible({ timeout: 15_000 });
  await expect(voiceButton).toBeEnabled({ timeout: 15_000 });
  await voiceButton.click();
  await expect(voiceButton).toHaveAttribute("aria-label", "Stop voice recording");
  await page.evaluate(() => {
    const processor = (window as typeof window & { __rudderVoiceProcessor?: unknown }).__rudderVoiceProcessor as {
      port: { onmessage: ((event: { data: Float32Array }) => void) | null };
    } | undefined;
    processor?.port.onmessage?.({ data: new Float32Array([0.2, -0.2, 0.3]) });
  });
  await voiceButton.click();
  await expect(composer).toContainText("local desktop words", { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();

  if (process.env.RUDDER_E2E_CAPTURE_VOICE_EVIDENCE === "1") {
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath("chat-desktop-voice.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(composer).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath("chat-mobile-voice.png"),
    });
  }
});
