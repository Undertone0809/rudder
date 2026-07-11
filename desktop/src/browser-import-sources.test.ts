import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserImportSourceRegistry } from "./browser-import-sources.js";

const tempRoots: string[] = [];

async function makeTempHome(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-browser-sources-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Browser import source discovery", () => {
  it("returns opaque Chrome profile sources without reading Cookies and rejects unsafe profiles", async () => {
    const homeDir = await makeTempHome();
    const chromeRoot = path.join(homeDir, "Library/Application Support/Google/Chrome");
    const profileRoot = path.join(chromeRoot, "Default");
    const outsideRoot = path.join(homeDir, "outside");
    await fs.mkdir(path.join(profileRoot, "Network"), { recursive: true });
    await fs.mkdir(outsideRoot, { recursive: true });
    await fs.writeFile(path.join(profileRoot, "Network/Cookies"), "must-not-be-read", { mode: 0o000 });
    await fs.writeFile(path.join(outsideRoot, "Cookies"), "outside");
    await fs.symlink(outsideRoot, path.join(chromeRoot, "Linked"));
    await fs.writeFile(path.join(chromeRoot, "Local State"), JSON.stringify({
      profile: {
        info_cache: {
          Default: { name: "Work" },
          Linked: { name: "Linked" },
          "../outside": { name: "Traversal" },
        },
      },
    }));

    const registry = createBrowserImportSourceRegistry({
      platform: "darwin",
      homeDir,
      createId: () => "opaque-source-id",
    });
    const sources = await registry.listSources();

    expect(sources).toEqual([{
      id: "opaque-source-id",
      displayName: "Google Chrome - Work",
      browserName: "Google Chrome",
      profileName: "Work",
      supported: { cookies: true, passwords: false },
    }]);
    expect(JSON.stringify(sources)).not.toContain(homeDir);
    expect(await fs.readFile(path.join(profileRoot, "Network/Cookies"), "utf8").catch(() => "unreadable"))
      .toBe("unreadable");

    const trusted = registry.resolveSource("opaque-source-id");
    expect(trusted.cookieDatabasePath).toBe(await fs.realpath(path.join(profileRoot, "Network/Cookies")));
    expect(trusted.keychain).toEqual({ service: "Chrome Safe Storage", account: "Chrome" });
    expect(() => registry.resolveSource("../../Default/Network/Cookies")).toThrow("Unknown browser import source");
  });

  it("discovers Edge and Brave profiles and falls back to the legacy Cookies path", async () => {
    const homeDir = await makeTempHome();
    const fixtures = [
      {
        root: "Library/Application Support/Microsoft Edge",
        browserName: "Microsoft Edge",
        keychain: { service: "Microsoft Edge Safe Storage", account: "Microsoft Edge" },
      },
      {
        root: "Library/Application Support/BraveSoftware/Brave-Browser",
        browserName: "Brave",
        keychain: { service: "Brave Safe Storage", account: "Brave" },
      },
    ];
    for (const fixture of fixtures) {
      const browserRoot = path.join(homeDir, fixture.root);
      await fs.mkdir(path.join(browserRoot, "Profile 1"), { recursive: true });
      await fs.writeFile(path.join(browserRoot, "Profile 1/Cookies"), "legacy");
      await fs.writeFile(path.join(browserRoot, "Local State"), JSON.stringify({
        profile: { info_cache: { "Profile 1": { name: "Personal" } } },
      }));
    }

    let nextId = 0;
    const registry = createBrowserImportSourceRegistry({
      platform: "darwin",
      homeDir,
      createId: () => `source-${++nextId}`,
    });
    const sources = await registry.listSources();

    expect(sources.map((source) => source.browserName)).toEqual(["Microsoft Edge", "Brave"]);
    for (const source of sources) {
      const trusted = registry.resolveSource(source.id);
      expect(trusted.cookieDatabasePath).toMatch(/Profile 1\/Cookies$/);
      expect(trusted.keychain).toEqual(fixtures.find((item) => item.browserName === source.browserName)?.keychain);
    }
  });

  it("returns no sources on unsupported platforms", async () => {
    const registry = createBrowserImportSourceRegistry({
      platform: "linux",
      homeDir: "/home/tester",
      createId: () => "unused",
    });
    await expect(registry.listSources()).resolves.toEqual([]);
  });

  it("contains realpath races without exposing absolute source paths", async () => {
    const homeDir = await makeTempHome();
    const chromeRoot = path.join(homeDir, "Library/Application Support/Google/Chrome");
    const cookiePath = path.join(chromeRoot, "Default/Network/Cookies");
    await fs.mkdir(path.dirname(cookiePath), { recursive: true });
    await fs.writeFile(cookiePath, "database");
    await fs.writeFile(path.join(chromeRoot, "Local State"), JSON.stringify({
      profile: { info_cache: { Default: { name: "Work" } } },
    }));

    for (const racedPath of [chromeRoot, cookiePath]) {
      const realpath = vi.fn(async (candidate: string) => {
        if (candidate === racedPath) throw new Error(`ENOENT: ${candidate}`);
        return fs.realpath(candidate);
      });
      const registry = createBrowserImportSourceRegistry({
        platform: "darwin",
        homeDir,
        createId: () => "opaque",
        realpath,
      });

      await expect(registry.listSources()).resolves.toEqual([]);
    }
  });
});
