// @vitest-environment jsdom

import type { HeartbeatRun, HeartbeatRunEvent } from "@rudderhq/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentRunsApi } from "../api/agent-runs";
import { agentsApi } from "../api/agents";
import { instanceSettingsApi } from "../api/instanceSettings";
import { LogViewer } from "./AgentDetail.run-log";

vi.mock("../context/I18nContext", () => ({
  useI18n: () => ({ locale: "en", t: (key: string) => key }),
}));

vi.mock("../context/SidePanelContext", () => ({
  useSidePanel: () => ({ openTarget: vi.fn() }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
}));

vi.mock("../components/transcript/useAgentRunTranscripts", () => ({
  isAgentRunTranscriptActiveStatus: (status: string | null | undefined) => status === "running" || status === "queued",
  useAgentRunTranscripts: () => ({
    transcriptByRun: new Map(),
    transcriptStateByRun: new Map(),
    transcriptNavigationByRun: new Map(),
  }),
}));

vi.mock("../components/transcript/RunTranscriptView", () => ({
  RunTranscriptView: () => null,
}));

let root: Root | null = null;

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function flushQueries() {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("Run Detail retained instruction snapshot", () => {
  it.each(["stored_snapshot", "persisted_invocation_inline"] as const)("fetches and renders the retained instruction snapshot in Metadata with distinct restored debug input: %s", async source => {
    const runId = "run-snapshot-1";
    const eventId = 17;
    const snapshotText = [
      "# Instructions retained for this Run",
      ...Array.from({ length: 80 }, (_, index) => `Rule ${index + 1}: use the recorded instruction source.`),
      "End of retained snapshot.",
    ].join("\n");
    const event: HeartbeatRunEvent = {
      id: eventId,
      orgId: "org-1",
      runId,
      agentId: "agent-1",
      seq: 1,
      eventType: "adapter.invoke",
      stream: "system",
      level: "info",
      color: null,
      message: "Agent invoked",
      payload: {
        invocationInstructionSnapshot: {
          status: "available",
          objectKey: `org-1/run-instruction-snapshots/${"a".repeat(64)}`,
          sha256: "a".repeat(64),
          byteSize: 1024,
        },
        invocationContent: { textStored: false, textSource: "agent_run_transcript_reader" },
        agentRuntimeType: "codex_local",
        command: "rudder",
        commandArgs: ["agent", "run"],
        commandNotes: ["Verbose command note for the retained invocation."],
        loadedSkills: [{ name: "verbose-skill-evidence" }],
        agentInstructionStack: "Stale inline stack must not be displayed.",
        prompt: "Stale legacy prompt must not be displayed.",
      },
      createdAt: new Date("2026-09-29T00:00:00.000Z"),
    };
    const run = {
      id: runId,
      orgId: "org-1",
      agentId: "agent-1",
      status: "succeeded",
      invocationSource: "test",
      triggerDetail: null,
      startedAt: new Date("2026-09-29T00:00:00.000Z"),
      finishedAt: new Date("2026-09-29T00:00:01.000Z"),
      createdAt: new Date("2026-09-29T00:00:00.000Z"),
      contextSnapshot: null,
    } as unknown as HeartbeatRun;

    vi.spyOn(agentRunsApi, "events").mockResolvedValue([event]);
    vi.spyOn(agentRunsApi, "allEvents").mockResolvedValue([event]);
    const fetchSnapshot = vi.spyOn(agentRunsApi, "invocationInstructions").mockResolvedValue({
      source,
      completeness: "complete",
      agentInstructionStack: snapshotText,
      prompt: "exact unique debug input 原文🙂",
      sha256: "a".repeat(64),
      byteSize: 1024,
    });
    vi.spyOn(agentRunsApi, "workspaceOperations").mockResolvedValue([]);
    vi.spyOn(agentsApi, "list").mockResolvedValue([]);
    vi.spyOn(instanceSettingsApi, "getGeneral").mockResolvedValue({} as Awaited<ReturnType<typeof instanceSettingsApi.getGeneral>>);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <LogViewer run={run} agentRuntimeType="codex_local" />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });
    await flushQueries();

    const metadataTab = Array.from(container.querySelectorAll<HTMLButtonElement>("[role='tab']"))
      .find((tab) => tab.textContent?.includes("Metadata"));
    expect(metadataTab).toBeDefined();
    expect(metadataTab?.querySelector('[role="tooltip"]')?.textContent)
      .toBe("Run metadata and the instruction snapshot used for this Run");
    expect(fetchSnapshot).not.toHaveBeenCalled();
    await act(async () => {
      metadataTab!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      metadataTab!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
      await Promise.resolve();
    });
    await flushQueries();

    expect(metadataTab!.getAttribute("data-state")).toBe("active");
    expect(fetchSnapshot).toHaveBeenCalledWith(runId, eventId);
    const renderedSnapshot = container.querySelector<HTMLElement>("[data-testid='invocation-prompt']");
    expect(renderedSnapshot).not.toBeNull();
    expect(renderedSnapshot!.textContent).toBe(snapshotText);
    expect(renderedSnapshot!.className).toContain("max-h-[min(60vh,34rem)]");
    expect(renderedSnapshot!.className).toContain("overflow-y-auto");
    expect(renderedSnapshot!.className).toContain("scrollbar-auto-hide");
    expect(renderedSnapshot!.getAttribute("tabindex")).toBe("0");
    expect(renderedSnapshot!.textContent).toContain("Rule 80: use the recorded instruction source.");
    const renderedText = container.textContent ?? "";
    expect(renderedText.indexOf("Runtime: codex_local")).toBeLessThan(renderedText.indexOf("Command: rudder agent run"));
    expect(renderedText.indexOf("Command: rudder agent run")).toBeLessThan(renderedText.indexOf("Injected Agent Instruction Stack"));
    expect(renderedText.indexOf("Injected Agent Instruction Stack")).toBeLessThan(renderedText.indexOf("Command notes"));
    expect(renderedText.indexOf("Command notes")).toBeLessThan(renderedText.indexOf("Skill usage"));
    expect(container.querySelector('[data-testid="invocation-debug-input"]')?.textContent?.trim()).toBe("exact unique debug input 原文🙂");
    expect(container.textContent).not.toContain("Stale inline stack must not be displayed.");
    expect(container.textContent).not.toContain("Stale legacy prompt must not be displayed.");
  });

  it("keeps Metadata and avoids promising a snapshot when none was retained", async () => {
    const event = {
      id: 18, orgId: "org-1", runId: "run-without-snapshot", agentId: "agent-1", seq: 1,
      eventType: "adapter.invoke", stream: "system", level: "info", color: null,
      message: "Agent invoked", payload: { agentInstructionStack: "Inline legacy details" },
      createdAt: new Date("2026-09-29T00:00:00.000Z"),
    } as HeartbeatRunEvent;
    const run = {
      id: event.runId, orgId: event.orgId, agentId: event.agentId,
      status: "succeeded", invocationSource: "test", triggerDetail: null,
      startedAt: event.createdAt, finishedAt: event.createdAt,
      createdAt: event.createdAt, contextSnapshot: null,
    } as unknown as HeartbeatRun;
    vi.spyOn(agentRunsApi, "events").mockResolvedValue([event]);
    vi.spyOn(agentRunsApi, "allEvents").mockResolvedValue([event]);
    vi.spyOn(agentRunsApi, "workspaceOperations").mockResolvedValue([]);
    vi.spyOn(agentsApi, "list").mockResolvedValue([]);
    vi.spyOn(instanceSettingsApi, "getGeneral").mockResolvedValue({} as Awaited<ReturnType<typeof instanceSettingsApi.getGeneral>>);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<QueryClientProvider client={queryClient}><LogViewer run={run} agentRuntimeType="codex_local" /></QueryClientProvider>);
    });
    await flushQueries();

    const metadataTab = Array.from(container.querySelectorAll<HTMLButtonElement>("[role='tab']"))
      .find((tab) => tab.textContent?.includes("Metadata"));
    expect(metadataTab).toBeDefined();
    expect(metadataTab?.querySelector('[role="tooltip"]')?.textContent)
      .toBe("Runtime metadata and any available instruction details for this Run");
    await act(async () => {
      metadataTab!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      metadataTab!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
      await Promise.resolve();
    });
    await flushQueries();
    expect(container.querySelector('[data-testid="invocation-prompt"]')?.textContent)
      .toContain("Inline legacy details");
  });

  it("shows a loading state while the retained instruction snapshot is being read", async () => {
    const runId = "run-snapshot-pending";
    const eventId = 19;
    const event: HeartbeatRunEvent = {
      id: eventId,
      orgId: "org-1",
      runId,
      agentId: "agent-1",
      seq: 1,
      eventType: "adapter.invoke",
      stream: "system",
      level: "info",
      color: null,
      message: "Agent invoked",
      payload: {
        invocationInstructionSnapshot: {
          status: "available",
          objectKey: `org-1/run-instruction-snapshots/${"b".repeat(64)}`,
          sha256: "b".repeat(64),
          byteSize: 128,
        },
        invocationContent: { textStored: true, textSource: "stored_snapshot" },
      },
      createdAt: new Date("2026-09-29T00:00:00.000Z"),
    };
    const run = {
      id: runId,
      orgId: "org-1",
      agentId: "agent-1",
      status: "succeeded",
      invocationSource: "test",
      triggerDetail: null,
      startedAt: event.createdAt,
      finishedAt: event.createdAt,
      createdAt: event.createdAt,
      contextSnapshot: null,
    } as unknown as HeartbeatRun;
    type InstructionSnapshot = Awaited<ReturnType<typeof agentRunsApi.invocationInstructions>>;
    let resolveSnapshot!: (value: InstructionSnapshot) => void;
    const snapshotPromise = new Promise<InstructionSnapshot>((resolve) => {
      resolveSnapshot = resolve;
    });
    const fetchSnapshot = vi.spyOn(agentRunsApi, "invocationInstructions").mockReturnValue(snapshotPromise);
    vi.spyOn(agentRunsApi, "events").mockResolvedValue([event]);
    vi.spyOn(agentRunsApi, "allEvents").mockResolvedValue([event]);
    vi.spyOn(agentRunsApi, "workspaceOperations").mockResolvedValue([]);
    vi.spyOn(agentsApi, "list").mockResolvedValue([]);
    vi.spyOn(instanceSettingsApi, "getGeneral").mockResolvedValue({} as Awaited<ReturnType<typeof instanceSettingsApi.getGeneral>>);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<QueryClientProvider client={queryClient}><LogViewer run={run} agentRuntimeType="codex_local" /></QueryClientProvider>);
    });
    await flushQueries();

    const metadataTab = Array.from(container.querySelectorAll<HTMLButtonElement>("[role='tab']"))
      .find((tab) => tab.textContent?.includes("Metadata"));
    expect(metadataTab).toBeDefined();
    await act(async () => {
      metadataTab!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      metadataTab!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
      await Promise.resolve();
    });
    await flushQueries();

    expect(fetchSnapshot).toHaveBeenCalledWith(runId, eventId);
    expect(container.querySelector('[data-testid="invocation-content-summary"]')?.textContent)
      .toContain("Loading the injected instruction snapshot");
    expect(container.querySelector('[data-testid="invocation-prompt"]')).toBeNull();

    const instructionStack = "The exact instructions retained for this run.";
    await act(async () => {
      resolveSnapshot({
        source: "stored_snapshot",
        completeness: "complete",
        agentInstructionStack: instructionStack,
        sha256: "b".repeat(64),
        byteSize: 128,
      });
      await snapshotPromise;
    });
    await flushQueries();

    expect(container.querySelector('[data-testid="invocation-prompt"]')?.textContent)
      .toBe(instructionStack);
  });

  it("explains when a retained instruction snapshot cannot be read", async () => {
    const runId = "run-snapshot-unavailable";
    const eventId = 20;
    const event: HeartbeatRunEvent = {
      id: eventId,
      orgId: "org-1",
      runId,
      agentId: "agent-1",
      seq: 1,
      eventType: "adapter.invoke",
      stream: "system",
      level: "info",
      color: null,
      message: "Agent invoked",
      payload: {
        invocationInstructionSnapshot: {
          status: "available",
          objectKey: `org-1/run-instruction-snapshots/${"c".repeat(64)}`,
          sha256: "c".repeat(64),
          byteSize: 128,
        },
        invocationContent: { textStored: true, textSource: "stored_snapshot" },
      },
      createdAt: new Date("2026-09-29T00:00:00.000Z"),
    };
    const run = {
      id: runId,
      orgId: "org-1",
      agentId: "agent-1",
      status: "succeeded",
      invocationSource: "test",
      triggerDetail: null,
      startedAt: event.createdAt,
      finishedAt: event.createdAt,
      createdAt: event.createdAt,
      contextSnapshot: null,
    } as unknown as HeartbeatRun;

    vi.spyOn(agentRunsApi, "events").mockResolvedValue([event]);
    vi.spyOn(agentRunsApi, "allEvents").mockResolvedValue([event]);
    vi.spyOn(agentRunsApi, "invocationInstructions").mockRejectedValue(new Error("snapshot read failed"));
    vi.spyOn(agentRunsApi, "workspaceOperations").mockResolvedValue([]);
    vi.spyOn(agentsApi, "list").mockResolvedValue([]);
    vi.spyOn(instanceSettingsApi, "getGeneral").mockResolvedValue({} as Awaited<ReturnType<typeof instanceSettingsApi.getGeneral>>);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<QueryClientProvider client={queryClient}><LogViewer run={run} agentRuntimeType="codex_local" /></QueryClientProvider>);
    });
    await flushQueries();

    const metadataTab = Array.from(container.querySelectorAll<HTMLButtonElement>("[role='tab']"))
      .find((tab) => tab.textContent?.includes("Metadata"));
    expect(metadataTab).toBeDefined();
    await act(async () => {
      metadataTab!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      metadataTab!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
      await Promise.resolve();
    });
    await flushQueries();

    expect(container.querySelector('[data-testid="invocation-content-summary"]')?.textContent)
      .toContain("Stored instruction snapshot could not be read");
    expect(container.querySelector('[data-testid="invocation-content-summary"]')?.textContent)
      .toContain("Current Agent files are not a historical substitute");
    expect(container.querySelector('[data-testid="invocation-prompt"]')).toBeNull();
  });
});
