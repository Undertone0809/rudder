const VALUE_FLAGS = new Set([
  "--append-system-prompt", "--provider", "--model", "--thinking",
  "--tools", "--extension", "--skill",
]);
const SWITCH_FLAGS = new Set(["--no-skills"]);
const CREDENTIAL_VALUE = /(?:bearer\s+\S{8,}|(?:api[-_]?key|authorization|cookie|password|secret|token)\s*[:=]\s*\S+)/iu;
const BARE_CREDENTIAL = /\b(?:sk-(?:proj-|ant-)?[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9_]{16,}|github_pat_[a-zA-Z0-9_]{16,}|xox[baprs]-[a-zA-Z0-9-]{16,}|AKIA[A-Z0-9]{16})\b/u;

/** Pi reuses these exact arguments for native Reader/fork operations. Unknown
 * flags cannot be safely persisted, including custom header/credential flags. */
export function assertPersistablePiRpcArgs(args: readonly string[]): void {
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (SWITCH_FLAGS.has(flag)) continue;
    if (!VALUE_FLAGS.has(flag)) throw new Error(`Pi RPC argument ${flag.slice(0, 80)} is not approved for durable transport`);
    const value = args[++index];
    if (!value || value.startsWith("--") || CREDENTIAL_VALUE.test(value) || BARE_CREDENTIAL.test(value)) {
      throw new Error(`Pi RPC argument ${flag} has a missing or credential-bearing value`);
    }
  }
}
