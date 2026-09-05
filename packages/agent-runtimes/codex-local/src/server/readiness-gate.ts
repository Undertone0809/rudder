import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const STATE_VERSION = 1;
const STATE_RELATIVE_DIRECTORY = path.join(".rudder", "provider-readiness", "codex");

type CodexAuthFailureState = {
  version: typeof STATE_VERSION;
  fingerprint: string;
  classification: "authentication";
  errorCode: "codex_provider_auth_required";
  failedAt: string;
};

function digestParts(parts: Array<string | Buffer>): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part, "utf8");
    hash.update(String(bytes.length));
    hash.update(":");
    hash.update(bytes);
    hash.update("\n");
  }
  return hash.digest("hex");
}

async function readFingerprintInput(candidate: string): Promise<Buffer> {
  return fs.readFile(candidate).catch(() => Buffer.from("missing", "utf8"));
}

export async function buildCodexReadinessFingerprint(input: {
  env: Record<string, string>;
  sharedCodexHome: string;
  model?: string;
}): Promise<string> {
  const apiKey = input.env.OPENAI_API_KEY?.trim() ?? "";
  const authSource = apiKey ? "api_key" : "subscription";
  const authMaterial = apiKey
    ? Buffer.from(apiKey, "utf8")
    : await readFingerprintInput(path.join(input.sharedCodexHome, "auth.json"));
  const providerConfig = await readFingerprintInput(path.join(input.sharedCodexHome, "config.toml"));

  return digestParts([
    "rudder.codex.readiness.v1",
    authSource,
    authMaterial,
    providerConfig,
    input.env.OPENAI_BASE_URL?.trim() ?? "",
    input.env.OPENAI_API_BASE?.trim() ?? "",
  ]);
}

function statePath(agentHome: string, fingerprint: string): string {
  return path.join(agentHome, STATE_RELATIVE_DIRECTORY, `${fingerprint}.json`);
}

async function readState(agentHome: string, fingerprint: string): Promise<CodexAuthFailureState | null> {
  const raw = await fs.readFile(statePath(agentHome, fingerprint), "utf8").catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CodexAuthFailureState>;
    if (
      parsed.version !== STATE_VERSION
      || typeof parsed.fingerprint !== "string"
      || parsed.classification !== "authentication"
      || parsed.errorCode !== "codex_provider_auth_required"
      || typeof parsed.failedAt !== "string"
    ) {
      return null;
    }
    return parsed as CodexAuthFailureState;
  } catch {
    return null;
  }
}

export async function hasMatchingCodexAuthFailure(
  agentHome: string,
  fingerprint: string,
): Promise<boolean> {
  const state = await readState(agentHome, fingerprint);
  return state?.fingerprint === fingerprint;
}

export async function recordCodexAuthFailure(
  agentHome: string,
  fingerprint: string,
): Promise<void> {
  const target = statePath(agentHome, fingerprint);
  const directory = path.dirname(target);
  await fs.mkdir(directory, { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const state: CodexAuthFailureState = {
    version: STATE_VERSION,
    fingerprint,
    classification: "authentication",
    errorCode: "codex_provider_auth_required",
    failedAt: new Date().toISOString(),
  };
  await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await fs.link(temporary, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

export async function clearMatchingCodexAuthFailure(
  agentHome: string,
  fingerprint: string,
): Promise<void> {
  if (!(await hasMatchingCodexAuthFailure(agentHome, fingerprint))) return;
  await fs.unlink(statePath(agentHome, fingerprint)).catch(() => undefined);
}
