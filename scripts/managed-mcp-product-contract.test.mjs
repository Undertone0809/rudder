import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("custom integration contract owns managed OAuth discovery, dispatch, and legacy compatibility", () => {
  const contract = read("doc/product/domains/agents/custom-integrations.md");

  for (const expected of [
    "legacy_manual",
    "10-minute",
    "real MCP tool discovery",
    "Streamable HTTP",
    "OAuth",
    "sanitized",
    "organization owner",
    "external MCP credentials",
    "account scope",
    "read_write",
    "Notion",
    "provider-granted",
  ]) {
    assert.match(contract, new RegExp(expected, "i"), `missing ${expected}`);
  }
});

test("control tools contract keeps external MCP proxies separate from rudder-tools", () => {
  const contract = read("doc/product/domains/agents/control-tools.md");

  assert.match(contract, /external MCP/i);
  assert.match(contract, /managedExternalMcpBindings/);
  assert.match(contract, /separate from.*`rudder-tools`/is);
  assert.match(contract, /run-scoped/i);
});

test("MCP capability failures never own Agent runtime admission", () => {
  const customIntegrations = read("doc/product/domains/agents/custom-integrations.md");
  const controlTools = read("doc/product/domains/agents/control-tools.md");
  const registry = read("doc/product/registry.yml");

  assert.match(customIntegrations, /capability extension, not runtime-admission authority/i);
  assert.match(
    customIntegrations,
    /fail closed for tool exposure but fail open for Agent\s+runtime startup/i,
  );
  assert.match(controlTools, /MCP availability never owns Agent runtime admission/i);
  assert.match(registry, /2026-07-26-managed-mcp-runtime-failure-isolation/);

  for (const adapterPath of [
    "packages/agent-runtimes/codex-local/src/server/execute.ts",
    "packages/agent-runtimes/claude-local/src/server/execute.ts",
    "packages/agent-runtimes/opencode-local/src/server/execute.ts",
    "packages/agent-runtimes/pi-local/src/server/execute.ts",
  ]) {
    const adapter = read(adapterPath);
    assert.doesNotMatch(adapter, /assertRudderMcpCoreAvailable/);
    assert.match(adapter, /continuing without .*Rudder MCP tools/i);
  }
  assert.match(
    read("packages/agent-runtime-utils/src/rudder-mcp-preflight.ts"),
    /PREFLIGHT_TIMEOUT_MS = 3_000/,
  );
  assert.match(
    read("packages/agent-runtimes/codex-local/src/server/execute.ts"),
    /rudderMcpPreflight\.available/,
  );
  assert.match(
    read("packages/agent-runtimes/claude-local/src/server/execute.ts"),
    /includeCore/,
  );
  assert.match(
    read("packages/agent-runtimes/opencode-local/src/server/execute.ts"),
    /includeCoreMcp/,
  );
});

test("runtime permissions contract defines OAuth, network, STDIO, and environment boundaries", () => {
  const contract = read("doc/product/domains/agents/runtime-platform-permissions.md");

  assert.match(contract, /OAuth token/i);
  assert.match(contract, /runtime identity/i);
  assert.match(contract, /STDIO/);
  assert.match(contract, /Streamable HTTP/);
  assert.match(contract, /environment variable/i);
});

test("registry and agent traceability map the managed MCP data contract and approved plan", () => {
  const registry = read("doc/product/registry.yml");
  const traceability = read("doc/product/domains/agents/traceability.md");

  for (const path of [
    "packages/db/src/schema/mcp_connections.ts",
    "packages/shared/src/types/mcp.ts",
    "packages/shared/src/validators/mcp.ts",
    "doc/plans/2026-07-23-managed-mcp-oauth-integrations.md",
  ]) {
    assert.match(registry, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(traceability, /2026-07-23-managed-mcp-oauth-integrations/);
  assert.match(traceability, /AGENT\.CUSTOM\.INTEGRATIONS\.001/);
  assert.match(traceability, /AGENT\.CONTROL\.TOOLS\.001/);
  assert.match(traceability, /AGENT\.RUNTIME\.PERMISSIONS\.001/);

  const entry = (contractId) => (
    registry.match(new RegExp(`  ${contractId.replaceAll(".", "\\.")}:[\\s\\S]*?(?=\\n  [A-Z][A-Z0-9.]+:\\n)`))?.[0] ?? ""
  );
  for (const contractId of [
    "AGENT.CUSTOM.INTEGRATIONS.001",
    "AGENT.CONTROL.TOOLS.001",
    "AGENT.RUNTIME.PERMISSIONS.001",
  ]) {
    assert.match(entry(contractId), /2026-07-23-managed-mcp-oauth-integrations/);
  }
  const skillsEntry = entry("AGENT.SKILLS.001");
  assert.doesNotMatch(skillsEntry, /2026-07-23-managed-mcp-oauth-integrations/);
});
