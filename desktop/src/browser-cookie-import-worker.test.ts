import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import type { ChromiumCookieDatabaseResult } from "./browser-cookie-db.js";
import {
  processBrowserCookieImportSource,
  runBrowserCookieImportWorker,
} from "./browser-cookie-import-worker.js";
import type { TrustedBrowserImportSource } from "./browser-import-sources.js";

const source: TrustedBrowserImportSource = {
  id: "opaque",
  displayName: "Google Chrome - Work",
  browserName: "Google Chrome",
  profileName: "Work",
  supported: { cookies: true, passwords: false },
  cookieDatabasePath: "/trusted/Chrome/Default/Network/Cookies",
  keychain: { service: "Chrome Safe Storage", account: "Chrome" },
};
const importOwnerId = "a".repeat(64);

const keyUnavailable: ChromiumCookieDatabaseResult = {
  cookies: [],
  skippedCount: 0,
  failedCount: 1,
  errors: [{
    errorCode: "COOKIE_KEY_UNAVAILABLE",
    message: "Encrypted cookies could not be read because browser key access was unavailable.",
  }],
};

describe("Browser Cookie import worker", () => {
  it("returns a stable sanitized error when the source browser database is open", async () => {
    const sourceOpenError = Object.assign(
      new Error(`SQLITE_BUSY while opening ${source.cookieDatabasePath}`),
      { code: "BROWSER_SOURCE_OPEN" },
    );

    await expect(processBrowserCookieImportSource(source, {
      createSnapshot: async () => { throw sourceOpenError; },
    })).resolves.toEqual({
      cookies: [],
      skippedCount: 0,
      failedCount: 1,
      errors: [{
        errorCode: "BROWSER_SOURCE_OPEN",
        message: "Close the source browser and try the import again.",
      }],
    });
  });

  it("does not expose unknown worker failures", async () => {
    class FailedWorker extends EventEmitter {
      terminate = vi.fn(async () => 1);

      constructor() {
        super();
        queueMicrotask(() => this.emit("message", { ok: false }));
      }
    }

    await expect(runBrowserCookieImportWorker(source, {
      ownerId: importOwnerId,
      createTempDirectory: async () => "/private/parent-owned",
      cleanupTempDirectory: async () => undefined,
      createWorker: () => new FailedWorker() as unknown as Worker,
    })).rejects.toThrow("Browser data import failed.");
  });

  it("reads plaintext first, requests Keychain only when needed, then zeroes secrets and cleans the snapshot", async () => {
    const cleanup = vi.fn(async () => undefined);
    const createSnapshot = vi.fn(async () => ({
      tempDirectory: "/private/temp",
      databasePath: "/private/temp/Cookies",
      cleanup,
    }));
    const password = Buffer.from("keychain-password");
    const derivedKey = Buffer.alloc(16, 7);
    const readKeychain = vi.fn(async () => password);
    const deriveKey = vi.fn(() => derivedKey);
    const success: ChromiumCookieDatabaseResult = {
      cookies: [],
      skippedCount: 1,
      failedCount: 0,
      errors: [{ errorCode: "COOKIE_EXPIRED", message: "An expired cookie was skipped." }],
    };
    const readDatabase = vi.fn()
      .mockReturnValueOnce(keyUnavailable)
      .mockReturnValueOnce(success);

    const result = await processBrowserCookieImportSource(source, {
      createSnapshot,
      readDatabase,
      readKeychain,
      deriveKey,
    });

    expect(createSnapshot).toHaveBeenCalledWith({ sourcePath: source.cookieDatabasePath });
    expect(readDatabase).toHaveBeenNthCalledWith(1, {
      databasePath: "/private/temp/Cookies",
      key: null,
    });
    expect(readKeychain).toHaveBeenCalledWith(source.keychain);
    expect(readDatabase).toHaveBeenNthCalledWith(2, {
      databasePath: "/private/temp/Cookies",
      key: derivedKey,
    });
    expect(result).toBe(success);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(password.every((byte) => byte === 0)).toBe(true);
    expect(derivedKey.every((byte) => byte === 0)).toBe(true);
  });

  it("does not access Keychain for plaintext-only databases and cleans after reader failures", async () => {
    const cleanup = vi.fn(async () => undefined);
    const plaintext: ChromiumCookieDatabaseResult = { cookies: [], skippedCount: 0, failedCount: 0, errors: [] };
    const readKeychain = vi.fn();
    await expect(processBrowserCookieImportSource(source, {
      createSnapshot: async () => ({ tempDirectory: "/tmp/private", databasePath: "/tmp/private/Cookies", cleanup }),
      readDatabase: () => plaintext,
      readKeychain,
      deriveKey: () => Buffer.alloc(16),
    })).resolves.toBe(plaintext);
    expect(readKeychain).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);

    await expect(processBrowserCookieImportSource(source, {
      createSnapshot: async () => ({ tempDirectory: "/tmp/private", databasePath: "/tmp/private/Cookies", cleanup }),
      readDatabase: () => {
        throw new Error("reader failure with /private/path");
      },
      readKeychain,
      deriveKey: () => Buffer.alloc(16),
    })).rejects.toThrow("reader failure");
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it("preserves plaintext results when Keychain access for encrypted rows is denied", async () => {
    const cleanup = vi.fn(async () => undefined);
    const partial: ChromiumCookieDatabaseResult = {
      ...keyUnavailable,
      cookies: [{
        hostKey: "plain.test",
        name: "plain",
        value: "available",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        sourceScheme: 2,
        sourcePort: -1,
        lastUpdateUtc: 1n,
      }],
    };

    await expect(processBrowserCookieImportSource(source, {
      createSnapshot: async () => ({ tempDirectory: "/tmp/private", databasePath: "/tmp/private/Cookies", cleanup }),
      readDatabase: () => partial,
      readKeychain: async () => {
        throw new Error("denied with secret path");
      },
      deriveKey: () => Buffer.alloc(16),
    })).resolves.toBe(partial);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("terminates timed-out workers before removing the parent-owned snapshot directory", async () => {
    const lifecycle: string[] = [];
    class HangingWorker extends EventEmitter {
      terminate = vi.fn(async () => {
        lifecycle.push("terminate");
        return 1;
      });
    }
    const worker = new HangingWorker();
    const cleanupTempDirectory = vi.fn(async () => {
      lifecycle.push("cleanup");
    });

    const createTempDirectory = vi.fn(async () => "/private/parent-owned");
    await expect(runBrowserCookieImportWorker(source, {
      ownerId: importOwnerId,
      timeoutMs: 1,
      createTempDirectory,
      cleanupTempDirectory,
      createWorker: () => worker as unknown as Worker,
    })).rejects.toThrow("timed out");

    expect(createTempDirectory).toHaveBeenCalledWith(importOwnerId);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(cleanupTempDirectory).toHaveBeenCalledWith("/private/parent-owned");
    expect(lifecycle).toEqual(["terminate", "cleanup"]);
  });

  it("terminates an aborted worker before removing the parent-owned snapshot directory", async () => {
    const lifecycle: string[] = [];
    class HangingWorker extends EventEmitter {
      terminate = vi.fn(async () => {
        lifecycle.push("terminate");
        return 1;
      });
    }
    const abortController = new AbortController();
    const worker = new HangingWorker();
    const createWorker = vi.fn(() => worker as unknown as Worker);
    const cleanupTempDirectory = vi.fn(async () => {
      lifecycle.push("cleanup");
    });

    const importing = runBrowserCookieImportWorker(source, {
      ownerId: importOwnerId,
      signal: abortController.signal,
      timeoutMs: 60_000,
      createTempDirectory: async () => "/private/parent-owned",
      cleanupTempDirectory,
      createWorker,
    });
    await vi.waitFor(() => expect(createWorker).toHaveBeenCalledTimes(1));
    abortController.abort();

    await expect(importing).rejects.toThrow("canceled");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(cleanupTempDirectory).toHaveBeenCalledWith("/private/parent-owned");
    expect(lifecycle).toEqual(["terminate", "cleanup"]);
  });
});
