import { resolveRudderNativeTarget } from "@rudderhq/shared";
import type { Request } from "express";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { accessSync, existsSync, constants as fsConstants, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { resolveOrganizationWorkspaceHomeDir, resolvePreviousDocumentsOrganizationWorkspaceRoot, resolveRudderInstanceRoot } from "../home-paths.js";
import { type RustAgentCreateCommand } from "./agent-create-bridge.js";
import { createRustActorEnvelope, type RustFoundationActor } from "./rust-actor-envelope.js";
import { RustFoundationBridgeError } from "./rust-foundation-bridge-error.js";
export { buildRustAgentCreateCommand, type RustAgentCreateCommand, type RustAgentCreateInput, type RustAgentCreateInstructionsBundle, type RustAgentCreateIntelligenceDefaults, type RustAgentCreateNodeOwned } from "./agent-create-bridge.js";
export type { CostReadInput, CostReadOperation } from "./cost-read-bridge.js";
export { createRustActorEnvelope, type RustFoundationActor } from "./rust-actor-envelope.js";
export { RustFoundationBridgeError } from "./rust-foundation-bridge-error.js";
export type {
  RustBrowserSessionAuth,
  RustNativeChatHost,
  RustPublicIngressOptions
} from "./rust-public-ingress-config.js";

import { requestActivityLinkRead, type ActivityLinkReadInput } from "./activity-link-read-bridge.js";
import { requestActivityRead, type ActivityReadInput } from "./activity-read-bridge.js";
import { requestApprovalRead, type ApprovalReadInput } from "./approval-read-bridge.js";
import { requestAutomationRead, type AutomationReadInput } from "./automation-read-bridge.js";
import { requestCostRead, type CostReadInput } from "./cost-read-bridge.js";
import { requestIssueMetadataRead, type IssueMetadataReadInput } from "./issue-metadata-read-bridge.js";
import type { LiveRunReadInput } from "./live-run-read-bridge.js";
import { messengerAuditContext, type MessengerStateInput } from "./messenger-state-bridge.js";
import { requestNativeChatMessages, type NativeChatMessageReaderInput } from "./native-chat-message-reader-bridge.js";
import { requestNativeChatTranscript, type NativeChatTranscriptInput } from "./native-chat-transcript-bridge.js";
import { requestOrganizationCatalogRead, type OrganizationCatalogReadInput } from "./organization-catalog-read-bridge.js";
import { requestOverviewRead, type OverviewReadInput } from "./overview-read-bridge.js";
import { requestRequestRead, type RequestReadInput } from "./request-read-bridge.js";
import type { RunReadInput } from "./run-read-bridge.js";
import { encodeRunWorkspaceOrdinaryUpdate } from "./run-workspace-ordinary-wire.js";
import { requestRunWorkspaceRead, type RunWorkspaceReadInput } from "./run-workspace-read-bridge.js";
import { requestRuntimeBinding, type RuntimeBindingInput } from "./runtime-binding-bridge.js";
import {
  nativeIdentityAuthEnvironment,
  nativeLocalAccountLifecycleEnvironment,
  nativeSessionAuthEnvironment,
  type RustPublicIngressOptions,
} from "./rust-public-ingress-config.js";

export type RustFoundationMode = "off" | "shadow" | "required";

export type RustFoundationBridgeOptions = {
  databaseUrl: string;
  mode?: RustFoundationMode;
  organizationBrandingMode?: RustFoundationMode;
  projectGoalSetMode?: RustFoundationMode;
  binaryPath?: string;
  actorEnvelopeKey?: string;
  requestTimeoutMs?: number;
  workspaceBackupListTimeoutMs?: number;
  publicIngress?: RustPublicIngressOptions;
};

export type RustFoundationResponse = {
  status: number;
  contentType: string;
  body: Buffer;
};

export interface RustFoundationBridge {
  runtimeBinding?(actor: RustFoundationActor, orgId: string, input: RuntimeBindingInput): Promise<RustFoundationResponse>;
  nativeChatTranscript?(actor: RustFoundationActor, orgId: string, input: NativeChatTranscriptInput): Promise<RustFoundationResponse>;
  nativeChatMessages?(actor: RustFoundationActor, orgId: string, input: NativeChatMessageReaderInput): Promise<RustFoundationResponse>;
  automationRead?(actor: RustFoundationActor, orgId: string, input: AutomationReadInput): Promise<RustFoundationResponse>;
  activityLinkRead?(actor: RustFoundationActor, orgId: string, input: ActivityLinkReadInput): Promise<RustFoundationResponse>;
  issueMetadataRead?(actor: RustFoundationActor, orgId: string, input: IssueMetadataReadInput): Promise<RustFoundationResponse>;
  organizationCatalogRead?(actor: RustFoundationActor, orgId: string, input: OrganizationCatalogReadInput): Promise<RustFoundationResponse>;
  approvalRead?(actor: RustFoundationActor, orgId: string, input: ApprovalReadInput): Promise<RustFoundationResponse>;
  requestRead?(actor: RustFoundationActor, orgId: string, input: RequestReadInput): Promise<RustFoundationResponse>;
  overviewRead?(actor: RustFoundationActor, orgId: string, input: OverviewReadInput): Promise<RustFoundationResponse>;
  runWorkspaceRead?(actor: RustFoundationActor, orgId: string, input: RunWorkspaceReadInput): Promise<RustFoundationResponse>;
  activityRead?(actor: RustFoundationActor, orgId: string, input: ActivityReadInput): Promise<RustFoundationResponse>;
  runWorkspaceOrdinaryUpdate?(actor: RustFoundationActor, input: Record<string, unknown>): Promise<RustFoundationResponse>;
  agentCore?(actor: RustFoundationActor, input: Record<string, unknown>): Promise<RustFoundationResponse>;
  agentInstructions?(actor: RustFoundationActor, input: Record<string, unknown>): Promise<RustFoundationResponse>;
  agentCreate?(actor: RustFoundationActor, command: RustAgentCreateCommand): Promise<RustFoundationResponse>;
  readonly mode: RustFoundationMode;
  readonly organizationBrandingMode: RustFoundationMode;
  readonly projectGoalSetMode: RustFoundationMode;
  readonly requiresStartup: boolean;
  readonly publicIngressBaseUrl?: string | null;
  readonly nativeChatHostEnabled?: boolean;
  waitForPublicIngressReady?(): Promise<void>;
  start(): Promise<void>;
  calendar?(actor: RustFoundationActor, orgId: string, input: Record<string, unknown>): Promise<RustFoundationResponse>;
  secret?(actor: RustFoundationActor, orgId: string, input: Record<string, unknown>): Promise<RustFoundationResponse>;
  messengerState?(actor: RustFoundationActor, orgId: string, input: MessengerStateInput): Promise<RustFoundationResponse>;
  runRead?(actor: RustFoundationActor, orgId: string, input: RunReadInput): Promise<RustFoundationResponse>;
  liveRunRead?(
    actor: RustFoundationActor,
    orgId: string,
    input: LiveRunReadInput,
  ): Promise<RustFoundationResponse>;
  goalRead(
    actor: RustFoundationActor,
    orgId: string,
    input: {
      view: "list" | "detail" | "activities" | "history" | "dependencies"
        | "workspaceCards" | "assigned" | "workspace" | "agentContext" | "timeline";
      goalId: string | null;
      cursor?: string | null;
      limit?: string | null;
      agentId?: string | null;
      lifecycle?: "draft" | "active" | "closed" | "all";
      focus?: boolean | null;
      facet?: string | null;
    },
  ): Promise<RustFoundationResponse>;
  costRead(
    actor: RustFoundationActor,
    orgId: string,
    input: CostReadInput,
  ): Promise<RustFoundationResponse>;
  projectRead(
    actor: RustFoundationActor,
    orgId: string,
    input: { projectId: string | null; resourcesOnly: boolean; organizationWorkspaceRoot: string },
  ): Promise<RustFoundationResponse>;
  projectCreate(
    actor: RustFoundationActor,
    orgId: string,
    data: Record<string, unknown>,
    idempotencyKey: string,
    activityDetails: Record<string, unknown>,
    roots: { organizationWorkspaceRoot: string; projectCreateStateRoot: string },
  ): Promise<RustFoundationResponse>;
  memberDirectory(req: Request, orgId: string): Promise<RustFoundationResponse>;
  workspaceBackupList(req: Request, orgId: string): Promise<RustFoundationResponse>;
  workspaceBackupRead?(
    req: Request,
    orgId: string,
    input: { backupId: string; operation: "files" | "file" | "download"; path: string },
    signal?: AbortSignal,
  ): Promise<globalThis.Response>;
  organizationBranding(
    req: Request,
    orgId: string,
    body: Buffer,
    requestPath?: string,
  ): Promise<RustFoundationResponse>;
  organizationBrandingForActor(
    actor: RustFoundationActor,
    orgId: string,
    body: Buffer,
    idempotencyKey: string,
    requestPath?: string,
  ): Promise<RustFoundationResponse>;
  organizationResourceMutation?(
    req: Request,
    orgId: string,
    resourceId: string,
    operation: "update" | "delete",
    body: Buffer,
    idempotencyKey: string,
  ): Promise<RustFoundationResponse>;
  projectGoalSet(
    req: Request,
    orgId: string,
    projectId: string,
    body: Buffer,
    requestPath?: string,
  ): Promise<RustFoundationResponse>;
  projectDelete(
    req: Request,
    orgId: string,
    projectId: string,
    body: Buffer,
    idempotencyKey: string,
    requestPath?: string,
  ): Promise<RustFoundationResponse>;
  close(): Promise<void>;
}

type StartupReceipt = {
  boundAddr?: unknown;
  publicListener?: unknown;
  productWriteAuthority?: unknown;
  publicIngress?: { boundAddr?: unknown; publicListener?: unknown; localAccountLifecycle?: { authority?: unknown; protocolVersion?: unknown; routes?: unknown } };
};

type RustFoundationChild = ChildProcessByStdio<null, Readable, Readable>;
type BridgeLifecycleState = "idle" | "starting" | "ready" | "closing";

const ACTOR_ENVELOPE_ACTION = "organization.members.directory.read";
const WORKSPACE_BACKUP_LIST_ACTION = "organization.workspace.backups.list";
const WORKSPACE_BACKUP_LIST_STREAM_CONTENT_TYPE = "application/x-rudder-workspace-backup-list+ndjson";
const ORGANIZATION_BRANDING_ACTION = "organization.branding.update";
const ORGANIZATION_RESOURCE_ACTION = "organization.resource.mutate";
const PROJECT_GOAL_SET_ACTION = "project.goal_set.replace";
const PROJECT_DELETE_ACTION = "project.delete";
const PROJECT_CREATE_ACTION = "project.create";
const PROJECT_READ_ACTION = "project.read";
const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;
const DEFAULT_READY_TIMEOUT_MS = 5_000;
const DEFAULT_WORKSPACE_BACKUP_LIST_TIMEOUT_MS = 30_000;

function debugBridge(message: string) {
  if (process.env.RUDDER_RUST_BRIDGE_DEBUG === "true") {
    process.stderr.write(`[rudder-rust-bridge] ${message}\n`);
  }
}

async function readWorkspaceBackupListResponse(response: Response): Promise<RustFoundationResponse> {
  const contentType = response.headers.get("content-type") ?? "application/json";
  if (response.status !== 200) {
    return {
      status: response.status,
      contentType,
      body: Buffer.from(await response.arrayBuffer()),
    };
  }

  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== WORKSPACE_BACKUP_LIST_STREAM_CONTENT_TYPE) {
    throw new Error("Rust workspace backup list response used an unexpected content type");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Rust workspace backup list stream has no body");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const lineParts: string[] = [];
  const backups: Record<string, unknown>[] = [];
  const digest = createHash("sha256");
  let ended = false;

  const acceptLine = (line: string) => {
    if (line.length === 0 || ended) throw new Error("Rust workspace backup list stream has an invalid frame sequence");
    const frame = JSON.parse(line) as unknown;
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
      throw new Error("Rust workspace backup list stream frame is not an object");
    }
    const record = frame as Record<string, unknown>;
    if (record.type === "backup") {
      if (Object.keys(record).length !== 2
        || !("backup" in record)
        || !record.backup
        || typeof record.backup !== "object"
        || Array.isArray(record.backup)) {
        throw new Error("Rust workspace backup list stream contains an invalid backup frame");
      }
      digest.update(`${line}\n`, "utf8");
      backups.push(record.backup as Record<string, unknown>);
      return;
    }
    if (record.type === "end") {
      if (Object.keys(record).length !== 3
        || typeof record.count !== "number"
        || !Number.isSafeInteger(record.count)
        || record.count !== backups.length
        || typeof record.sha256 !== "string"
        || !/^[a-f0-9]{64}$/.test(record.sha256)
        || digest.digest("hex") !== record.sha256) {
        throw new Error("Rust workspace backup list stream terminal integrity check failed");
      }
      ended = true;
      return;
    }
    throw new Error("Rust workspace backup list stream contains an unknown frame");
  };

  const acceptText = (text: string) => {
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) !== 10) continue;
      lineParts.push(text.slice(start, index));
      acceptLine(lineParts.join(""));
      lineParts.length = 0;
      start = index + 1;
    }
    if (start < text.length) lineParts.push(text.slice(start));
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      acceptText(decoder.decode(value, { stream: true }));
    }
    acceptText(decoder.decode());
    if (lineParts.length > 0 || !ended) {
      throw new Error("Rust workspace backup list stream ended before its complete terminal frame");
    }
    return {
      status: response.status,
      contentType: "application/json",
      body: Buffer.from(JSON.stringify({ backups }), "utf8"),
    };
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
}

function configuredMode(
  value: string | undefined,
  envName: string,
  defaultMode: RustFoundationMode = "off",
): RustFoundationMode {
  const mode = value?.trim() || defaultMode;
  if (mode === "off" || mode === "shadow" || mode === "required") return mode;
  throw new RustFoundationBridgeError(
    "invalid_mode",
    `${envName} must be off, shadow, or required; received ${mode}`,
  );
}

function isLoopbackBoundAddress(value: string) {
  const [host] = value.startsWith("[")
    ? [value.slice(1, value.indexOf("]"))]
    : value.split(":");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function candidateBinaryPaths(configured: string | undefined) {
  const explicit = configured?.trim();
  if (explicit) return [explicit];

  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = resolve(moduleDirectory, "../../..");
  const serverPackageRoot = resolve(moduleDirectory, "../..");
  const isSourceRuntime = basename(moduleDirectory) === "services"
    && basename(dirname(moduleDirectory)) === "src";
  const binaryName = process.platform === "win32"
    ? "rudder-server-foundation.exe"
    : "rudder-server-foundation";
  const candidates: string[] = [];
  const target = resolveRudderNativeTarget();
  if (target) {
    candidates.push(join(serverPackageRoot, "resources", "native", target, binaryName));
  }
  // Only source modules get repository build outputs; installed modules fail closed without their packaged asset.
  if (isSourceRuntime) {
    candidates.push(
      join(repositoryRoot, "native", "target", "debug", binaryName),
      join(repositoryRoot, "native", "target", "release", binaryName),
    );
  }
  return candidates;
}

function createFoundationChildEnvironment(input: {
  databaseUrl: string;
  actorEnvelopeKey: string;
  publicIngress?: RustPublicIngressOptions;
  secretsMasterKey?: string;
  secretsMasterKeyFile: string;
}): Record<string, string> {
  return {
    // ZIP DOS timestamps follow the Node host's local Date semantics. Keep
    // this explicit non-secret locale setting without inheriting other env.
    ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
    RUDDER_NATIVE_LISTEN: "127.0.0.1:0",
    RUDDER_NATIVE_DATABASE_URL: input.databaseUrl,
    RUDDER_NATIVE_DATABASE_REQUIRED: "true",
    RUDDER_NATIVE_ACTOR_ENVELOPE_KEY: input.actorEnvelopeKey,
    // These existing feature gates must reach the native authority as well as
    // the public transport. Do not inherit the rest of the ambient environment.
    ...Object.fromEntries([
      "RUDDER_AGENT_CREATE_RUST_ENABLED",
      "RUDDER_AGENT_CREATE_INSTRUCTIONS_DURABLE_ENABLED",
      "RUDDER_AGENT_CREATE_RUST_MANAGED_MCP_ENABLED",
      "RUDDER_AGENT_CREATE_INTELLIGENCE_AVATAR_RUST_ENABLED",
    ].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
    RUDDER_NATIVE_HOST_HOME_DIRECTORY: homedir(),
    RUDDER_NATIVE_HOST_PROCESS_WORKING_DIRECTORY: process.cwd(),
    RUDDER_NATIVE_HOST_HOSTNAME: hostname(),
    ...(process.env.RUDDER_HOME !== undefined
      ? { RUDDER_NATIVE_HOST_RUDDER_HOME: process.env.RUDDER_HOME }
      : {}),
    ...(process.env.RUDDER_INSTANCE_ID !== undefined
      ? { RUDDER_NATIVE_HOST_INSTANCE_ID: process.env.RUDDER_INSTANCE_ID }
      : {}),
    ...(process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME !== undefined
      ? { RUDDER_NATIVE_HOST_ORGANIZATION_WORKSPACE_HOME: process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME }
      : {}),
    ...(input.secretsMasterKey ? { RUDDER_SECRETS_MASTER_KEY: input.secretsMasterKey } : {}),
    RUDDER_SECRETS_MASTER_KEY_FILE: input.secretsMasterKeyFile,
    ...(input.publicIngress ? {
      RUDDER_NATIVE_PUBLIC_LISTEN: input.publicIngress.listenAddr,
      RUDDER_NATIVE_NODE_UPSTREAM: input.publicIngress.nodeUpstream,
      RUDDER_NATIVE_INGRESS_AUTH_KEY: input.publicIngress.authorizationKey,
      RUDDER_NATIVE_DEPLOYMENT_MODE: input.publicIngress.deploymentMode ?? "authenticated",
      ...(input.publicIngress.privateHostGate
        ? { RUDDER_NATIVE_PRIVATE_HOST_GATE: JSON.stringify(input.publicIngress.privateHostGate) }
        : {}),
      ...nativeIdentityAuthEnvironment(input.publicIngress.identityAuth),
      ...nativeSessionAuthEnvironment(input.publicIngress.sessionAuth),
      ...nativeLocalAccountLifecycleEnvironment(input.publicIngress),
      ...(input.publicIngress.nativeChatHost
        ? {
            RUDDER_NATIVE_CHAT_HOST: JSON.stringify(input.publicIngress.nativeChatHost),
            PATH: input.publicIngress.nativeChatHost.executableSearchPath,
          }
        : {}),
      ...(input.publicIngress.browserSessionAuth
        ? { RUDDER_NATIVE_BROWSER_AUTH_ISSUER: JSON.stringify(input.publicIngress.browserSessionAuth) }
        : {}),
      ...(input.publicIngress.trustedProxies ? { RUDDER_NATIVE_INGRESS_TRUSTED_PROXIES: input.publicIngress.trustedProxies } : {}),
    } : {}),
  };
}

function resolveBinaryPath(configured: string | undefined) {
  const candidate = candidateBinaryPaths(configured).find((value) => {
    try {
      if (!existsSync(value) || !statSync(value).isFile()) return false;
      accessSync(value, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  return candidate ?? null;
}

function childHasExited(child: RustFoundationChild) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child: RustFoundationChild, timeoutMs?: number) {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise<boolean>((resolveExit) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      resolveExit(exited);
    };
    const onExit = () => finish(true);
    const onError = () => finish(true);
    child.once("exit", onExit);
    child.once("error", onError);
    if (childHasExited(child)) {
      finish(true);
    } else if (timeoutMs !== undefined) {
      timer = setTimeout(() => finish(false), timeoutMs);
    }
  });
}

async function stopChild(child: RustFoundationChild, spawnFailed = false) {
  if (spawnFailed || childHasExited(child)) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // The process may have exited between the state check and the signal.
  }
  if (await waitForChildExit(child, 2_000)) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // The process may have exited while the graceful-stop timeout elapsed.
  }
  await waitForChildExit(child);
}

export function createRustFoundationBridge(options: RustFoundationBridgeOptions): RustFoundationBridge {
  const mode = configuredMode(
    options.mode ?? process.env.RUDDER_RUST_MEMBER_DIRECTORY_MODE,
    "RUDDER_RUST_MEMBER_DIRECTORY_MODE",
    "required",
  );
  const organizationBrandingMode = configuredMode(
    options.organizationBrandingMode ?? process.env.RUDDER_RUST_ORGANIZATION_BRANDING_MODE,
    "RUDDER_RUST_ORGANIZATION_BRANDING_MODE",
  );
  const projectGoalSetMode = configuredMode(
    options.projectGoalSetMode ?? process.env.RUDDER_RUST_PROJECT_GOAL_SET_MODE,
    "RUDDER_RUST_PROJECT_GOAL_SET_MODE",
    "required",
  );
  const actorEnvelopeKey = options.actorEnvelopeKey?.trim()
    || process.env.RUDDER_NATIVE_ACTOR_ENVELOPE_KEY?.trim()
    || randomBytes(32).toString("hex");
  // Project and live-run reads are API-wide Rust capabilities, independent
  // of entity mutation ownership and the remaining mutation pilot switches.
  const requiresStartup = true;
  let child: RustFoundationChild | null = null;
  let baseUrl: string | null = null;
  let publicIngressBaseUrl: string | null = null;
  let lifecycleState: BridgeLifecycleState = "idle";
  let lifecycleTail: Promise<void> = Promise.resolve();
  let lastStderr = "";
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const workspaceBackupListTimeoutMs = options.workspaceBackupListTimeoutMs ?? DEFAULT_WORKSPACE_BACKUP_LIST_TIMEOUT_MS;

  const start = async (): Promise<void> => {
    lifecycleState = "starting";
    let spawned: RustFoundationChild | null = null;
    let spawnFailed = false;
    try {
      if (!options.databaseUrl.trim()) {
        throw new RustFoundationBridgeError("database_unconfigured", "Rust foundation bridge requires the active database URL");
      }
      const binary = resolveBinaryPath(options.binaryPath ?? process.env.RUDDER_SERVER_FOUNDATION_PATH);
      if (!binary) {
        throw new RustFoundationBridgeError("binary_unavailable", "rudder-server-foundation binary is unavailable");
      }

      lastStderr = "";
      const processHandle = spawn(binary, [], {
        cwd: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
        env: createFoundationChildEnvironment({
          databaseUrl: options.databaseUrl,
          actorEnvelopeKey,
          publicIngress: options.publicIngress,
          secretsMasterKey: process.env.RUDDER_SECRETS_MASTER_KEY,
          secretsMasterKeyFile: process.env.RUDDER_SECRETS_MASTER_KEY_FILE?.trim()
            ? resolve(process.env.RUDDER_SECRETS_MASTER_KEY_FILE.trim())
            : resolve(process.cwd(), "data/secrets/master.key"),
        }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      spawned = processHandle as RustFoundationChild;
      child = spawned;
      debugBridge(`started pid=${spawned.pid ?? "unknown"}`);
      spawned.once("error", () => {
        spawnFailed = true;
      });
      spawned.stderr.on("data", (chunk: Buffer) => {
        lastStderr = `${lastStderr}${chunk.toString("utf8")}`.slice(-2_000);
      });
      spawned.once("exit", () => {
        if (child === spawned) {
          child = null;
          baseUrl = null;
          publicIngressBaseUrl = null;
          if (lifecycleState !== "closing") lifecycleState = "idle";
        }
      });

      const stdout = createInterface({ input: spawned.stdout });
      const startupLine = await new Promise<string>((resolveLine, rejectLine) => {
        const onLine = (line: string) => {
          cleanup();
          resolveLine(line);
        };
        const onError = (error: Error) => {
          cleanup();
          rejectLine(error);
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          cleanup();
          rejectLine(new Error(`Rust foundation exited before startup (${code ?? signal ?? "unknown"})`));
        };
        const cleanup = () => {
          stdout.off("line", onLine);
          spawned?.off("error", onError);
          spawned?.off("exit", onExit);
          stdout.close();
        };
        stdout.once("line", onLine);
        processHandle.once("error", onError);
        processHandle.once("exit", onExit);
      }).catch((error) => {
        throw new RustFoundationBridgeError(
          "startup_failed",
          `Rust foundation startup failed${lastStderr ? `: ${lastStderr.trim()}` : ""}`,
          { cause: error },
        );
      });

      let receipt: StartupReceipt;
      try {
        const parsed: unknown = JSON.parse(startupLine);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("startup receipt must be a JSON object");
        }
        receipt = parsed as StartupReceipt;
      } catch (error) {
        throw new RustFoundationBridgeError("startup_failed", "Rust foundation emitted an invalid startup receipt", { cause: error });
      }
      const boundAddr = typeof receipt.boundAddr === "string" ? receipt.boundAddr : null;
      if (!boundAddr || !isLoopbackBoundAddress(boundAddr) || receipt.publicListener === true || receipt.productWriteAuthority === true) {
        throw new RustFoundationBridgeError("startup_failed", "Rust foundation startup receipt violated the private bridge contract");
      }
      baseUrl = `http://${boundAddr}`;
      if (options.publicIngress) {
        const publicAddr = receipt.publicIngress?.boundAddr;
        const expected = options.publicIngress.listenAddr;
        const expectedPort = expected.slice(expected.lastIndexOf(":") + 1);
        const expectedHost = expected.slice(0, expected.lastIndexOf(":") + 1);
        if (typeof publicAddr !== "string"
          || receipt.publicIngress?.publicListener !== true
          || !publicAddr.startsWith(expectedHost)
          || (expectedPort !== "0" && publicAddr !== expected)
          || !/^\d+$/.test(publicAddr.slice(publicAddr.lastIndexOf(":") + 1))
          || Number(publicAddr.slice(publicAddr.lastIndexOf(":") + 1)) < 1
          || Number(publicAddr.slice(publicAddr.lastIndexOf(":") + 1)) > 65535
          || publicAddr === boundAddr) {
          throw new RustFoundationBridgeError("startup_failed", "Rust public ingress binding did not match the requested listener");
        }
        if (options.publicIngress.localAccountLifecycle) {
          const lifecycle = receipt.publicIngress?.localAccountLifecycle;
          const routes = lifecycle?.routes;
          const requiredRoutes = ["/api/auth/local-exchange", "/api/auth/local-offline", "/api/auth/local-claim", "/api/auth/local-signout-all"];
          if (lifecycle?.authority !== "rust" || lifecycle.protocolVersion !== 1
            || !Array.isArray(routes)
            || !requiredRoutes.every((route) => routes.includes(route))) {
            throw new RustFoundationBridgeError("startup_failed", "Rust local-account lifecycle authority was not confirmed");
          }
        }
        publicIngressBaseUrl = `http://${publicAddr}`;
      } else if (receipt.publicIngress !== undefined) {
        throw new RustFoundationBridgeError("startup_failed", "Unexpected Rust public ingress listener");
      }
      const deadline = Date.now() + DEFAULT_READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`${baseUrl}/readyz`, {
            signal: AbortSignal.timeout(Math.min(requestTimeoutMs, 1_000)),
          });
          if (response.status === 200) {
            lifecycleState = "ready";
            return;
          }
        } catch {
          // The process may need a short interval between binding and readiness.
        }
        await delay(50);
      }
      throw new RustFoundationBridgeError("not_ready", "Rust foundation did not become ready", {
        cause: new Error(lastStderr || "ready probe failed"),
      });
    } catch (error) {
      const startupError = error instanceof RustFoundationBridgeError
        ? error
        : new RustFoundationBridgeError("startup_failed", "Rust foundation startup failed", { cause: error });
      baseUrl = null;
      publicIngressBaseUrl = null;
      if (spawned) await stopChild(spawned, spawnFailed);
      if (child === spawned) child = null;
      lifecycleState = "idle";
      throw startupError;
    }
  };

  const enqueueLifecycle = <T>(operation: () => Promise<T>) => {
    const run = lifecycleTail.then(operation, operation);
    lifecycleTail = run.then(() => undefined, () => undefined);
    return run;
  };

  const ensureStarted = (): Promise<void> => enqueueLifecycle(async () => {
    if (lifecycleState === "ready" && child && baseUrl && !childHasExited(child)) return;
    await start();
  });

  async function requestAgentCore(
    actor: RustFoundationActor,
    input: Record<string, unknown>,
  ): Promise<RustFoundationResponse> {
    await ensureStarted();
    if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
    const requestPath = "/internal/agent-core";
    const body = Buffer.from(JSON.stringify({ ...input, actorRunId: actor.runId ?? null,
      localImplicit: actor.type === "board" && actor.source === "local_implicit", canonicalLocale: Intl.Collator().resolvedOptions().locale }), "utf8");
    const requestId = randomUUID();
    const envelope = createRustActorEnvelope({ actor, organizationId: "agent-core", method: "POST", path: requestPath,
      action: "agent.core.execute", body, secret: actorEnvelopeKey, requestId, allowAnonymous: true });
    try {
      const response = await fetch(`${baseUrl}${requestPath}`, { method: "POST", headers: {
        "content-type": "application/json", "x-rudder-actor-envelope": JSON.stringify(envelope), "x-rudder-request-id": requestId },
        body: body as unknown as BodyInit,
        // Detail/permissions and create retain the legacy lock wait. An
        // admitted create may commit several organization-wide side effects;
        // aborting the fetch would make a successful commit indistinguishable
        // from a failed request and make a retry unsafe. Explicit caller
        // timeouts remain available for read/resolve operations.
        signal: input.operation === "create"
          || (input.resolveOnly !== true && ["detail", "me", "permissions"].includes(String(input.operation)) && options.requestTimeoutMs === undefined)
          ? undefined : AbortSignal.timeout(requestTimeoutMs) });
      return { status: response.status, contentType: response.headers.get("content-type") ?? "application/json", body: Buffer.from(await response.arrayBuffer()) };
    } catch (error) { throw new RustFoundationBridgeError("request_failed", "Rust Agent core request failed", { cause: error }); }
  }

  const close = (): Promise<void> => enqueueLifecycle(async () => {
    lifecycleState = "closing";
    const current = child;
    baseUrl = null;
    publicIngressBaseUrl = null;
    debugBridge(`close requested pid=${current?.pid ?? "none"}`);
    try {
      if (current) await stopChild(current);
    } finally {
      if (child === current) child = null;
      baseUrl = null;
      lifecycleState = "idle";
      debugBridge(`close completed pid=${current?.pid ?? "none"} exitCode=${current?.exitCode ?? "none"} signal=${current?.signalCode ?? "none"}`);
    }
  });

  async function sendOrganizationBranding(
    actor: RustFoundationActor,
    orgId: string,
    body: Buffer,
    idempotencyKey: string,
    requestPath: string,
    contentType = "application/json",
  ): Promise<RustFoundationResponse> {
    if (organizationBrandingMode === "off") {
      throw new RustFoundationBridgeError("request_failed", "Rust foundation organization branding bridge is disabled");
    }
    await ensureStarted();
    if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
    const requestId = randomUUID();
    const envelope = createRustActorEnvelope({
      actor,
      organizationId: orgId,
      method: "PATCH",
      path: requestPath,
      action: ORGANIZATION_BRANDING_ACTION,
      body,
      secret: actorEnvelopeKey,
      requestId,
      idempotencyKey,
    });
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${requestPath}`, {
        method: "PATCH",
        headers: {
          "content-type": contentType,
          "x-rudder-actor-envelope": JSON.stringify(envelope),
          "x-rudder-request-id": requestId,
          "x-rudder-idempotency-key": idempotencyKey,
        },
        body: body as unknown as BodyInit,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) {
      throw new RustFoundationBridgeError("request_failed", "Rust foundation request failed", { cause: error });
    }
    const responseBody = Buffer.from(await response.arrayBuffer());
    debugBridge(`organization-branding response status=${response.status} body=${responseBody.toString("utf8").slice(0, 512)}`);
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/json",
      body: responseBody,
    } satisfies RustFoundationResponse;
  }

  return {
    mode,
    organizationBrandingMode,
    projectGoalSetMode,
    requiresStartup,
    nativeChatHostEnabled: Boolean(options.publicIngress?.nativeChatHost),
    get publicIngressBaseUrl() { return publicIngressBaseUrl; },
    async waitForPublicIngressReady() {
      if (!options.publicIngress || !publicIngressBaseUrl || !child || childHasExited(child)) {
        throw new RustFoundationBridgeError("not_ready", "Rust public ingress is not running");
      }
      // Called after the private Node listener binds: public readiness includes
      // that upstream, whereas start() checks only the private Rust listener.
      const probeUrl = publicIngressBaseUrl.replace("http://0.0.0.0:", "http://127.0.0.1:")
        .replace("http://[::]:", "http://[::1]:");
      const deadline = Date.now() + DEFAULT_READY_TIMEOUT_MS;
      while (Date.now() < deadline && child && !childHasExited(child)) {
        try {
          const response = await fetch(`${probeUrl}/readyz`, {
            signal: AbortSignal.timeout(Math.min(requestTimeoutMs, 1_000)),
          });
          if (response.status === 200) return;
        } catch { /* Remain fail-closed while the upstream starts. */ }
        await delay(50);
      }
      throw new RustFoundationBridgeError("not_ready", "Rust public ingress did not become ready");
    },
    start: ensureStarted,
    async runtimeBinding(actor, orgId, input) {
      await ensureStarted();
      if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
      return requestRuntimeBinding(baseUrl, actorEnvelopeKey, requestTimeoutMs, actor, orgId, input);
    },
    async nativeChatTranscript(actor, orgId, input) {
      await ensureStarted();
      if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
      return requestNativeChatTranscript(baseUrl, actorEnvelopeKey, requestTimeoutMs, actor, orgId, input);
    },
    async nativeChatMessages(actor, orgId, input) {
      await ensureStarted();
      if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
      return requestNativeChatMessages(baseUrl, actorEnvelopeKey, requestTimeoutMs, actor, orgId, input);
    },
    async automationRead(actor, orgId, input) {
      await ensureStarted();
      if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
      return requestAutomationRead(baseUrl, actorEnvelopeKey, requestTimeoutMs, actor, orgId, input);
    },
    async activityLinkRead(actor, orgId, input) {
      await ensureStarted();
      if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
      return requestActivityLinkRead(baseUrl, actorEnvelopeKey, requestTimeoutMs, actor, orgId, input);
    },
    async issueMetadataRead(actor, orgId, input) {
      await ensureStarted();
      if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
      return requestIssueMetadataRead(baseUrl, actorEnvelopeKey, requestTimeoutMs, actor, orgId, input);
    },
    async organizationCatalogRead(actor, orgId, input) {
      await ensureStarted();
      if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
      return requestOrganizationCatalogRead(baseUrl, actorEnvelopeKey, requestTimeoutMs, actor, orgId, input);
    },
    async approvalRead(actor, orgId, input) {
      await ensureStarted();
      if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
      return requestApprovalRead(baseUrl, actorEnvelopeKey, requestTimeoutMs, actor, orgId, input);
    },
    async requestRead(actor, orgId, input) {
      await ensureStarted();
      if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
      return requestRequestRead(baseUrl, actorEnvelopeKey, requestTimeoutMs, actor, orgId, input);
    },
    async overviewRead(actor, orgId, input) {
      await ensureStarted();
      if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
      return requestOverviewRead(baseUrl, actorEnvelopeKey, requestTimeoutMs, actor, orgId, input);
    },
    async runWorkspaceRead(actor, orgId, input) {
      await ensureStarted();
      if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
      return requestRunWorkspaceRead(baseUrl, actorEnvelopeKey, requestTimeoutMs, actor, orgId, input);
    },
    async activityRead(actor, orgId, input) {
      await ensureStarted();
      if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
      return requestActivityRead(baseUrl, actorEnvelopeKey, requestTimeoutMs, actor, orgId, input);
    },
    async runWorkspaceOrdinaryUpdate(actor, input) {
      await ensureStarted();
      if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
      const requestPath = "/internal/run-workspace-ordinary-update";
      const body = encodeRunWorkspaceOrdinaryUpdate(actor, input);
      const requestId = randomUUID();
      const envelope = createRustActorEnvelope({ actor, organizationId: "run-workspace-ordinary-update", method: "POST", path: requestPath,
        action: "run_workspace.ordinary_update", body, secret: actorEnvelopeKey, requestId, allowAnonymous: true });
      try {
        const response = await fetch(`${baseUrl}${requestPath}`, { method: "POST", headers: {
          "content-type": "application/json", "x-rudder-actor-envelope": JSON.stringify(envelope), "x-rudder-request-id": requestId },
          body: body as unknown as BodyInit });
        return { status: response.status, contentType: response.headers.get("content-type") ?? "application/json", body: Buffer.from(await response.arrayBuffer()) };
      } catch (error) { throw new RustFoundationBridgeError("request_failed", "Rust run workspace update request failed", { cause: error }); }
    },
    async agentCore(actor, input) {
      return requestAgentCore(actor, input);
    },
    async agentInstructions(actor, input) {
      const orgId = typeof input.orgId === "string" ? input.orgId : "";
      const host = {
        instanceRoot: resolveRudderInstanceRoot(),
        workspaceHome: resolveOrganizationWorkspaceHomeDir(),
        previousDocumentsRoot: resolvePreviousDocumentsOrganizationWorkspaceRoot(orgId),
        friendlyWorkspaceHome: Boolean(process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME?.trim()) || !process.env.RUDDER_HOME?.trim(),
        hostname: hostname(),
      };
      return requestAgentCore(actor, {
        operation: input.operation,
        orgId,
        id: input.id ?? null,
        revisionId: null,
        keyId: null,
        query: input.query ?? {},
        input: input.input ?? null,
        deploymentMode: options.publicIngress?.deploymentMode ?? "authenticated",
        homeDirectory: homedir(),
        processWorkingDirectory: process.cwd(),
        instructionsHost: host,
      });
    },
    async agentCreate(actor, command) {
      return requestAgentCore(actor, {
        operation: command.operation,
        orgId: command.orgId,
        id: null,
        revisionId: null,
        keyId: null,
        query: {},
        input: command.input,
        deploymentMode: options.publicIngress?.deploymentMode ?? "authenticated",
        homeDirectory: homedir(),
        processWorkingDirectory: process.cwd(),
        // Installation placement is selected by the local bridge, never by
        // public create JSON. AgentCore uses it only after committing the
        // Agent row to materialize the durable managed-workspace projection.
        instructionsHost: {
          instanceRoot: resolveRudderInstanceRoot(),
          workspaceHome: resolveOrganizationWorkspaceHomeDir(),
          previousDocumentsRoot: resolvePreviousDocumentsOrganizationWorkspaceRoot(command.orgId),
          friendlyWorkspaceHome: Boolean(process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME?.trim()) || !process.env.RUDDER_HOME?.trim(),
          hostname: hostname(),
        },
      });
    },
    async goalRead(actor, orgId, input) {
      await ensureStarted();
      if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
      const requestPath = `/internal/orgs/${encodeURIComponent(orgId)}/goal-reads`;
      const body = Buffer.from(JSON.stringify(input), "utf8");
      const requestId = randomUUID();
      const envelope = createRustActorEnvelope({
        actor,
        organizationId: orgId,
        method: "POST",
        path: requestPath,
        action: "goal.read",
        body,
        secret: actorEnvelopeKey,
        requestId,
      });
      try {
        const response = await fetch(`${baseUrl}${requestPath}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-rudder-actor-envelope": JSON.stringify(envelope),
            "x-rudder-request-id": requestId,
          },
          body: body as unknown as BodyInit,
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
        return {
          status: response.status,
          contentType: response.headers.get("content-type") ?? "application/json",
          body: Buffer.from(await response.arrayBuffer()),
        } satisfies RustFoundationResponse;
      } catch (error) {
        throw new RustFoundationBridgeError("request_failed", "Rust Goal read request failed", { cause: error });
      }
    },
    async calendar(actor, orgId, input) {
      await ensureStarted();
      if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
      const requestPath = `/internal/orgs/${encodeURIComponent(orgId)}/calendar`;
      const body = Buffer.from(JSON.stringify(input), "utf8");
      const requestId = randomUUID();
      const envelope = createRustActorEnvelope({
        actor,
        organizationId: orgId,
        method: "POST",
        path: requestPath,
        action: "calendar.mutate",
        body,
        secret: actorEnvelopeKey,
        requestId,
      });
      try {
        const response = await fetch(`${baseUrl}${requestPath}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-rudder-actor-envelope": JSON.stringify(envelope),
            "x-rudder-request-id": requestId,
          },
          body: body as unknown as BodyInit,
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
        return {
          status: response.status,
          contentType: response.headers.get("content-type") ?? "application/json",
          body: Buffer.from(await response.arrayBuffer()),
        } satisfies RustFoundationResponse;
      } catch (error) {
        throw new RustFoundationBridgeError("request_failed", "Rust Calendar request failed", { cause: error });
      }
    },
    async secret(actor, orgId, input) {
      await ensureStarted();
      if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
      const requestPath = `/internal/orgs/${encodeURIComponent(orgId)}/secrets`;
      const body = Buffer.from(JSON.stringify(input), "utf8");
      const requestId = randomUUID();
      const envelope = createRustActorEnvelope({
        actor,
        organizationId: orgId,
        method: "POST",
        path: requestPath,
        action: "secrets.mutate",
        body,
        secret: actorEnvelopeKey,
        requestId,
      });
      try {
        const response = await fetch(`${baseUrl}${requestPath}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-rudder-actor-envelope": JSON.stringify(envelope),
            "x-rudder-request-id": requestId,
          },
          body: body as unknown as BodyInit,
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
        return {
          status: response.status,
          contentType: response.headers.get("content-type") ?? "application/json",
          body: Buffer.from(await response.arrayBuffer()),
        } satisfies RustFoundationResponse;
      } catch (error) {
        throw new RustFoundationBridgeError("request_failed", "Rust Secrets request failed", { cause: error });
      }
    },
    async costRead(actor, orgId, input) {
      await ensureStarted();
      if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
      return requestCostRead(baseUrl, actorEnvelopeKey, requestTimeoutMs, actor, orgId, input);
    },
    async projectRead(actor, orgId, input) {
      await ensureStarted();
      if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
      const requestPath = `/internal/orgs/${encodeURIComponent(orgId)}/project-reads`;
      const body = Buffer.from(JSON.stringify(input), "utf8");
      const requestId = randomUUID();
      const envelope = createRustActorEnvelope({
        actor,
        organizationId: orgId,
        method: "POST",
        path: requestPath,
        action: PROJECT_READ_ACTION,
        body,
        secret: actorEnvelopeKey,
        requestId,
      });
      try {
        const response = await fetch(`${baseUrl}${requestPath}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-rudder-actor-envelope": JSON.stringify(envelope),
            "x-rudder-request-id": requestId,
          },
          body: body as unknown as BodyInit,
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
        return {
          status: response.status,
          contentType: response.headers.get("content-type") ?? "application/json",
          body: Buffer.from(await response.arrayBuffer()),
        } satisfies RustFoundationResponse;
      } catch (error) {
        throw new RustFoundationBridgeError("request_failed", "Rust Project read request failed", { cause: error });
      }
    },
    async runRead(actor, orgId, input) {
      await ensureStarted();
      if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
      const requestPath = `/internal/orgs/${encodeURIComponent(orgId)}/run-reads`;
      const body = Buffer.from(JSON.stringify(input));
      const requestId = randomUUID();
      const envelope = createRustActorEnvelope({
        actor,
        organizationId: orgId,
        method: "POST",
        path: requestPath,
        action: "run.read",
        body,
        secret: actorEnvelopeKey,
        requestId,
      });
      try {
        const response = await fetch(`${baseUrl}${requestPath}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-rudder-actor-envelope": JSON.stringify(envelope),
            "x-rudder-request-id": requestId,
          },
          body: body as unknown as BodyInit,
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
        return {
          status: response.status,
          contentType: response.headers.get("content-type") ?? "application/json",
          body: Buffer.from(await response.arrayBuffer()),
        } satisfies RustFoundationResponse;
      } catch (error) {
        throw new RustFoundationBridgeError("request_failed", "Rust foundation request failed", { cause: error });
      }
    },
    async liveRunRead(actor, orgId, input) {
      await ensureStarted();
      if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
      const requestPath = `/internal/orgs/${encodeURIComponent(orgId)}/live-run-reads`;
      const body = Buffer.from(JSON.stringify(input));
      const requestId = randomUUID();
      const envelope = createRustActorEnvelope({
        actor,
        organizationId: orgId,
        method: "POST",
        path: requestPath,
        action: "live_run.read",
        body,
        secret: actorEnvelopeKey,
        requestId,
      });
      try {
        const response = await fetch(`${baseUrl}${requestPath}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-rudder-actor-envelope": JSON.stringify(envelope),
            "x-rudder-request-id": requestId,
          },
          body: body as unknown as BodyInit,
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
        return {
          status: response.status,
          contentType: response.headers.get("content-type") ?? "application/json",
          body: Buffer.from(await response.arrayBuffer()),
        } satisfies RustFoundationResponse;
      } catch (error) {
        throw new RustFoundationBridgeError("request_failed", "Rust foundation request failed", { cause: error });
      }
    },
    async messengerState(actor, orgId, input) {
      await ensureStarted();
      if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
      const requestPath = `/internal/orgs/${encodeURIComponent(orgId)}/messenger-state`;
      const body = Buffer.from(JSON.stringify({ input, auditContext: messengerAuditContext() }));
      const requestId = randomUUID();
      const envelope = createRustActorEnvelope({
        actor,
        organizationId: orgId,
        method: "POST",
        path: requestPath,
        action: "messenger.state",
        body,
        secret: actorEnvelopeKey,
        requestId,
      });
      try {
        const response = await fetch(`${baseUrl}${requestPath}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-rudder-actor-envelope": JSON.stringify(envelope),
            "x-rudder-request-id": requestId,
          },
          body: body as unknown as BodyInit,
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
        return {
          status: response.status,
          contentType: response.headers.get("content-type") ?? "application/json",
          body: Buffer.from(await response.arrayBuffer()),
        } satisfies RustFoundationResponse;
      } catch (error) {
        throw new RustFoundationBridgeError("request_failed", "Rust foundation request failed", { cause: error });
      }
    },
    async projectCreate(actor, orgId, data, idempotencyKey, activityDetails, roots) {
      if (projectGoalSetMode !== "required") {
        throw new RustFoundationBridgeError("request_failed", "Rust Project creation requires required mode");
      }
      const normalizedIdempotencyKey = idempotencyKey.trim();
      if (!normalizedIdempotencyKey) {
        throw new RustFoundationBridgeError("request_failed", "Rust Project creation requires an idempotency key");
      }
      await ensureStarted();
      if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
      const requestPath = `/api/orgs/${encodeURIComponent(orgId)}/projects`;
      const body = Buffer.from(JSON.stringify({
        runId: actor.runId ?? null,
        data,
        activityDetails,
        organizationWorkspaceRoot: roots.organizationWorkspaceRoot,
        projectCreateStateRoot: roots.projectCreateStateRoot,
      }));
      const requestId = randomUUID();
      const envelope = createRustActorEnvelope({
        actor,
        organizationId: orgId,
        method: "POST",
        path: requestPath,
        action: PROJECT_CREATE_ACTION,
        body,
        secret: actorEnvelopeKey,
        requestId,
        idempotencyKey: normalizedIdempotencyKey,
      });
      let response: Response;
      try {
        response = await fetch(`${baseUrl}${requestPath}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-rudder-actor-envelope": JSON.stringify(envelope),
            "x-rudder-request-id": requestId,
            "x-rudder-idempotency-key": normalizedIdempotencyKey,
          },
          body: body as unknown as BodyInit,
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
      } catch (error) {
        throw new RustFoundationBridgeError("request_failed", "Rust foundation request failed", { cause: error });
      }
      return {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "application/json",
        body: Buffer.from(await response.arrayBuffer()),
      } satisfies RustFoundationResponse;
    },
    async memberDirectory(req, orgId) {
      if (mode === "off") {
        throw new RustFoundationBridgeError("request_failed", "Rust foundation member directory bridge is disabled");
      }
      await ensureStarted();
      if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
      const body = Buffer.alloc(0);
      const requestId = randomUUID();
      const envelope = createRustActorEnvelope({
        actor: req.actor,
        organizationId: orgId,
        method: "GET",
        path: req.originalUrl,
        action: ACTOR_ENVELOPE_ACTION,
        body,
        secret: actorEnvelopeKey,
        requestId,
      });
      let response: Response;
      try {
        response = await fetch(`${baseUrl}${req.originalUrl}`, {
          method: "GET",
          headers: {
            "x-rudder-actor-envelope": JSON.stringify(envelope),
            "x-rudder-request-id": requestId,
          },
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
      } catch (error) {
        throw new RustFoundationBridgeError("request_failed", "Rust foundation request failed", { cause: error });
      }
      return {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "application/json",
        body: Buffer.from(await response.arrayBuffer()),
      } satisfies RustFoundationResponse;
    },
    async workspaceBackupRead(req, orgId, input, signal) {
      await ensureStarted();
      if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
      const requestPath = `/internal/orgs/${encodeURIComponent(orgId)}/workspace/backup-reads`;
      const body = Buffer.from(JSON.stringify(input), "utf8");
      const requestId = randomUUID();
      const envelope = createRustActorEnvelope({
        actor: req.actor,
        organizationId: orgId,
        method: "POST",
        path: requestPath,
        action: "organization.workspace.backup.read",
        body,
        secret: actorEnvelopeKey,
        requestId,
      });
      const headerDeadline = new AbortController();
      const deadlineTimer = setTimeout(() => headerDeadline.abort(), workspaceBackupListTimeoutMs);
      try {
        // Keep the response streaming. A large archive must not be buffered in
        // Node, and disconnects must cancel its native producer.
        return await fetch(`${baseUrl}${requestPath}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-rudder-actor-envelope": JSON.stringify(envelope),
            "x-rudder-request-id": requestId,
          },
          body: body as unknown as BodyInit,
          signal: signal ? AbortSignal.any([signal, headerDeadline.signal]) : headerDeadline.signal,
        });
      } catch (error) {
        throw new RustFoundationBridgeError("request_failed", "Rust workspace backup read request failed", { cause: error });
      } finally {
        // Bound header preparation, not the client's archive transfer speed.
        clearTimeout(deadlineTimer);
      }
    },
    async workspaceBackupList(req, orgId) {
      await ensureStarted();
      if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
      const requestPath = `/internal/orgs/${encodeURIComponent(orgId)}/workspace/backups`;
      const body = Buffer.alloc(0);
      const requestId = randomUUID();
      const envelope = createRustActorEnvelope({
        actor: req.actor,
        organizationId: orgId,
        method: "GET",
        path: requestPath,
        action: WORKSPACE_BACKUP_LIST_ACTION,
        body,
        secret: actorEnvelopeKey,
        requestId,
      });
      try {
        const response = await fetch(`${baseUrl}${requestPath}`, {
          method: "GET",
          headers: {
            "x-rudder-actor-envelope": JSON.stringify(envelope),
            "x-rudder-request-id": requestId,
          },
          signal: AbortSignal.timeout(workspaceBackupListTimeoutMs),
        });
        return await readWorkspaceBackupListResponse(response);
      } catch (error) {
        throw new RustFoundationBridgeError("request_failed", "Rust workspace backup list request failed", { cause: error });
      }
    },
    async organizationBranding(req, orgId, body, requestPath = req.originalUrl) {
      const idempotencyKey = req.header("x-rudder-idempotency-key")?.trim();
      if (!idempotencyKey) {
        throw new RustFoundationBridgeError("request_failed", "Rust organization branding requires x-rudder-idempotency-key");
      }
      return sendOrganizationBranding(
        req.actor,
        orgId,
        body,
        idempotencyKey,
        requestPath,
        req.header("content-type") ?? "application/json",
      );
    },
    async organizationBrandingForActor(actor, orgId, body, idempotencyKey, requestPath) {
      const path = requestPath ?? `/api/orgs/${encodeURIComponent(orgId)}/branding`;
      return sendOrganizationBranding(actor, orgId, body, idempotencyKey, path);
    },
    async projectGoalSet(
      req,
      orgId,
      projectId,
      body,
      requestPath = `/api/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/goal-set`,
    ) {
      if (projectGoalSetMode !== "required") {
        throw new RustFoundationBridgeError("request_failed", "Rust foundation Project-Goal writes require required mode");
      }
      await ensureStarted();
      if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
      const requestId = randomUUID();
      const idempotencyKey = req.header("x-rudder-idempotency-key")?.trim();
      if (!idempotencyKey) {
        throw new RustFoundationBridgeError("request_failed", "Rust Project-Goal replacement requires x-rudder-idempotency-key");
      }
      const envelope = createRustActorEnvelope({
        actor: req.actor,
        organizationId: orgId,
        method: "PATCH",
        path: requestPath,
        action: PROJECT_GOAL_SET_ACTION,
        body,
        secret: actorEnvelopeKey,
        requestId,
        idempotencyKey,
      });
      let response: Response;
      try {
        response = await fetch(`${baseUrl}${requestPath}`, {
          method: "PATCH",
          headers: {
            "content-type": req.header("content-type") ?? "application/json",
            "x-rudder-actor-envelope": JSON.stringify(envelope),
            "x-rudder-request-id": requestId,
            "x-rudder-idempotency-key": idempotencyKey,
          },
          body: body as unknown as BodyInit,
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
      } catch (error) {
        throw new RustFoundationBridgeError("request_failed", "Rust foundation request failed", { cause: error });
      }
      const responseBody = Buffer.from(await response.arrayBuffer());
      debugBridge(`project-goal response status=${response.status} body=${responseBody.toString("utf8").slice(0, 512)}`);
      return {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "application/json",
        body: responseBody,
      } satisfies RustFoundationResponse;
    },
    async organizationResourceMutation(req, orgId, resourceId, operation, body, idempotencyKey) {
      if (projectGoalSetMode !== "required") {
        throw new RustFoundationBridgeError("request_failed", "Rust organization resource writes require required mode");
      }
      await ensureStarted();
      if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
      const normalizedKey = idempotencyKey.trim();
      if (!normalizedKey) throw new RustFoundationBridgeError("request_failed", "Rust resource mutation requires an idempotency key");
      const requestPath = `/api/orgs/${encodeURIComponent(orgId)}/resources/${encodeURIComponent(resourceId)}`;
      const method = operation === "update" ? "PATCH" : "DELETE";
      const requestId = randomUUID();
      const envelope = createRustActorEnvelope({
        actor: req.actor,
        organizationId: orgId,
        method,
        path: requestPath,
        action: ORGANIZATION_RESOURCE_ACTION,
        body,
        secret: actorEnvelopeKey,
        requestId,
        idempotencyKey: normalizedKey,
      });
      try {
        const response = await fetch(`${baseUrl}${requestPath}`, {
          method,
          headers: {
            "content-type": "application/json",
            "x-rudder-actor-envelope": JSON.stringify(envelope),
            "x-rudder-request-id": requestId,
            "x-rudder-idempotency-key": normalizedKey,
          },
          body: body as unknown as BodyInit,
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
        return {
          status: response.status,
          contentType: response.headers.get("content-type") ?? "application/json",
          body: Buffer.from(await response.arrayBuffer()),
        } satisfies RustFoundationResponse;
      } catch (error) {
        throw new RustFoundationBridgeError("request_failed", "Rust organization resource request failed", { cause: error });
      }
    },
    async projectDelete(
      req,
      orgId,
      projectId,
      body,
      idempotencyKey,
      requestPath = `/api/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}`,
    ) {
      if (projectGoalSetMode !== "required") {
        throw new RustFoundationBridgeError("request_failed", "Rust Project deletion requires required mode");
      }
      await ensureStarted();
      if (!baseUrl) throw new RustFoundationBridgeError("request_failed", "Rust foundation bridge is not running");
      const requestId = randomUUID();
      const normalizedIdempotencyKey = idempotencyKey.trim();
      if (!normalizedIdempotencyKey) {
        throw new RustFoundationBridgeError("request_failed", "Rust Project deletion requires an idempotency key");
      }
      const envelope = createRustActorEnvelope({
        actor: req.actor,
        organizationId: orgId,
        method: "DELETE",
        path: requestPath,
        action: PROJECT_DELETE_ACTION,
        body,
        secret: actorEnvelopeKey,
        requestId,
        idempotencyKey: normalizedIdempotencyKey,
      });
      let response: Response;
      try {
        response = await fetch(`${baseUrl}${requestPath}`, {
          method: "DELETE",
          headers: {
            "content-type": req.header("content-type") ?? "application/json",
            "x-rudder-actor-envelope": JSON.stringify(envelope),
            "x-rudder-request-id": requestId,
            "x-rudder-idempotency-key": normalizedIdempotencyKey,
          },
          body: body as unknown as BodyInit,
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
      } catch (error) {
        throw new RustFoundationBridgeError("request_failed", "Rust foundation request failed", { cause: error });
      }
      const responseBody = Buffer.from(await response.arrayBuffer());
      debugBridge(`project-delete response status=${response.status} body=${responseBody.toString("utf8").slice(0, 512)}`);
      return {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "application/json",
        body: responseBody,
      } satisfies RustFoundationResponse;
    },
    close,
  };
}
