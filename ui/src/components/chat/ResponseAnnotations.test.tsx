// @vitest-environment jsdom

import type { ChatAttachment, ChatInlineAnnotation } from "@rudderhq/shared";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ResponseAnnotationCountChip,
  ResponseAnnotationEditor,
  ResponseAnnotationMarker,
  SentResponseAnnotationsCard,
} from "./ResponseAnnotations";

vi.mock("../../pages/Chat.attachments", () => ({
  ChatFileAttachmentChip: ({ name, href }: { name: string; href?: string }) => (
    href ? <a href={href}>{name}</a> : <span>{name}</span>
  ),
  ChatImageAttachmentTile: ({ name }: { name: string }) => <span>{name}</span>,
  PendingAttachmentPreview: ({ file, onRemove }: { file: File; onRemove: () => void }) => (
    <span>
      {file.name}
      <button type="button" aria-label={`Remove ${file.name}`} onClick={onRemove}>Remove</button>
    </span>
  ),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const annotation: ChatInlineAnnotation = {
  id: "10000000-0000-4000-8000-000000000001",
  selectedText: "Only real send failures show Retry.",
  comment: "When can this happen?",
  sourceConversationId: "20000000-0000-4000-8000-000000000001",
  sourceMessageId: "30000000-0000-4000-8000-000000000001",
  surface: "assistant_body",
  sourceHash: "a".repeat(64),
  start: 10,
  end: 45,
  prefix: "",
  suffix: "",
  attachmentIds: ["40000000-0000-4000-8000-000000000001"],
};

const attachment: ChatAttachment = {
  id: "40000000-0000-4000-8000-000000000001",
  orgId: "50000000-0000-4000-8000-000000000001",
  conversationId: annotation.sourceConversationId,
  messageId: "60000000-0000-4000-8000-000000000001",
  assetId: "70000000-0000-4000-8000-000000000001",
  contentType: "application/pdf",
  byteSize: 42,
  sha256: "b".repeat(64),
  originalFilename: "failure-notes.pdf",
  createdByAgentId: null,
  createdByUserId: "80000000-0000-4000-8000-000000000001",
  createdAt: new Date("2026-07-23T00:00:00Z"),
  updatedAt: new Date("2026-07-23T00:00:00Z"),
  contentPath: "/api/assets/70000000-0000-4000-8000-000000000001/content",
};

let root: Root;
let host: HTMLDivElement;

function render(element: ReactElement) {
  act(() => {
    root.render(element);
  });
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:preview"),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("response annotation components", () => {
  it("shows a composer count chip that expands and can clear annotations", () => {
    const onToggle = vi.fn();
    const onClear = vi.fn();
    render(
      <ResponseAnnotationCountChip
        count={2}
        expanded={false}
        controlsId="annotation-list"
        onToggle={onToggle}
        onClear={onClear}
      />,
    );

    expect(host.textContent).toContain("2 annotations");
    expect(host.querySelector("[aria-label='Show 2 annotations']")?.getAttribute("aria-controls"))
      .toBe("annotation-list");
    click(host.querySelector("[aria-label='Show 2 annotations']")!);
    click(host.querySelector("[aria-label='Clear all annotations']")!);
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("renders a numbered keyboard-focusable source marker", () => {
    const onActivate = vi.fn();
    render(
      <ResponseAnnotationMarker
        ordinal={2}
        excerpt="Only real send failures show Retry."
        onActivate={onActivate}
      />,
    );

    const marker = host.querySelector("button")!;
    expect(marker.textContent).toBe("2");
    expect(marker.getAttribute("aria-label")).toBe(
      "Annotation 2: Only real send failures show Retry.",
    );
    click(marker);
    expect(onActivate).toHaveBeenCalledOnce();
  });

  it("edits a comment and accepts annotation-owned images and files", () => {
    const onSave = vi.fn();
    const onAddFiles = vi.fn();
    const onRemovePendingFile = vi.fn();
    const onRemoveAttachment = vi.fn();
    const pendingImage = new File(["image"], "screenshot.png", { type: "image/png" });
    render(
      <ResponseAnnotationEditor
        annotation={annotation}
        pendingFiles={[pendingImage]}
        attachments={[attachment]}
        onSave={onSave}
        onCancel={vi.fn()}
        onDelete={vi.fn()}
        onAddFiles={onAddFiles}
        onRemovePendingFile={onRemovePendingFile}
        onRemoveAttachment={onRemoveAttachment}
      />,
    );

    expect(host.textContent).toContain(annotation.selectedText);
    expect(host.textContent).toContain("screenshot.png");
    const textarea = host.querySelector("textarea")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "Add a concrete example.");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const fileInput = host.querySelector("input[type='file']") as HTMLInputElement;
    const report = new File(["report"], "report.pdf", { type: "application/pdf" });
    Object.defineProperty(fileInput, "files", { configurable: true, value: [report] });
    act(() => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onAddFiles).toHaveBeenCalledWith([report]);

    click(host.querySelector("[aria-label='Remove screenshot.png']")!);
    expect(onRemovePendingFile).toHaveBeenCalledWith(0);
    click(host.querySelector("[aria-label='Remove failure-notes.pdf']")!);
    expect(onRemoveAttachment).toHaveBeenCalledWith(attachment.id);

    click(Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Save")!);
    expect(onSave).toHaveBeenCalledWith({ comment: "Add a concrete example." });
  });

  it("renders sent annotations as an immutable ordered card with their own attachments", () => {
    const onSelect = vi.fn();
    render(
      <SentResponseAnnotationsCard
        annotations={[annotation]}
        attachments={[attachment]}
        onSelect={onSelect}
      />,
    );

    expect(host.textContent).toContain("1 annotation");
    click(host.querySelector("[aria-label='Show 1 annotation']")!);
    expect(host.textContent).toContain("1. Selected text:");
    expect(host.textContent).toContain(annotation.selectedText);
    expect(host.textContent).toContain("User comment:");
    expect(host.textContent).toContain("When can this happen?");
    expect(host.textContent).toContain("failure-notes.pdf");
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.querySelector("[aria-label^='Delete annotation']")).toBeNull();
    expect(host.querySelector("button a")).toBeNull();

    click(host.querySelector("[data-annotation-id]")!);
    expect(onSelect).toHaveBeenCalledWith(annotation);
  });
});
