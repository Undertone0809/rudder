import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { copyOfficialAppBuilderScaffold } from "./app-builder-scaffold.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "rudder-app-scaffold-"));
  const templateRoot = path.join(root, "template");
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(path.join(templateRoot, "src"), { recursive: true });
  await mkdir(workspaceRoot);
  await writeFile(path.join(templateRoot, "src", "app.ts"), "export const app = true;\n");
  await writeFile(path.join(templateRoot, "package.json"), "{}\n");
  return { root, templateRoot, workspaceRoot };
}

describe("App Builder official scaffold copy", () => {
  it("copies the trusted template into a new project directory", async () => {
    const { templateRoot, workspaceRoot } = await fixture();
    const result = await copyOfficialAppBuilderScaffold({
      templateRoot,
      workspaceRoot,
      targetDirectory: "apps/crm",
    });
    expect(await readFile(path.join(result.appRoot, "src", "app.ts"), "utf8"))
      .toBe("export const app = true;\n");
    expect(result.entries).toBeGreaterThan(1);
  });

  it("accepts an existing empty target but rejects a non-empty target without changing it", async () => {
    const { templateRoot, workspaceRoot } = await fixture();
    await mkdir(path.join(workspaceRoot, "empty"));
    await expect(copyOfficialAppBuilderScaffold({
      templateRoot,
      workspaceRoot,
      targetDirectory: "empty",
    })).resolves.toMatchObject({ appRoot: path.join(await realpath(workspaceRoot), "empty") });

    const occupied = path.join(workspaceRoot, "occupied");
    await mkdir(occupied);
    await writeFile(path.join(occupied, "keep.txt"), "keep");
    await expect(copyOfficialAppBuilderScaffold({
      templateRoot,
      workspaceRoot,
      targetDirectory: "occupied",
    })).rejects.toThrow("must be empty");
    await expect(readFile(path.join(occupied, "keep.txt"), "utf8")).resolves.toBe("keep");
  });

  it.runIf(process.platform !== "win32")(
    "rejects template symlinks and target ancestors that escape the workspace",
    async () => {
      const first = await fixture();
      await symlink("/tmp", path.join(first.templateRoot, "unsafe-link"));
      await expect(copyOfficialAppBuilderScaffold({
        templateRoot: first.templateRoot,
        workspaceRoot: first.workspaceRoot,
        targetDirectory: "unsafe",
      })).rejects.toThrow("symbolic links");

      const second = await fixture();
      const outside = await mkdtemp(path.join(tmpdir(), "rudder-scaffold-outside-"));
      await symlink(outside, path.join(second.workspaceRoot, "linked"));
      await expect(copyOfficialAppBuilderScaffold({
        templateRoot: second.templateRoot,
        workspaceRoot: second.workspaceRoot,
        targetDirectory: "linked/app",
      })).rejects.toThrow("outside");
    },
  );
});
