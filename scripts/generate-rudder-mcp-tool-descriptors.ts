import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stableRudderMcpContractJson } from "../packages/agent-runtime-utils/src/rudder-mcp-fingerprint.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(repoRoot, "contracts/rudder-agent-contract/v1.json");
const outputs = {
  cli: path.join(repoRoot, "cli/src/agent-v1-capabilities.generated.ts"),
  mcp: path.join(repoRoot, "packages/agent-runtime-utils/src/rudder-mcp-tool-descriptors.generated.ts"),
  contract: path.join(repoRoot, "packages/agent-runtime-utils/src/rudder-agent-contract.generated.ts"),
  shards: path.join(repoRoot, "packages/agent-runtime-utils/src/contract-shards"),
  rust: path.join(repoRoot, "native/crates/agent-contract-core/src/contract.generated.json"),
};
const MAX_SHARD_LINES = 1_200;
// Keep aggregate exports below the architecture audit's oversized-file threshold.
const MAX_MCP_AGGREGATE_LINES = 1_200;
const MAX_AGENT_CONTRACT_AGGREGATE_LINES = 1_200;
const SHARD_NAME_PATTERN = /^(?:rudder-agent-contract-capabilities|rudder-mcp-tool-descriptors)-\d+\.ts$/;

type JsonObject = Record<string, unknown>;

interface ContractCapability {
  id: string;
  cli: JsonObject;
  mcp: (JsonObject & { name: string }) | null;
  api: {
    transport: "direct" | "cli-fallback";
    method?: "GET" | "POST" | "PATCH";
    pathTemplate?: string;
  };
}

interface ContractSource extends JsonObject {
  schema: "rudder.agent-contract-source/v1";
  contractVersion: "rudder.agent-contract/v1";
  capabilities: ContractCapability[];
  normalizationProfiles: Record<string, string[]>;
  differentialFixtures: Array<{
    id: string;
    profile: string;
    left: unknown;
    right: unknown;
    expected: unknown;
  }>;
  g0DifferentialFixtures: Array<ContractSource["differentialFixtures"][number] & {
    nodeEvidence: string[];
  }>;
}

interface GeneratedShard {
  exportName: string;
  filePath: string;
  source: string;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(JSON.parse(stableRudderMcpContractJson(value)), null, 2)}\n`;
}

function sourceHash(source: ContractSource): string {
  return createHash("sha256").update(stableRudderMcpContractJson(source)).digest("hex");
}

function renderMcpDescriptors(source: ContractSource): JsonObject[] {
  return source.capabilities.flatMap((capability) => capability.mcp ? [{
    capabilityId: capability.id,
    name: capability.mcp.name,
    description: capability.cli.description,
    semanticDescription: capability.mcp.description,
    annotations: capability.mcp.annotations,
    mutating: capability.cli.mutating,
    requiresOrgId: capability.cli.requiresOrgId,
    requiresAgentId: capability.cli.requiresAgentId,
    attachesRunIdWhenAvailable: capability.cli.attachesRunIdWhenAvailable,
    inputSchema: capability.mcp.inputSchema,
  }] : []);
}

function assertSource(value: unknown): asserts value is ContractSource {
  if (!value || typeof value !== "object") throw new Error("Rudder agent contract source must be an object");
  const source = value as Partial<ContractSource>;
  if (source.schema !== "rudder.agent-contract-source/v1" || source.contractVersion !== "rudder.agent-contract/v1") {
    throw new Error("Unsupported Rudder agent contract source version");
  }
  if (!Array.isArray(source.capabilities) || !source.normalizationProfiles
    || !Array.isArray(source.differentialFixtures) || !Array.isArray(source.g0DifferentialFixtures)) {
    throw new Error("Incomplete Rudder agent contract source");
  }
  const ids = new Set<string>();
  for (const capability of source.capabilities) {
    if (!capability || typeof capability.id !== "string" || ids.has(capability.id)) {
      throw new Error(`Invalid or duplicate capability id: ${String(capability?.id)}`);
    }
    ids.add(capability.id);
    if ((capability.cli as { id?: unknown }).id !== capability.id) throw new Error(`CLI descriptor id mismatch for ${capability.id}`);
    if (capability.mcp && capability.mcp.capabilityId !== capability.id) throw new Error(`MCP descriptor id mismatch for ${capability.id}`);
    if (capability.api.transport === "direct" && (!capability.api.method || !capability.api.pathTemplate)) {
      throw new Error(`Incomplete direct API descriptor for ${capability.id}`);
    }
  }
  for (const [profile, pointers] of Object.entries(source.normalizationProfiles)) {
    if (!Array.isArray(pointers) || pointers.some((pointer) => typeof pointer !== "string" || !pointer.startsWith("/"))) {
      throw new Error(`Invalid normalization profile: ${profile}`);
    }
  }
  for (const fixture of [...source.differentialFixtures, ...source.g0DifferentialFixtures]) {
    if (!source.normalizationProfiles[fixture.profile]) throw new Error(`Unknown fixture normalization profile: ${fixture.profile}`);
  }
  for (const fixture of source.g0DifferentialFixtures) {
    if (!Array.isArray(fixture.nodeEvidence) || fixture.nodeEvidence.length === 0
      || fixture.nodeEvidence.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
      throw new Error(`G0 fixture lacks Node authority evidence: ${fixture.id}`);
    }
  }
}

async function readSource(): Promise<ContractSource> {
  const parsed = JSON.parse(await readFile(sourcePath, "utf8")) as unknown;
  assertSource(parsed);
  return JSON.parse(stableRudderMcpContractJson(parsed)) as ContractSource;
}

function fingerprintTools(tools: Array<JsonObject & { name: string }>): string {
  const semantic = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  return createHash("sha256").update(stableRudderMcpContractJson(semantic)).digest("hex");
}

function renderCli(source: ContractSource): string {
  return [
    "// Generated by scripts/generate-rudder-mcp-tool-descriptors.ts. Do not edit by hand.",
    'import type { AgentCliCapability } from "./agent-v1-registry.js";',
    `export const AGENT_CLI_CAPABILITIES: AgentCliCapability[] = ${JSON.stringify(source.capabilities.map((capability) => capability.cli), null, 2)};`,
    "",
  ].join("\n");
}

function countLines(source: string): number {
  return source.length === 0 ? 0 : source.split("\n").length - Number(source.endsWith("\n"));
}

function renderArrayShard<T>(exportName: string, entries: readonly T[]): string {
  return [
    "// Generated by scripts/generate-rudder-mcp-tool-descriptors.ts. Do not edit by hand.",
    `export const ${exportName} = ${JSON.stringify(entries, null, 2)} as const;`,
    "",
  ].join("\n");
}

function splitIntoShards<T>(
  entries: readonly T[],
  exportNamePrefix: string,
  fileNamePrefix: string,
): GeneratedShard[] {
  const shards: GeneratedShard[] = [];
  let current: T[] = [];

  const createShard = (index: number, values: readonly T[]): GeneratedShard => {
    const suffix = String(index).padStart(3, "0");
    const exportName = `${exportNamePrefix}_${suffix}`;
    return {
      exportName,
      filePath: path.join(outputs.shards, `${fileNamePrefix}-${suffix}.ts`),
      source: renderArrayShard(exportName, values),
    };
  };

  for (const entry of entries) {
    const candidate = [...current, entry];
    if (countLines(renderArrayShard(`${exportNamePrefix}_${String(shards.length).padStart(3, "0")}`, candidate)) <= MAX_SHARD_LINES) {
      current = candidate;
      continue;
    }
    if (current.length === 0) throw new Error(`${fileNamePrefix} entry exceeds the ${MAX_SHARD_LINES}-line shard limit`);
    shards.push(createShard(shards.length, current));
    current = [entry];
    if (countLines(renderArrayShard(`${exportNamePrefix}_${String(shards.length).padStart(3, "0")}`, current)) > MAX_SHARD_LINES) {
      throw new Error(`${fileNamePrefix} entry exceeds the ${MAX_SHARD_LINES}-line shard limit`);
    }
  }

  if (current.length > 0) shards.push(createShard(shards.length, current));
  return shards;
}

function renderArrayItems(entries: readonly unknown[], indentation: number): string {
  const prefix = " ".repeat(indentation);
  return entries.map((entry) => JSON.stringify(entry, null, 2).split("\n")
    .map((line) => `${prefix}${line}`).join("\n")).join(",\n");
}

function renderArrayBody(
  inlineEntries: readonly unknown[],
  shards: readonly GeneratedShard[],
  indentation: number,
): string {
  const inline = renderArrayItems(inlineEntries, indentation);
  const prefix = " ".repeat(indentation);
  const spread = shards.map((shard) => `${prefix}...${shard.exportName}`).join(",\n");
  if (inline && spread) return `${inline},\n${spread}`;
  return inline || spread;
}

function partitionForAggregate<T>(
  entries: readonly T[],
  exportNamePrefix: string,
  fileNamePrefix: string,
  maxAggregateLines: number,
  renderAggregate: (inlineEntries: readonly T[], shards: readonly GeneratedShard[]) => string,
): { inlineEntries: T[]; shards: GeneratedShard[] } {
  let inlineCount = entries.length;
  while (inlineCount >= 0) {
    const inlineEntries = entries.slice(0, inlineCount);
    const shards = splitIntoShards(entries.slice(inlineCount), exportNamePrefix, fileNamePrefix);
    if (countLines(renderAggregate(inlineEntries, shards)) <= maxAggregateLines) return { inlineEntries, shards };
    inlineCount -= 1;
  }
  throw new Error(`${fileNamePrefix} aggregate exceeds its ${maxAggregateLines}-line limit`);
}

function renderMcp(
  source: ContractSource,
  inlineDescriptors: readonly JsonObject[],
  shards: readonly GeneratedShard[],
): string {
  const tools = source.capabilities.flatMap((capability) => capability.mcp ? [capability.mcp] : []);
  const coreHash = fingerprintTools(tools.filter((tool) => !tool.name.startsWith("rudder_browser_")));
  const browserHash = fingerprintTools(tools.filter((tool) => tool.name.startsWith("rudder_browser_")));
  const imports = shards.map((shard) => (
    `import { ${shard.exportName} } from "./contract-shards/${path.basename(shard.filePath, ".ts")}.js";`
  )).join("\n");
  const descriptorEntries = renderArrayBody(inlineDescriptors, shards, 2);
  return [
    "// Generated by scripts/generate-rudder-mcp-tool-descriptors.ts. Do not edit by hand.",
    ...(imports ? [imports] : []),
    `export const RUDDER_MCP_TOOL_DESCRIPTORS = [\n${descriptorEntries}\n] as const;`,
    `export const GENERATED_RUDDER_CORE_MCP_CONTRACT_HASH = ${JSON.stringify(coreHash)};`,
    `export const GENERATED_RUDDER_BROWSER_MCP_CONTRACT_HASH = ${JSON.stringify(browserHash)};`,
    `export const GENERATED_RUDDER_AGENT_CONTRACT_HASH = ${JSON.stringify(sourceHash(source))};`,
    "",
  ].join("\n");
}

function renderContract(
  source: ContractSource,
  inlineCapabilities: readonly ContractCapability[],
  shards: readonly GeneratedShard[],
): string {
  const imports = shards.map((shard) => (
    `import { ${shard.exportName} } from "./contract-shards/${path.basename(shard.filePath, ".ts")}.js";`
  )).join("\n");
  const properties = Object.entries(source).map(([key, value]) => {
    if (key === "capabilities") {
      const entries = renderArrayBody(inlineCapabilities, shards, 4);
      return `  ${JSON.stringify(key)}: [\n${entries}\n  ]`;
    }
    const renderedValue = JSON.stringify(value, null, 2).split("\n");
    return `  ${JSON.stringify(key)}: ${renderedValue[0]}${renderedValue.slice(1).map((line) => `\n  ${line}`).join("")}`;
  });
  return [
    "// Generated by scripts/generate-rudder-mcp-tool-descriptors.ts. Do not edit by hand.",
    ...(imports ? [imports] : []),
    `export const RUDDER_AGENT_CONTRACT = {\n${properties.join(",\n")}\n} as const;`,
    `export const RUDDER_AGENT_CONTRACT_HASH = ${JSON.stringify(sourceHash(source))};`,
    "",
  ].join("\n");
}

async function writeOrCheck(filePath: string, expected: string, check: boolean): Promise<void> {
  if (check) {
    const actual = await readFile(filePath, "utf8").catch(() => "");
    if (actual !== expected) throw new Error(`${path.relative(repoRoot, filePath)} is stale; run pnpm mcp-contract:generate`);
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, expected, "utf8");
}

async function writeOrCheckShards(shards: readonly GeneratedShard[], check: boolean): Promise<void> {
  const expectedPaths = new Set(shards.map((shard) => shard.filePath));
  for (const shard of shards) await writeOrCheck(shard.filePath, shard.source, check);

  const existing = await readdir(outputs.shards).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const stale = existing.filter((name) => SHARD_NAME_PATTERN.test(name)
    && !expectedPaths.has(path.join(outputs.shards, name)));
  if (stale.length > 0 && check) {
    throw new Error(`${path.relative(repoRoot, outputs.shards)} contains stale generated shards; run pnpm mcp-contract:generate`);
  }
  for (const name of stale) await rm(path.join(outputs.shards, name));
}

const check = process.argv.includes("--check");
const source = await readSource();
const mcpTools = renderMcpDescriptors(source);
const mcpSplit = partitionForAggregate(
  mcpTools,
  "GENERATED_RUDDER_MCP_TOOL_DESCRIPTORS",
  "rudder-mcp-tool-descriptors",
  MAX_MCP_AGGREGATE_LINES,
  (inlineEntries, shards) => renderMcp(source, inlineEntries, shards),
);
const contractSplit = partitionForAggregate(
  source.capabilities,
  "GENERATED_RUDDER_AGENT_CONTRACT_CAPABILITIES",
  "rudder-agent-contract-capabilities",
  MAX_AGENT_CONTRACT_AGGREGATE_LINES,
  (inlineEntries, shards) => renderContract(source, inlineEntries, shards),
);
await writeOrCheck(sourcePath, stableJson(source), check);
await writeOrCheck(outputs.cli, renderCli(source), check);
await writeOrCheck(outputs.mcp, renderMcp(source, mcpSplit.inlineEntries, mcpSplit.shards), check);
await writeOrCheck(outputs.contract, renderContract(source, contractSplit.inlineEntries, contractSplit.shards), check);
await writeOrCheckShards([...mcpSplit.shards, ...contractSplit.shards], check);
await writeOrCheck(outputs.rust, stableJson({ ...source, artifactHash: sourceHash(source) }), check);
