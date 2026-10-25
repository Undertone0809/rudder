import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildInventory,
  compareInventoriesWithLegacyFenceSourcePolicyForTests,
  compareInventoriesWithTransportPolicyForTests,
  compareInventories as compareProductionInventories,
  consumeReviewedTransportSurfaces,
  scanSource,
  sha256,
  TRUSTED_NODE_TRANSPORT_SOURCES,
  TRUSTED_TRANSPORT_ADMISSIONS,
  TRUSTED_TRANSPORT_SURFACES,
  validateTrustedNodeTransportSourceRecord,
} from "./rust-backend-authority-inventory.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");


// Fixed canonical caller fixture, never derived from the mutated candidate.
function compareInventories(base, head, before, after) {
  return compareInventoriesWithLegacyFenceSourcePolicyForTests(base, head, before, after, {
    [queueGuardCallerPath]: sha256(queueGuardCallerHead),
  });
}

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

function retainedClientRecord(sourcePath, baseHash, headHash, overrides = {}) {
  return {
    path: sourcePath,
    change_kind: "modified_retained_client",
    node_role: "retained_client",
    base_sha256: baseHash,
    head_sha256: headHash,
    client_responsibility: "Electron owns client-side account-gate and credential-storage policy; it does not own server account lifecycle.",
    associated_backend_authority: "native::server_foundation::local_account_auth",
    compatibility_boundary: "This is retained Electron client policy/storage code; the related Rust owner applies only to server-side local-account lifecycle.",
    reviewer: "maintainer@example.test",
    review_reference: "Reviewed retained Electron client boundary fixture",
    review_status: "reviewed",
    ...overrides,
  };
}

function surfaceRef(inventory, sourcePath, type, method) {
  const surface = inventory.structural_surfaces.find((entry) => entry.source === sourcePath
    && entry.type === type && entry.method === method);
  assert(surface, `missing ${type}/${method} surface in ${sourcePath}`);
  return { type: surface.type, signature: surface.signature, line: surface.line };
}

function legacyFenceRecord(t, { sourcePath, baseSource, headSource, changeKind, overrides = {} }) {
  const baseRoot = temporaryTree(t);
  const headRoot = temporaryTree(t);
  put(baseRoot, sourcePath, baseSource);
  put(headRoot, sourcePath, headSource);
  const base = buildInventory(baseRoot);
  const head = buildInventory(headRoot);
  const record = {
    id: `${changeKind}:${sourcePath.replaceAll("/", ".")}`,
    path: sourcePath,
    base_sha256: base.source_manifest.find((entry) => entry.path === sourcePath).sha256,
    head_sha256: head.source_manifest.find((entry) => entry.path === sourcePath).sha256,
    change_kind: changeKind,
    semantic_operation: "chat_queue.claim",
    ...(changeKind === "existing_operation_mapping" ? {} : {
      transaction_mapping_id: `existing-operation:${sourcePath.replaceAll("/", ".")}`,
    }),
    rust_authority: "native::native_chat::admission",
    compatibility_boundary: "This exact Node callsite is a temporary ordering fence; Rust owns admission and durable authority.",
    retirement_criterion: "Delete after Node queue workers and direct mutations are removed from production.",
    reviewer: "maintainer@example.test",
    review_reference: "Reviewed exact legacy fence callsite",
    review_status: "reviewed",
  };
  if (changeKind === "target_advisory_lock") {
    record.head_surfaces = [
      surfaceRef(head, sourcePath, "database_call_candidate", "execute"),
      surfaceRef(head, sourcePath, "database_write_candidate", "execute"),
    ];
    record.base_protected_surface = surfaceRef(base, sourcePath, "database_write_candidate", "insert");
    record.head_protected_surface = surfaceRef(head, sourcePath, "database_write_candidate", "insert");
  }
  Object.assign(record, overrides);
  return { baseRoot, headRoot, base, head, record };
}

function compareLegacyFenceFixture(fixture, record = fixture.record, { includeOperationMapping = true } = {}) {
  const records = Array.isArray(record) ? [...record] : [record];
  const transactionKey = (surface) => surface.type === "database_call_candidate" && surface.method === "transaction";
  const oldTransactions = fixture.base.structural_surfaces.filter((surface) => surface.source === fixture.record.path && transactionKey(surface));
  const newTransactions = fixture.head.structural_surfaces.filter((surface) => surface.source === fixture.record.path && transactionKey(surface));
  const oldSignatures = new Set(oldTransactions.map((surface) => surface.signature));
  const newSignatures = new Set(newTransactions.map((surface) => surface.signature));
  const removed = oldTransactions.filter((surface) => !newSignatures.has(surface.signature));
  const added = newTransactions.filter((surface) => !oldSignatures.has(surface.signature));
  if (includeOperationMapping && removed.length === 1 && added.length === 1) {
    records.push({
      id: `existing-operation:${fixture.record.path.replaceAll("/", ".")}`,
      path: fixture.record.path,
      base_sha256: fixture.record.base_sha256,
      head_sha256: fixture.record.head_sha256,
      change_kind: "existing_operation_mapping",
      semantic_operation: "chat_queue.claim",
      base_surface: { type: removed[0].type, signature: removed[0].signature, line: removed[0].line },
      head_surface: { type: added[0].type, signature: added[0].signature, line: added[0].line },
      base_protected_surface: surfaceRef(fixture.base, fixture.record.path, "database_write_candidate", "insert"),
      head_protected_surface: surfaceRef(fixture.head, fixture.record.path, "database_write_candidate", "insert"),
      rust_authority: "native::native_chat::admission",
      compatibility_boundary: "The callback remains the same existing queue claim operation; the exact body change is separately reviewed.",
      retirement_criterion: "Delete after the Node queue claim is removed from production.",
      reviewer: "maintainer@example.test",
      review_reference: "Reviewed exact transaction callback mapping",
      review_status: "reviewed",
    });
  }
  const nodeRecords = [...new Map(records.map((entry) => [entry.path, boundaryRecord(entry.path, entry.base_sha256, entry.head_sha256)])).values()];
  const head = buildInventory(fixture.headRoot, nodeRecords, undefined, records);
  return compareInventories(fixture.base, head, contentsFor(fixture.baseRoot, fixture.base), contentsFor(fixture.headRoot, head));
}

const queueGuardHelperPath = "server/src/services/organization-mutation-fence.ts";
const queueGuardCallerPath = "server/src/services/chat-queue.ts";
const queueGuardHelperBase = `export async function lockNodeMutationAuthority(tx, organizationId) {
  await tx.execute(sql\`select owner from organization_mutation_state where org_id = ${"${organizationId}"}::uuid for update\`);
}
`;
const trustedQueueGuardBody = [
  "{",
  "  const hintResult = await tx.execute(sql`",
  "    SELECT c.org_id::text AS org_id, c.id::text AS id",
  "    FROM chat_conversations c",
  "    WHERE c.org_id = ${organizationId}::uuid",
  "      AND c.id = ${conversationId}::uuid",
  "  `) as { rows?: LegacyChatTargetHint[] } | LegacyChatTargetHint[];",
  "  const hint = Array.isArray(hintResult) ? hintResult[0] : hintResult.rows?.[0];",
  "  if (!hint) return \"missing\";",
  "",
  "  // Use UUID values read back from PostgreSQL. This matches Rust's canonical",
  "  // UUID string when callers supplied uppercase but equivalent UUID text.",
  "  const targetKey = `runtime-binding:target:chat_conversation:${hint.org_id}:${hint.id}`;",
  "  await tx.execute(sql`",
  "    SELECT pg_advisory_xact_lock(hashtextextended(${targetKey}, 0))",
  "  `);",
  "",
  "  const result = await tx.execute(sql`",
  "    SELECT c.id::text AS id,",
  "      EXISTS (",
  "        SELECT 1",
  "        FROM chat_generations native_generation",
  "        WHERE native_generation.org_id = c.org_id",
  "          AND native_generation.conversation_id = c.id",
  "          AND native_generation.execution_authority = 'native_rust'",
  "      ) AS native_owned",
  "    FROM chat_conversations c",
  "    WHERE c.org_id = ${organizationId}::uuid",
  "      AND c.id = ${conversationId}::uuid",
  "    FOR SHARE OF c",
  "  `) as { rows?: LegacyChatTargetRow[] } | LegacyChatTargetRow[];",
  "  const row = Array.isArray(result) ? result[0] : result.rows?.[0];",
  "  if (!row) return \"missing\";",
  "  return row.native_owned ? \"native_owned\" : \"available\";",
  "}",
].join("\n");
const queueGuardHelperHead = `${queueGuardHelperBase}
export async function lockLegacyNativeChatQueueTarget(tx: TransactionClient, organizationId: string, conversationId: string): Promise<"available" | "native_owned" | "missing"> ${trustedQueueGuardBody}
`;
const queueGuardCallerBase = `import { lockLegacyNativeChatQueueTarget } from "./organization-mutation-fence.js";
export async function enqueue(db, input) {
  await db.transaction(async (tx) => {
    await tx.insert(chatMessages).values({ conversationId: input.conversationId, body: input.body });
  });
}
`;
const queueGuardCallerHead = `import { lockLegacyNativeChatQueueTarget } from "./organization-mutation-fence.js";
export async function enqueue(db, input) {
  await db.transaction(async (tx) => {
    const targetAuthority = await lockLegacyNativeChatQueueTarget(tx, input.orgId, input.conversationId);
    if (targetAuthority === "missing") throw notFound("Chat conversation not found");
    if (targetAuthority === "native_owned") { throw conflict("Native Chat owns this target"); }
    await tx.insert(chatMessages).values({ conversationId: input.conversationId, body: input.body });
  });
}
`;

function queueGuardRecords(baseRoot, headRoot, helperHeadSource = queueGuardHelperHead, callerHeadSource = queueGuardCallerHead) {
  const base = buildInventory(baseRoot);
  const headWithoutRecords = buildInventory(headRoot);
  const helperStartLine = helperHeadSource.slice(0, helperHeadSource.indexOf("export async function lockLegacyNativeChatQueueTarget")).split("\n").length;
  const helperHead = headWithoutRecords.structural_surfaces.filter((surface) => surface.source === queueGuardHelperPath
    && ["database_call_candidate", "database_write_candidate"].includes(surface.type)
    && surface.method === "execute" && surface.line >= helperStartLine);
  const helperRecord = {
    id: "native-chat-queue-guard:helper",
    path: queueGuardHelperPath,
    base_sha256: base.source_manifest.find((entry) => entry.path === queueGuardHelperPath).sha256,
    head_sha256: headWithoutRecords.source_manifest.find((entry) => entry.path === queueGuardHelperPath).sha256,
    change_kind: "native_chat_queue_guard_helper",
    helper_name: "lockLegacyNativeChatQueueTarget",
    semantic_operation: "chat.queue.mutation-fence",
    head_surfaces: helperHead.map((surface) => ({ type: surface.type, signature: surface.signature, line: surface.line })),
    rust_authority: "native::native_chat::admission",
    compatibility_boundary: "This exact Node helper serializes the existing queue writers with Rust admission and checks the Native owner under the same transaction.",
    retirement_criterion: "Delete after legacy Node chat queue mutation paths and workers are retired.",
    reviewer: "maintainer@example.test",
    review_reference: "Reviewed exact queue helper and caller source hashes",
    review_status: "reviewed",
  };
  const baseCaller = base.structural_surfaces.filter((surface) => surface.source === queueGuardCallerPath);
  const headCaller = headWithoutRecords.structural_surfaces.filter((surface) => surface.source === queueGuardCallerPath);
  const oldTransaction = baseCaller.find((surface) => surface.type === "database_call_candidate" && surface.method === "transaction");
  const newTransaction = headCaller.find((surface) => surface.type === "database_call_candidate" && surface.method === "transaction");
  const oldWriter = baseCaller.find((surface) => surface.type === "database_write_candidate" && surface.method === "insert");
  const newWriter = headCaller.find((surface) => surface.type === "database_write_candidate" && surface.method === "insert");
  const mapping = {
    id: "native-chat-queue-guard:operation",
    path: queueGuardCallerPath,
    base_sha256: base.source_manifest.find((entry) => entry.path === queueGuardCallerPath).sha256,
    head_sha256: headWithoutRecords.source_manifest.find((entry) => entry.path === queueGuardCallerPath).sha256,
    change_kind: "existing_operation_mapping",
    semantic_operation: "chat.queue.mutation-fence",
    base_surface: { type: oldTransaction.type, signature: oldTransaction.signature, line: oldTransaction.line },
    head_surface: { type: newTransaction.type, signature: newTransaction.signature, line: newTransaction.line },
    base_protected_surface: { type: oldWriter.type, signature: oldWriter.signature, line: oldWriter.line },
    head_protected_surface: { type: newWriter.type, signature: newWriter.signature, line: newWriter.line },
    rust_authority: "native::native_chat::admission",
    compatibility_boundary: "The existing queue insert remains the same operation inside its existing transaction.",
    retirement_criterion: "Delete after legacy Node chat queue mutation paths and workers are retired.",
    reviewer: "maintainer@example.test",
    review_reference: "Reviewed exact queue helper and caller source hashes",
    review_status: "reviewed",
  };
  const callStart = callerHeadSource.indexOf("await lockLegacyNativeChatQueueTarget(");
  const helperNameStart = callStart + "await ".length;
  const line = callerHeadSource.slice(0, callStart).split("\n").length;
  const callClose = callerHeadSource.indexOf(");", callStart) + 1;
  const callsite = callerHeadSource.slice(helperNameStart, callClose).replace(/\s+/g, " ").trim();
  const callsiteRecord = {
    id: "native-chat-queue-guard:caller",
    path: queueGuardCallerPath,
    base_sha256: base.source_manifest.find((entry) => entry.path === queueGuardCallerPath).sha256,
    head_sha256: headWithoutRecords.source_manifest.find((entry) => entry.path === queueGuardCallerPath).sha256,
    change_kind: "native_chat_queue_guard_callsite",
    semantic_operation: "chat.queue.mutation-fence",
    transaction_mapping_id: mapping.id,
    guard_helper_id: helperRecord.id,
    head_guard_callsite: { type: "guard_callsite", signature: callsite, line },
    base_protected_surface: mapping.base_protected_surface,
    head_protected_surface: mapping.head_protected_surface,
    rust_authority: "native::native_chat::admission",
    compatibility_boundary: "This exact callsite acquires the queue fence before the unchanged message insert.",
    retirement_criterion: "Delete after legacy Node chat queue mutation paths and workers are retired.",
    reviewer: "maintainer@example.test",
    review_reference: "Reviewed exact queue helper and caller source hashes",
    review_status: "reviewed",
  };
  return { base, headWithoutRecords, records: [helperRecord, mapping, callsiteRecord] };
}

function compareQueueGuardFixture(t, { helperHeadSource = queueGuardHelperHead, callerHeadSource = queueGuardCallerHead } = {}) {
  const baseRoot = temporaryTree(t);
  const headRoot = temporaryTree(t);
  put(baseRoot, queueGuardHelperPath, queueGuardHelperBase);
  put(headRoot, queueGuardHelperPath, helperHeadSource);
  put(baseRoot, queueGuardCallerPath, queueGuardCallerBase);
  put(headRoot, queueGuardCallerPath, callerHeadSource);
  const { base, records } = queueGuardRecords(baseRoot, headRoot, helperHeadSource, callerHeadSource);
  const nodeRecords = [
    boundaryRecord(queueGuardHelperPath, sha256(queueGuardHelperBase), sha256(helperHeadSource)),
    boundaryRecord(queueGuardCallerPath, sha256(queueGuardCallerBase), sha256(callerHeadSource)),
  ];
  const head = buildInventory(headRoot, nodeRecords, undefined, records);
  return { baseRoot, headRoot, base, head, records,
    result: compareInventories(base, head, contentsFor(baseRoot, base), contentsFor(headRoot, head)) };
}

const chatAuthorityHelperPath = "server/src/services/chats.ts";
const chatAuthorityHelperBase = `export function chatService() { return null; }
`;
const trustedChatHelperBodies = {
  assertLegacyChatConversationAuthority: [
    "{",
    "    const authority = await lockLegacyNativeChatQueueTarget(tx, orgId, conversationId);",
    "    if (authority === \"missing\") throw notFound(\"Chat conversation not found\");",
    "    if (authority === \"native_owned\") {",
    "      throw conflict(\"This chat is controlled by the Rust Native Chat runtime\");",
    "    }",
    "  }",
  ].join("\n"),
  assertLegacyChatGenerationAuthority: [
    "{",
    "    const hint = await tx",
    "      .select({ orgId: chatGenerations.orgId, conversationId: chatGenerations.conversationId })",
    "      .from(chatGenerations)",
    "      .where(and(",
    "        eq(chatGenerations.orgId, orgId),",
    "        eq(chatGenerations.id, generationId),",
    "      ))",
    "      .limit(1)",
    "      .then((rows: Array<{ orgId: string; conversationId: string }>) => rows[0] ?? null);",
    "    if (hint) await assertLegacyChatConversationAuthority(tx, hint.orgId, hint.conversationId);",
    "    return hint;",
    "  }",
  ].join("\n"),
  assertLegacyQueuedMessageAuthority: [
    "{",
    "    const hint = await tx",
    "      .select({ orgId: chatQueuedMessages.orgId, conversationId: chatQueuedMessages.conversationId })",
    "      .from(chatQueuedMessages)",
    "      .where(and(",
    "        eq(chatQueuedMessages.id, itemId),",
    "        expected?.orgId ? eq(chatQueuedMessages.orgId, expected.orgId) : undefined,",
    "        expected?.conversationId ? eq(chatQueuedMessages.conversationId, expected.conversationId) : undefined,",
    "      ))",
    "      .limit(1)",
    "      .then((rows: Array<{ orgId: string; conversationId: string }>) => rows[0] ?? null);",
    "    if (hint) await assertLegacyChatConversationAuthority(tx, hint.orgId, hint.conversationId);",
    "    return hint;",
    "  }",
  ].join("\n"),
  assertLegacyChatConversationIdAuthority: [
    "{",
    "    const hint = await tx",
    "      .select({ orgId: chatConversations.orgId })",
    "      .from(chatConversations)",
    "      .where(eq(chatConversations.id, conversationId))",
    "      .limit(1)",
    "      .then((rows: Array<{ orgId: string }>) => rows[0] ?? null);",
    "    if (!hint) throw notFound(\"Chat conversation not found\");",
    "    await assertLegacyChatConversationAuthority(tx, hint.orgId, conversationId);",
    "    return hint;",
    "  }",
  ].join("\n"),
};
const chatAuthorityHelperHead = `import { lockLegacyNativeChatQueueTarget } from "./organization-mutation-fence.js";
export function chatService() {
  async function assertLegacyChatConversationAuthority(tx: any, orgId: string, conversationId: string) ${trustedChatHelperBodies.assertLegacyChatConversationAuthority}
  async function assertLegacyChatGenerationAuthority(tx: any, orgId: string, generationId: string) ${trustedChatHelperBodies.assertLegacyChatGenerationAuthority}
  async function assertLegacyQueuedMessageAuthority(tx: any, itemId: string, expected?: { orgId?: string; conversationId?: string }) ${trustedChatHelperBodies.assertLegacyQueuedMessageAuthority}
  async function assertLegacyChatConversationIdAuthority(tx: any, conversationId: string) ${trustedChatHelperBodies.assertLegacyChatConversationIdAuthority}
  return null;
}
`;

function chatAuthorityHelperFixture(t, headSource = chatAuthorityHelperHead) {
  const baseRoot = temporaryTree(t);
  const headRoot = temporaryTree(t);
  put(baseRoot, queueGuardHelperPath, queueGuardHelperBase);
  put(headRoot, queueGuardHelperPath, queueGuardHelperHead);
  put(baseRoot, chatAuthorityHelperPath, chatAuthorityHelperBase);
  put(headRoot, chatAuthorityHelperPath, headSource);
  const base = buildInventory(baseRoot);
  const headWithoutRecords = buildInventory(headRoot);
  const queueBaseHash = base.source_manifest.find((entry) => entry.path === queueGuardHelperPath).sha256;
  const queueHeadHash = headWithoutRecords.source_manifest.find((entry) => entry.path === queueGuardHelperPath).sha256;
  const helperStartLine = queueGuardHelperHead.slice(0, queueGuardHelperHead.indexOf("export async function lockLegacyNativeChatQueueTarget")).split("\n").length;
  const rawHelperSurfaces = headWithoutRecords.structural_surfaces.filter((surface) => surface.source === queueGuardHelperPath
    && ["database_call_candidate", "database_write_candidate"].includes(surface.type)
    && surface.method === "execute" && surface.line >= helperStartLine)
    .map((surface) => ({ type: surface.type, signature: surface.signature, line: surface.line }));
  const queueHelper = {
    id: "native-chat-authority-helper:raw",
    path: queueGuardHelperPath,
    base_sha256: queueBaseHash,
    head_sha256: queueHeadHash,
    change_kind: "native_chat_queue_guard_helper",
    helper_name: "lockLegacyNativeChatQueueTarget",
    semantic_operation: "chat.queue.mutation-fence",
    head_surfaces: rawHelperSurfaces,
    rust_authority: "native::native_chat::admission",
    compatibility_boundary: "This exact raw helper serializes legacy queue operations with Rust admission.",
    retirement_criterion: "Remove after legacy Node chat mutation paths are retired.",
    reviewer: "maintainer@example.test",
    review_reference: "Reviewed exact helper source hashes",
    review_status: "reviewed",
  };
  const chatsBaseHash = base.source_manifest.find((entry) => entry.path === chatAuthorityHelperPath).sha256;
  const chatsHeadHash = headWithoutRecords.source_manifest.find((entry) => entry.path === chatAuthorityHelperPath).sha256;
  const selectForHelper = (table, helperName) => {
    const start = chatAuthorityHelperHead.indexOf(`async function ${helperName}(`);
    assert.notEqual(start, -1, `${helperName} must exist in the fixture`);
    const followingHelper = chatAuthorityHelperHead.indexOf("  async function ", start + 1);
    const end = followingHelper < 0 ? chatAuthorityHelperHead.indexOf("  return null;", start) : followingHelper;
    const startLine = chatAuthorityHelperHead.slice(0, start).split("\n").length;
    const endLine = chatAuthorityHelperHead.slice(0, end).split("\n").length;
    const matches = headWithoutRecords.structural_surfaces.filter((surface) => surface.source === chatAuthorityHelperPath
      && surface.type === "database_call_candidate" && surface.method === "select"
      && surface.signature.includes(table) && surface.line >= startLine && surface.line < endLine);
    return matches.map((surface) => ({ type: surface.type, signature: surface.signature, line: surface.line }));
  };
  const conversationHelper = {
    id: "native-chat-authority-helper:conversation",
    path: chatAuthorityHelperPath,
    base_sha256: chatsBaseHash,
    head_sha256: chatsHeadHash,
    change_kind: "native_chat_conversation_authority_helper",
    semantic_operation: "chat.queue.mutation-fence",
    helper_name: "assertLegacyChatConversationAuthority",
    head_surfaces: [],
    queue_helper_id: queueHelper.id,
    rust_authority: "native::native_chat::admission",
    compatibility_boundary: "This helper delegates the exact scoped target decision to the reviewed queue fence.",
    retirement_criterion: "Remove after legacy Node chat mutation paths are retired.",
    reviewer: "maintainer@example.test",
    review_reference: "Reviewed exact helper source hashes",
    review_status: "reviewed",
  };
  const generationHelper = {
    id: "native-chat-authority-helper:generation",
    path: chatAuthorityHelperPath,
    base_sha256: chatsBaseHash,
    head_sha256: chatsHeadHash,
    change_kind: "native_chat_generation_hint_helper",
    semantic_operation: "chat.queue.mutation-fence",
    helper_name: "assertLegacyChatGenerationAuthority",
    head_surfaces: selectForHelper("chatGenerations", "assertLegacyChatGenerationAuthority"),
    conversation_helper_id: conversationHelper.id,
    rust_authority: "native::native_chat::admission",
    compatibility_boundary: "This exact org-scoped hint resolves a generation to its conversation before the reviewed conversation fence.",
    retirement_criterion: "Remove after legacy Node chat mutation paths are retired.",
    reviewer: "maintainer@example.test",
    review_reference: "Reviewed exact helper source hashes",
    review_status: "reviewed",
  };
  const queuedMessageHelper = {
    id: "native-chat-authority-helper:queued-message",
    path: chatAuthorityHelperPath,
    base_sha256: chatsBaseHash,
    head_sha256: chatsHeadHash,
    change_kind: "native_chat_queued_message_hint_helper",
    semantic_operation: "chat.queue.mutation-fence",
    helper_name: "assertLegacyQueuedMessageAuthority",
    head_surfaces: selectForHelper("chatQueuedMessages", "assertLegacyQueuedMessageAuthority"),
    conversation_helper_id: conversationHelper.id,
    rust_authority: "native::native_chat::admission",
    compatibility_boundary: "This item hint scopes the exact queue row before the reviewed conversation fence.",
    retirement_criterion: "Remove after legacy Node chat mutation paths are retired.",
  };
  const conversationIdHelper = {
    id: "native-chat-authority-helper:conversation-id",
    path: chatAuthorityHelperPath,
    base_sha256: chatsBaseHash,
    head_sha256: chatsHeadHash,
    change_kind: "native_chat_conversation_id_hint_helper",
    semantic_operation: "chat.queue.mutation-fence",
    helper_name: "assertLegacyChatConversationIdAuthority",
    head_surfaces: selectForHelper("chatConversations", "assertLegacyChatConversationIdAuthority"),
    conversation_helper_id: conversationHelper.id,
    rust_authority: "native::native_chat::admission",
    compatibility_boundary: "This conversation-id hint resolves the organization before the reviewed conversation fence.",
    retirement_criterion: "Remove after legacy Node chat mutation paths are retired.",
  };
  const nodeRecords = [
    boundaryRecord(queueGuardHelperPath, queueBaseHash, queueHeadHash),
    boundaryRecord(chatAuthorityHelperPath, chatsBaseHash, chatsHeadHash),
  ];
  const records = [queueHelper, conversationHelper, generationHelper, queuedMessageHelper, conversationIdHelper];
  const head = buildInventory(headRoot, nodeRecords, undefined, records);
  return { baseRoot, headRoot, base, head, records,
    result: compareInventories(base, head, contentsFor(baseRoot, base), contentsFor(headRoot, head)) };
}

function compareChatAuthorityHelperFixture(fixture) {
  return compareInventories(
    fixture.base,
    fixture.head,
    contentsFor(fixture.baseRoot, fixture.base),
    contentsFor(fixture.headRoot, fixture.head),
  );
}

test("legacy Native Chat helper chain pins the exact scoped hint and reviewed target fence", (t) => {
  const fixture = chatAuthorityHelperFixture(t);
  assert.deepEqual(fixture.result.failures, []);

  const unscoped = chatAuthorityHelperHead.replace(
    `      .where(and(
        eq(chatGenerations.orgId, orgId),
        eq(chatGenerations.id, generationId),
      ))`,
    `      .where(eq(chatGenerations.id, generationId))`,
  );
  assert.notEqual(unscoped, chatAuthorityHelperHead);
  const unscopedResult = chatAuthorityHelperFixture(t, unscoped).result;
  assert(unscopedResult.failures.some((failure) => failure.includes("statically trusted exact-source digest")));

  const broadened = chatAuthorityHelperHead.replace(
    `      .where(and(
        eq(chatGenerations.orgId, orgId),
        eq(chatGenerations.id, generationId),
      ))`,
    `      .where(or(
        eq(chatGenerations.orgId, orgId),
        eq(chatGenerations.id, generationId),
      ))`,
  );
  assert.notEqual(broadened, chatAuthorityHelperHead);
  const broadenedResult = chatAuthorityHelperFixture(t, broadened).result;
  assert(broadenedResult.failures.some((failure) => failure.includes("statically trusted exact-source digest")));

  const extraRead = chatAuthorityHelperHead.replace(
    "    if (hint) await assertLegacyChatConversationAuthority(tx, hint.orgId, hint.conversationId);",
    `    await tx.select({ id: chatGenerations.id }).from(chatGenerations).where(and(
      eq(chatGenerations.orgId, orgId), eq(chatGenerations.conversationId, conversationId),
    ));
    if (hint) await assertLegacyChatConversationAuthority(tx, hint.orgId, hint.conversationId);`,
  );
  assert.notEqual(extraRead, chatAuthorityHelperHead);
  const extraReadResult = chatAuthorityHelperFixture(t, extraRead).result;
  assert(extraReadResult.failures.some((failure) => failure.includes("unmatched")));

  const wrongLink = chatAuthorityHelperFixture(t);
  const generationRecord = wrongLink.head.reviewed_legacy_fence_changes.find((record) =>
    record.change_kind === "native_chat_generation_hint_helper");
  generationRecord.conversation_helper_id = "unreviewed-helper";
  const wrongLinkResult = compareChatAuthorityHelperFixture(wrongLink);
  assert(wrongLinkResult.failures.some((failure) => failure.includes("exact conversation authority helper record")));

  const wrongRawLink = chatAuthorityHelperFixture(t);
  const conversationRecord = wrongRawLink.head.reviewed_legacy_fence_changes.find((record) =>
    record.change_kind === "native_chat_conversation_authority_helper");
  conversationRecord.queue_helper_id = "unreviewed-raw-fence";
  const wrongRawLinkResult = compareChatAuthorityHelperFixture(wrongRawLink);
  assert(wrongRawLinkResult.failures.some((failure) => failure.includes("exact raw queue fence record")));

  const broadQueuedHint = chatAuthorityHelperHead.replace(
    "expected?.orgId ? eq(chatQueuedMessages.orgId, expected.orgId) : undefined,",
    "undefined,",
  );
  const broadQueuedResult = chatAuthorityHelperFixture(t, broadQueuedHint).result;
  assert(broadQueuedResult.failures.some((failure) => failure.includes("statically trusted exact-source digest")));

  const unscopedConversationId = chatAuthorityHelperHead.replace(
    ".where(eq(chatConversations.id, conversationId))",
    ".where(or(eq(chatConversations.id, conversationId), eq(chatConversations.orgId, orgId)))",
  );
  const unscopedConversationResult = chatAuthorityHelperFixture(t, unscopedConversationId).result;
  assert(unscopedConversationResult.failures.some((failure) => failure.includes("statically trusted exact-source digest")));
});

test("trusted helper semantics come from checker-pinned digests, not record review metadata", (t) => {
  const fixture = chatAuthorityHelperFixture(t);
  const records = structuredClone(fixture.head.reviewed_legacy_fence_changes);
  const metadataFree = structuredClone(records);
  for (const entry of metadataFree) {
    delete entry.reviewer;
    delete entry.review_reference;
    delete entry.review_status;
  }
  const metadataFreeHead = buildInventory(fixture.headRoot, fixture.head.reviewed_node_changes, undefined, metadataFree);
  assert.deepEqual(compareInventories(
    fixture.base, metadataFreeHead,
    contentsFor(fixture.baseRoot, fixture.base), contentsFor(fixture.headRoot, metadataFreeHead),
  ).failures, []);

  const rawRecord = records.find((entry) => entry.change_kind === "native_chat_queue_guard_helper");
  rawRecord.reviewer = "unverified text";
  rawRecord.review_reference = "not an authenticated receipt";
  rawRecord.review_status = "reviewed";
  rawRecord.helper_body_sha256 = sha256("attacker supplied value");
  const unsupported = buildInventory(fixture.headRoot, fixture.head.reviewed_node_changes, undefined, records);
  assert(compareInventories(
    fixture.base, unsupported, contentsFor(fixture.baseRoot, fixture.base), contentsFor(fixture.headRoot, unsupported),
  ).failures.some((failure) => failure.includes("unsupported record field helper_body_sha256")));

  delete rawRecord.helper_body_sha256;
  const attackerBody = queueGuardHelperHead.replace(
    "return row.native_owned ? \"native_owned\" : \"available\";",
    "return \"available\";",
  );
  put(fixture.headRoot, queueGuardHelperPath, attackerBody);
  rawRecord.head_sha256 = sha256(attackerBody);
  const nodeRecords = structuredClone(fixture.head.reviewed_node_changes).map((entry) => entry.path === queueGuardHelperPath
    ? { ...entry, head_sha256: sha256(attackerBody) }
    : entry);
  const mutatedInventory = buildInventory(fixture.headRoot, nodeRecords, undefined, records);
  const result = compareInventories(
    fixture.base,
    mutatedInventory,
    contentsFor(fixture.baseRoot, fixture.base),
    contentsFor(fixture.headRoot, mutatedInventory),
  );
  assert(result.failures.some((failure) => failure.includes("statically trusted exact-source digest")));
});

const SESSION_ADMISSION_ID = "rust-native-session-proof-v1";
const IDENTITY_ADMISSION_ID = "rust-native-identity-proof-v1";
const PROJECT_READS_ADMISSION_ID = "rust-native-project-reads-router-v1";
const GOAL_WRITES_ADMISSION_ID = "rust-native-goal-writes-router-v1";
const ISSUE_APPROVAL_READS_ADMISSION_ID = "rust-native-issue-approval-reads-router-v1";
const APPROVAL_READS_ADMISSION_ID = "rust-native-approval-reads-router-v1";
const CLI_AUTH_ADMISSION_ID = "rust-native-cli-auth-router-v1";
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

function identityAdmissionAppSource({ mount = true, mountAfterParser = false, extra = "", emailFence = false, fenceExpression, fenceGuard = "opts.rustPublicIngress" } = {}) {
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
  const fenceHandler = fenceExpression ?? '(req, res, next) => { if (isNativeEmailAuthRequest(req.method, req.originalUrl)) { res.status(404).json({ error: "API route not found" }); return; } next(); }';
  const emailAuthFence = emailFence ? `if (${fenceGuard}) {
  app.use(${fenceHandler});
}
` : "";
  return `import { nativeSessionAssertionMiddleware } from "../auth/native-session-assertion.js";
const app = express();
app.use(async (req, res, next) => {
  if (await workspacePreview.handlePreviewHostRequest(req, res)) return;
  next();
});
app.use("/workspace-preview", (_req, res) => res.status(404).send("Not found"));
${orderedBody}${emailAuthFence}app.use(${TRUSTED_TRANSPORT_ADMISSIONS[IDENTITY_ADMISSION_ID].existing_mount_replacement[mount ? "after" : "before"]},);
app.all("/api/auth/*authPath", opts.betterAuthHandler);
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
  const headSource = options.headSource ?? identityAdmissionAppSource({ ...options.appOptions, emailFence: options.emailFence });
  const factorySource = options.factorySource ?? identityAdmissionFixtureFactory;
  const baseIdentitySource = identityAdmissionAppSource();
  const fencedIdentitySource = identityAdmissionAppSource({ emailFence: true });
  const trustedPolicy = {
    ...TRUSTED_TRANSPORT_ADMISSIONS[IDENTITY_ADMISSION_ID],
    source_sha256: sha256(baseIdentitySource),
    conditional_source_variants: [{
      source_sha256: options.emailFenceHash ?? sha256(fencedIdentitySource),
      additional_mounts: [{
        expression: '(req, res, next) => { if (isNativeEmailAuthRequest(req.method, req.originalUrl)) { res.status(404).json({ error: "API route not found" }); return; } next(); }',
        guard: "opts.rustPublicIngress",
        order_before: 'app.all("/api/auth/*authPath", opts.betterAuthHandler)',
      }],
    }],
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
  if (options.extraSourcePath) put(headRoot, options.extraSourcePath, options.extraSource ?? "");
  const admissionRecord = identityAdmissionReviewRecord(trustedPolicy, headSource, options.recordOverrides);
  const head = buildInventory(headRoot, options.omitNodeRecord ? [] : nodeRecords, options.omitAdmissionRecord ? [] : [admissionRecord]);
  const result = compareInventoriesWithTransportPolicyForTests(
    base,
    head,
    contentsFor(baseRoot, base),
    contentsFor(headRoot, head),
    trustedPolicy,
  );
  return { result, base, head, trustedPolicy, admissionRecord };
}

function publicOwnerMountSource({
  projectExpression = TRUSTED_TRANSPORT_ADMISSIONS[PROJECT_READS_ADMISSION_ID].mount_expression,
  cliExpression = TRUSTED_TRANSPORT_ADMISSIONS[CLI_AUTH_ADMISSION_ID].mount_expression,
  goalExpression = null,
  issueExpression = null,
  approvalExpression = null,
  includeGoalAnchors = goalExpression !== null,
  includeIssueApprovalAnchors = false,
  duplicateProject = false,
  duplicateCli = false,
  duplicateGoal = false,
  duplicateIssue = false,
  duplicateApproval = false,
  moveProjectAfterAnchor = false,
  moveCliBeforeAnchor = false,
  moveGoalBeforeAnchor = false,
  moveGoalAfterAnchor = false,
  moveIssueAfterAnchor = false,
  moveApprovalBeforeGoal = false,
  moveApprovalAfterAnchor = false,
  extra = "",
} = {}) {
  const goalPolicy = TRUSTED_TRANSPORT_ADMISSIONS[GOAL_WRITES_ADMISSION_ID];
  const issuePolicy = TRUSTED_TRANSPORT_ADMISSIONS[ISSUE_APPROVAL_READS_ADMISSION_ID];
  const projectMount = `api.use(${projectExpression});\n`;
  const cliMount = `api.use(${cliExpression});\n`;
  const goalMount = goalExpression ? `api.use(${goalExpression});\n` : "";
  const issueMount = `api.use(${issueExpression ?? "issueRoutes(db, opts.storageService, rustFoundationBridge)"});\n`;
  const approvalMount = `api.use(${approvalExpression ?? "approvalRoutes(db, rustFoundationBridge)"});\n`;
  const projectBeforeAnchor = `api.use(assetRoutes(db, opts.storageService));\n`;
  const projectAfterAnchor = `api.use(appBuilderRoutes(db, { onAppChanged: (orgId) => pluginProjectionService.syncLocalApps(orgId), }));\n`;
  const cliBeforeAnchor = `api.use(rudderPluginRoutes(db, pluginMcpOptions));\n`;
  const goalBeforeAnchor = `api.use(${goalPolicy.order_after_expression});\n`;
  const goalAfterAnchor = `api.use(${goalPolicy.order_before_expression});\n`;
  const issueBeforeAnchor = `api.use(${issuePolicy.order_after_expression});\n`;
  const issueAfterAnchor = `api.use(${issuePolicy.order_before_expression});\n`;
  const initialProject = moveProjectAfterAnchor
    ? `${projectBeforeAnchor}${projectAfterAnchor}${projectMount}${duplicateProject ? projectMount : ""}`
    : `${projectBeforeAnchor}${projectMount}${duplicateProject ? projectMount : ""}${projectAfterAnchor}`;
  const cli = moveCliBeforeAnchor
    ? `${cliMount}${duplicateCli ? cliMount : ""}${cliBeforeAnchor}`
    : `${cliBeforeAnchor}${cliMount}${duplicateCli ? cliMount : ""}`;
  const goalMounts = `${goalMount}${duplicateGoal ? goalMount : ""}`;
  const approvalMounts = includeIssueApprovalAnchors ? `${approvalMount}${duplicateApproval ? approvalMount : ""}` : "";
  const goal = !includeGoalAnchors ? ""
    : moveGoalBeforeAnchor ? `${goalMounts}${approvalMounts}${goalBeforeAnchor}${goalAfterAnchor}`
      : moveGoalAfterAnchor ? `${goalBeforeAnchor}${goalAfterAnchor}${goalMounts}${approvalMounts}`
        : moveApprovalBeforeGoal ? `${goalBeforeAnchor}${approvalMounts}${goalMounts}${goalAfterAnchor}`
          : moveApprovalAfterAnchor ? `${goalBeforeAnchor}${goalMounts}${goalAfterAnchor}${approvalMounts}`
            : `${goalBeforeAnchor}${goalMounts}${approvalMounts}${goalAfterAnchor}`;
  const issueMounts = `${issueMount}${duplicateIssue ? issueMount : ""}`;
  const issue = !includeIssueApprovalAnchors ? ""
    : moveIssueAfterAnchor
      ? `${issueBeforeAnchor}${issueAfterAnchor}${issueMounts}`
      : `${issueBeforeAnchor}${issueMounts}${issueAfterAnchor}`;
  return `function register(api, opts) {
${initialProject}${issue}${goal}${cli}${extra}return api;
}
`;
}

function publicOwnerMountReviewRecord(policy, source) {
  return {
    id: policy.id,
    mount_source_path: policy.source_path,
    mount_source_sha256: sha256(source),
    mount_receiver: policy.receiver,
    mount_expression: policy.mount_expression,
    mount_guard: policy.mount_guard,
    order_after: policy.order_after,
    order_before: policy.order_before,
    rust_proof_owner: policy.rust_proof_owner,
    compatibility_boundary: "Node passes only the exact public-ingress mode option to the existing router factory; this record admits no new Node business handler or database writer, and separate legacy compatibility paths remain migration debt.",
    retirement_criterion: "Remove this router admission when the legacy router no longer serves any first-party compatibility paths and the corresponding Rust routes are the sole supported owner.",
    reviewer: "policy-test-reviewer@example.test",
    review_reference: "Fixed trusted compatibility-mount policy fixture",
    review_status: "reviewed",
  };
}

function comparePublicOwnerMountFixture(t, options = {}) {
  const baseRoot = temporaryTree(t);
  const headRoot = temporaryTree(t);
  const sourcePath = "server/src/bootstrap/register-api-routes.ts";
  const projectPolicy = TRUSTED_TRANSPORT_ADMISSIONS[PROJECT_READS_ADMISSION_ID];
  const goalPolicy = TRUSTED_TRANSPORT_ADMISSIONS[GOAL_WRITES_ADMISSION_ID];
  const issuePolicy = TRUSTED_TRANSPORT_ADMISSIONS[ISSUE_APPROVAL_READS_ADMISSION_ID];
  const approvalPolicy = TRUSTED_TRANSPORT_ADMISSIONS[APPROVAL_READS_ADMISSION_ID];
  const cliPolicy = TRUSTED_TRANSPORT_ADMISSIONS[CLI_AUTH_ADMISSION_ID];
  const baseSource = publicOwnerMountSource({
    projectExpression: "projectRoutes(db, rustFoundationBridge)",
    cliExpression: "accessRoutes(db, { deploymentMode: opts.deploymentMode, deploymentExposure: opts.deploymentExposure, bindHost: opts.bindHost, allowedHostnames: opts.allowedHostnames, })",
    goalExpression: options.includeGoalAdmission ? "goalRoutes(db, rustFoundationBridge)" : null,
    includeGoalAnchors: options.includeGoalAdmission,
    issueExpression: options.includeIssueApprovalAnchors ? "issueRoutes(db, opts.storageService, rustFoundationBridge)" : null,
    approvalExpression: options.includeIssueApprovalAnchors ? "approvalRoutes(db, rustFoundationBridge)" : null,
    includeIssueApprovalAnchors: options.includeIssueApprovalAnchors,
  });
  const headSource = options.headSource ?? publicOwnerMountSource({
    ...options,
    includeGoalAnchors: options.includeGoalAdmission,
    includeIssueApprovalAnchors: options.includeIssueApprovalAnchors,
  });
  put(baseRoot, sourcePath, baseSource);
  put(headRoot, sourcePath, headSource);
  const base = buildInventory(baseRoot);
  const nodeRecord = boundaryRecord(sourcePath, sha256(baseSource), sha256(headSource), {
    node_role: "transport_adapter",
    change_kind: "modified_node_compatibility",
  });
  const nodeRecords = [nodeRecord];
  if (options.extraSourcePath) {
    const extraSource = options.extraSource ?? "";
    put(headRoot, options.extraSourcePath, extraSource);
    nodeRecords.push(boundaryRecord(options.extraSourcePath, null, sha256(extraSource), {
      node_role: "transport_adapter",
      change_kind: "new_transport_adapter",
    }));
  }
  const admissionRecords = [
    publicOwnerMountReviewRecord(projectPolicy, headSource),
    publicOwnerMountReviewRecord(cliPolicy, headSource),
  ];
  if (options.includeGoalAdmission && !options.omitGoalAdmission) {
    admissionRecords.push(publicOwnerMountReviewRecord(goalPolicy, headSource));
  }
  if (options.includeIssueAdmission && !options.omitIssueAdmission) {
    admissionRecords.push(publicOwnerMountReviewRecord(issuePolicy, headSource));
  }
  if (options.includeApprovalAdmission && !options.omitApprovalAdmission) {
    admissionRecords.push(publicOwnerMountReviewRecord(approvalPolicy, headSource));
  }
  const head = buildInventory(headRoot, nodeRecords, admissionRecords);
  const result = compareProductionInventories(base, head, contentsFor(baseRoot, base), contentsFor(headRoot, head));
  return { result, base, head, baseSource, headSource };
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

test("an existing identity policy module accepts a reviewed retained-client record without inventing Rust ownership", (t) => {
  const baseRoot = temporaryTree(t);
  const headRoot = temporaryTree(t);
  const sourcePath = "desktop/src/identity-startup-policy.ts";
  const original = "export const bypassAllowed = false;\n";
  const changed = "export const bypassAllowed = true;\n";
  put(baseRoot, sourcePath, original);
  put(headRoot, sourcePath, changed);
  const base = buildInventory(baseRoot);
  const headWithoutRecord = buildInventory(headRoot);
  const missing = compareInventories(base, headWithoutRecord, contentsFor(baseRoot, base), contentsFor(headRoot, headWithoutRecord));
  assert(missing.failures.some((failure) => failure.includes("missing reviewed_node_changes record")));

  const head = buildInventory(headRoot, [retainedClientRecord(sourcePath, sha256(original), sha256(changed))]);
  const clientEntry = head.source_manifest.find((entry) => entry.path === sourcePath);
  assert.deepEqual(clientEntry?.families, ["electron_process_graph"]);
  const accepted = compareInventories(base, head, contentsFor(baseRoot, base), contentsFor(headRoot, head));
  assert.deepEqual(accepted.failures, []);
  assert.deepEqual(accepted.changed_files, [sourcePath]);
});

test("retained-client reviews keep hash, reviewer, and client-responsibility gates", (t) => {
  const baseRoot = temporaryTree(t);
  const headRoot = temporaryTree(t);
  const sourcePath = "desktop/src/identity-safe-storage-policy.ts";
  const original = "export const storageMode = 'native';\n";
  const changed = "export const storageMode = 'fixture';\n";
  put(baseRoot, sourcePath, original);
  put(headRoot, sourcePath, changed);
  const base = buildInventory(baseRoot);
  const baseHash = sha256(original);
  const headHash = sha256(changed);
  const compareRecord = (overrides) => {
    const head = buildInventory(headRoot, [retainedClientRecord(sourcePath, baseHash, headHash, overrides)]);
    return compareInventories(base, head, contentsFor(baseRoot, base), contentsFor(headRoot, head));
  };

  assert(compareRecord({ head_sha256: "0".repeat(64) }).failures.some((failure) => failure.includes("head_sha256 does not match")));
  assert(compareRecord({ review_status: "pending" }).failures.some((failure) => failure.includes('review_status must be "reviewed"')));
  assert(compareRecord({ reviewer: " " }).failures.some((failure) => failure.includes("reviewer is required")));
  assert(compareRecord({ client_responsibility: "" }).failures.some((failure) => failure.includes("client_responsibility is required")));
  assert(compareRecord({ rust_authority: "native::server_foundation::local_account_auth" }).failures.some((failure) => failure.includes("must not claim rust_authority")));
  assert(compareRecord({ associated_backend_authority: "" }).failures.some((failure) => failure.includes("associated_backend_authority must be a nonempty")));
});

test("retained-client role cannot masquerade as backend or escape its exact existing path scope", (t) => {
  const compareChangedSource = (sourcePath, record) => {
    const baseRoot = temporaryTree(t);
    const headRoot = temporaryTree(t);
    const original = "export const mode = 'old';\n";
    const changed = "export const mode = 'new';\n";
    put(baseRoot, sourcePath, original);
    put(headRoot, sourcePath, changed);
    const base = buildInventory(baseRoot);
    const head = buildInventory(headRoot, [record(sourcePath, sha256(original), sha256(changed))]);
    return compareInventories(base, head, contentsFor(baseRoot, base), contentsFor(headRoot, head));
  };

  const backend = compareChangedSource("server/src/services/account-auth.ts", (pathValue, baseHash, headHash) =>
    boundaryRecord(pathValue, baseHash, headHash, {
      change_kind: "modified_retained_client",
      node_role: "retained_client",
      rust_authority: undefined,
      client_responsibility: "client policy",
      associated_backend_authority: "native::server_foundation::local_account_auth",
    }));
  assert(backend.failures.some((failure) => failure.includes('change_kind must be "modified_node_compatibility"')));
  assert(backend.failures.some((failure) => failure.includes("rust_authority is required")));
  assert(backend.failures.some((failure) => failure.includes('node_role must be "compatibility_adapter" or "transport_adapter"')));

  const otherDesktopClient = compareChangedSource("desktop/src/other-client.ts", retainedClientRecord);
  assert(otherDesktopClient.failures.some((failure) => failure.includes('change_kind must be "modified_node_compatibility"')));
  assert(otherDesktopClient.failures.some((failure) => failure.includes('node_role must be "compatibility_adapter" or "transport_adapter"')));
});

test("new Electron source and new runtime admissions remain forbidden under retained-client review", (t) => {
  const baseRoot = temporaryTree(t);
  const headRoot = temporaryTree(t);
  const newPath = "desktop/src/new-identity-runtime.ts";
  const content = "export const client = true;\n";
  const base = buildInventory(baseRoot);
  put(headRoot, newPath, content);
  const head = buildInventory(headRoot, [retainedClientRecord(newPath, null, sha256(content))]);
  const added = compareInventories(base, head, contentsFor(baseRoot, base), contentsFor(headRoot, head));
  assert(added.failures.some((failure) => failure.includes("new production Node source is forbidden by the ratchet")));

  const routeBaseRoot = temporaryTree(t);
  const routeHeadRoot = temporaryTree(t);
  const sourcePath = "server/src/routes/account-auth.ts";
  const original = "export const routeMode = 'legacy';\n";
  const changed = `export const routeMode = 'new';\nconst router = Router();\nrouter.post("/api/new-client-runtime", handler);\n`;
  put(routeBaseRoot, sourcePath, original);
  put(routeHeadRoot, sourcePath, changed);
  const routeBase = buildInventory(routeBaseRoot);
  const routeHead = buildInventory(routeHeadRoot, [retainedClientRecord(sourcePath, sha256(original), sha256(changed))]);
  const routeChange = compareInventories(routeBase, routeHead, contentsFor(routeBaseRoot, routeBase), contentsFor(routeHeadRoot, routeHead));
  assert(routeChange.failures.some((failure) => failure.includes("new Node authority surface is forbidden by the ratchet")));
});

test("retained-client review records are stale when their source is unchanged", (t) => {
  const root = temporaryTree(t);
  const sourcePath = "desktop/src/identity-runtime.ts";
  const content = "export const runtime = true;\n";
  put(root, sourcePath, content);
  const base = buildInventory(root);
  const head = buildInventory(root, [retainedClientRecord(sourcePath, sha256(content), sha256(content))]);
  const result = compareInventories(base, head, contentsFor(root, base), contentsFor(root, head));
  assert(result.failures.some((failure) => failure.includes(`stale or unrelated reviewed_node_changes record: ${sourcePath}`)));
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

test("only the two hash-pinned packages/db Rust process transports are admitted", (t) => {
  const baseRoot = temporaryTree(t);
  const headRoot = temporaryTree(t);
  const paths = Object.keys(TRUSTED_NODE_TRANSPORT_SOURCES).sort();
  assert.deepEqual(paths, [
    "packages/db/src/migration-operator.ts",
    "packages/db/src/postgres-owner.ts",
  ]);

  const records = [];
  for (const sourcePath of paths) {
    const policy = TRUSTED_NODE_TRANSPORT_SOURCES[sourcePath];
    const source = fs.readFileSync(path.join(REPOSITORY_ROOT, sourcePath), "utf8");
    assert.equal(sha256(source), policy.source_sha256, `${sourcePath} must match the static source pin`);
    put(headRoot, sourcePath, source);
    records.push(boundaryRecord(sourcePath, null, policy.source_sha256, {
      transport_admission_id: policy.id,
      rust_authority: policy.rust_authority,
      allowed_node_duties: [...policy.allowed_node_duties],
      prohibited_node_duties: [...policy.prohibited_node_duties],
      compatibility_boundary: policy.compatibility_boundary,
      retirement_criterion: policy.retirement_criterion,
    }));
  }

  const base = buildInventory(baseRoot);
  const head = buildInventory(headRoot, records);
  const admitted = compareProductionInventories(base, head, contentsFor(baseRoot, base), contentsFor(headRoot, head));
  assert.deepEqual(admitted.failures, []);

  const [pinnedRecord] = structuredClone(records);
  const driftedPath = pinnedRecord.path;
  const driftedSource = `${fs.readFileSync(path.join(REPOSITORY_ROOT, driftedPath), "utf8")}\n// unreviewed drift\n`;
  put(headRoot, driftedPath, driftedSource);
  pinnedRecord.head_sha256 = sha256(driftedSource);
  const driftedHead = buildInventory(headRoot, [pinnedRecord, records[1]]);
  const drifted = compareProductionInventories(base, driftedHead, contentsFor(baseRoot, base), contentsFor(headRoot, driftedHead));
  assert(drifted.failures.some((failure) => failure.includes("source hash does not match the statically trusted transport-source digest")));

  const unrelatedPath = "packages/db/src/unreviewed-node-bridge.ts";
  const unrelatedSource = "export const bridge = true;\n";
  put(headRoot, unrelatedPath, unrelatedSource);
  const unrelatedRecord = boundaryRecord(unrelatedPath, null, sha256(unrelatedSource));
  const unrelatedHead = buildInventory(headRoot, [pinnedRecord, records[1], unrelatedRecord]);
  const unrelated = compareProductionInventories(base, unrelatedHead, contentsFor(baseRoot, base), contentsFor(headRoot, unrelatedHead));
  assert(unrelated.failures.some((failure) => failure.includes(`new production Node source is forbidden by the ratchet: ${unrelatedPath}`)));
});

test("only the exact migration-preflight child escalation timer is admitted", (t) => {
  const sourcePath = "server/src/services/migration-preflight.ts";
  const policy = TRUSTED_TRANSPORT_SURFACES[sourcePath];
  assert.deepEqual(Object.keys(TRUSTED_TRANSPORT_SURFACES), [sourcePath]);
  assert.equal(policy.signatures.length, 1);
  assert.equal(policy.owner, `${sourcePath}::runMigrationProcess`);

  const original = fs.readFileSync(path.join(REPOSITORY_ROOT, sourcePath), "utf8");
  assert.equal(sha256(original), policy.source_sha256, "candidate source must match the exact helper-bound source pin");
  const pendingFailureGuard = `if (pendingFailure) {\n          pendingFailure = new MigrationPreflightAdapterError(\n            "process",\n            "cancellation_cleanup_unconfirmed",\n          );\n        }\n        `;
  assert(original.includes(pendingFailureGuard), "candidate source must contain the reviewed child escalation guard");
  const baseSource = original.replace(pendingFailureGuard, "");
  assert.notEqual(baseSource, original);

  const baseRoot = temporaryTree(t);
  const headRoot = temporaryTree(t);
  put(baseRoot, sourcePath, baseSource);
  put(headRoot, sourcePath, original);
  const base = buildInventory(baseRoot);
  const head = buildInventory(headRoot);
  const signature = policy.signatures[0];
  const record = boundaryRecord(
    sourcePath,
    base.source_manifest.find((entry) => entry.path === sourcePath).sha256,
    head.source_manifest.find((entry) => entry.path === sourcePath).sha256,
    { node_role: "transport_adapter", transport_surface_owner: policy.owner, allowed_transport_surfaces: [signature] },
  );
  const reviewedHead = buildInventory(headRoot, [record]);
  const reviewed = compareProductionInventories(base, reviewedHead, contentsFor(baseRoot, base), contentsFor(headRoot, reviewedHead));
  assert.deepEqual(reviewed.failures, []);

  const wrongOwnerHead = buildInventory(headRoot, [
    boundaryRecord(
      sourcePath,
      base.source_manifest.find((entry) => entry.path === sourcePath).sha256,
      head.source_manifest.find((entry) => entry.path === sourcePath).sha256,
      { node_role: "transport_adapter", transport_surface_owner: `${sourcePath}::unrelatedWorker`, allowed_transport_surfaces: [signature] },
    ),
  ]);
  const wrongOwner = compareProductionInventories(base, wrongOwnerHead, contentsFor(baseRoot, base), contentsFor(headRoot, wrongOwnerHead));
  assert(wrongOwner.failures.some((failure) => failure.includes("transport_surface_owner does not match the exact statically trusted adapter helper")));

  const fabricatedTimerSignature = `${sourcePath}|worker-schedule-candidate|setTimeout|() => worker.poll()`;
  const fabricatedTimerHead = buildInventory(headRoot, [
    boundaryRecord(
      sourcePath,
      base.source_manifest.find((entry) => entry.path === sourcePath).sha256,
      head.source_manifest.find((entry) => entry.path === sourcePath).sha256,
      { node_role: "transport_adapter", transport_surface_owner: policy.owner, allowed_transport_surfaces: [signature, fabricatedTimerSignature] },
    ),
  ]);
  const fabricatedTimer = compareProductionInventories(base, fabricatedTimerHead, contentsFor(baseRoot, base), contentsFor(headRoot, fabricatedTimerHead));
  assert(fabricatedTimer.failures.some((failure) => failure.includes("transport surface is not statically trusted for this exact source path")));

  const renamedHelperSource = original.replace(
    "export async function runMigrationProcess(",
    "export async function unrelatedWorker(",
  );
  assert.notEqual(renamedHelperSource, original);
  put(headRoot, sourcePath, renamedHelperSource);
  const renamedHelperHead = buildInventory(headRoot, [
    boundaryRecord(
      sourcePath,
      base.source_manifest.find((entry) => entry.path === sourcePath).sha256,
      sha256(renamedHelperSource),
      { node_role: "transport_adapter", transport_surface_owner: policy.owner, allowed_transport_surfaces: [signature] },
    ),
  ]);
  const renamedHelper = compareProductionInventories(base, renamedHelperHead, contentsFor(baseRoot, base), contentsFor(headRoot, renamedHelperHead));
  assert(renamedHelper.failures.some((failure) => failure.includes("source hash does not match the statically trusted transport-helper digest")));

  const unrelatedSource = `${original}\nsetTimeout(() => worker.poll(), 25);\n`;
  put(headRoot, sourcePath, unrelatedSource);
  const unrelatedTimerSignature = scanSource(sourcePath, unrelatedSource).surfaces.find((surface) =>
    surface.type === "worker_schedule_candidate" && surface.expression.includes("worker.poll()"))?.signature;
  assert(unrelatedTimerSignature);
  const withUnrelatedTimer = buildInventory(headRoot, [
    boundaryRecord(
      sourcePath,
      base.source_manifest.find((entry) => entry.path === sourcePath).sha256,
      sha256(unrelatedSource),
      { node_role: "transport_adapter", transport_surface_owner: policy.owner, allowed_transport_surfaces: [signature, unrelatedTimerSignature] },
    ),
  ]);
  const unrelated = compareProductionInventories(base, withUnrelatedTimer, contentsFor(baseRoot, base), contentsFor(headRoot, withUnrelatedTimer));
  assert(unrelated.failures.some((failure) => failure.includes("source hash does not match the statically trusted transport-helper digest")));
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
  assert.deepEqual(identityPolicy.conditional_source_variants.map((variant) => variant.source_sha256), [
    "06ab8d223e65b879ea8d8d8b224f0880ef059b0377f285d3e68c369cf6981afb",
  ]);
  assert.deepEqual(identityPolicy.conditional_source_variants[0].additional_mounts, [{
    expression: '(req, res, next) => { if (isNativeEmailAuthRequest(req.method, req.originalUrl)) { res.status(404).json({ error: "API route not found" }); return; } next(); }',
    guard: "opts.rustPublicIngress",
    order_before: 'app.all("/api/auth/*authPath", opts.betterAuthHandler)',
  }]);

  const sessionPolicy = TRUSTED_TRANSPORT_ADMISSIONS[SESSION_ADMISSION_ID];
  assert.equal(sessionPolicy.factory_sha256, "f020323ee03bc0a8f38bb04d47b58b443afe07f93cefacdfc13cf8d46bebced5");
  assert.equal(sessionPolicy.mount_expression, "nativeSessionAssertionMiddleware({ key: opts.rustPublicIngress.sessionAuth.assertionKey, })");
  assert.deepEqual(Object.keys(TRUSTED_TRANSPORT_ADMISSIONS).sort(), [
    "rust-native-agent-core-handler-v1",
    "rust-native-agent-core-router-v1",
    APPROVAL_READS_ADMISSION_ID,
    CLI_AUTH_ADMISSION_ID,
    GOAL_WRITES_ADMISSION_ID,
    IDENTITY_ADMISSION_ID,
    ISSUE_APPROVAL_READS_ADMISSION_ID,
    PROJECT_READS_ADMISSION_ID,
    SESSION_ADMISSION_ID,
  ].sort());

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

test("trusted policy admits only the exact Rust CLI auth and Project reads router options", (t) => {
  const projectPolicy = TRUSTED_TRANSPORT_ADMISSIONS[PROJECT_READS_ADMISSION_ID];
  const cliPolicy = TRUSTED_TRANSPORT_ADMISSIONS[CLI_AUTH_ADMISSION_ID];
  assert.equal(projectPolicy.source_path, "server/src/bootstrap/register-api-routes.ts");
  assert.equal(projectPolicy.receiver, "api");
  assert.equal(projectPolicy.mount_expression, "projectRoutes(db, rustFoundationBridge, { nativeProjectReads: Boolean(opts.rustPublicIngress), })");
  assert.equal(projectPolicy.mount_guard, "Boolean(opts.rustPublicIngress)");
  assert.equal(projectPolicy.order_after_expression, "assetRoutes(db, opts.storageService)");
  assert.equal(projectPolicy.order_before_expression, "appBuilderRoutes(db, { onAppChanged: (orgId) => pluginProjectionService.syncLocalApps(orgId), })");
  assert.equal(projectPolicy.rust_proof_owner, "native/crates/server-foundation/src/public_ingress/project_reads.rs");
  assert.equal(cliPolicy.source_path, "server/src/bootstrap/register-api-routes.ts");
  assert.equal(cliPolicy.receiver, "api");
  assert.equal(cliPolicy.mount_expression, "accessRoutes(db, { deploymentMode: opts.deploymentMode, deploymentExposure: opts.deploymentExposure, bindHost: opts.bindHost, allowedHostnames: opts.allowedHostnames, nativeCliAuthOwner: Boolean(opts.rustPublicIngress), })");
  assert.equal(cliPolicy.mount_guard, "Boolean(opts.rustPublicIngress)");
  assert.equal(cliPolicy.order_after_expression, "rudderPluginRoutes(db, pluginMcpOptions)");
  assert.equal(cliPolicy.order_before_expression, "return api");
  assert.equal(cliPolicy.rust_proof_owner, "native/crates/server-foundation/src/public_ingress/cli_auth.rs");

  const accepted = comparePublicOwnerMountFixture(t);
  assert.deepEqual(accepted.result.failures, []);
  assert.deepEqual(accepted.result.allowed_transport_admissions.map((entry) => entry.id).sort(), [
    CLI_AUTH_ADMISSION_ID,
    PROJECT_READS_ADMISSION_ID,
  ].sort());
  for (const id of [CLI_AUTH_ADMISSION_ID, PROJECT_READS_ADMISSION_ID]) {
    assert.equal(accepted.head.structural_surfaces.filter((surface) => surface.transport_admission === id).length, 1);
  }
});

test("trusted policy admits only the exact Rust Goal writes router between its fixed anchors", (t) => {
  const goalPolicy = TRUSTED_TRANSPORT_ADMISSIONS[GOAL_WRITES_ADMISSION_ID];
  const goalExpression = goalPolicy.mount_expression;
  assert.equal(goalPolicy.source_path, "server/src/bootstrap/register-api-routes.ts");
  assert.equal(goalPolicy.receiver, "api");
  assert.equal(goalPolicy.mount_expression, "goalRoutes(db, rustFoundationBridge, { nativeGoalWrites: Boolean(opts.rustPublicIngress), })");
  assert.equal(goalPolicy.mount_guard, "Boolean(opts.rustPublicIngress)");
  assert.equal(goalPolicy.order_after_expression, "managedMcpConnectionRoutes(db, { deploymentMode: opts.deploymentMode, serverPort: opts.serverPort, authPublicBaseUrl: opts.authPublicBaseUrl, allowlists: opts.mcpDeploymentAllowlists ?? { httpOrigins: [], stdioCommands: [], stdioWorkingDirectories: [], stdioEnvironmentNames: [], }, hostEnv: opts.mcpHostEnv ?? process.env, })");
  assert.equal(goalPolicy.order_before_expression, "requestRoutes(db, rustFoundationBridge)");
  assert.equal(goalPolicy.order_before, "request_routes");
  assert.equal(goalPolicy.order_before_call, true);
  assert.equal(goalPolicy.order_after_call, true);
  assert.equal(goalPolicy.rust_proof_owner, "native/crates/server-foundation/src/public_ingress/goal_writes.rs");

  const accepted = comparePublicOwnerMountFixture(t, {
    includeGoalAdmission: true,
    goalExpression,
  });
  assert.deepEqual(accepted.result.failures, []);
  assert.equal(accepted.head.structural_surfaces.filter((surface) => surface.transport_admission === GOAL_WRITES_ADMISSION_ID).length, 1);
  assert(accepted.result.allowed_transport_admissions.some((entry) => entry.id === GOAL_WRITES_ADMISSION_ID));

  const missingRecord = comparePublicOwnerMountFixture(t, {
    includeGoalAdmission: true,
    goalExpression,
    omitGoalAdmission: true,
  });
  assert(missingRecord.result.failures.some((failure) => failure.includes(`${GOAL_WRITES_ADMISSION_ID}: missing reviewed_transport_admissions record`)));

  const wrongGuard = comparePublicOwnerMountFixture(t, {
    includeGoalAdmission: true,
    goalExpression: goalExpression.replace("Boolean(opts.rustPublicIngress)", "Boolean(opts.rustPublicIngress?.goalWrites)"),
  });
  assert(wrongGuard.result.failures.some((failure) => failure.includes("new Node authority surface is forbidden")));

  const reordered = comparePublicOwnerMountFixture(t, {
    includeGoalAdmission: true,
    goalExpression,
    moveGoalAfterAnchor: true,
  });
  assert(reordered.result.failures.some((failure) => failure.includes("native Goal writes router adapter must appear before its order-before anchor")));

  const duplicate = comparePublicOwnerMountFixture(t, {
    includeGoalAdmission: true,
    goalExpression,
    duplicateGoal: true,
  });
  assert(duplicate.result.failures.some((failure) => failure.includes(`${GOAL_WRITES_ADMISSION_ID}: trusted primary transport-admission mount must appear exactly once`)));
});

test("trusted policy admits only the exact Rust Issue and Approval reads mounts at fixed anchors", (t) => {
  const goalPolicy = TRUSTED_TRANSPORT_ADMISSIONS[GOAL_WRITES_ADMISSION_ID];
  const issuePolicy = TRUSTED_TRANSPORT_ADMISSIONS[ISSUE_APPROVAL_READS_ADMISSION_ID];
  const approvalPolicy = TRUSTED_TRANSPORT_ADMISSIONS[APPROVAL_READS_ADMISSION_ID];

  assert.equal(goalPolicy.order_before_expression, "requestRoutes(db, rustFoundationBridge)");
  assert.equal(issuePolicy.source_path, "server/src/bootstrap/register-api-routes.ts");
  assert.equal(issuePolicy.receiver, "api");
  assert.equal(issuePolicy.mount_expression, "issueRoutes(db, opts.storageService, rustFoundationBridge, { nativeApprovalReads: Boolean(opts.rustPublicIngress), })");
  assert.equal(issuePolicy.mount_guard, "Boolean(opts.rustPublicIngress)");
  assert.equal(issuePolicy.order_after, "product_analytics_routes");
  assert.equal(issuePolicy.order_before, "messenger_routes");
  assert.equal(issuePolicy.order_after_call, true);
  assert.equal(issuePolicy.order_before_call, true);
  assert.equal(issuePolicy.order_after_expression, "productAnalyticsRoutes(db)");
  assert.equal(issuePolicy.order_before_expression, "messengerRoutes(db, rustFoundationBridge)");
  assert.equal(issuePolicy.rust_proof_owner, "native/crates/server-foundation/src/public_ingress/approval_reads.rs");

  assert.equal(approvalPolicy.source_path, "server/src/bootstrap/register-api-routes.ts");
  assert.equal(approvalPolicy.receiver, "api");
  assert.equal(approvalPolicy.mount_expression, "approvalRoutes(db, rustFoundationBridge, { nativeApprovalReads: Boolean(opts.rustPublicIngress), })");
  assert.equal(approvalPolicy.mount_guard, "Boolean(opts.rustPublicIngress)");
  assert.equal(approvalPolicy.order_after, "goal_routes");
  assert.equal(approvalPolicy.order_before, "request_routes");
  assert.equal(approvalPolicy.order_after_call, true);
  assert.equal(approvalPolicy.order_before_call, true);
  assert.equal(approvalPolicy.order_after_expression, goalPolicy.mount_expression);
  assert.equal(approvalPolicy.order_before_expression, "requestRoutes(db, rustFoundationBridge)");
  assert.equal(approvalPolicy.rust_proof_owner, "native/crates/server-foundation/src/public_ingress/approval_reads.rs");

  const accepted = comparePublicOwnerMountFixture(t, {
    includeGoalAdmission: true,
    includeIssueApprovalAnchors: true,
    includeIssueAdmission: true,
    includeApprovalAdmission: true,
    goalExpression: goalPolicy.mount_expression,
    issueExpression: issuePolicy.mount_expression,
    approvalExpression: approvalPolicy.mount_expression,
  });
  assert.deepEqual(accepted.result.failures, []);
  for (const id of [GOAL_WRITES_ADMISSION_ID, ISSUE_APPROVAL_READS_ADMISSION_ID, APPROVAL_READS_ADMISSION_ID]) {
    assert.equal(accepted.head.structural_surfaces.filter((surface) => surface.transport_admission === id).length, 1);
    assert(accepted.result.allowed_transport_admissions.some((entry) => entry.id === id));
  }

  const missingIssueRecord = comparePublicOwnerMountFixture(t, {
    includeGoalAdmission: true, includeIssueApprovalAnchors: true, includeIssueAdmission: true,
    includeApprovalAdmission: true, goalExpression: goalPolicy.mount_expression,
    issueExpression: issuePolicy.mount_expression, approvalExpression: approvalPolicy.mount_expression,
    omitIssueAdmission: true,
  });
  assert(missingIssueRecord.result.failures.some((failure) => failure.includes(`${ISSUE_APPROVAL_READS_ADMISSION_ID}: missing reviewed_transport_admissions record`)));

  const missingApprovalRecord = comparePublicOwnerMountFixture(t, {
    includeGoalAdmission: true, includeIssueApprovalAnchors: true, includeIssueAdmission: true,
    includeApprovalAdmission: true, goalExpression: goalPolicy.mount_expression,
    issueExpression: issuePolicy.mount_expression, approvalExpression: approvalPolicy.mount_expression,
    omitApprovalAdmission: true,
  });
  assert(missingApprovalRecord.result.failures.some((failure) => failure.includes(`${APPROVAL_READS_ADMISSION_ID}: missing reviewed_transport_admissions record`)));

  const wrongIssueGuard = comparePublicOwnerMountFixture(t, {
    includeGoalAdmission: true, includeIssueApprovalAnchors: true, includeIssueAdmission: true,
    includeApprovalAdmission: true, goalExpression: goalPolicy.mount_expression,
    issueExpression: issuePolicy.mount_expression.replace("Boolean(opts.rustPublicIngress)", "Boolean(opts.rustPublicIngress?.issueReads)"),
    approvalExpression: approvalPolicy.mount_expression,
  });
  assert(wrongIssueGuard.result.failures.some((failure) => failure.includes("new Node authority surface is forbidden")));

  const wrongApprovalGuard = comparePublicOwnerMountFixture(t, {
    includeGoalAdmission: true, includeIssueApprovalAnchors: true, includeIssueAdmission: true,
    includeApprovalAdmission: true, goalExpression: goalPolicy.mount_expression,
    issueExpression: issuePolicy.mount_expression,
    approvalExpression: approvalPolicy.mount_expression.replace("Boolean(opts.rustPublicIngress)", "Boolean(opts.rustPublicIngress?.approvalReads)"),
  });
  assert(wrongApprovalGuard.result.failures.some((failure) => failure.includes("new Node authority surface is forbidden")));

  const wrongIssueOption = comparePublicOwnerMountFixture(t, {
    includeGoalAdmission: true, includeIssueApprovalAnchors: true, includeIssueAdmission: true,
    includeApprovalAdmission: true, goalExpression: goalPolicy.mount_expression,
    issueExpression: issuePolicy.mount_expression.replace("nativeApprovalReads:", "unreviewedReads:"),
    approvalExpression: approvalPolicy.mount_expression,
  });
  assert(wrongIssueOption.result.failures.some((failure) => failure.includes("new Node authority surface is forbidden")));

  const wrongApprovalOption = comparePublicOwnerMountFixture(t, {
    includeGoalAdmission: true, includeIssueApprovalAnchors: true, includeIssueAdmission: true,
    includeApprovalAdmission: true, goalExpression: goalPolicy.mount_expression,
    issueExpression: issuePolicy.mount_expression,
    approvalExpression: approvalPolicy.mount_expression.replace("nativeApprovalReads:", "unreviewedReads:"),
  });
  assert(wrongApprovalOption.result.failures.some((failure) => failure.includes("new Node authority surface is forbidden")));

  const duplicateIssue = comparePublicOwnerMountFixture(t, {
    includeGoalAdmission: true, includeIssueApprovalAnchors: true, includeIssueAdmission: true,
    includeApprovalAdmission: true, goalExpression: goalPolicy.mount_expression,
    issueExpression: issuePolicy.mount_expression, approvalExpression: approvalPolicy.mount_expression,
    duplicateIssue: true,
  });
  assert(duplicateIssue.result.failures.some((failure) => failure.includes(`${ISSUE_APPROVAL_READS_ADMISSION_ID}: trusted primary transport-admission mount must appear exactly once`)));

  const duplicateApproval = comparePublicOwnerMountFixture(t, {
    includeGoalAdmission: true, includeIssueApprovalAnchors: true, includeIssueAdmission: true,
    includeApprovalAdmission: true, goalExpression: goalPolicy.mount_expression,
    issueExpression: issuePolicy.mount_expression, approvalExpression: approvalPolicy.mount_expression,
    duplicateApproval: true,
  });
  assert(duplicateApproval.result.failures.some((failure) => failure.includes(`${APPROVAL_READS_ADMISSION_ID}: trusted primary transport-admission mount must appear exactly once`)));

  const reorderedIssue = comparePublicOwnerMountFixture(t, {
    includeGoalAdmission: true, includeIssueApprovalAnchors: true, includeIssueAdmission: true,
    includeApprovalAdmission: true, goalExpression: goalPolicy.mount_expression,
    issueExpression: issuePolicy.mount_expression, approvalExpression: approvalPolicy.mount_expression,
    moveIssueAfterAnchor: true,
  });
  assert(reorderedIssue.result.failures.some((failure) => failure.includes("native Issue router approval reads adapter must appear before its order-before anchor")));

  const reorderedApproval = comparePublicOwnerMountFixture(t, {
    includeGoalAdmission: true, includeIssueApprovalAnchors: true, includeIssueAdmission: true,
    includeApprovalAdmission: true, goalExpression: goalPolicy.mount_expression,
    issueExpression: issuePolicy.mount_expression, approvalExpression: approvalPolicy.mount_expression,
    moveApprovalBeforeGoal: true,
  });
  assert(reorderedApproval.result.failures.some((failure) => failure.includes("native Approval reads router adapter must appear after its order-after anchor")));
});

test("public owner mount admissions reject wrong guards, duplicates, and reordered mounts", (t) => {
  const wrongCliGuard = comparePublicOwnerMountFixture(t, {
    cliExpression: TRUSTED_TRANSPORT_ADMISSIONS[CLI_AUTH_ADMISSION_ID].mount_expression
      .replace("Boolean(opts.rustPublicIngress)", "Boolean(opts.rustPublicIngress?.cliAuth)"),
  });
  assert(wrongCliGuard.result.failures.some((failure) => failure.includes("new Node authority surface is forbidden")));
  assert(wrongCliGuard.result.failures.some((failure) => failure.includes(`stale reviewed_transport_admissions record: ${CLI_AUTH_ADMISSION_ID}`)));

  const wrongProjectGuard = comparePublicOwnerMountFixture(t, {
    projectExpression: TRUSTED_TRANSPORT_ADMISSIONS[PROJECT_READS_ADMISSION_ID].mount_expression
      .replace("Boolean(opts.rustPublicIngress)", "Boolean(opts.rustPublicIngress?.projectReads)"),
  });
  assert(wrongProjectGuard.result.failures.some((failure) => failure.includes("new Node authority surface is forbidden")));
  assert(wrongProjectGuard.result.failures.some((failure) => failure.includes(`stale reviewed_transport_admissions record: ${PROJECT_READS_ADMISSION_ID}`)));

  const wrongCliOptionName = comparePublicOwnerMountFixture(t, {
    cliExpression: TRUSTED_TRANSPORT_ADMISSIONS[CLI_AUTH_ADMISSION_ID].mount_expression
      .replace("nativeCliAuthOwner:", "unreviewedNativeOwner:"),
  });
  assert(wrongCliOptionName.result.failures.some((failure) => failure.includes("new Node authority surface is forbidden")));
  const wrongProjectOptionName = comparePublicOwnerMountFixture(t, {
    projectExpression: TRUSTED_TRANSPORT_ADMISSIONS[PROJECT_READS_ADMISSION_ID].mount_expression
      .replace("nativeProjectReads:", "unreviewedProjectReads:"),
  });
  assert(wrongProjectOptionName.result.failures.some((failure) => failure.includes("new Node authority surface is forbidden")));

  const duplicateCli = comparePublicOwnerMountFixture(t, { duplicateCli: true });
  assert(duplicateCli.result.failures.some((failure) => failure.includes(`${CLI_AUTH_ADMISSION_ID}: trusted primary transport-admission mount must appear exactly once`)));
  const duplicateProject = comparePublicOwnerMountFixture(t, { duplicateProject: true });
  assert(duplicateProject.result.failures.some((failure) => failure.includes(`${PROJECT_READS_ADMISSION_ID}: trusted primary transport-admission mount must appear exactly once`)));

  const reorderedCli = comparePublicOwnerMountFixture(t, { moveCliBeforeAnchor: true });
  assert(reorderedCli.result.failures.some((failure) => failure.includes("native CLI auth router adapter must appear after its order-after anchor")));
  const reorderedProject = comparePublicOwnerMountFixture(t, { moveProjectAfterAnchor: true });
  assert(reorderedProject.result.failures.some((failure) => failure.includes("native Project reads router adapter must appear before its order-before anchor")));
});

test("admitted public owner mounts cannot authorize an additional Node route or database writer", (t) => {
  const extraNodeBusiness = comparePublicOwnerMountFixture(t, {
    extra: 'api.post("/api/unreviewed-native-owner", handler);\n',
  });
  assert.deepEqual(extraNodeBusiness.result.allowed_transport_admissions.map((entry) => entry.id).sort(), [
    CLI_AUTH_ADMISSION_ID,
    PROJECT_READS_ADMISSION_ID,
  ].sort());
  assert(extraNodeBusiness.result.failures.some((failure) => failure.includes("new Node authority surface is forbidden")));

  const extraNodeWriter = comparePublicOwnerMountFixture(t, {
    extraSourcePath: "server/src/services/unreviewed-native-owner-writer.ts",
    extraSource: 'export function write(db) { return db.insert(users).values({ id: "unreviewed" }); }\n',
  });
  assert(extraNodeWriter.result.failures.some((failure) => failure.includes("new Node authority surface is forbidden")));
  assert(extraNodeWriter.result.failures.some((failure) => failure.includes("db-write-candidate")));
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

test("the exact source-pinned Rust email-auth negative fence is the only conditional identity-proof surface", (t) => {
  const accepted = compareIdentityAdmissionFixture(t, { emailFence: true });
  assert.deepEqual(accepted.result.failures, []);
  assert.deepEqual(accepted.result.allowed_transport_admissions.map((entry) => entry.id), [IDENTITY_ADMISSION_ID]);
  assert.deepEqual(accepted.result.allowed_transport_admissions[0].conditional_signatures, [
    'server/src/bootstrap/create-http-app.ts|middleware|app|<handler:(req, res, next) => { if (isNativeEmailAuthRequest(req.method, req.originalUrl)) { res.status(404).json({ error: "API route not found" }); return; } next(); }>',
  ]);
  assert.equal(accepted.result.added_surfaces.filter((surface) => surface.signature.includes("isNativeEmailAuthRequest")).length, 1);
  assert.equal(accepted.head.structural_surfaces.filter((surface) => surface.expression?.includes("isNativeEmailAuthRequest")).length, 1);

  const unreviewedSource = compareIdentityAdmissionFixture(t, { emailFence: true, omitNodeRecord: true });
  assert(unreviewedSource.result.failures.some((failure) => failure.includes("server/src/bootstrap/create-http-app.ts: missing reviewed_node_changes record")));
  assert(unreviewedSource.result.failures.some((failure) => failure.includes("mount source hash does not match the trusted allowlist")) === false);

  const wrongHash = compareIdentityAdmissionFixture(t, { emailFence: true, emailFenceHash: "0".repeat(64) });
  assert(wrongHash.result.failures.some((failure) => failure.includes("mount source hash does not match the trusted allowlist")));
  assert(wrongHash.result.failures.some((failure) => failure.includes("only the source-pinned conditional middleware surfaces")));

  const wrongBody = compareIdentityAdmissionFixture(t, {
    headSource: identityAdmissionAppSource({ emailFence: true, fenceExpression: '(req, res, next) => { if (isNativeEmailAuthRequest(req.method, req.originalUrl)) { res.status(200).json({ error: "API route not found" }); return; } next(); }' }),
  });
  assert(wrongBody.result.failures.some((failure) => failure.includes("mount source hash does not match the trusted allowlist")));
  assert(wrongBody.result.failures.some((failure) => failure.includes("new Node authority surface is forbidden")));

  const wrongPath = compareIdentityAdmissionFixture(t, {
    extraSourcePath: "server/src/bootstrap/untrusted-email-fence.ts",
    extraSource: `const app = express();\nif (opts.rustPublicIngress) {\n  app.use((req, res, next) => { if (isNativeEmailAuthRequest(req.method, req.originalUrl)) { res.status(404).json({ error: "API route not found" }); return; } next(); });\n}\n`,
  });
  assert(wrongPath.result.failures.some((failure) => failure.includes("new Node authority surface is forbidden")));

  const extraSurface = compareIdentityAdmissionFixture(t, {
    emailFence: true,
    appOptions: { extra: 'app.use("/unrelated", unrelatedMiddleware);\n' },
  });
  assert(extraSurface.result.failures.some((failure) => failure.includes("only the source-pinned conditional middleware surfaces")));
  assert(extraSurface.result.failures.some((failure) => failure.includes("new Node authority surface is forbidden")));
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
  const fenceRecord = [{ id: "queue.read-fence", path: "server/src/services/queue.ts", reviewer: "reviewer@example.test" }];
  fs.writeFileSync(inventoryPath, `${JSON.stringify({
    reviewed_transport_admissions: reviewedRecord,
    reviewed_legacy_fence_changes: fenceRecord,
  })}\n`);
  const checker = fileURLToPath(new URL("./rust-backend-authority-inventory.mjs", import.meta.url));

  const generated = spawnSync(process.execPath, [checker, "generate", "--root", root, "--inventory", inventoryPath], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(inventoryPath, "utf8")).reviewed_transport_admissions, reviewedRecord);
  assert.deepEqual(JSON.parse(fs.readFileSync(inventoryPath, "utf8")).reviewed_legacy_fence_changes, fenceRecord);

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


test("trusted helper calls reject parameter, destructuring, catch, and alias shadowing", (t) => {
  const helper = "lockLegacyNativeChatQueueTarget";
  const mutations = [
    queueGuardCallerHead.replace("enqueue(db, input)", `enqueue(db, input, ${helper} = async () => "available")`),
    queueGuardCallerHead.replace("enqueue(db, input)", `enqueue(db, input, { ${helper} })`),
    queueGuardCallerHead.replace("enqueue(db, input)", `enqueue(db, input, { guard: ${helper} })`),
    queueGuardCallerHead.replace("  await db.transaction", `  const alias = ${helper};\n  await db.transaction`),
    queueGuardCallerHead.replace("  await db.transaction", `  try { throw async () => "available"; } catch (${helper}) {\n  await db.transaction`).replace("  });\n}", "  });\n  }\n}"),
  ];
  for (const callerHeadSource of mutations) {
    const fixture = compareQueueGuardFixture(t, { callerHeadSource });
    assert(fixture.result.failures.length > 0, "only the pinned binding may be called");
  }
});


test("pinned helper chains reject dependency shadowing outside the fixed body", (t) => {
  for (const helper of ["lockLegacyNativeChatQueueTarget", "assertLegacyChatConversationAuthority"]) {
    const head = helper === "lockLegacyNativeChatQueueTarget"
      ? chatAuthorityHelperHead.replace("chatService()", `chatService(${helper}: any)`)
      : chatAuthorityHelperHead.replace("  return null;", `  async function legacyWriter(${helper} = async () => {}) { await ${helper}(null, null, null); }\n  return null;`);
    const fixture = chatAuthorityHelperFixture(t, head);
    assert(fixture.result.failures.some((failure) => failure.includes("shadowing binding")));
  }
});


test("guard targets stay bound to the fixed reviewed caller, independently for org and conversation", (t) => {
  for (const callerHeadSource of [
    queueGuardCallerHead.replace("tx, input.orgId, input.conversationId", "tx, otherOrgId, input.conversationId"),
    queueGuardCallerHead.replace("tx, input.orgId, input.conversationId", "tx, input.orgId, otherConversationId"),
    queueGuardCallerHead.replace("conversationId: input.conversationId", "conversationId: otherConversationId"),
  ]) {
    const fixture = compareQueueGuardFixture(t, { callerHeadSource });
    assert(fixture.result.failures.some((failure) => failure.includes("guard-to-writer target contract")));
  }
  const fixture = compareQueueGuardFixture(t);
  const result = compareProductionInventories(fixture.base, fixture.head,
    contentsFor(fixture.baseRoot, fixture.base), contentsFor(fixture.headRoot, fixture.head));
  assert(result.failures.some((failure) => failure.includes("guard-to-writer target contract")),
    "inventory records cannot self-admit a caller missing from the production policy table");
});

// These rules must be testable before the future production adapters exist.
// The later adapter PR is checked with this trusted-base policy against its
// actual Git source hashes; a candidate cannot admit its own new policy.
test("package Rust transport admissions are fixed by path, digest and boundary metadata", (t) => {
  assert.deepEqual(Object.keys(TRUSTED_NODE_TRANSPORT_SOURCES).sort(), [
    "packages/db/src/migration-operator.ts", "packages/db/src/postgres-owner.ts",
  ]);
  for (const [sourcePath, policy] of Object.entries(TRUSTED_NODE_TRANSPORT_SOURCES)) {
    const record = boundaryRecord(sourcePath, null, policy.source_sha256, {
      transport_admission_id: policy.id,
      rust_authority: policy.rust_authority,
      allowed_node_duties: [...policy.allowed_node_duties],
      prohibited_node_duties: [...policy.prohibited_node_duties],
      compatibility_boundary: policy.compatibility_boundary,
      retirement_criterion: policy.retirement_criterion,
    });
    assert.deepEqual(validateTrustedNodeTransportSourceRecord(record, sourcePath, policy.source_sha256), []);
    const mutations = {
      transport_admission_id: "unreviewed", rust_authority: "Node",
      allowed_node_duties: ["execute SQL"], prohibited_node_duties: [],
      compatibility_boundary: "self attested", retirement_criterion: "never",
      allowed_transport_surfaces: [],
    };
    for (const [key, value] of Object.entries(mutations)) {
      assert(validateTrustedNodeTransportSourceRecord({ ...record, [key]: value }, sourcePath, policy.source_sha256).length > 0, key);
    }
    assert(validateTrustedNodeTransportSourceRecord(record, sourcePath, "0".repeat(64)).length > 0);
    assert(validateTrustedNodeTransportSourceRecord(record, "packages/db/src/arbitrary.ts", policy.source_sha256).length > 0);

    const baseRoot = temporaryTree(t), headRoot = temporaryTree(t);
    const unreviewed = "export async function migrate(db) { await db.execute('select 1'); }\n";
    put(headRoot, sourcePath, unreviewed);
    const base = buildInventory(baseRoot);
    const head = buildInventory(headRoot, [{ ...record, head_sha256: sha256(unreviewed) }]);
    const rejected = compareProductionInventories(base, head, contentsFor(baseRoot, base), contentsFor(headRoot, head));
    assert(rejected.failures.some((failure) => failure.includes("statically trusted transport-source digest")));
    assert(rejected.failures.some((failure) => failure.includes("new Node authority surface is forbidden")));
  }
});

test("transport timer admission binds the exact source hash, owner and added signature", () => {
  const sourcePath = "server/src/services/migration-preflight.ts";
  assert.deepEqual(Object.keys(TRUSTED_TRANSPORT_SURFACES), [sourcePath]);
  const policy = TRUSTED_TRANSPORT_SURFACES[sourcePath];
  const [signature] = policy.signatures;
  const record = { transport_surface_owner: policy.owner, allowed_transport_surfaces: [signature] };
  const evaluate = ({ path = sourcePath, entry = record, digest = policy.source_sha256,
    surfaces = [{ source: sourcePath, signature }], added = new Map([[signature, 1]]) } = {}) => {
    const failures = [];
    consumeReviewedTransportSurfaces(entry, path, surfaces, new Map([[path, { sha256: digest }]]), added, failures);
    return { failures, added };
  };
  const accepted = evaluate();
  assert.deepEqual(accepted.failures, []);
  assert.equal(accepted.added.size, 0);
  assert(evaluate({ digest: "0".repeat(64) }).failures.length > 0);
  assert(evaluate({ path: "server/src/unreviewed-worker.ts" }).failures.length > 0);
  assert(evaluate({ entry: { ...record, transport_surface_owner: "unrelatedWorker" } }).failures.length > 0);
  assert(evaluate({ entry: { ...record, allowed_transport_surfaces: ["fabricated worker"] } }).failures.length > 0);
  assert(evaluate({ entry: { ...record, allowed_transport_surfaces: [signature, signature] } }).failures.length > 0);
  assert(evaluate({ surfaces: [] }).failures.length > 0);
  assert(evaluate({ added: new Map() }).failures.length > 0);
  assert(evaluate({ entry: { ...record, allowed_transport_surfaces: [""] } }).failures.length > 0);
});
