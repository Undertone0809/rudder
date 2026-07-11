// @vitest-environment jsdom

import type { ReactElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelDropdown } from "./AgentConfigForm.model-dropdown";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  document.body.innerHTML = "";
});

function render(element: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  cleanupFn = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };

  act(() => {
    root.render(element);
  });

  return container;
}

describe("ModelDropdown", () => {
  it("preserves the caller-provided model order when requested", () => {
    render(
      <ModelDropdown
        label="Model"
        models={[
          { id: "gpt-5.6-sol", label: "GPT-5.6-sol" },
          { id: "gpt-5.6-terra", label: "GPT-5.6-terra" },
          { id: "gpt-5.6-luna", label: "GPT-5.6-luna" },
          { id: "gpt-5.5", label: "GPT-5.5" },
          { id: "gpt-5.4", label: "GPT-5.4" },
          { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
          { id: "gpt-5.2", label: "GPT-5.2" },
        ]}
        value=""
        onChange={() => {}}
        open
        onOpenChange={() => {}}
        allowDefault={false}
        required={false}
        groupByProvider={false}
        emptyLabel="Default"
        preserveModelOrder
      />,
    );

    const modelLabels = Array.from(document.querySelectorAll("button"))
      .map((button) => button.textContent?.trim())
      .filter((label) => label?.startsWith("GPT-"));

    expect(modelLabels).toEqual([
      "GPT-5.6-sol",
      "GPT-5.6-terra",
      "GPT-5.6-luna",
      "GPT-5.5",
      "GPT-5.4",
      "GPT-5.4 Mini",
      "GPT-5.2",
    ]);
  });

  it("lets provider/model runtimes enter a custom model that was not discovered", () => {
    const onChange = vi.fn();

    render(
      <ModelDropdown
        label="Model"
        models={[
          {
            id: "kimi-coding/kimi-for-coding",
            label: "kimi-coding/kimi-for-coding",
          },
        ]}
        value=""
        onChange={onChange}
        open
        onOpenChange={() => {}}
        allowDefault={false}
        required
        groupByProvider
        emptyLabel="Select or enter provider/model"
        searchPlaceholder="Search or enter provider/model..."
        emptyMessage="No models discovered. Enter provider/model and run Test now."
        allowCustom
      />,
    );

    const input = document.querySelector<HTMLInputElement>(
      "input[placeholder='Search or enter provider/model...']",
    );
    expect(input).toBeTruthy();

    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(input, "deepseek/deepseek-chat");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const customButton = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes('Use "deepseek/deepseek-chat"'));
    expect(customButton).toBeTruthy();

    act(() => {
      customButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith("deepseek/deepseek-chat");
  });
});
