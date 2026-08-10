import type { Db } from "@rudderhq/db";
import {
  agentEnabledSkills,
  agents,
  appBuilderApps,
  installedPlugins,
  mcpConnections as mcpConnectionRows,
  organizationSkills,
  pluginComponentLinks,
  pluginImportReports,
  pluginPackages,
  pluginSources,
} from "@rudderhq/db";
import type {
  ConfigureRudderPluginMarketplace,
  InspectRudderPlugin,
  InspectRudderPluginArchive,
  RudderInstalledPlugin,
  RudderLocalAppPlugin,
  RudderMcpUiResource,
  RudderPluginCapabilityDiff,
  RudderPluginCompatibilityComponent,
  RudderPluginDirectory,
  RudderPluginDiscoverEntry,
  RudderPluginImportReport,
  RudderPluginPackageFileInput,
  RudderPluginSkillConflictStrategy,
} from "@rudderhq/shared";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";
import { createHash } from "node:crypto";
import path from "node:path";
import { conflict, notFound, unprocessable } from "../errors.js";
import { agentEnabledSkillsService } from "./agent-enabled-skills.js";
import type { ManagedMcpConnectionServiceOptions } from "./mcp/managed-connections.js";
import { managedMcpConnectionService } from "./mcp/managed-connections.js";
import { organizationSkillService } from "./organization-skills.js";

const MAX_PLUGIN_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_RATIO = 100;
const MAX_MCP_UI_HTML_BYTES = 2 * 1024 * 1024;
const SENSITIVE_KEY = /(?:authorization|api[_-]?key|password|secret|token|cookie)/i;

type SnapshotFile = { path: string; content: string; encoding: "base64" };
type StoredReport = Omit<RudderPluginImportReport, "id" | "orgId" | "packageId" | "sourceType" | "sourceLabel" | "status" | "digest" | "createdAt">;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeName(value: string, fallback = "plugin") {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return (normalized || fallback).slice(0, 80);
}

function packageIdentityKey(
  sourceType: string,
  publisher: string | null,
  name: string,
) {
  return `${sourceType}:${(publisher ?? "unknown").toLocaleLowerCase("en-US")}:${name}`;
}

function decodeInputFile(file: InspectRudderPlugin["files"][number]): Buffer {
  if (file.encoding !== "base64") return Buffer.from(file.content, "utf8");
  const compact = file.content.replace(/\s/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw unprocessable(`Invalid base64 content for ${file.path}`);
  }
  return Buffer.from(compact, "base64");
}

function decodeBase64(value: string, label: string): Buffer {
  const compact = value.replace(/\s/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw unprocessable(`Invalid base64 content for ${label}`);
  }
  return Buffer.from(compact, "base64");
}

function unzipPackageFiles(content: string, label: string, stripPluginRoot: boolean): RudderPluginPackageFileInput[] {
  const archive = decodeBase64(content, label);
  if (archive.byteLength > MAX_PLUGIN_BYTES) throw unprocessable("Plugin archive exceeds the 10 MiB V1 limit");
  const files: RudderPluginPackageFileInput[] = [];
  let totalBytes = 0;
  let failure: Error | null = null;
  const unzip = new Unzip((file) => {
    if (failure || file.name.endsWith("/")) return;
    if (files.length >= 500) {
      failure = new Error("Plugin archive exceeds the 500-file V1 limit");
      file.terminate();
      return;
    }
    if (file.originalSize !== undefined && file.originalSize > MAX_FILE_BYTES) {
      failure = new Error(`Plugin archive entry exceeds 2 MiB: ${file.name}`);
      file.terminate();
      return;
    }
    if (file.size && file.originalSize && file.originalSize / file.size > MAX_ARCHIVE_RATIO) {
      failure = new Error(`Plugin archive entry exceeds the ${MAX_ARCHIVE_RATIO}:1 expansion limit: ${file.name}`);
      file.terminate();
      return;
    }
    const chunks: Buffer[] = [];
    let entryBytes = 0;
    file.ondata = (error, data, final) => {
      if (failure) return;
      if (error) {
        failure = error;
        return;
      }
      entryBytes += data.byteLength;
      totalBytes += data.byteLength;
      if (entryBytes > MAX_FILE_BYTES || totalBytes > MAX_PLUGIN_BYTES) {
        failure = new Error(entryBytes > MAX_FILE_BYTES
          ? `Plugin archive entry exceeds 2 MiB: ${file.name}`
          : "Plugin archive exceeds the 10 MiB V1 expansion limit");
        file.terminate();
        return;
      }
      chunks.push(Buffer.from(data));
      if (final) {
        files.push({ path: file.name, content: Buffer.concat(chunks).toString("base64"), encoding: "base64" });
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  try {
    unzip.push(archive, true);
  } catch (error) {
    throw unprocessable(`Invalid ZIP Plugin archive: ${error instanceof Error ? error.message : String(error)}`);
  }
  const archiveFailure = failure as Error | null;
  if (archiveFailure) throw unprocessable(archiveFailure.message);
  if (files.length === 0) throw unprocessable("Invalid ZIP Plugin archive: archive contains no files");
  if (totalBytes > archive.byteLength * MAX_ARCHIVE_RATIO) {
    throw unprocessable(`Plugin archive exceeds the ${MAX_ARCHIVE_RATIO}:1 expansion limit`);
  }
  if (!stripPluginRoot || files.some((file) => file.path === ".codex-plugin/plugin.json")) return files;
  const manifests = files.filter((file) => file.path.endsWith("/.codex-plugin/plugin.json"));
  if (manifests.length !== 1) return files;
  const prefix = manifests[0]!.path.slice(0, -".codex-plugin/plugin.json".length);
  if (!files.every((file) => file.path.startsWith(prefix))) return files;
  return files.map((file) => ({ ...file, path: file.path.slice(prefix.length) }));
}

function normalizeFiles(input: InspectRudderPlugin): {
  files: SnapshotFile[];
  bytes: Map<string, Buffer>;
  totalBytes: number;
  digest: string;
} {
  if (input.files.length > 500) throw unprocessable("Plugin package exceeds the 500-file V1 limit");
  const bytes = new Map<string, Buffer>();
  const caseFolded = new Set<string>();
  let totalBytes = 0;
  for (const inputFile of input.files) {
    const slashPath = inputFile.path.replace(/\\/g, "/");
    if (slashPath.split("/").some((segment) => segment === "." || segment === "..")) {
      throw unprocessable(`Unsafe Plugin file path: ${inputFile.path}`);
    }
    const normalized = path.posix.normalize(slashPath).replace(/^\.\//, "");
    if (
      !normalized
      || normalized === "."
      || normalized.startsWith("../")
      || normalized.includes("/../")
      || path.posix.isAbsolute(normalized)
      || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw unprocessable(`Unsafe Plugin file path: ${inputFile.path}`);
    }
    const folded = normalized.toLocaleLowerCase("en-US");
    if (caseFolded.has(folded)) throw unprocessable(`Plugin contains a duplicate or case-colliding path: ${normalized}`);
    caseFolded.add(folded);
    const content = decodeInputFile(inputFile);
    if (content.byteLength > MAX_FILE_BYTES) throw unprocessable(`Plugin file exceeds 2 MiB: ${normalized}`);
    totalBytes += content.byteLength;
    if (totalBytes > MAX_PLUGIN_BYTES) throw unprocessable("Plugin package exceeds the 10 MiB V1 limit");
    bytes.set(normalized, content);
  }

  const hash = createHash("sha256");
  for (const [filePath, content] of [...bytes.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(Buffer.from(filePath, "utf8"));
    hash.update(Buffer.from([0]));
    hash.update(content);
    hash.update(Buffer.from([0]));
  }
  return {
    bytes,
    totalBytes,
    digest: hash.digest("hex"),
    files: [...bytes.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([filePath, content]) => ({
      path: filePath,
      content: content.toString("base64"),
      encoding: "base64" as const,
    })),
  };
}

function parseJsonFile(bytes: Map<string, Buffer>, filePath: string): Record<string, unknown> | null {
  const content = bytes.get(filePath);
  if (!content) return null;
  try {
    const parsed: unknown = JSON.parse(content.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw unprocessable(`${filePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function containsLiteralSecret(value: unknown, parentKey = ""): boolean {
  if (typeof value === "string") {
    if (!SENSITIVE_KEY.test(parentKey)) return false;
    return !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value.trim());
  }
  if (Array.isArray(value)) return value.some((entry) => containsLiteralSecret(entry, parentKey));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>)
    .some(([key, entry]) => containsLiteralSecret(entry, key));
}

function normalizeManifestPath(value: string, field: string): string {
  const slashPath = value.replace(/\\/g, "/").replace(/^\.\//, "");
  const normalized = path.posix.normalize(slashPath);
  if (
    !normalized
    || normalized === "."
    || normalized.startsWith("../")
    || normalized.includes("/../")
    || path.posix.isAbsolute(normalized)
  ) {
    throw unprocessable(`Plugin manifest ${field} contains an unsafe package path`);
  }
  return normalized.replace(/\/$/, "");
}

function skillComponents(
  bytes: Map<string, Buffer>,
  manifest: Record<string, unknown>,
): RudderPluginCompatibilityComponent[] {
  const declared = asString(manifest.skills);
  const declaredPath = declared ? normalizeManifestPath(declared, "skills") : null;
  const matchesDeclared = (filePath: string) => declaredPath
    ? filePath === declaredPath || filePath.startsWith(`${declaredPath}/`)
    : false;
  return [...bytes.keys()]
    .filter((filePath) => path.posix.basename(filePath).toLowerCase() === "skill.md")
    .filter((filePath) => /^skills\//i.test(filePath) || matchesDeclared(filePath))
    .sort()
    .map((filePath) => {
      const root = path.posix.dirname(filePath);
      const slug = path.posix.basename(root);
      const markdown = bytes.get(filePath)!.toString("utf8");
      const name = markdown.match(/^name:\s*["']?([^\n"']+)/im)?.[1]?.trim() || slug;
      const description = markdown.match(/^description:\s*["']?([^\n"']+)/im)?.[1]?.trim() || null;
      const inventory = [...bytes.keys()].filter((candidate) => candidate === filePath || candidate.startsWith(`${root}/`));
      const executableFiles = inventory
        .filter((candidate) => candidate !== filePath && (
          /(?:^|\/)scripts?\//i.test(candidate)
          || /(?:^|\/)bin\//i.test(candidate)
          || /\.(?:bash|cjs|js|mjs|ps1|py|sh|ts|tsx|zsh)$/i.test(candidate)
        ))
        .map((candidate) => ({
          path: candidate,
          digest: createHash("sha256").update(bytes.get(candidate)!).digest("hex"),
        }));
      return {
        key: `skill:${slug}`,
        type: "skill" as const,
        name,
        path: filePath,
        status: "ready" as const,
        required: true,
        detail: description,
        metadata: {
          slug,
          root,
          fileCount: inventory.length,
          instructionDigest: createHash("sha256").update(markdown).digest("hex"),
          executableFiles,
        },
      };
    });
}

type ManifestConfig = { path: string; value: Record<string, unknown> };

function manifestConfigs(
  bytes: Map<string, Buffer>,
  manifestValue: unknown,
  defaultPath: string,
  field: string,
): ManifestConfig[] {
  const configs: ManifestConfig[] = [];
  const seenPaths = new Set<string>();
  const addPath = (filePath: string) => {
    if (seenPaths.has(filePath)) return;
    seenPaths.add(filePath);
    const value = parseJsonFile(bytes, filePath);
    if (!value) throw unprocessable(`Plugin manifest ${field} references a missing file: ${filePath}`);
    configs.push({ path: filePath, value });
  };
  if (bytes.has(defaultPath)) addPath(defaultPath);
  if (typeof manifestValue === "string" && manifestValue.trim()) {
    addPath(normalizeManifestPath(manifestValue, field));
  } else if (manifestValue && typeof manifestValue === "object" && !Array.isArray(manifestValue)) {
    configs.push({ path: ".codex-plugin/plugin.json", value: manifestValue as Record<string, unknown> });
  }
  return configs;
}

function mcpComponents(configs: ManifestConfig[]): RudderPluginCompatibilityComponent[] {
  const seen = new Set<string>();
  const components: RudderPluginCompatibilityComponent[] = [];
  for (const config of configs) {
    const nested = asRecord(config.value.mcpServers);
    const legacyNested = asRecord(config.value.mcp_servers);
    const definitions = Object.keys(nested).length > 0
      ? nested
      : Object.keys(legacyNested).length > 0 ? legacyNested : config.value;
    for (const [name, rawDefinition] of Object.entries(definitions)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const definition = asRecord(rawDefinition);
      const transport = asString(definition.url) ? "streamable_http" : asString(definition.command) ? "stdio" : "unknown";
      components.push({
        key: `mcp:${name}`,
        type: "mcp",
        name,
        path: config.path,
        status: transport === "unknown" ? "unsupported" : "setup_required",
        required: true,
        detail: transport === "unknown" ? "No supported URL or command transport was declared." : "Review and create a managed MCP connection.",
        metadata: { name, transport, definition, sourcePath: config.path },
      });
    }
  }
  return components;
}

function appComponents(configs: ManifestConfig[]): RudderPluginCompatibilityComponent[] {
  const seen = new Set<string>();
  return configs.flatMap((config) => Object.entries(config.value).flatMap(([name, id]) => {
    if (seen.has(name)) return [];
    seen.add(name);
    return [{
      key: `app:${name}`,
      type: "app",
      name,
      path: config.path,
      status: "unsupported",
      required: false,
      detail: "OpenAI registered App ids are preserved but cannot be executed by Rudder V1.",
      metadata: { alias: name, registeredId: typeof id === "string" ? id : null },
    } satisfies RudderPluginCompatibilityComponent];
  }));
}

function unsupportedCodexComponents(
  bytes: Map<string, Buffer>,
  manifest: Record<string, unknown>,
): RudderPluginCompatibilityComponent[] {
  const definitions = [
    {
      key: "unsupported:browser-extensions",
      name: "Browser extensions",
      manifestFields: ["browserExtensions", "browser_extensions"],
      filePattern: /^(?:browser-extensions?|extensions\/browser)(?:\/|$)|^\.browser-extensions?\.json$/i,
      detail: "Browser extensions are preserved in the package snapshot but are not installed or loaded by Rudder V1.",
    },
    {
      key: "unsupported:scheduled-task-templates",
      name: "Scheduled task templates",
      manifestFields: ["scheduledTasks", "scheduled_tasks", "taskTemplates", "task_templates"],
      filePattern: /^(?:scheduled-tasks?|task-templates?|tasks)(?:\/|$)|^\.(?:scheduled-)?tasks\.json$/i,
      detail: "Scheduled task templates are preserved in the package snapshot but are not scheduled or run by Rudder V1.",
    },
  ] as const;
  return definitions.flatMap((definition) => {
    const files = [...bytes.keys()].filter((filePath) => definition.filePattern.test(filePath));
    const declaredFields = definition.manifestFields.filter((field) => manifest[field] !== undefined);
    if (files.length === 0 && declaredFields.length === 0) return [];
    return [{
      key: definition.key,
      type: "unsupported" as const,
      name: definition.name,
      path: files[0] ?? null,
      status: "unsupported" as const,
      required: false,
      detail: definition.detail,
      metadata: { fileCount: files.length, declaredFields },
    }];
  });
}

function capabilitySnapshot(component: RudderPluginCompatibilityComponent) {
  const metadata = asRecord(component.metadata);
  let executionSurface: Record<string, unknown>;
  if (component.type === "skill") {
    executionSurface = {
      instructionDigest: metadata.instructionDigest ?? null,
      executableFiles: Array.isArray(metadata.executableFiles) ? metadata.executableFiles : [],
    };
  } else if (component.type === "mcp") {
    const definition = asRecord(metadata.definition);
    const environment = Object.entries(asRecord(definition.env));
    const staticEnvironment = environment
      .filter(([, value]) => typeof value === "string" && !/^\$\{/.test(value))
      .map(([key, value]) => ({
        key,
        valueDigest: createHash("sha256").update(value as string).digest("hex"),
      }))
      .sort((left, right) => left.key.localeCompare(right.key));
    const forwardedEnvironment = [...new Set(environment
      .map(([, value]) => value)
      .filter((value): value is string => (
        typeof value === "string" && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)
      ))
      .map((value) => value.slice(2, -1)))]
      .sort((left, right) => left.localeCompare(right));
    executionSurface = {
      transport: metadata.transport ?? null,
      url: asString(definition.url),
      command: asString(definition.command),
      args: Array.isArray(definition.args) ? definition.args.filter((entry) => typeof entry === "string") : [],
      cwd: asString(definition.cwd),
      staticEnvironment,
      forwardedEnvironment,
    };
  } else if (component.type === "app") {
    executionSurface = { registeredId: metadata.registeredId ?? null };
  } else {
    executionSurface = { unsupported: true };
  }
  return { status: component.status, executionSurface };
}

function capabilityDiff(
  before: RudderPluginCompatibilityComponent[],
  after: RudderPluginCompatibilityComponent[],
): RudderPluginCapabilityDiff {
  const beforeByKey = new Map(before.map((component) => [component.key, component]));
  const afterByKey = new Map(after.map((component) => [component.key, component]));
  const changes: RudderPluginCapabilityDiff["changes"] = [];
  for (const key of [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])].sort()) {
    const previous = beforeByKey.get(key);
    const next = afterByKey.get(key);
    if (!previous && next) {
      const expanded = next.status !== "unsupported" && (next.type === "skill" || next.type === "mcp");
      changes.push({
        kind: "added",
        key,
        type: next.type,
        name: next.name,
        accessImpact: expanded ? "expanded" : "none",
        detail: expanded ? "Adds a new executable capability." : "Adds package inventory without a new Rudder execution path.",
        before: null,
        after: capabilitySnapshot(next),
      });
      continue;
    }
    if (previous && !next) {
      changes.push({
        kind: "removed",
        key,
        type: previous.type,
        name: previous.name,
        accessImpact: previous.status === "unsupported" ? "none" : "reduced",
        detail: "Removes a previously reviewed capability.",
        before: capabilitySnapshot(previous),
        after: null,
      });
      continue;
    }
    if (!previous || !next) continue;
    const beforeSnapshot = capabilitySnapshot(previous);
    const afterSnapshot = capabilitySnapshot(next);
    if (JSON.stringify(beforeSnapshot) === JSON.stringify(afterSnapshot)) continue;
    const becameExecutable = previous.status === "unsupported" && next.status !== "unsupported";
    const executionChanged = JSON.stringify(beforeSnapshot.executionSurface) !== JSON.stringify(afterSnapshot.executionSurface);
    const expanded = becameExecutable || (
      executionChanged && (next.type === "mcp" || next.type === "skill")
    );
    changes.push({
      kind: "changed",
      key,
      type: next.type,
      name: next.name,
      accessImpact: expanded ? "expanded" : executionChanged ? "changed" : "none",
      detail: expanded
        ? next.type === "mcp"
          ? "Changes the MCP command, endpoint, environment, or runtime launch surface."
          : "Changes Skill instructions or executable files."
        : "Changes capability metadata or availability.",
      before: beforeSnapshot,
      after: afterSnapshot,
    });
  }
  return { changes, accessExpansion: changes.some((change) => change.accessImpact === "expanded") };
}

function compatibilityReport(bytes: Map<string, Buffer>, manifest: Record<string, unknown>): StoredReport {
  const mcpConfigs = manifestConfigs(bytes, manifest.mcpServers, ".mcp.json", "mcpServers");
  const appConfigs = manifestConfigs(bytes, manifest.apps, ".app.json", "apps");
  const components = [
    ...skillComponents(bytes, manifest),
    ...mcpComponents(mcpConfigs),
    ...appComponents(appConfigs),
    ...unsupportedCodexComponents(bytes, manifest),
  ];
  const warnings: string[] = [];
  const errors: string[] = [];
  if (mcpConfigs.some((config) => containsLiteralSecret(config.value))) {
    errors.push("MCP configuration appears to contain literal credential material. Replace it with environment references before import.");
  }
  const hookFiles = [...bytes.keys()].filter((filePath) => /^hooks(?:\/|$)/i.test(filePath));
  if (hookFiles.length > 0 || manifest.hooks) {
    components.push({
      key: "unsupported:hooks",
      type: "unsupported",
      name: "Hooks",
      path: hookFiles[0] ?? null,
      status: "unsupported",
      required: false,
      detail: "Hooks are preserved in the package snapshot and never executed by Rudder V1.",
      metadata: { fileCount: hookFiles.length },
    });
    warnings.push("Hooks are preserved but unsupported and will not run.");
  }
  if (bytes.has(".rudder/plugin.json")) {
    components.push({
      key: "unsupported:rudder-app-sidecar",
      type: "unsupported",
      name: "Rudder App sidecar",
      path: ".rudder/plugin.json",
      status: "unsupported",
      required: false,
      detail: "Importing a new Local App from a package sidecar is not enabled in V1.",
      metadata: {},
    });
  }
  if (components.length === 0) errors.push("The package contains no Skills, MCP servers, or App references.");
  if (components.every((component) => component.status === "unsupported")) {
    warnings.push("This package has no currently usable Rudder components.");
    errors.push("The package cannot be installed until it contains at least one supported or setup-capable component.");
  }
  return {
    manifest,
    components,
    warnings,
    errors,
    limits: { fileCount: bytes.size, totalBytes: [...bytes.values()].reduce((sum, content) => sum + content.byteLength, 0) },
    operation: "install",
    installedPluginId: null,
    capabilityDiff: null,
    skillConflicts: [],
  };
}

function normalizeManifest(manifest: Record<string, unknown>) {
  const interfaceMetadata = asRecord(manifest.interface);
  const author = asRecord(manifest.author);
  return {
    name: asString(manifest.name),
    version: asString(manifest.version),
    description: asString(manifest.description),
    displayName: asString(interfaceMetadata.displayName) ?? asString(manifest.name),
    shortDescription: asString(interfaceMetadata.shortDescription) ?? asString(manifest.description),
    publisher: asString(interfaceMetadata.developerName) ?? asString(author.name) ?? asString(manifest.author),
    category: asString(interfaceMetadata.category),
    capabilities: Array.isArray(interfaceMetadata.capabilities) ? interfaceMetadata.capabilities : [],
  };
}

function reportFromRow(row: typeof pluginImportReports.$inferSelect): RudderPluginImportReport {
  const report = row.report as unknown as StoredReport;
  return {
    id: row.id,
    orgId: row.orgId,
    packageId: row.packageId,
    sourceType: row.sourceType as RudderPluginImportReport["sourceType"],
    sourceLabel: row.sourceLabel,
    status: row.status as RudderPluginImportReport["status"],
    digest: row.digest,
    manifest: report.manifest,
    components: report.components,
    warnings: report.warnings,
    errors: report.errors,
    limits: report.limits,
    createdAt: row.createdAt.toISOString(),
    operation: report.operation,
    installedPluginId: report.installedPluginId,
    capabilityDiff: report.capabilityDiff ?? null,
    skillConflicts: report.skillConflicts ?? [],
  };
}

export function inspectRudderPluginPackage(input: InspectRudderPlugin) {
  const normalized = normalizeFiles(input);
  const manifest = parseJsonFile(normalized.bytes, ".codex-plugin/plugin.json");
  if (!manifest) throw unprocessable("Plugin package must contain .codex-plugin/plugin.json");
  const identity = normalizeManifest(manifest);
  if (!identity.name || !identity.version) throw unprocessable("Plugin manifest must declare name and version");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(identity.name) || identity.name.length > 64) {
    throw unprocessable("Plugin manifest name must be lower-case hyphen-case and at most 64 characters");
  }
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(identity.version)) {
    throw unprocessable("Plugin manifest version must be strict semantic versioning");
  }
  return {
    normalized,
    manifest,
    identity: identity as typeof identity & { name: string; version: string },
    report: compatibilityReport(normalized.bytes, manifest),
  };
}

export function inspectRudderPluginArchivePackage(input: InspectRudderPluginArchive) {
  return inspectRudderPluginPackage({
    sourceType: "local_upload",
    sourceLabel: input.sourceLabel,
    files: unzipPackageFiles(input.content, input.filename, true)
      .map((file) => ({ ...file, encoding: file.encoding ?? "utf8" })),
  });
}

export function rudderPluginService(db: Db, mcpOptions: ManagedMcpConnectionServiceOptions) {
  const skills = organizationSkillService(db);
  const enabledSkills = agentEnabledSkillsService(db);
  const mcpConnections = managedMcpConnectionService(db, mcpOptions);

  async function inspectFromSource(
    orgId: string,
    input: InspectRudderPlugin,
    source: {
      type: RudderPluginImportReport["sourceType"];
      label: string;
      locator?: string | null;
      metadata?: Record<string, unknown>;
    },
  ): Promise<RudderPluginImportReport> {
    const { normalized, manifest, identity, report } = inspectRudderPluginPackage(input);
    const sourceNamespace = asString(source.metadata?.marketplaceName)
      ? `${source.type}:${asString(source.metadata?.marketplaceName)}`
      : source.type;
    const normalizedIdentity = { ...identity, sourceNamespace };

    const identityConflict = await db.select({
      digest: pluginPackages.digest,
      normalizedManifest: pluginPackages.normalizedManifest,
      sourceMetadata: pluginSources.metadata,
    })
      .from(pluginImportReports)
      .innerJoin(pluginPackages, eq(pluginImportReports.packageId, pluginPackages.id))
      .innerJoin(pluginSources, eq(pluginImportReports.sourceId, pluginSources.id))
      .where(and(
        eq(pluginImportReports.orgId, orgId),
        eq(pluginImportReports.sourceType, source.type),
        eq(pluginPackages.name, identity.name),
        eq(pluginPackages.version, identity.version),
      ))
      .then((rows) => rows.find((row) => (
        asString(asRecord(row.normalizedManifest).publisher) ?? null
      ) === (identity.publisher ?? null)
        && (asString(row.sourceMetadata.marketplaceName)
          ? `${source.type}:${asString(row.sourceMetadata.marketplaceName)}`
          : source.type) === sourceNamespace
        && row.digest !== normalized.digest) ?? null);
    if (identityConflict) report.errors.push("The same Plugin name and version already exists with a different digest.");

    const identityKey = packageIdentityKey(sourceNamespace, identity.publisher, identity.name);
    const currentInstallation = await db.select({
      id: installedPlugins.id,
      digest: pluginPackages.digest,
      version: pluginPackages.version,
      compatibility: pluginPackages.compatibility,
    }).from(installedPlugins)
      .innerJoin(pluginPackages, eq(installedPlugins.packageId, pluginPackages.id))
      .where(and(
        eq(installedPlugins.orgId, orgId),
        eq(installedPlugins.packageName, identityKey),
        ne(installedPlugins.lifecycleState, "uninstalled"),
      ))
      .then((rows) => rows[0] ?? null);
    if (currentInstallation?.digest === normalized.digest) {
      report.errors.push("This exact Plugin package is already installed in this Organization.");
    } else if (currentInstallation && currentInstallation.version !== identity.version && !identityConflict) {
      report.operation = "update";
      report.installedPluginId = currentInstallation.id;
      const currentReport = currentInstallation.compatibility as unknown as StoredReport;
      report.capabilityDiff = capabilityDiff(currentReport.components ?? [], report.components);
    }

    const existingSkills = await db.select().from(organizationSkills)
      .where(eq(organizationSkills.orgId, orgId));
    const ownedSkillIds = new Set(currentInstallation
      ? await db.select({ targetId: pluginComponentLinks.targetId }).from(pluginComponentLinks)
        .where(and(
          eq(pluginComponentLinks.orgId, orgId),
          eq(pluginComponentLinks.installedPluginId, currentInstallation.id),
          eq(pluginComponentLinks.componentType, "skill"),
        )).then((rows) => rows.map((row) => row.targetId).filter((id): id is string => Boolean(id)))
      : []);
    report.skillConflicts = report.components.flatMap((component) => {
      if (component.type !== "skill") return [];
      const slug = asString(component.metadata.slug);
      if (!slug) return [];
      const existing = existingSkills.find((skill) => (
        !ownedSkillIds.has(skill.id)
        && (skill.slug.toLocaleLowerCase("en-US") === slug.toLocaleLowerCase("en-US")
          || skill.key.toLocaleLowerCase("en-US").endsWith(`:${slug.toLocaleLowerCase("en-US")}`))
      ));
      return existing ? [{
        componentKey: component.key,
        skillKey: existing.key,
        skillName: component.name,
        existingSkillId: existing.id,
        existingSkillName: existing.name,
      }] : [];
    });

    const [sourceRow] = await db.insert(pluginSources).values({
      orgId,
      sourceType: source.type,
      label: source.label,
      locator: source.locator ?? null,
      metadata: {
        fileCount: normalized.files.length,
        totalBytes: normalized.totalBytes,
        ...(source.metadata ?? {}),
      },
    }).returning();

    let packageId: string | null = null;
    if (report.errors.length === 0) {
      const existingPackage = await db.select().from(pluginPackages)
        .where(eq(pluginPackages.digest, normalized.digest))
        .then((rows) => rows[0] ?? null);
      const packageRow = existingPackage ?? await db.insert(pluginPackages).values({
        sourceId: sourceRow!.id,
        name: identity.name,
        version: identity.version,
        digest: normalized.digest,
        rawManifest: manifest,
        normalizedManifest: normalizedIdentity,
        snapshot: normalized.files,
        compatibility: report as unknown as Record<string, unknown>,
      }).returning().then((rows) => rows[0]!);
      packageId = packageRow.id;
    }

    const [row] = await db.insert(pluginImportReports).values({
      orgId,
      packageId,
      sourceId: sourceRow!.id,
      sourceType: source.type,
      sourceLabel: source.label,
      status: report.errors.length > 0 ? "failed" : "review_required",
      digest: normalized.digest,
      report: report as unknown as Record<string, unknown>,
    }).returning();
    return reportFromRow(row!);
  }

  async function inspect(orgId: string, input: InspectRudderPlugin): Promise<RudderPluginImportReport> {
    return inspectFromSource(orgId, input, { type: "local_upload", label: input.sourceLabel });
  }

  async function inspectArchive(orgId: string, input: InspectRudderPluginArchive) {
    const files = unzipPackageFiles(input.content, input.filename, true);
    return inspectFromSource(orgId, {
      sourceType: "local_upload",
      sourceLabel: input.sourceLabel,
      files: files.map((file) => ({ ...file, encoding: file.encoding ?? "utf8" })),
    }, {
      type: "local_upload",
      label: input.sourceLabel,
      locator: input.filename,
      metadata: { archive: true, filename: input.filename },
    });
  }

  async function configureMarketplace(orgId: string, input: ConfigureRudderPluginMarketplace) {
    let sourceType: "marketplace" | "git" = "marketplace";
    let sourceFiles: RudderPluginPackageFileInput[];
    let locator: string | null = null;
    let provenance: Record<string, unknown> = {};
    if (input.github) {
      const repository = new URL(input.github.repository);
      if (repository.protocol !== "https:" || repository.hostname.toLocaleLowerCase("en-US") !== "github.com") {
        throw unprocessable("Git marketplace repositories must use HTTPS on github.com");
      }
      const segments = repository.pathname.replace(/\.git$/i, "").split("/").filter(Boolean);
      if (segments.length !== 2) throw unprocessable("Git marketplace repository must identify one GitHub owner and repository");
      const [owner, repo] = segments;
      const archiveUrl = `https://codeload.github.com/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}/zip/${input.github.commit}`;
      const response = await fetch(archiveUrl, {
        redirect: "error",
        headers: { accept: "application/zip", "user-agent": "Rudder-Plugin-V1" },
      });
      if (!response.ok) throw unprocessable(`Pinned Git marketplace fetch failed with HTTP ${response.status}`);
      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(contentLength) && contentLength > MAX_PLUGIN_BYTES) {
        throw unprocessable("Pinned Git marketplace archive exceeds the 10 MiB V1 limit");
      }
      const archive = Buffer.from(await response.arrayBuffer());
      if (archive.byteLength > MAX_PLUGIN_BYTES) throw unprocessable("Pinned Git marketplace archive exceeds the 10 MiB V1 limit");
      sourceFiles = unzipPackageFiles(archive.toString("base64"), `${repo}@${input.github.commit}.zip`, true);
      sourceType = "git";
      locator = `${repository.toString().replace(/\/$/, "")}#${input.github.commit}`;
      provenance = { repository: repository.toString(), commit: input.github.commit, immutable: true };
    } else {
      sourceFiles = input.files ?? [];
      provenance = { local: true };
    }

    const normalizedMarketplace = normalizeFiles({
      sourceType: "local_upload",
      sourceLabel: input.sourceLabel,
      files: sourceFiles.map((file) => ({ ...file, encoding: file.encoding ?? "utf8" })),
    });
    const marketplacePaths = [...normalizedMarketplace.bytes.keys()]
      .filter((filePath) => path.posix.basename(filePath).toLocaleLowerCase("en-US") === "marketplace.json")
      .sort((left, right) => left.length - right.length);
    if (marketplacePaths.length === 0) throw unprocessable("Marketplace source must contain marketplace.json");
    const marketplacePath = marketplacePaths[0]!;
    const marketplace = parseJsonFile(normalizedMarketplace.bytes, marketplacePath)!;
    const marketplaceName = asString(marketplace.name) ?? input.sourceLabel;
    if (!Array.isArray(marketplace.plugins)) throw unprocessable("marketplace.json must declare an ordered plugins array");
    const marketplaceRoot = path.posix.dirname(marketplacePath) === "." ? "" : path.posix.dirname(marketplacePath);
    const reports: RudderPluginImportReport[] = [];
    for (const [index, rawEntry] of marketplace.plugins.entries()) {
      const entry = asRecord(rawEntry);
      const name = asString(entry.name);
      const source = asRecord(entry.source);
      const policy = asRecord(entry.policy);
      const installation = asString(policy.installation);
      if (!name || source.source !== "local" || !asString(source.path)) continue;
      if (installation === "NOT_AVAILABLE") continue;
      const relativeRoot = normalizeManifestPath(asString(source.path)!, "marketplace source.path").replace(/^\.\//, "");
      const pluginRoot = marketplaceRoot ? path.posix.join(marketplaceRoot, relativeRoot) : relativeRoot;
      const pluginFiles = [...normalizedMarketplace.bytes.entries()]
        .filter(([filePath]) => filePath.startsWith(`${pluginRoot}/`))
        .map(([filePath, content]) => ({
          path: filePath.slice(pluginRoot.length + 1),
          content: content.toString("base64"),
          encoding: "base64" as const,
        }));
      if (pluginFiles.length === 0) throw unprocessable(`Marketplace Plugin ${name} points to a missing local source path`);
      const report = await inspectFromSource(orgId, {
        sourceType: "local_upload",
        sourceLabel: `${marketplaceName}/${name}`,
        files: pluginFiles,
      }, {
        type: sourceType,
        label: `${marketplaceName}/${name}`,
        locator,
        metadata: {
          ...provenance,
          marketplaceName,
          marketplacePath,
          marketplaceOrder: index,
          policy,
          category: asString(entry.category),
          declaredInstallation: installation ?? "AVAILABLE",
          declaredAuthentication: asString(policy.authentication),
        },
      });
      reports.push(report);
    }
    if (reports.length === 0) throw unprocessable("Marketplace contains no available local Plugins that Rudder can review");
    return reports;
  }

  async function listDiscover(orgId: string): Promise<RudderPluginDiscoverEntry[]> {
    const rows = await db.select({
      report: pluginImportReports,
      pkg: pluginPackages,
      source: pluginSources,
    }).from(pluginImportReports)
      .innerJoin(pluginPackages, eq(pluginImportReports.packageId, pluginPackages.id))
      .innerJoin(pluginSources, eq(pluginImportReports.sourceId, pluginSources.id))
      .where(and(
        eq(pluginImportReports.orgId, orgId),
        eq(pluginImportReports.status, "review_required"),
        inArray(pluginImportReports.sourceType, ["marketplace", "git"]),
      ))
      .orderBy(asc(pluginImportReports.createdAt));
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) latest.set(
      `${row.report.sourceType}:${asString(row.source.metadata.marketplaceName) ?? row.source.label}:${row.pkg.name}`,
      row,
    );
    return [...latest.values()].map(({ report: reportRow, pkg, source }) => {
      const normalized = asRecord(pkg.normalizedManifest);
      const report = reportFromRow(reportRow);
      return {
        reportId: reportRow.id,
        packageId: pkg.id,
        name: pkg.name,
        displayName: asString(normalized.displayName) ?? pkg.name,
        description: asString(normalized.shortDescription) ?? asString(normalized.description),
        version: pkg.version,
        publisher: asString(normalized.publisher),
        sourceLabel: reportRow.sourceLabel,
        sourceType: reportRow.sourceType as "marketplace" | "git",
        digest: pkg.digest,
        category: asString(source.metadata.category) ?? asString(normalized.category),
        policy: asRecord(source.metadata.policy),
        components: report.components,
      };
    });
  }

  async function getImportReport(orgId: string, reportId: string) {
    const row = await db.select().from(pluginImportReports)
      .where(and(eq(pluginImportReports.orgId, orgId), eq(pluginImportReports.id, reportId)))
      .then((rows) => rows[0] ?? null);
    return row ? reportFromRow(row) : null;
  }

  async function applyPackageRevision(
    orgId: string,
    pluginId: string,
    packageRow: typeof pluginPackages.$inferSelect,
    sourceId: string | null,
    operation: "update" | "rollback",
    skillConflictStrategy: RudderPluginSkillConflictStrategy = "rename",
  ): Promise<RudderInstalledPlugin> {
    const current = await getInstalled(orgId, pluginId);
    if (!current) throw notFound("Installed Plugin not found");
    const report = packageRow.compatibility as unknown as StoredReport;
    const snapshot = packageRow.snapshot as SnapshotFile[];
    const skillRoots = report.components
      .filter((component) => component.type === "skill")
      .map((component) => asString(component.metadata.root))
      .filter((root): root is string => Boolean(root));
    const packageFiles = Object.fromEntries(snapshot
      .filter((file) => skillRoots.some((root) => file.path === `${root}/SKILL.md` || file.path.startsWith(`${root}/`)))
      .map((file) => [file.path, Buffer.from(file.content, "base64").toString("utf8")]));
    const importedSkills = report.components.some((component) => component.type === "skill")
      ? await skills.importPackageFiles(orgId, packageFiles, {
        onConflict: skillConflictStrategy === "keep" ? "skip" : skillConflictStrategy,
      })
      : [];
    let switched = false;
    try {
      for (const result of importedSkills) {
        if (result.action === "skipped") continue;
        await db.update(organizationSkills).set({
          metadata: {
            ...asRecord(result.skill.metadata),
            sourceKind: "plugin_managed",
            pluginManaged: true,
            pluginEnabled: current.enabled,
            pluginDisplayName: asString(asRecord(packageRow.normalizedManifest).displayName) ?? packageRow.name,
            installedPluginId: current.id,
            pluginPackageId: packageRow.id,
            pluginDigest: packageRow.digest,
          },
          updatedAt: new Date(),
        }).where(and(eq(organizationSkills.orgId, orgId), eq(organizationSkills.id, result.skill.id)));
      }
      const oldByKey = new Map(current.components.map((component) => [component.key, component]));
      const existingRetiredMcpLinks = await db.select().from(pluginComponentLinks)
        .where(and(
          eq(pluginComponentLinks.orgId, orgId),
          eq(pluginComponentLinks.installedPluginId, current.id),
          eq(pluginComponentLinks.componentType, "mcp"),
        ))
        .then((rows) => rows.filter((link) => asRecord(link.metadata).retired === true));
      const linkValues: Array<typeof pluginComponentLinks.$inferInsert> = [];
      for (const result of importedSkills) {
        const declared = report.components.find((component) => (
          component.type === "skill" && asString(component.metadata.slug) === result.originalSlug
        ));
        const componentKey = declared?.key ?? `skill:${result.originalSlug}`;
        const old = oldByKey.get(componentKey);
        linkValues.push({
          orgId,
          installedPluginId: current.id,
          componentType: "skill",
          componentKey,
          displayName: result.skill.name,
          status: result.action === "skipped" ? "disabled" : current.enabled ? "ready" : "disabled",
          targetId: result.action === "skipped" ? null : result.skill.id,
          metadata: {
            skillKey: result.skill.key,
            originalSlug: result.originalSlug,
            action: result.action,
            ...(result.action === "skipped" ? { keptExistingSkillId: result.skill.id } : {}),
            enabledAgentIds: Array.isArray(old?.metadata.enabledAgentIds) ? old.metadata.enabledAgentIds : [],
          },
        });
      }
      for (const component of report.components.filter((entry) => entry.type !== "skill")) {
        const old = oldByKey.get(component.key);
        const definitionUnchanged = component.type !== "mcp"
          || JSON.stringify(old?.metadata.definition ?? null) === JSON.stringify(component.metadata.definition ?? null);
        const reusableRetiredMcp = component.type === "mcp" && !definitionUnchanged
          ? existingRetiredMcpLinks.find((link) => (
            asString(asRecord(link.metadata).previousComponentKey) === component.key
            && JSON.stringify(asRecord(link.metadata).definition ?? null)
              === JSON.stringify(component.metadata.definition ?? null)
          ))
          : null;
        linkValues.push({
          orgId,
          installedPluginId: current.id,
          componentType: component.type,
          componentKey: component.key,
          displayName: component.name,
          status: current.enabled ? component.status : "disabled",
          targetId: definitionUnchanged
            ? old?.targetId ?? null
            : reusableRetiredMcp?.targetId ?? null,
          metadata: component.metadata,
        });
      }
      const retainedMcpTargets = new Set(linkValues
        .filter((link) => link.componentType === "mcp" && link.targetId)
        .map((link) => link.targetId));
      const retiredAt = new Date().toISOString();
      const newlyRetiredMcpLinks = current.components
        .filter((component) => (
          component.type === "mcp"
          && component.targetId
          && !retainedMcpTargets.has(component.targetId)
        ))
        .map((component) => ({
          orgId,
          installedPluginId: current.id,
          componentType: "mcp",
          componentKey: `retired:${component.targetId}`,
          displayName: component.displayName,
          status: "disabled",
          targetId: component.targetId,
          metadata: {
            ...component.metadata,
            retired: true,
            retiredAt,
            retiredReason: "package_revision",
            previousComponentKey: component.key,
          },
        } satisfies typeof pluginComponentLinks.$inferInsert));
      for (const retired of [...existingRetiredMcpLinks, ...newlyRetiredMcpLinks]) {
        if (
          linkValues.some((link) => link.componentKey === retired.componentKey)
          || (retired.targetId && retainedMcpTargets.has(retired.targetId))
        ) continue;
        linkValues.push({
          orgId,
          installedPluginId: current.id,
          componentType: "mcp",
          componentKey: retired.componentKey,
          displayName: retired.displayName,
          status: "disabled",
          targetId: retired.targetId,
          metadata: retired.metadata,
        });
      }
      const supported = report.components.filter((component) => component.status !== "unsupported");
      const setupRequired = supported.some((component) => component.status === "setup_required");
      await db.transaction(async (tx) => {
        await tx.delete(pluginComponentLinks).where(and(
          eq(pluginComponentLinks.orgId, orgId),
          eq(pluginComponentLinks.installedPluginId, current.id),
        ));
        if (linkValues.length > 0) await tx.insert(pluginComponentLinks).values(linkValues);
        await tx.update(installedPlugins).set({
          packageId: packageRow.id,
          previousPackageId: current.packageId,
          sourceId,
          setupState: supported.length === 0 ? "blocked" : setupRequired ? "setup_required" : "ready",
          healthState: supported.length === 0 ? "unavailable" : report.warnings.length > 0 ? "degraded" : "healthy",
          updateState: "none",
          lastOperation: { kind: operation, result: "succeeded", fromPackageId: current.packageId, toPackageId: packageRow.id, at: new Date().toISOString() },
          updatedAt: new Date(),
        }).where(and(eq(installedPlugins.orgId, orgId), eq(installedPlugins.id, current.id)));
      });
      switched = true;
      for (const component of current.components.filter((entry) => entry.type === "skill" && entry.targetId)) {
        await skills.deletePluginManagedSkill(orgId, component.targetId!, current.id);
      }
      for (const link of linkValues.filter((entry) => entry.componentType === "skill" && entry.targetId)) {
        const skill = await db.select().from(organizationSkills).where(eq(organizationSkills.id, link.targetId!)).then((rows) => rows[0] ?? null);
        const agentIds = Array.isArray(link.metadata?.enabledAgentIds)
          ? link.metadata.enabledAgentIds.filter((value): value is string => typeof value === "string")
          : [];
        if (skill) for (const agentId of agentIds) await enabledSkills.addMissingKeys(orgId, agentId, [skill.key]);
      }
      return (await getInstalled(orgId, current.id))!;
    } catch (error) {
      if (!switched) {
        for (const result of importedSkills) {
          await skills.deletePluginManagedSkill(orgId, result.skill.id, current.id).catch(() => null);
        }
      } else {
        await db.update(installedPlugins).set({
          healthState: "degraded",
          lastOperation: { kind: operation, result: "cleanup_failed", message: error instanceof Error ? error.message : String(error), at: new Date().toISOString() },
          updatedAt: new Date(),
        }).where(and(eq(installedPlugins.orgId, orgId), eq(installedPlugins.id, current.id)));
      }
      throw error;
    }
  }

  async function install(
    orgId: string,
    reportId: string,
    enabled = true,
    confirmAccessExpansion = false,
    skillConflictStrategy?: RudderPluginSkillConflictStrategy,
  ): Promise<RudderInstalledPlugin> {
    const reportRow = await db.select().from(pluginImportReports)
      .where(and(eq(pluginImportReports.orgId, orgId), eq(pluginImportReports.id, reportId)))
      .then((rows) => rows[0] ?? null);
    if (!reportRow) throw notFound("Plugin import report not found");
    if (reportRow.status !== "review_required" || !reportRow.packageId) {
      throw unprocessable("Plugin import is not ready for installation");
    }
    const packageRow = await db.select().from(pluginPackages)
      .where(eq(pluginPackages.id, reportRow.packageId))
      .then((rows) => rows[0] ?? null);
    if (!packageRow) throw notFound("Plugin package snapshot not found");
    const normalizedManifest = asRecord(packageRow.normalizedManifest);
    const sourceRow = reportRow.sourceId
      ? await db.select().from(pluginSources).where(eq(pluginSources.id, reportRow.sourceId)).then((rows) => rows[0] ?? null)
      : null;
    const installSourceNamespace = asString(sourceRow?.metadata.marketplaceName)
      ? `${reportRow.sourceType}:${asString(sourceRow?.metadata.marketplaceName)}`
      : reportRow.sourceType;
    const installedIdentity = packageIdentityKey(
      installSourceNamespace,
      asString(normalizedManifest.publisher),
      packageRow.name,
    );
    const existing = await db.select({ id: installedPlugins.id }).from(installedPlugins)
      .where(and(eq(installedPlugins.orgId, orgId), eq(installedPlugins.packageName, installedIdentity), ne(installedPlugins.lifecycleState, "uninstalled")))
      .then((rows) => rows[0] ?? null);
    const report = packageRow.compatibility as unknown as StoredReport;
    const importReport = reportRow.report as unknown as StoredReport;
    if (importReport.operation === "update" && importReport.capabilityDiff?.accessExpansion && !confirmAccessExpansion) {
      throw unprocessable("This Plugin update expands execution or external access. Confirm the reviewed access expansion before applying it.");
    }
    if ((importReport.skillConflicts?.length ?? 0) > 0 && !skillConflictStrategy) {
      throw unprocessable("Choose keep, replace, or rename for the reported Skill conflicts before installing");
    }
    const resolvedSkillConflictStrategy = skillConflictStrategy ?? "rename";
    if (existing) {
      if (importReport.operation === "update" && importReport.installedPluginId === existing.id) {
        const updated = await applyPackageRevision(
          orgId,
          existing.id,
          packageRow,
          reportRow.sourceId,
          "update",
          resolvedSkillConflictStrategy,
        );
        await db.update(pluginImportReports).set({ status: "accepted", updatedAt: new Date() })
          .where(and(eq(pluginImportReports.orgId, orgId), eq(pluginImportReports.id, reportRow.id)));
        return updated;
      }
      throw conflict("Plugin is already installed in this Organization");
    }

    const supported = report.components.filter((component) => component.status !== "unsupported");
    const setupRequired = supported.some((component) => component.status === "setup_required");
    const [installed] = await db.insert(installedPlugins).values({
      orgId,
      packageId: packageRow.id,
      sourceId: reportRow.sourceId,
      packageName: installedIdentity,
      enabled,
      setupState: "configuring",
      healthState: "unknown",
      lastOperation: { kind: "install", result: "running", at: new Date().toISOString() },
    }).returning();

    const importedSkillIds: string[] = [];
    try {
      const snapshot = packageRow.snapshot as SnapshotFile[];
      const skillRoots = report.components
        .filter((component) => component.type === "skill")
        .map((component) => asString(component.metadata.root))
        .filter((root): root is string => Boolean(root));
      const packageFiles = Object.fromEntries(snapshot
        .filter((file) => skillRoots.some((root) => file.path === `${root}/SKILL.md` || file.path.startsWith(`${root}/`)))
        .map((file) => [file.path, Buffer.from(file.content, "base64").toString("utf8")]));
      const importedSkills = report.components.some((component) => component.type === "skill")
        ? await skills.importPackageFiles(orgId, packageFiles, {
          onConflict: resolvedSkillConflictStrategy === "keep" ? "skip" : resolvedSkillConflictStrategy,
        })
        : [];
      for (const result of importedSkills) {
        if (result.action !== "skipped") {
          importedSkillIds.push(result.skill.id);
          const currentMetadata = asRecord(result.skill.metadata);
          await db.update(organizationSkills).set({
            metadata: {
              ...currentMetadata,
              sourceKind: "plugin_managed",
              pluginManaged: true,
              pluginEnabled: enabled,
              pluginDisplayName: asString(asRecord(packageRow.normalizedManifest).displayName) ?? packageRow.name,
              installedPluginId: installed!.id,
              pluginPackageId: packageRow.id,
              pluginDigest: packageRow.digest,
            },
            updatedAt: new Date(),
          }).where(and(eq(organizationSkills.orgId, orgId), eq(organizationSkills.id, result.skill.id)));
        }
        await db.insert(pluginComponentLinks).values({
          orgId,
          installedPluginId: installed!.id,
          componentType: "skill",
          componentKey: result.originalKey,
          displayName: result.skill.name,
          status: result.action === "skipped" ? "disabled" : enabled ? "ready" : "disabled",
          targetId: result.action === "skipped" ? null : result.skill.id,
          metadata: {
            skillKey: result.skill.key,
            originalSlug: result.originalSlug,
            action: result.action,
            ...(result.action === "skipped" ? { keptExistingSkillId: result.skill.id } : {}),
          },
        });
      }
      for (const component of report.components.filter((entry) => entry.type !== "skill")) {
        await db.insert(pluginComponentLinks).values({
          orgId,
          installedPluginId: installed!.id,
          componentType: component.type,
          componentKey: component.key,
          displayName: component.name,
          status: enabled ? component.status : "disabled",
          metadata: component.metadata,
        });
      }
      await db.update(installedPlugins).set({
        setupState: supported.length === 0 ? "blocked" : setupRequired ? "setup_required" : "ready",
        healthState: supported.length === 0 ? "unavailable" : report.warnings.length > 0 ? "degraded" : "healthy",
        lastOperation: { kind: "install", result: "succeeded", at: new Date().toISOString() },
        updatedAt: new Date(),
      }).where(eq(installedPlugins.id, installed!.id));
      await db.update(pluginImportReports).set({ status: "accepted", updatedAt: new Date() })
        .where(eq(pluginImportReports.id, reportRow.id));
    } catch (error) {
      for (const skillId of importedSkillIds) {
        await skills.deletePluginManagedSkill(orgId, skillId, installed!.id).catch(() => null);
      }
      await db.delete(installedPlugins).where(and(
        eq(installedPlugins.orgId, orgId),
        eq(installedPlugins.id, installed!.id),
      ));
      throw error;
    }
    return (await getInstalled(orgId, installed!.id))!;
  }

  async function reconcileMcpState(orgId: string) {
    const links = await db.select().from(pluginComponentLinks)
      .where(and(eq(pluginComponentLinks.orgId, orgId), eq(pluginComponentLinks.componentType, "mcp")));
    const targetIds = links.map((link) => link.targetId).filter((id): id is string => Boolean(id));
    const connections = targetIds.length === 0 ? [] : await db.select().from(mcpConnectionRows)
      .where(and(eq(mcpConnectionRows.orgId, orgId), inArray(mcpConnectionRows.id, targetIds)));
    const installations = await db.select().from(installedPlugins)
      .where(and(eq(installedPlugins.orgId, orgId), ne(installedPlugins.lifecycleState, "uninstalled")));
    for (const link of links) {
      const installation = installations.find((entry) => entry.id === link.installedPluginId);
      if (!installation) continue;
      if (asRecord(link.metadata).retired === true) {
        if (link.status !== "disabled") {
          await db.update(pluginComponentLinks).set({ status: "disabled", updatedAt: new Date() })
            .where(and(eq(pluginComponentLinks.orgId, orgId), eq(pluginComponentLinks.id, link.id)));
        }
        continue;
      }
      const connection = connections.find((entry) => entry.id === link.targetId);
      const nextStatus = !installation.enabled
        ? "disabled"
        : connection?.status === "active" && connection.enabled
          ? "ready"
          : "setup_required";
      if (link.status !== nextStatus) {
        await db.update(pluginComponentLinks).set({ status: nextStatus, updatedAt: new Date() })
          .where(and(eq(pluginComponentLinks.orgId, orgId), eq(pluginComponentLinks.id, link.id)));
      }
    }
    for (const installation of installations) {
      const ownedLinks = links.filter((link) => (
        link.installedPluginId === installation.id
        && asRecord(link.metadata).retired !== true
      ));
      const ownedConnections = ownedLinks
        .map((link) => connections.find((entry) => entry.id === link.targetId))
        .filter((entry): entry is typeof mcpConnectionRows.$inferSelect => Boolean(entry));
      const hasMcpError = ownedConnections.some((entry) => ["error", "needs_reauth", "revoked"].includes(entry.status));
      const hasMcpSetup = ownedLinks.some((link) => !link.targetId)
        || ownedConnections.some((entry) => entry.status !== "active" || !entry.enabled);
      if (!installation.enabled) continue;
      const setupState = hasMcpSetup ? "setup_required" : installation.setupState === "setup_required" ? "ready" : installation.setupState;
      const healthState = hasMcpError ? "degraded" : installation.healthState === "degraded" && ownedConnections.length > 0 ? "healthy" : installation.healthState;
      if (setupState !== installation.setupState || healthState !== installation.healthState) {
        await db.update(installedPlugins).set({ setupState, healthState, updatedAt: new Date() })
          .where(and(eq(installedPlugins.orgId, orgId), eq(installedPlugins.id, installation.id)));
      }
    }
  }

  async function listInstalled(orgId: string): Promise<RudderInstalledPlugin[]> {
    await reconcileMcpState(orgId);
    const rows = await db.select({
      installed: installedPlugins,
      pkg: pluginPackages,
      sourceLabel: pluginSources.label,
    }).from(installedPlugins)
      .innerJoin(pluginPackages, eq(installedPlugins.packageId, pluginPackages.id))
      .leftJoin(pluginSources, eq(installedPlugins.sourceId, pluginSources.id))
      .where(and(eq(installedPlugins.orgId, orgId), ne(installedPlugins.lifecycleState, "uninstalled")))
      .orderBy(asc(installedPlugins.packageName));
    const ids = rows.map((row) => row.installed.id);
    const links = ids.length === 0 ? [] : await db.select().from(pluginComponentLinks)
      .where(and(eq(pluginComponentLinks.orgId, orgId), inArray(pluginComponentLinks.installedPluginId, ids)))
      .orderBy(asc(pluginComponentLinks.componentType), asc(pluginComponentLinks.displayName));
    const pendingPackageIds = rows
      .map(({ installed }) => asString(asRecord(installed.lastOperation).pendingPackageId))
      .filter((id): id is string => Boolean(id));
    const pendingPackages = pendingPackageIds.length === 0 ? [] : await db.select().from(pluginPackages)
      .where(inArray(pluginPackages.id, pendingPackageIds));
    return rows.map(({ installed, pkg, sourceLabel }) => {
      const normalized = asRecord(pkg.normalizedManifest);
      const pendingPackageId = asString(asRecord(installed.lastOperation).pendingPackageId);
      const pendingPackage = pendingPackageId
        ? pendingPackages.find((candidate) => candidate.id === pendingPackageId) ?? null
        : null;
      const pendingNormalized = pendingPackage ? asRecord(pendingPackage.normalizedManifest) : null;
      return {
        id: installed.id,
        orgId: installed.orgId,
        packageId: pkg.id,
        previousPackageId: installed.previousPackageId,
        name: pkg.name,
        displayName: asString(normalized.displayName) ?? pkg.name,
        description: asString(normalized.shortDescription) ?? asString(normalized.description),
        version: pkg.version,
        publisher: asString(normalized.publisher),
        sourceLabel: sourceLabel ?? "Imported package",
        digest: pkg.digest,
        enabled: installed.enabled,
        lifecycleState: installed.lifecycleState as RudderInstalledPlugin["lifecycleState"],
        setupState: installed.setupState as RudderInstalledPlugin["setupState"],
        healthState: installed.healthState as RudderInstalledPlugin["healthState"],
        updateState: installed.updateState as RudderInstalledPlugin["updateState"],
        components: links.filter((link) => (
          link.installedPluginId === installed.id
          && asRecord(link.metadata).retired !== true
        )).map((link) => ({
          id: link.id,
          type: link.componentType as RudderInstalledPlugin["components"][number]["type"],
          key: link.componentKey,
          displayName: link.displayName,
          status: link.status as RudderInstalledPlugin["components"][number]["status"],
          targetId: link.targetId,
          metadata: link.metadata,
        })),
        manifest: pkg.rawManifest,
        pendingUpdate: pendingPackage && pendingNormalized ? {
          packageId: pendingPackage.id,
          version: pendingPackage.version,
          digest: pendingPackage.digest,
          displayName: asString(pendingNormalized.displayName) ?? pendingPackage.name,
          sourceLabel: asString(asRecord(installed.lastOperation).pendingSourceLabel) ?? "App Builder",
        } : null,
        installedAt: installed.installedAt.toISOString(),
        updatedAt: installed.updatedAt.toISOString(),
      };
    });
  }

  async function getInstalled(orgId: string, pluginId: string) {
    return (await listInstalled(orgId)).find((plugin) => plugin.id === pluginId) ?? null;
  }

  async function ensureLocalAppPlugins(orgId: string) {
    const apps = await db.select().from(appBuilderApps).where(eq(appBuilderApps.orgId, orgId));
    const activeProjections = await db.select({
      link: pluginComponentLinks,
      installed: installedPlugins,
      packageDigest: pluginPackages.digest,
    }).from(pluginComponentLinks)
      .innerJoin(installedPlugins, eq(pluginComponentLinks.installedPluginId, installedPlugins.id))
      .innerJoin(pluginPackages, eq(installedPlugins.packageId, pluginPackages.id))
      .where(and(
        eq(pluginComponentLinks.orgId, orgId),
        eq(pluginComponentLinks.componentType, "app"),
        ne(installedPlugins.lifecycleState, "uninstalled"),
      ));
    for (const app of apps) {
      const packageName = `local-app-${app.id}`;
      const revision = {
        appId: app.id,
        name: app.name,
        sourceRoot: app.sourceRoot,
        buildStatus: app.buildStatus,
        latestBuildRunId: app.latestBuildRunId,
        latestVerificationRunId: app.latestVerificationRunId,
        desktopInstallationId: app.desktopInstallationId,
        appPublicId: app.appPublicId,
        localBindingId: app.localBindingId,
        updatedAt: app.updatedAt.toISOString(),
      };
      const revisionDigest = createHash("sha256").update(JSON.stringify(revision)).digest("hex");
      const version = `0.0.0-local.${revisionDigest.slice(0, 12)}`;
      const rawManifest = {
        name: packageName,
        version,
        description: "Rudder Local App",
        interface: { displayName: app.name, developerName: "Rudder", category: "Local App" },
        rudder: { kind: "local_app", appId: app.id, revisionDigest },
      };
      const manifestContent = JSON.stringify(rawManifest);
      const digest = createHash("sha256").update(`rudder-local-app\0${orgId}\0${revisionDigest}\0${manifestContent}`).digest("hex");
      const status = app.buildStatus === "ready" ? "ready" : "setup_required";
      const componentMetadata = {
        projectionKind: "rudder_local_app",
        revisionDigest,
        appId: app.id,
        appKey: app.buildStatus === "ready" ? `managed:${app.id}` : null,
        buildStatus: app.buildStatus,
        sourceRoot: app.sourceRoot,
        desktopInstallationId: app.desktopInstallationId,
        appPublicId: app.appPublicId,
        localBindingId: app.localBindingId,
      };
      const compatibility: StoredReport = {
        manifest: rawManifest,
        components: [{
          key: `app:${app.id}`,
          type: "app",
          name: app.name,
          path: null,
          status,
          required: true,
          detail: "Rudder Local App managed by App Builder and Desktop.",
          metadata: componentMetadata,
        }],
        warnings: [],
        errors: [],
        limits: { fileCount: 1, totalBytes: Buffer.byteLength(manifestContent) },
        operation: "install",
        installedPluginId: null,
        capabilityDiff: null,
        skillConflicts: [],
      };
      const existingProjection = activeProjections.find((entry) => (
        entry.link.targetId === app.id
        && asString(asRecord(entry.link.metadata).projectionKind) === "rudder_local_app"
      ));
      if (existingProjection?.packageDigest === digest) {
        await db.update(pluginComponentLinks).set({
          displayName: app.name,
          status: existingProjection.installed.enabled ? status : "disabled",
          metadata: componentMetadata,
          updatedAt: new Date(),
        }).where(eq(pluginComponentLinks.id, existingProjection.link.id));
        continue;
      }
      if (asString(asRecord(existingProjection?.installed.lastOperation).pendingDigest) === digest) continue;

      const [source] = await db.insert(pluginSources).values({
        orgId,
        sourceType: "package",
        label: "App Builder",
        metadata: { kind: "rudder_local_app", appId: app.id, sourceRoot: app.sourceRoot, revisionDigest },
      }).returning();
      const existingPackage = await db.select().from(pluginPackages)
        .where(eq(pluginPackages.digest, digest))
        .then((rows) => rows[0] ?? null);
      const pkg = existingPackage ?? await db.insert(pluginPackages).values({
        sourceId: source!.id,
        name: packageName,
        version,
        digest,
        rawManifest,
        normalizedManifest: {
          name: packageName,
          version,
          description: "Rudder Local App",
          displayName: app.name,
          shortDescription: "Private interactive capability built in Rudder.",
          publisher: "Rudder",
          category: "Local App",
          capabilities: ["app"],
        },
        snapshot: [{ path: ".codex-plugin/plugin.json", content: Buffer.from(manifestContent).toString("base64"), encoding: "base64" }],
        compatibility: compatibility as unknown as Record<string, unknown>,
      }).returning().then((rows) => rows[0]!);

      if (existingProjection) {
        await db.update(installedPlugins).set({
          updateState: "review_required",
          lastOperation: {
            kind: "review_local_app_revision",
            result: "review_required",
            fromPackageId: existingProjection.installed.packageId,
            pendingPackageId: pkg.id,
            pendingSourceId: source!.id,
            pendingSourceLabel: "App Builder",
            pendingDigest: digest,
            pendingRevisionDigest: revisionDigest,
            at: new Date().toISOString(),
          },
          updatedAt: new Date(),
        }).where(and(
          eq(installedPlugins.orgId, orgId),
          eq(installedPlugins.id, existingProjection.installed.id),
        ));
        continue;
      }

      await db.transaction(async (tx) => {
        const raced = await tx.select({ id: pluginComponentLinks.id }).from(pluginComponentLinks)
          .innerJoin(installedPlugins, eq(pluginComponentLinks.installedPluginId, installedPlugins.id))
          .where(and(
            eq(pluginComponentLinks.orgId, orgId),
            eq(pluginComponentLinks.componentType, "app"),
            eq(pluginComponentLinks.targetId, app.id),
            ne(installedPlugins.lifecycleState, "uninstalled"),
          )).then((rows) => rows[0] ?? null);
        if (raced) return;
        const [installed] = await tx.insert(installedPlugins).values({
          orgId,
          packageId: pkg.id,
          sourceId: source!.id,
          packageName: packageIdentityKey("package", "Rudder", packageName),
          enabled: true,
          setupState: app.buildStatus === "ready" ? "ready" : "setup_required",
          healthState: app.buildStatus === "ready" ? "healthy" : "unknown",
          lastOperation: { kind: "project_local_app", result: "succeeded", revisionDigest, at: new Date().toISOString() },
        }).returning();
        await tx.insert(pluginComponentLinks).values({
          orgId,
          installedPluginId: installed!.id,
          componentType: "app",
          componentKey: `app:${app.id}`,
          displayName: app.name,
          status,
          targetId: app.id,
          metadata: componentMetadata,
        });
      });
    }
  }

  async function syncAllLocalApps() {
    const appOrganizations = await db.selectDistinct({ orgId: appBuilderApps.orgId })
      .from(appBuilderApps);
    for (const { orgId } of appOrganizations) {
      await ensureLocalAppPlugins(orgId);
    }
  }

  async function listLocalApps(orgId: string): Promise<RudderLocalAppPlugin[]> {
    void orgId;
    return [];
  }

  async function directory(orgId: string): Promise<RudderPluginDirectory> {
    await ensureLocalAppPlugins(orgId);
    const discover = await listDiscover(orgId);
    return {
      installed: await listInstalled(orgId),
      localApps: await listLocalApps(orgId),
      discover,
      discoverSource: discover.length > 0 ? "configured" : "none",
    };
  }

  async function applyPendingLocalAppUpdate(orgId: string, pluginId: string) {
    const row = await db.select().from(installedPlugins)
      .where(and(
        eq(installedPlugins.orgId, orgId),
        eq(installedPlugins.id, pluginId),
        ne(installedPlugins.lifecycleState, "uninstalled"),
      ))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Installed Plugin not found");
    const operation = asRecord(row.lastOperation);
    const packageId = asString(operation.pendingPackageId);
    if (!["review_required", "failed"].includes(row.updateState) || !packageId) {
      throw unprocessable("This Local App Plugin has no reviewed update to apply");
    }
    const pkg = await db.select().from(pluginPackages).where(eq(pluginPackages.id, packageId))
      .then((rows) => rows[0] ?? null);
    if (!pkg || asString(asRecord(asRecord(pkg.rawManifest).rudder).kind) !== "local_app") {
      throw unprocessable("Pending update is not a Rudder Local App revision");
    }
    const sourceId = asString(operation.pendingSourceId) ?? row.sourceId;
    await db.update(installedPlugins).set({ updateState: "applying", updatedAt: new Date() })
      .where(and(eq(installedPlugins.orgId, orgId), eq(installedPlugins.id, pluginId)));
    try {
      return await applyPackageRevision(orgId, pluginId, pkg, sourceId, "update");
    } catch (error) {
      await db.update(installedPlugins).set({
        updateState: "failed",
        lastOperation: {
          ...operation,
          result: "failed",
          message: error instanceof Error ? error.message : String(error),
          failedAt: new Date().toISOString(),
        },
        updatedAt: new Date(),
      }).where(and(eq(installedPlugins.orgId, orgId), eq(installedPlugins.id, pluginId)));
      throw error;
    }
  }

  async function setEnabled(orgId: string, pluginId: string, enabled: boolean) {
    const plugin = await getInstalled(orgId, pluginId);
    if (!plugin) throw notFound("Installed Plugin not found");
    const installedRow = await db.select({ lastOperation: installedPlugins.lastOperation }).from(installedPlugins)
      .where(and(eq(installedPlugins.orgId, orgId), eq(installedPlugins.id, pluginId)))
      .then((rows) => rows[0] ?? null);
    const skillLinks = plugin.components.filter((component) => component.type === "skill" && component.targetId);
    const skillIds = skillLinks.map((component) => component.targetId!);
    const skillRows = skillIds.length === 0 ? [] : await db.select().from(organizationSkills)
      .where(and(eq(organizationSkills.orgId, orgId), inArray(organizationSkills.id, skillIds)));
    if (!enabled) {
      const skillKeys = skillRows.map((skill) => skill.key);
      const selected = skillKeys.length === 0 ? [] : await db.select().from(agentEnabledSkills)
        .where(and(eq(agentEnabledSkills.orgId, orgId), inArray(agentEnabledSkills.skillKey, skillKeys)));
      for (const link of skillLinks) {
        const skill = skillRows.find((row) => row.id === link.targetId);
        if (!skill) continue;
        const enabledAgentIds = selected.filter((row) => row.skillKey === skill.key).map((row) => row.agentId);
        await db.update(pluginComponentLinks).set({
          status: "disabled",
          metadata: { ...link.metadata, enabledAgentIds },
          updatedAt: new Date(),
        }).where(eq(pluginComponentLinks.id, link.id));
      }
      await enabledSkills.removeSkillKeys(orgId, skillKeys);
    } else {
      for (const link of skillLinks) {
        const skill = skillRows.find((row) => row.id === link.targetId);
        if (!skill) continue;
        const agentIds = Array.isArray(link.metadata.enabledAgentIds)
          ? link.metadata.enabledAgentIds.filter((value): value is string => typeof value === "string")
          : [];
        for (const agentId of agentIds) await enabledSkills.addMissingKeys(orgId, agentId, [skill.key]);
        await db.update(pluginComponentLinks).set({ status: "ready", updatedAt: new Date() })
          .where(eq(pluginComponentLinks.id, link.id));
      }
    }
    for (const skill of skillRows) {
      await db.update(organizationSkills).set({
        metadata: { ...asRecord(skill.metadata), pluginEnabled: enabled },
        updatedAt: new Date(),
      }).where(eq(organizationSkills.id, skill.id));
    }
    if (!enabled) {
      await db.update(pluginComponentLinks).set({ status: "disabled", updatedAt: new Date() })
        .where(and(eq(pluginComponentLinks.installedPluginId, pluginId), eq(pluginComponentLinks.componentType, "mcp")));
    }
    await db.update(installedPlugins).set({
      enabled,
      lastOperation: {
        ...asRecord(installedRow?.lastOperation),
        kind: enabled ? "enable" : "disable",
        result: "succeeded",
        at: new Date().toISOString(),
      },
      updatedAt: new Date(),
    }).where(and(eq(installedPlugins.orgId, orgId), eq(installedPlugins.id, pluginId)));
    await reconcileMcpState(orgId);
    return (await getInstalled(orgId, pluginId))!;
  }

  async function configureSkills(orgId: string, pluginId: string, agentIds: string[]) {
    const plugin = await getInstalled(orgId, pluginId);
    if (!plugin) throw notFound("Installed Plugin not found");
    if (!plugin.enabled) throw unprocessable("Enable the Plugin before assigning its Skills");
    const validAgents = agentIds.length === 0 ? [] : await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.orgId, orgId), inArray(agents.id, agentIds)));
    if (validAgents.length !== new Set(agentIds).size) throw unprocessable("One or more Agents do not belong to this Organization");
    const skillIds = plugin.components.filter((component) => component.type === "skill" && component.targetId).map((component) => component.targetId!);
    const skillRows = skillIds.length === 0 ? [] : await db.select().from(organizationSkills)
      .where(and(eq(organizationSkills.orgId, orgId), inArray(organizationSkills.id, skillIds)));
    await enabledSkills.removeSkillKeys(orgId, skillRows.map((skill) => skill.key));
    for (const agentId of agentIds) await enabledSkills.addMissingKeys(orgId, agentId, skillRows.map((skill) => skill.key));
    for (const component of plugin.components.filter((entry) => entry.type === "skill")) {
      await db.update(pluginComponentLinks).set({
        metadata: { ...component.metadata, enabledAgentIds: agentIds },
        updatedAt: new Date(),
      }).where(and(eq(pluginComponentLinks.orgId, orgId), eq(pluginComponentLinks.id, component.id)));
    }
    return getInstalled(orgId, pluginId);
  }

  async function customizeSkill(orgId: string, pluginId: string, componentId: string) {
    const plugin = await getInstalled(orgId, pluginId);
    if (!plugin) throw notFound("Installed Plugin not found");
    const component = plugin.components.find((entry) => entry.id === componentId && entry.type === "skill");
    if (!component?.targetId) throw notFound("Plugin Skill component not found");
    const source = await db.select().from(organizationSkills)
      .where(and(eq(organizationSkills.orgId, orgId), eq(organizationSkills.id, component.targetId)))
      .then((rows) => rows[0] ?? null);
    if (!source) throw notFound("Plugin-managed Skill not found");
    const fork = await skills.createLocalSkill(orgId, {
      name: `${source.name} Custom`,
      slug: `${source.slug}-custom-${Date.now().toString(36)}`,
      description: source.description,
      markdown: source.markdown,
    });
    await db.update(organizationSkills).set({
      metadata: {
        ...asRecord(fork.metadata),
        sourceKind: "managed_local",
        forkedFromPluginId: plugin.id,
        forkedFromPackageId: plugin.packageId,
        forkedFromSkillId: source.id,
        forkedFromDigest: plugin.digest,
      },
      updatedAt: new Date(),
    }).where(and(eq(organizationSkills.orgId, orgId), eq(organizationSkills.id, fork.id)));
    return db.select().from(organizationSkills)
      .where(and(eq(organizationSkills.orgId, orgId), eq(organizationSkills.id, fork.id)))
      .then((rows) => rows[0]!);
  }

  async function configureMcp(orgId: string, pluginId: string, componentId: string, actor: { userId?: string | null; agentId?: string | null }) {
    const plugin = await getInstalled(orgId, pluginId);
    if (!plugin) throw notFound("Installed Plugin not found");
    const component = plugin.components.find((entry) => entry.id === componentId && entry.type === "mcp");
    if (!component) throw notFound("Plugin MCP component not found");
    if (component.targetId) return component;
    const definition = asRecord(component.metadata.definition);
    const transport = component.metadata.transport === "stdio" ? "stdio" : "streamable_http";
    const connectionName = safeName(`${plugin.name}-${asString(component.metadata.name) ?? component.displayName}`);
    const safeConfig = transport === "stdio"
      ? {
        command: asString(definition.command)!,
        ...(Array.isArray(definition.args) ? { args: definition.args.filter((value): value is string => typeof value === "string") } : {}),
        ...(asString(definition.cwd) ? { cwd: asString(definition.cwd)! } : {}),
        ...(definition.env && typeof definition.env === "object" ? {
          staticEnv: Object.fromEntries(Object.entries(asRecord(definition.env)).filter(([, value]) => typeof value === "string" && !/^\$\{/.test(value)).map(([key, value]) => [key, value as string])),
          forwardedEnv: Object.values(asRecord(definition.env)).filter((value): value is string => typeof value === "string" && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)).map((value) => value.slice(2, -1)),
        } : {}),
      }
      : { url: asString(definition.url)! };
    const connection = await mcpConnections.create(orgId, {
      name: connectionName,
      displayName: component.displayName,
      provider: "custom",
      scope: "organization",
      ownerAgentId: null,
      transport,
      accessMode: "provider_default",
      safeConfig,
      startupTimeoutMs: 10_000,
      toolTimeoutMs: 60_000,
      enabled: false,
      required: false,
    }, actor);
    await db.update(pluginComponentLinks).set({ targetId: connection.id, updatedAt: new Date() })
      .where(and(eq(pluginComponentLinks.orgId, orgId), eq(pluginComponentLinks.id, componentId)));
    return (await getInstalled(orgId, pluginId))!.components.find((entry) => entry.id === componentId)!;
  }

  async function listMcpUiResources(
    orgId: string,
    pluginId: string,
    componentId: string,
  ): Promise<RudderMcpUiResource[]> {
    const plugin = await getInstalled(orgId, pluginId);
    if (!plugin?.enabled) throw unprocessable("Enable the Plugin before opening MCP UI resources");
    const component = plugin.components.find((entry) => entry.id === componentId && entry.type === "mcp");
    if (!component?.targetId || component.status !== "ready") {
      throw unprocessable("Complete Managed MCP setup before opening UI resources");
    }
    const client = await mcpConnections.openRuntimeClient(orgId, component.targetId);
    try {
      return (await client.listResources())
        .filter((resource) => resource.mimeType?.toLowerCase().startsWith("text/html"))
        .map((resource) => ({
          uri: resource.uri,
          name: resource.title ?? resource.name ?? resource.uri,
          description: resource.description ?? null,
          mimeType: resource.mimeType!,
        }));
    } finally {
      await client.close();
    }
  }

  async function readMcpUiResource(
    orgId: string,
    pluginId: string,
    componentId: string,
    uri: string,
  ) {
    const resources = await listMcpUiResources(orgId, pluginId, componentId);
    const resource = resources.find((entry) => entry.uri === uri);
    if (!resource) throw notFound("MCP UI resource not found");
    const plugin = await getInstalled(orgId, pluginId);
    const component = plugin!.components.find((entry) => entry.id === componentId)!;
    const client = await mcpConnections.openRuntimeClient(orgId, component.targetId!);
    try {
      const result = await client.readResource(uri);
      const content = result.contents.find((entry) => entry.uri === uri && typeof entry.text === "string");
      if (!content?.text) throw unprocessable("MCP UI resource did not return HTML text content");
      if (!(content.mimeType ?? resource.mimeType).toLowerCase().startsWith("text/html")) {
        throw unprocessable("MCP resource is not a supported HTML UI resource");
      }
      if (Buffer.byteLength(content.text, "utf8") > MAX_MCP_UI_HTML_BYTES) {
        throw unprocessable("MCP HTML UI resource exceeds the 2 MiB display limit");
      }
      return { ...resource, html: content.text };
    } finally {
      await client.close();
    }
  }

  async function uninstall(orgId: string, pluginId: string) {
    const plugin = await getInstalled(orgId, pluginId);
    if (!plugin) throw notFound("Installed Plugin not found");
    await setEnabled(orgId, pluginId, false);
    const skillIds = plugin.components.filter((component) => component.type === "skill" && component.targetId).map((component) => component.targetId!);
    for (const skillId of skillIds) {
      await skills.deletePluginManagedSkill(orgId, skillId, pluginId);
    }
    await db.update(installedPlugins).set({
      lifecycleState: "uninstalled",
      enabled: false,
      lastOperation: { kind: "uninstall", result: "succeeded", preservedTargets: plugin.components.filter((component) => component.type !== "skill" && component.targetId).map((component) => component.targetId), at: new Date().toISOString() },
      updatedAt: new Date(),
    }).where(and(eq(installedPlugins.orgId, orgId), eq(installedPlugins.id, pluginId)));
    return { id: pluginId, uninstalled: true as const };
  }

  async function rollback(orgId: string, pluginId: string) {
    const row = await db.select().from(installedPlugins)
      .where(and(eq(installedPlugins.orgId, orgId), eq(installedPlugins.id, pluginId), ne(installedPlugins.lifecycleState, "uninstalled")))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Installed Plugin not found");
    if (!row.previousPackageId) throw unprocessable("No previous Plugin package is available for rollback");
    const pkg = await db.select().from(pluginPackages).where(eq(pluginPackages.id, row.previousPackageId))
      .then((rows) => rows[0] ?? null);
    if (!pkg) throw notFound("Previous Plugin package snapshot not found");
    return applyPackageRevision(orgId, pluginId, pkg, row.sourceId, "rollback");
  }

  return {
    applyPendingLocalAppUpdate,
    configureMarketplace,
    configureMcp,
    configureSkills,
    customizeSkill,
    directory,
    getImportReport,
    getInstalled,
    inspect,
    inspectArchive,
    install,
    listInstalled,
    listMcpUiResources,
    readMcpUiResource,
    rollback,
    setEnabled,
    syncAllLocalApps,
    syncLocalApps: ensureLocalAppPlugins,
    uninstall,
  };
}
