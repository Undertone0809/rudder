const MAX_LOG_ENTRIES = 50;

type LogLevel = "error" | "warn";

export interface ConsoleLogEntry {
  level: LogLevel;
  args: unknown[];
  timestamp: number;
}

let entries: ConsoleLogEntry[] = [];
let installed = false;
const originalConsole = {
  error: console.error,
  warn: console.warn,
};

function formatArg(arg: unknown): string {
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  if (typeof arg === "object" && arg !== null) {
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

function formatEntries(limit = 20): string {
  const recent = entries.slice(-limit);
  return recent
    .map((e) => {
      const time = new Date(e.timestamp).toISOString().slice(11, 23);
      const text = e.args.map(formatArg).join(" ");
      return `[${time}] ${e.level.toUpperCase()}: ${text}`;
    })
    .join("\n");
}

export const ConsoleRingBuffer = {
  install() {
    if (installed) return;
    installed = true;
    console.error = (...args: unknown[]) => {
      entries.push({ level: "error", args, timestamp: Date.now() });
      if (entries.length > MAX_LOG_ENTRIES) entries = entries.slice(-MAX_LOG_ENTRIES);
      originalConsole.error.apply(console, args);
    };
    console.warn = (...args: unknown[]) => {
      entries.push({ level: "warn", args, timestamp: Date.now() });
      if (entries.length > MAX_LOG_ENTRIES) entries = entries.slice(-MAX_LOG_ENTRIES);
      originalConsole.warn.apply(console, args);
    };
  },

  uninstall() {
    if (!installed) return;
    installed = false;
    console.error = originalConsole.error;
    console.warn = originalConsole.warn;
  },

  getRecent(limit = 20): ConsoleLogEntry[] {
    return entries.slice(-limit);
  },

  formatRecent(limit = 20): string {
    return formatEntries(limit);
  },

  /** For testing only. */
  _reset() {
    entries = [];
    this.uninstall();
  },
};
