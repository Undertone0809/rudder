// @vitest-environment jsdom

import type { ChatAttachment, ChatInlineAnnotation } from "@rudderhq/shared";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EditableResponseAnnotationsCard,
  ResponseAnnotationCountChip,
  ResponseAnnotationEditor,
  ResponseAnnotationMarker,
  SentResponseAnnotationsCard,
  placeResponseAnnotationMarker,
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
        annotationId={annotation.id}
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
    expect(marker.hasAttribute("data-chat-annotation-ignore")).toBe(true);
    click(marker);
    expect(onActivate).toHaveBeenCalledWith(marker);
    expect(marker.getAttribute("data-annotation-id")).toBe(annotation.id);
  });

  it("places a multi-line selection marker beside its final line", () => {
    expect(placeResponseAnnotationMarker(
      { left: 220, right: 300, top: 160, bottom: 180, width: 80, height: 20 },
      { left: 50, right: 650, top: 100, bottom: 500, width: 600, height: 400 },
    )).toEqual({
      left: 256,
      top: 60,
    });
  });

  it("edits a comment and accepts annotation-owned images and files", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const pendingImage = new File(["image"], "screenshot.png", { type: "image/png" });
    render(
      <ResponseAnnotationEditor
        annotation={annotation}
        ordinal={2}
        pendingFiles={[pendingImage]}
        attachments={[attachment]}
        onSave={onSave}
        onCancel={onCancel}
        onDelete={vi.fn()}
      />,
    );

    expect(host.textContent).toContain("2. Selected text:");
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

    click(host.querySelector("[aria-label='Remove screenshot.png']")!);
    click(host.querySelector("[aria-label='Remove failure-notes.pdf']")!);

    click(Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Save")!);
    expect(onSave).toHaveBeenCalledWith({
      comment: "Add a concrete example.",
      pendingFiles: [report],
      attachmentIds: [],
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("provides the pencil button as the editor anchor", () => {
    const onEdit = vi.fn();
    render(
      <EditableResponseAnnotationsCard
        annotations={[annotation]}
        pendingFilesByAnnotationId={{}}
        onEdit={onEdit}
        onDelete={vi.fn()}
      />,
    );

    const pencil = host.querySelector<HTMLButtonElement>("[aria-label='Edit annotation 1']")!;
    click(pencil);
    expect(onEdit).toHaveBeenCalledWith(annotation, pencil);
    expect(pencil.dataset.annotationId).toBe(annotation.id);
  });

  it("keeps file and comment edits local when the editor is cancelled", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const pendingImage = new File(["image"], "screenshot.png", { type: "image/png" });
    render(
      <ResponseAnnotationEditor
        annotation={annotation}
        ordinal={1}
        pendingFiles={[pendingImage]}
        attachments={[attachment]}
        onSave={onSave}
        onCancel={onCancel}
        onDelete={vi.fn()}
      />,
    );

    click(host.querySelector("[aria-label='Remove screenshot.png']")!);
    click(host.querySelector("[aria-label='Remove failure-notes.pdf']")!);
    click(Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Cancel")!);

    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("keeps the anchored portal editor open and announces aggregate validation errors", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const focusReturn = document.createElement("button");
    document.body.appendChild(focusReturn);
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = vi.fn(() => ({
      left: 0,
      right: 300,
      top: 0,
      bottom: 200,
      width: 300,
      height: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }));

    render(
      <ResponseAnnotationEditor
        annotation={annotation}
        ordinal={1}
        pendingFiles={[]}
        anchorRect={{ left: 190, right: 210, top: 60, bottom: 70, width: 20, height: 10 }}
        boundaryRect={{ left: 200, right: 520, top: 40, bottom: 500, width: 320, height: 460 }}
        returnFocusRef={{ current: focusReturn }}
        validateSave={() => "Annotations can include at most 10 files."}
        onSave={onSave}
        onCancel={onCancel}
        onDelete={vi.fn()}
      />,
    );

    expect(host.children).toHaveLength(0);
    const editor = document.body.querySelector<HTMLElement>(
      "[data-testid='chat-response-annotation-editor']",
    )!;
    expect(editor.dataset.placement).toBe("bottom");
    expect(editor.style.left).toBe("208px");
    expect(editor.style.top).toBe("78px");
    expect(editor.style.maxWidth).toBe("304px");

    click(Array.from(editor.querySelectorAll("button")).find(
      (button) => button.textContent === "Save",
    )!);
    expect(onSave).not.toHaveBeenCalled();
    expect(document.body.querySelector("[role='alert']")?.textContent)
      .toBe("Annotations can include at most 10 files.");
    expect(document.body.contains(editor)).toBe(true);

    act(() => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(focusReturn);

    HTMLElement.prototype.getBoundingClientRect = originalRect;
    focusReturn.remove();
  });

  it("dismisses an anchored editor with Escape and restores focus", () => {
    const onCancel = vi.fn();
    const focusReturn = document.createElement("button");
    document.body.appendChild(focusReturn);

    render(
      <ResponseAnnotationEditor
        annotation={annotation}
        ordinal={1}
        pendingFiles={[]}
        anchorRect={{ left: 40, right: 60, top: 100, bottom: 110, width: 20, height: 10 }}
        returnFocusRef={{ current: focusReturn }}
        onSave={vi.fn()}
        onCancel={onCancel}
        onDelete={vi.fn()}
      />,
    );

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(focusReturn);

    focusReturn.remove();
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
    expect(document.body.textContent).toContain("1. Selected text:");
    expect(document.body.textContent).toContain(annotation.selectedText);
    expect(document.body.textContent).toContain("User comment:");
    expect(document.body.textContent).toContain("When can this happen?");
    expect(document.body.textContent).toContain("failure-notes.pdf");
    expect(document.body.querySelector("textarea")).toBeNull();
    expect(document.body.querySelector("[aria-label^='Delete annotation']")).toBeNull();
    expect(document.body.querySelector("button a")).toBeNull();
    expect(document.body.querySelector("[data-annotation-id] p, [data-annotation-id] blockquote")).toBeNull();

    click(document.body.querySelector("[data-annotation-id]")!);
    expect(onSelect).toHaveBeenCalledWith(annotation, 1);
  });

  it("keeps the immutable snapshot visible when its source can no longer be located", () => {
    render(
      <SentResponseAnnotationsCard
        annotations={[annotation]}
        attachments={[]}
        unlocatableAnnotationId={annotation.id}
      />,
    );

    click(host.querySelector("[aria-label='Show 1 annotation']")!);
    expect(document.body.querySelector("[data-testid='chat-response-annotation-unlocatable']")?.textContent)
      .toBe("Source is no longer available.");
    expect(document.body.textContent).toContain(annotation.selectedText);
  });
});
