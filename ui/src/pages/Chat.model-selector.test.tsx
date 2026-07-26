import type { Agent } from "@rudderhq/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ChatConversationRuntimeControls,
  chatConversationModelOptions,
  chatRuntimeSelectionLabel,
  normalizedChatRuntimeOverridesForModel,
} from "./Chat.model-selector";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    orgId: "org-1",
    name: "Noah",
    urlKey: "noah",
    role: "engineer",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    agentRuntimeType: "codex_local",
    agentRuntimeConfig: { model: "gpt-5.6-sol" },
    runtimeConfig: { model: "gpt-5.6-sol" },
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: {
      canCreateAgents: false,
      canManageSkills: false,
    },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-07-23T00:00:00.000Z"),
    updatedAt: new Date("2026-07-23T00:00:00.000Z"),
    ...overrides,
  };
}

describe("chat conversation model options", () => {
  it("keeps the runtime-owned Codex ordering instead of discovery ordering", () => {
    const options = chatConversationModelOptions(
      makeAgent(),
      [{ id: "gpt-5.4", label: "GPT-5.4" }, { id: "gpt-5.6-sol", label: "GPT-5.6-sol" }],
      null,
    );

    expect(options.slice(0, 4).map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
  });

  it("keeps a persisted custom model visible without creating a free-input option", () => {
    const options = chatConversationModelOptions(
      makeAgent({ agentRuntimeType: "pi_local" }),
      [{ id: "openrouter/known", label: "Known" }],
      "custom/private-model",
    );

    expect(options).toEqual([
      { id: "openrouter/known", label: "Known" },
      { id: "custom/private-model", label: "custom/private-model" },
    ]);
  });

  it("announces model discovery failures even when fallback options remain", () => {
    const html = renderToStaticMarkup(
      <ChatConversationRuntimeControls
        agent={makeAgent()}
        adapterModels={[]}
        overrides={{ modelOverride: null, effortOverride: null }}
        error={new Error("Model discovery failed")}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain("Model discovery failed");
  });

  it("renders model and thinking controls without an Agent picker", () => {
    const html = renderToStaticMarkup(
      <ChatConversationRuntimeControls
        agent={makeAgent({
          agentRuntimeConfig: {
            model: "gpt-5.6-sol",
            modelReasoningEffort: "high",
          },
        })}
        adapterModels={[]}
        overrides={{ modelOverride: null, effortOverride: null }}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain('data-testid="chat-model-selector"');
    expect(html).toContain('data-testid="chat-effort-selector"');
    expect(html).toContain(">gpt-5.6-sol<");
    expect(html).toContain(">High<");
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain("lucide-chevron-right");
    expect(html).not.toContain(">Agents<");
  });

  it("preserves Agent effort inheritance when runtime derivation must fall back to Auto", () => {
    const next = normalizedChatRuntimeOverridesForModel(
      makeAgent({
          agentRuntimeConfig: {
            model: "gpt-5.6-sol",
            modelReasoningEffort: "ultra",
          },
      }),
      { modelOverride: null, effortOverride: null },
      "gpt-5.5",
    );

    expect(next).toEqual({
      modelOverride: "gpt-5.5",
      effortOverride: null,
    });
  });

  it("summarizes the effective conversation model and effort for the composer pill", () => {
    expect(chatRuntimeSelectionLabel({
      agent: makeAgent(),
      runtime: {
        sourceType: "agent",
        sourceLabel: "Noah",
        runtimeAgentId: "agent-1",
        agentRuntimeType: "codex_local",
        model: "gpt-5.6-terra",
        effort: "medium",
        available: true,
        error: null,
      },
      overrides: {
        modelOverride: "gpt-5.6-terra",
        effortOverride: "high",
      },
    })).toBe("gpt-5.6-terra · High");

    expect(chatRuntimeSelectionLabel({
      agent: makeAgent(),
      runtime: null,
      overrides: {
        modelOverride: "gpt-5.6-terra",
        effortOverride: "xhigh",
      },
    })).toBe("gpt-5.6-terra · Extra High");
  });
});
