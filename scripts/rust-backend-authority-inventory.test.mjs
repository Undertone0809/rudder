import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildInventory, compareInventories, scanSource, sha256 } from "./rust-backend-authority-inventory.mjs";


function temporaryTree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-authority-inventory-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function put(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function contentsFor(root, inventory) {
  const entries = [...inventory.source_manifest, ...inventory.migration_manifest];
  return new Map(entries.map((entry) => {
    const content = fs.readFileSync(path.join(root, entry.path), "utf8");
    return [entry.path, { content, sha256: sha256(content) }];
  }));
}

function boundaryRecord(sourcePath, baseHash, headHash, overrides = {}) {
  return {
    path: sourcePath,
    change_kind: baseHash === null ? "new_transport_adapter" : "modified_node_compatibility",
    base_sha256: baseHash,
    head_sha256: headHash,
    node_role: baseHash === null ? "transport_adapter" : "compatibility_adapter",
    rust_authority: "native::http_gateway",
    compatibility_boundary: "Node forwards the existing request contract to the Rust-owned authority.",
    retirement_criterion: "Remove after the Rust public ingress is the only production route owner.",
    reviewer: "maintainer@example.test",
    review_reference: "PR #test, reviewed boundary record",
    review_status: "reviewed",
    ...overrides,
  };
}

test("inventory recognizes Express and direct identity routes without mistaking ordinary map updates for DB writers", () => {
  const expressSource = `
    const router = Router();
    const paths = ["/one", "/two"] as const;
    router.get(paths, handler);
    router.use("/api", auth);
    const cache = new Map();
    cache.delete("key");
    hash.update("value");
    db.insert(users).values(row);
    tx.update(users).set(patch);
  `;
  const express = scanSource("server/src/routes/example.ts", expressSource);
  const routes = express.surfaces.filter((surface) => surface.type === "http_route");
  assert.deepEqual(routes.map((route) => route.path).sort(), ["/one", "/two"]);
  assert.equal(express.surfaces.filter((surface) => surface.type === "middleware_mount").length, 1);
  assert.deepEqual(
    express.surfaces.filter((surface) => surface.type === "database_write_candidate").map((surface) => `${surface.receiver}.${surface.method}`).sort(),
    ["db.insert", "tx.update"],
  );

  const identitySource = `
    if (req.method === "GET" && url.pathname === "/health") return;
    if ((req.method === "GET" || req.method === "PATCH") && url.pathname === "/profile") return;
    if (req.method === "POST" && url.pathname.startsWith("/api/items/")) return;
    if (req.method === "PATCH" && session.valid) return;
  `;
  const identity = scanSource("identity/src/handler.ts", identitySource);
  const identityRoutes = identity.surfaces.filter((surface) => surface.type === "http_route");
  assert.deepEqual(identityRoutes.map((route) => `${route.method} ${route.path_match}:${route.path}`).sort(), [
    "GET exact:/health",
    "GET exact:/profile",
    "PATCH exact:/profile",
    "POST prefix:/api/items/",
  ]);
  assert.equal(identity.unknown.some((entry) => entry.type === "dynamic_identity_http_route_path"), false);
});

test("long candidate expressions remain distinguishable without bloating the inventory", () => {
  const query = `UPDATE records SET payload = '${"x".repeat(600)}'`;
  const result = scanSource("server/src/services/large-query.ts", `db.execute(${JSON.stringify(query)});`);
  const candidate = result.surfaces.find((surface) => surface.type === "database_write_candidate");
  assert(candidate);
  assert(candidate.signature.length < 260);
  assert(candidate.target.length < 260);
  assert.match(candidate.target, /sha256:[a-f0-9]{64}/);
});

test("source scope excludes scripts and shared contracts while retaining runtime package sources", (t) => {
  const root = temporaryTree(t);
  put(root, "scripts/helper.mjs", "export const helper = true;\n");
  put(root, "packages/shared/src/api.ts", "export type Api = {};\n");
  put(root, "ui/src/main.tsx", "export const ui = true;\n");
  put(root, "packages/agent-runtime-utils/src/index.ts", "export const runtime = true;\n");
  put(root, "packages/new-runtime/src/index.ts", "export const authority = true;\n");
  put(root, "api/handler.mjs", "export function handler() {}\n");
  put(root, "server/ui-dist/assets/index.js", "export const bundledUi = true;\n");
  put(root, "server/src/app.ts", "import { productionHandler } from './__tests__/production-handler.test.js';\nimport { generatedHandler } from './dist/generated-handler.js';\nexport { productionHandler, generatedHandler };\n");
  put(root, "server/src/__tests__/production-handler.test.ts", "export const productionHandler = true;\n");
  put(root, "server/src/dist/generated-handler.ts", "export const generatedHandler = true;\n");
  const inventory = buildInventory(root);
  assert.deepEqual(inventory.source_manifest.map((entry) => entry.path), [
    "api/handler.mjs",
    "packages/agent-runtime-utils/src/index.ts",
    "packages/new-runtime/src/index.ts",
    "server/src/__tests__/production-handler.test.ts",
    "server/src/app.ts",
    "server/src/dist/generated-handler.ts",
  ]);
  assert.equal(inventory.unknown.some((entry) => entry.type === "unmapped_node_source_family" && entry.source === "packages/new-runtime/src/index.ts"), true);
  assert.equal(inventory.unknown.some((entry) => entry.type === "unmapped_node_source_family" && entry.source === "api/handler.mjs"), true);
  assert.equal(inventory.source_manifest.some((entry) => entry.path === "server/ui-dist/assets/index.js"), false);
});

test("compare rejects new production Node source and business authority surfaces", (t) => {
  const baseRoot = temporaryTree(t);
  const headRoot = temporaryTree(t);
  put(baseRoot, "server/src/app.ts", "export const app = {};\n");
  put(headRoot, "server/src/app.ts", "export const app = {};\n");
  put(headRoot, "server/src/routes/new.ts", "export const route = true;\n");
  const base = buildInventory(baseRoot);
  const head = buildInventory(headRoot);
  const result = compareInventories(base, head, contentsFor(baseRoot, base), contentsFor(headRoot, head));
  assert(result.failures.some((failure) => failure.includes("missing reviewed_node_changes record")));

  put(baseRoot, "server/src/routes/new.ts", "export const route = true;\n");
  const baseWithRoute = buildInventory(baseRoot);
  put(headRoot, "server/src/routes/new.ts", `
    const router = Router();
    router.post("/api/new-business-capability", handler);
  `);
  const headWithRoute = buildInventory(headRoot);
  const routeChange = compareInventories(baseWithRoute, headWithRoute, contentsFor(baseRoot, baseWithRoute), contentsFor(headRoot, headWithRoute));
  assert(routeChange.failures.some((failure) => failure.includes("new Node authority surface is forbidden")));
});

test("existing Node edits require trusted hash-bound reviewer and Rust retirement boundary records", (t) => {
  const baseRoot = temporaryTree(t);
  const headRoot = temporaryTree(t);
  const original = "export const value = 1;\n";
  const changed = "export const value = 2;\n";
  const sourcePath = "server/src/services/compat.ts";
  put(baseRoot, sourcePath, original);
  put(headRoot, sourcePath, changed);
  const base = buildInventory(baseRoot);
  const headWithoutRecord = buildInventory(headRoot);
  const missing = compareInventories(base, headWithoutRecord, contentsFor(baseRoot, base), contentsFor(headRoot, headWithoutRecord));
  assert(missing.failures.some((failure) => failure.includes("missing reviewed_node_changes record")));

  const record = boundaryRecord(sourcePath, sha256(original), sha256(changed));
  const head = buildInventory(headRoot, [record]);
  const accepted = compareInventories(base, head, contentsFor(baseRoot, base), contentsFor(headRoot, head));
  assert.deepEqual(accepted.failures, []);
});

test("new transport adapter requires a reviewed boundary and cannot add Node authority surfaces", (t) => {
  const baseRoot = temporaryTree(t);
  const headRoot = temporaryTree(t);
  const sourcePath = "server/src/transport/rust-bridge.ts";
  const adapter = "export async function forward(url: string) { return fetch(url); }\n";
  const base = buildInventory(baseRoot);
  put(headRoot, sourcePath, adapter);
  const adapterHash = sha256(adapter);
  const head = buildInventory(headRoot, [boundaryRecord(sourcePath, null, adapterHash)]);
  const accepted = compareInventories(base, head, contentsFor(baseRoot, base), contentsFor(headRoot, head));
  assert.deepEqual(accepted.failures, []);

  const routeAdapter = `
    const router = Router();
    router.post("/api/new-node-authority", handler);
  `;
  put(headRoot, sourcePath, routeAdapter);
  const routeHash = sha256(routeAdapter);
  const headWithRoute = buildInventory(headRoot, [boundaryRecord(sourcePath, null, routeHash)]);
  const blocked = compareInventories(base, headWithRoute, contentsFor(baseRoot, base), contentsFor(headRoot, headWithRoute));
  assert(blocked.failures.some((failure) => failure.includes("new Node authority surface is forbidden")));
});

test("SQL migrations can be appended with an append-only journal, while existing migration history is immutable", (t) => {
  const baseRoot = temporaryTree(t);
  const headRoot = temporaryTree(t);
  const migrationsRoot = "packages/db/src/migrations";
  const journalPath = `${migrationsRoot}/meta/_journal.json`;
  const firstSqlPath = `${migrationsRoot}/0001_initial.sql`;
  const secondSqlPath = `${migrationsRoot}/0002_next.sql`;
  const firstSql = "CREATE TABLE first_table (id integer PRIMARY KEY);\n";
  const firstJournal = JSON.stringify({
    version: "7", dialect: "postgresql", entries: [{ idx: 0, version: "7", when: 1, tag: "0001_initial", breakpoints: true }],
  }, null, 2) + "\n";
  put(baseRoot, firstSqlPath, firstSql);
  assert.equal(secondSqlPath, `${migrationsRoot}/0002_next.sql`);
  put(baseRoot, journalPath, firstJournal);
  put(headRoot, firstSqlPath, firstSql);
  put(headRoot, `${migrationsRoot}/0002_next.sql`, "ALTER TABLE first_table ADD COLUMN name text;\n");
  const appendedJournal = JSON.stringify({
    version: "7", dialect: "postgresql", entries: [
      { idx: 0, version: "7", when: 1, tag: "0001_initial", breakpoints: true },
      { idx: 1, version: "7", when: 2, tag: "0002_next", breakpoints: true },
    ],
  }, null, 2) + "\n";
  put(headRoot, journalPath, appendedJournal);
  const base = buildInventory(baseRoot);
  const head = buildInventory(headRoot);
  const allowed = compareInventories(base, head, contentsFor(baseRoot, base), contentsFor(headRoot, head));
  assert.deepEqual(allowed.failures, []);
  assert.deepEqual(allowed.migration_added, [secondSqlPath]);
  assert.deepEqual(allowed.migration_changed, [journalPath]);

  put(headRoot, firstSqlPath, "DROP TABLE first_table;\n");
  const mutated = buildInventory(headRoot);
  const blocked = compareInventories(base, mutated, contentsFor(baseRoot, base), contentsFor(headRoot, mutated));
  assert(blocked.failures.some((failure) => failure.includes(`existing migration SQL/snapshot is immutable: ${firstSqlPath}`)));

  const badJournal = JSON.parse(appendedJournal);
  badJournal.entries[0].tag = "0001_rewritten";
  put(headRoot, journalPath, `${JSON.stringify(badJournal, null, 2)}\n`);
  const mutatedJournal = buildInventory(headRoot);
  const journalResult = compareInventories(base, mutatedJournal, contentsFor(baseRoot, base), contentsFor(headRoot, mutatedJournal));
  assert(journalResult.failures.some((failure) => failure.includes("journal entry 0 was edited or reordered")));
});


test("CLI invoked through a symlink executes and fails for an invalid command", (t) => {
  const root = temporaryTree(t);
  const link = path.join(root, "checker.mjs");
  fs.symlinkSync(new URL("./rust-backend-authority-inventory.mjs", import.meta.url), link);
  const result = spawnSync(process.execPath, [link, "invalid-command"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown command|usage|invalid|unsupported/i);
});


test("runtime source file and directory symlinks fail closed before inventory comparison", (t) => {
  const root = temporaryTree(t);
  put(root, "server/src/original.ts", "export const original = true;\n");
  const link = path.join(root, "server/src/new-route.ts");
  fs.symlinkSync("original.ts", link);
  assert.throws(() => buildInventory(root), /Runtime source symlink is not permitted/);
  fs.unlinkSync(link);
  fs.symlinkSync(path.join(root, "server/src"), path.join(root, "backend"), "dir");
  assert.throws(() => buildInventory(root), /Runtime source symlink is not permitted/);
});


test("packaged Electron release symlinks are excluded while imported release source stays visible", (t) => {
  const root = temporaryTree(t);
  put(root, "server/src/main.ts", "export const main = true;\n");
  put(root, "desktop/release/Rudder.app/Versions/Current/Helpers/index.js", "export const generated = true;\n");
  fs.symlinkSync("Versions/Current/Helpers", path.join(root, "desktop/release/Rudder.app/Helpers"), "dir");
  const initial = buildInventory(root);
  assert.equal(initial.source_manifest.some((entry) => entry.path.startsWith("desktop/release/")), false);
  put(root, "server/src/main.ts", 'import "../../desktop/release/authority.js";\n');
  put(root, "desktop/release/authority.js", "export const authority = true;\n");
  const imported = buildInventory(root);
  assert(imported.source_manifest.some((entry) => entry.path === "desktop/release/authority.js"));
});


test("packaging vendor parking directory is pruned without hiding imported authority", (t) => {
  const root = temporaryTree(t);
  put(root, "server/src/main.ts", "export const main = true;\n");
  put(root, "desktop/node_modules-packaging-hidden/pkg/index.js", "export const generated = true;\n");
  fs.symlinkSync("pkg", path.join(root, "desktop/node_modules-packaging-hidden/linked"), "dir");
  const initial = buildInventory(root);
  assert.equal(initial.source_manifest.some((entry) => entry.path.startsWith("desktop/node_modules-packaging-hidden/")), false);
  put(root, "server/src/main.ts", 'import "../../desktop/node_modules-packaging-hidden/pkg/index.js";\n');
  const imported = buildInventory(root);
  assert(imported.source_manifest.some((entry) => entry.path === "desktop/node_modules-packaging-hidden/pkg/index.js"));
  put(root, "server/src/node_modules-packaging-hidden/authority.ts", "export const authority = true;\n");
  const exactPathOnly = buildInventory(root);
  assert(exactPathOnly.source_manifest.some((entry) => entry.path === "server/src/node_modules-packaging-hidden/authority.ts"));
});
