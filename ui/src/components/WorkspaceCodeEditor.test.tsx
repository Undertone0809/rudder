// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { requestChatFileAnnotationLocation } from "@/lib/chat-file-annotation-events";
import { hashChatAnnotationSource } from "@/lib/chat-response-annotation-selection";
import { WorkspaceCodeEditor } from "./WorkspaceCodeEditor";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const originalGetClientRects = Range.prototype.getClientRects;

describe("WorkspaceCodeEditor", () => {
  beforeAll(() => {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  });

  afterAll(() => {
    Range.prototype.getClientRects = originalGetClientRects;
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("does not report a parent-controlled document replacement as a user edit", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const onChange = vi.fn();

    act(() => {
      root.render(
        <WorkspaceCodeEditor
          filePath="example.ts"
          value="const value = 1;"
          onChange={onChange}
        />,
      );
    });
    act(() => {
      root.render(
        <WorkspaceCodeEditor
          filePath="example.ts"
          value="const value = 2;"
          onChange={onChange}
        />,
      );
    });

    expect(host.textContent).toContain("const value = 2;");
    expect(onChange).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("reveals the exact persisted annotation range", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const value = "alpha beta gamma";

    act(() => {
      root.render(
        <WorkspaceCodeEditor
          annotationSource={{
            surface: "workspace_file",
            sourceFilePath: "example.ts",
          }}
          filePath="example.ts"
          value={value}
        />,
      );
    });
    const sourceHash = await hashChatAnnotationSource(value);
    await act(async () => {
      requestChatFileAnnotationLocation({
        surface: "workspace_file",
        sourceFilePath: "example.ts",
        sourceHash,
        sourceRenderMode: "text",
        start: 6,
        end: 10,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect((host.firstElementChild as HTMLElement).dataset.annotationLocationStart)
        .toBe("6");
      expect((host.firstElementChild as HTMLElement).dataset.annotationLocationEnd)
        .toBe("10");
    });
    act(() => root.unmount());
  });
});
