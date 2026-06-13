// @vitest-environment jsdom

import { Bot } from "lucide-react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { MetricCard } from "./MetricCard";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  document.body.innerHTML = "";
});

function renderMetric(value: string | number) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const render = (nextValue: string | number) => {
    act(() => {
      root.render(<MetricCard icon={Bot} value={nextValue} label="Agents Enabled" />);
    });
  };
  render(value);
  cleanupFn = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };
  return { container, render };
}

describe("MetricCard", () => {
  it("keeps the metric readable while rendering animated digit slots", () => {
    const { container, render } = renderMetric("$0.00");

    render("$12.50");

    const metricValue = container.querySelector(".metric-value-motion");
    expect(metricValue?.getAttribute("aria-label")).toBe("$12.50");
    expect(metricValue?.getAttribute("data-animated")).toBe("true");
    expect(container.querySelectorAll(".metric-digit-window").length).toBe(4);
  });
});
