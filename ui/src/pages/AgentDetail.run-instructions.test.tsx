import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RecoveredDeveloperInstructions } from "./AgentDetail.run-instructions";

describe("historical Metadata partial recovery", () => {
  it("labels recovered text as partial and never renders it as a full injected stack", () => {
    const markup = renderToStaticMarkup(<RecoveredDeveloperInstructions censorUsernameInLogs={false} recovery={{
      source: "codex_native_rollout", completeness: "partial", snapshotStatus: "missing",
      developerInstructions: "Recovered example <script>unsafe()</script>", sha256: "a".repeat(64),
      byteSize: 47, spanId: "span", sessionId: "session", turnId: "turn",
    }} />);
    expect(markup).toContain("Recovered developer instructions · Partial");
    expect(markup).toContain("historical prompt is not recovered");
    expect(markup).not.toContain("Injected Agent Instruction Stack");
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).not.toContain("<script>");
  });
});
