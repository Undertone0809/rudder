import type { ChromiumCookieDatabaseResult, ImportedChromiumCookie } from "./browser-cookie-db.js";
import type { BrowserImportSource, TrustedBrowserImportSource } from "./browser-import-sources.js";

export type BrowserDataImportResult = {
  status: "succeeded" | "partial" | "failed";
  importedCount: number;
  skippedCount: number;
  failedCount: number;
  errors?: Array<{ errorCode: string; message: string }>;
};

export type BrowserCookieSetDetails = {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
  sameSite: ImportedChromiumCookie["sameSite"];
};

const MAX_REPORTED_ERRORS = 20;

type DestinationCookie = {
  name?: unknown;
  domain?: unknown;
  path?: unknown;
  hostOnly?: unknown;
};

function canonicalCookieHost(hostKey: string): string | null {
  const normalizedHost = hostKey.replace(/^\./, "").toLowerCase();
  if (!normalizedHost || /[\u0000-\u0020/\\@?#%]/.test(normalizedHost)) return null;
  const unbracketedHost = normalizedHost.startsWith("[") && normalizedHost.endsWith("]")
    ? normalizedHost.slice(1, -1)
    : normalizedHost;
  const urlHost = unbracketedHost.includes(":") ? `[${unbracketedHost}]` : unbracketedHost;
  try {
    const parsed = new URL(`https://${urlHost}`);
    const canonicalHost = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
      ? parsed.hostname.slice(1, -1).toLowerCase()
      : parsed.hostname.toLowerCase();
    return canonicalHost === unbracketedHost ? canonicalHost : null;
  } catch {
    return null;
  }
}

function cookieIdentity(input: {
  hostKey: string;
  name: string;
  path: string;
  hostOnly: boolean;
}): string | null {
  const canonicalHost = canonicalCookieHost(input.hostKey);
  if (!canonicalHost) return null;
  return `${input.hostOnly ? "host" : "domain"}\0${canonicalHost}\0${input.name}\0${input.path}`;
}

function destinationCookieIdentity(cookie: DestinationCookie): string | null {
  if (typeof cookie.name !== "string" || typeof cookie.domain !== "string" || typeof cookie.path !== "string") {
    return null;
  }
  return cookieIdentity({
    hostKey: cookie.domain,
    name: cookie.name,
    path: cookie.path,
    hostOnly: cookie.hostOnly === true,
  });
}

function cookieSetDetails(cookie: ImportedChromiumCookie): BrowserCookieSetDetails | null {
  const isDomainCookie = cookie.hostKey.startsWith(".");
  const host = canonicalCookieHost(cookie.hostKey);
  if (!host || cookie.path.startsWith("//")) return null;
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const scheme = cookie.secure || cookie.sourceScheme === 2 ? "https:" : "http:";
  const port = cookie.sourcePort > 0 ? `:${cookie.sourcePort}` : "";
  let origin: URL;
  try {
    origin = new URL(`${scheme}//${urlHost}${port}`);
  } catch {
    return null;
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") return null;
  const details: BrowserCookieSetDetails = {
    url: new URL(`${origin.origin}${cookie.path}`).toString(),
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
  };
  if (isDomainCookie) details.domain = `.${host}`;
  return details;
}

export function createBrowserCookieImporter(options: {
  sourceRegistry: {
    listSources(): Promise<BrowserImportSource[]>;
    resolveSource(sourceId: string): TrustedBrowserImportSource;
  };
  cookies: {
    get(filter: Record<string, never>): Promise<DestinationCookie[]>;
    set(details: BrowserCookieSetDetails): Promise<void>;
    flushStore(): Promise<void>;
  };
  runWorker(source: TrustedBrowserImportSource, signal?: AbortSignal): Promise<ChromiumCookieDatabaseResult>;
  runExclusive<T>(operation: (signal?: AbortSignal) => Promise<T>): Promise<T>;
}) {
  return {
    listBrowserImportSources: (): Promise<BrowserImportSource[]> => options.sourceRegistry.listSources(),
    importBrowserData: async (input: { sourceId: string; importCookies: true }): Promise<BrowserDataImportResult> => {
      if (!input || typeof input.sourceId !== "string" || !input.sourceId || input.importCookies !== true) {
        throw new TypeError("Browser cookie import must be enabled for a known source.");
      }
      const source = options.sourceRegistry.resolveSource(input.sourceId);
      return options.runExclusive(async (signal) => {
        if (signal?.aborted) throw new Error("Browser data import canceled.");
        const workerResult = signal
          ? await options.runWorker(source, signal)
          : await options.runWorker(source);
        const errors = workerResult.errors.slice(0, MAX_REPORTED_ERRORS);
        let importedCount = 0;
        let skippedCount = workerResult.skippedCount;
        let failedCount = workerResult.failedCount;
        const identities = new Set<string>();
        for (const existing of await options.cookies.get({})) {
          const identity = destinationCookieIdentity(existing);
          if (identity) identities.add(identity);
        }

        const sourceCookies = [...workerResult.cookies].sort((left, right) =>
          left.lastUpdateUtc === right.lastUpdateUtc ? 0 : left.lastUpdateUtc > right.lastUpdateUtc ? -1 : 1);
        for (const cookie of sourceCookies) {
          const hostOnly = !cookie.hostKey.startsWith(".");
          const identity = cookieIdentity({
            hostKey: cookie.hostKey,
            name: cookie.name,
            path: cookie.path,
            hostOnly,
          });
          if (!identity) {
            skippedCount += 1;
            if (errors.length < MAX_REPORTED_ERRORS) {
              errors.push({ errorCode: "COOKIE_ROW_INVALID", message: "An invalid cookie row was skipped." });
            }
            continue;
          }
          if (identities.has(identity)) {
            skippedCount += 1;
            continue;
          }
          const details = cookieSetDetails(cookie);
          if (!details) {
            skippedCount += 1;
            if (errors.length < MAX_REPORTED_ERRORS) {
              errors.push({ errorCode: "COOKIE_ROW_INVALID", message: "An invalid cookie row was skipped." });
            }
            continue;
          }
          try {
            await options.cookies.set(details);
            identities.add(identity);
            importedCount += 1;
          } catch {
            failedCount += 1;
            if (errors.length < MAX_REPORTED_ERRORS) {
              errors.push({
                errorCode: "COOKIE_WRITE_FAILED",
                message: "A cookie could not be written to the Rudder Browser.",
              });
            }
          }
        }
        try {
          await options.cookies.flushStore();
        } catch {
          failedCount += 1;
          if (errors.length < MAX_REPORTED_ERRORS) {
            errors.push({
              errorCode: "COOKIE_FLUSH_FAILED",
              message: "Imported cookies could not be flushed to the Rudder Browser profile.",
            });
          }
        }

        return {
          status: failedCount > 0 ? (importedCount > 0 ? "partial" : "failed") : "succeeded",
          importedCount,
          skippedCount,
          failedCount,
          ...(errors.length > 0 ? { errors } : {}),
        };
      });
    },
  };
}
