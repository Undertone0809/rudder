import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stageDesktopNative } from "./stage-native.mjs";

const script = readFileSync(new URL("./stage-native.mjs", import.meta.url), "utf8");
const rootPackage = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

const nativeNames = ["rudder-process-host", "rudder-native", "rudder-update-helper", "migration-preflight", "rudder-server-foundation"];

function macho(machine = 0x01000007) {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(machine, 4);
  return bytes;
}

async function withStagingFixture(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-foundation-reuse-"));
  const target = "x86_64-apple-darwin";
  const targetRoot = path.join(root, "desktop", ".packaged", "native", target);
  const artifactDir = path.join(root, "qualified-artifacts");
  const artifactPath = path.join(artifactDir, target, "rudder-server-foundation");
  const previous = path.join(targetRoot, "previous-staging");
  await fs.mkdir(targetRoot, { recursive: true });
  await fs.writeFile(previous, "preserve until every source is ready");
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.writeFile(artifactPath, macho());
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push({ command, args });
    const profile = path.join(root, "native", "target", "release");
    await fs.mkdir(profile, { recursive: true });
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "--bin") await fs.writeFile(path.join(profile, args[index + 1]), `release-version ${args[index + 1]}`);
    }
  };
  const options = { root, platform: "darwin", hostArch: "x64", targetArch: "x64", nativeTarget: null, artifactDir, runCommand };
  try { await callback({ root, target, targetRoot, artifactDir, artifactPath, previous, calls, runCommand, options }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

describe("Desktop native staging contract", () => {
  it("builds and stages the server foundation at the resolved target-relative path", () => {
    expect(script).toMatch(/"--bin", "rudder-server-foundation"/u);
    expect(script).toMatch(/const targetRoot = path\.join\(stagedNativeRoot, target\);/u);
    expect(script).toMatch(/const serverFoundationSourcePath = path\.join\(profileRoot, serverFoundationBinaryName\);/u);
    expect(script).toMatch(/const serverFoundationDestinationPath = path\.join\(targetRoot, serverFoundationBinaryName\);/u);
    expect(script).toMatch(/await fs\.copyFile\(serverFoundationSourcePath, serverFoundationDestinationPath\);/u);
  });

  it("checks every source binary before replacing the target staging directory", () => {
    const foundationAccess = script.indexOf("await fs.access(serverFoundationSourcePath);");
    const targetRemoval = script.indexOf("await fs.rm(targetRoot");
    expect(foundationAccess).toBeGreaterThanOrEqual(0);
    expect(targetRemoval).toBeGreaterThan(foundationAccess);
  });

  it("keeps all existing native binaries in the staging contract", () => {
    for (const binary of [
      "rudder-process-host",
      "rudder-native",
      "rudder-update-helper",
      "migration-preflight",
      "rudder-server-foundation",
    ]) {
      expect(script).toContain(binary);
    }
  });
});

describe("Desktop verification contract", () => {
  it("builds only the development process host before running Desktop smoke", () => {
    const verifyScript = rootPackage.scripts["desktop:verify"];
    const debugHostBuild = "cargo build --locked --manifest-path native/Cargo.toml --bin rudder-process-host";
    const debugHostBuildIndex = verifyScript.indexOf(debugHostBuild);
    const desktopSmokeIndex = verifyScript.indexOf("pnpm --filter @rudderhq/desktop smoke");

    expect(debugHostBuildIndex).toBeGreaterThanOrEqual(0);
    expect(desktopSmokeIndex).toBeGreaterThan(debugHostBuildIndex);
    expect(verifyScript).not.toContain("pnpm native:build");
  });
});

describe("Desktop qualified foundation reuse", () => {
  for (const [platform, targetArch, target, bytes] of [
    ["darwin", "arm64", "aarch64-apple-darwin", macho(0x0100000c)],
    ["linux", "x64", "x86_64-unknown-linux-gnu", (() => {
      const value = Buffer.alloc(64);
      value.set([0x7f, 0x45, 0x4c, 0x46]); value[5] = 1; value.writeUInt16LE(62, 18);
      return value;
    })()],
    ["win32", "x64", "x86_64-pc-windows-msvc", (() => {
      const value = Buffer.alloc(256);
      value.set([0x4d, 0x5a]); value.writeUInt32LE(128, 0x3c);
      value.write("PE\0\0", 128); value.writeUInt16LE(0x8664, 132);
      return value;
    })()],
  ]) {
    it(`stages matching ${platform}/${targetArch} artifacts and builds the resolved output layout`, async () => {
      await withStagingFixture(async ({ root, artifactDir, options }) => {
        const extension = platform === "win32" ? ".exe" : "";
        const source = path.join(artifactDir, target, `rudder-server-foundation${extension}`);
        await fs.mkdir(path.dirname(source), { recursive: true });
        await fs.writeFile(source, bytes);
        await stageDesktopNative({ ...options, platform, targetArch, runCommand: async (command, args) => {
          expect(command).toBe(platform === "win32" ? "cargo.exe" : "cargo");
          const targetIndex = args.indexOf("--target");
          expect(targetIndex !== -1).toBe(targetArch === "arm64");
          if (targetIndex !== -1) expect(args[targetIndex + 1]).toBe(target);
          const profile = path.join(root, "native", "target", ...(targetIndex !== -1 ? [target] : []), "release");
          await fs.mkdir(profile, { recursive: true });
          for (const name of nativeNames.slice(0, 4)) await fs.writeFile(path.join(profile, `${name}${extension}`), `release-version ${name}`);
        } });
        const destination = path.join(root, "desktop", ".packaged", "native", target, `rudder-server-foundation${extension}`);
        expect(await fs.readFile(destination)).toEqual(bytes);
      });
    });
  }

  it("preserves the default five-binary build when no artifact directory is provided", async () => {
    await withStagingFixture(async ({ options, calls, targetRoot }) => {
      await stageDesktopNative({ ...options, artifactDir: null });
      expect(calls).toHaveLength(1);
      expect(calls[0].args.filter((_, index, args) => args[index - 1] === "--bin")).toEqual(nativeNames);
      expect(calls[0].args).not.toContain("-p");
      for (const name of nativeNames) expect(await fs.readFile(path.join(targetRoot, name), "utf8")).toBe(`release-version ${name}`);
    });
  });

  it("reuses only foundation while explicitly building all four versioned binaries", async () => {
    await withStagingFixture(async ({ options, calls, artifactDir, target, targetRoot }) => {
      await fs.writeFile(path.join(artifactDir, target, "migration-preflight"), "base-version preflight must not be staged");
      await stageDesktopNative(options);
      expect(calls).toHaveLength(1);
      expect(calls[0].args.filter((_, index, args) => args[index - 1] === "--bin")).toEqual(nativeNames.slice(0, 4));
      expect(calls[0].args.filter((_, index, args) => args[index - 1] === "-p")).toEqual([
        "rudder-process-host", "rudder-native", "rudder-update-helper", "rudder-migration-service",
      ]);
      expect(await fs.readFile(path.join(targetRoot, "rudder-server-foundation"))).toEqual(macho());
      expect(await fs.readFile(path.join(targetRoot, "migration-preflight"), "utf8")).toBe("release-version migration-preflight");
      if (process.platform !== "win32") {
        expect((await fs.stat(path.join(targetRoot, "rudder-server-foundation"))).mode & 0o777).toBe(0o755);
      }
    });
  });

  for (const [name, bytes] of [["invalid format", Buffer.from("invalid")], ["wrong architecture", macho(0x0100000c)]]) {
    it(`rejects ${name} before Cargo or staging mutation`, async () => {
      await withStagingFixture(async ({ options, artifactPath, previous, calls }) => {
        await fs.writeFile(artifactPath, bytes);
        await expect(stageDesktopNative(options)).rejects.toThrow();
        expect(calls).toHaveLength(0);
        expect(await fs.readFile(previous, "utf8")).toBe("preserve until every source is ready");
      });
    });
  }

  for (const kind of ["missing", "directory"]) {
    it(`rejects a ${kind} provided artifact without falling back to Cargo`, async () => {
      await withStagingFixture(async ({ options, artifactPath, previous, calls }) => {
        await fs.rm(artifactPath);
        if (kind === "directory") await fs.mkdir(artifactPath);
        await expect(stageDesktopNative(options)).rejects.toThrow();
        expect(calls).toHaveLength(0);
        expect(await fs.readFile(previous, "utf8")).toBe("preserve until every source is ready");
      });
    });
  }

  it.skipIf(process.platform === "win32")("rejects a symlink artifact", async () => {
    await withStagingFixture(async ({ options, artifactPath, root, previous, calls }) => {
      const original = path.join(root, "real-foundation");
      await fs.rename(artifactPath, original);
      await fs.symlink(original, artifactPath);
      await expect(stageDesktopNative(options)).rejects.toThrow(/regular, non-symlink/u);
      expect(calls).toHaveLength(0);
      expect(await fs.readFile(previous, "utf8")).toBe("preserve until every source is ready");
    });
  });

  for (const alias of [false, true]) {
    it.skipIf(alias && process.platform === "win32")(`rejects an artifact inside replaced staging${alias ? " through a parent alias" : ""}`, async () => {
      await withStagingFixture(async ({ options, targetRoot, root, previous, calls }) => {
        await fs.writeFile(path.join(targetRoot, "rudder-server-foundation"), macho());
        let artifactDir = path.dirname(targetRoot);
        if (alias) {
          const link = path.join(root, "staging-alias");
          await fs.symlink(artifactDir, link);
          artifactDir = link;
        }
        await expect(stageDesktopNative({ ...options, artifactDir })).rejects.toThrow(/outside/u);
        expect(calls).toHaveLength(0);
        expect(await fs.readFile(previous, "utf8")).toBe("preserve until every source is ready");
      });
    });
  }

  it("rejects a conflicting explicit Cargo target before building", async () => {
    await withStagingFixture(async ({ options, calls, previous }) => {
      await expect(stageDesktopNative({ ...options, nativeTarget: "aarch64-apple-darwin" })).rejects.toThrow(/conflicts/u);
      expect(calls).toHaveLength(0);
      expect(await fs.readFile(previous, "utf8")).toBe("preserve until every source is ready");
    });
  });

  it("preserves existing staging on Cargo failure or a missing compiled preflight", async () => {
    await withStagingFixture(async ({ options, previous, runCommand, root }) => {
      await expect(stageDesktopNative({ ...options, runCommand: async () => { throw new Error("Cargo fixture failure"); } })).rejects.toThrow(/Cargo fixture/u);
      expect(await fs.readFile(previous, "utf8")).toBe("preserve until every source is ready");
      await expect(stageDesktopNative({ ...options, runCommand: async (...args) => {
        await runCommand(...args);
        await fs.rm(path.join(root, "native", "target", "release", "migration-preflight"));
      } })).rejects.toThrow();
      expect(await fs.readFile(previous, "utf8")).toBe("preserve until every source is ready");
    });
  });

  it("stages the validated foundation bytes even if the input changes during Cargo", async () => {
    await withStagingFixture(async ({ options, runCommand, artifactPath, targetRoot }) => {
      await stageDesktopNative({ ...options, runCommand: async (...args) => {
        await runCommand(...args);
        await fs.writeFile(artifactPath, "replaced after validation");
      } });
      expect(await fs.readFile(path.join(targetRoot, "rudder-server-foundation"))).toEqual(macho());
    });
  });
});
