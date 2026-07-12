import { describe, expect, it, vi } from "vitest";
import type { ImportedChromiumCookie } from "./browser-cookie-db.js";
import { createBrowserCookieImporter } from "./browser-cookie-import.js";
import type { TrustedBrowserImportSource } from "./browser-import-sources.js";

const source: TrustedBrowserImportSource = {
  id: "opaque-source",
  displayName: "Google Chrome - Work",
  browserName: "Google Chrome",
  profileName: "Work",
  supported: { cookies: true, passwords: false },
  cookieDatabasePath: "/private/source/Network/Cookies",
  keychain: { service: "Chrome Safe Storage", account: "Chrome" },
};

function cookie(overrides: Partial<ImportedChromiumCookie> = {}): ImportedChromiumCookie {
  return {
    hostKey: "new.example.com",
    name: "session",
    value: "secret-value",
    path: "/",
    secure: true,
    httpOnly: true,
    expirationDate: 1_900_000_000,
    sameSite: "lax",
    sourceScheme: 2,
    sourcePort: -1,
    lastUpdateUtc: 20n,
    ...overrides,
  };
}

describe("Browser Cookie importer", () => {
  it("passes the profile cancellation signal to the import worker", async () => {
    const abortController = new AbortController();
    const runWorker = vi.fn(async () => ({
      cookies: [],
      skippedCount: 0,
      failedCount: 0,
      errors: [],
    }));
    const importer = createBrowserCookieImporter({
      sourceRegistry: {
        listSources: async () => [],
        resolveSource: () => source,
      },
      cookies: {
        get: async () => [],
        set: async () => undefined,
        flushStore: async () => undefined,
      },
      runWorker,
      runExclusive: async (operation) => operation(abortController.signal),
    });

    await importer.importBrowserData({ sourceId: source.id, importCookies: true });

    expect(runWorker).toHaveBeenCalledWith(source, abortController.signal);
  });

  it("preserves destination cookies, maps host-only/domain cookies, and reports partial writes", async () => {
    const set = vi.fn(async (details: { name?: string }) => {
      if (details.name === "write-fails") throw new Error("secret failure for /private/path");
    });
    const flushStore = vi.fn(async () => undefined);
    const runExclusive = vi.fn(async <T>(operation: () => Promise<T>) => operation());
    const runWorker = vi.fn(async () => ({
      cookies: [
        cookie({ hostKey: "existing.example.com", name: "existing" }),
        cookie(),
        cookie({ lastUpdateUtc: 1n }),
        cookie({ hostKey: ".domain.example", name: "domain", sameSite: "no_restriction" }),
        cookie({ hostKey: "fail.example", name: "write-fails" }),
      ],
      skippedCount: 2,
      failedCount: 1,
      errors: [{ errorCode: "COOKIE_DECRYPT_FAILED", message: "A cookie could not be decrypted and was not imported." }],
    }));
    const importer = createBrowserCookieImporter({
      sourceRegistry: {
        listSources: async () => [],
        resolveSource: (id) => {
          if (id !== source.id) throw new Error("Unknown browser import source.");
          return source;
        },
      },
      cookies: {
        get: async () => [{
          name: "existing",
          value: "destination-value",
          domain: "existing.example.com",
          path: "/",
          hostOnly: true,
          sameSite: "lax",
        }],
        set,
        flushStore,
      },
      runWorker,
      runExclusive,
    });

    const result = await importer.importBrowserData({ sourceId: source.id, importCookies: true });

    expect(runExclusive).toHaveBeenCalledTimes(1);
    expect(runWorker).toHaveBeenCalledWith(source);
    expect(set).toHaveBeenCalledTimes(3);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://new.example.com/",
      name: "session",
      value: "secret-value",
    }));
    expect(set.mock.calls.find(([details]) => details.name === "session")?.[0]).not.toHaveProperty("domain");
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://domain.example/",
      domain: ".domain.example",
      name: "domain",
      sameSite: "no_restriction",
    }));
    expect(flushStore).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: "partial",
      importedCount: 2,
      skippedCount: 4,
      failedCount: 2,
      errors: [
        { errorCode: "COOKIE_DECRYPT_FAILED", message: "A cookie could not be decrypted and was not imported." },
        { errorCode: "COOKIE_WRITE_FAILED", message: "A cookie could not be written to the Rudder Browser." },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("/private");
    expect(JSON.stringify(result)).not.toContain("fail.example");
    expect(JSON.stringify(result)).not.toContain("write-fails");
  });

  it("validates renderer input and caps sanitized errors", async () => {
    const importer = createBrowserCookieImporter({
      sourceRegistry: {
        listSources: async () => [],
        resolveSource: () => source,
      },
      cookies: {
        get: async () => [],
        set: async () => {
          throw new Error("sensitive");
        },
        flushStore: async () => undefined,
      },
      runWorker: async () => ({
        cookies: Array.from({ length: 25 }, (_, index) => cookie({ name: `failure-${index}` })),
        skippedCount: 0,
        failedCount: 0,
        errors: [],
      }),
      runExclusive: async (operation) => operation(),
    });

    await expect(importer.importBrowserData({ sourceId: source.id, importCookies: false as true }))
      .rejects.toThrow("cookie import must be enabled");
    const result = await importer.importBrowserData({ sourceId: source.id, importCookies: true });
    expect(result.status).toBe("failed");
    expect(result.failedCount).toBe(25);
    expect(result.errors).toHaveLength(20);
    expect(new Set(result.errors?.map((error) => error.message)))
      .toEqual(new Set(["A cookie could not be written to the Rudder Browser."]));
  });

  it("rejects non-canonical source hosts before Electron can overwrite a canonical destination", async () => {
    const set = vi.fn(async () => undefined);
    const importer = createBrowserCookieImporter({
      sourceRegistry: {
        listSources: async () => [],
        resolveSource: () => source,
      },
      cookies: {
        get: async () => [
          { name: "session", domain: "example.com", path: "/", hostOnly: true },
          { name: "session", domain: "127.0.0.1", path: "/", hostOnly: true },
        ],
        set,
        flushStore: async () => undefined,
      },
      runWorker: async () => ({
        cookies: [
          cookie({ hostKey: "example.com#ignored" }),
          cookie({ hostKey: "example.com?ignored" }),
          cookie({ hostKey: "%65xample.com" }),
          cookie({ hostKey: "127.1" }),
        ],
        skippedCount: 0,
        failedCount: 0,
        errors: [],
      }),
      runExclusive: async (operation) => operation(),
    });

    await expect(importer.importBrowserData({ sourceId: source.id, importCookies: true })).resolves.toEqual({
      status: "succeeded",
      importedCount: 0,
      skippedCount: 4,
      failedCount: 0,
      errors: Array.from({ length: 4 }, () => ({
        errorCode: "COOKIE_ROW_INVALID",
        message: "An invalid cookie row was skipped.",
      })),
    });
    expect(set).not.toHaveBeenCalled();
  });
});
