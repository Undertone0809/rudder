import { redactSensitiveText } from "../redaction.js";

// Native instructions can contain Markdown, JSON, dotenv and HTTP examples.
// Keep this stricter display policy local to recovered instruction text.
const CREDENTIAL_ASSIGNMENT = /((?:^|[\s{\[,;?&])["']?(?:[a-z0-9]+[_-])*(?:api[_-]?key|(?:access|refresh|auth|session|id)[_-]?token|token|(?:client[_-]?)?secret|secret[_-]?access[_-]?key|password|passwd|credentials?|authorization|(?:set[_-]?)?cookie|connection[_-]?string|private[_-]?key)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:bearer|basic)\s+[^\s,;}\]]+|[^\s,;&}\]]+)/gimu;

export function redactRecoveredInstructionText(value: string): string {
  return redactSensitiveText(value
    .replace(/((?:^|[\s{\[,;?&])["']?(?:[a-z0-9]+[_-])*service[_-]?role[_-]?key["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}\]]+)/gimu, (_match, prefix: string, secret: string) => {
      const quote = secret.startsWith('"') ? '"' : secret.startsWith("'") ? "'" : "";
      return `${prefix}${quote}[REDACTED]${quote}`;
    })
    .replace(/^(\s*(?:set-cookie|cookie)\s*:\s*)[^\r\n]+/gimu, "$1[REDACTED]")
    .replace(CREDENTIAL_ASSIGNMENT, (_match, prefix: string, secret: string) => {
      const quote = secret.startsWith('"') ? '"' : secret.startsWith("'") ? "'" : "";
      return `${prefix}${quote}[REDACTED]${quote}`;
    })
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@"));
}
