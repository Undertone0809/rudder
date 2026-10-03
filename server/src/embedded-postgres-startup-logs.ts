import { redactSensitiveText } from "./redaction.js";

const MAX_STARTUP_LOG_BYTES = 8 * 1024;
const MAX_STARTUP_LOG_LINES = 120;

// Reuses the server's startup tail. Hold incomplete lines until flush so a
// credential split across process chunks cannot escape redaction.
export function createEmbeddedPostgresStartupLogBuffer(onLine?: (line: string) => void) {
  const lines: string[] = [];
  let pending = "";
  let oversized = false;
  const emit = () => {
    let line = oversized ? "[over-limit PostgreSQL startup line omitted]" : redactSensitiveText(pending)
      .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s/]+@/giu, "$1[REDACTED]@")
      .trim();
    if (Buffer.byteLength(line, "utf8") > MAX_STARTUP_LOG_BYTES) line = "[over-limit PostgreSQL startup line omitted]";
    pending = "";
    oversized = false;
    if (!line) return;
    lines.push(line);
    while (lines.length > MAX_STARTUP_LOG_LINES || Buffer.byteLength(lines.join("\n"), "utf8") > MAX_STARTUP_LOG_BYTES) {
      lines.shift();
    }
    onLine?.(line);
  };
  return {
    lines,
    append(message: unknown) {
      const text = typeof message === "string" ? message : message instanceof Error ? message.message : String(message ?? "");
      const parts = text.split("\n");
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index]!;
        if (!oversized) {
          if (Buffer.byteLength(pending, "utf8") + Buffer.byteLength(part, "utf8") > MAX_STARTUP_LOG_BYTES) {
            pending = "";
            oversized = true;
          } else pending += part;
        }
        if (index < parts.length - 1) emit();
      }
    },
    flush: emit,
  };
}
