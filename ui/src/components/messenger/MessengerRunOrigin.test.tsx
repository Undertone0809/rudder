// @vitest-environment jsdom

import type { MessengerRunOriginDescriptor } from "@rudderhq/shared";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { MessengerRunOrigin } from "./MessengerRunOrigin";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("MessengerRunOrigin", () => {
  it("labels Delegation Runs without falling back to Heartbeat Run copy", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const origin: MessengerRunOriginDescriptor = {
      runId: "run-1",
      scene: "delegation",
      triggerKind: "agent_run_created",
      invocationSource: "delegation",
      targetType: "wakeup_request",
      targetId: null,
      conversationId: null,
      messageId: null,
      issueId: null,
      automationRunId: null,
      automationId: null,
      wakeupRequestId: "wakeup-1",
      sourceRunId: "source-run-1",
      targetLabel: null,
      targetStatus: null,
      sourceState: "legacy_unknown",
      source: { kind: "unavailable", state: "legacy_unknown" },
    };

    act(() => root.render(createElement(MessengerRunOrigin, { origin })));
    expect(container.textContent).toContain("Delegation Run");
    expect(container.textContent).not.toContain("Heartbeat Run");
    act(() => root.unmount());
    container.remove();
  });
});
