import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildInventory,
  compareInventories,
  compareInventoriesWithTransportPolicyForTests,
  scanSource,
  sha256,
  TRUSTED_TRANSPORT_ADMISSIONS,
} from "./rust-backend-authority-inventory.mjs";


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

const SESSION_ADMISSION_ID = "rust-native-session-proof-v1";
const IDENTITY_ADMISSION_ID = "rust-native-identity-proof-v1";
const sessionAdmissionFixtureFactory = `export function nativeSessionAssertionMiddleware(options) {
  return (request, _response, next) => next();
}
`;
const identityAdmissionFixtureFactory = `export function nativeSessionAssertionMiddleware(options) {
  return (request, _response, next) => next();
}
`;

function sessionAdmissionAppSource({ mount = true, mountAfterParser = false, extra = "" } = {}) {
  const middlewareMount = `if (opts.rustPublicIngress?.sessionAuth) {
    app.use(nativeSessionAssertionMiddleware({
      key: opts.rustPublicIngress.sessionAuth.assertionKey,
    }));
  }
`;
  const bodyParser = "app.use(express.json({}));\n";
  const orderedBody = mountAfterParser
    ? `${bodyParser}${mount ? middlewareMount : ""}`
    : `${mount ? middlewareMount : ""}${bodyParser}`;
  return `import { nativeSessionAssertionMiddleware } from "../auth/native-session-assertion.js";
const app = express();
app.use(async (req, res, next) => {
  if (await workspacePreview.handlePreviewHostRequest(req, res)) return;
  next();
});
app.use("/workspace-preview", (_req, res) => res.status(404).send("Not found"));
${orderedBody}app.use(actorMiddleware(db, options));
${extra}
`;
}

function sessionAdmissionReviewRecord(policy, appSource, overrides = {}) {
  return {
    id: policy.id,
    mount_source_path: policy.source_path,
    mount_source_sha256: sha256(appSource),
    mount_receiver: policy.receiver,
    mount_expression: policy.mount_expression,
    mount_guard: policy.mount_guard,
    order_after: policy.order_after,
    order_before: policy.order_before,
    factory_path: policy.factory_path,
    factory_export: policy.factory_export,
    factory_sha256: policy.factory_sha256,
    rust_proof_owner: policy.rust_proof_owner,
    compatibility_boundary: "Node verifies only the Rust-signed ingress proof and binds request identity; Rust owns session proof issuance and business authorization.",
    retirement_criterion: "Remove this adapter when Node no longer receives native public-ingress requests.",
    reviewer: "auth-reviewer@example.test",
    review_reference: "Reviewed transport admission policy test fixture",
    review_status: "reviewed",
    ...overrides,
  };
}

function compareSessionAdmissionFixture(t, options = {}) {
  const baseRoot = temporaryTree(t);
  const headRoot = temporaryTree(t);
  const sourcePath = "server/src/bootstrap/create-http-app.ts";
  const factoryPath = "server/src/auth/native-session-assertion.ts";
  const baseSource = sessionAdmissionAppSource({ mount: false });
  const headSource = options.headSource ?? sessionAdmissionAppSource(options.appOptions);
  const factorySource = options.factorySource ?? sessionAdmissionFixtureFactory;
  const trustedPolicy = {
    ...TRUSTED_TRANSPORT_ADMISSIONS[SESSION_ADMISSION_ID],
    factory_sha256: sha256(sessionAdmissionFixtureFactory),
  };

  put(baseRoot, sourcePath, baseSource);
  put(headRoot, sourcePath, headSource);
  put(headRoot, factoryPath, factorySource);
  const base = buildInventory(baseRoot);
  const nodeRecords = [
    boundaryRecord(sourcePath, sha256(baseSource), sha256(headSource), {
      node_role: "transport_adapter",
      change_kind: "modified_node_compatibility",
    }),
    boundaryRecord(factoryPath, null, sha256(factorySource)),
  ];
  const admissionRecord = sessionAdmissionReviewRecord(trustedPolicy, headSource, options.recordOverrides);
  const head = buildInventory(headRoot, nodeRecords, options.omitAdmissionRecord ? [] : [admissionRecord]);
  const result = compareInventoriesWithTransportPolicyForTests(
    base,
    head,
    contentsFor(baseRoot, base),
    contentsFor(headRoot, head),
    trustedPolicy,
  );
  return { result, base, head, trustedPolicy, admissionRecord };
}

function identityAdmissionAppSource({ mount = true, mountAfterParser = false, extra = "" } = {}) {
  const middlewareMount = `const nativeIdentityAssertionKey =
  opts.rustPublicIngress?.identityAuth?.assertionKey
    ?? opts.rustPublicIngress?.sessionAuth?.assertionKey;
if (nativeIdentityAssertionKey) {
  app.use(nativeSessionAssertionMiddleware({
    key: nativeIdentityAssertionKey,
  }));
}
`;
  const bodyParser = "app.use(express.json({}));\n";
  const orderedBody = mountAfterParser
    ? `${bodyParser}${mount ? middlewareMount : ""}`
    : `${mount ? middlewareMount : ""}${bodyParser}`;
  return `import { nativeSessionAssertionMiddleware } from "../auth/native-session-assertion.js";
const app = express();
app.use(async (req, res, next) => {
  if (await workspacePreview.handlePreviewHostRequest(req, res)) return;
  next();
});
app.use("/workspace-preview", (_req, res) => res.status(404).send("Not found"));
${orderedBody}app.use(${TRUSTED_TRANSPORT_ADMISSIONS[IDENTITY_ADMISSION_ID].existing_mount_replacement[mount ? "after" : "before"]},);
${extra}
`;
}

function identityAdmissionReviewRecord(policy, appSource, overrides = {}) {
  return {
    id: policy.id,
    mount_source_path: policy.source_path,
    mount_source_sha256: sha256(appSource),
    mount_receiver: policy.receiver,
    mount_expression: policy.mount_expression,
    mount_guard: policy.mount_guard,
    order_after: policy.order_after,
    order_before: policy.order_before,
    factory_path: policy.factory_path,
    factory_export: policy.factory_export,
    factory_sha256: policy.factory_sha256,
    rust_proof_owner: policy.rust_proof_owner,
    compatibility_boundary: "The exact middleware mount verifies the Rust-signed identity envelope at the fixed private ingress and binds that identity to the request; Node actor permission lookup remains separate migration debt.",
    retirement_criterion: "Remove this verifier when Node no longer receives native public-ingress requests.",
    reviewer: "auth-reviewer@example.test",
    review_reference: "Reviewed identity transport admission policy test fixture",
    review_status: "reviewed",
    ...overrides,
  };
}

function compareIdentityAdmissionFixture(t, options = {}) {
  const baseRoot = temporaryTree(t);
  const headRoot = temporaryTree(t);
  const sourcePath = "server/src/bootstrap/create-http-app.ts";
  const factoryPath = "server/src/auth/native-session-assertion.ts";
  const baseSource = options.baseSource ?? identityAdmissionAppSource({ mount: false });
  const headSource = options.headSource ?? identityAdmissionAppSource(options.appOptions);
  const factorySource = options.factorySource ?? identityAdmissionFixtureFactory;
  const trustedPolicy = {
    ...TRUSTED_TRANSPORT_ADMISSIONS[IDENTITY_ADMISSION_ID],
    source_sha256: sha256(identityAdmissionAppSource()),
    factory_sha256: sha256(identityAdmissionFixtureFactory),
  };

  put(baseRoot, sourcePath, baseSource);
  put(headRoot, sourcePath, headSource);
  put(headRoot, factoryPath, factorySource);
  const base = buildInventory(baseRoot);
  const nodeRecords = [
    boundaryRecord(sourcePath, sha256(baseSource), sha256(headSource), {
      node_role: "transport_adapter",
      change_kind: "modified_node_compatibility",
    }),
    boundaryRecord(factoryPath, null, sha256(factorySource)),
  ];
  const admissionRecord = identityAdmissionReviewRecord(trustedPolicy, headSource, options.recordOverrides);
  const head = buildInventory(headRoot, nodeRecords, options.omitAdmissionRecord ? [] : [admissionRecord]);
  const result = compareInventoriesWithTransportPolicyForTests(
    base,
    head,
    contentsFor(baseRoot, base),
    contentsFor(headRoot, head),
    trustedPolicy,
  );
  return { result, base, head, trustedPolicy, admissionRecord };
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

test("CLI retires diff-local Node reviews after their source changes enter the comparison base", (t) => {
  const root = temporaryTree(t);
  const sourcePath = "server/src/services/compat.ts";
  const original = "export const value = 1;\n";
  const reviewed = "export const value = 2;\n";
  const next = "export const value = 3;\n";
  const inventoryPath = path.join(root, "authority.json");
  const checker = fileURLToPath(new URL("./rust-backend-authority-inventory.mjs", import.meta.url));
  const run = (command, ...args) => spawnSync(process.execPath, [
    checker, command, "--root", root, "--inventory", inventoryPath, ...args,
  ], { encoding: "utf8" });
  const git = (...args) => execFileSync("git", [
    "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false",
    "-c", "user.name=Authority lifecycle test", "-c", "user.email=authority@example.test", ...args,
  ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const read = () => JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
  const write = (inventory) => fs.writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);

  git("init");
  git("config", "core.autocrlf", "false");
  put(root, sourcePath, original);
  assert.equal(run("generate").status, 0);
  git("add", ".");
  git("commit", "-m", "fixture: original boundary");

  put(root, sourcePath, reviewed);
  assert.equal(run("generate").status, 0);
  const admission = boundaryRecord(sourcePath, sha256(original), sha256(reviewed));
  write({ ...read(), reviewed_node_changes: [admission] });
  const accepted = run("compare", "--compare-ref", "HEAD");
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  git("add", ".");
  git("commit", "-m", "fixture: reviewed Node boundary");

  assert.equal(run("generate").status, 0);
  assert.deepEqual(read().reviewed_node_changes, [admission], "generation must retain review metadata");
  const stale = run("compare", "--compare-ref", "HEAD");
  assert.equal(stale.status, 1, stale.stdout + stale.stderr);
  assert.match(stale.stdout, /stale or unrelated reviewed_node_changes record/);

  const beforeRetirement = read();
  write({ ...beforeRetirement, reviewed_node_changes: [] });
  assert.equal(run("check").status, 0);
  const retired = run("compare", "--compare-ref", "HEAD");
  assert.equal(retired.status, 0, retired.stdout + retired.stderr);
  assert.deepEqual(read(), { ...beforeRetirement, reviewed_node_changes: [] });

  put(root, sourcePath, next);
  assert.equal(run("generate").status, 0);
  const unreviewed = run("compare", "--compare-ref", "HEAD");
  assert.equal(unreviewed.status, 1, unreviewed.stdout + unreviewed.stderr);
  assert.match(unreviewed.stdout, /missing reviewed_node_changes record/);
  write({ ...read(), reviewed_node_changes: [admission] });
  const wrongHashes = run("compare", "--compare-ref", "HEAD");
  assert.equal(wrongHashes.status, 1, wrongHashes.stdout + wrongHashes.stderr);
  assert.match(wrongHashes.stdout, /head_sha256 does not match candidate source/);

  put(root, sourcePath, reviewed);
  put(root, "server/src/transport/new-bridge.ts", "export const forward = true;\n");
  assert.equal(run("generate").status, 0);
  write({ ...read(), reviewed_node_changes: [] });
  const newSource = run("compare", "--compare-ref", "HEAD");
  assert.equal(newSource.status, 1, newSource.stdout + newSource.stderr);
  assert.match(newSource.stdout, /missing reviewed_node_changes record/);
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

test("trusted-base policy pins the exact Rust identity-proof source and mount without activating it on its own", (t) => {
  const identityPolicy = TRUSTED_TRANSPORT_ADMISSIONS[IDENTITY_ADMISSION_ID];
  assert.equal(identityPolicy.source_path, "server/src/bootstrap/create-http-app.ts");
  assert.equal(identityPolicy.source_sha256, "ed30faf4b741ee06323d27d6c60d1189ab912961902c2d20f2819dfaaef214d9");
  assert.equal(identityPolicy.factory_path, "server/src/auth/native-session-assertion.ts");
  assert.equal(identityPolicy.factory_sha256, "26c438378ca462495348fbf70333608d7622fe7f818844048cbb8947d9a8654d");
  assert.equal(identityPolicy.factory_export, "nativeSessionAssertionMiddleware");
  assert.equal(identityPolicy.mount_expression, "nativeSessionAssertionMiddleware({ key: nativeIdentityAssertionKey, })");
  assert.equal(identityPolicy.mount_guard, "nativeIdentityAssertionKey");
  assert.equal(identityPolicy.order_after, "workspace_preview_reserved_404");
  assert.equal(identityPolicy.order_before, "express_json_body_parser");
  assert.equal(identityPolicy.rust_proof_owner, "native/crates/server-foundation/src/native_session_auth.rs::issue_assertion");

  const sessionPolicy = TRUSTED_TRANSPORT_ADMISSIONS[SESSION_ADMISSION_ID];
  assert.equal(sessionPolicy.factory_sha256, "f020323ee03bc0a8f38bb04d47b58b443afe07f93cefacdfc13cf8d46bebced5");
  assert.equal(sessionPolicy.mount_expression, "nativeSessionAssertionMiddleware({ key: opts.rustPublicIngress.sessionAuth.assertionKey, })");
  assert.deepEqual(Object.keys(TRUSTED_TRANSPORT_ADMISSIONS).sort(), [IDENTITY_ADMISSION_ID, SESSION_ADMISSION_ID].sort());

  const baseRoot = temporaryTree(t);
  const headRoot = temporaryTree(t);
  const sourcePath = identityPolicy.source_path;
  const noMountSource = identityAdmissionAppSource({ mount: false });
  put(baseRoot, sourcePath, noMountSource);
  put(headRoot, sourcePath, noMountSource);
  const base = buildInventory(baseRoot);
  const head = buildInventory(headRoot);
  const result = compareInventoriesWithTransportPolicyForTests(
    base,
    head,
    contentsFor(baseRoot, base),
    contentsFor(headRoot, head),
    identityPolicy,
  );
  assert.deepEqual(result.allowed_transport_admissions, []);
  assert.equal(head.structural_surfaces.some((surface) => surface.transport_admission === IDENTITY_ADMISSION_ID), false);
  assert.deepEqual(result.failures, []);

  const recordWithoutMount = compareIdentityAdmissionFixture(t, {
    appOptions: { mount: false },
  });
  assert(recordWithoutMount.result.failures.some((failure) => failure.includes("stale reviewed_transport_admissions record")));
});

test("exact Rust identity-proof mount is admitted while its source and factory hashes stay pinned", (t) => {
  const { result, head } = compareIdentityAdmissionFixture(t);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.allowed_transport_admissions.map((entry) => entry.id), [IDENTITY_ADMISSION_ID]);
  assert(result.added_surfaces.some((surface) => surface.signature.includes("nativeSessionAssertionMiddleware")));
  assert(head.structural_surfaces.some((surface) => surface.transport_admission === IDENTITY_ADMISSION_ID));

  const changedFactory = compareIdentityAdmissionFixture(t, {
    factorySource: `${identityAdmissionFixtureFactory}// changed or unknown proof code\n`,
  });
  assert(changedFactory.result.failures.some((failure) => failure.includes("factory source hash does not match the trusted allowlist")));

  const changedMountSource = compareIdentityAdmissionFixture(t, {
    headSource: `${identityAdmissionAppSource()}// unrelated source change\n`,
  });
  assert(changedMountSource.result.failures.some((failure) => failure.includes("mount source hash does not match the trusted allowlist")));
});

test("identity transport admission rejects import, callee, key, guard, and pre-body-order variations", (t) => {
  const original = identityAdmissionAppSource();
  const alteredImport = compareIdentityAdmissionFixture(t, {
    headSource: original.replace("../auth/native-session-assertion.js", "../auth/unreviewed-identity.js"),
  });
  assert(alteredImport.result.failures.some((failure) => failure.includes("trusted allowlist")));
  assert(alteredImport.result.failures.some((failure) => failure.includes("factory must be imported once by its exact named export")));

  const alteredCallee = compareIdentityAdmissionFixture(t, {
    headSource: original.replace("nativeSessionAssertionMiddleware({", "unreviewedMiddleware({"),
  });
  assert(alteredCallee.result.failures.some((failure) => failure.includes("new Node authority surface is forbidden")));
  assert(alteredCallee.result.failures.some((failure) => failure.includes("stale reviewed_transport_admissions record")));

  const alteredKey = compareIdentityAdmissionFixture(t, {
    headSource: original.replace("key: nativeIdentityAssertionKey", "key: legacyConfig.sessionKey"),
  });
  assert(alteredKey.result.failures.some((failure) => failure.includes("new Node authority surface is forbidden")));
  assert(alteredKey.result.failures.some((failure) => failure.includes("stale reviewed_transport_admissions record")));

  const alteredGuard = compareIdentityAdmissionFixture(t, {
    headSource: original.replace("if (nativeIdentityAssertionKey)", "if (legacyConfig.enabled)"),
  });
  assert(alteredGuard.result.failures.some((failure) => failure.includes("native identity proof must be mounted once inside the exact configured ingress-auth guard")));

  const wrongOrder = compareIdentityAdmissionFixture(t, {
    appOptions: { mountAfterParser: true },
  });
  assert(wrongOrder.result.failures.some((failure) => failure.includes("must immediately follow the reserved workspace preview mount")));
  assert(wrongOrder.result.failures.some((failure) => failure.includes("must immediately precede the first body parser")));
});

test("an identity proof admission cannot authorize an unrelated Node writer or route", (t) => {
  const writer = compareIdentityAdmissionFixture(t, {
    appOptions: { extra: "db.insert(users).values({ id: 'new' });\n" },
  });
  assert(writer.head.structural_surfaces.some((surface) => surface.type === "database_write_candidate"));
  assert(writer.result.failures.some((failure) => failure.includes("new Node authority surface is forbidden")));
  assert(writer.result.failures.some((failure) => failure.includes("mount source hash does not match the trusted allowlist")));

  const route = compareIdentityAdmissionFixture(t, {
    appOptions: { extra: 'app.post("/api/new-identity-authority", handler);\n' },
  });
  assert(route.result.failures.some((failure) => failure.includes("new Node authority surface is forbidden")));
  assert(route.result.failures.some((failure) => failure.includes("mount source hash does not match the trusted allowlist")));

  const unrelatedMount = compareIdentityAdmissionFixture(t, {
    appOptions: { extra: 'app.use("/unrelated", unrelatedMiddleware);\n' },
  });
  assert(unrelatedMount.result.failures.some((failure) => failure.includes("new Node authority surface is forbidden")));
  assert(unrelatedMount.result.added_surfaces.some((surface) => surface.signature.includes("/unrelated")));
});

test("trusted-base policy pins one exact session-proof admission factory and keeps its mount visible", (t) => {
  assert.equal(
    TRUSTED_TRANSPORT_ADMISSIONS[SESSION_ADMISSION_ID].factory_sha256,
    "f020323ee03bc0a8f38bb04d47b58b443afe07f93cefacdfc13cf8d46bebced5",
  );
  const { result, head } = compareSessionAdmissionFixture(t);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.allowed_transport_admissions.map((entry) => entry.id), [SESSION_ADMISSION_ID]);
  assert(result.added_surfaces.some((surface) => surface.signature.includes("nativeSessionAssertionMiddleware")));
  assert(head.structural_surfaces.some((surface) => surface.transport_admission === SESSION_ADMISSION_ID));
});

test("session-proof transport admission rejects a changed pinned factory hash and an altered mount-source hash", (t) => {
  const changedFactory = compareSessionAdmissionFixture(t, {
    factorySource: `${sessionAdmissionFixtureFactory}// changed factory bytes\n`,
  });
  assert(changedFactory.result.failures.some((failure) => failure.includes("factory source hash does not match the trusted allowlist")));

  const changedMountRecord = compareSessionAdmissionFixture(t, {
    recordOverrides: { mount_source_sha256: "0".repeat(64) },
  });
  assert(changedMountRecord.result.failures.some((failure) => failure.includes("mount_source_sha256 does not match candidate source")));
});

test("session-proof transport admission rejects an altered callee, key option, or order", (t) => {
  const original = sessionAdmissionAppSource();
  const alteredCallee = compareSessionAdmissionFixture(t, {
    headSource: original.replace("nativeSessionAssertionMiddleware({", "unreviewedMiddleware({"),
  });
  assert(alteredCallee.result.failures.some((failure) => failure.includes("new Node authority surface is forbidden")));
  assert(alteredCallee.result.failures.some((failure) => failure.includes("stale reviewed_transport_admissions record")));

  const alteredKey = compareSessionAdmissionFixture(t, {
    headSource: original.replace("sessionAuth.assertionKey", "legacyConfig.sessionKey"),
  });
  assert(alteredKey.result.failures.some((failure) => failure.includes("new Node authority surface is forbidden")));
  assert(alteredKey.result.failures.some((failure) => failure.includes("stale reviewed_transport_admissions record")));

  const wrongOrder = compareSessionAdmissionFixture(t, {
    appOptions: { mountAfterParser: true },
  });
  assert(wrongOrder.result.failures.some((failure) => failure.includes("must immediately follow the reserved workspace preview mount")));
  assert(wrongOrder.result.failures.some((failure) => failure.includes("must immediately precede the first body parser")));

  const duplicateMount = compareSessionAdmissionFixture(t, {
    appOptions: {
      extra: `if (opts.rustPublicIngress?.sessionAuth) {
  app.use(nativeSessionAssertionMiddleware({
    key: opts.rustPublicIngress.sessionAuth.assertionKey,
  }));
}
`,
    },
  });
  assert(duplicateMount.result.failures.some((failure) => failure.includes("must appear exactly once")));
});

test("one reviewed session-proof mount cannot authorize a Node database writer or unrelated middleware", (t) => {
  const writer = compareSessionAdmissionFixture(t, {
    appOptions: { extra: "db.update(users).set({ active: true });\n" },
  });
  assert(writer.head.structural_surfaces.some((surface) => surface.type === "database_write_candidate"));
  assert(writer.head.structural_surfaces.some((surface) => surface.type === "database_call_candidate"));
  assert(writer.result.failures.some((failure) => failure.includes("db-write-candidate")));
  assert(writer.result.failures.some((failure) => failure.includes("db-call")));

  const unrelatedMount = compareSessionAdmissionFixture(t, {
    appOptions: { extra: 'app.use("/unrelated", unrelatedMiddleware);\n' },
  });
  assert(unrelatedMount.result.failures.some((failure) => failure.includes("new Node authority surface is forbidden")));
  assert(unrelatedMount.result.added_surfaces.some((surface) => surface.signature.includes("/unrelated")));
});

test("session-proof transport admission requires a current exact reviewed record", (t) => {
  const missing = compareSessionAdmissionFixture(t, { omitAdmissionRecord: true });
  assert(missing.result.failures.some((failure) => failure.includes("missing reviewed_transport_admissions record")));

  const wrongReceiver = compareSessionAdmissionFixture(t, {
    recordOverrides: { mount_receiver: "router" },
  });
  assert(wrongReceiver.result.failures.some((failure) => failure.includes("mount_receiver does not match trusted policy")));
});

test("inventory regeneration preserves optional transport-admission review records", (t) => {
  const root = temporaryTree(t);
  put(root, "server/src/main.ts", "export const main = true;\n");
  const inventoryPath = path.join(root, "authority.json");
  const reviewedRecord = [{ id: SESSION_ADMISSION_ID, reviewer: "reviewer@example.test" }];
  fs.writeFileSync(inventoryPath, `${JSON.stringify({ reviewed_transport_admissions: reviewedRecord })}\n`);
  const checker = fileURLToPath(new URL("./rust-backend-authority-inventory.mjs", import.meta.url));

  const generated = spawnSync(process.execPath, [checker, "generate", "--root", root, "--inventory", inventoryPath], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(inventoryPath, "utf8")).reviewed_transport_admissions, reviewedRecord);

  const checked = spawnSync(process.execPath, [checker, "check", "--root", root, "--inventory", inventoryPath], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
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


test("identity admission only replaces the existing actor mount and keeps its debt visible", (t) => {
  const policy = TRUSTED_TRANSPORT_ADMISSIONS[IDENTITY_ADMISSION_ID];
  const replacement = policy.existing_mount_replacement;
  const valid = compareIdentityAdmissionFixture(t);
  assert.deepEqual(valid.result.failures, []);
  assert(valid.result.added_surfaces.some((surface) => surface.signature.includes(replacement.after)));
  assert(valid.result.added_unknown.some((entry) => entry.expression === replacement.after));
  const absentBase = compareIdentityAdmissionFixture(t, {
    baseSource: identityAdmissionAppSource({ mount: false }).replace(`app.use(${replacement.before},);`, ""),
  });
  assert(absentBase.result.failures.some((failure) => failure.includes("existing actor mount must be replaced exactly once")));
  const duplicateBase = compareIdentityAdmissionFixture(t, {
    baseSource: identityAdmissionAppSource({ mount: false }) + `app.use(${replacement.before},);`,
  });
  assert(duplicateBase.result.failures.some((failure) => failure.includes("existing actor mount must be replaced exactly once")));
  const extraHead = compareIdentityAdmissionFixture(t, {
    headSource: identityAdmissionAppSource() + `app.use(${replacement.after});`,
  });
  assert(extraHead.result.failures.some((failure) => failure.includes("existing actor mount must be replaced exactly once")));
  const retainedOld = compareIdentityAdmissionFixture(t, {
    headSource: identityAdmissionAppSource() + `app.use(${replacement.before},);`,
  });
  assert(retainedOld.result.failures.some((failure) => failure.includes("existing actor mount must be replaced exactly once")));
  const noProof = compareIdentityAdmissionFixture(t, { omitAdmissionRecord: true });
  assert(noProof.result.failures.some((failure) => failure.includes("new Node authority surface is forbidden") && failure.includes("actorMiddleware")));
});
