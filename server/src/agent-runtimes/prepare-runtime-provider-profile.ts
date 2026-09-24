import { buildCodexProfileEnvironment, resolveManagedCodexHomeDir } from "@rudderhq/agent-runtime-codex-local/server";
import { ensureAbsoluteDirectory } from "@rudderhq/agent-runtime-utils/server-utils";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { prepareOtherRuntimeProviderProfile } from "./prepare-other-runtime-provider-profile.js";

const execFileAsync = promisify(execFile);

export function codexMethodsFromSchema(schema: unknown) {
  const record = schema as { oneOf?: Array<{ properties?: { method?: { enum?: unknown[]; const?: unknown } } }> } | null;
  const methods = new Set((Array.isArray(record?.oneOf) ? record.oneOf : []).flatMap((entry) => {
    const method = entry?.properties?.method;
    return Array.isArray(method?.enum) ? method.enum : method?.const ? [method.const] : [];
  }));
  return {
    threadResume: methods.has("thread/resume"),
    threadRead: methods.has("thread/read"),
    threadFork: methods.has("thread/fork"),
  };
}

/** Resolve the host-owned transport before Driver admission, using the same
 * managed home identity as the existing Codex execute implementation. */
export async function prepareRuntimeProviderProfile(input: {
  runtimeType: string;
  orgId: string;
  agentId: string;
  config: Record<string, unknown>;
  workspace?: Record<string, unknown> | null;
}): Promise<Record<string, unknown>> {
  if (input.runtimeType !== "codex_local") return prepareOtherRuntimeProviderProfile(input);
  const config = { ...input.config };
  const configuredCwd = typeof config.cwd === "string" ? config.cwd.trim() : "";
  const workspaceCwd = typeof input.workspace?.cwd === "string" ? input.workspace.cwd : "";
  const cwd = (input.workspace?.source === "agent_home" && configuredCwd ? configuredCwd : workspaceCwd || configuredCwd) || process.cwd();
  if (!path.isAbsolute(cwd)) throw new Error("Codex native profile requires an absolute workspace");
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  const configuredEnv = config.env && typeof config.env === "object" && !Array.isArray(config.env)
    ? Object.fromEntries(Object.entries(config.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {};
  // execute intentionally derives the target home from the Rudder host, not
  // from an agent-supplied RUDDER_HOME or its shared authentication source.
  const codexHome = resolveManagedCodexHomeDir(process.env, input.orgId, input.agentId);
  const env = buildCodexProfileEnvironment({ configured: configuredEnv, codexHome });
  const command = typeof config.command === "string" && config.command.trim() ? config.command.trim() : "codex";
  const { stdout } = await execFileAsync(command, ["--version"], {
    cwd, env, timeout: 15_000, maxBuffer: 64 * 1024,
  });
  const version = stdout.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/)?.[1];
  if (!version) throw new Error("Codex native profile could not identify the installed provider version");
  const schemaDir = await mkdtemp(path.join(os.tmpdir(), "rudder-codex-protocol-"));
  try {
    // Ask the installed binary for its public protocol; version presence alone
    // is not evidence that a method exists. No native session is created here.
    await execFileAsync(command, ["app-server", "generate-json-schema", "--out", schemaDir], {
      cwd, env, timeout: 15_000, maxBuffer: 64 * 1024,
    });
    const nativeCapabilityMethods = codexMethodsFromSchema(JSON.parse(await readFile(path.join(schemaDir, "ClientRequest.json"), "utf8")));
    // A custom executable path is still a native Codex provider once its
    // installed protocol is discovered; do not silently select exec mode
    // merely because the command is not the literal string "codex".
    return { ...config, cwd, codexHome, providerVersion: version, nativeCapabilityMethods,
      chatAppServerEnabled: config.chatAppServerEnabled ?? (nativeCapabilityMethods.threadResume && nativeCapabilityMethods.threadRead) };
  } finally {
    await rm(schemaDir, { recursive: true, force: true });
  }
}
