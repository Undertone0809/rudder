// @vitest-environment jsdom

import type { ChatAttachment, ChatInlineAnnotation } from "@rudderhq/shared";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DraftResponseAnnotationsPopover,
  EditableResponseAnnotationsCard,
  ResponseAnnotationCountChip,
  ResponseAnnotationEditor,
  ResponseAnnotationMarker,
  SentResponseAnnotationsCard,
  avoidResponseAnnotationMarkerCollisions,
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
  document.querySelectorAll("[data-testid='chat-response-annotation-editor-exit']")
    .forEach((element) => element.remove());
  host.remove();
  vi.useRealTimers();
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

  it("places a selection marker after the complete visual line instead of over following text", () => {
    expect(placeResponseAnnotationMarker(
      { left: 220, right: 300, top: 160, bottom: 180, width: 80, height: 20 },
      { left: 50, right: 650, top: 100, bottom: 500, width: 600, height: 400 },
      { viewportWidth: 1_000, markerSize: 28, gap: 6, padding: 8 },
    )).toEqual({
      left: 256,
      top: 56,
    });
  });

  it("moves a selection marker before the complete visual line when its right side would clip", () => {
    expect(placeResponseAnnotationMarker(
      { left: 620, right: 660, top: 160, bottom: 180, width: 40, height: 20 },
      { left: 50, right: 650, top: 100, bottom: 500, width: 600, height: 400 },
      { viewportWidth: 670, markerSize: 28, gap: 6, padding: 8 },
    )).toEqual({
      left: 536,
      top: 56,
    });
  });

  it("keeps a narrow-screen marker inside the viewport when neither side gutter fits", () => {
    expect(placeResponseAnnotationMarker(
      { left: 10, right: 382, top: 160, bottom: 180, width: 372, height: 20 },
      { left: 8, right: 382, top: 100, bottom: 500, width: 374, height: 400 },
      { viewportWidth: 390, markerSize: 44, gap: 6, padding: 8 },
    )).toEqual({
      left: 330,
      top: 86,
    });
  });

  it("moves a narrow-screen marker past following text when no side gutter fits", () => {
    expect(placeResponseAnnotationMarker(
      { left: 10, right: 382, top: 160, bottom: 180, width: 372, height: 20 },
      { left: 8, right: 382, top: 100, bottom: 500, width: 374, height: 400 },
      {
        viewportWidth: 390,
        markerSize: 44,
        gap: 6,
        padding: 8,
        textRects: [
          { left: 10, right: 382, top: 182, bottom: 202, width: 372, height: 20 },
          { left: 10, right: 382, top: 204, bottom: 224, width: 372, height: 20 },
        ],
      },
    )).toEqual({
      left: 330,
      top: 130,
    });
  });

  it("spreads same-line markers horizontally before falling back to another row", () => {
    expect(avoidResponseAnnotationMarkerCollisions([
      { id: "annotation-2", left: 256, top: 60 },
      { id: "annotation-1", left: 256, top: 60 },
      { id: "annotation-3", left: 256, top: 120 },
    ], 28, 2, { minLeft: -42, maxLeft: 316 })).toEqual({
      "annotation-1": { left: 256, top: 60 },
      "annotation-2": { left: 286, top: 60 },
      "annotation-3": { left: 256, top: 120 },
    });
  });

  it("keeps collision-shifted narrow-screen markers clear of following text", () => {
    expect(avoidResponseAnnotationMarkerCollisions([
      { id: "annotation-1", left: 330, top: 86, direction: -1 },
      { id: "annotation-2", left: 330, top: 86, direction: -1 },
    ], 44, 2, { minLeft: 0, maxLeft: 330 }, [
      { left: 2, right: 322, top: 82, bottom: 102, width: 320, height: 20 },
    ])).toEqual({
      "annotation-1": { left: 330, top: 86 },
      "annotation-2": { left: 330, top: 132 },
    });
  });

  it("edits a comment without a visible redundant label and accepts picked or pasted files", () => {
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
    expect(host.textContent).not.toContain("User comment:");
    const filePicker = host.querySelector<HTMLLabelElement>(
      "label[aria-label='Add images or files']",
    );
    expect(filePicker).not.toBeNull();
    expect(filePicker?.textContent?.trim()).toBe("");
    expect(filePicker?.getAttribute("title")).toBe("Add images or files");
    const textarea = host.querySelector("textarea")!;
    expect(textarea.getAttribute("aria-label")).toBe("Comment");
    const pastedImage = new File(["pasted"], "pasted-image.png", { type: "image/png" });
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      configurable: true,
      value: { files: [pastedImage] },
    });
    act(() => {
      textarea.dispatchEvent(pasteEvent);
    });
    expect(pasteEvent.defaultPrevented).toBe(true);
    expect(host.textContent).toContain("pasted-image.png");
    const textPasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(textPasteEvent, "clipboardData", {
      configurable: true,
      value: { files: [] },
    });
    act(() => {
      textarea.dispatchEvent(textPasteEvent);
    });
    expect(textPasteEvent.defaultPrevented).toBe(false);
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
      pendingFiles: [pastedImage, report],
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

  it("opens draft details above the composer without mounting the card in composer layout", () => {
    const secondAnnotation: ChatInlineAnnotation = {
      ...annotation,
      id: "10000000-0000-4000-8000-000000000002",
      selectedText: "A second draft quote.",
      start: 50,
      end: 71,
      attachmentIds: [],
    };
    const onOpenChange = vi.fn();
    const onEdit = vi.fn();
    render(
      <DraftResponseAnnotationsPopover
        annotations={[annotation, secondAnnotation]}
        pendingFilesByAnnotationId={{}}
        open={false}
        onOpenChange={onOpenChange}
        onClear={vi.fn()}
        onEdit={onEdit}
        onDelete={vi.fn()}
      />,
    );

    click(host.querySelector("[aria-label='Show 2 annotations']")!);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    render(
      <DraftResponseAnnotationsPopover
        annotations={[annotation, secondAnnotation]}
        pendingFilesByAnnotationId={{}}
        open
        onOpenChange={onOpenChange}
        onClear={vi.fn()}
        onEdit={onEdit}
        onDelete={vi.fn()}
      />,
    );
    const card = document.body.querySelector<HTMLElement>(
      "[data-testid='chat-response-annotation-card']",
    )!;
    const popover = card.closest<HTMLElement>(
      "[data-testid='chat-response-annotations-draft-popover']",
    )!;
    expect(card).not.toBeNull();
    expect(host.contains(card)).toBe(false);
    expect(card.closest("[data-side='top']")).not.toBeNull();
    expect(popover.className).toContain("overflow-y-auto");
    expect(popover.className).toContain("--radix-popover-content-available-height");

    click(card.querySelector("[aria-label='Edit annotation 2']")!);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(onEdit).toHaveBeenCalledWith(secondAnnotation);
  });

  it("animates the single editor out before completing Cancel", () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    const onCancel = vi.fn();
    render(
      <ResponseAnnotationEditor
        annotation={annotation}
        ordinal={1}
        pendingFiles={[]}
        onSave={vi.fn()}
        onCancel={onCancel}
        onDelete={vi.fn()}
      />,
    );

    const editor = host.querySelector<HTMLElement>(
      "[data-testid='chat-response-annotation-editor']",
    )!;
    click(Array.from(editor.querySelectorAll("button")).find(
      (button) => button.textContent === "Cancel",
    )!);
    expect(editor.dataset.state).toBe("closed");
    expect(onCancel).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(onCancel).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("commits Save immediately even when exit motion is enabled", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    const onSave = vi.fn();
    render(
      <ResponseAnnotationEditor
        annotation={annotation}
        ordinal={1}
        pendingFiles={[]}
        onSave={onSave}
        onCancel={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    click(Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "Save",
    )!);
    expect(onSave).toHaveBeenCalledOnce();
    expect(document.body.querySelector(
      "[data-testid='chat-response-annotation-editor-exit']",
    )?.getAttribute("data-state")).toBe("closed");
  });

  it("commits Delete immediately while preserving an exit snapshot", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    const onDelete = vi.fn();
    render(
      <ResponseAnnotationEditor
        annotation={annotation}
        ordinal={1}
        pendingFiles={[]}
        onSave={vi.fn()}
        onCancel={vi.fn()}
        onDelete={onDelete}
      />,
    );

    click(host.querySelector("[aria-label='Delete annotation']")!);
    expect(onDelete).toHaveBeenCalledOnce();
    expect(document.body.querySelector(
      "[data-testid='chat-response-annotation-editor-exit']",
    )?.getAttribute("data-state")).toBe("closed");
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

  it("keeps the last anchor position when the source button is replaced", async () => {
    render(
      <ResponseAnnotationEditor
        annotation={annotation}
        ordinal={1}
        pendingFiles={[]}
        anchorRect={{ left: 40, right: 60, top: 100, bottom: 110, width: 20, height: 10 }}
        getAnchorRect={() => null}
        onSave={vi.fn()}
        onCancel={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    await act(async () => Promise.resolve());
    const editor = document.body.querySelector<HTMLElement>(
      "[data-testid='chat-response-annotation-editor']",
    )!;
    expect(editor.style.visibility).toBe("visible");
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
    expect(document.body.textContent).not.toContain("User comment:");
    expect(document.body.textContent).toContain("When can this happen?");
    expect(document.body.textContent).toContain("failure-notes.pdf");
    expect(document.body.querySelector("textarea")).toBeNull();
    expect(document.body.querySelector("[aria-label^='Delete annotation']")).toBeNull();
    expect(document.body.querySelector("button a")).toBeNull();
    expect(document.body.querySelector("[data-annotation-id] p, [data-annotation-id] blockquote")).toBeNull();

    click(document.body.querySelector("[data-annotation-id]")!);
    expect(onSelect).toHaveBeenCalledWith(annotation, 1);
  });

  it("dismisses sent annotation details with Escape and restores focus", () => {
    const onExpandedChange = vi.fn();
    render(
      <SentResponseAnnotationsCard
        annotations={[annotation]}
        attachments={[]}
        onExpandedChange={onExpandedChange}
      />,
    );

    const chip = host.querySelector<HTMLButtonElement>(
      "[aria-label='Show 1 annotation']",
    )!;
    click(chip);
    expect(document.body.querySelector("[data-testid='chat-response-annotation-sent-card']"))
      .not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }));
    });

    expect(document.body.querySelector("[data-testid='chat-response-annotation-sent-card']"))
      .toBeNull();
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(chip);
    expect(onExpandedChange.mock.calls).toEqual([[true], [false]]);
  });

  it("dismisses sent details on outside click and keeps only one sent card open", () => {
    const secondAnnotation: ChatInlineAnnotation = {
      ...annotation,
      id: "10000000-0000-4000-8000-000000000002",
      selectedText: "A second immutable quote.",
      start: 50,
      end: 75,
    };
    const firstExpanded = vi.fn();
    const secondExpanded = vi.fn();
    render(
      <>
        <SentResponseAnnotationsCard
          annotations={[annotation]}
          attachments={[]}
          onExpandedChange={firstExpanded}
        />
        <SentResponseAnnotationsCard
          annotations={[secondAnnotation]}
          attachments={[]}
          onExpandedChange={secondExpanded}
        />
      </>,
    );

    const chips = host.querySelectorAll<HTMLButtonElement>(
      "[aria-label='Show 1 annotation']",
    );
    click(chips[0]!);
    click(chips[1]!);
    expect(document.body.querySelectorAll(
      "[data-testid='chat-response-annotation-sent-card']",
    )).toHaveLength(1);
    expect(firstExpanded.mock.calls).toEqual([[true], [false]]);
    expect(secondExpanded.mock.calls).toEqual([[true]]);

    act(() => {
      document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.body.querySelector("[data-testid='chat-response-annotation-sent-card']"))
      .toBeNull();
    expect(secondExpanded.mock.calls).toEqual([[true], [false]]);
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
