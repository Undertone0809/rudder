import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listAgentRuntimeAvailability } from "../services/agent-runtime-availability.js";

describe("agent runtime availability", () => {
  it("marks local runtimes available only when their CLI command resolves", async () => {
    const binDir = await mkdtemp(path.join(os.tmpdir(), "rudder-runtime-bin-"));
    const codexPath = path.join(binDir, "codex");
    await writeFile(codexPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const checkedAt = new Date("2026-07-07T00:00:00.000Z");
    const availability = await listAgentRuntimeAvailability({
      env: { PATH: binDir },
      now: checkedAt,
    });

    expect(availability.find((item) => item.agentRuntimeType === "codex_local")).toMatchObject({
      status: "available",
      command: "codex",
      resolvedCommand: codexPath,
      checkedAt: checkedAt.toISOString(),
    });
    expect(availability.find((item) => item.agentRuntimeType === "claude_local")).toMatchObject({
      status: "unavailable",
      command: "claude",
      resolvedCommand: null,
    });
    expect(availability.find((item) => item.agentRuntimeType === "openclaw_gateway")).toMatchObject({
      status: "unknown",
      command: null,
    });
    expect(availability.map((item) => item.agentRuntimeType)).not.toContain("process");
    expect(availability.map((item) => item.agentRuntimeType)).not.toContain("http");
  });
});
