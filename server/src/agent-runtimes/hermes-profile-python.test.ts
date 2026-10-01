import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveHermesProfilePython } from "./hermes-profile-python.js";

describe("Hermes profile Python discovery", () => {
  it.skipIf(process.platform === "win32")("skips an installed interpreter missing dependencies without replacing explicit overrides", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "rudder-hermes-python-"));
    const broken = path.join(cwd, "broken-python");
    const working = path.join(cwd, "working-python");
    await writeFile(broken, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await writeFile(working, '#!/bin/sh\n[ "$1" = "-I" ] && [ "$2" = "-c" ] && [ "$3" = "import yaml" ]\n', { mode: 0o755 });
    const options = { cwd, env: process.env };
    expect(await resolveHermesProfilePython([broken, working], options)).toEqual({ pythonCommand: working });
    expect(await resolveHermesProfilePython([broken], options)).toEqual({ pythonCommand: null, gap: "yaml_missing" });
    expect(await resolveHermesProfilePython([path.join(cwd, "missing"), "relative-python"], options))
      .toEqual({ pythonCommand: null, gap: "python_missing" });
  });
});
