import type { Agent } from "@rudderhq/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatConversationModelSelect, chatConversationModelOptions } from "./Chat.model-selector";

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
      <ChatConversationModelSelect
        agent={makeAgent()}
        adapterModels={[]}
        modelOverride={null}
        error={new Error("Model discovery failed")}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain("Model discovery failed");
  });
});
