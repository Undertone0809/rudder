import {
  createCodexLocalProviderCapabilities,
  probeCodexNativeTranscriptPagination,
  type CodexAppServerProfileTransport,
  type CodexNativeTranscriptReadResult,
} from "@rudderhq/agent-runtime-codex-local/server";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  bindingRefFromReaderInput,
  createRuntimeNativeTranscriptReaderHook,
  sessionFromReaderInput,
  type RuntimeProviderCapabilityResolver,
} from "../services/runtime-kernel/provider-capabilities.js";
import type { NativeTranscriptReaderHook } from "../services/runtime-kernel/transcript-reader.js";
import { resolveCodexTranscriptProfile, type RuntimeProviderProfileConfig } from "./index.js";

// Successful protocol observations only; neither historical records nor generic
// resume/fork capabilities are upgraded. Cache entries contain no raw env/path.
const verifiedProfiles = new Map<string, number>();
const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 128;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function executableIdentity(profile: CodexAppServerProfileTransport) {
  const candidates = profile.command.includes("/") || profile.command.includes("\\")
    ? [path.resolve(profile.cwd, profile.command)]
    : (profile.env.PATH ?? "").split(path.delimiter).slice(0, 128).flatMap(directory => {
      const base = path.resolve(profile.cwd, directory, profile.command);
      return process.platform === "win32" && !path.extname(base)
        ? [base, `${base}.exe`, `${base}.cmd`] : [base];
    });
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const command = await realpath(candidate);
      const info = await stat(command, { bigint: true });
      if (!info.isFile()) continue;
      const roots = await Promise.all([profile.cwd, profile.env.CODEX_HOME].map(directory =>
        directory ? realpath(directory).catch(() => null) : null));
      const fingerprint = createHash("sha256").update(JSON.stringify({
        protocol: "codex-read-pagination-v1", command,
        binary: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String),
        binding: profile.binding, args: profile.args ?? [], cwd: profile.cwd, roots,
        env: Object.entries(profile.env).sort(([a], [b]) => a.localeCompare(b)),
        version: profile.providerVersion,
      })).digest("hex");
      return { command, fingerprint };
    } catch { /* Try the next PATH entry, without falling back to another profile. */ }
  }
  throw new Error("Historical Codex executable cannot be resolved");
}

/** Called only with the DB Reader's authorized run/span/binding. The first page
 * itself proves the read-only protocol; there is no schema generation on disk,
 * admission preparation, native session mutation, or full-snapshot fallback. */
export function createHistoricalCodexTranscriptReaderHook(
  config: RuntimeProviderProfileConfig,
  resolve: RuntimeProviderCapabilityResolver,
): NativeTranscriptReaderHook & Required<Pick<NativeTranscriptReaderHook, "readRange">> {
  const ordinary = createRuntimeNativeTranscriptReaderHook(resolve);
  return {
    async readRange(input) {
      const binding = bindingRefFromReaderInput(input);
      const session = sessionFromReaderInput(input);
      if (config.runtimeType !== "codex_local" || input.binding?.runtimeType !== "codex_local"
        || !binding || !session || !input.segment || input.selector.kind !== "codex_turn") {
        return ordinary.readRange(input);
      }
      const profile = resolveCodexTranscriptProfile(config, binding);
      const historicalSession = { ...session, sessionParams: { ...session.sessionParams,
        ...record(input.run.sessionParamsBeforeJson), ...record(input.run.sessionParamsAfterJson) } };
      const methods = profile.methods;
      if (methods?.threadRead === false || methods?.threadTurnsList === false || methods?.threadItemsList === false
        || methods?.threadReadFullSnapshot === true
        || (methods?.threadTurnsList === true && methods.threadItemsList === true)) {
        return ordinary.readRange(input);
      }
      const unavailable = () => ({ items: [], nextCursor: null, source: "native" as const,
        availability: "offline" as const, completeness: "unknown" as const,
        revision: `codex:unverified:${input.span.id}` });
      try {
        input.signal?.throwIfAborted();
        // A historical provider version/home must still be present. Native
        // session payloads never supply commands, args, cwd, or environment.
        const configuredHome = config.runtimeConfig.codexHome ?? record(config.runtimeConfig.env).CODEX_HOME;
        if (typeof configuredHome !== "string" || !path.isAbsolute(configuredHome)
          || !profile.providerVersion || !path.isAbsolute(profile.cwd) || !path.isAbsolute(profile.env.CODEX_HOME ?? "")) return unavailable();
        const identity = await executableIdentity(profile);
        const temporary = { ...profile, command: identity.command,
          transcriptVerificationFingerprint: identity.fingerprint };
        const expires = verifiedProfiles.get(identity.fingerprint) ?? 0;
        let firstPage: CodexNativeTranscriptReadResult | undefined;
        if (expires <= Date.now()) {
          verifiedProfiles.delete(identity.fingerprint);
          const observation = await probeCodexNativeTranscriptPagination({
            runtimeType: "codex_local", binding, session: historicalSession, selector: input.selector,
            cursor: input.cursor, range: input.range, readerInput: input, signal: input.signal,
          }, temporary);
          if ((await executableIdentity(profile)).fingerprint !== identity.fingerprint) return unavailable();
          if (!observation.verified) return observation.page;
          if (verifiedProfiles.size >= MAX_CACHE_ENTRIES) verifiedProfiles.delete(verifiedProfiles.keys().next().value!);
          verifiedProfiles.set(identity.fingerprint, Date.now() + CACHE_TTL_MS);
          firstPage = observation.page;
        }
        // Attest only the transcript on this ephemeral adapter. Existing
        // profile and binding capabilityRevision remain byte-for-byte intact.
        const adapter = createCodexLocalProviderCapabilities({ ...temporary,
          methods: { threadRead: true, threadTurnsList: true, threadItemsList: true },
        });
        const transcript = adapter.transcript!;
        const page = await createRuntimeNativeTranscriptReaderHook(() => ({
          binding, profileResolved: true,
          adapter: { runtimeType: "codex_local", transcript: { ...transcript,
            readRange: async request => firstPage ?? transcript.readRange!({ ...request, session: historicalSession }),
          } },
        })).readRange(input);
        if ((await executableIdentity(profile)).fingerprint !== identity.fingerprint) return unavailable();
        return page;
      } catch {
        // No raw paths, environment, or provider diagnostics escape this gate.
        return unavailable();
      }
    },
  };
}
