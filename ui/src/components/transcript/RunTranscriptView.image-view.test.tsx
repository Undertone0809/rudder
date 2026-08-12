// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptChatToolActionRow } from "./RunTranscriptView.chat";
import { normalizeTranscript } from "./RunTranscriptView.normalize";
import { describeToolSemanticInfo } from "./RunTranscriptView.semantic";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { previewLocalFile, readDesktopShell } = vi.hoisted(() => ({
  previewLocalFile: vi.fn(),
  readDesktopShell: vi.fn(),
}));

vi.mock("../../lib/desktop-shell", () => ({ readDesktopShell }));
vi.mock("../MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock("../../pages/Chat.attachments", () => ({
  ChatFileAttachmentChip: ({ name }: { name: string }) => <span>{name}</span>,
  ChatImageAttachmentTile: ({ name }: { name: string }) => <span>{name}</span>,
  PendingAttachmentPreview: ({ file }: { file: File }) => <span>{file.name}</span>,
}));
vi.mock("../InspectableImage", () => ({
  InspectableImage: ({ src, name }: { src: string; name: string }) => (
    <button type="button" data-testid="inspectable-image" data-src={src}>{name}</button>
  ),
}));

const roots: Root[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("ImageView transcript artifacts", () => {
  it.each(["image_view", "ImageView", "image-view", "image view"])(
    "recognizes %s as structured image evidence",
    (toolName) => {
      expect(describeToolSemanticInfo(toolName, {
        status: "completed",
        path: "/tmp/dashboard.png",
      })).toMatchObject({
        category: "image",
        summary: "Viewed an image",
        image: {
          displayLabel: "dashboard.png",
          path: "/tmp/dashboard.png",
        },
      });
    },
  );

  it.each(["failed", "error", "cancelled", "canceled", "denied", "rejected"])(
    "does not expose a preview action for %s image evidence",
    (status) => {
      expect(describeToolSemanticInfo("image_view", {
        status,
        path: "/tmp/dashboard.png",
      }).image).toBeUndefined();
    },
  );

  it("hydrates completed-only image evidence from its trusted tool result", () => {
    const evidence = { status: "completed", path: "/tmp/image.png" };
    const blocks = normalizeTranscript([{
      kind: "tool_result",
      ts: "2026-07-25T00:00:00.000Z",
      toolUseId: "image-1",
      toolName: "image_view",
      content: JSON.stringify(evidence),
      isError: false,
    }], false);

    expect(blocks[0]).toMatchObject({
      type: "tool",
      name: "image_view",
      input: evidence,
      status: "completed",
    });
  });

  it("does not expose a preview action when the tool block failed despite completed evidence", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <TranscriptChatToolActionRow
          density="compact"
          block={{
            ts: "2026-07-25T00:00:00.000Z",
            endTs: "2026-07-25T00:00:01.000Z",
            name: "image_view",
            input: { status: "completed", path: "/tmp/dashboard.png" },
            result: "provider rejected the image",
            status: "error",
          }}
        />,
      );
    });

    expect(container.querySelector("[data-transcript-image-target]")).toBeNull();
  });

  it("loads and renders the local image only after ImageView is expanded", async () => {
    readDesktopShell.mockReturnValue({ previewLocalFile });
    previewLocalFile.mockResolvedValue({
      canonicalPath: "/private/tmp/dashboard.png",
      fileName: "dashboard.png",
      parentPath: "/private/tmp",
      contentType: "image/png",
      previewKind: "image",
      content: null,
      base64: "aW1hZ2U=",
      sizeBytes: 5,
      modifiedAt: "2026-07-25T00:00:00.000Z",
      truncated: false,
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <StrictMode>
          <TranscriptChatToolActionRow
            density="compact"
            block={{
              ts: "2026-07-25T00:00:00.000Z",
              endTs: "2026-07-25T00:00:01.000Z",
              name: "image_view",
              input: { status: "completed", path: "/tmp/dashboard.png" },
              result: "{}",
              status: "completed",
            }}
          />
        </StrictMode>,
      );
    });

    expect(previewLocalFile).not.toHaveBeenCalled();
    expect(container.querySelector("[data-transcript-action-icon='image']")).not.toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-transcript-image-target]")?.click();
      await Promise.resolve();
    });

    expect(previewLocalFile).toHaveBeenCalledTimes(1);
    expect(previewLocalFile).toHaveBeenCalledWith("/tmp/dashboard.png");
    expect(container.querySelector("[data-testid='inspectable-image']")?.getAttribute("data-src"))
      .toBe("data:image/png;base64,aW1hZ2U=");
  });

  it("renders a durable Rudder asset without asking Desktop to reopen a temporary file", async () => {
    readDesktopShell.mockReturnValue({ previewLocalFile });
    const assetPath = "/api/assets/asset-image-1/content";
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <TranscriptChatToolActionRow
          density="compact"
          block={{
            ts: "2026-07-25T00:00:00.000Z",
            endTs: "2026-07-25T00:00:01.000Z",
            name: "image_view",
            input: { status: "completed", path: assetPath, displayName: "evidence.png" },
            result: "{}",
            status: "completed",
          }}
        />,
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-transcript-image-target]")?.click();
      await Promise.resolve();
    });

    expect(previewLocalFile).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='inspectable-image']")?.getAttribute("data-src"))
      .toBe(assetPath);
    expect(container.querySelector("[data-testid='inspectable-image']")?.textContent).toBe("evidence.png");
  });

  it("explains when a legacy temporary image has already been cleaned up", async () => {
    readDesktopShell.mockReturnValue({ previewLocalFile });
    previewLocalFile.mockRejectedValue(
      new Error("ENOENT: no such file or directory, realpath '/tmp/expired.png'"),
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <TranscriptChatToolActionRow
          density="compact"
          block={{
            ts: "2026-07-25T00:00:00.000Z",
            name: "image_view",
            input: { status: "completed", path: "/tmp/expired.png" },
            result: "{}",
            status: "completed",
          }}
        />,
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-transcript-image-target]")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "temporary runtime folder and is no longer available",
    );
    expect(container.textContent).not.toContain("ENOENT");
  });
});
