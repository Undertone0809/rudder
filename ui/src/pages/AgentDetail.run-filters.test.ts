// @vitest-environment jsdom

import type { HeartbeatRun } from "@rudderhq/shared";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it } from "vitest";
import {
  appendRunSearchParams,
  applyRunFilters,
  applyRunSort,
  parseRunFilterState,
  runFilterChips,
  RunFiltersToolbar,
  runSkillOptions,
  writeRunFilterState,
  type RunFilterParamPatch,
  type RunFilterState,
} from "./AgentDetail.run-filters";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function run(overrides: Partial<HeartbeatRun>): HeartbeatRun {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    orgId: "org-1",
    agentId: "agent-1",
    invocationSource: "on_demand",
    triggerDetail: "manual",
    status: "succeeded",
    startedAt: null,
    finishedAt: null,
    error: null,
    wakeupRequestId: null,
    exitCode: null,
    signal: null,
    usageJson: null,
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    errorCode: null,
    externalRunId: null,
    processPid: null,
    processStartedAt: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    contextSnapshot: null,
    createdAt: new Date("2026-05-24T12:00:00.000Z"),
    updatedAt: new Date("2026-05-24T12:00:00.000Z"),
    ...overrides,
  };
}

function defaultFilterState(overrides: Partial<RunFilterState> = {}): RunFilterState {
  return {
    view: "all",
    q: "",
    statuses: [],
    sources: [],
    scenes: [],
    targets: [],
    contexts: [],
    skills: [],
    date: "all",
    customFrom: "",
    customTo: "",
    cost: [],
    sort: "newest",
    ...overrides,
  };
}

function renderToolbar({
  state = defaultFilterState(),
  onChange = () => undefined,
}: {
  state?: RunFilterState;
  onChange?: (patch: RunFilterParamPatch) => void;
} = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(RunFiltersToolbar, {
      runs: [],
      filteredCount: 0,
      state,
      onChange,
      onClear: () => undefined,
    }));
  });
  return { container, root };
}

function cleanupToolbar(root: Root, container: HTMLElement) {
  act(() => {
    root.unmount();
  });
  container.remove();
  document.body.replaceChildren();
}

describe("agent run filters", () => {
  it("parses and writes URL query state without dropping unrelated params", () => {
    const original = new URLSearchParams("tab=runs&runView=failed&runStatus=failed,timed_out&runScene=chat&runTarget=automation_run&runContext=retry&runSkill=build-advisor&runQ=process&runSort=duration_desc&runDate=custom&runFrom=2026-05-24T08:00&runTo=2026-05-24T18:00");
    const state = parseRunFilterState(original);

    expect(state.view).toBe("failed");
    expect(state.statuses).toEqual(["failed", "timed_out"]);
    expect(state.scenes).toEqual(["chat"]);
    expect(state.targets).toEqual(["automation_run"]);
    expect(state.contexts).toEqual(["retry"]);
    expect(state.skills).toEqual(["build-advisor"]);
    expect(state.q).toBe("process");
    expect(state.sort).toBe("duration_desc");
    expect(state.date).toBe("custom");
    expect(state.customFrom).toBe("2026-05-24T08:00");
    expect(state.customTo).toBe("2026-05-24T18:00");

    const next = writeRunFilterState(original, {
      view: "all",
      q: "",
      statuses: [],
      scenes: [],
      targets: [],
      contexts: [],
      skills: [],
      date: "all",
      customFrom: "",
      customTo: "",
      sort: "newest",
    });

    expect(next.get("tab")).toBe("runs");
    expect(next.get("runView")).toBeNull();
    expect(next.get("runStatus")).toBeNull();
    expect(next.get("runScene")).toBeNull();
    expect(next.get("runTarget")).toBeNull();
    expect(next.get("runContext")).toBeNull();
    expect(next.get("runSkill")).toBeNull();
    expect(next.get("runQ")).toBeNull();
    expect(next.get("runSort")).toBeNull();
    expect(next.get("runDate")).toBeNull();
    expect(next.get("runFrom")).toBeNull();
    expect(next.get("runTo")).toBeNull();
  });

  it("keeps only run filter query params on run navigation destinations", () => {
    const searchParams = new URLSearchParams("tab=runs&runStatus=failed&runScene=chat&runTarget=automation_run&runSkill=build-advisor&runSort=duration_desc&panel=details");

    expect(appendRunSearchParams("/agents/agent-1/runs/run-2", searchParams)).toBe(
      "/agents/agent-1/runs/run-2?runStatus=failed&runScene=chat&runTarget=automation_run&runSkill=build-advisor&runSort=duration_desc",
    );
    expect(appendRunSearchParams("/agents/agent-1/runs", new URLSearchParams())).toBe("/agents/agent-1/runs");
  });

  it("filters by status, issue context, retry context, used skill, token cost, and search text", () => {
    const normal = run({
      id: "11111111-0000-4000-8000-000000000000",
      resultJson: { summary: "Finished ordinary run" },
    });
    const issueRetry = run({
      id: "22222222-0000-4000-8000-000000000000",
      status: "failed",
      errorCode: "process_lost",
      retryOfRunId: "11111111-0000-4000-8000-000000000000",
      contextSnapshot: {
        issueId: "issue-1",
        recovery: {
          originalRunId: "11111111-0000-4000-8000-000000000000",
          failureKind: "process_lost",
          failureSummary: "Process lost on launch",
          recoveryTrigger: "automatic",
          recoveryMode: "continue_preferred",
        },
      },
      usageJson: {
        inputTokens: 600_000,
        cachedInputTokens: 100_000,
        outputTokens: 25_000,
      },
      resultJson: { summary: "Process lost on launch" },
    });
    const skillRun = run({
      id: "33333333-0000-4000-8000-000000000000",
      status: "failed",
      errorCode: "process_lost",
      contextSnapshot: {
        issueId: "issue-2",
        recovery: {
          originalRunId: "11111111-0000-4000-8000-000000000000",
          failureKind: "process_lost",
          failureSummary: "Process lost on launch",
          recoveryTrigger: "automatic",
          recoveryMode: "continue_preferred",
        },
      },
      usageJson: {
        inputTokens: 600_000,
        cachedInputTokens: 100_000,
        outputTokens: 25_000,
      },
      resultJson: {
        summary: "Process lost on launch",
        skillEvidenceType: "used",
        usedSkills: [{ key: "build-advisor", runtimeName: "build-advisor", name: "Build Advisor" }],
      },
    });

    const filtered = applyRunFilters([normal, issueRetry, skillRun], {
      view: "all",
      q: "launch",
      statuses: ["failed"],
      sources: [],
      scenes: [],
      targets: [],
      contexts: ["issue", "retry", "process_lost"],
      skills: ["build-advisor"],
      date: "all",
      customFrom: "",
      customTo: "",
      cost: ["high_tokens"],
      sort: "newest",
    });

    expect(filtered.map((item) => item.id)).toEqual([skillRun.id]);
  });

  it("filters by normalized agent-run scene and target type", () => {
    const chatAutomation = run({
      id: "11111111-0000-4000-8000-000000000000",
      invocationSource: "chat",
      chatConversationId: "chat-1",
      contextSnapshot: {
        scene: "chat",
        targetType: "automation_run",
        targetId: "automation-run-1",
        automationRunId: "automation-run-1",
      },
    });
    const issueRun = run({
      id: "22222222-0000-4000-8000-000000000000",
      invocationSource: "assignment",
      contextSnapshot: { issueId: "issue-1" },
    });

    const filtered = applyRunFilters([chatAutomation, issueRun], defaultFilterState({
      scenes: ["chat"],
      targets: ["automation_run"],
    }));

    expect(filtered.map((item) => item.id)).toEqual([chatAutomation.id]);
  });

  it("lists used skill filter options with run counts", () => {
    const first = run({
      id: "11111111-0000-4000-8000-000000000000",
      resultJson: {
        skillEvidenceType: "used",
        usedSkills: [{ key: "build-advisor", runtimeName: "build-advisor", name: "Build Advisor" }],
      },
    });
    const second = run({
      id: "22222222-0000-4000-8000-000000000000",
      resultJson: {
        skillEvidenceType: "used",
        usedSkillKeys: ["build-advisor", "debug-run-transcript"],
      },
    });

    expect(runSkillOptions([first, second])).toEqual([
      { key: "build-advisor", label: "build-advisor", count: 2 },
      { key: "debug-run-transcript", label: "debug-run-transcript", count: 1 },
    ]);
  });

  it("describes active filter chips for the floating toolbar", () => {
    const chips = runFilterChips({
      view: "issue",
      q: "ZST-289",
      statuses: ["succeeded"],
      sources: ["assignment"],
      scenes: ["chat"],
      targets: ["automation_run"],
      contexts: ["followup"],
      skills: ["build-advisor", "debug-run-transcript"],
      date: "7d",
      customFrom: "",
      customTo: "",
      cost: ["long"],
      sort: "duration_desc",
    });

    expect(chips).toEqual([
      "Issue work",
      "Search: ZST-289",
      "Status: Succeeded",
      "Source: Assignment",
      "Scene: Chat",
      "Target: Automation run",
      "Passive follow-up",
      "Skill: build-advisor, debug-run-transcript",
      ">30m",
      "7d",
    ]);
  });

  it("labels timer source filters as heartbeat", () => {
    expect(runFilterChips(defaultFilterState({
      sources: ["timer"],
    }))).toEqual(["Source: Heartbeat"]);
  });

  it("filters timer and manual heartbeat invocations through the normalized heartbeat scene", () => {
    const timerRun = run({
      id: "11111111-0000-4000-8000-000000000000",
      invocationSource: "timer",
      contextSnapshot: { wakeReason: "heartbeat_timer" },
    });
    const manualRun = run({
      id: "22222222-0000-4000-8000-000000000000",
      invocationSource: "on_demand",
    });

    const filtered = applyRunFilters([timerRun, manualRun], defaultFilterState({
      scenes: ["heartbeat"],
    }));

    expect(filtered.map((item) => item.id)).toEqual([timerRun.id, manualRun.id]);
    expect(runFilterChips(defaultFilterState({
      scenes: ["heartbeat"],
    }))).toEqual(["Scene: Heartbeat"]);
  });

  it("filters by custom run time bounds", () => {
    const early = run({
      id: "11111111-0000-4000-8000-000000000000",
      createdAt: new Date("2026-05-24T07:59:00"),
    });
    const inside = run({
      id: "22222222-0000-4000-8000-000000000000",
      createdAt: new Date("2026-05-24T12:00:00"),
    });
    const late = run({
      id: "33333333-0000-4000-8000-000000000000",
      createdAt: new Date("2026-05-24T18:01:00"),
    });

    const filtered = applyRunFilters([early, inside, late], defaultFilterState({
      date: "custom",
      customFrom: "2026-05-24T08:00",
      customTo: "2026-05-24T18:00",
    }));

    expect(filtered.map((item) => item.id)).toEqual([inside.id]);
  });

  it("describes custom time chips", () => {
    const chips = runFilterChips(defaultFilterState({
      date: "custom",
      customFrom: "2026-05-24T08:00",
      customTo: "2026-05-24T18:00",
    }));

    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatch(/^Custom: /);
  });

  it("sorts filtered runs by duration after filtering", () => {
    const shortRun = run({
      id: "11111111-0000-4000-8000-000000000000",
      startedAt: new Date("2026-05-24T12:00:00.000Z"),
      finishedAt: new Date("2026-05-24T12:03:00.000Z"),
      createdAt: new Date("2026-05-24T12:00:00.000Z"),
    });
    const longRun = run({
      id: "22222222-0000-4000-8000-000000000000",
      startedAt: new Date("2026-05-24T11:00:00.000Z"),
      finishedAt: new Date("2026-05-24T12:00:00.000Z"),
      createdAt: new Date("2026-05-24T11:00:00.000Z"),
    });
    const mediumRun = run({
      id: "33333333-0000-4000-8000-000000000000",
      startedAt: new Date("2026-05-24T10:00:00.000Z"),
      finishedAt: new Date("2026-05-24T10:20:00.000Z"),
      createdAt: new Date("2026-05-24T10:00:00.000Z"),
    });

    expect(applyRunSort([shortRun, longRun, mediumRun], "duration_desc").map((item) => item.id)).toEqual([
      longRun.id,
      mediumRun.id,
      shortRun.id,
    ]);
  });

  it("sorts runs by ascending token and cost totals", () => {
    const cheap = run({
      id: "11111111-0000-4000-8000-000000000000",
      usageJson: { inputTokens: 10, outputTokens: 5, costCents: 1 },
      createdAt: new Date("2026-05-24T12:00:00.000Z"),
    });
    const expensive = run({
      id: "22222222-0000-4000-8000-000000000000",
      usageJson: { inputTokens: 100, outputTokens: 50, costCents: 20 },
      createdAt: new Date("2026-05-24T11:00:00.000Z"),
    });

    expect(applyRunSort([expensive, cheap], "tokens_asc").map((item) => item.id)).toEqual([
      cheap.id,
      expensive.id,
    ]);
    expect(applyRunSort([expensive, cheap], "cost_asc").map((item) => item.id)).toEqual([
      cheap.id,
      expensive.id,
    ]);
  });

  it("uses the issue-board sort interaction for run sorting", () => {
    const patches: RunFilterParamPatch[] = [];
    const { container, root } = renderToolbar({
      onChange: (patch) => patches.push(patch),
    });

    try {
      const sortButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Sort"),
      );
      expect(sortButton?.textContent).toContain("Sort");
      expect(sortButton?.textContent).not.toContain("Newest");

      act(() => {
        sortButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });

      const createdButton = Array.from(document.body.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Created"),
      );
      const durationButton = Array.from(document.body.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Duration"),
      );
      expect(createdButton?.textContent).toContain("\u2193");

      act(() => {
        createdButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      expect(patches.at(-1)).toMatchObject({ sort: "oldest" });

      act(() => {
        durationButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      expect(patches.at(-1)).toMatchObject({ sort: "duration_asc" });
    } finally {
      cleanupToolbar(root, container);
    }
  });

  it("shows custom time inputs in the filter popover", () => {
    const patches: RunFilterParamPatch[] = [];
    const { container, root } = renderToolbar({
      onChange: (patch) => patches.push(patch),
    });

    try {
      const filterButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Filter"),
      );
      act(() => {
        filterButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });

      const customButton = Array.from(document.body.querySelectorAll("button")).find(
        (button) => button.textContent === "Custom",
      );
      act(() => {
        customButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      expect(patches.at(-1)).toMatchObject({ date: "custom" });

      act(() => {
        root.render(createElement(RunFiltersToolbar, {
          runs: [],
          filteredCount: 0,
          state: defaultFilterState({ date: "custom", customFrom: "2026-05-24T08:00" }),
          onChange: (patch) => patches.push(patch),
          onClear: () => undefined,
        }));
      });

      const fromInput = document.body.querySelector<HTMLInputElement>('input[aria-label="Custom run start time"]');
      const toInput = document.body.querySelector<HTMLInputElement>('input[aria-label="Custom run end time"]');
      expect(fromInput?.value).toBe("2026-05-24T08:00");
      expect(toInput?.value).toBe("");
    } finally {
      cleanupToolbar(root, container);
    }
  });

  it("applies consecutive filter toggles against the latest query state", () => {
    let searchParams = new URLSearchParams("runSort=duration_desc");
    const applyPatch = (patch: RunFilterParamPatch) => {
      searchParams = writeRunFilterState(searchParams, patch);
    };

    applyPatch((current) => ({ scenes: [...current.scenes, "chat"] }));
    applyPatch((current) => ({ targets: [...current.targets, "automation_run"] }));

    expect(searchParams.get("runScene")).toBe("chat");
    expect(searchParams.get("runTarget")).toBe("automation_run");
    expect(searchParams.get("runSort")).toBe("duration_desc");
  });
});
