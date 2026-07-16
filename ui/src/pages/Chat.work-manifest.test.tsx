// @vitest-environment jsdom

import type { ChatWorkManifestItem, ChatWorkManifestResponse } from "@rudderhq/shared";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatWorkManifest, ChatWorkManifestToggle } from "./Chat.work-manifest";

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
};

const wideProps = {
  wideOpen: true,
};

describe("ChatWorkManifest", () => {
  it("renders ordered sections, bounded rows, and website details without project work", () => {
    const container = render(
      <ChatWorkManifest
        manifest={manifest}
        loading={false}
        error={null}
        sidePanelOpen={false}
        {...wideProps}
        {...handlers}
      />,
    );

    const text = container.textContent ?? "";
    expect(text.indexOf("Outputs")).toBeLessThan(text.indexOf("Sources"));
    expect(text.indexOf("Sources")).toBeLessThan(text.indexOf("References"));
    expect(text).toContain("Report.md");
    expect(text).toContain("Brief.md");
    expect(text).not.toContain("Notes.txt");
    expect(text).toContain("View all 3");
    expect(text).not.toContain("Project work");
    expect(text).not.toContain("9 items");
    expect(text).not.toContain("Browser");
    expect(text).not.toContain("From Agent");
    expect(text).toContain("https://ref-1.example/");
    expect(container.querySelector("[data-website-icon]")).not.toBeNull();
    expect(container.querySelectorAll("section[aria-label='Outputs']").length).toBe(1);
    expect(container.querySelector("button[aria-label='Add source']")).toBeNull();
    expect(text).not.toContain("Work");
    expect(Array.from(container.querySelectorAll("span")).filter((element) => element.textContent === "Outputs")).toHaveLength(1);
    const shelf = container.querySelector("[data-testid='chat-work-manifest-wide-panel']");
    const scrollRegion = container.querySelector("[data-testid='chat-work-manifest-scroll-region']");
    expect(shelf?.className).toContain("max-h-[calc(100dvh-5rem)]");
    expect(shelf?.className).toContain("flex-col");
    expect(scrollRegion?.className).toContain("overflow-y-auto");
    expect(scrollRegion?.className).toContain("scrollbar-auto-hide");
  });

  it("does not render while loading or when thread work is empty", () => {
    const loading = render(
      <ChatWorkManifest manifest={null} loading error={null} sidePanelOpen={false} {...wideProps} {...handlers} />,
    );
    expect(loading.querySelector("[data-testid='chat-work-manifest']")).toBeNull();
    cleanup?.();
    const empty = render(
      <ChatWorkManifest
        manifest={{ ...manifest, totalCount: 0, outputs: [], sources: [], references: [], project: null }}
        loading={false}
        error={null}
        sidePanelOpen={false}
        {...wideProps}
        {...handlers}
      />,
    );
    expect(empty.querySelector("[data-testid='chat-work-manifest']")).toBeNull();
    cleanup?.();
    const projectOnly = render(
      <ChatWorkManifest
        manifest={{ ...manifest, totalCount: 0, outputs: [], sources: [], references: [] }}
        loading={false}
        error={null}
        sidePanelOpen={false}
        {...wideProps}
        {...handlers}
      />,
    );
    expect(projectOnly.querySelector("[data-testid='chat-work-manifest']")).toBeNull();
  });

  it("surfaces manifest request errors instead of treating them as empty", () => {
    const container = render(
      <ChatWorkManifest
        manifest={null}
        loading={false}
        error="Manifest unavailable"
        sidePanelOpen={false}
        {...wideProps}
        {...handlers}
      />,
    );
    expect(container.querySelector("[data-testid='chat-work-manifest']")?.textContent).toContain("Manifest unavailable");
    expect(container.querySelector("[data-testid='chat-work-manifest']")?.textContent).toContain("Conversation items");
    expect(container.querySelector("[data-testid='chat-work-manifest']")?.textContent).not.toContain("Outputs 0");
  });

  it("renders a controlled icon toggle and animatable wide state", () => {
    const onToggle = vi.fn();
    const toggle = render(<ChatWorkManifestToggle open count={manifest.totalCount} onToggle={onToggle} />);
    const button = toggle.querySelector<HTMLButtonElement>("[data-testid='chat-work-manifest-wide-toggle']");
    expect(button?.getAttribute("aria-pressed")).toBe("true");
    expect(button?.getAttribute("aria-expanded")).toBe("true");
    expect(button?.getAttribute("aria-controls")).toBe("chat-work-manifest-wide-panel");
    act(() => button?.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
    cleanup?.();

    const panel = render(
      <ChatWorkManifest
        manifest={manifest}
        loading={false}
        error={null}
        sidePanelOpen={false}
        wideOpen={false}
        {...handlers}
      />,
    );
    const shelf = panel.querySelector("[data-testid='chat-work-manifest-wide-panel']");
    expect(panel.querySelector("[data-testid='chat-work-manifest']")?.className).toContain("pointer-events-none");
    expect(shelf?.getAttribute("data-state")).toBe("closed");
    expect(shelf?.getAttribute("aria-hidden")).toBe("true");
    expect(shelf?.className).toContain("transition-");
    expect(shelf?.className).toContain("pointer-events-none");
  });

  it("uses the first category for the compact trigger", () => {
    const container = render(
      <ChatWorkManifest manifest={manifest} loading={false} error={null} sidePanelOpen={false} {...wideProps} {...handlers} />,
    );
    const trigger = container.querySelector<HTMLButtonElement>("[data-testid='chat-work-manifest-trigger']");
    expect(trigger?.textContent).toContain("Outputs 2");
    act(() => trigger?.click());
    const compactPanel = container.querySelector("[data-testid='chat-work-manifest-compact-panel']");
    expect(compactPanel?.textContent).toContain("Report.md");
    expect(compactPanel?.className).toContain("max-h-[calc(100dvh-6rem)]");
  });

  it("promotes a lone Outputs section without duplicating the label or add action", () => {
    const outputOnlyManifest = {
      ...manifest,
      totalCount: 1,
      outputs: [item("out-only", "output", "report.md")],
      sources: [],
      references: [],
      project: null,
    };
    const container = render(
      <ChatWorkManifest
        manifest={outputOnlyManifest}
        loading={false}
        error={null}
        sidePanelOpen={false}
        {...wideProps}
        {...handlers}
      />,
    );

    expect(container.querySelectorAll("section[aria-label='Outputs']")).toHaveLength(1);
    expect(Array.from(container.querySelectorAll("span")).filter((element) => element.textContent === "Outputs")).toHaveLength(1);
    expect(container.textContent).toContain("report.md");
    expect(container.textContent).not.toContain("Work");
    expect(container.querySelector("button[aria-label='Add source']")).toBeNull();
  });

  it.each([
    { label: "Sources", category: "source" as const },
    { label: "References", category: "reference" as const },
  ])("promotes a lone $label section with its own count", ({ label, category }) => {
    const singleCategoryManifest = {
      ...manifest,
      totalCount: 1,
      outputs: [],
      sources: category === "source" ? [item("source-only", category, "brief.md")] : [],
      references: category === "reference" ? [item("reference-only", category, "docs.example")] : [],
      project: null,
    };
    const container = render(
      <ChatWorkManifest
        manifest={singleCategoryManifest}
        loading={false}
        error={null}
        sidePanelOpen={false}
        {...wideProps}
        {...handlers}
      />,
    );

    expect(Array.from(container.querySelectorAll("span")).filter((element) => element.textContent === label)).toHaveLength(1);
    expect(container.querySelector<HTMLButtonElement>("[data-testid='chat-work-manifest-trigger']")?.textContent)
      .toContain(`${label} 1`);
  });

  it("preserves row open and source-message actions", () => {
    handlers.onOpenItem.mockClear();
    handlers.onJumpToMessage.mockClear();
    const container = render(
      <ChatWorkManifest manifest={manifest} loading={false} error={null} sidePanelOpen={false} {...wideProps} {...handlers} />,
    );
    const reportButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.title === "Report.md");
    const jumpButton = container.querySelector<HTMLButtonElement>("button[aria-label='Jump to source message for Report.md']");

    act(() => reportButton?.click());
    act(() => jumpButton?.click());

    expect(handlers.onOpenItem).toHaveBeenCalledWith(manifest.outputs[0]);
    expect(handlers.onJumpToMessage).toHaveBeenCalledWith("message-out-1");
  });
});
