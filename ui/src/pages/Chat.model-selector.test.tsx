// @vitest-environment jsdom

import type { Agent } from "@rudderhq/shared";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ChatAgentRuntimeSelector,
  ChatConversationRuntimeControls,
  chatConversationModelOptions,
  chatRuntimeSelectionLabel,
  normalizedChatRuntimeOverridesForModel,
} from "./Chat.model-selector";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  it("uses official Codex discovery ordering before static fallback additions", () => {
    const options = chatConversationModelOptions(
      makeAgent(),
      [{ id: "gpt-5.4", label: "GPT-5.4" }, { id: "gpt-5.6-sol", label: "GPT-5.6-sol" }],
      null,
    );

    expect(options.slice(0, 4).map((model) => model.id)).toEqual([
      "gpt-5.4",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
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

  it("renders model and thinking controls for the current Agent row", () => {
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
  });

  it.each([
    { width: 1633, height: 1031, left: 949, top: 659, optionsLeft: 1261, optionsTop: 659, narrow: false },
    { width: 390, height: 844, left: 16, top: 500, optionsLeft: 23, optionsTop: 172, narrow: true },
  ])("keeps runtime options aligned or separate from their panel at width $width", (viewport) => {
    const previousWidth = window.innerWidth;
    const previousHeight = window.innerHeight;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: viewport.width });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: viewport.height });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => root.render(
        <div data-runtime-profile-panel>
          <ChatConversationRuntimeControls
            agent={makeAgent()}
            adapterModels={[]}
            overrides={{ modelOverride: null, effortOverride: null }}
            onChange={() => undefined}
          />
        </div>,
      ));
      const panel = container.querySelector<HTMLElement>("[data-runtime-profile-panel]");
      const trigger = container.querySelector<HTMLButtonElement>('[data-testid="chat-effort-selector"]');
      if (!panel) throw new Error("Runtime profile panel was not rendered");
      if (!trigger) throw new Error("Thinking trigger was not rendered");
      vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({
        x: viewport.left,
        y: viewport.top,
        left: viewport.left,
        top: viewport.top,
        right: viewport.left + 304,
        bottom: viewport.top + 143,
        width: 304,
        height: 143,
        toJSON: () => ({}),
      } as DOMRect);
      vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
        x: viewport.left + 7,
        y: viewport.top + 96,
        left: viewport.left + 7,
        top: viewport.top + 96,
        right: viewport.left + 297,
        bottom: viewport.top + 136,
        width: 290,
        height: 40,
        toJSON: () => ({}),
      } as DOMRect);

      act(() => trigger.click());

      const options = document.body.querySelector<HTMLElement>('[data-testid="chat-effort-options"]');
      if (!options) throw new Error("Thinking options were not rendered");
      const expectedHeight = Math.min(
        320,
        options.querySelectorAll('[role="option"]').length * 40 + 12,
      );
      expect(options.style.left).toBe(`${viewport.optionsLeft}px`);
      expect(options.style.top).toBe(`${viewport.optionsTop}px`);
      expect(options.style.maxHeight).toBe(`${viewport.narrow ? 320 : expectedHeight}px`);
      expect(Number.parseFloat(options.style.top) + expectedHeight).toBeLessThanOrEqual(viewport.height - 12);
      if (viewport.narrow) {
        expect(Number.parseFloat(options.style.top) + Number.parseFloat(options.style.maxHeight)).toBeLessThan(viewport.top);
      }
    } finally {
      act(() => root.unmount());
      container.remove();
      Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: previousHeight });
    }
  });

  it("renders the compact current-Agent runtime entry", () => {
    const html = renderToStaticMarkup(
      <ChatAgentRuntimeSelector
        agent={makeAgent()}
        adapterModels={[]}
        overrides={{ modelOverride: null, effortOverride: null }}
        label="gpt-5.6-sol · Medium"
        onChange={() => undefined}
      />,
    );

    expect(html).toContain('data-testid="chat-agent-runtime-selector"');
    expect(html).toContain('role="menuitem"');
    expect(html).toContain("data-chat-composer-menu-item");
    expect(html).toContain("gpt-5.6-sol · Medium");
    expect(html).toContain("Configure model and thinking for Noah");
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

  it("clears a model-specific effort when switching to a model that does not expose it", () => {
    const next = normalizedChatRuntimeOverridesForModel(
      makeAgent({ agentRuntimeType: "opencode_local" }),
      { modelOverride: "opencode/model-a", effortOverride: "max" },
      "opencode/model-b",
      { id: "opencode/model-b", label: "Model B", variants: ["low", "medium", "high"] },
    );

    expect(next).toEqual({
      modelOverride: "opencode/model-b",
      effortOverride: null,
    });
  });

  it("summarizes the effective model and effort for the current Agent row", () => {
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

  it("ignores legacy conversation runtime when the composer uses Agent defaults", () => {
    expect(chatRuntimeSelectionLabel({
      agent: makeAgent({
        agentRuntimeConfig: { model: "gpt-5.6-sol", modelReasoningEffort: "high" },
      }),
      runtime: {
        sourceType: "agent",
        sourceLabel: "Legacy override",
        runtimeAgentId: "agent-1",
        agentRuntimeType: "codex_local",
        model: "gpt-5.6-terra",
        effort: "xhigh",
        available: true,
        error: null,
      },
      overrides: { modelOverride: null, effortOverride: null },
    })).toBe("gpt-5.6-sol · High");
  });
});
