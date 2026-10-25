#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_INVENTORY = "doc/plans/2026-10-16-rudder-rust-backend-authority-inventory.json";
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const GENERATED_OR_VENDOR_DIRS = new Set([".git", "node_modules", ".pnpm-store", "target", "dist", "build", "coverage", ".packaged", "ui-dist", ".turbo", ".next", ".cache", ".vite", ".output", "out", "vendor", "artifacts"]);
const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all", "route"]);
const DATABASE_CALL_METHODS = new Set(["select", "selectDistinct", "findMany", "findFirst", "findUnique", "count", "insert", "update", "delete", "execute", "query", "run", "transaction"]);
const WORKER_METHODS = new Set(["setInterval", "setTimeout", "schedule", "scheduleJob", "registerJob"]);
const MCP_METHODS = new Set(["tool", "registerTool", "addTool"]);
const WS_EVENTS = new Set(["upgrade", "connection", "message"]);
const OPERATORS_BY_FIRST_CHAR = new Map([
  ["=", ["===", "==", "=>"]], ["!", ["!==", "!="]], ["?", ["?.", "??"]], [".", ["..."]],
  ["<", ["<="]], [">", [">="]], ["&", ["&&"]], ["|", ["||"]], ["+", ["++"]], ["-", ["--"]], ["*", ["**"]],
]);
const DATABASE_RECEIVER = /^(?:db|tx|database|dbOrTx|txDb|identityDb|transaction|trx|pool|connection|conn|executor|statement|sqlite|postgres|pg|drizzle|sqlx)(?:[A-Z][A-Za-z0-9_]*)?$/;
const TRUSTED_TRANSPORT_ADMISSIONS = Object.freeze({
  "rust-native-session-proof-v1": Object.freeze({
    id: "rust-native-session-proof-v1",
    admission_label: "native session proof",
    source_path: "server/src/bootstrap/create-http-app.ts",
    receiver: "app",
    factory_path: "server/src/auth/native-session-assertion.ts",
    factory_import: "../auth/native-session-assertion.js",
    factory_export: "nativeSessionAssertionMiddleware",
    factory_sha256: "f020323ee03bc0a8f38bb04d47b58b443afe07f93cefacdfc13cf8d46bebced5",
    mount_expression: "nativeSessionAssertionMiddleware({ key: opts.rustPublicIngress.sessionAuth.assertionKey, })",
    mount_guard: "opts.rustPublicIngress?.sessionAuth",
    order_after: "workspace_preview_reserved_404",
    order_before: "express_json_body_parser",
    rust_proof_owner: "native/crates/server-foundation/src/native_session_auth.rs::issue_assertion",
  }),
  "rust-native-identity-proof-v1": Object.freeze({
    id: "rust-native-identity-proof-v1",
    admission_label: "native identity proof",
    source_path: "server/src/bootstrap/create-http-app.ts",
    source_sha256: "ed30faf4b741ee06323d27d6c60d1189ab912961902c2d20f2819dfaaef214d9",
    // This second exact source is a reviewed candidate variant, not a general
    // exception. It admits only the private negative fence for the three Rust
    // email-auth paths and only before the legacy Better Auth wildcard.
    conditional_source_variants: Object.freeze([
      Object.freeze({
        source_sha256: "06ab8d223e65b879ea8d8d8b224f0880ef059b0377f285d3e68c369cf6981afb",
        additional_mounts: Object.freeze([
          Object.freeze({
            expression: '(req, res, next) => { if (isNativeEmailAuthRequest(req.method, req.originalUrl)) { res.status(404).json({ error: "API route not found" }); return; } next(); }',
            guard: "opts.rustPublicIngress",
            order_before: 'app.all("/api/auth/*authPath", opts.betterAuthHandler)',
          }),
        ]),
      }),
    ]),
    // The pinned caller also narrows an EXISTING actor mount to required auth.
    // This is an exact replacement, never permission to add another actor owner.
    existing_mount_replacement: Object.freeze({
      before: "actorMiddleware(db, { deploymentMode: opts.deploymentMode, authRequirement: opts.authRequirement, resolveSession: opts.resolveSession, })",
      after: "actorMiddleware(db, { deploymentMode: opts.deploymentMode, authRequirement, resolveSession: opts.resolveSession, })",
    }),
    receiver: "app",
    factory_path: "server/src/auth/native-session-assertion.ts",
    factory_import: "../auth/native-session-assertion.js",
    factory_export: "nativeSessionAssertionMiddleware",
    factory_sha256: "26c438378ca462495348fbf70333608d7622fe7f818844048cbb8947d9a8654d",
    mount_expression: "nativeSessionAssertionMiddleware({ key: nativeIdentityAssertionKey, })",
    mount_guard: "nativeIdentityAssertionKey",
    order_after: "workspace_preview_reserved_404",
    order_before: "express_json_body_parser",
    rust_proof_owner: "native/crates/server-foundation/src/native_session_auth.rs::issue_assertion",
  }),
  // These mounts remain Node compatibility adapters. They are admitted only
  // as route projections because Rust owns the corresponding public paths;
  // they do not grant a second Node business or auth authority.
  "rust-native-agent-core-router-v1": Object.freeze({
    id: "rust-native-agent-core-router-v1",
    admission_label: "native AgentCore router adapter",
    validation_kind: "compatibility_mount",
    source_path: "server/src/bootstrap/register-api-routes.ts",
    receiver: "api",
    mount_expression: "agentRoutes( db, opts.storageService, rustFoundationBridge, Boolean(opts.rustPublicIngress?.identityAuth), )",
    mount_guard: "Boolean(opts.rustPublicIngress?.identityAuth)",
    order_after: "api_route_registration",
    order_before: "agent_core_compatibility_handlers",
    order_after_expression: "organizationSkillRoutes(db)",
    order_before_expression: "managedMcpAgentBindingRoutes(db)",
    order_after_call: true,
    order_before_call: true,
    rust_proof_owner: "native/crates/server-foundation/src/public_ingress/agent_core.rs",
  }),
  "rust-native-agent-core-handler-v1": Object.freeze({
    id: "rust-native-agent-core-handler-v1",
    admission_label: "native AgentCore handler adapter",
    validation_kind: "compatibility_mount",
    source_path: "server/src/routes/agents.ts",
    receiver: "router",
    mount_expression: "agentCoreRoutes( rustFoundationBridge, resolveBrowserCapabilityDeployment(db), nativeAgentCorePaths, )",
    mount_guard: "nativeAgentCorePaths",
    order_after: "agent_router_initialization",
    order_before: "agent_core_compatibility_handlers",
    order_after_expression: null,
    order_before_expression: "const svc = agentService(db);",
    order_after_call: false,
    order_before_call: false,
    rust_proof_owner: "native/crates/server-foundation/src/public_ingress/agent_core.rs",
  }),
  "rust-native-project-reads-router-v1": Object.freeze({
    id: "rust-native-project-reads-router-v1",
    admission_label: "native Project reads router adapter",
    validation_kind: "compatibility_mount",
    source_path: "server/src/bootstrap/register-api-routes.ts",
    receiver: "api",
    mount_expression: "projectRoutes(db, rustFoundationBridge, { nativeProjectReads: Boolean(opts.rustPublicIngress), })",
    mount_guard: "Boolean(opts.rustPublicIngress)",
    order_after: "asset_routes",
    order_before: "app_builder_routes",
    order_after_expression: "assetRoutes(db, opts.storageService)",
    order_before_expression: "appBuilderRoutes(db, { onAppChanged: (orgId) => pluginProjectionService.syncLocalApps(orgId), })",
    order_after_call: true,
    order_before_call: true,
    rust_proof_owner: "native/crates/server-foundation/src/public_ingress/project_reads.rs",
  }),
  "rust-native-cli-auth-router-v1": Object.freeze({
    id: "rust-native-cli-auth-router-v1",
    admission_label: "native CLI auth router adapter",
    validation_kind: "compatibility_mount",
    source_path: "server/src/bootstrap/register-api-routes.ts",
    receiver: "api",
    mount_expression: "accessRoutes(db, { deploymentMode: opts.deploymentMode, deploymentExposure: opts.deploymentExposure, bindHost: opts.bindHost, allowedHostnames: opts.allowedHostnames, nativeCliAuthOwner: Boolean(opts.rustPublicIngress), })",
    mount_guard: "Boolean(opts.rustPublicIngress)",
    order_after: "rudder_plugin_routes",
    order_before: "api_return",
    order_after_expression: "rudderPluginRoutes(db, pluginMcpOptions)",
    order_before_expression: "return api",
    order_after_call: true,
    order_before_call: false,
    rust_proof_owner: "native/crates/server-foundation/src/public_ingress/cli_auth.rs",
  }),
});

// These two package-level files are temporary typed transports to Rust-owned
// migration and PostgreSQL lifecycle executors. Keep admission path- and
// content-bound: packages/db is otherwise a production Node database runtime,
// not a generally trusted transport directory.
const TRUSTED_NODE_TRANSPORT_SOURCES = Object.freeze({
  "packages/db/src/migration-operator.ts": Object.freeze({
    id: "rust-migration-operator-process-transport-v1",
    source_sha256: "f9a5f20555bb6b4942adadf5c249c86469de5b11ba6dd671da87409565b3fce5",
    rust_authority: "native/crates/migration-service/src/operator.rs and native/crates/migration-service/src/apply.rs",
    allowed_node_duties: Object.freeze([
      "resolve the installed Rust migration executable and migration source paths",
      "build the deterministic source manifest fingerprint and send the typed bounded process request",
      "parse the typed response and bound cancellation, timeout, and process cleanup",
    ]),
    prohibited_node_duties: Object.freeze([
      "SQL execution or database inspection",
      "deciding whether migrations are needed or whether approval is required",
      "migration history repair, backup, locking, or apply fallback in Node",
    ]),
    compatibility_boundary: "This exact package module resolves and invokes the Rust migration operator over its typed process protocol. It does not connect to PostgreSQL or decide, inspect, back up, lock, repair, or apply migration state in Node.",
    retirement_criterion: "Retire this Node process adapter when all first-party callers invoke the Rust migration operator through the shared native transport and this package module is deleted.",
  }),
  "packages/db/src/postgres-owner.ts": Object.freeze({
    id: "rust-postgres-owner-process-transport-v1",
    source_sha256: "3868134ff321bb2212dcf5a40812aa088e09fc0ced114046bf4f7540bd1e4895",
    rust_authority: "native/crates/postgres-lifecycle/src/lib.rs and native/crates/postgres-lifecycle/src/bin/rudder-postgres-owner.rs",
    allowed_node_duties: Object.freeze([
      "resolve the installed Rust owner executable and packaged PostgreSQL runtime directory",
      "spawn the typed bounded owner protocol and project readiness and shutdown messages",
      "bound process lifetime and report the Rust owner endpoint to existing callers",
    ]),
    prohibited_node_duties: Object.freeze([
      "initdb, pg_ctl, SQL, or PostgreSQL data-directory mutation",
      "database creation, readiness policy, lifecycle decisions, or migration decisions",
      "fallback to a Node-managed PostgreSQL owner when Rust is missing or fails",
    ]),
    compatibility_boundary: "This exact package module resolves and invokes the Rust PostgreSQL owner over its typed process protocol. PostgreSQL initialization, supervision policy, database operations, and failure handling remain Rust-owned; Node fallback is forbidden.",
    retirement_criterion: "Retire this Node process adapter when all first-party callers consume the Rust owner through the shared native transport and this package module is deleted.",
  }),
});

// A structural timer allowance is valid only for the reviewed native child
// process escalation callback. This does not admit timers on any other path or
// any other expression in migration-preflight.
const TRUSTED_TRANSPORT_SURFACES = Object.freeze({
  "server/src/services/migration-preflight.ts": Object.freeze({
    owner: "server/src/services/migration-preflight.ts::runMigrationProcess",
    source_sha256: "3f140195cfd75250bbe9e19a7928c27ba7eea35f89c2114a88961f4f1264c7e9",
    signatures: Object.freeze([
      "server/src/services/migration-preflight.ts|worker-schedule-candidate|setTimeout|() => { if (pendingFailure) { pendingFailure = new MigrationPreflightAdapterErro… [sha256:622fdb8c7f383d5a4265b4e5db2c04120c48d226d2e2713f8dc981cdeac95e3c]",
    ]),
  }),
});

const LEGACY_FENCE_CHANGE_KINDS = new Set([
  "target_advisory_lock",
  "native_chat_queue_guard_helper",
  "native_chat_conversation_authority_helper",
  "native_chat_generation_hint_helper",
  "native_chat_queued_message_hint_helper",
  "native_chat_conversation_id_hint_helper",
  "native_chat_queue_guard_callsite",
  "native_chat_run_attempt_admission",
  "native_chat_side_chat_retention",
  "existing_operation_mapping",
]);
const TARGET_LOCK_RECEIVERS = new Set(["tx"]);

// These body digests are the only code allowed to implement the temporary
// Native Chat negative fence. They are trusted policy literals, not values
// supplied by reviewed_legacy_fence_changes. Updating one requires a separate
// exact-source review of the helper body.
// Exact reviewed caller files bind each negative guard, its argument aliases,
// and the existing writer to one source contract. Inventory records cannot
// update these pins. A caller edit needs a separately reviewed policy change;
// the lexical checks below do not attempt general argument/data-flow proof.
const TRUSTED_NATIVE_CHAT_FENCE_CALLERS = Object.freeze({
  "server/src/services/chats.annotation-persistence.ts": "94c30f2e90d6f79b5b71e101e683914bab0723140656b39b49624094e95aabfd",
  "server/src/services/chats.ts": "0ee118bb6d19b12c53a90a1c862a419ca2d938b56bc67b9b0df70780592a97a2",
  "server/src/services/chat-generation-protocol.ts": "96ea9f4e2cc1e8ed63a22ec7fda76311bfcfe3f2d6f724ba203a02f30072f04d",
  "server/src/services/chats.queued-message-create.ts": "7ca4c03b504f383750d452d7e09e0a51c9e059e76879eaefd7527f6e38f910b6",
  "server/src/services/chat-steer-messages.ts": "eac974850d555f7fe3e3001e1518954e1df67d7993d495d03c11639a92d78611"
});

const TRUSTED_NATIVE_CHAT_HELPERS = Object.freeze({
  lockLegacyNativeChatQueueTarget: Object.freeze({
    path: "server/src/services/organization-mutation-fence.ts",
    parameters: ["tx: TransactionClient", "organizationId: string", "conversationId: string"],
    body_sha256: "eec4d580d06e7beb1fad0eb0cf05fc4358eadc7614e6a0bbb9bc7fd9a20c44a4",
    surfaces: [
      ["database_call_candidate", "execute", 3],
      ["database_write_candidate", "execute", 3],
    ],
  }),
  assertLegacyChatConversationAuthority: Object.freeze({
    path: "server/src/services/chats.ts",
    parameters: ["tx: any", "orgId: string", "conversationId: string"],
    body_sha256: "031405e0595b803c2c575541d6b9b873acc1967f96e9ff468f71ac26c32888c8",
    surfaces: [],
    record_kind: "native_chat_conversation_authority_helper",
    helper_reference: "queue_helper_id",
  }),
  assertLegacyChatGenerationAuthority: Object.freeze({
    path: "server/src/services/chats.ts",
    parameters: ["tx: any", "orgId: string", "generationId: string"],
    body_sha256: "376ee9a168d578a5165886a1ba68d0f7edb26c5dfdfde214cb0ea646b7725708",
    surfaces: [["database_call_candidate", "select", 1]],
    record_kind: "native_chat_generation_hint_helper",
    helper_reference: "conversation_helper_id",
  }),
  assertLegacyQueuedMessageAuthority: Object.freeze({
    path: "server/src/services/chats.ts",
    parameters: ["tx: any", "itemId: string", "expected?: { orgId?: string; conversationId?: string }"],
    body_sha256: "f34fcb0cfc5f4ac89af18089874104361ce703acba93bdaefb6a3111b57f8602",
    surfaces: [["database_call_candidate", "select", 1]],
    record_kind: "native_chat_queued_message_hint_helper",
    helper_reference: "conversation_helper_id",
  }),
  assertLegacyChatConversationIdAuthority: Object.freeze({
    path: "server/src/services/chats.ts",
    parameters: ["tx: any", "conversationId: string"],
    body_sha256: "6eb6475e91f99c34877657c1562e0988dfe7128889f318f1c7422cc139de2fa9",
    surfaces: [["database_call_candidate", "select", 1]],
    record_kind: "native_chat_conversation_id_hint_helper",
    helper_reference: "conversation_helper_id",
  }),
});


// These existing Electron identity-policy modules are retained client code,
// not Node backend adapters. Keep this allowlist explicit so new Desktop
// runtime files cannot enter through the retained-client review path.
const RETAINED_ELECTRON_CLIENT_PATHS = new Set([
  "desktop/src/identity-runtime.ts",
  "desktop/src/identity-safe-storage-policy.ts",
  "desktop/src/identity-startup-policy.ts",
]);

const FAMILY_DEFINITIONS = [
  { id: "public_http_and_routes", owner: "Node/Express", roots: ["server/src/bootstrap", "server/src/routes", "server/src/app.ts"] },
  { id: "http_middleware_and_auth", owner: "Node/Express", roots: ["server/src/middleware", "server/src/auth", "server/src/bootstrap"] },
  { id: "websocket_and_streaming", owner: "Node/Express", roots: ["server/src/realtime", "server/src/routes"] },
  { id: "server_lifecycle_and_workers", owner: "Node", roots: ["server/src", "identity/src"] },
  { id: "database_queries_and_writers", owner: "Node/Drizzle", roots: ["packages/db/src", "packages/identity-db/src"] },
  { id: "schema_and_migration_apply", owner: "Node/Drizzle", roots: ["packages/db/src", "packages/identity-db/src", "identity/src"] },
  { id: "identity_and_sessions", owner: "Node", roots: ["identity/src", "identity/api", "packages/identity-core/src", "packages/identity-db/src", "server/src/auth", "server/src/routes"] },
  { id: "analytics_collection", owner: "Node", roots: ["server/src/product-analytics-collector-", "server/src/product-analytics", "identity/src/analytics"] },
  { id: "managed_mcp_and_plugins", owner: "Node", roots: ["server/src/routes/managed-mcp-", "server/src/routes/rudder-plugins-", "server/src/services/managed-mcp-", "server/src/services/rudder-plugins"] },
  { id: "first_party_cli_and_mcp", owner: "Node", roots: ["cli/src"] },
  { id: "rudder_owned_runtime_adapters", owner: "Node", roots: ["packages/agent-runtime-utils/src", "packages/agent-runtimes", "packages/run-intelligence-core/src", "server/src/agent-runtimes"] },
  { id: "electron_process_graph", owner: "Electron/Node", roots: ["desktop/src"] },
  { id: "identity_and_shared_domain", owner: "Node", roots: ["packages/identity-core/src", "packages/run-intelligence-core/src"] },
  { id: "unknown_node_runtime_source", owner: "Unclassified", roots: [] },
];

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function conditionalTransportSourceVariant(policy, sourceHash) {
  return policy.conditional_source_variants?.find((variant) => variant.source_sha256 === sourceHash) ?? null;
}

function compactInventoryRecord(record) {
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string" || value.length <= 240) continue;
    record[key] = `${value.slice(0, 160)}… [sha256:${sha256(value)}]`;
  }
  return record;
}

function normalizePath(value) {
  return value.split(path.sep).join("/").replace(/^\.\//, "");
}

function isTestOrGeneratedPath(relativePath) {
  const normalized = normalizePath(relativePath);
  const parts = normalized.split("/");
  const base = parts.at(-1) ?? "";
  return normalized.startsWith("desktop/release/")
    || normalized.startsWith("desktop/node_modules-packaging-hidden/")
    || parts.some((part) => ["__tests__", "test", "tests", "fixtures", "fixture", "generated", ".generated"].includes(part))
    || /\.(?:test|spec)\.[^.]+$/i.test(base)
    || parts.some((part) => GENERATED_OR_VENDOR_DIRS.has(part));
}

function isUiOrDocsPath(relativePath) {
  const normalized = normalizePath(relativePath);
  return normalized.startsWith("ui/")
    || normalized.startsWith("docs/")
    || normalized.startsWith("doc/")
    || normalized.startsWith("native/")
    || normalized.startsWith("tests/")
    || normalized.startsWith(".agents/");
}

function isPotentialNodeSource(relativePath) {
  const normalized = normalizePath(relativePath);
  const extension = path.posix.extname(normalized);
  if (!SOURCE_EXTENSIONS.has(extension) || isTestOrGeneratedPath(normalized) || isUiOrDocsPath(normalized)) return false;
  // Track runtime source trees, not workspace scripts, build config, templates,
  // or shared API/schema contracts. All other package src trees are included
  // below as unknown so a new runtime package cannot fall outside the scan.
  if (normalized.startsWith("packages/shared/")) return false;
  if (normalized.startsWith("scripts/") || normalized.startsWith("desktop/scripts/")
    || normalized.startsWith("server/scripts/") || normalized.startsWith("cli/scripts/")
    || normalized.startsWith("identity/scripts/") || normalized.startsWith("server/resources/")
    || normalized.startsWith(".github/") || normalized.startsWith("docker/openclaw-smoke/")) return false;
  if (/^(?:eslint|vite|vitest|playwright|esbuild|rollup|webpack|jest|tailwind|postcss|electron-builder|tsup|drizzle)\.config\.[^.]+$/i.test(path.posix.basename(normalized))) return false;
  if (/^(?:server|identity|cli|desktop)\/src\//.test(normalized)) return true;
  if (/^packages\/[^/]+\/src\//.test(normalized)) return true;
  // Executable files outside explicitly retained UI/docs/build/test/tooling
  // areas remain visible as unknown instead of escaping through a new folder.
  return true;
}

function isMigrationInputPath(relativePath) {
  const normalized = normalizePath(relativePath);
  return /^packages\/(?:db|identity-db)\/src\/migrations\/(?:.*\.(?:sql|json))$/i.test(normalized)
    && !normalized.includes("/test-fixtures/");
}

function familyForPath(relativePath) {
  const normalized = normalizePath(relativePath);
  const matches = [];
  for (const family of FAMILY_DEFINITIONS) {
    if (family.roots.some((root) => {
      if (root.endsWith("-")) return normalized.startsWith(root);
      return normalized === root || normalized.startsWith(`${root}/`);
    })) matches.push(family.id);
  }
  if (normalized.startsWith("packages/") && /\/src\//.test(normalized)) {
    const packageName = normalized.split("/")[1];
    if (!matches.length) matches.push(`unclassified_package:${packageName}`);
  }
  if (!matches.length) matches.push("unknown_node_runtime_source");
  return [...new Set(matches)].sort();
}

function walkFiles(rootPath, relative = "", predicate = isPotentialNodeSource) {
  const absolute = path.join(rootPath, relative);
  let entries;
  try {
    entries = fs.readdirSync(absolute, { withFileTypes: true });
  } catch {
    return [];
  }
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (GENERATED_OR_VENDOR_DIRS.has(entry.name)) continue;
    const child = path.join(relative, entry.name);
    // dist.mjs temporarily parks vendor dependencies here while packaging.
    if (["desktop/release", "desktop/node_modules-packaging-hidden"].includes(normalizePath(child))) continue;
    if (entry.isSymbolicLink()) {
      // Runtime symlinks could otherwise add untracked sources or entire trees.
      // Do not follow them outside this checkout or silently omit their authority.
      let directory = false;
      try { directory = fs.statSync(path.join(rootPath, child)).isDirectory(); }
      catch { directory = path.extname(child) === ""; }
      if (predicate(child) || (directory && predicate(path.join(child, "index.js")))) {
        throw new Error(`Runtime source symlink is not permitted: ${normalizePath(child)}`);
      }
      continue;
    }
    if (entry.isDirectory()) result.push(...walkFiles(rootPath, child, predicate));
    else if (entry.isFile() && predicate(child)) result.push(normalizePath(child));
  }
  return result;
}

function isFileAt(rootPath, relativePath) {
  if (relativePath.startsWith("../") || relativePath === "..") return false;
  try {
    return fs.statSync(path.join(rootPath, relativePath)).isFile();
  } catch {
    return false;
  }
}

function readCurrentSources(rootPath) {
  const map = new Map();
  const retained = new Set(walkFiles(rootPath));
  const queue = [...retained];
  while (queue.length) {
    const importer = queue.shift();
    const source = fs.readFileSync(path.join(rootPath, importer), "utf8");
    const tokens = tokenize(source);
    const specifiers = [];
    for (let i = 0; i < tokens.length - 1; i += 1) {
      if ((tokens[i].value === "from" || tokens[i].value === "import" || tokens[i].value === "require") && tokens[i + 1]?.kind === "string") {
        specifiers.push(tokens[i + 1].value);
      } else if (tokens[i].value === "require" && tokens[i + 1]?.value === "(" && tokens[i + 2]?.kind === "string") {
        specifiers.push(tokens[i + 2].value);
      } else if (tokens[i].value === "import" && tokens[i + 1]?.value === "(" && tokens[i + 2]?.kind === "string") {
        specifiers.push(tokens[i + 2].value);
      }
    }
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) continue;
      const targetBase = normalizePath(path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier)));
      const specifiedExtension = path.posix.extname(targetBase);
      const extensionless = SOURCE_EXTENSIONS.has(specifiedExtension) ? targetBase.slice(0, -specifiedExtension.length) : targetBase;
      const candidates = [targetBase, ...[...SOURCE_EXTENSIONS].map((extension) => `${extensionless}${extension}`), ...[...SOURCE_EXTENSIONS].map((extension) => `${targetBase}/index${extension}`)];
      const target = candidates.find((candidate) => SOURCE_EXTENSIONS.has(path.posix.extname(candidate)) && isFileAt(rootPath, candidate));
      if (target && isTestOrGeneratedPath(target) && !retained.has(target)) {
        retained.add(target);
        queue.push(target);
      }
    }
  }
  for (const relativePath of [...retained].sort()) {
    const content = fs.readFileSync(path.join(rootPath, relativePath));
    map.set(relativePath, { content: content.toString("utf8"), sha256: sha256(content) });
  }
  return map;
}

function readCurrentMigrations(rootPath) {
  const map = new Map();
  for (const relativePath of walkFiles(rootPath, "", isMigrationInputPath)) {
    const content = fs.readFileSync(path.join(rootPath, relativePath));
    map.set(relativePath, { content: content.toString("utf8"), sha256: sha256(content) });
  }
  return map;
}

function decodeQuotedString(raw) {
  const quote = raw[0];
  const body = raw.slice(1, -1);
  if (quote === '"') {
    try { return JSON.parse(raw); } catch { return body.replaceAll('\\"', '"').replaceAll("\\\\", "\\"); }
  }
  return body
    .replaceAll("\\'", "'")
    .replaceAll("\\\"", '"')
    .replaceAll("\\\\", "\\")
    .replaceAll("\\n", "\n")
    .replaceAll("\\r", "\r")
    .replaceAll("\\t", "\t");
}

function tokenize(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const start = index;
    const char = source[index];
    if (/\s/.test(char)) { index += 1; continue; }
    if (char === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      index = close < 0 ? source.length : close + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") { index += 2; continue; }
        if (source[index] === char) { index += 1; break; }
        index += 1;
      }
      const raw = source.slice(start, index);
      tokens.push({ kind: "string", value: decodeQuotedString(raw), raw, start, end: index });
      continue;
    }
    if (char === "`") {
      index += 1;
      let interpolated = false;
      while (index < source.length) {
        if (source[index] === "\\") { index += 2; continue; }
        if (source[index] === "$" && source[index + 1] === "{") interpolated = true;
        if (source[index] === "`") { index += 1; break; }
        index += 1;
      }
      const raw = source.slice(start, index);
      tokens.push({ kind: "template", value: interpolated ? null : raw.slice(1, -1), raw, interpolated, start, end: index });
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) index += 1;
      tokens.push({ kind: "identifier", value: source.slice(start, index), raw: source.slice(start, index), start, end: index });
      continue;
    }
    if (/[0-9]/.test(char)) {
      index += 1;
      while (index < source.length && /[A-Za-z0-9_.]/.test(source[index])) index += 1;
      tokens.push({ kind: "number", value: source.slice(start, index), raw: source.slice(start, index), start, end: index });
      continue;
    }
    const operator = (OPERATORS_BY_FIRST_CHAR.get(char) ?? []).find((candidate) => source.startsWith(candidate, index));
    if (operator) {
      index += operator.length;
      tokens.push({ kind: "punct", value: operator, raw: operator, start, end: index });
    } else {
      index += 1;
      tokens.push({ kind: "punct", value: char, raw: char, start, end: index });
    }
  }
  return tokens;
}

function lineLocator(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (starts[middle] <= offset) low = middle + 1;
      else high = middle;
    }
    return low;
  };
}

function callArguments(tokens, openIndex) {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let firstEnd = openIndex + 1;
  let argCount = 0;
  for (let i = openIndex + 1; i < tokens.length; i += 1) {
    const value = tokens[i].value;
    if (value === "(" ) parenDepth += 1;
    else if (value === ")") {
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        if (argCount > 0) argCount += 1;
        else if (i > openIndex + 1) {
          firstEnd = i;
          argCount = 1;
        }
        return { firstStart: openIndex + 1, firstEnd, argCount, closeIndex: i };
      }
      parenDepth -= 1;
    } else if (value === "[") bracketDepth += 1;
    else if (value === "]") bracketDepth -= 1;
    else if (value === "{") braceDepth += 1;
    else if (value === "}") braceDepth -= 1;
    else if (value === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      if (argCount === 0) firstEnd = i;
      argCount += 1;
    }
    if (parenDepth < 0 || bracketDepth < 0 || braceDepth < 0) break;
  }
  return null;
}

function staticBindings(tokens) {
  const bindings = new Map();
  for (let i = 0; i < tokens.length - 3; i += 1) {
    if (!["const", "let", "var"].includes(tokens[i].value) || tokens[i + 1]?.kind !== "identifier" || tokens[i + 2]?.value !== "=") continue;
    const name = tokens[i + 1].value;
    const value = tokens[i + 3];
    if (value?.kind === "string" || (value?.kind === "template" && !value.interpolated)) {
      bindings.set(name, { values: [value.value], kind: "constant_string" });
      continue;
    }
    if (value?.value !== "[") continue;
    const values = [];
    let valid = true;
    let expectValue = true;
    let closed = false;
    for (let cursor = i + 4; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor];
      if (token.value === "]") { closed = true; break; }
      if (token.value === ",") { expectValue = true; continue; }
      if (!expectValue || (token.kind !== "string" && !(token.kind === "template" && !token.interpolated))) { valid = false; break; }
      values.push(token.value);
      expectValue = false;
    }
    if (closed && valid && values.length > 0) bindings.set(name, { values, kind: "constant_string_array" });
  }
  return bindings;
}

function arrayLiteralValues(tokens, startIndex, endIndex) {
  if (tokens[startIndex]?.value !== "[" || tokens[endIndex - 1]?.value !== "]") return null;
  const values = [];
  let expectValue = true;
  for (let cursor = startIndex + 1; cursor < endIndex - 1; cursor += 1) {
    const token = tokens[cursor];
    if (token.value === ",") { expectValue = true; continue; }
    if (!expectValue || (token.kind !== "string" && !(token.kind === "template" && !token.interpolated))) return null;
    values.push(token.value);
    expectValue = false;
  }
  return values.length ? values : null;
}

function normalizedTokens(tokens, source, startIndex, endIndex) {
  if (startIndex >= endIndex) return "";
  return source.slice(tokens[startIndex].start, tokens[endIndex - 1].end).replace(/\s+/g, " ").trim();
}

function firstArgument(tokens, source, args, bindings = new Map()) {
  if (!args || args.firstStart >= args.firstEnd) return { text: "", staticValue: null, kind: "missing" };
  const first = tokens[args.firstStart];
  const end = tokens[args.firstEnd - 1];
  if (args.firstEnd === args.firstStart + 1 && first.kind === "identifier" && bindings.has(first.value)) {
    const binding = bindings.get(first.value);
    return { text: first.value, staticValue: binding.values.length === 1 ? binding.values[0] : null, staticValues: binding.values, kind: binding.kind };
  }
  const arrayValues = arrayLiteralValues(tokens, args.firstStart, args.firstEnd);
  if (arrayValues) return { text: source.slice(first.start, end.end).replace(/\s+/g, " ").trim(), staticValue: null, staticValues: arrayValues, kind: "string_array" };
  if (args.firstEnd === args.firstStart + 1 && first.kind === "string") {
    return { text: first.raw, staticValue: first.value, staticValues: [first.value], kind: "string" };
  }
  if (args.firstEnd === args.firstStart + 1 && first.kind === "template" && !first.interpolated) {
    return { text: first.raw, staticValue: first.value, staticValues: [first.value], kind: "template" };
  }
  const text = source.slice(first.start, end.end).replace(/\s+/g, " ").trim();
  return { text, staticValue: null, staticValues: null, kind: first.kind === "template" ? "dynamic_template" : "expression" };
}

function routeReceiverNames(tokens) {
  const names = new Set(["app", "api", "router"]);
  for (let i = 0; i < tokens.length - 4; i += 1) {
    if (!["const", "let", "var"].includes(tokens[i].value) || tokens[i + 1]?.kind !== "identifier") continue;
    const name = tokens[i + 1].value;
    const lookahead = tokens.slice(i + 2, Math.min(i + 9, tokens.length)).map((token) => token.value);
    if (lookahead.includes("Router") || lookahead.includes("express") || lookahead.includes("createServer")) names.add(name);
  }
  for (let i = 0; i < tokens.length - 2; i += 1) {
    if (tokens[i].kind === "identifier" && tokens[i + 1].value === ":" && ["Router", "Express"].includes(tokens[i + 2]?.value)) names.add(tokens[i].value);
  }
  return names;
}

function classifySourceFamily(relativePath) {
  const normalized = normalizePath(relativePath);
  const families = familyForPath(normalized);
  if (families.includes("unknown_node_runtime_source")) return "unknown_node_runtime_source";
  const unclassifiedPackage = families.find((family) => family.startsWith("unclassified_package:"));
  if (unclassifiedPackage) return unclassifiedPackage;
  if (normalized.startsWith("server/src/routes/") || normalized.startsWith("server/src/bootstrap/")) return "public_http_and_routes";
  if (normalized.startsWith("server/src/middleware/") || normalized.startsWith("server/src/auth/")) return "http_middleware_and_auth";
  if (normalized.startsWith("server/src/realtime/")) return "websocket_and_streaming";
  if (normalized.startsWith("packages/db/") || normalized.startsWith("packages/identity-db/")) return "database_queries_and_writers";
  if (normalized.startsWith("packages/identity-core/") || normalized.startsWith("identity/")) return "identity_and_sessions";
  if (normalized.startsWith("cli/") || normalized.startsWith("packages/shared/")) return "first_party_cli_and_mcp";
  if (normalized.startsWith("desktop/")) return "electron_process_graph";
  if (normalized.startsWith("packages/agent-runtime-") || normalized.startsWith("packages/agent-runtimes/")
    || normalized.startsWith("packages/run-intelligence-core/")) return "rudder_owned_runtime_adapters";
  if (normalized.startsWith("scripts/") || normalized.startsWith("server/resources/") || normalized.startsWith("server/scripts/")) return "node_maintenance_and_lifecycle_tools";
  return "server_lifecycle_and_workers";
}

function familyForSurface(type, sourcePath, fallbackFamily) {
  if (type === "http_route") return "public_http_and_routes";
  if (type === "middleware_mount") return "http_middleware_and_auth";
  if (type === "websocket_event") return "websocket_and_streaming";
  if (type.startsWith("database_") || type === "sql_dml_candidate") return "database_queries_and_writers";
  if (type === "cli_command_candidate") return "first_party_cli_and_mcp";
  if (type === "mcp_tool_candidate") return sourcePath.startsWith("cli/") ? "first_party_cli_and_mcp" : "managed_mcp_and_plugins";
  if (type.startsWith("worker_") || type === "runtime_resource_ownership" || type === "listener_start" || type === "http_server_construction") return "server_lifecycle_and_workers";
  return fallbackFamily;
}

function scanSource(relativePath, source) {
  const tokens = tokenize(source);
  const getLine = lineLocator(source);
  const routeNames = routeReceiverNames(tokens);
  const bindings = staticBindings(tokens);
  const family = classifySourceFamily(relativePath);
  const surfaces = [];
  const unknown = [];
  const inServerRuntime = relativePath.startsWith("server/") || relativePath.startsWith("identity/");
  const inExpressRouteArea = relativePath.startsWith("server/src/");
  const inDatabaseRuntime = inServerRuntime
    || relativePath.startsWith("scripts/")
    || relativePath.startsWith("packages/db/")
    || relativePath.startsWith("packages/identity-db/");
  const inRouteArea = /(?:^|\/)routes?(?:\/|\.)/.test(relativePath)
    || relativePath.includes("/bootstrap/")
    || relativePath.endsWith("/app.ts");

  for (let i = 0; i < tokens.length; i += 1) {
    let methodToken = null;
    let receiver = null;
    let isMember = false;
    let openIndex = -1;
    if ([".", "?."].includes(tokens[i].value) && tokens[i + 1]?.kind === "identifier" && tokens[i + 2]?.value === "(") {
      isMember = true;
      receiver = tokens[i - 1]?.value ?? "<expression>";
      methodToken = tokens[i + 1];
      openIndex = i + 2;
    } else if (tokens[i].kind === "identifier" && tokens[i + 1]?.value === "(") {
      methodToken = tokens[i];
      openIndex = i + 1;
    }
    if (!methodToken) continue;

    const method = methodToken.value;
    const args = callArguments(tokens, openIndex);
    if (!args) {
      if ((ROUTE_METHODS.has(method) && inRouteArea) || WORKER_METHODS.has(method)) {
        unknown.push({ type: "unclosed_call", source: relativePath, line: getLine(methodToken.start), method });
      }
      continue;
    }
    const first = firstArgument(tokens, source, args, bindings);
    const location = getLine(methodToken.start);
    const isRouteReceiver = isMember && routeNames.has(receiver);
    const addSurface = (type, signature, details = {}) => surfaces.push({
      type, family: familyForSurface(type, relativePath, family), source: relativePath, line: location, signature, ...details,
    });

    if (inExpressRouteArea && isRouteReceiver && ROUTE_METHODS.has(method)) {
      const paths = first.staticValues ?? (first.staticValue === null ? null : [first.staticValue]);
      if (paths) {
        for (const pathText of paths) {
          const signature = `${relativePath}|http-route|${receiver}|${method.toUpperCase()}|${pathText}`;
          addSurface("http_route", signature, { receiver, method: method.toUpperCase(), path: pathText });
        }
      } else {
        const signature = `${relativePath}|http-route|${receiver}|${method.toUpperCase()}|${first.text}`;
        addSurface("http_route", signature, { receiver, method: method.toUpperCase(), path_expression: first.text });
        unknown.push({ type: "dynamic_http_route_path", source: relativePath, line: location, method: method.toUpperCase(), expression: first.text });
      }
    }

    if (inExpressRouteArea && isRouteReceiver && method === "use") {
      const hasExplicitHandler = args.argCount >= 2;
      const mountPaths = first.staticValues ?? (first.staticValue === null ? null : [first.staticValue]);
      if (mountPaths) {
        for (const mountPath of mountPaths) {
          const signature = `${relativePath}|middleware|${receiver}|${mountPath}`;
          addSurface("middleware_mount", signature, { receiver, mount_path: mountPath });
        }
      } else {
        const signature = `${relativePath}|middleware|${receiver}|<handler:${first.text}>`;
        const admissionId = Object.entries(TRUSTED_TRANSPORT_ADMISSIONS).find(([, policy]) => {
          if (relativePath !== policy.source_path || receiver !== policy.receiver || args.argCount !== 1) return false;
          if (first.text === policy.mount_expression) return true;
          // Tag a narrowly recognized candidate so comparison can reject it
          // explicitly when its source hash is not the approved conditional variant.
          return policy.conditional_source_variants?.some((variant) =>
            variant.additional_mounts.some((mount) => first.text === mount.expression)
          ) ?? false;
        })?.[0];
        addSurface("middleware_mount", signature, {
          receiver,
          expression: first.text,
          ...(admissionId ? { transport_admission: admissionId } : {}),
        });
        if (hasExplicitHandler) unknown.push({ type: "dynamic_middleware_mount", source: relativePath, line: location, receiver, expression: first.text });
      }
    }

    if (inServerRuntime && isMember && method === "on" && first.staticValue !== null && WS_EVENTS.has(first.staticValue)) {
      addSurface("websocket_event", `${relativePath}|websocket|${receiver}|${first.staticValue}`, { receiver, event: first.staticValue });
    }
    if (inServerRuntime && isMember && method === "on" && first.staticValue === null && /websocket|realtime|(?:^|\/)ws(?:\.|\/)/i.test(relativePath)) {
      unknown.push({ type: "dynamic_websocket_event", source: relativePath, line: location, expression: first.text });
    }

    if (inServerRuntime && method === "createServer") {
      addSurface("http_server_construction", `${relativePath}|http-server|${first.text}`, { expression: first.text });
    }
    if (inServerRuntime && isMember && method === "listen") {
      addSurface("listener_start", `${relativePath}|listener|${receiver}|${first.text}`, { receiver, expression: first.text });
    }

    const databaseReceiver = isMember && (DATABASE_RECEIVER.test(receiver)
      || (receiver === "client" && ["execute", "query", "run"].includes(method)));
    if (inDatabaseRuntime && databaseReceiver && DATABASE_CALL_METHODS.has(method)) {
      const target = first.staticValue ?? first.text;
      addSurface("database_call_candidate", `${relativePath}|db-call|${receiver}|${method}|${target}`, {
        receiver, method, target, certainty: "structural_candidate_requires_semantic_review",
      });
    }
    const databaseWriteMethod = ["insert", "update", "delete"].includes(method)
      || (["execute", "query", "run"].includes(method) && databaseReceiver)
      || (["execute", "query"].includes(method) && /^(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i.test(first.staticValue ?? ""));
    if (inDatabaseRuntime && databaseReceiver && databaseWriteMethod) {
      const target = first.kind === "identifier" || first.kind === "string" ? first.staticValue ?? first.text : first.text;
      const signature = `${relativePath}|db-write-candidate|${receiver}|${method}|${target}`;
      addSurface("database_write_candidate", signature, { receiver, method, target, certainty: "structural_candidate_requires_semantic_review" });
      if (["execute", "query", "run"].includes(method) && databaseReceiver
        && first.kind !== "string" && !/^(?:sql|\w+\.(?:select|insert|update|delete)\b)/i.test(first.text)) {
        unknown.push({ type: "dynamic_database_statement", source: relativePath, line: location, receiver, method, expression: first.text });
      }
    }

    if (inServerRuntime && WORKER_METHODS.has(method)) {
      const signature = `${relativePath}|worker-schedule-candidate|${isMember ? `${receiver}.` : ""}${method}|${first.text}`;
      addSurface("worker_schedule_candidate", signature, { receiver: isMember ? receiver : null, method, expression: first.text });
    }

    if (inServerRuntime && isMember && method === "own") {
      addSurface("runtime_resource_ownership", `${relativePath}|supervisor-own|${first.staticValue ?? first.text}`, { receiver, resource: first.staticValue ?? first.text });
    }

    if ((relativePath.startsWith("cli/") || relativePath.startsWith("server/"))
      && isMember && (method === "command" || MCP_METHODS.has(method))) {
      const type = MCP_METHODS.has(method) ? "mcp_tool_candidate" : "cli_command_candidate";
      addSurface(type, `${relativePath}|${type}|${receiver}|${method}|${first.staticValue ?? first.text}`, { receiver, method, name: first.staticValue });
      if (first.staticValue === null) unknown.push({ type: "dynamic_cli_or_mcp_registration", source: relativePath, line: location, method, expression: first.text });
    }
  }

  if (relativePath === "identity/src/handler.ts") {
    for (let i = 0; i < tokens.length - 3; i += 1) {
      if (tokens[i].value !== "if" || tokens[i + 1]?.value !== "(") continue;
      let depth = 0;
      let end = i + 1;
      for (; end < tokens.length; end += 1) {
        if (tokens[end].value === "(") depth += 1;
        else if (tokens[end].value === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (depth !== 0) {
        unknown.push({ type: "unclosed_identity_route_condition", source: relativePath, line: getLine(tokens[i].start) });
        continue;
      }
      const condition = tokens.slice(i + 2, end);
      const methods = [];
      const paths = [];
      let hasPathTest = false;
      for (let cursor = 0; cursor < condition.length - 3; cursor += 1) {
        if (condition[cursor].value === "." && condition[cursor + 1]?.value === "method"
          && ["===", "=="].includes(condition[cursor + 2]?.value) && condition[cursor + 3]?.kind === "string") {
          methods.push(condition[cursor + 3].value.toUpperCase());
        }
        if (condition[cursor].value === "." && condition[cursor + 1]?.value === "pathname") {
          hasPathTest = true;
          if (["===", "=="].includes(condition[cursor + 2]?.value) && condition[cursor + 3]?.kind === "string") {
            paths.push({ path: condition[cursor + 3].value, match: "exact" });
          } else if (["===", "=="].includes(condition[cursor + 2]?.value) && condition[cursor + 3]?.kind === "identifier") {
            const binding = bindings.get(condition[cursor + 3].value);
            if (binding) for (const routePath of binding.values) paths.push({ path: routePath, match: "exact" });
            else unknown.push({ type: "dynamic_identity_http_route_path", source: relativePath, line: getLine(condition[cursor].start), expression: condition[cursor + 3].value });
          } else if (condition[cursor + 2]?.value === "." && condition[cursor + 3]?.value === "startsWith" && condition[cursor + 4]?.value === "(") {
            const pathArg = firstArgument(condition, source, callArguments(condition, cursor + 4), bindings);
            if (pathArg.staticValue !== null) paths.push({ path: pathArg.staticValue, match: "prefix" });
            else if (pathArg.staticValues) for (const routePath of pathArg.staticValues) paths.push({ path: routePath, match: "prefix" });
            else unknown.push({ type: "dynamic_identity_http_route_path", source: relativePath, line: getLine(condition[cursor].start), expression: pathArg.text });
          }
        }
      }
      for (const method of new Set(methods)) {
        for (const routePath of paths) {
          const location = getLine(tokens[i].start);
          const signature = `${relativePath}|http-route|node-handler|${method}|${routePath.match}:${routePath.path}`;
          surfaces.push({ type: "http_route", family: familyForSurface("http_route", relativePath, family), source: relativePath, line: location, signature, receiver: "node-handler", method, path: routePath.path, path_match: routePath.match });
        }
      }
      if (methods.length && hasPathTest && !paths.length) unknown.push({ type: "dynamic_identity_http_route_path", source: relativePath, line: getLine(tokens[i].start), method: [...new Set(methods)] });
    }
  }

  // Dynamic SQL and direct DML literals are useful write-family signals even
  // when they are not passed through a recognized ORM method.
  for (const token of tokens) {
    if (!["string", "template"].includes(token.kind)) continue;
    const sqlText = token.value ?? token.raw;
    const match = sqlText.match(/^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE\s+TABLE)\s+([\w."`]+)/i);
    if (match) {
      const operation = match[1].toUpperCase().replace(/\s+/g, " ");
      const table = match[2];
      surfaces.push({
        type: "sql_dml_candidate", family, source: relativePath, line: getLine(token.start),
        signature: `${relativePath}|sql-dml|${operation}|${table}`, operation, table,
        certainty: "structural_candidate_requires_semantic_review",
      });
      if (token.kind === "template" && token.interpolated) unknown.push({ type: "interpolated_sql_dml", source: relativePath, line: getLine(token.start), operation, table });
    }
  }

  if (family.startsWith("unclassified_") || family === "unknown_node_runtime_source") {
    unknown.push({ type: "unmapped_node_source_family", source: relativePath, families: [family] });
  }
  // Full-file hashes in the manifest remain authoritative. Surface strings are
  // bounded for reviewability; long expressions retain a digest so distinct
  // candidates cannot collapse to the same displayed prefix.
  surfaces.forEach(compactInventoryRecord);
  unknown.forEach(compactInventoryRecord);
  return { surfaces, unknown };
}

function buildInventory(rootPath, reviewedNodeChanges = [], reviewedTransportAdmissions, reviewedLegacyFenceChanges = []) {
  const sources = readCurrentSources(rootPath);
  const migrations = readCurrentMigrations(rootPath);
  const manifest = [];
  const migrationManifest = [];
  const surfaces = [];
  const unknown = [];
  for (const [relativePath, source] of [...sources.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const families = familyForPath(relativePath);
    const scan = scanSource(relativePath, source.content);
    const sourceFamilies = [...new Set([...families, ...scan.surfaces.map((surface) => surface.family)])].sort();
    manifest.push({ path: relativePath, sha256: source.sha256, families: sourceFamilies });
    surfaces.push(...scan.surfaces);
    unknown.push(...scan.unknown);
  }
  for (const [relativePath, migration] of [...migrations.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const kind = relativePath.endsWith(".sql")
      ? "sql"
      : relativePath.endsWith("/_journal.json")
        ? "journal"
        : "snapshot";
    migrationManifest.push({ path: relativePath, sha256: migration.sha256, kind });
    if (kind === "journal") {
      try {
        const journal = JSON.parse(migration.content);
        if (!Array.isArray(journal.entries)) throw new Error("entries is not an array");
      } catch (error) {
        unknown.push({ type: "invalid_migration_journal", source: relativePath, detail: error.message });
      }
    }
  }
  surfaces.sort((a, b) => a.signature.localeCompare(b.signature) || a.line - b.line);
  const familyCounts = Object.fromEntries(FAMILY_DEFINITIONS.map((family) => [family.id, {
    source_files: manifest.filter((entry) => entry.families.includes(family.id)).length,
    structural_surfaces: surfaces.filter((surface) => surface.family === family.id).length,
  }]));
  const surfaceCounts = Object.fromEntries([...new Set(surfaces.map((surface) => surface.type))].sort().map((type) => [type, surfaces.filter((surface) => surface.type === type).length]));
  const journalSummaries = migrationManifest.filter((entry) => entry.kind === "journal").map((entry) => {
    try {
      const journal = JSON.parse(migrations.get(entry.path).content);
      const migrationDirectory = entry.path.slice(0, -"/meta/_journal.json".length);
      const sqlFiles = migrationManifest.filter((candidate) => candidate.kind === "sql"
        && path.posix.dirname(candidate.path) === migrationDirectory);
      const referenced = new Set(journal.entries.map((journalEntry) => `${migrationDirectory}/${journalEntry.tag}.sql`));
      const unjournaledSqlFiles = sqlFiles.map((candidate) => candidate.path).filter((candidate) => !referenced.has(candidate));
      const missingSqlFiles = [...referenced].filter((candidate) => !migrations.has(candidate));
      for (const missingPath of missingSqlFiles) unknown.push({ type: "journal_entry_missing_sql_migration", source: entry.path, migration: missingPath });
      return {
        path: entry.path,
        entries: journal.entries.length,
        latest_tag: journal.entries.at(-1)?.tag ?? null,
        unjournaled_sql_files: unjournaledSqlFiles,
        missing_sql_files: missingSqlFiles,
      };
    } catch {
      return { path: entry.path, entries: null, latest_tag: null, unjournaled_sql_files: [], missing_sql_files: [] };
    }
  });
  unknown.sort((a, b) => `${a.type}|${a.source}|${a.line ?? 0}|${a.expression ?? ""}|${a.migration ?? ""}`.localeCompare(`${b.type}|${b.source}|${b.line ?? 0}|${b.expression ?? ""}|${b.migration ?? ""}`));
  const backendSourceFiles = manifest.filter((entry) => !entry.path.startsWith("desktop/src/")).length;
  const inventory = {
    schema_version: "1.0",
    generated_by: "scripts/rust-backend-authority-inventory.mjs",
    source_scope: {
      description: "Production Node/Rudder-owned runtime sources plus database migration inputs; UI, tests, docs, native Rust, and unreferenced generated build outputs are excluded.",
      rules: "Resident source trees under server, identity, cli, desktop, or packages/*/src are inventoried, except packages/shared contracts. Other executable JS/TS is inventoried as unknown unless it is under an explicit UI, documentation, test, build, or tooling root. Files in test/generated/build-output-looking paths that are imported by a production source are pulled into the manifest. Database SQL files, Drizzle journals, and snapshots are separately inventoried.",
      semantic_limit: "Hashes and lexical structural candidates expose source and recognizable entrypoint changes; they do not prove business semantics or complete authority ownership. Every modified Node runtime source needs a reviewer-bound Rust ownership, compatibility-boundary, and retirement record. The Git review remains responsible for semantic authority review.",
    },
    authority_families: FAMILY_DEFINITIONS.map((family) => ({ ...family, ...(familyCounts[family.id] ?? { source_files: 0, structural_surfaces: 0 }) })),
    source_manifest: manifest,
    migration_manifest: migrationManifest,
    migration_summary: {
      sql_files: migrationManifest.filter((entry) => entry.kind === "sql").length,
      journal_files: migrationManifest.filter((entry) => entry.kind === "journal").length,
      snapshot_files: migrationManifest.filter((entry) => entry.kind === "snapshot").length,
      journals: journalSummaries,
      unjournaled_sql_files: journalSummaries.flatMap((journal) => journal.unjournaled_sql_files),
    },
    structural_surface_counts: surfaceCounts,
    structural_surfaces: surfaces,
    unknown,
    completion_gate: {
      blocked: unknown.length > 0 || backendSourceFiles > 0,
      blocking_unknown_count: unknown.length,
      remaining_backend_node_source_files: backendSourceFiles,
      excluded_retained_electron_shell_source_files: manifest.length - backendSourceFiles,
      reason: "Unknown/unclassified Node surfaces or any remaining backend Node source block a full Rust-backend completion claim. Electron shell source is inventoried as an explicit retained exception. Structural inventory is not semantic acceptance.",
    },
    reviewed_node_changes: reviewedNodeChanges,
    reviewed_legacy_fence_changes: reviewedLegacyFenceChanges,
  };
  if (reviewedTransportAdmissions !== undefined) inventory.reviewed_transport_admissions = reviewedTransportAdmissions;
  return inventory;
}

function readInventory(inventoryPath) {
  try {
    return JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function stableGeneratedPart(inventory) {
  const {
    reviewed_node_changes: _nodeRecords,
    reviewed_transport_admissions: _transportRecords,
    reviewed_legacy_fence_changes: _legacyFenceRecords,
    ...generated
  } = inventory;
  return generated;
}

function writeInventory(inventoryPath, current, prior) {
  fs.mkdirSync(path.dirname(inventoryPath), { recursive: true });
  const output = { ...current, reviewed_node_changes: prior?.reviewed_node_changes ?? [] };
  output.reviewed_legacy_fence_changes = prior?.reviewed_legacy_fence_changes ?? [];
  if (prior && Object.hasOwn(prior, "reviewed_transport_admissions")) {
    output.reviewed_transport_admissions = prior.reviewed_transport_admissions;
  }
  fs.writeFileSync(inventoryPath, `${JSON.stringify(output, null, 2)}\n`);
}

function git(rootPath, args, options = {}) {
  return execFileSync("git", args, { cwd: rootPath, encoding: options.encoding === null ? null : options.encoding ?? "utf8", maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

function baseTrackedPaths(rootPath, compareRef) {
  const output = git(rootPath, ["ls-tree", "-r", "--name-only", "-z", compareRef]);
  return output.split("\0").filter((entry) => entry && (
    isPotentialNodeSource(entry)
    || isMigrationInputPath(entry)
    || (SOURCE_EXTENSIONS.has(path.posix.extname(entry))
      && isTestOrGeneratedPath(entry)
      && !isUiOrDocsPath(entry)
      && !entry.startsWith("packages/shared/")
      && !entry.startsWith("scripts/")
      && !entry.startsWith("desktop/scripts/")
      && !entry.startsWith("server/scripts/")
      && !entry.startsWith("cli/scripts/")
      && !entry.startsWith("identity/scripts/")
      && !entry.startsWith("server/resources/")
      && !entry.startsWith(".github/")
      && !entry.startsWith("docker/openclaw-smoke/"))
  )).sort();
}

function countSignatures(surfaces, types) {
  const result = new Map();
  for (const surface of surfaces) {
    if (!types.has(surface.type)) continue;
    result.set(surface.signature, (result.get(surface.signature) ?? 0) + 1);
  }
  return result;
}

function findAppUseCalls(source, receiver = "app") {
  const tokens = tokenize(source);
  const bindings = staticBindings(tokens);
  const calls = [];
  for (let index = 0; index < tokens.length - 3; index += 1) {
    if (tokens[index].value !== receiver || tokens[index + 1]?.value !== "."
      || tokens[index + 2]?.value !== "use" || tokens[index + 3]?.value !== "(") continue;
    const args = callArguments(tokens, index + 3);
    if (!args) continue;
    const first = firstArgument(tokens, source, args, bindings);
    calls.push({
      start: tokens[index].start,
      end: tokens[args.closeIndex].end,
      expression: first.text,
      static_path: first.staticValue,
      argument_count: args.argCount,
    });
  }
  return { tokens, calls };
}

function findMatchingToken(tokens, openIndex, openValue, closeValue) {
  if (tokens[openIndex]?.value !== openValue) return -1;
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index].value === openValue) depth += 1;
    else if (tokens[index].value === closeValue) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findTokenSequence(tokens, expression) {
  if (!expression) return -1;
  const expected = tokenize(expression).map((token) => token.value);
  if (!expected.length) return -1;
  for (let index = 0; index <= tokens.length - expected.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < expected.length; offset += 1) {
      if (tokens[index + offset]?.value !== expected[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return index;
  }
  return -1;
}

function hasExactNamedImport(tokens, exportName, specifier) {
  let matchingImports = 0;
  for (let index = 0; index < tokens.length - 5; index += 1) {
    if (tokens[index].value !== "import" || tokens[index + 1]?.value !== "{"
      || tokens[index + 2]?.value !== exportName || tokens[index + 3]?.value !== "}"
      || tokens[index + 4]?.value !== "from" || tokens[index + 5]?.kind !== "string"
      || tokens[index + 5]?.value !== specifier) continue;
    matchingImports += 1;
  }
  const identifierOccurrences = tokens.filter((token) => token.value === exportName).length;
  return matchingImports === 1 && identifierOccurrences === 2;
}

function validateTransportAdmissionSource(policy, source, sourcePath, sourceHash = sha256(source)) {
  const problems = [];
  if (sourcePath !== policy.source_path) problems.push("mount source path does not match trusted policy");
  const sourceVariant = conditionalTransportSourceVariant(policy, sourceHash);
  if (policy.conditional_source_variants?.length && sourceHash !== policy.source_sha256 && !sourceVariant) {
    problems.push("mount source hash does not match any trusted caller variant");
  }
  const { tokens, calls } = findAppUseCalls(source, policy.receiver);
  const proofCalls = calls.filter((call) => call.expression === policy.mount_expression);
  if (policy.validation_kind === "compatibility_mount") {
    if (proofCalls.length !== 1) {
      problems.push(`expected exactly one exact ${policy.admission_label} app.use mount`);
    } else {
      const proofCall = proofCalls[0];
      if (proofCall.argument_count !== 1) {
        problems.push(`${policy.admission_label} must use the single-argument app.use form`);
      }
      if (policy.mount_guard && !proofCall.expression.includes(policy.mount_guard)) {
        problems.push(`${policy.admission_label} must carry the exact configured native-path guard argument`);
      }
      const proofTokenIndex = tokens.findIndex((token) => token.start === proofCall.start);
      const anchorIndex = (expression, callAware) => {
        if (!expression) return -1;
        if (callAware) {
          const anchor = calls.find((call) => call.expression === expression);
          return anchor ? tokens.findIndex((token) => token.start === anchor.start) : -1;
        }
        return findTokenSequence(tokens, expression);
      };
      const after = anchorIndex(policy.order_after_expression, policy.order_after_call);
      const before = anchorIndex(policy.order_before_expression, policy.order_before_call);
      if (policy.order_after_expression && after < 0) problems.push(`${policy.admission_label} is missing its order-after anchor`);
      if (policy.order_before_expression && before < 0) problems.push(`${policy.admission_label} is missing its order-before anchor`);
      if (after >= 0 && after >= proofTokenIndex) problems.push(`${policy.admission_label} must appear after its order-after anchor`);
      if (before >= 0 && before <= proofTokenIndex) problems.push(`${policy.admission_label} must appear before its order-before anchor`);
    }
    return problems;
  }
  if (proofCalls.length !== 1) problems.push(`expected exactly one exact ${policy.admission_label} app.use mount`);
  if (!hasExactNamedImport(tokens, policy.factory_export, policy.factory_import)) {
    problems.push("factory must be imported once by its exact named export from the trusted module");
  }

  const previewCalls = calls.filter((call) => call.static_path === "/workspace-preview");
  const previewHandlerCalls = calls.filter((call) => call.expression.includes("workspacePreview.handlePreviewHostRequest"));
  const parserCalls = calls.filter((call) => /^(?:express|bodyParser)\.(?:json|raw|text|urlencoded)\s*\(/.test(call.expression));
  if (previewCalls.length !== 1) problems.push("expected exactly one reserved /workspace-preview 404 mount before proof admission");
  if (previewHandlerCalls.length !== 1) problems.push("expected exactly one workspace preview host admission before proof admission");
  if (parserCalls.length === 0) problems.push("expected a recognized body parser after proof admission");

  if (proofCalls.length === 1 && previewCalls.length === 1 && previewHandlerCalls.length === 1 && parserCalls.length > 0) {
    const proofIndex = calls.indexOf(proofCalls[0]);
    const previewIndex = calls.indexOf(previewCalls[0]);
    const previewHandlerIndex = calls.indexOf(previewHandlerCalls[0]);
    const parserIndex = calls.indexOf(parserCalls[0]);
    if (previewHandlerIndex !== previewIndex - 1) problems.push("workspace preview host handling must immediately precede its reserved 404 mount");
    if (proofIndex !== previewIndex + 1) problems.push("proof admission must immediately follow the reserved workspace preview mount");
    if (parserIndex !== proofIndex + 1) problems.push("proof admission must immediately precede the first body parser");
    if (proofCalls[0].argument_count !== 1) problems.push("proof admission must use the single-argument app.use form");
    if (previewHandlerCalls[0].start >= proofCalls[0].start) problems.push("workspace preview host handling must precede proof admission");
    if (proofCalls[0].start >= parserCalls[0].start) problems.push("proof admission must run before body parsing");
  }

  const proofCall = proofCalls[0];
  if (proofCall) {
    const proofTokenIndex = tokens.findIndex((token) => token.start === proofCall.start);
    let guardMatches = 0;
    for (let index = 0; index < proofTokenIndex; index += 1) {
      if (tokens[index].value !== "if" || tokens[index + 1]?.value !== "(") continue;
      const conditionEnd = findMatchingToken(tokens, index + 1, "(", ")");
      if (conditionEnd < 0 || normalizedTokens(tokens, source, index + 2, conditionEnd) !== policy.mount_guard) continue;
      if (tokens[conditionEnd + 1]?.value !== "{") continue;
      const bodyEnd = findMatchingToken(tokens, conditionEnd + 1, "{", "}");
      if (bodyEnd > proofTokenIndex) guardMatches += 1;
    }
    if (guardMatches !== 1) problems.push(`${policy.admission_label} must be mounted once inside the exact configured ingress-auth guard`);
  }

  const actorCalls = calls.filter((call) => call.expression.startsWith("actorMiddleware("));
  if (actorCalls.length !== 1 || !proofCall || actorCalls[0].start <= proofCall.start) {
    problems.push("proof admission must precede the existing actor resolver");
  }
  for (const mount of sourceVariant?.additional_mounts ?? []) {
    const matches = calls.filter((call) => call.expression === mount.expression);
    if (matches.length !== 1 || matches[0].argument_count !== 1) {
      problems.push("conditional Rust email-auth fence must use its one exact single-argument app.use mount");
      continue;
    }
    const mountTokenIndex = tokens.findIndex((token) => token.start === matches[0].start);
    let exactGuardMatches = 0;
    for (let index = 0; index < mountTokenIndex; index += 1) {
      if (tokens[index].value !== "if" || tokens[index + 1]?.value !== "(") continue;
      const conditionEnd = findMatchingToken(tokens, index + 1, "(", ")");
      if (conditionEnd < 0 || normalizedTokens(tokens, source, index + 2, conditionEnd) !== mount.guard) continue;
      if (tokens[conditionEnd + 1]?.value !== "{") continue;
      const bodyEnd = findMatchingToken(tokens, conditionEnd + 1, "{", "}");
      if (bodyEnd > mountTokenIndex) exactGuardMatches += 1;
    }
    if (exactGuardMatches !== 1) problems.push("conditional Rust email-auth fence must be inside the exact Rust public-ingress guard");
    const wildcardIndex = findTokenSequence(tokens, mount.order_before);
    if (wildcardIndex < 0 || mountTokenIndex >= wildcardIndex) {
      problems.push("conditional Rust email-auth fence must precede the Better Auth wildcard handler");
    }
  }
  return problems;
}

function validateTransportAdmissionRecord(record, policy, headInventory, headContents) {
  const problems = [];
  if (!record) return ["missing reviewed_transport_admissions record"];
  if (record.id !== policy.id) problems.push("record id does not match the trusted transport-admission capability");
  if (record.mount_source_path !== policy.source_path) problems.push("mount_source_path does not match trusted policy");
  if (record.mount_receiver !== policy.receiver) problems.push("mount_receiver does not match trusted policy");
  if (record.mount_expression !== policy.mount_expression) problems.push("mount_expression does not match trusted policy");
  if (record.mount_guard !== policy.mount_guard) problems.push("mount_guard does not match trusted policy");
  if (record.order_after !== policy.order_after) problems.push("order_after does not match trusted policy");
  if (record.order_before !== policy.order_before) problems.push("order_before does not match trusted policy");
  if (record.factory_path !== policy.factory_path) problems.push("factory_path does not match trusted policy");
  if (record.factory_export !== policy.factory_export) problems.push("factory_export does not match trusted policy");
  if (record.factory_sha256 !== policy.factory_sha256) problems.push("factory_sha256 does not match trusted policy");
  if (record.rust_proof_owner !== policy.rust_proof_owner) problems.push("rust_proof_owner does not match trusted policy");
  for (const field of ["mount_source_sha256", "compatibility_boundary", "retirement_criterion", "reviewer", "review_reference"]) {
    if (typeof record[field] !== "string" || !record[field].trim()) problems.push(`${field} is required`);
  }
  if (record.review_status !== "reviewed") problems.push('review_status must be "reviewed"');

  const mountSource = headContents.get(policy.source_path);
  if (policy.validation_kind === "compatibility_mount") {
    if (!mountSource) problems.push("trusted mount source is absent from the candidate inventory");
    else {
      const manifestMountSource = headInventory.source_manifest.find((entry) => entry.path === policy.source_path);
      if (!manifestMountSource) problems.push("trusted mount source is absent from the candidate inventory");
      else if (manifestMountSource.sha256 !== mountSource.sha256) problems.push("mount source content hash disagrees with the candidate inventory");
      if (record.mount_source_sha256 !== mountSource.sha256) problems.push("mount_source_sha256 does not match candidate source");
      problems.push(...validateTransportAdmissionSource(policy, mountSource.content, policy.source_path, mountSource.sha256));
    }
    return problems;
  }
  const factorySource = headContents.get(policy.factory_path);
  const manifestMountSource = headInventory.source_manifest.find((entry) => entry.path === policy.source_path);
  const manifestFactorySource = headInventory.source_manifest.find((entry) => entry.path === policy.factory_path);
  if (!mountSource || !manifestMountSource) problems.push("trusted mount source is absent from the candidate inventory");
  else {
    if (manifestMountSource.sha256 !== mountSource.sha256) problems.push("mount source content hash disagrees with the candidate inventory");
    if (policy.source_sha256 && mountSource.sha256 !== policy.source_sha256
      && !conditionalTransportSourceVariant(policy, mountSource.sha256)) {
      problems.push("mount source hash does not match the trusted allowlist");
    }
    if (record.mount_source_sha256 !== mountSource.sha256) problems.push("mount_source_sha256 does not match candidate source");
    problems.push(...validateTransportAdmissionSource(policy, mountSource.content, policy.source_path, mountSource.sha256));
  }
  if (!factorySource || !manifestFactorySource) problems.push("trusted factory source is absent from the candidate inventory");
  else {
    if (manifestFactorySource.sha256 !== factorySource.sha256) problems.push("factory source content hash disagrees with the candidate inventory");
    if (factorySource.sha256 !== policy.factory_sha256) problems.push("factory source hash does not match the trusted allowlist");
  }
  return problems;
}

function recordMap(records) {
  return new Map((Array.isArray(records) ? records : []).map((record) => [record.path, record]));
}

function validateBoundaryRecord(record, pathValue, baseHash, headHash, expectedChangeKind, options = {}) {
  const problems = [];
  if (!record) return ["missing reviewed_node_changes record"];
  if (record.path !== pathValue) problems.push("record path does not match source path");
  if (record.change_kind !== expectedChangeKind) problems.push(`change_kind must be ${JSON.stringify(expectedChangeKind)}`);
  if (record.base_sha256 !== baseHash) problems.push("base_sha256 does not match trusted base source");
  if (record.head_sha256 !== headHash) problems.push("head_sha256 does not match candidate source");
  if (options.requireRustAuthority !== false
    && (typeof record.rust_authority !== "string" || !record.rust_authority.trim())) {
    problems.push("rust_authority is required");
  }
  if (typeof record.compatibility_boundary !== "string" || !record.compatibility_boundary.trim()) problems.push("compatibility_boundary is required");
  if (options.requireRetirementCriterion !== false
    && (typeof record.retirement_criterion !== "string" || !record.retirement_criterion.trim())) {
    problems.push("retirement_criterion is required");
  }
  if (typeof record.reviewer !== "string" || !record.reviewer.trim()) problems.push("reviewer is required");
  if (typeof record.review_reference !== "string" || !record.review_reference.trim()) problems.push("review_reference is required");
  if (record.review_status !== "reviewed") problems.push('review_status must be "reviewed"');
  return problems;
}

function isRetainedElectronClientSource(sourcePath, baseEntry, headEntry) {
  const eligibleManifestEntry = (entry) => entry?.families?.length === 1
    && entry.families[0] === "electron_process_graph";
  return RETAINED_ELECTRON_CLIENT_PATHS.has(sourcePath)
    && /^desktop\/src\/[^/]+\.ts$/.test(sourcePath)
    && eligibleManifestEntry(baseEntry)
    && eligibleManifestEntry(headEntry);
}

function validateRetainedClientRecord(record, sourcePath, baseHash, headHash) {
  const problems = validateBoundaryRecord(
    record,
    sourcePath,
    baseHash,
    headHash,
    "modified_retained_client",
    { requireRustAuthority: false, requireRetirementCriterion: false },
  );
  if (record?.node_role !== "retained_client") problems.push('node_role must be "retained_client"');
  if (record && Object.hasOwn(record, "rust_authority")) {
    problems.push("retained_client records must not claim rust_authority; use associated_backend_authority only for a related backend owner");
  }
  if (typeof record?.client_responsibility !== "string" || !record.client_responsibility.trim()) {
    problems.push("client_responsibility is required for retained client changes");
  }
  if (record && Object.hasOwn(record, "associated_backend_authority")
    && (typeof record.associated_backend_authority !== "string" || !record.associated_backend_authority.trim())) {
    problems.push("associated_backend_authority must be a nonempty related backend owner when provided");
  }
  return problems;
}

const LEGACY_FENCE_RECORD_FIELDS = new Set([
  "id", "path", "base_sha256", "head_sha256", "change_kind", "semantic_operation", "transaction_mapping_id",
  "base_surface", "head_surface", "head_surfaces", "base_protected_surface", "head_protected_surface", "head_guard_callsite", "guard_helper_id",
  "helper_name", "queue_helper_id", "conversation_helper_id",
  "rust_authority", "compatibility_boundary", "retirement_criterion", "reviewer", "review_reference", "review_status",
]);

function exactSurfaceRef(surface) {
  return surface && typeof surface === "object"
    && typeof surface.type === "string" && typeof surface.signature === "string"
    && Number.isInteger(surface.line) && surface.line > 0
    && Object.keys(surface).length === 3
    && Object.hasOwn(surface, "type") && Object.hasOwn(surface, "signature") && Object.hasOwn(surface, "line")
    ? { type: surface.type, signature: surface.signature, line: surface.line }
    : null;
}

function sameSurfaceRef(left, right) {
  return Boolean(left && right && left.type === right.type
    && left.signature === right.signature && left.line === right.line);
}

function hasSurface(inventory, sourcePath, reference) {
  return inventory.structural_surfaces.some((surface) => surface.source === sourcePath
    && sameSurfaceRef(surface, reference));
}

function findMappedTransactionSurface(record, baseInventory, headInventory) {
  const mapping = (headInventory.reviewed_legacy_fence_changes ?? []).find((entry) => entry?.id === record.transaction_mapping_id
    && entry?.path === record.path && entry?.change_kind === "existing_operation_mapping");
  const reference = exactSurfaceRef(mapping?.head_surface);
  if (!reference) return null;
  return headInventory.structural_surfaces.find((surface) => surface.source === record.path
    && surface.type === "database_call_candidate" && surface.method === "transaction" && sameSurfaceRef(surface, reference)) ?? null;
}

function sourceCallsiteForSurface(source, reference) {
  if (typeof source !== "string" || !reference) return null;
  const tokens = tokenize(source);
  const getLine = lineLocator(source);
  const matches = [];
  for (let index = 1; index + 2 < tokens.length; index += 1) {
    if (![".", "?."].includes(tokens[index].value)
      || tokens[index + 1]?.value !== reference.method
      || tokens[index + 2]?.value !== "(") continue;
    const receiver = tokens[index - 1]?.value;
    if (receiver !== reference.receiver || getLine(tokens[index + 1].start) !== reference.line) continue;
    let args = callArguments(tokens, index + 2);
    if (!args) continue;
    let endIndex = args.closeIndex;
    let cursor = endIndex + 1;
    while ([".", "?."].includes(tokens[cursor]?.value)
      && tokens[cursor + 1]?.kind === "identifier" && tokens[cursor + 2]?.value === "(") {
      args = callArguments(tokens, cursor + 2);
      if (!args) break;
      endIndex = args.closeIndex;
      cursor = endIndex + 1;
    }
    const receiverIndex = index - 1;
    matches.push(normalizedTokens(tokens, source, receiverIndex, endIndex + 1));
  }
  return matches.length === 1 ? matches[0] : null;
}

function sourceSpanForSurface(source, reference) {
  if (typeof source !== "string" || !reference) return null;
  const tokens = tokenize(source);
  const getLine = lineLocator(source);
  const matches = [];
  for (let index = 1; index + 2 < tokens.length; index += 1) {
    if (![".", "?."].includes(tokens[index].value)
      || tokens[index + 1]?.value !== reference.method
      || tokens[index + 2]?.value !== "(") continue;
    if (tokens[index - 1]?.value !== reference.receiver || getLine(tokens[index + 1].start) !== reference.line) continue;
    let args = callArguments(tokens, index + 2);
    if (!args) continue;
    let endIndex = args.closeIndex;
    let cursor = endIndex + 1;
    while ([".", "?."].includes(tokens[cursor]?.value)
      && tokens[cursor + 1]?.kind === "identifier" && tokens[cursor + 2]?.value === "(") {
      args = callArguments(tokens, cursor + 2);
      if (!args) break;
      endIndex = args.closeIndex;
      cursor = endIndex + 1;
    }
    const startIndex = index - 1;
    matches.push({
      start: tokens[startIndex].start,
      end: tokens[endIndex].end,
      signature: normalizedTokens(tokens, source, startIndex, endIndex + 1),
    });
  }
  return matches.length === 1 ? matches[0] : null;
}

function splitCallArguments(tokens, openIndex) {
  const closeIndex = findMatchingToken(tokens, openIndex, "(", ")");
  if (closeIndex < 0) return null;
  const result = [];
  let start = openIndex + 1;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  for (let index = openIndex + 1; index < closeIndex; index += 1) {
    const value = tokens[index].value;
    if (value === "(") parenDepth += 1;
    else if (value === ")") parenDepth -= 1;
    else if (value === "[") bracketDepth += 1;
    else if (value === "]") bracketDepth -= 1;
    else if (value === "{") braceDepth += 1;
    else if (value === "}") braceDepth -= 1;
    else if (value === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      result.push([start, index]);
      start = index + 1;
    }
  }
  if (start < closeIndex) result.push([start, closeIndex]);
  return { ranges: result, closeIndex };
}

function normalizedRange(tokens, source, range) {
  return range && range[0] < range[1] ? normalizedTokens(tokens, source, range[0], range[1]) : "";
}

function sourceCallByName(source, name, line) {
  const tokens = tokenize(source);
  const getLine = lineLocator(source);
  const matches = [];
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    if (tokens[index].value !== name || tokens[index + 1]?.value !== "(") continue;
    if (getLine(tokens[index].start) !== line) continue;
    const closeIndex = findMatchingToken(tokens, index + 1, "(", ")");
    if (closeIndex < 0) continue;
    let startIndex = index;
    if ([".", "?."].includes(tokens[index - 1]?.value)) startIndex = index - 2;
    const args = callArguments(tokens, index + 1);
    matches.push({
      start: tokens[startIndex].start,
      end: tokens[closeIndex].end,
      signature: normalizedTokens(tokens, source, startIndex, closeIndex + 1),
      awaited: tokens[index - 1]?.value === "await",
      argCount: args?.argCount ?? 0,
      arguments: args ? Array.from({ length: args.argCount }, (_, argIndex) => {
        const ranges = splitCallArguments(tokens, index + 1)?.ranges ?? [];
        return normalizedRange(tokens, source, ranges[argIndex]);
      }) : [],
      tokens,
      nameIndex: index,
      openIndex: index + 1,
      closeIndex,
    });
  }
  return matches.length === 1 ? matches[0] : null;
}

function functionBodyRange(source, functionName) {
  const tokens = tokenize(source);
  const matches = [];
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    if (tokens[index].value !== "function" || tokens[index + 1]?.value !== functionName
      || tokens[index + 2]?.value !== "(") continue;
    const paramsEnd = findMatchingToken(tokens, index + 2, "(", ")");
    if (paramsEnd < 0) continue;
    let bodyStart = paramsEnd + 1;
    while (bodyStart < tokens.length && tokens[bodyStart].value !== "{") bodyStart += 1;
    const bodyEnd = findMatchingToken(tokens, bodyStart, "{", "}");
    if (bodyEnd < 0) continue;
    matches.push({ start: tokens[bodyStart].start, end: tokens[bodyEnd].end, tokens, bodyStart, bodyEnd });
  }
  return matches.length === 1 ? matches[0] : null;
}

function exactAsyncFunctionParameters(source, functionName, expectedParameters) {
  const tokens = tokenize(source);
  const matches = [];
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    if (tokens[index].value !== "function" || tokens[index + 1]?.value !== functionName
      || tokens[index + 2]?.value !== "(") continue;
    const args = splitCallArguments(tokens, index + 2);
    if (!args) continue;
    const parameters = args.ranges.map((range) => normalizedRange(tokens, source, range));
    const isAsync = tokens[index - 1]?.value === "async";
    matches.push({ parameters, isAsync });
  }
  return matches.length === 1 && matches[0].isAsync
    && matches[0].parameters.length === expectedParameters.length
    && matches[0].parameters.every((value, index) => value === expectedParameters[index]);
}

function trustedHelperKind(functionName) {
  if (functionName === "lockLegacyNativeChatQueueTarget") return "native_chat_queue_guard_helper";
  return TRUSTED_NATIVE_CHAT_HELPERS[functionName]?.record_kind ?? null;
}

function trustedHelperBodyMatches(source, sourcePath, functionName) {
  const policy = TRUSTED_NATIVE_CHAT_HELPERS[functionName];
  if (!policy || sourcePath !== policy.path || !exactAsyncFunctionParameters(source, functionName, policy.parameters)) return false;
  const body = functionBodyRange(source, functionName);
  return Boolean(body && sha256(source.slice(body.start, body.end)) === policy.body_sha256);
}

function helperSurfaceReferences(source, sourcePath, inventory, functionName) {
  const body = functionBodyRange(source, functionName);
  if (!body) return null;
  return inventory.structural_surfaces
    .filter((surface) => surface.source === sourcePath
      && ["database_call_candidate", "database_write_candidate"].includes(surface.type))
    .filter((surface) => {
      const span = sourceSpanForSurface(source, surface);
      return span && span.start >= body.start && span.end <= body.end;
    })
    .map((surface) => ({ type: surface.type, signature: surface.signature, line: surface.line }))
    .sort((left, right) => left.type.localeCompare(right.type)
      || left.signature.localeCompare(right.signature) || left.line - right.line);
}

function helperSurfacesMatchPolicy(source, sourcePath, inventory, functionName) {
  const body = functionBodyRange(source, functionName);
  const spec = TRUSTED_NATIVE_CHAT_HELPERS[functionName];
  if (!body || !spec) return false;
  const actual = inventory.structural_surfaces.filter((surface) => surface.source === sourcePath
    && ["database_call_candidate", "database_write_candidate"].includes(surface.type))
    .filter((surface) => {
      const span = sourceSpanForSurface(source, surface);
      return span && span.start >= body.start && span.end <= body.end;
    });
  const counts = new Map();
  for (const surface of actual) {
    const key = `${surface.type}\0${surface.method}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const expected = new Map(spec.surfaces.map(([type, method, count]) => [`${type}\0${method}`, count]));
  return actual.length === [...expected.values()].reduce((sum, count) => sum + count, 0)
    && counts.size === expected.size
    && [...expected].every(([key, count]) => counts.get(key) === count);
}

function sameSurfaceReferenceLists(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const sort = (items) => items.map(exactSurfaceRef).filter(Boolean)
    .sort((a, b) => a.type.localeCompare(b.type) || a.signature.localeCompare(b.signature) || a.line - b.line);
  const a = sort(left);
  const b = sort(right);
  return a.length === left.length && b.length === right.length
    && a.every((entry, index) => sameSurfaceRef(entry, b[index]));
}

function transactionCallbackRange(source, transactionSurface) {
  const tokens = tokenize(source);
  const span = sourceSpanForSurface(source, transactionSurface);
  if (!span) return null;
  const startIndex = tokens.findIndex((token) => token.start === span.start);
  const openIndex = startIndex + 3;
  const parsed = splitCallArguments(tokens, openIndex);
  if (!parsed || parsed.ranges.length < 1) return null;
  const [firstStart, firstEnd] = parsed.ranges[0];
  let arrowIndex = -1;
  for (let index = firstStart; index < firstEnd; index += 1) {
    if (tokens[index].value === "=>") { arrowIndex = index; break; }
  }
  if (arrowIndex < 0) return null;
  const blockStart = arrowIndex + 1;
  if (tokens[blockStart]?.value !== "{") return null;
  const blockEnd = findMatchingToken(tokens, blockStart, "{", "}");
  return blockEnd >= 0 ? { start: tokens[blockStart].start, end: tokens[blockEnd].end } : null;
}

function exactGuardCallsite(source, reference, helperName) {
  if (!reference || reference.type !== "guard_callsite" || !Number.isInteger(reference.line) || reference.line < 1
    || typeof reference.signature !== "string") return null;
  const call = sourceCallByName(source, helperName, reference.line);
  if (!call || call.signature !== reference.signature) return null;
  return call;
}

function importsExactRawQueueHelper(source, helperName) {
  const tokens = tokenize(source);
  let matches = 0;
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    if (tokens[index].value !== "import" || tokens[index + 1]?.value !== "{") continue;
    const close = findMatchingToken(tokens, index + 1, "{", "}");
    if (close < 0 || tokens[close + 1]?.value !== "from" || tokens[close + 2]?.kind !== "string") continue;
    if (tokens[close + 2].value !== "./organization-mutation-fence.js") continue;
    const specifiers = tokens.slice(index + 2, close);
    const names = specifiers.filter((token) => token.kind === "identifier" && token.value === helperName);
    if (!names.length) continue;
    if (tokens[index + 1]?.value === "type" || names.length !== 1) return false;
    const nameIndex = tokens.indexOf(names[0]);
    if (tokens[nameIndex + 1]?.value === "as" || tokens[nameIndex - 1]?.value === "as") return false;
    matches += 1;
  }
  return matches === 1;
}

function helperNameHasOnlyDirectUses(source, helperName) {
  const tokens = tokenize(source);
  // A pinned helper name may occur only at its exact declaration/import or
  // as an awaited direct call. Reject every other identifier use, including
  // parameters, destructuring, catch bindings and aliases; declaration-only
  // scans cannot prove which binding a protected writer actually calls.
  const importBindings = new Set();
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    if (tokens[index].value !== "import" || tokens[index + 1]?.value !== "{") continue;
    const close = findMatchingToken(tokens, index + 1, "{", "}");
    if (close < 0 || tokens[close + 1]?.value !== "from"
      || tokens[close + 2]?.value !== "./organization-mutation-fence.js") continue;
    for (let item = index + 2; item < close; item += 1) {
      if (tokens[item].value === helperName) importBindings.add(item);
    }
  }
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].kind !== "identifier" || tokens[index].value !== helperName) continue;
    if (importBindings.has(index) || tokens[index - 1]?.value === "function") continue;
    if (tokens[index - 1]?.value === "await" && tokens[index + 1]?.value === "(") continue;
    return false;
  }
  return true;
}

function hasOnlyTrustedHelperBinding(source, sourcePath, helperName, helperSource = source) {
  const spec = TRUSTED_NATIVE_CHAT_HELPERS[helperName];
  if (!spec || !trustedHelperBodyMatches(helperSource, spec.path, helperName)) return false;
  if (!helperNameHasOnlyDirectUses(source, helperName)) return false;
  const tokens = tokenize(source);
  const declarations = [];
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    if (["const", "let", "var", "class"].includes(tokens[index].value)
      && tokens[index + 1]?.value === helperName) declarations.push("local");
    if (tokens[index].value === "function" && tokens[index + 1]?.value === helperName) declarations.push("function");
  }
  if (helperName === "lockLegacyNativeChatQueueTarget") {
    return declarations.length === 0 && importsExactRawQueueHelper(source, helperName);
  }
  return sourcePath === spec.path && declarations.length === 1 && declarations[0] === "function";
}

function terminalGuardBranch(tokens, ifIndex, variable, kind) {
  if (tokens[ifIndex]?.value !== "if" || tokens[ifIndex + 1]?.value !== "(") return false;
  const conditionEnd = findMatchingToken(tokens, ifIndex + 1, "(", ")");
  if (conditionEnd < 0) return false;
  const condition = tokens.slice(ifIndex + 2, conditionEnd);
  const expected = kind === "unavailable"
    ? condition.length === 3 && condition[0].value === variable && condition[1].value === "!=="
      && condition[2].kind === "string" && condition[2].value === "available"
    : condition.length === 3 && condition[0].value === variable && condition[1].value === "==="
      && condition[2].kind === "string" && condition[2].value === kind;
  if (!expected) return false;
  const statement = conditionEnd + 1;
  if (["throw", "return"].includes(tokens[statement]?.value)) return true;
  if (tokens[statement]?.value !== "{") return false;
  const blockEnd = findMatchingToken(tokens, statement, "{", "}");
  if (blockEnd < 0 || !["throw", "return"].includes(tokens[statement + 1]?.value)) return false;
  return tokens[blockEnd + 1]?.value !== "else";
}

function braceDepthBefore(tokens, endIndex) {
  let depth = 0;
  for (let index = 0; index < endIndex; index += 1) {
    if (tokens[index].value === "{") depth += 1;
    else if (tokens[index].value === "}") depth -= 1;
  }
  return depth;
}

function rawGuardResultIsRejected(source, call, writerSpan, transactionRange) {
  const tokens = call?.tokens;
  if (!tokens || !writerSpan || !transactionRange || !call.awaited) return false;
  const variable = tokens[call.nameIndex - 3];
  if (tokens[call.nameIndex - 4]?.value !== "const" || variable?.kind !== "identifier"
    || tokens[call.nameIndex - 2]?.value !== "=" || tokens[call.nameIndex - 1]?.value !== "await") return false;
  const scopeTokens = tokens.filter((token) => token.start >= transactionRange.start && token.end <= transactionRange.end);
  let declarations = 0;
  for (let index = 0; index + 1 < scopeTokens.length; index += 1) {
    if (["const", "let", "var"].includes(scopeTokens[index].value) && scopeTokens[index + 1]?.value === variable.value) declarations += 1;
  }
  if (declarations !== 1) return false;
  const writerIndex = tokens.findIndex((token) => token.start === writerSpan.start);
  if (writerIndex < 0) return false;
  const callDepth = braceDepthBefore(tokens, call.nameIndex);
  if (braceDepthBefore(tokens, writerIndex) !== callDepth) return false;
  let currentDepth = braceDepthBefore(tokens, call.closeIndex + 1);
  const checks = new Set();
  for (let index = call.closeIndex + 1; index < tokens.length && tokens[index].start < writerSpan.start; index += 1) {
    if (currentDepth === callDepth) {
      for (const kind of ["missing", "native_owned", "unavailable"]) {
        if (terminalGuardBranch(tokens, index, variable.value, kind)) checks.add(kind);
      }
    }
    if (tokens[index].value === "{") currentDepth += 1;
    else if (tokens[index].value === "}") currentDepth -= 1;
  }
  return checks.has("unavailable") || (checks.has("missing") && checks.has("native_owned"));
}

function exactTargetKeyBinding(source, keyName) {
  const tokens = tokenize(source);
  const declarations = [];
  for (let index = 0; index + 3 < tokens.length; index += 1) {
    if (!["const", "let", "var"].includes(tokens[index].value)
      || tokens[index + 1]?.value !== keyName || tokens[index + 2]?.value !== "=") continue;
    declarations.push({ kind: tokens[index].value, valueToken: tokens[index + 3], index });
  }
  if (declarations.length !== 1 || declarations[0].kind !== "const") return false;
  const binding = declarations[0];
  const expected = /^`runtime-binding:target:chat_conversation:\$\{(?:organizationId|orgId|hint\.org_id)\}:\$\{(?:conversationId|hint\.id)\}`$/;
  if (binding.valueToken?.kind !== "template" || !binding.valueToken.interpolated || !expected.test(binding.valueToken.raw)) return false;
  const occurrences = tokens.filter((token) => token.kind === "identifier" && token.value === keyName);
  if (occurrences.length !== 1 || occurrences[0].start !== tokens[binding.index + 1].start) return false;
  const interpolation = new RegExp(`\\$\\{\\s*${keyName.replace(/[$]/g, "\\$")}\\s*\\}`, "g");
  if ([...source.matchAll(interpolation)].length !== 1) return false;
  if (tokens.some((token, index) => token.kind === "identifier" && token.value === keyName
    && tokens[index + 1]?.value === "=" && index !== binding.index + 1)) return false;
  return true;
}

function validateTrustedHelperRecord(record, before, after, headInventory, pathValue) {
  const problems = [];
  const spec = TRUSTED_NATIVE_CHAT_HELPERS[record.helper_name];
  if (!spec || trustedHelperKind(record.helper_name) !== record.change_kind) {
    return ["helper name and change_kind must match one fixed Native Chat helper policy"];
  }
  if (pathValue !== spec.path) problems.push("Native Chat helper is restricted to its fixed existing source module");
  if (functionBodyRange(before, record.helper_name)) problems.push("Native Chat helper must be a newly added function");
  if (!trustedHelperBodyMatches(after, pathValue, record.helper_name)) {
    problems.push("helper body does not match the statically trusted exact-source digest and parameter contract");
  }
  const dependencyName = spec.helper_reference === "queue_helper_id"
    ? "lockLegacyNativeChatQueueTarget"
    : spec.helper_reference === "conversation_helper_id" ? "assertLegacyChatConversationAuthority" : null;
  if (!helperNameHasOnlyDirectUses(after, record.helper_name)
    || (dependencyName && !helperNameHasOnlyDirectUses(after, dependencyName))) {
    problems.push("trusted helper or dependency has a shadowing binding or indirect identifier use");
  }
  if (record.helper_name === "assertLegacyChatConversationAuthority"
    && !importsExactRawQueueHelper(after, "lockLegacyNativeChatQueueTarget")) {
    problems.push("conversation wrapper must import the trusted raw queue helper directly from its fixed module");
  }
  if (!helperSurfacesMatchPolicy(after, pathValue, headInventory, record.helper_name)) {
    problems.push("helper database call/write surface counts do not match the statically trusted helper contract");
  }
  if (record.head_surface || !Array.isArray(record.head_surfaces)) {
    problems.push("helper records must pin head_surfaces only");
  } else {
    const actual = helperSurfaceReferences(after, pathValue, headInventory, record.helper_name);
    if (!actual || !sameSurfaceReferenceLists(record.head_surfaces, actual)) {
      problems.push("helper head_surfaces must exactly match every database call/write surface inside the trusted helper");
    }
  }
  for (const field of ["transaction_mapping_id", "base_surface", "base_protected_surface", "head_protected_surface", "head_guard_callsite"]) {
    if (record[field] !== undefined) problems.push(`helper records cannot set ${field}`);
  }
  if (spec.helper_reference) {
    if (typeof record[spec.helper_reference] !== "string" || !record[spec.helper_reference].trim()) {
      problems.push(`helper record must reference its exact ${spec.helper_reference}`);
    }
    const otherReference = spec.helper_reference === "queue_helper_id" ? "conversation_helper_id" : "queue_helper_id";
    if (record[otherReference] !== undefined) problems.push(`helper record cannot set ${otherReference}`);
  } else if (record.queue_helper_id !== undefined || record.conversation_helper_id !== undefined) {
    problems.push("raw queue-fence helper record cannot reference another helper");
  }
  return problems;
}

function exactTargetAdvisoryLock(source, surface, callsite) {
  if (!surface || surface.method !== "execute" || !TARGET_LOCK_RECEIVERS.has(surface.receiver) || !callsite) return false;
  const call = callsite.match(/^(tx|transaction|dbOrTx)\.execute\(sql`([\s\S]*)`\)$/i);
  if (!call) return false;
  const sqlText = call[2];
  const lock = sqlText.match(/^\s*select\s+pg_advisory_xact_lock\s*\(\s*hashtextextended\s*\(\s*\$\{\s*([A-Za-z_$][\w$]*)\s*\}\s*,\s*0\s*\)\s*\)\s*$/i);
  if (!lock) return false;
  return exactTargetKeyBinding(source, lock[1]);
}

function validateQueueGuardCallsite(record, before, after, baseInventory, headInventory, baseSurface, headSurface, baseProtectedSurface, headProtectedSurface, headContents, trustedCallers) {
  if (typeof after !== "string" || trustedCallers[record.path] !== sha256(after)) {
    return ["guard-to-writer target contract does not match an exact statically trusted caller source"];
  }
  const problems = [];
  if (!before || !after) return ["queue guard callsite requires the same existing source file in base and head"];
  if (record.transaction_mapping_id === undefined || typeof record.transaction_mapping_id !== "string") {
    problems.push("queue guard callsite must reference its exact transaction_mapping_id");
  }
  if (typeof record.guard_helper_id !== "string" || !record.guard_helper_id.trim()) {
    problems.push("queue guard callsite must reference its exact guard_helper_id");
  }
  if (baseSurface || headSurface || record.head_surfaces) problems.push("queue guard callsite uses head_guard_callsite, not database-call surfaces");
  if (!baseProtectedSurface || !headProtectedSurface || baseProtectedSurface.type !== "database_write_candidate"
    || headProtectedSurface.type !== "database_write_candidate") {
    problems.push("queue guard callsite must pin the same existing protected writer in base and head");
    return problems;
  }
  if (baseProtectedSurface.signature !== headProtectedSurface.signature
    || !hasSurface(baseInventory, record.path, baseProtectedSurface)
    || !hasSurface(headInventory, record.path, headProtectedSurface)) {
    problems.push("queue guard callsite protected writer must be unchanged and exact in base and head");
    return problems;
  }
  const callsiteRef = record.head_guard_callsite;
  if (!callsiteRef || callsiteRef.type !== "guard_callsite" || !Number.isInteger(callsiteRef.line)
    || typeof callsiteRef.signature !== "string" || Object.keys(callsiteRef).length !== 3) {
    problems.push("head_guard_callsite must pin exact type, signature, and line");
    return problems;
  }
  const allowedHelpers = Object.keys(TRUSTED_NATIVE_CHAT_HELPERS);
  const matchingCalls = allowedHelpers.map((name) => ({ name, call: exactGuardCallsite(after, callsiteRef, name) }))
    .filter((entry) => entry.call);
  if (matchingCalls.length !== 1) {
    problems.push("guard callsite must be one direct call to an approved Native Chat queue guard helper");
    return problems;
  }
  const guardCall = matchingCalls[0].call;
  if (!guardCall.awaited) problems.push("queue guard call must be awaited before the protected writer");
  const helperSpec = TRUSTED_NATIVE_CHAT_HELPERS[matchingCalls[0].name];
  const helperSource = helperSpec?.path === record.path ? after : headContents.get(helperSpec?.path)?.content;
  if (!hasOnlyTrustedHelperBinding(after, record.path, matchingCalls[0].name, helperSource)) {
    problems.push("guard call must resolve to the statically trusted helper in its fixed source module");
  }
  const transaction = findMappedTransactionSurface(record, baseInventory, headInventory);
  const transactionRange = transaction && transactionCallbackRange(after, transaction);
  const writer = headInventory.structural_surfaces.find((entry) => entry.source === record.path
    && sameSurfaceRef(entry, headProtectedSurface));
  const writerSpan = writer && sourceSpanForSurface(after, writer);
  if (!transactionRange || !writerSpan || guardCall.start < transactionRange.start || guardCall.end > transactionRange.end
    || writerSpan.start < transactionRange.start || writerSpan.end > transactionRange.end) {
    problems.push("guard call and protected writer must share one mapped transaction callback");
  }
  else if (guardCall.start >= writerSpan.start) problems.push("guard call must precede the protected writer inside the exact transaction callback");
  if (matchingCalls[0].name === "lockLegacyNativeChatQueueTarget"
    && !rawGuardResultIsRejected(after, guardCall, writerSpan, transactionRange)) {
    problems.push("direct queue helper result must be captured once and tokenized missing/native-owned or unavailable branches must terminate before the writer");
  }
  return problems;
}

function validateLegacyFenceRecord(record, baseInventory, headInventory, baseContents, headContents, trustedCallers) {
  const problems = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) return ["record must be an object"];
  for (const key of Object.keys(record)) if (!LEGACY_FENCE_RECORD_FIELDS.has(key)) problems.push(`unsupported record field ${key}`);
  for (const field of ["id", "path", "base_sha256", "head_sha256", "semantic_operation", "rust_authority", "compatibility_boundary", "retirement_criterion"]) {
    if (typeof record[field] !== "string" || !record[field].trim()) problems.push(`${field} is required`);
  }
  if (!/^[a-z][a-z0-9_.:-]{2,95}$/.test(record.id ?? "")) problems.push("id must be a stable lowercase identifier");
  if (!/^[a-z][a-z0-9_.:-]{2,95}$/.test(record.semantic_operation ?? "")) problems.push("semantic_operation must identify one existing operation");
  if (!LEGACY_FENCE_CHANGE_KINDS.has(record.change_kind)) problems.push("change_kind is not a supported legacy fence change");
  if (typeof record.path !== "string" || !record.path.startsWith("server/src/services/") || isTestOrGeneratedPath(record.path)) {
    problems.push("legacy Native Chat fences are limited to existing server/src/services production sources");
  }

  const before = baseContents.get(record.path);
  const after = headContents.get(record.path);
  if (!before || !after) problems.push("legacy fence records may only bind an existing source file present in base and head");
  if (before && record.base_sha256 !== before.sha256) problems.push("base_sha256 does not match exact base source");
  if (after && record.head_sha256 !== after.sha256) problems.push("head_sha256 does not match exact candidate source");
  if (before && after && before.sha256 === after.sha256) problems.push("record is stale because the source file did not change");

  const baseSurface = exactSurfaceRef(record.base_surface);
  const headSurface = exactSurfaceRef(record.head_surface);
  const baseProtectedSurface = exactSurfaceRef(record.base_protected_surface);
  const headProtectedSurface = exactSurfaceRef(record.head_protected_surface);
  if (record.base_surface && !baseSurface) problems.push("base_surface must pin type, exact signature, and line");
  if (record.head_surface && !headSurface) problems.push("head_surface must pin type, exact signature, and line");
  if (record.base_protected_surface && !baseProtectedSurface) problems.push("base_protected_surface must pin type, exact signature, and line");
  if (record.head_protected_surface && !headProtectedSurface) problems.push("head_protected_surface must pin type, exact signature, and line");

  const requireBeforeHead = (beforeRef, afterRef) => {
    if (!beforeRef || !afterRef) return;
    if (!hasSurface(baseInventory, record.path, beforeRef)) problems.push("base_surface does not identify an exact base callsite");
    if (!hasSurface(headInventory, record.path, afterRef)) problems.push("head_surface does not identify an exact candidate callsite");
  };
  if (record.change_kind === "existing_operation_mapping") {
    if (record.transaction_mapping_id) problems.push("existing_operation_mapping cannot reference another transaction mapping");
    requireBeforeHead(baseSurface, headSurface);
    if (record.head_surfaces) problems.push("existing_operation_mapping accepts one old-to-new transaction pair");
    if (baseSurface?.type !== "database_call_candidate" || headSurface?.type !== "database_call_candidate") {
      problems.push("existing_operation_mapping must map database call candidates");
    } else {
      const oldSurface = baseInventory.structural_surfaces.find((surface) => surface.source === record.path && sameSurfaceRef(surface, baseSurface));
      const newSurface = headInventory.structural_surfaces.find((surface) => surface.source === record.path && sameSurfaceRef(surface, headSurface));
      if (oldSurface?.method !== "transaction" || newSurface?.method !== "transaction"
        || oldSurface.receiver !== newSurface.receiver) {
        problems.push("existing_operation_mapping must preserve the same transaction receiver and operation");
      }
      if (sameSurfaceRef(baseSurface, headSurface)) problems.push("existing_operation_mapping must pin a changed callback surface");
      if (!baseProtectedSurface || !headProtectedSurface
        || baseProtectedSurface.type !== "database_write_candidate" || headProtectedSurface.type !== "database_write_candidate") {
        problems.push("existing_operation_mapping must pin the existing writer that identifies the semantic operation");
      } else {
        if (baseProtectedSurface.signature !== headProtectedSurface.signature) problems.push("mapped semantic-operation writer must remain unchanged");
        const oldWriter = baseInventory.structural_surfaces.find((surface) => surface.source === record.path && sameSurfaceRef(surface, baseProtectedSurface));
        const newWriter = headInventory.structural_surfaces.find((surface) => surface.source === record.path && sameSurfaceRef(surface, headProtectedSurface));
        if (!oldWriter || !newWriter) problems.push("semantic-operation writer must exist at the exact base and head callsites");
        const oldTransactionCallsite = before && oldSurface && sourceCallsiteForSurface(before.content, oldSurface);
        const newTransactionCallsite = after && newSurface && sourceCallsiteForSurface(after.content, newSurface);
        const oldWriterCallsite = before && oldWriter && sourceCallsiteForSurface(before.content, oldWriter);
        const newWriterCallsite = after && newWriter && sourceCallsiteForSurface(after.content, newWriter);
        if (!oldTransactionCallsite || !oldWriterCallsite || !oldTransactionCallsite.includes(oldWriterCallsite)) {
          problems.push("base transaction callback must contain its exact pinned semantic-operation writer");
        }
        if (!newTransactionCallsite || !newWriterCallsite || !newTransactionCallsite.includes(newWriterCallsite)) {
          problems.push("candidate transaction callback must contain its exact pinned semantic-operation writer");
        }
        const oldRange = transactionCallbackRange(before.content, oldSurface);
        const newRange = transactionCallbackRange(after.content, newSurface);
        const oldWriterSpan = sourceSpanForSurface(before.content, oldWriter);
        const newWriterSpan = sourceSpanForSurface(after.content, newWriter);
        if (!oldRange || !oldWriterSpan || oldWriterSpan.start < oldRange.start || oldWriterSpan.end > oldRange.end) {
          problems.push("base semantic-operation writer must be in the exact mapped callback body");
        }
        if (!newRange || !newWriterSpan || newWriterSpan.start < newRange.start || newWriterSpan.end > newRange.end) {
          problems.push("candidate semantic-operation writer must be in the exact mapped callback body");
        }
      }
    }
  } else if (record.change_kind === "target_advisory_lock") {
    if (typeof record.transaction_mapping_id !== "string" || !record.transaction_mapping_id.trim()) problems.push("target_advisory_lock must reference its exact transaction_mapping_id");
    if (record.base_surface || record.head_surface || !Array.isArray(record.head_surfaces) || record.head_surfaces.length !== 2) {
      problems.push("target_advisory_lock must pin exactly its database-call and write-candidate surfaces");
    }
    const refs = Array.isArray(record.head_surfaces) ? record.head_surfaces.map(exactSurfaceRef) : [];
    if (refs.some((ref) => !ref)) problems.push("head_surfaces must pin exact type, signature, and line");
    const callRef = refs.find((ref) => ref?.type === "database_call_candidate");
    const writeRef = refs.find((ref) => ref?.type === "database_write_candidate");
    if (!callRef || !writeRef) problems.push("target_advisory_lock requires one database call and its scanner write candidate");
    if (callRef && !hasSurface(headInventory, record.path, callRef)) problems.push("advisory lock database call does not match the candidate inventory");
    if (writeRef && !hasSurface(headInventory, record.path, writeRef)) problems.push("advisory lock write candidate does not match the candidate inventory");
    if (callRef && writeRef) {
      const call = headInventory.structural_surfaces.find((surface) => surface.source === record.path && sameSurfaceRef(surface, callRef));
      const write = headInventory.structural_surfaces.find((surface) => surface.source === record.path && sameSurfaceRef(surface, writeRef));
      const callsite = call && after && sourceCallsiteForSurface(after.content, call);
      if (call?.method !== "execute" || write?.method !== "execute" || call.receiver !== write.receiver
        || call.line !== write.line || call.signature.replace("|db-call|", "|db-write-candidate|") !== write.signature) {
        problems.push("advisory lock references must be the same exact execute call");
      }
      if (!after || !exactTargetAdvisoryLock(after.content, call, callsite)) {
        problems.push("target advisory lock must use the exact transaction-scoped Native target-key SQL contract");
      }
    }
    if (!baseProtectedSurface || !headProtectedSurface || baseProtectedSurface.type !== "database_write_candidate" || headProtectedSurface.type !== "database_write_candidate") {
      problems.push("target_advisory_lock must identify the exact existing write it fences with base_protected_surface and head_protected_surface");
    }
    if (baseProtectedSurface && headProtectedSurface) {
      if (baseProtectedSurface.signature !== headProtectedSurface.signature) problems.push("protected write signature must remain the same across base and head");
      if (!hasSurface(baseInventory, record.path, baseProtectedSurface) || !hasSurface(headInventory, record.path, headProtectedSurface)) {
        problems.push("protected write must be the same pre-existing operation in base and head");
      }
    }
    const transactionRef = typeof record.transaction_mapping_id === "string"
      ? findMappedTransactionSurface(record, baseInventory, headInventory)
      : null;
    const lockSurface = callRef && headInventory.structural_surfaces.find((surface) => surface.source === record.path && sameSurfaceRef(surface, callRef));
    const protectedWrite = headProtectedSurface && headInventory.structural_surfaces.find((surface) => surface.source === record.path && sameSurfaceRef(surface, headProtectedSurface));
    const lockSpan = callRef && lockSurface && after ? sourceSpanForSurface(after.content, lockSurface) : null;
    const writeSpan = protectedWrite && after ? sourceSpanForSurface(after.content, protectedWrite) : null;
    const callback = transactionRef && after ? transactionCallbackRange(after.content, transactionRef) : null;
    if (!callback || !lockSpan || !writeSpan || lockSpan.start < callback.start || lockSpan.end > callback.end
      || writeSpan.start < callback.start || writeSpan.end > callback.end) {
      problems.push("target advisory lock and protected write must be inside the exact mapped transaction callback");
    } else if (lockSpan.start >= writeSpan.start) {
      problems.push("target advisory lock must run before its exact protected write inside the callback");
    }
    if (lockSurface?.receiver !== "tx" || protectedWrite?.receiver !== lockSurface?.receiver) {
      problems.push("target advisory lock and protected write must use the same transaction client");
    }
  } else if (["native_chat_run_attempt_admission", "native_chat_side_chat_retention"].includes(record.change_kind)) {
    if (record.base_surface || record.head_surface || record.transaction_mapping_id || record.base_protected_surface || record.head_protected_surface) {
      problems.push(`${record.change_kind} accepts only head_surfaces for the new atomic admission unit`);
    }
    if (!Array.isArray(record.head_surfaces) || record.head_surfaces.length < 3) {
      problems.push(`${record.change_kind} must pin its transaction and every new writer`);
    }
    const refs = Array.isArray(record.head_surfaces) ? record.head_surfaces.map(exactSurfaceRef) : [];
    if (refs.some((ref) => !ref)) problems.push("head_surfaces must pin exact type, signature, and line");
    const surfaces = refs.map((ref) => ref && headInventory.structural_surfaces.find((surface) => surface.source === record.path && sameSurfaceRef(surface, ref))).filter(Boolean);
    if (surfaces.length !== refs.length) problems.push("head_surfaces must match candidate inventory surfaces");
    if (record.change_kind === "native_chat_side_chat_retention") return problems;
    const transaction = surfaces.find((surface) => surface.type === "database_call_candidate" && surface.method === "transaction");
    if (!transaction) problems.push(`${record.change_kind} requires one transaction callback surface`);
    if (transaction) {
      const range = after && transactionCallbackRange(after.content, transaction);
      if (!range) problems.push(`${record.change_kind} transaction callback could not be resolved`);
      for (const surface of surfaces) {
        if (surface === transaction) continue;
        const span = after && sourceSpanForSurface(after.content, surface);
        if (!span || !range || span.start < range.start || span.end > range.end) {
          problems.push("every new writer must remain inside the mapped transaction callback");
        }
        if (surface.receiver !== "tx") problems.push("new retention writers must use the transaction client");
      }
    }
  } else if ([
    "native_chat_queue_guard_helper",
    "native_chat_conversation_authority_helper",
    "native_chat_generation_hint_helper",
    "native_chat_queued_message_hint_helper",
    "native_chat_conversation_id_hint_helper",
  ].includes(record.change_kind)) {
    if (before && after) problems.push(...validateTrustedHelperRecord(record, before.content, after.content, headInventory, record.path));
  } else if (record.change_kind === "native_chat_queue_guard_callsite") {
    problems.push(...validateQueueGuardCallsite(
      record, before?.content, after?.content, baseInventory, headInventory,
      baseSurface, headSurface, baseProtectedSurface, headProtectedSurface, headContents, trustedCallers,
    ));
  }
  return problems;
}

function surfaceChangeCounts(before, after, types) {
  const oldCounts = countSignatures(before, types);
  const newCounts = countSignatures(after, types);
  const added = new Map();
  const removed = new Map();
  for (const [signature, count] of newCounts) {
    const delta = count - (oldCounts.get(signature) ?? 0);
    if (delta > 0) added.set(signature, delta);
  }
  for (const [signature, count] of oldCounts) {
    const delta = count - (newCounts.get(signature) ?? 0);
    if (delta > 0) removed.set(signature, delta);
  }
  return { added, removed };
}

function compareLegacyFenceChanges(baseInventory, headInventory, baseContents, headContents, addedSurfaceCounts, removedSurfaceCounts, trustedCallers) {
  const failures = [];
  const records = Array.isArray(headInventory.reviewed_legacy_fence_changes)
    ? headInventory.reviewed_legacy_fence_changes : [];
  if (Object.hasOwn(headInventory, "reviewed_legacy_fence_changes") && !Array.isArray(headInventory.reviewed_legacy_fence_changes)) {
    failures.push("reviewed_legacy_fence_changes must be an array");
  }
  const ids = records.map((record) => record?.id).filter((id) => typeof id === "string");
  for (const id of new Set(ids.filter((id, index) => ids.indexOf(id) !== index))) {
    failures.push(`duplicate reviewed_legacy_fence_changes id: ${id}`);
  }
  const remainingAdded = new Map(addedSurfaceCounts);
  const remainingRemovedTransactions = new Map([...removedSurfaceCounts].filter(([signature]) => /\|db-call\|[^|]+\|transaction\|/.test(signature)));
  const consumedIds = new Set();
  const consume = (counts, reference, label) => {
    if (!reference) return;
    const remaining = counts.get(reference.signature) ?? 0;
    if (remaining < 1) failures.push(`${label} does not map an exact unmatched structural surface: ${reference.signature}`);
    else if (remaining === 1) counts.delete(reference.signature);
    else counts.set(reference.signature, remaining - 1);
  };

  const validRecords = [];
  for (const record of records) {
    const problems = validateLegacyFenceRecord(record, baseInventory, headInventory, baseContents, headContents, trustedCallers);
    if (problems.length) {
      failures.push(`${record?.id ?? "<missing id>"}: ${problems.join("; ")}`);
      continue;
    }
    validRecords.push(record);
    consumedIds.add(record.id);
    if (record.change_kind === "target_advisory_lock") {
      for (const reference of record.head_surfaces.map(exactSurfaceRef)) consume(remainingAdded, reference, record.id);
    } else if (record.change_kind === "native_chat_queue_guard_helper") {
      for (const reference of record.head_surfaces.map(exactSurfaceRef)) consume(remainingAdded, reference, record.id);
    } else if ([
      "native_chat_generation_hint_helper",
      "native_chat_queued_message_hint_helper",
      "native_chat_conversation_id_hint_helper",
    ].includes(record.change_kind)) {
      for (const reference of record.head_surfaces.map(exactSurfaceRef)) consume(remainingAdded, reference, record.id);
    } else if (["native_chat_run_attempt_admission", "native_chat_side_chat_retention"].includes(record.change_kind)) {
      for (const reference of record.head_surfaces.map(exactSurfaceRef)) consume(remainingAdded, reference, record.id);
    } else {
      if (record.change_kind === "existing_operation_mapping") {
        consume(remainingRemovedTransactions, exactSurfaceRef(record.base_surface), record.id);
        consume(remainingAdded, exactSurfaceRef(record.head_surface), record.id);
      }
    }
  }

  for (const record of validRecords.filter((entry) => ["target_advisory_lock", "native_chat_queue_guard_callsite"].includes(entry.change_kind))) {
    const mappedTransaction = validRecords.find((entry) => entry.path === record.path
      && entry.change_kind === "existing_operation_mapping"
      && entry.id === record.transaction_mapping_id
      && entry.semantic_operation === record.semantic_operation);
    if (!mappedTransaction) failures.push(`${record.id}: fence must reference an exact transaction callback mapping for the same semantic_operation`);
    else if (!sameSurfaceRef(exactSurfaceRef(mappedTransaction.base_protected_surface), exactSurfaceRef(record.base_protected_surface))
      || !sameSurfaceRef(exactSurfaceRef(mappedTransaction.head_protected_surface), exactSurfaceRef(record.head_protected_surface))) {
      failures.push(`${record.id}: transaction mapping must pin the same exact protected writer`);
    }
    if (record.change_kind === "native_chat_queue_guard_callsite") {
      const signature = record.head_guard_callsite?.signature ?? "";
      const helperKinds = {
        lockLegacyNativeChatQueueTarget: "native_chat_queue_guard_helper",
        assertLegacyChatConversationAuthority: "native_chat_conversation_authority_helper",
        assertLegacyChatGenerationAuthority: "native_chat_generation_hint_helper",
        assertLegacyQueuedMessageAuthority: "native_chat_queued_message_hint_helper",
        assertLegacyChatConversationIdAuthority: "native_chat_conversation_id_hint_helper",
      };
      const calledHelper = Object.keys(helperKinds).find((name) => signature.startsWith(`${name}(`));
      const requiredKind = helperKinds[calledHelper];
      const helper = validRecords.find((entry) => entry.id === record.guard_helper_id
        && entry.change_kind === requiredKind
        && entry.semantic_operation === record.semantic_operation);
      if (!helper) failures.push(`${record.id}: guard callsite must reference a reviewed helper record for the same semantic_operation`);
    }
  }

  for (const record of validRecords) {
    if (record.change_kind === "native_chat_conversation_authority_helper") {
      const rawHelper = validRecords.find((entry) => entry.id === record.queue_helper_id
        && entry.change_kind === "native_chat_queue_guard_helper"
        && entry.semantic_operation === record.semantic_operation);
      if (!rawHelper) failures.push(`${record.id}: conversation authority helper must reference the exact raw queue fence record`);
    } else if ([
      "native_chat_generation_hint_helper",
      "native_chat_queued_message_hint_helper",
      "native_chat_conversation_id_hint_helper",
    ].includes(record.change_kind)) {
      const conversationHelper = validRecords.find((entry) => entry.id === record.conversation_helper_id
        && entry.change_kind === "native_chat_conversation_authority_helper"
        && entry.semantic_operation === record.semantic_operation);
      if (!conversationHelper) failures.push(`${record.id}: generation hint helper must reference the exact conversation authority helper record`);
    }
  }

  for (const [signature, count] of remainingAdded) {
    failures.push(`new Node authority surface is forbidden by the ratchet: ${signature} (${count} unmatched)`);
  }
  return { failures, consumed_ids: [...consumedIds].sort() };
}

function isTransportAdapterPath(sourcePath) {
  return sourcePath.endsWith(".ts") && !isTestOrGeneratedPath(sourcePath)
    && (sourcePath.startsWith("server/src/") || sourcePath.startsWith("identity/src/")
      || Object.hasOwn(TRUSTED_NODE_TRANSPORT_SOURCES, sourcePath));
}

function validateTrustedNodeTransportSourceRecord(record, sourcePath, sourceHash) {
  const policy = TRUSTED_NODE_TRANSPORT_SOURCES[sourcePath];
  if (!policy) return [`${sourcePath}: no statically trusted package transport source admission`];
  const problems = [];
  if (sourceHash !== policy.source_sha256) problems.push("source hash does not match the statically trusted transport-source digest");
  if (record?.transport_admission_id !== policy.id) problems.push("transport_admission_id does not match the statically trusted source admission");
  if (record?.rust_authority !== policy.rust_authority) problems.push("rust_authority does not match the statically trusted source admission");
  if (JSON.stringify(record?.allowed_node_duties) !== JSON.stringify(policy.allowed_node_duties)) {
    problems.push("allowed_node_duties do not match the statically trusted source admission");
  }
  if (JSON.stringify(record?.prohibited_node_duties) !== JSON.stringify(policy.prohibited_node_duties)) {
    problems.push("prohibited_node_duties do not match the statically trusted source admission");
  }
  if (record?.compatibility_boundary !== policy.compatibility_boundary) problems.push("compatibility_boundary does not match the statically trusted source admission");
  if (record?.retirement_criterion !== policy.retirement_criterion) problems.push("retirement_criterion does not match the statically trusted source admission");
  if (record && Object.hasOwn(record, "allowed_transport_surfaces")) {
    problems.push("package transport source records cannot admit structural surfaces");
  }
  return problems;
}

// A transport adapter may add a route surface while handing business
// authority to Rust. Keep this allowance explicit and hash-bound to the
// reviewed source record: every permitted signature must exist in the current
// candidate and must be one of the exact surfaces added by this diff.
function consumeReviewedTransportSurfaces(record, sourcePath, headSurfaces, headContents, remainingAdded, failures) {
  if (!record || !Object.hasOwn(record, "allowed_transport_surfaces")) return;
  const allowed = record.allowed_transport_surfaces;
  if (!Array.isArray(allowed) || allowed.some((signature) => typeof signature !== "string" || !signature.trim())) {
    failures.push(`${sourcePath}: allowed_transport_surfaces must be an array of nonempty signatures`);
    return;
  }
  const sourcePolicy = TRUSTED_TRANSPORT_SURFACES[sourcePath];
  if (!sourcePolicy) failures.push(`${sourcePath}: no statically trusted transport surface policy`);
  else {
    const candidateSource = headContents.get(sourcePath);
    if (!candidateSource) {
      failures.push(`${sourcePath}: candidate source is absent for the statically trusted transport surface`);
      return;
    }
    if (candidateSource.sha256 !== sourcePolicy.source_sha256) {
      failures.push(`${sourcePath}: source hash does not match the statically trusted transport-helper digest`);
      return;
    }
    if (record.transport_surface_owner !== sourcePolicy.owner) {
      failures.push(`${sourcePath}: transport_surface_owner does not match the exact statically trusted adapter helper`);
    }
  }
  const trustedForPath = new Set(sourcePolicy?.signatures ?? []);
  const headSignatures = new Set(headSurfaces.filter((surface) => surface.source === sourcePath).map((surface) => surface.signature));
  const seen = new Set();
  for (const signature of allowed) {
    if (seen.has(signature)) {
      failures.push(`${sourcePath}: duplicate allowed transport surface: ${signature}`);
      continue;
    }
    seen.add(signature);
    if (!trustedForPath.has(signature)) {
      failures.push(`${sourcePath}: transport surface is not statically trusted for this exact source path: ${signature}`);
      continue;
    }
    if (!headSignatures.has(signature)) {
      failures.push(`${sourcePath}: allowed transport surface is absent from candidate: ${signature}`);
      continue;
    }
    const count = remainingAdded.get(signature) ?? 0;
    if (count < 1) {
      failures.push(`${sourcePath}: allowed transport surface is not an exact added surface: ${signature}`);
      continue;
    }
    if (count === 1) remainingAdded.delete(signature);
    else remainingAdded.set(signature, count - 1);
  }
}

function journalAppendProblems(journalPath, beforeText, afterText, availableHeadMigrationPaths) {
  const problems = [];
  let before;
  let after;
  try {
    before = JSON.parse(beforeText);
    after = JSON.parse(afterText);
  } catch (error) {
    return [`journal JSON is invalid: ${error.message}`];
  }
  if (!Array.isArray(before.entries) || !Array.isArray(after.entries)) return ["journal entries must be arrays"];
  if (before.version !== after.version || before.dialect !== after.dialect) problems.push("journal version/dialect cannot change");
  if (after.entries.length <= before.entries.length) problems.push("journal changes must append at least one entry");
  for (let index = 0; index < before.entries.length; index += 1) {
    if (JSON.stringify(before.entries[index]) !== JSON.stringify(after.entries[index])) {
      problems.push(`journal entry ${index} was edited or reordered`);
      break;
    }
  }
  const migrationRoot = journalPath.slice(0, -"/meta/_journal.json".length);
  const tags = new Set(before.entries.map((entry) => entry.tag));
  for (let index = before.entries.length; index < after.entries.length; index += 1) {
    const entry = after.entries[index];
    if (entry.idx !== index) problems.push(`appended journal entry ${index} has idx ${entry.idx}`);
    if (typeof entry.tag !== "string" || !entry.tag.trim() || tags.has(entry.tag)) {
      problems.push(`appended journal entry ${index} has a missing or duplicate tag`);
      continue;
    }
    tags.add(entry.tag);
    const migrationPath = `${migrationRoot}/${entry.tag}.sql`;
    if (!availableHeadMigrationPaths.has(migrationPath)) problems.push(`appended journal entry ${entry.tag} has no matching SQL migration`);
  }
  return problems;
}

function compareMigrationManifests(baseInventory, headInventory, baseContents, headContents) {
  const failures = [];
  const added = [];
  const changed = [];
  const deleted = [];
  const baseEntries = new Map((baseInventory.migration_manifest ?? []).map((entry) => [entry.path, entry]));
  const headEntries = new Map((headInventory.migration_manifest ?? []).map((entry) => [entry.path, entry]));
  const headPaths = new Set(headEntries.keys());
  for (const migrationPath of [...new Set([...baseEntries.keys(), ...headEntries.keys()])].sort()) {
    const before = baseContents.get(migrationPath);
    const after = headContents.get(migrationPath);
    if (!before && after) {
      added.push(migrationPath);
      const isSql = migrationPath.endsWith(".sql");
      const isSnapshot = /\/meta\/\d+_snapshot\.json$/.test(migrationPath);
      if (!isSql && !isSnapshot) failures.push(`new migration input is not a SQL file or Drizzle snapshot: ${migrationPath}`);
      continue;
    }
    if (before && !after) {
      deleted.push(migrationPath);
      failures.push(`existing migration history cannot be deleted: ${migrationPath}`);
      continue;
    }
    if (!before || !after || before.sha256 === after.sha256) continue;
    changed.push(migrationPath);
    if (!migrationPath.endsWith("/meta/_journal.json")) {
      failures.push(`existing migration SQL/snapshot is immutable: ${migrationPath}`);
      continue;
    }
    for (const problem of journalAppendProblems(migrationPath, before.content, after.content, headPaths)) {
      failures.push(`${migrationPath}: ${problem}`);
    }
  }
  return { failures, added, changed, deleted };
}

function compareInventoriesWithPolicy(baseInventory, headInventory, baseContents, headContents, trustedAdmissions, trustedCallers = TRUSTED_NATIVE_CHAT_FENCE_CALLERS) {
  const failures = [];
  const addedFiles = [];
  const changedFiles = [];
  const deletedFiles = [];
  const basePaths = new Set(baseInventory.source_manifest.map((entry) => entry.path));
  const headPaths = new Set(headInventory.source_manifest.map((entry) => entry.path));
  const records = recordMap(headInventory.reviewed_node_changes);
  const recordList = Array.isArray(headInventory.reviewed_node_changes) ? headInventory.reviewed_node_changes : [];
  const recordPaths = recordList.map((record) => record?.path).filter((value) => typeof value === "string");
  for (const recordPath of new Set(recordPaths.filter((value, index) => recordPaths.indexOf(value) !== index))) {
    failures.push(`duplicate reviewed_node_changes record: ${recordPath}`);
  }
  const consumedRecords = new Set();
  for (const sourcePath of [...new Set([...basePaths, ...headPaths])].sort()) {
    const before = baseContents.get(sourcePath);
    const after = headContents.get(sourcePath);
    if (!before && after) {
      addedFiles.push(sourcePath);
      const record = records.get(sourcePath);
      if (!isTransportAdapterPath(sourcePath)) {
        failures.push(`new production Node source is forbidden by the ratchet: ${sourcePath}`);
      } else {
        consumedRecords.add(sourcePath);
        const problems = validateBoundaryRecord(record, sourcePath, null, after.sha256, "new_transport_adapter");
        if (record?.node_role !== "transport_adapter") problems.push('node_role must be "transport_adapter"');
        if (Object.hasOwn(TRUSTED_NODE_TRANSPORT_SOURCES, sourcePath)) {
          problems.push(...validateTrustedNodeTransportSourceRecord(record, sourcePath, after.sha256));
        }
        if (problems.length) failures.push(`${sourcePath}: ${problems.join("; ")}`);
      }
      continue;
    }
    if (before && !after) {
      deletedFiles.push(sourcePath);
      continue;
    }
    if (!before || !after || before.sha256 === after.sha256) continue;
    changedFiles.push(sourcePath);
    consumedRecords.add(sourcePath);
    const record = records.get(sourcePath);
    const baseEntry = baseInventory.source_manifest.find((entry) => entry.path === sourcePath);
    const headEntry = headInventory.source_manifest.find((entry) => entry.path === sourcePath);
    const retainedClientChange = isRetainedElectronClientSource(sourcePath, baseEntry, headEntry);
    const problems = retainedClientChange
      ? validateRetainedClientRecord(record, sourcePath, before.sha256, after.sha256)
      : validateBoundaryRecord(record, sourcePath, before.sha256, after.sha256, "modified_node_compatibility");
    if (!retainedClientChange && record && Object.hasOwn(record, "associated_backend_authority")) {
      problems.push("associated_backend_authority is only valid for retained_client records");
    }
    if (!retainedClientChange && record && !["compatibility_adapter", "transport_adapter"].includes(record.node_role)) {
      problems.push('node_role must be "compatibility_adapter" or "transport_adapter"');
    }
    if (problems.length) failures.push(`${sourcePath}: ${problems.join("; ")}`);
    if (Object.hasOwn(TRUSTED_NODE_TRANSPORT_SOURCES, sourcePath)) {
      const trustedSourceProblems = validateTrustedNodeTransportSourceRecord(record, sourcePath, after.sha256);
      if (trustedSourceProblems.length) failures.push(`${sourcePath}: ${trustedSourceProblems.join("; ")}`);
    }
  }

  const routeAndWriterTypes = new Set([
    "http_route", "middleware_mount", "websocket_event", "database_call_candidate", "database_write_candidate", "sql_dml_candidate",
    "worker_schedule_candidate", "runtime_resource_ownership", "cli_command_candidate", "mcp_tool_candidate",
    "listener_start", "http_server_construction",
  ]);
  const surfaceChanges = surfaceChangeCounts(baseInventory.structural_surfaces, headInventory.structural_surfaces, routeAndWriterTypes);
  const addedSurfaces = [...surfaceChanges.added].map(([signature, count]) => ({ signature, count }));
  const removedSurfaces = [...surfaceChanges.removed].map(([signature, count]) => ({ signature, count }));

  const hasTransportRecords = Object.hasOwn(headInventory, "reviewed_transport_admissions");
  const transportRecords = headInventory.reviewed_transport_admissions;
  if (hasTransportRecords && !Array.isArray(transportRecords)) {
    failures.push("reviewed_transport_admissions must be an array");
  }
  const normalizedTransportRecords = Array.isArray(transportRecords) ? transportRecords : [];
  const transportIds = normalizedTransportRecords.map((record) => record?.id).filter((value) => typeof value === "string");
  for (const id of new Set(transportIds.filter((value, index) => transportIds.indexOf(value) !== index))) {
    failures.push(`duplicate reviewed_transport_admissions record: ${id}`);
  }

  const headAdmissionSurfaces = headInventory.structural_surfaces.filter((surface) => surface.transport_admission);
  const admissionSurfacesById = new Map();
  for (const surface of headAdmissionSurfaces) {
    const values = admissionSurfacesById.get(surface.transport_admission) ?? [];
    values.push(surface);
    admissionSurfacesById.set(surface.transport_admission, values);
  }
  const transportRecordsById = new Map(normalizedTransportRecords.map((record) => [record?.id, record]));
  const allowedTransportSurfaceSignatures = new Set();
  const allowedTransportAdmissions = [];
  const allowedReplacementUnknown = new Set();
  for (const [id, policy] of Object.entries(trustedAdmissions)) {
    const surfacesForId = admissionSurfacesById.get(id) ?? [];
    const record = transportRecordsById.get(id);
    const mountSource = headContents.get(policy.source_path);
    const sourceVariant = mountSource
      ? conditionalTransportSourceVariant(policy, mountSource.sha256)
      : null;
    const requiredAdditionalMounts = sourceVariant?.additional_mounts ?? [];
    const primarySurfaces = surfacesForId.filter((surface) => surface.expression === policy.mount_expression);
    if (surfacesForId.length === 0 && record) failures.push(`stale reviewed_transport_admissions record: ${id}`);
    if (primarySurfaces.length > 1 || (surfacesForId.length > 0 && primarySurfaces.length !== 1)) {
      failures.push(`${id}: trusted primary transport-admission mount must appear exactly once`);
    }
    if (surfacesForId.length !== (primarySurfaces.length === 1 ? 1 + requiredAdditionalMounts.length : 0)) {
      failures.push(`${id}: only the source-pinned conditional middleware surfaces may accompany its primary mount`);
    }
    if (surfacesForId.length === 0) continue;
    if (!record) {
      failures.push(`${id}: missing reviewed_transport_admissions record`);
      continue;
    }
    const problems = validateTransportAdmissionRecord(record, policy, headInventory, headContents);
    const surface = primarySurfaces[0];
    if (!surface || surface.type !== "middleware_mount" || surface.source !== policy.source_path
      || surface.receiver !== policy.receiver || surface.expression !== policy.mount_expression) {
      problems.push("generated middleware surface does not match the trusted mount identity");
    }
    for (const mount of requiredAdditionalMounts) {
      const matchingSurfaces = surfacesForId.filter((entry) => entry.expression === mount.expression);
      if (matchingSurfaces.length !== 1 || matchingSurfaces[0].type !== "middleware_mount"
        || matchingSurfaces[0].source !== policy.source_path || matchingSurfaces[0].receiver !== policy.receiver) {
        problems.push("conditional Rust email-auth fence surface does not match its exact trusted middleware identity");
      }
    }
    let replacementSurface;
    if (policy.existing_mount_replacement) {
      const replacement = policy.existing_mount_replacement;
      const mounts = (inventory, expression) => inventory.structural_surfaces.filter((entry) =>
        entry.type === "middleware_mount" && entry.source === policy.source_path
        && entry.receiver === policy.receiver && entry.expression === expression);
      const oldBase = mounts(baseInventory, replacement.before);
      const newBase = mounts(baseInventory, replacement.after);
      const oldHead = mounts(headInventory, replacement.before);
      const newHead = mounts(headInventory, replacement.after);
      if (!policy.source_sha256 || oldHead.length !== 0 || newHead.length !== 1
        || !((oldBase.length === 1 && newBase.length === 0) || (oldBase.length === 0 && newBase.length === 1))) {
        problems.push("existing actor mount must be replaced exactly once from the trusted base; adding or retaining another mount is forbidden");
      } else replacementSurface = newHead[0];
    }
    if (problems.length) {
      failures.push(`${id}: ${problems.join("; ")}`);
      continue;
    }
    if (replacementSurface) {
      allowedTransportSurfaceSignatures.add(replacementSurface.signature);
      allowedReplacementUnknown.add(`dynamic_middleware_mount|${replacementSurface.source}|${replacementSurface.expression}`);
    }
    allowedTransportSurfaceSignatures.add(surface.signature);
    for (const mount of requiredAdditionalMounts) {
      for (const additionalSurface of surfacesForId.filter((entry) => entry.expression === mount.expression)) {
        allowedTransportSurfaceSignatures.add(additionalSurface.signature);
      }
    }
    allowedTransportAdmissions.push({
      id,
      source_path: policy.source_path,
      signature: surface.signature,
      ...(requiredAdditionalMounts.length
        ? { conditional_signatures: surfacesForId
          .filter((entry) => requiredAdditionalMounts.some((mount) => entry.expression === mount.expression))
          .map((entry) => entry.signature) }
        : {}),
    });
  }
  for (const record of normalizedTransportRecords) {
    if (typeof record?.id !== "string" || !Object.hasOwn(trustedAdmissions, record.id)) {
      failures.push(`untrusted reviewed_transport_admissions record: ${record?.id ?? "<missing id>"}`);
    }
  }
  for (const surface of headAdmissionSurfaces) {
    if (!Object.hasOwn(trustedAdmissions, surface.transport_admission)) {
      failures.push(`untrusted transport-admission surface: ${surface.transport_admission}`);
    }
  }

  const unmatchedAdded = new Map(surfaceChanges.added);
  for (const signature of allowedTransportSurfaceSignatures) {
    const remaining = unmatchedAdded.get(signature) ?? 0;
    if (remaining === 1) unmatchedAdded.delete(signature);
  }
  for (const record of records.values()) {
    consumeReviewedTransportSurfaces(
      record,
      record.path,
      headInventory.structural_surfaces,
      headContents,
      unmatchedAdded,
      failures,
    );
  }
  const legacyFenceComparison = compareLegacyFenceChanges(
    baseInventory, headInventory, baseContents, headContents, unmatchedAdded, surfaceChanges.removed, trustedCallers,
  );
  failures.push(...legacyFenceComparison.failures);

  const oldUnknown = new Set(baseInventory.unknown.map((entry) => `${entry.type}|${entry.source}|${entry.expression ?? ""}`));
  const addedUnknown = headInventory.unknown.filter((entry) => !oldUnknown.has(`${entry.type}|${entry.source}|${entry.expression ?? ""}`));
  for (const entry of addedUnknown) {
    if (allowedReplacementUnknown.has(`${entry.type}|${entry.source}|${entry.expression ?? ""}`)) continue;
    failures.push(`new unclassified Node surface blocks the ratchet: ${entry.type} at ${entry.source}:${entry.line ?? "?"}`);
  }

  for (const record of records.values()) {
    if (!consumedRecords.has(record.path)) failures.push(`stale or unrelated reviewed_node_changes record: ${record.path}`);
  }
  const migrations = compareMigrationManifests(baseInventory, headInventory, baseContents, headContents);
  failures.push(...migrations.failures);
  return {
    failures, added_files: addedFiles, changed_files: changedFiles, deleted_files: deletedFiles,
    added_surfaces: addedSurfaces, removed_surfaces: removedSurfaces,
    allowed_transport_admissions: allowedTransportAdmissions,
    reviewed_legacy_fence_changes: legacyFenceComparison.consumed_ids,
    added_unknown: addedUnknown,
    migration_added: migrations.added, migration_changed: migrations.changed, migration_deleted: migrations.deleted,
  };
}

function compareInventories(baseInventory, headInventory, baseContents, headContents) {
  return compareInventoriesWithPolicy(baseInventory, headInventory, baseContents, headContents, TRUSTED_TRANSPORT_ADMISSIONS);
}

function compareInventoriesWithTransportPolicyForTests(baseInventory, headInventory, baseContents, headContents, policy) {
  return compareInventoriesWithPolicy(baseInventory, headInventory, baseContents, headContents, { [policy.id]: policy });
}

// Test-only analogue of the transport policy harness. The production CLI and
// compareInventories always use the static source table above, never records.
function compareInventoriesWithLegacyFenceSourcePolicyForTests(base, head, before, after, trustedCallers) {
  return compareInventoriesWithPolicy(base, head, before, after, TRUSTED_TRANSPORT_ADMISSIONS, trustedCallers);
}

function inventoryContentsFromRoot(rootPath, inventory) {
  const result = new Map();
  for (const entry of [...inventory.source_manifest, ...(inventory.migration_manifest ?? [])]) {
    const content = fs.readFileSync(path.join(rootPath, entry.path));
    result.set(entry.path, { content: content.toString("utf8"), sha256: sha256(content) });
  }
  return result;
}

function inventoryTreeAtRef(rootPath, compareRef, paths) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-rust-authority-base-"));
  try {
    if (paths.length) {
      const archive = git(rootPath, ["archive", "--format=tar", compareRef, "--", ...paths], { encoding: null });
      execFileSync("tar", ["-xf", "-", "-C", temporaryRoot], {
        input: archive,
        stdio: ["pipe", "ignore", "pipe"],
        maxBuffer: 128 * 1024 * 1024,
      });
    }
    const inventory = buildInventory(temporaryRoot);
    return { inventory, contents: inventoryContentsFromRoot(temporaryRoot, inventory) };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() ?? "check";
  const options = { command, root: DEFAULT_ROOT, inventory: DEFAULT_INVENTORY, compareRef: null };
  while (args.length) {
    const flag = args.shift();
    const value = args.shift();
    if (flag === "--root" && value) options.root = path.resolve(value);
    else if (flag === "--inventory" && value) options.inventory = value;
    else if (flag === "--compare-ref" && value) options.compareRef = value;
    else throw new Error(`unknown or incomplete argument: ${flag}`);
  }
  options.inventoryPath = path.isAbsolute(options.inventory) ? options.inventory : path.join(options.root, options.inventory);
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/rust-backend-authority-inventory.mjs generate [--root PATH] [--inventory PATH]",
    "  node scripts/rust-backend-authority-inventory.mjs check [--root PATH] [--inventory PATH]",
    "  node scripts/rust-backend-authority-inventory.mjs compare --compare-ref REF [--root PATH] [--inventory PATH]",
  ].join("\n");
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!["generate", "check", "compare"].includes(options.command)) throw new Error(`${usage()}\n`);
  const prior = readInventory(options.inventoryPath);
  const current = buildInventory(
    options.root,
    prior?.reviewed_node_changes ?? [],
    prior?.reviewed_transport_admissions,
    prior?.reviewed_legacy_fence_changes ?? [],
  );
  if (options.command === "generate") {
    writeInventory(options.inventoryPath, current, prior);
    process.stdout.write(`Generated ${options.inventory} (${current.source_manifest.length} source files, ${current.structural_surfaces.length} structural surfaces, ${current.unknown.length} unknowns).\n`);
    return 0;
  }
  if (!prior) throw new Error(`inventory is missing: ${options.inventoryPath}; run generate and review the result`);
  if (JSON.stringify(stableGeneratedPart(current)) !== JSON.stringify(stableGeneratedPart(prior))) {
    process.stderr.write(`Generated inventory is stale: ${options.inventory}. Re-generate it and review source/unknown deltas.\n`);
    return 1;
  }
  if (options.command === "check") {
    process.stdout.write(`Inventory matches current source (${current.source_manifest.length} source files, ${current.structural_surfaces.length} structural surfaces, ${current.unknown.length} unknowns).\n`);
    return 0;
  }
  if (!options.compareRef) throw new Error(`compare requires --compare-ref REF\n${usage()}`);
  const basePaths = baseTrackedPaths(options.root, options.compareRef);
  const baseTree = inventoryTreeAtRef(options.root, options.compareRef, basePaths);
  const baseInventory = baseTree.inventory;
  const baseContents = baseTree.contents;
  const headContents = inventoryContentsFromRoot(options.root, current);
  const comparison = compareInventories(baseInventory, current, baseContents, headContents);
  process.stdout.write(JSON.stringify({ compare_ref: options.compareRef, ...comparison }, null, 2) + "\n");
  if (comparison.failures.length) {
    process.stderr.write(`Rust backend authority ratchet failed with ${comparison.failures.length} finding(s).\n`);
    return 1;
  }
  process.stdout.write("Rust backend authority ratchet passed.\n");
  return 0;
}

const buildInventoryFromSources = (rootPath, ref, paths) => inventoryTreeAtRef(rootPath, ref, paths).inventory;

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try { process.exitCode = main(); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

export {
  buildInventory,
  buildInventoryFromSources,
  compareInventories, compareInventoriesWithLegacyFenceSourcePolicyForTests, compareInventoriesWithTransportPolicyForTests, compareMigrationManifests,
  journalAppendProblems,
  scanSource,
  sha256,
  stableGeneratedPart, TRUSTED_NODE_TRANSPORT_SOURCES, TRUSTED_TRANSPORT_ADMISSIONS,
  consumeReviewedTransportSurfaces, validateTrustedNodeTransportSourceRecord,
  TRUSTED_TRANSPORT_SURFACES, validateBoundaryRecord
};
