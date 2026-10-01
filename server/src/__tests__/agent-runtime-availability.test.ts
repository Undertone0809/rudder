import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

  it.each([
    { yamlExit: 0, backend: "native_product_rpc", gap: undefined },
    { yamlExit: 1, backend: "acp", gap: "yaml_missing" },
  ])("selects a concrete Hermes local backend without exposing profile data ($backend)", async ({ yamlExit, backend, gap }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-hermes-availability-"));
    const binDir = path.join(root, "bin");
    const hermesHome = path.join(root, "home");
    const source = path.join(hermesHome, "hermes-agent");
    const python = path.join(source, ".venv", "bin", "python3");
    await mkdir(binDir, { recursive: true });
    await mkdir(path.join(source, "tui_gateway"), { recursive: true });
    await mkdir(path.dirname(python), { recursive: true });
    await writeFile(path.join(source, "hermes_state.py"), "");
    await writeFile(path.join(source, "tui_gateway", "entry.py"), "");
    await writeFile(path.join(binDir, "hermes"), "#!/bin/sh\n[ \"$1\" = acp ] && [ \"$2\" = --check ] && exit 0\nexit 1\n", { mode: 0o755 });
    await writeFile(python, `#!/bin/sh\nexit ${yamlExit}\n`, { mode: 0o755 });

    const availability = await listAgentRuntimeAvailability({
      cwd: root,
      env: { PATH: binDir, HERMES_HOME: hermesHome },
    });
    const hermes = availability.find((item) => item.agentRuntimeType === "hermes_gateway");
    expect(hermes).toMatchObject({
      status: "available",
      resolvedCommand: path.join(binDir, "hermes"),
      hermesLocalBackend: backend,
      ...(gap ? { hermesProductRpcCapabilityGap: gap } : {}),
    });
    expect(hermes?.message).toContain("local ACP setup check passed");
    expect(hermes?.message).toContain(backend === "acp" ? "Rudder will use ACP" : "native Product RPC prerequisites are present");
    expect(JSON.stringify(hermes)).not.toContain(hermesHome);
    expect(JSON.stringify(hermes)).not.toContain("config.yaml");
  });

  it("does not label a found Hermes CLI ready when ACP setup check fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-hermes-not-ready-"));
    const binDir = path.join(root, "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(binDir, "hermes"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const hermes = (await listAgentRuntimeAvailability({ cwd: root, env: { PATH: binDir } }))
      .find((item) => item.agentRuntimeType === "hermes_gateway");
    expect(hermes).toMatchObject({ status: "unavailable", resolvedCommand: path.join(binDir, "hermes") });
    expect(hermes?.message).toContain("ACP setup check did not pass");
  });
});
