// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import type { SidePanelTarget } from "@/lib/side-panel-targets";
import { SubagentPanelView } from "./SubagentPanelView";

describe("SubagentPanelView", () => {
  it("treats App Server inProgress snapshots as active and read only", () => {
    const target: Extract<SidePanelTarget, { kind: "subagent" }> = {
      kind: "subagent",
      callId: "spawn-1",
      threadId: "thread-child-1",
      avatarSeed: "spawn-1",
      label: "Sub-agent · Review the transcript renderer",
      senderLabel: "Main agent",
      prompt: "Review the transcript renderer.",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      status: "inProgress",
      response: null,
      entries: [],
    };

    const html = renderToStaticMarkup(
      <ThemeProvider>
        <SubagentPanelView target={target} />
      </ThemeProvider>,
    );

    expect(html).toContain(">In progress<");
    expect(html).toContain("The sub-agent is still working.");
    expect(html).not.toContain("No response was captured");
    expect(html).not.toContain("textarea");
  });
});
