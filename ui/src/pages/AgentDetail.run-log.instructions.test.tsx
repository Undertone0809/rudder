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
  it("fetches and renders the full stored snapshot after opening Metadata", async () => {
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
      source: "stored_snapshot",
      completeness: "complete",
      agentInstructionStack: snapshotText,
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
    expect(container.textContent).not.toContain("Stale inline stack must not be displayed.");
    expect(container.textContent).not.toContain("Stale legacy prompt must not be displayed.");
  });
});
