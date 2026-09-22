import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stableRudderMcpContractJson } from "../packages/agent-runtime-utils/src/rudder-mcp-fingerprint.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(repoRoot, "contracts/rudder-agent-contract/v1.json");
const outputs = {
  cli: path.join(repoRoot, "cli/src/agent-v1-capabilities.generated.ts"),
  mcp: path.join(repoRoot, "packages/agent-runtime-utils/src/rudder-mcp-tool-descriptors.generated.ts"),
  contract: path.join(repoRoot, "packages/agent-runtime-utils/src/rudder-agent-contract.generated.ts"),
  rust: path.join(repoRoot, "native/crates/agent-contract-core/src/contract.generated.json"),
};

const generatedChunkMaxLines = 1200;
const generatedChunkDirectory = path.dirname(outputs.contract);
const generatedChunkPrefixes = [
  "rudder-agent-contract.generated.capabilities-",
  "rudder-mcp-tool-descriptors.generated.descriptors-",
];

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

function stableJson(value: unknown): string {
  return `${JSON.stringify(JSON.parse(stableRudderMcpContractJson(value)), null, 2)}\n`;
}

function sourceHash(source: ContractSource): string {
  return createHash("sha256").update(stableRudderMcpContractJson(source)).digest("hex");
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

type GeneratedChunk = {
  filePath: string;
  content: string;
};

type RenderedGeneratedModule = {
  main: string;
  chunks: GeneratedChunk[];
};

function renderGeneratedArrayModule(exportName: string, values: unknown[]): string {
  return [
    "// Generated by scripts/generate-rudder-mcp-tool-descriptors.ts. Do not edit by hand.",
    `export const ${exportName} = ${JSON.stringify(values, null, 2)} as const;`,
    "",
  ].join("\n");
}

function chunkGeneratedArray(
  values: unknown[],
  exportNamePrefix: string,
  fileNamePrefix: string,
): GeneratedChunk[] {
  const chunks: unknown[][] = [];
  let current: unknown[] = [];

  for (const value of values) {
    const candidate = [...current, value];
    const candidateExportName = `${exportNamePrefix}${chunks.length}`;
    const candidateContent = renderGeneratedArrayModule(candidateExportName, candidate);
    if (current.length > 0 && candidateContent.split("\n").length > generatedChunkMaxLines) {
      chunks.push(current);
      current = [value];
      continue;
    }
    if (current.length === 0 && candidateContent.split("\n").length > generatedChunkMaxLines) {
      throw new Error(`Generated ${fileNamePrefix} entry exceeds ${generatedChunkMaxLines} lines`);
    }
    current = candidate;
  }
  if (current.length > 0) chunks.push(current);

  return chunks.map((chunk, index) => ({
    filePath: path.join(generatedChunkDirectory, `${fileNamePrefix}-${index}.ts`),
    content: renderGeneratedArrayModule(`${exportNamePrefix}${index}`, chunk),
  }));
}

function generatedChunkExportName(filePath: string): string {
  return path.basename(filePath, ".ts")
    .replace("rudder-agent-contract.generated.capabilities-", "RUDDER_AGENT_CONTRACT_CAPABILITIES_")
    .replace("rudder-mcp-tool-descriptors.generated.descriptors-", "RUDDER_MCP_TOOL_DESCRIPTORS_");
}

function renderChunkImports(chunks: GeneratedChunk[]): string[] {
  return chunks.map((chunk) => (
    `import { ${generatedChunkExportName(chunk.filePath)} } from "./${path.basename(chunk.filePath, ".ts")}.js";`
  ));
}

function renderChunkSpreads(chunks: GeneratedChunk[]): string[] {
  return chunks.map((chunk) => `  ...${generatedChunkExportName(chunk.filePath)},`);
}

function renderCli(source: ContractSource): string {
  return [
    "// Generated by scripts/generate-rudder-mcp-tool-descriptors.ts. Do not edit by hand.",
    'import type { AgentCliCapability } from "./agent-v1-registry.js";',
    `export const AGENT_CLI_CAPABILITIES: AgentCliCapability[] = ${JSON.stringify(source.capabilities.map((capability) => capability.cli), null, 2)};`,
    "",
  ].join("\n");
}

function renderMcp(source: ContractSource): RenderedGeneratedModule {
  const tools = source.capabilities.flatMap((capability) => capability.mcp ? [capability.mcp] : []);
  const descriptors = source.capabilities.flatMap((capability) => capability.mcp ? [{
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
  const coreHash = fingerprintTools(tools.filter((tool) => !tool.name.startsWith("rudder_browser_")));
  const browserHash = fingerprintTools(tools.filter((tool) => tool.name.startsWith("rudder_browser_")));
  const chunks = chunkGeneratedArray(
    descriptors,
    "RUDDER_MCP_TOOL_DESCRIPTORS_",
    "rudder-mcp-tool-descriptors.generated.descriptors",
  );
  return {
    main: [
      "// Generated by scripts/generate-rudder-mcp-tool-descriptors.ts. Do not edit by hand.",
      ...renderChunkImports(chunks),
      "",
      "export const RUDDER_MCP_TOOL_DESCRIPTORS = [",
      ...renderChunkSpreads(chunks),
      "] as const;",
      `export const GENERATED_RUDDER_CORE_MCP_CONTRACT_HASH = ${JSON.stringify(coreHash)};`,
      `export const GENERATED_RUDDER_BROWSER_MCP_CONTRACT_HASH = ${JSON.stringify(browserHash)};`,
      `export const GENERATED_RUDDER_AGENT_CONTRACT_HASH = ${JSON.stringify(sourceHash(source))};`,
      "",
    ].join("\n"),
    chunks,
  };
}

function renderContract(source: ContractSource): RenderedGeneratedModule {
  const { capabilities, ...metadata } = source;
  const chunks = chunkGeneratedArray(
    capabilities,
    "RUDDER_AGENT_CONTRACT_CAPABILITIES_",
    "rudder-agent-contract.generated.capabilities",
  );
  return {
    main: [
      "// Generated by scripts/generate-rudder-mcp-tool-descriptors.ts. Do not edit by hand.",
      ...renderChunkImports(chunks),
      "",
      "const RUDDER_AGENT_CONTRACT_CAPABILITIES = [",
      ...renderChunkSpreads(chunks),
      "] as const;",
      `const RUDDER_AGENT_CONTRACT_METADATA = ${JSON.stringify(metadata, null, 2)} as const;`,
      "",
      "export const RUDDER_AGENT_CONTRACT = {",
      "  ...RUDDER_AGENT_CONTRACT_METADATA,",
      "  capabilities: RUDDER_AGENT_CONTRACT_CAPABILITIES,",
      "} as const;",
      `export const RUDDER_AGENT_CONTRACT_HASH = ${JSON.stringify(sourceHash(source))};`,
      "",
    ].join("\n"),
    chunks,
  };
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

async function writeGeneratedChunks(chunks: GeneratedChunk[], check: boolean): Promise<void> {
  const expectedPaths = new Set(chunks.map((chunk) => chunk.filePath));
  const existingNames = await readdir(generatedChunkDirectory);
  for (const name of existingNames) {
    if (!generatedChunkPrefixes.some((prefix) => name.startsWith(prefix)) || !name.endsWith(".ts")) continue;
    const filePath = path.join(generatedChunkDirectory, name);
    if (expectedPaths.has(filePath)) continue;
    if (check) throw new Error(`${path.relative(repoRoot, filePath)} is stale; run pnpm mcp-contract:generate`);
    await unlink(filePath);
  }
  for (const chunk of chunks) await writeOrCheck(chunk.filePath, chunk.content, check);
}

const check = process.argv.includes("--check");
const source = await readSource();
await writeOrCheck(sourcePath, stableJson(source), check);
await writeOrCheck(outputs.cli, renderCli(source), check);
const renderedMcp = renderMcp(source);
const renderedContract = renderContract(source);
await writeOrCheck(outputs.mcp, renderedMcp.main, check);
await writeOrCheck(outputs.contract, renderedContract.main, check);
await writeGeneratedChunks([...renderedMcp.chunks, ...renderedContract.chunks], check);
await writeOrCheck(outputs.rust, stableJson({ ...source, artifactHash: sourceHash(source) }), check);
