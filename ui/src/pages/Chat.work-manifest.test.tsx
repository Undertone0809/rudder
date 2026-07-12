// @vitest-environment jsdom

import type { ChatWorkManifestItem, ChatWorkManifestResponse } from "@rudderhq/shared";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatWorkManifest } from "./Chat.work-manifest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
});

function render(element: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  cleanup = () => act(() => root.unmount());
  return container;
}

function item(id: string, category: "output" | "source" | "reference", title: string): ChatWorkManifestItem {
  return {
    id,
    orgId: "org-1",
    conversationId: "chat-1",
    projectId: "project-1",
    messageId: `message-${id}`,
    runId: category === "output" ? "run-1" : null,
    category,
    targetType: category === "reference" ? "external_url" : "library_file",
    targetKey: `target:${id}`,
    title,
    url: category === "reference" ? `https://${id}.example/` : null,
    status: "ready",
    sourceRole: category === "source" ? "user" : "assistant",
    createdByAgentId: category === "output" ? "agent-1" : null,
    createdByUserId: category === "source" ? "user-1" : null,
    metadata: category === "reference" ? { hostname: `${id}.example` } : { filePath: `${title}` },
    createdAt: new Date("2026-07-12T08:00:00.000Z"),
    updatedAt: new Date("2026-07-12T08:00:00.000Z"),
  };
}

const manifest: ChatWorkManifestResponse = {
  conversationId: "chat-1",
  totalCount: 6,
  outputs: [item("out-1", "output", "Report.md"), item("out-2", "output", "Site build")],
  sources: [item("src-1", "source", "Brief.md"), item("src-2", "source", "Data.csv"), item("src-3", "source", "Notes.txt")],
  references: [item("ref-1", "reference", "docs.example")],
  project: { id: "project-1", totalCount: 9 },
};

const handlers = {
  onOpenItem: vi.fn(),
  onJumpToMessage: vi.fn(),
  onAddSource: vi.fn(),
  onOpenProject: vi.fn(),
};

describe("ChatWorkManifest", () => {
  it("renders ordered sections, bounded rows, provenance, and a separate project roll-up", () => {
    const container = render(
      <ChatWorkManifest
        manifest={manifest}
        loading={false}
        error={null}
        sidePanelOpen={false}
        {...handlers}
      />,
    );

    const text = container.textContent ?? "";
    expect(text.indexOf("Outputs")).toBeLessThan(text.indexOf("Sources"));
    expect(text.indexOf("Sources")).toBeLessThan(text.indexOf("References"));
    expect(text).toContain("Report.md");
    expect(text).toContain("From Agent");
    expect(text).toContain("Brief.md");
    expect(text).not.toContain("Notes.txt");
    expect(text).toContain("View all 3");
    expect(text).toContain("Project work");
    expect(text).toContain("9 items");
    expect(text).not.toContain("Browser");
  });

  it("shows loading, error, and empty states with a source action", () => {
    const loading = render(
      <ChatWorkManifest manifest={null} loading error={null} sidePanelOpen={false} {...handlers} />,
    );
    expect(loading.textContent).toContain("Loading work");
    cleanup?.();
    const failed = render(
      <ChatWorkManifest manifest={null} loading={false} error="Unavailable" sidePanelOpen={false} {...handlers} />,
    );
    expect(failed.textContent).toContain("Unavailable");
    cleanup?.();
    const empty = render(
      <ChatWorkManifest
        manifest={{ ...manifest, totalCount: 0, outputs: [], sources: [], references: [], project: null }}
        loading={false}
        error={null}
        sidePanelOpen={false}
        {...handlers}
      />,
    );
    const addButton = Array.from(empty.querySelectorAll("button")).find((button) => button.textContent?.includes("Add source"));
    expect(addButton).toBeTruthy();
    act(() => addButton?.click());
    expect(handlers.onAddSource).toHaveBeenCalled();
  });

  it("exposes a compact Work count trigger", () => {
    const container = render(
      <ChatWorkManifest manifest={manifest} loading={false} error={null} sidePanelOpen={false} {...handlers} />,
    );
    const trigger = container.querySelector<HTMLButtonElement>("[data-testid='chat-work-manifest-trigger']");
    expect(trigger?.textContent).toContain("Work 6");
    act(() => trigger?.click());
    expect(container.querySelector("[data-testid='chat-work-manifest-compact-panel']")?.textContent).toContain("Report.md");
  });
});
