// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceMediaPreview } from "./WorkspaceMediaPreview";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

async function renderMedia(overrides: Partial<Parameters<typeof WorkspaceMediaPreview>[0]> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const props = {
    kind: "video" as const,
    src: "/api/orgs/org-1/workspace/file/content?path=media%2Fdemo.mp4",
    contentType: "video/mp4",
    title: "media/demo.mp4",
    openAction: <button type="button">Open</button>,
    testId: "test-media",
    ...overrides,
  };
  await act(async () => root.render(<WorkspaceMediaPreview {...props} />));
  return { container, root, props };
}

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

describe("WorkspaceMediaPreview", () => {
  it("renders a no-autoplay browser-native video with responsive playback controls", async () => {
    const { container, props } = await renderMedia();
    const video = container.querySelector<HTMLVideoElement>("video");

    expect(video?.controls).toBe(true);
    expect(video?.playsInline).toBe(true);
    expect(video?.preload).toBe("metadata");
    expect(video?.autoplay).toBe(false);
    expect(video?.getAttribute("src")).toBe(props.src);
    expect(video?.getAttribute("aria-label")).toBe("media/demo.mp4 video preview");
    expect(container.querySelector("[data-workspace-media-preview='video']")).not.toBeNull();
    expect(container.querySelector<HTMLAnchorElement>("a[download]")?.getAttribute("href")).toBe(props.src);
    expect(container.textContent).toContain("Open");
  });

  it("renders a no-autoplay browser-native audio player", async () => {
    const { container } = await renderMedia({
      kind: "audio",
      src: "/api/orgs/org-1/workspace/file/content?path=media%2Fdemo.mp3",
      contentType: "audio/mpeg",
      title: "media/demo.mp3",
    });
    const audio = container.querySelector<HTMLAudioElement>("audio");

    expect(audio?.controls).toBe(true);
    expect(audio?.preload).toBe("metadata");
    expect(audio?.autoplay).toBe(false);
    expect(audio?.getAttribute("aria-label")).toBe("media/demo.mp3 audio preview");
    expect(container.querySelector("[data-workspace-media-preview='audio']")).not.toBeNull();
  });

  it("shows codec recovery actions on load error and resets when the file changes", async () => {
    const { container, root, props } = await renderMedia();
    await act(async () => {
      container.querySelector("video")?.dispatchEvent(new Event("error"));
    });

    const fallback = container.querySelector("[data-testid='test-media-fallback']");
    expect(fallback?.getAttribute("role")).toBe("alert");
    expect(fallback?.textContent).toContain("can’t be played in this browser");
    expect(fallback?.textContent).toContain("Download");
    expect(fallback?.textContent).toContain("Open");

    await act(async () => {
      root.render(<WorkspaceMediaPreview {...props} src="/api/media/next.mp4" title="media/next.mp4" />);
    });
    expect(container.querySelector("[data-testid='test-media-fallback']")).toBeNull();
    expect(container.querySelector("video")?.getAttribute("src")).toBe("/api/media/next.mp4");
  });
});
