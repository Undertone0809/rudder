import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyShellIdentityDependency } from "./verify-shell-identity-dependency.mjs";

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "rudder-shell-identity-"));
  roots.push(root);
  const app = path.join(root, "installed", "app");
  await mkdir(app, { recursive: true });
  await writeFile(path.join(app, "package.json"), '{"type":"module"}');
  return { root, app };
}

async function dependency(root) {
  const pkg = path.join(root, "node_modules", "@rudderhq", "identity-core");
  await mkdir(path.join(pkg, "dist"), { recursive: true });
  await writeFile(path.join(pkg, "package.json"), JSON.stringify({
    name: "@rudderhq/identity-core", type: "module",
    exports: { "./electron": { import: "./dist/index.js", default: "./dist/index.js" } },
  }));
  await writeFile(path.join(pkg, "dist", "index.js"), "export {};\n");
  return pkg;
}

describe("packaged shell identity dependency", () => {
  it("accepts a compiled dependency carried by the installed app", async () => {
    const { app } = await fixture();
    const pkg = await dependency(app);
    expect(await verifyShellIdentityDependency(app)).toBe(await realpath(path.join(pkg, "dist", "index.js")));
  });

  it("rejects accidental ancestor-checkout resolution", async () => {
    const { root, app } = await fixture();
    await dependency(root);
    await expect(verifyShellIdentityDependency(app)).rejects.toThrow("outside the packaged app");
  });

  it("rejects workspace symlinks escaping the installed app", async () => {
    const { root, app } = await fixture();
    const pkg = await dependency(root);
    await mkdir(path.join(app, "node_modules", "@rudderhq"), { recursive: true });
    await symlink(pkg, path.join(app, "node_modules", "@rudderhq", "identity-core"), "dir");
    await expect(verifyShellIdentityDependency(app)).rejects.toThrow("outside the packaged app");
  });
});
