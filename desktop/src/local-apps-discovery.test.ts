import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { discoverLocalAppDefinition } from "./local-apps-discovery.js";

describe("Desktop Local App discovery", () => {
  it("reads only bounded package metadata and infers a safe dev script without starting it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-discovery-"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "safe-dashboard",
      scripts: {
        install: "node install.js",
        build: "vite build",
        migrate: "db migrate",
        dev: "vite --host 127.0.0.1",
      },
    }));
    await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await mkdir(path.join(root, "nested"));
    const spawn = vi.fn();

    const result = await discoverLocalAppDefinition(root, { spawn });

    expect(result).toMatchObject({
      title: "safe-dashboard",
      cwd: await import("node:fs/promises").then(({ realpath }) => realpath(root)),
      argv: ["run", "dev"],
      readiness: { path: "/api/health" },
      openPath: "/",
    });
    expect(result.executable).toMatch(/pnpm(?:\.cmd)?$/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects oversized, malformed, and scriptless package metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-bounded-"));
    await writeFile(path.join(root, "package.json"), "x".repeat(300_000));
    await expect(discoverLocalAppDefinition(root)).rejects.toThrow("too large");
    await writeFile(path.join(root, "package.json"), "{");
    await expect(discoverLocalAppDefinition(root)).rejects.toThrow("valid package.json");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { build: "vite build" } }));
    await expect(discoverLocalAppDefinition(root)).rejects.toThrow("supported development script");
  });

  it("conservatively infers documented health and open routes from a bounded README", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-readme-"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "operations-dashboard",
      scripts: { dev: "node server/dev.mjs" },
    }));
    await writeFile(path.join(root, "package-lock.json"), "{}");
    await writeFile(path.join(root, "README.md"), [
      "# Operations dashboard",
      "Open the printed URL at `/outreach` to use the local console.",
      "- `GET /api/health`: readiness status.",
    ].join("\n"));

    const result = await discoverLocalAppDefinition(root);
    expect(result.openPath).toBe("/outreach");
    expect(result.readiness.path).toBe("/api/health");
  });
});
