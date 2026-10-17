import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyDesktopIdentityPackage } from "./verify-app-identity-package.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "rudder-app-identity-"));
  roots.push(root);
  const app = path.join(root, "installed", "app");
  await mkdir(app, { recursive: true });
  await writeFile(path.join(app, "package.json"), JSON.stringify({
    type: "module", dependencies: { "@rudderhq/identity-core": "1.0.0" },
  }));
  return { root, app };
}

async function identityPackage(root) {
  const dir = path.join(root, "node_modules", "@rudderhq", "identity-core");
  await mkdir(path.join(dir, "dist"), { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({
    name: "@rudderhq/identity-core", type: "module",
    exports: { "./electron": "./dist/index.js" },
  }));
  await writeFile(path.join(dir, "dist", "index.js"),
    "export const normalizeVerifiedEmail = value => value.trim().toLowerCase();\n");
  return dir;
}

describe("packaged Desktop identity dependency", () => {
  it("loads its Electron export inside an isolated installed app", async () => {
    const { app } = await fixture();
    await identityPackage(app);
    await expect(verifyDesktopIdentityPackage(app)).resolves.toBeUndefined();
  });

  it("rejects a missing local package even when an ancestor checkout satisfies resolution", async () => {
    const { root, app } = await fixture();
    const ancestor = await identityPackage(root);
    expect(createRequire(path.join(app, "package.json")).resolve("@rudderhq/identity-core/electron"))
      .toBe(await realpath(path.join(ancestor, "dist", "index.js")));
    await expect(verifyDesktopIdentityPackage(app)).rejects.toThrow();
  });

  it("rejects a staged symlink that escapes the installed app", async () => {
    const { root, app } = await fixture();
    const external = await identityPackage(root);
    const scope = path.join(app, "node_modules", "@rudderhq");
    await mkdir(scope, { recursive: true });
    await symlink(external, path.join(scope, "identity-core"), process.platform === "win32" ? "junction" : "dir");
    await expect(verifyDesktopIdentityPackage(app)).rejects.toThrow("outside the packaged app");
  });

  it("rejects a manifest whose compiled Electron entry is absent", async () => {
    const { app } = await fixture();
    const identity = await identityPackage(app);
    await rm(path.join(identity, "dist"), { recursive: true });
    await expect(verifyDesktopIdentityPackage(app)).rejects.toThrow();
  });
});
