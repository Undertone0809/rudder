// @vitest-environment jsdom

import type {
  ChatWorkManifestItem,
  ChatWorkManifestResponse,
  ChatWorkManifestSubagentSummary,
} from "@rudderhq/shared";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { translateLegacyString } from "../i18n/legacyPhrases";
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

function attachmentItem(id: string, title: string, contentType: string | null = null): ChatWorkManifestItem {
  return {
    ...item(id, "output", title),
    targetType: "attachment",
    metadata: { contentType },
  };
}

function subagent(
  threadId: string,
  state: "active" | "done",
  status: ChatWorkManifestSubagentSummary["status"],
  updatedAt: string,
): ChatWorkManifestSubagentSummary {
  return {
    callId: `call-${threadId}`,
    threadId,
    sourceMessageId: `message-${threadId}`,
    runId: `run-${threadId}`,
    label: `Agent ${threadId}`,
    prompt: `Investigate ${threadId}`,
    avatarSeed: `avatar-${threadId}`,
    model: "gpt-5.6",
    reasoningEffort: "high",
    state,
    status,
    startedAt: "2026-07-29T08:00:00.000Z",
    updatedAt,
  };
}

function referenceItem(
  id: string,
  targetType: ChatWorkManifestItem["targetType"],
  title: string,
  issueStatus?: string,
): ChatWorkManifestItem {
  return {
    ...item(id, "reference", title),
    targetType,
    url: null,
    metadata: targetType === "issue" || targetType === "issue_comment"
      ? {
        issueId: id,
        commentId: targetType === "issue_comment" ? `comment-${id}` : null,
        ...(issueStatus ? { issueStatus } : {}),
      }
      : targetType === "automation"
        ? { automationId: id }
        : targetType === "chat_conversation"
          ? { conversationId: id }
          : {},
  };
}

const manifest: ChatWorkManifestResponse = {
  conversationId: "chat-1",
  totalCount: 6,
  outputs: [item("out-1", "output", "Report.md"), item("out-2", "output", "Site build")],
  sources: [item("src-1", "source", "Brief.md"), item("src-2", "source", "Data.csv"), item("src-3", "source", "Notes.txt")],
  references: [item("ref-1", "reference", "docs.example")],
  subagents: { active: [], done: [], totalCount: 0 },
  project: { id: "project-1", totalCount: 9 },
};

const handlers = {
  onOpenItem: vi.fn(),
  onOpenSubagents: vi.fn(),
  onJumpToMessage: vi.fn(),
};

const wideProps = {
  wideOpen: true,
};

describe("ChatWorkManifest", () => {
  it("localizes rendered manifest chrome while preserving item identifiers", () => {
    const localizeText = (text: string) => translateLegacyString("zh-CN", text);
    const sources = Array.from(
      { length: 7 },
      (_, index) => item(`source-${index + 1}`, "source", `Source ${index + 1}.md`),
    );
    const localizedManifest: ChatWorkManifestResponse = {
      ...manifest,
      totalCount: 12,
      outputs: [item("output-1", "output", "Report.md")],
      sources,
      references: [referenceItem("issue-1", "issue", "RUD-42", "blocked")],
      subagents: {
        active: [subagent("active-1", "active", "running", "2026-07-29T10:04:00.000Z")],
        done: [subagent("done-1", "done", "completed", "2026-07-29T10:06:00.000Z")],
        totalCount: 2,
      },
    };
    const container = render(
      <ChatWorkManifest
        manifest={localizedManifest}
        loading={false}
        error={null}
        sidePanelOpen={false}
        wideOpen
        localizeText={localizeText}
        {...handlers}
      />,
    );

    expect(container.textContent).toContain("产出");
    expect(container.textContent).toContain("来源");
    expect(container.textContent).toContain("引用");
    expect(container.textContent).toContain("子智能体");
    expect(container.textContent).toContain("1 个运行中 · 1 个已完成");
    expect(container.textContent).toContain("Report.md");
    expect(container.textContent).toContain("RUD-42");
    expect(container.querySelector("[data-file-icon='issue']")?.getAttribute("title"))
      .toBe("任务状态：阻塞");
    expect(container.querySelector("[data-testid='chat-work-manifest-subagents-summary']")?.getAttribute("aria-label"))
      .toBe("打开子智能体，1 个运行中 · 1 个已完成");
    expect(container.querySelector("button[title='跳转到来源消息']")?.getAttribute("aria-label"))
      .toBe("跳转到 Report.md 的来源消息");

    const viewAll = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("查看全部 7 项"));
    expect(viewAll).toBeTruthy();
    act(() => viewAll?.click());
    expect(viewAll?.textContent).toContain("收起");
  });

  it("renders ordered sections and website details without project work", () => {
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
    expect(text).toContain("Notes.txt");
    expect(text).not.toContain("View all 3");
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
    const outputsHeader = container.querySelector("[data-testid='chat-work-manifest-section-header-outputs']");
    const referencesHeader = container.querySelector("[data-testid='chat-work-manifest-section-header-references']");
    expect(outputsHeader?.className).toBe(referencesHeader?.className);
    expect(outputsHeader?.querySelector("svg")).not.toBeNull();
    expect(referencesHeader?.querySelector("svg")).not.toBeNull();
    const shelf = container.querySelector("[data-testid='chat-work-manifest-wide-panel']");
    const scrollRegion = container.querySelector("[data-testid='chat-work-manifest-scroll-region']");
    expect(shelf?.className).toContain("max-h-[min(32rem,calc(100dvh-8rem))]");
    expect(shelf?.className).toContain("flex-col");
    expect(scrollRegion?.className).toContain("overflow-y-auto");
    expect(scrollRegion?.className).toContain("scrollbar-auto-hide");
  });

  it("uses typed website, image, document, and attachment icons", () => {
    const fileManifest: ChatWorkManifestResponse = {
      ...manifest,
      totalCount: 7,
      outputs: [
        attachmentItem("html", "index.html", "text/html"),
        attachmentItem("image", "hero.png", "image/png"),
        attachmentItem("table", "results.csv", "text/csv"),
        attachmentItem("code", "styles.css", "text/css"),
        attachmentItem("document", "README.md", "text/markdown"),
        attachmentItem("unknown", "Artifact"),
      ],
      sources: [],
      references: [item("website", "reference", "docs.example")],
    };
    const container = render(
      <ChatWorkManifest
        manifest={fileManifest}
        loading={false}
        error={null}
        sidePanelOpen={false}
        wideOpen
        {...handlers}
      />,
    );

    const panel = container.querySelector("[data-testid='chat-work-manifest-wide-panel']");
    expect(panel?.textContent).not.toContain("View all 6");
    const iconFor = (title: string) => Array.from(panel?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .find((button) => button.title === title)
      ?.querySelector("[data-file-icon]")
      ?.getAttribute("data-file-icon");
    expect(iconFor("index.html")).toBe("website");
    expect(iconFor("hero.png")).toBe("image");
    expect(iconFor("results.csv")).toBe("document");
    expect(iconFor("styles.css")).toBe("document");
    expect(iconFor("README.md")).toBe("document");
    expect(iconFor("Artifact")).toBe("attachment");
    expect(panel?.querySelector("[data-website-icon]")).not.toBeNull();
  });

  it("uses typed icons for Rudder references", () => {
    const referenceManifest: ChatWorkManifestResponse = {
      ...manifest,
      totalCount: 4,
      outputs: [],
      sources: [],
      references: [
        referenceItem("issue-1", "issue", "ZST-1", "blocked"),
        referenceItem("automation-1", "automation", "Daily report"),
        referenceItem("chat-1", "chat_conversation", "Planning chat"),
      ],
    };
    const container = render(
      <ChatWorkManifest
        manifest={referenceManifest}
        loading={false}
        error={null}
        sidePanelOpen={false}
        wideOpen
        {...handlers}
      />,
    );

    const panel = container.querySelector("[data-testid='chat-work-manifest-wide-panel']");
    expect(panel?.textContent).not.toContain("View all 3");
    const rowFor = (title: string) => Array.from(panel?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .find((button) => button.title === title);
    const iconFor = (title: string) => rowFor(title)
      ?.querySelector("[data-file-icon]")
      ?.getAttribute("data-file-icon");
    expect(iconFor("ZST-1")).toBe("issue");
    expect(iconFor("Daily report")).toBe("automation");
    expect(iconFor("Planning chat")).toBe("chat");
    const issueIcon = rowFor("ZST-1")?.querySelector("[data-file-icon='issue']");
    expect(issueIcon?.getAttribute("data-issue-status")).toBe("blocked");
    expect(issueIcon?.getAttribute("title")).toBe("Issue status: Blocked");
    expect(issueIcon?.getAttribute("aria-hidden")).toBe("true");
    expect(issueIcon?.querySelector("[data-issue-type-icon='true']")).not.toBeNull();
    expect(issueIcon?.querySelector("[data-slot='issue-status-icon']")?.getAttribute("data-status"))
      .toBe("blocked");
    const issueRow = rowFor("ZST-1");
    const statusDescriptionId = issueRow?.getAttribute("aria-describedby");
    expect(statusDescriptionId).toBeTruthy();
    expect(container.querySelector(`[id="${statusDescriptionId}"]`)?.textContent).toBe("Issue status: Blocked");
  });

  it("keeps the full reference title accessible while constraining long rows to one truncated line", () => {
    const longTitle = "Original referenced chat title that is deliberately longer than the compact manifest shelf";
    const container = render(
      <ChatWorkManifest
        manifest={{
          ...manifest,
          totalCount: 1,
          outputs: [],
          sources: [],
          references: [referenceItem("chat-long", "chat_conversation", longTitle)],
        }}
        loading={false}
        error={null}
        sidePanelOpen={false}
        wideOpen
        {...handlers}
      />,
    );

    const row = container.querySelector<HTMLButtonElement>(`button[title="${longTitle}"]`);
    const label = row?.querySelector("span.truncate");
    expect(row?.title).toBe(longTitle);
    expect(label?.textContent).toBe(longTitle);
    expect(label?.className).toContain("block");
    expect(label?.className).toContain("truncate");
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

  it("renders subagents between Outputs and Sources with active-first avatars and counts", () => {
    handlers.onOpenSubagents.mockClear();
    const withSubagents: ChatWorkManifestResponse = {
      ...manifest,
      subagents: {
        active: [
          subagent("active-1", "active", "running", "2026-07-29T10:04:00.000Z"),
          subagent("active-2", "active", "pending", "2026-07-29T10:03:00.000Z"),
        ],
        done: [
          subagent("done-1", "done", "completed", "2026-07-29T10:06:00.000Z"),
          subagent("done-2", "done", "failed", "2026-07-29T10:05:00.000Z"),
          subagent("done-3", "done", "interrupted", "2026-07-29T10:02:00.000Z"),
        ],
        totalCount: 5,
      },
    };
    const container = render(
      <ChatWorkManifest
        manifest={withSubagents}
        loading={false}
        error={null}
        sidePanelOpen={false}
        {...wideProps}
        {...handlers}
      />,
    );

    const text = container.textContent ?? "";
    expect(text.indexOf("Outputs")).toBeLessThan(text.indexOf("Subagents"));
    expect(text.indexOf("Subagents")).toBeLessThan(text.indexOf("Sources"));
    expect(container.querySelectorAll("[data-subagent-avatar]")).toHaveLength(4);
    expect(Array.from(container.querySelectorAll("[data-subagent-avatar]")).map(
      (element) => element.getAttribute("data-subagent-avatar"),
    )).toEqual(["active-1", "active-2", "done-1", "done-2"]);
    const summary = container.querySelector<HTMLButtonElement>(
      "[data-testid='chat-work-manifest-subagents-summary']",
    );
    expect(summary?.textContent).toContain("2 active · 3 done");
    act(() => summary?.click());
    expect(handlers.onOpenSubagents).toHaveBeenCalledTimes(1);
  });

  it("shows Subagents N as the compact entry when subagents are the only work", () => {
    const onlySubagents: ChatWorkManifestResponse = {
      ...manifest,
      totalCount: 0,
      outputs: [],
      sources: [],
      references: [],
      subagents: {
        active: [],
        done: [subagent("done-only", "done", "failed", "2026-07-29T10:00:00.000Z")],
        totalCount: 1,
      },
      project: null,
    };
    const container = render(
      <ChatWorkManifest
        manifest={onlySubagents}
        loading={false}
        error={null}
        sidePanelOpen={false}
        {...wideProps}
        {...handlers}
      />,
    );

    expect(container.querySelector("[data-testid='chat-work-manifest']")).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>("[data-testid='chat-work-manifest-trigger']")?.textContent)
      .toContain("Subagents 1");
    expect(container.textContent).toContain("1 done");
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
    expect(trigger?.getAttribute("aria-controls")).toBe("chat-work-manifest-compact-panel");
    act(() => trigger?.click());
    const compactPanel = container.querySelector("[data-testid='chat-work-manifest-compact-panel']");
    expect(compactPanel?.id).toBe("chat-work-manifest-compact-panel");
    expect(compactPanel?.textContent).toContain("Report.md");
    expect(compactPanel?.className).toContain("max-h-[min(32rem,calc(100dvh-6rem))]");
    const compactOutputsHeader = compactPanel?.querySelector("[data-testid='chat-work-manifest-section-header-outputs']");
    const compactReferencesHeader = compactPanel?.querySelector("[data-testid='chat-work-manifest-section-header-references']");
    expect(compactOutputsHeader?.className).toBe(compactReferencesHeader?.className);
    const compactOutputsActionSlot = compactOutputsHeader
      ?.querySelector("[data-testid='chat-work-manifest-section-count-outputs']")
      ?.nextElementSibling;
    const compactReferencesActionSlot = compactReferencesHeader
      ?.querySelector("[data-testid='chat-work-manifest-section-count-references']")
      ?.nextElementSibling;
    expect(compactOutputsActionSlot?.className).toBe(compactReferencesActionSlot?.className);
    const closeButton = compactPanel?.querySelector<HTMLButtonElement>("button[aria-label='Close conversation files and links']");
    act(() => closeButton?.click());
    expect(container.querySelector("[data-testid='chat-work-manifest-compact-panel']")).toBeNull();
  });

  it("shows up to six items directly and expands a seventh with an accessible control", () => {
    const sources = Array.from(
      { length: 7 },
      (_, index) => item(`source-${index + 1}`, "source", `Source ${index + 1}`),
    );
    const container = render(
      <ChatWorkManifest
        manifest={{ ...manifest, totalCount: 7, outputs: [], sources, references: [] }}
        loading={false}
        error={null}
        sidePanelOpen={false}
        {...wideProps}
        {...handlers}
      />,
    );
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((candidate) => candidate.textContent?.includes("View all 7"));
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    expect(button?.getAttribute("aria-controls")).toBe("chat-work-manifest-wide-sources");
    expect(container.textContent).toContain("Source 6");
    expect(container.textContent).not.toContain("Source 7");
    act(() => button?.click());
    expect(button?.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Source 7");
    expect(button?.textContent).toContain("Show less");
  });

  it("keeps wide and compact section ids unique", () => {
    const container = render(
      <ChatWorkManifest manifest={manifest} loading={false} error={null} sidePanelOpen={false} {...wideProps} {...handlers} />,
    );
    const trigger = container.querySelector<HTMLButtonElement>("[data-testid='chat-work-manifest-trigger']");
    act(() => trigger?.click());
    const ids = Array.from(container.querySelectorAll<HTMLElement>("[id^='chat-work-manifest-']"))
      .map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("chat-work-manifest-wide-sources");
    expect(ids).toContain("chat-work-manifest-compact-sources");
  });

  it("renders a lone Outputs section without duplicating the label or add action", () => {
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
  ])("renders a lone $label section with its own count", ({ label, category }) => {
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
