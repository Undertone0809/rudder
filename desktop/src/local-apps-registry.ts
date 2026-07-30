import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import {
  discoverLocalAppIcon,
  isSafeLocalAppIconDataUrl,
} from "./local-app-icon-discovery.js";
import { isSafeLocalAppProcessId } from "./local-app-process-identity.mjs";

export type LocalAppDefinitionDraft = {
  title: string;
  executable: string;
  argv: string[];
  cwd: string;
  inheritedEnvNames: string[];
  readiness: { path: string; timeoutMs: number };
  openPath: string;
};

export type PreparedLocalAppDefinition = LocalAppDefinitionDraft & {
  trustFingerprint: string;
  iconDataUrl: string | null;
};

export type LocalAppDefinition = PreparedLocalAppDefinition & {
  id: string;
  desktopInstallationId: string;
  appPublicId: string;
  localBindingId: string;
  approvedFingerprint: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LocalAppPersistedRuntimeStatus =
  | "starting"
  | "running"
  | "stopping"
  | "failed"
  | "orphaned_unverified"
  | "quarantined";

export type LocalAppRuntimeDescriptor = {
  status: LocalAppPersistedRuntimeStatus;
  pid: number | null;
  pgid: number | null;
  generation: string;
  port?: number;
};

type RegistryState = {
  version: 1;
  installationId: string;
  definitions: LocalAppDefinition[];
  runtimeDescriptors: Record<string, LocalAppRuntimeDescriptor>;
};

const REGISTRY_VERSION = 1 as const;
const MAX_TITLE_LENGTH = 200;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_LENGTH = 4_096;
const MAX_ENV_NAMES = 64;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OWNED_RUNTIME_STATUSES = new Set<LocalAppPersistedRuntimeStatus>([
  "starting",
  "running",
  "stopping",
  "orphaned_unverified",
]);
const OWNERLESS_RUNTIME_STATUSES = new Set<LocalAppPersistedRuntimeStatus>([
  "failed",
  "quarantined",
]);

function requireBoundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.includes("\0")) {
    throw new Error(`Invalid Local App ${label}`);
  }
  return value;
}

function normalizeRoute(value: unknown, label: string): string {
  const route = requireBoundedString(value, label, 2_048);
  if (!route.startsWith("/")
    || route.startsWith("//")
    || route.includes("://")
    || /[\\\u0000-\u001f\u007f]/.test(route)) {
    throw new Error(`Invalid Local App ${label}`);
  }
  const loopbackBase = "http://127.0.0.1";
  const parsed = new URL(route, loopbackBase);
  if (parsed.origin !== loopbackBase || `${parsed.pathname}${parsed.search}${parsed.hash}` !== route) {
    throw new Error(`Invalid Local App ${label}`);
  }
  return route;
}

async function resolveExecutable(value: unknown, cwd: string): Promise<string> {
  const executable = requireBoundedString(value, "executable", 4_096);
  if (path.isAbsolute(executable)) {
    const resolved = await realpath(executable);
    await access(resolved, fsConstants.X_OK);
    return resolved;
  }

  if (executable.includes("/") || executable.includes("\\")) {
    const resolved = await realpath(path.resolve(cwd, executable));
    await access(resolved, fsConstants.X_OK);
    return resolved;
  }

  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, executable);
    try {
      await access(candidate, fsConstants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue through PATH without invoking a shell.
    }
  }
  throw new Error(`Local App executable was not found: ${executable}`);
}

async function normalizeDefinition(draft: LocalAppDefinitionDraft): Promise<LocalAppDefinitionDraft> {
  if (!draft || typeof draft !== "object") throw new Error("Invalid Local App definition");
  const cwdInput = requireBoundedString(draft.cwd, "working directory", 4_096);
  const cwd = await realpath(cwdInput);
  const executable = await resolveExecutable(draft.executable, cwd);

  if (!Array.isArray(draft.argv) || draft.argv.length > MAX_ARGUMENTS) {
    throw new Error("Invalid Local App arguments");
  }
  const argv = draft.argv.map((argument) => requireBoundedString(argument, "argument", MAX_ARGUMENT_LENGTH));

  if (!Array.isArray(draft.inheritedEnvNames) || draft.inheritedEnvNames.length > MAX_ENV_NAMES) {
    throw new Error("Invalid Local App environment variable names");
  }
  const inheritedEnvNames = [...new Set(draft.inheritedEnvNames.map((name) => {
    if (typeof name !== "string" || !ENV_NAME_PATTERN.test(name)) {
      throw new Error("Invalid Local App environment variable name");
    }
    return name;
  }))].sort();

  const timeoutMs = draft.readiness?.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 600_000) {
    throw new Error("Invalid Local App readiness timeout");
  }

  return {
    title: requireBoundedString(draft.title, "title", MAX_TITLE_LENGTH),
    executable,
    argv,
    cwd,
    inheritedEnvNames,
    readiness: {
      path: normalizeRoute(draft.readiness?.path, "readiness path"),
      timeoutMs,
    },
    openPath: normalizeRoute(draft.openPath, "open path"),
  };
}

export async function computeLocalAppTrustFingerprint(
  draft: LocalAppDefinitionDraft,
): Promise<{ definition: LocalAppDefinitionDraft; fingerprint: string }> {
  const definition = await normalizeDefinition(draft);
  const fingerprint = createHash("sha256").update(JSON.stringify({
    executable: definition.executable,
    argv: definition.argv,
    cwd: definition.cwd,
    inheritedEnvNames: definition.inheritedEnvNames,
    readiness: definition.readiness,
    openPath: definition.openPath,
  })).digest("hex");
  return { definition, fingerprint };
}

function isRuntimeDescriptor(value: unknown): value is LocalAppRuntimeDescriptor {
  if (!value || typeof value !== "object") return false;
  const descriptor = value as Partial<LocalAppRuntimeDescriptor>;
  if (typeof descriptor.status !== "string"
    || (!OWNED_RUNTIME_STATUSES.has(descriptor.status as LocalAppPersistedRuntimeStatus)
      && !OWNERLESS_RUNTIME_STATUSES.has(descriptor.status as LocalAppPersistedRuntimeStatus))
    || typeof descriptor.generation !== "string"
    || descriptor.generation.length === 0
    || descriptor.generation.length > 200
    || descriptor.generation.includes("\0")) return false;
  if (OWNED_RUNTIME_STATUSES.has(descriptor.status as LocalAppPersistedRuntimeStatus)) {
    return isSafeLocalAppProcessId(descriptor.pid)
      && isSafeLocalAppProcessId(descriptor.pgid)
      && Number.isInteger(descriptor.port)
      && descriptor.port! > 0
      && descriptor.port! <= 65_535;
  }
  return descriptor.pid === null && descriptor.pgid === null && descriptor.port === undefined;
}

function quarantinedRuntimeDescriptor(value: unknown): LocalAppRuntimeDescriptor {
  const descriptor = value && typeof value === "object"
    ? value as Partial<LocalAppRuntimeDescriptor>
    : null;
  const generation = typeof descriptor?.generation === "string"
    && descriptor.generation.length > 0
    && descriptor.generation.length <= 200
    && !descriptor.generation.includes("\0")
    ? descriptor.generation
    : randomUUID();
  const pid = descriptor?.pid;
  const pgid = descriptor?.pgid;
  const port = descriptor?.port;
  if (isSafeLocalAppProcessId(pid)
    && isSafeLocalAppProcessId(pgid)
    && Number.isInteger(port)
    && port! > 0
    && port! <= 65_535) {
    return {
      status: "orphaned_unverified",
      pid,
      pgid,
      port,
      generation,
    };
  }
  return { status: "quarantined", pid: null, pgid: null, generation };
}

function isDefinition(value: unknown): value is LocalAppDefinition {
  if (!value || typeof value !== "object") return false;
  const definition = value as Partial<LocalAppDefinition>;
  return typeof definition.id === "string"
    && typeof definition.desktopInstallationId === "string"
    && typeof definition.appPublicId === "string"
    && typeof definition.localBindingId === "string"
    && definition.localBindingId === definition.id
    && new Set([definition.desktopInstallationId, definition.appPublicId, definition.localBindingId]).size === 3
    && typeof definition.title === "string"
    && typeof definition.executable === "string"
    && Array.isArray(definition.argv)
    && typeof definition.cwd === "string"
    && Array.isArray(definition.inheritedEnvNames)
    && typeof definition.trustFingerprint === "string"
    && (definition.iconDataUrl === undefined || definition.iconDataUrl === null
      || isSafeLocalAppIconDataUrl(definition.iconDataUrl))
    && (definition.approvedFingerprint === null || typeof definition.approvedFingerprint === "string")
    && typeof definition.createdAt === "string"
    && typeof definition.updatedAt === "string";
}

export class LocalAppRegistry {
  readonly installationId: string;
  private readonly registryPath: string;
  private statePromise: Promise<RegistryState> | null = null;
  private writeQueue = Promise.resolve();

  constructor(options: { registryPath: string; installationId: string }) {
    this.registryPath = options.registryPath;
    this.installationId = requireBoundedString(options.installationId, "installation id", 200);
  }

  private emptyState(): RegistryState {
    return {
      version: REGISTRY_VERSION,
      installationId: this.installationId,
      definitions: [],
      runtimeDescriptors: {},
    };
  }

  private async load(): Promise<RegistryState> {
    if (!this.statePromise) this.statePromise = this.loadFromDisk();
    return this.statePromise;
  }

  private async loadFromDisk(): Promise<RegistryState> {
    try {
      const raw = JSON.parse(await readFile(this.registryPath, "utf8")) as Partial<RegistryState>;
      if (raw.version !== REGISTRY_VERSION
        || raw.installationId !== this.installationId
        || !Array.isArray(raw.definitions)
        || !raw.definitions.every(isDefinition)
        || !raw.definitions.every((definition) => definition.desktopInstallationId === this.installationId)) {
        throw new Error("Invalid Local App registry");
      }
      const definitionIds = new Set(raw.definitions.map((definition) => definition.id));
      if (definitionIds.size !== raw.definitions.length) {
        throw new Error("Invalid Local App registry identity references");
      }
      for (const definition of raw.definitions) {
        const computed = await computeLocalAppTrustFingerprint(definition);
        if (computed.fingerprint !== definition.trustFingerprint
          || (definition.approvedFingerprint !== null && definition.approvedFingerprint !== computed.fingerprint)
          || JSON.stringify(computed.definition) !== JSON.stringify({
            title: definition.title,
            executable: definition.executable,
            argv: definition.argv,
            cwd: definition.cwd,
            inheritedEnvNames: definition.inheritedEnvNames,
            readiness: definition.readiness,
            openPath: definition.openPath,
          })) {
          throw new Error("Invalid Local App trust fingerprint");
        }
      }
      const definitions = await Promise.all(raw.definitions.map(async (definition) => ({
        ...definition,
        iconDataUrl: definition.iconDataUrl ?? await discoverLocalAppIcon(definition.cwd),
      })));

      let runtimeDescriptorCorruption = false;
      const runtimeDescriptors: Record<string, LocalAppRuntimeDescriptor> = {};
      const rawRuntimeDescriptors = raw.runtimeDescriptors;
      if (!rawRuntimeDescriptors
        || typeof rawRuntimeDescriptors !== "object"
        || Array.isArray(rawRuntimeDescriptors)) {
        runtimeDescriptorCorruption = true;
        for (const definition of raw.definitions) {
          runtimeDescriptors[definition.id] = quarantinedRuntimeDescriptor(null);
        }
      } else {
        for (const [id, descriptor] of Object.entries(rawRuntimeDescriptors)) {
          if (!definitionIds.has(id)) {
            runtimeDescriptorCorruption = true;
            continue;
          }
          if (isRuntimeDescriptor(descriptor)) runtimeDescriptors[id] = descriptor;
          else {
            runtimeDescriptorCorruption = true;
            runtimeDescriptors[id] = quarantinedRuntimeDescriptor(descriptor);
          }
        }
      }

      const state: RegistryState = {
        version: REGISTRY_VERSION,
        installationId: this.installationId,
        definitions,
        runtimeDescriptors,
      };
      if (runtimeDescriptorCorruption) {
        await mkdir(path.dirname(this.registryPath), { recursive: true, mode: 0o700 });
        await rename(this.registryPath, `${this.registryPath}.corrupt-${Date.now()}-${randomUUID()}`);
        await this.persist(state);
      } else {
        await chmod(this.registryPath, 0o600);
      }
      return state;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        await mkdir(path.dirname(this.registryPath), { recursive: true, mode: 0o700 });
        await rename(this.registryPath, `${this.registryPath}.corrupt-${Date.now()}-${randomUUID()}`).catch(() => undefined);
      }
      const state = this.emptyState();
      await this.persist(state);
      return state;
    }
  }

  private async persist(state: RegistryState): Promise<void> {
    const directory = path.dirname(this.registryPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryPath = `${this.registryPath}.${process.pid}.${randomUUID()}.tmp`;
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await file.sync();
      await file.close();
      await rename(temporaryPath, this.registryPath);
      await chmod(this.registryPath, 0o600);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      await file.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async mutate<T>(operation: (state: RegistryState) => Promise<T> | T): Promise<T> {
    let result!: T;
    let failure: unknown;
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        const state = await this.load();
        result = await operation(state);
        await this.persist(state);
      } catch (error) {
        failure = error;
      }
    });
    await this.writeQueue;
    if (failure) throw failure;
    return result;
  }

  async prepareDefinition(draft: LocalAppDefinitionDraft): Promise<PreparedLocalAppDefinition> {
    const prepared = await computeLocalAppTrustFingerprint(draft);
    return {
      ...prepared.definition,
      trustFingerprint: prepared.fingerprint,
      iconDataUrl: await discoverLocalAppIcon(prepared.definition.cwd),
    };
  }

  async createDefinition(input: LocalAppDefinitionDraft & { trustFingerprint?: string }): Promise<LocalAppDefinition> {
    const prepared = await this.prepareDefinition(input);
    if (input.trustFingerprint !== undefined && input.trustFingerprint !== prepared.trustFingerprint) {
      throw new Error("Local App definition changed after review");
    }
    const now = new Date().toISOString();
    const localBindingId = randomUUID();
    const definition: LocalAppDefinition = {
      ...prepared,
      id: localBindingId,
      desktopInstallationId: this.installationId,
      appPublicId: randomUUID(),
      localBindingId,
      // Approval is granted only by the Desktop-main native confirmation controller.
      // A renderer-provided fingerprint is review material, never authority.
      approvedFingerprint: null,
      createdAt: now,
      updatedAt: now,
    };
    return this.mutate((state) => {
      state.definitions.push(definition);
      return structuredClone(definition);
    });
  }

  async updateDefinition(id: string, input: LocalAppDefinitionDraft): Promise<LocalAppDefinition> {
    const prepared = await this.prepareDefinition(input);
    return this.mutate((state) => {
      const index = state.definitions.findIndex((definition) => definition.id === id);
      if (index < 0) throw new Error("Local App definition not found");
      const previous = state.definitions[index];
      const definition: LocalAppDefinition = {
        ...prepared,
        id: previous.id,
        desktopInstallationId: previous.desktopInstallationId,
        appPublicId: previous.appPublicId,
        localBindingId: previous.localBindingId,
        approvedFingerprint: previous.approvedFingerprint === prepared.trustFingerprint
          ? previous.approvedFingerprint
          : null,
        createdAt: previous.createdAt,
        updatedAt: new Date().toISOString(),
      };
      state.definitions[index] = definition;
      return structuredClone(definition);
    });
  }

  async approveDefinition(id: string, fingerprint: string): Promise<LocalAppDefinition> {
    return this.mutate((state) => {
      const definition = state.definitions.find((entry) => entry.id === id);
      if (!definition) throw new Error("Local App definition not found");
      if (fingerprint !== definition.trustFingerprint) throw new Error("Local App definition changed after review");
      definition.approvedFingerprint = fingerprint;
      definition.updatedAt = new Date().toISOString();
      return structuredClone(definition);
    });
  }

  async deleteDefinition(id: string): Promise<void> {
    await this.mutate((state) => {
      const index = state.definitions.findIndex((definition) => definition.id === id);
      if (index < 0) throw new Error("Local App definition not found");
      state.definitions.splice(index, 1);
      delete state.runtimeDescriptors[id];
    });
  }

  async listDefinitions(): Promise<LocalAppDefinition[]> {
    return structuredClone((await this.load()).definitions);
  }

  async getDefinition(id: string): Promise<LocalAppDefinition> {
    const definition = (await this.load()).definitions.find((entry) => entry.id === id);
    if (!definition) throw new Error("Local App definition not found");
    return structuredClone(definition);
  }

  async requireApprovedDefinition(id: string): Promise<LocalAppDefinition> {
    const definition = await this.getDefinition(id);
    if (!definition.approvedFingerprint || definition.approvedFingerprint !== definition.trustFingerprint) {
      throw new Error("Review changes before starting this Local App");
    }
    return definition;
  }

  async recordRuntimeDescriptor(id: string, descriptor: LocalAppRuntimeDescriptor | null): Promise<void> {
    await this.mutate((state) => {
      if (!state.definitions.some((definition) => definition.id === id)) {
        throw new Error("Local App definition not found");
      }
      if (descriptor === null) delete state.runtimeDescriptors[id];
      else if (!isRuntimeDescriptor(descriptor)) throw new Error("Invalid Local App runtime descriptor");
      else state.runtimeDescriptors[id] = structuredClone(descriptor);
    });
  }

  async recordRuntimeDescriptorIfGeneration(
    id: string,
    expectedGeneration: string | null,
    descriptor: LocalAppRuntimeDescriptor | null,
  ): Promise<boolean> {
    return this.recordRuntimeDescriptorIfMatch(
      id,
      expectedGeneration === null ? null : { generation: expectedGeneration },
      descriptor,
    );
  }

  async recordRuntimeDescriptorIfMatch(
    id: string,
    expected: { generation: string; status?: string | readonly string[] } | null,
    descriptor: LocalAppRuntimeDescriptor | null,
  ): Promise<boolean> {
    return this.mutate((state) => {
      if (!state.definitions.some((definition) => definition.id === id)) {
        throw new Error("Local App definition not found");
      }
      if (descriptor !== null && !isRuntimeDescriptor(descriptor)) {
        throw new Error("Invalid Local App runtime descriptor");
      }
      const current = state.runtimeDescriptors[id];
      const matches = expected === null
        ? current === undefined
        : current?.generation === expected.generation
          && (expected.status === undefined
            || (Array.isArray(expected.status)
              ? expected.status.includes(current.status)
              : current.status === expected.status));
      if (!matches) return false;
      if (descriptor === null) delete state.runtimeDescriptors[id];
      else state.runtimeDescriptors[id] = structuredClone(descriptor);
      return true;
    });
  }

  async getRuntimeDescriptor(id: string): Promise<LocalAppRuntimeDescriptor | null> {
    const descriptor = (await this.load()).runtimeDescriptors[id];
    return descriptor ? structuredClone(descriptor) : null;
  }
}
