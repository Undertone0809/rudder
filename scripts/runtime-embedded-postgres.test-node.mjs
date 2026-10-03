import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { repairEmbeddedPostgres } from "../server/resources/postinstall-embedded-postgres.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const original = readFileSync(path.join(repoRoot, "scripts/fixtures/embedded-postgres-18.1.0-beta.16/index.js.txt"));
const patch = readFileSync(path.join(repoRoot, "patches/embedded-postgres@18.1.0-beta.16.patch"), "utf8");
const hunk = patch.slice(patch.indexOf("@@", patch.indexOf("@@") + 2) + 3).split("\n");
const before = hunk.filter((line) => line.startsWith(" ") || line.startsWith("-")).map((line) => line.slice(1)).join("\n") + "\n";
const after = hunk.filter((line) => line.startsWith(" ") || line.startsWith("+")).map((line) => line.slice(1)).join("\n") + "\n";
const patched = Buffer.from(original.toString("utf8").replace(before, after));
const roots = [];
const scriptName = "postinstall-embedded-postgres.mjs";

function temporaryRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "rudder-wrapper-packaging-"));
  roots.push(root);
  return root;
}

function writeJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
}

function writeWrapper(root, content = original) {
  writeJson(path.join(root, "package.json"), { name: "embedded-postgres", version: "18.1.0-beta.16", exports: "./dist/index.js" });
  mkdirSync(path.join(root, "dist"), { recursive: true });
  writeFileSync(path.join(root, "dist/index.js"), content);
  return path.join(root, "dist/index.js");
}

function fixture({ nested = false, staged = false } = {}) {
  const root = temporaryRoot();
  const allowedRoot = staged ? root : path.join(root, "node_modules");
  const serverPackageDir = staged ? root : path.join(allowedRoot, "@rudderhq/server");
  const dbRoot = path.join(serverPackageDir, "node_modules/@rudderhq/db");
  writeJson(path.join(serverPackageDir, "package.json"), { name: "@rudderhq/server" });
  writeJson(path.join(dbRoot, "package.json"), { name: "@rudderhq/db", exports: { ".": { import: "./dist/index.js" } } });
  const serverEntry = writeWrapper(path.join(serverPackageDir, "node_modules/embedded-postgres"));
  const dbEntry = nested ? writeWrapper(path.join(dbRoot, "node_modules/embedded-postgres")) : serverEntry;
  return { root, allowedRoot, serverPackageDir, dbRoot, serverEntry, dbEntry };
}

function installScript(serverRoot) {
  mkdirSync(path.join(serverRoot, "resources"), { recursive: true });
  const installed = path.join(serverRoot, "resources", scriptName);
  copyFileSync(path.join(repoRoot, "server/resources", scriptName), installed);
  return installed;
}

function runNode(script, env = {}) {
  return spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, ...env } });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("fixture and repaired bytes match both exact pnpm patch Git objects", () => {
  function gitBlob(content) {
    return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
  }
  assert.equal(gitBlob(original), "ccfe17a82f4879bf20cc345c579a987d9eba5309");
  assert.equal(gitBlob(patched), "f8f99c748ccd947c0fd2ca5a40fcf672ce26ce97");
});

test("repairs a shared hoisted dependency once and is byte/inode idempotent", () => {
  const f = fixture();
  assert.deepEqual(repairEmbeddedPostgres(f), [{ entryPath: f.serverEntry, status: "patched" }]);
  assert.deepEqual(readFileSync(f.serverEntry), patched);
  const first = statSync(f.serverEntry);
  assert.deepEqual(repairEmbeddedPostgres(f), [{ entryPath: f.serverEntry, status: "already_patched" }]);
  assert.equal(statSync(f.serverEntry).ino, first.ino);
  assert.equal(statSync(f.serverEntry).mtimeMs, first.mtimeMs);
  repairEmbeddedPostgres({ ...f, checkOnly: true });
});

test("repairs separate server and DB dependency copies", () => {
  const f = fixture({ nested: true });
  assert.equal(repairEmbeddedPostgres(f).length, 2);
  for (const entry of [f.serverEntry, f.dbEntry]) assert.deepEqual(readFileSync(entry), patched);
});

test("finds a dependency hoisted above the server package", () => {
  const f = fixture();
  const hoisted = path.join(f.allowedRoot, "embedded-postgres");
  renameSync(path.dirname(path.dirname(f.serverEntry)), hoisted);
  assert.deepEqual(repairEmbeddedPostgres(f), [{ entryPath: path.join(hoisted, "dist/index.js"), status: "patched" }]);
});

test("validates the whole graph before changing either copy", () => {
  const f = fixture({ nested: true });
  const unknown = Buffer.concat([original, Buffer.from("\n// unexpected change\n")]);
  writeFileSync(f.dbEntry, unknown);
  assert.throws(() => repairEmbeddedPostgres(f), /Unknown embedded-postgres content/);
  assert.deepEqual(readFileSync(f.serverEntry), original);
  assert.deepEqual(readFileSync(f.dbEntry), unknown);
});

test("rejects unknown versions and incomplete graphs", () => {
  for (const problem of ["version", "missing-db", "missing-wrapper"]) {
    const f = fixture();
    if (problem === "version") {
      writeJson(path.resolve(f.serverEntry, "../../package.json"), { name: "embedded-postgres", version: "19.0.0", exports: "./dist/index.js" });
    } else {
      rmSync(problem === "missing-db" ? f.dbRoot : path.resolve(f.serverEntry, "../.."), { recursive: true });
    }
    assert.throws(() => repairEmbeddedPostgres(f), /Unsupported embedded-postgres version|Missing .* dependency/);
  }
});

test("verification refuses unpatched content without modifying it", () => {
  const f = fixture({ staged: true });
  assert.throws(() => repairEmbeddedPostgres({ ...f, checkOnly: true }), /Unpatched embedded-postgres/);
  assert.deepEqual(readFileSync(f.serverEntry), original);
  repairEmbeddedPostgres(f);
  repairEmbeddedPostgres({ ...f, checkOnly: true });
});

test("atomic replacement leaves shared pnpm hardlinks unchanged", () => {
  const f = fixture();
  const shared = path.join(temporaryRoot(), "store-index.js");
  linkSync(f.serverEntry, shared);
  assert.equal(statSync(f.serverEntry).ino, statSync(shared).ino);
  repairEmbeddedPostgres(f);
  assert.deepEqual(readFileSync(shared), original);
  assert.deepEqual(readFileSync(f.serverEntry), patched);
  assert.notEqual(statSync(f.serverEntry).ino, statSync(shared).ino);
});

test("supports dependency symlinks to the installation's own pnpm virtual store", () => {
  const f = fixture();
  const wrapperRoot = path.resolve(f.serverEntry, "../..");
  const localStoreRoot = path.join(f.allowedRoot, ".pnpm/embedded-postgres@18.1.0-beta.16/node_modules/embedded-postgres");
  mkdirSync(path.dirname(localStoreRoot), { recursive: true });
  renameSync(wrapperRoot, localStoreRoot);
  symlinkSync(localStoreRoot, wrapperRoot, "junction");
  repairEmbeddedPostgres(f);
  assert.deepEqual(readFileSync(f.serverEntry), patched);
});

test("rejects external dependency and DB links even if the external source is patched", () => {
  for (const target of ["wrapper", "db"]) {
    const f = fixture();
    const localRoot = target === "db" ? f.dbRoot : path.resolve(f.serverEntry, "../..");
    const externalRoot = path.join(temporaryRoot(), target);
    renameSync(localRoot, externalRoot);
    if (target === "wrapper") writeFileSync(path.join(externalRoot, "dist/index.js"), patched);
    symlinkSync(externalRoot, localRoot, "junction");
    assert.throws(() => repairEmbeddedPostgres(f), /outside install root/);
    if (target === "wrapper") assert.deepEqual(readFileSync(path.join(externalRoot, "dist/index.js")), patched);
    else assert.deepEqual(readFileSync(f.serverEntry), original);
  }
});

test("rejects symlinked dist directories and entry files", () => {
  for (const target of ["directory", "file"]) {
    const f = fixture();
    const local = target === "directory" ? path.dirname(f.serverEntry) : f.serverEntry;
    const linked = `${local}.linked`;
    renameSync(local, linked);
    symlinkSync(linked, local, target === "directory" ? "junction" : "file");
    assert.throws(() => repairEmbeddedPostgres(f), /file or directory symlink/);
    assert.deepEqual(readFileSync(f.serverEntry), original);
  }
});

test("lifecycle handles installed nested copies and fails closed on unknown bytes", () => {
  const f = fixture({ nested: true });
  const script = installScript(f.serverPackageDir);
  const first = runNode(script);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /2 copies/);
  assert.deepEqual(readFileSync(f.dbEntry), patched);
  writeFileSync(f.dbEntry, "unknown");
  const failed = runNode(script);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Unknown embedded-postgres content/);
});

test("workspace lifecycle leaves sources untouched", () => {
  const root = temporaryRoot();
  const serverRoot = path.join(root, "server");
  const script = installScript(serverRoot);
  const entry = writeWrapper(path.join(root, "node_modules/embedded-postgres"));
  const result = runNode(script);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.deepEqual(readFileSync(entry), original);
});

test("lifecycle rejects a server symlink into a different installation", () => {
  const f = fixture();
  installScript(f.serverPackageDir);
  const other = temporaryRoot();
  const linkedRoot = path.join(other, "node_modules/@rudderhq/server");
  mkdirSync(path.dirname(linkedRoot), { recursive: true });
  symlinkSync(f.serverPackageDir, linkedRoot, "junction");
  const result = runNode(path.join(linkedRoot, "resources", scriptName));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside install root/);
  assert.deepEqual(readFileSync(f.serverEntry), original);
});

test("lifecycle rejects a symlinked node_modules boundary", () => {
  const f = fixture();
  installScript(f.serverPackageDir);
  const other = temporaryRoot();
  symlinkSync(f.allowedRoot, path.join(other, "node_modules"), "junction");
  const result = runNode(path.join(other, "node_modules/@rudderhq/server/resources", scriptName));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /symlinked install root/);
  assert.deepEqual(readFileSync(f.serverEntry), original);
});

test("repaired artifact captures late stderr, close status, signal and spawn failure without PostgreSQL", async () => {
  const f = fixture();
  repairEmbeddedPostgres(f);
  const source = readFileSync(f.serverEntry, "utf8");
  const block = source.slice(source.indexOf("// Initialize the database"), source.indexOf("// Clean up the file"));
  const invoke = new Function("spawn", "initdb", "passwordFile", "permissionIds", "LC_MESSAGES_LOCALE", block.replace("yield new Promise", "return new Promise"));
  for (const scenario of ["failure", "success", "signal", "spawn"]) {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    const errors = [];
    const promise = invoke.call({ options: { databaseDir: "/unused", initdbFlags: [], onLog() {}, onError: (line) => errors.push(line) } }, () => child, "/unused/initdb", "/unused/password", {}, "C");
    let settled = false;
    const observed = promise.then(() => { settled = true; }, (error) => { settled = true; return error; });
    if (scenario === "spawn") {
      const error = new Error("spawn ENOENT");
      child.emit("error", error);
      assert.equal(await observed, error);
      continue;
    }
    const code = scenario === "success" ? 0 : scenario === "signal" ? null : 1;
    child.emit("exit", code, null);
    await Promise.resolve();
    assert.equal(settled, false);
    child.stderr.emit("data", Buffer.from("late initdb diagnostic"));
    child.emit("close", code, scenario === "signal" ? "SIGTERM" : null);
    const outcome = await observed;
    assert.deepEqual(errors, ["late initdb diagnostic"]);
    if (scenario === "success") assert.equal(outcome, undefined);
    else assert.match(outcome, scenario === "signal" ? /signal SIGTERM/ : /code 1/);
  }
});

test("offline npm tarball install runs the shipped server postinstall for both dependency copies", { timeout: 30_000 }, () => {
  const f = fixture({ nested: true, staged: true });
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "server/package.json"), "utf8"));
  writeJson(path.join(f.serverPackageDir, "package.json"), {
    name: manifest.name, version: "0.0.0-packaging-test", type: "module", files: manifest.files,
    scripts: { postinstall: manifest.scripts.postinstall },
    dependencies: { "@rudderhq/db": "0.0.0-packaging-test", "embedded-postgres": "18.1.0-beta.16" },
    bundledDependencies: ["@rudderhq/db", "embedded-postgres"],
  });
  writeJson(path.join(f.dbRoot, "package.json"), { name: "@rudderhq/db", version: "0.0.0-packaging-test", dependencies: { "embedded-postgres": "18.1.0-beta.16" } });
  installScript(f.serverPackageDir);
  for (const name of ["postinstall-native-mode.mjs", "postinstall-postgres-compat.mjs"]) {
    copyFileSync(path.join(repoRoot, "server/resources", name), path.join(f.serverPackageDir, "resources", name));
  }
  const installRoot = temporaryRoot();
  writeJson(path.join(installRoot, "package.json"), { name: "runtime-install-test", private: true });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const options = { encoding: "utf8", shell: process.platform === "win32", timeout: 20_000,
    env: { ...process.env, npm_config_cache: path.join(installRoot, "cache"), RUDDER_HOME: path.join(installRoot, "rudder-home") } };
  const pack = spawnSync(npm, ["pack", "--ignore-scripts", "--json", "--offline"], { ...options, cwd: f.serverPackageDir });
  assert.equal(pack.status, 0, pack.stderr);
  const tarball = path.join(f.serverPackageDir, JSON.parse(pack.stdout)[0].filename);
  const install = spawnSync(npm, ["install", tarball, "--offline", "--no-audit", "--no-fund", "--foreground-scripts"], { ...options, cwd: installRoot });
  assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
  assert.match(install.stdout, /2 copies/);
  const installedServer = path.join(installRoot, "node_modules/@rudderhq/server");
  const copies = repairEmbeddedPostgres({ serverPackageDir: installedServer, allowedRoot: path.join(installRoot, "node_modules"), checkOnly: true });
  assert.equal(copies.length, 2);
  for (const { entryPath } of copies) assert.deepEqual(readFileSync(entryPath), patched);
});
