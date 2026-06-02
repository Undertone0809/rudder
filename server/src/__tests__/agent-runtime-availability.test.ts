import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listLocalAgentRuntimeAvailability } from "../agent-runtimes/availability.js";

async function writeExecutable(dir: string, name: string) {
  const file = path.join(dir, name);
  await fs.writeFile(file, "#!/usr/bin/env sh\nexit 0\n", "utf8");
  await fs.chmod(file, 0o755);
  return file;
}

describe("agent runtime availability", () => {
  it("marks local runtimes available only when their CLI command is executable", async () => {
    const bin = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-runtime-bin-"));
    await writeExecutable(bin, "opencode");

    const result = await listLocalAgentRuntimeAvailability({
      cwd: bin,
      env: { PATH: bin },
    });

    const byType = new Map(result.map((runtime) => [runtime.agentRuntimeType, runtime]));
    expect(byType.get("opencode_local")).toMatchObject({
      command: "opencode",
      available: true,
      status: "available",
    });
    expect(byType.get("claude_local")).toMatchObject({
      command: "claude",
      available: false,
      status: "missing",
    });
    expect(byType.get("claude_local")?.installUrl).toContain("claude-code");
  });

  it("uses the Cursor Agent CLI command, not a generic agent binary", async () => {
    const bin = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-runtime-bin-"));
    await writeExecutable(bin, "agent");

    const withGenericAgent = await listLocalAgentRuntimeAvailability({
      cwd: bin,
      env: { PATH: bin },
    });
    expect(withGenericAgent.find((runtime) => runtime.agentRuntimeType === "cursor")).toMatchObject({
      command: "cursor-agent",
      available: false,
      status: "missing",
    });

    await writeExecutable(bin, "cursor-agent");
    const withCursorAgent = await listLocalAgentRuntimeAvailability({
      cwd: bin,
      env: { PATH: bin },
    });
    expect(withCursorAgent.find((runtime) => runtime.agentRuntimeType === "cursor")).toMatchObject({
      command: "cursor-agent",
      available: true,
      status: "available",
    });
  });
});
