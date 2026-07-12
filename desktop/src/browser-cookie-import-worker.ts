import fs from "node:fs/promises";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { deriveMacChromiumCookieKey } from "./browser-cookie-crypto-macos.js";
import {
  readChromiumCookieDatabase,
  type ChromiumCookieDatabaseResult,
} from "./browser-cookie-db.js";
import {
  BROWSER_SOURCE_OPEN_ERROR_CODE,
  createPrivateBrowserImportTempDirectory,
  createStableCookieDatabaseSnapshot,
  isBrowserImportSourceOpenError,
  type BrowserCookieDatabaseSnapshot,
} from "./browser-import-snapshot.js";
import type { TrustedBrowserImportSource } from "./browser-import-sources.js";
import { readMacBrowserKeychainPassword } from "./browser-keychain-macos.js";

type BrowserCookieImportWorkerDependencies = {
  createSnapshot(input: { sourcePath: string }): Promise<BrowserCookieDatabaseSnapshot>;
  readDatabase(input: {
    databasePath: string;
    key: Uint8Array | null;
  }): ChromiumCookieDatabaseResult;
  readKeychain(keychain: TrustedBrowserImportSource["keychain"]): Promise<Buffer>;
  deriveKey(password: Uint8Array): Buffer;
};

export async function processBrowserCookieImportSource(
  source: TrustedBrowserImportSource,
  dependencies: Partial<BrowserCookieImportWorkerDependencies> = {},
): Promise<ChromiumCookieDatabaseResult> {
  const createSnapshot = dependencies.createSnapshot ?? ((input) =>
    createStableCookieDatabaseSnapshot(input));
  const readDatabase = dependencies.readDatabase ?? readChromiumCookieDatabase;
  const readKeychain = dependencies.readKeychain ?? readMacBrowserKeychainPassword;
  const deriveKey = dependencies.deriveKey ?? deriveMacChromiumCookieKey;
  let snapshot: BrowserCookieDatabaseSnapshot;
  try {
    snapshot = await createSnapshot({ sourcePath: source.cookieDatabasePath });
  } catch (error) {
    if (!isBrowserImportSourceOpenError(error)) throw error;
    return {
      cookies: [],
      skippedCount: 0,
      failedCount: 1,
      errors: [{
        errorCode: BROWSER_SOURCE_OPEN_ERROR_CODE,
        message: "Close the source browser and try the import again.",
      }],
    };
  }
  let password: Buffer | null = null;
  let key: Buffer | null = null;
  try {
    let result = readDatabase({ databasePath: snapshot.databasePath, key: null });
    if (!result.errors.some((error) => error.errorCode === "COOKIE_KEY_UNAVAILABLE")) return result;

    try {
      password = await readKeychain(source.keychain);
    } catch {
      return result;
    }
    key = deriveKey(password);
    result = readDatabase({ databasePath: snapshot.databasePath, key });
    return result;
  } finally {
    key?.fill(0);
    password?.fill(0);
    await snapshot.cleanup();
  }
}

type WorkerMessage =
  | { ok: true; result: ChromiumCookieDatabaseResult }
  | { ok: false };

type BrowserCookieImportWorkerData = {
  source: TrustedBrowserImportSource;
  tempDirectory: string;
};

type BrowserCookieImportWorkerOptions = {
  ownerId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  createTempDirectory?: (ownerId: string) => Promise<string>;
  cleanupTempDirectory?: (tempDirectory: string) => Promise<void>;
  createWorker?: (workerData: BrowserCookieImportWorkerData) => Worker;
};

export async function runBrowserCookieImportWorker(
  source: TrustedBrowserImportSource,
  options: BrowserCookieImportWorkerOptions,
): Promise<ChromiumCookieDatabaseResult> {
  const createTempDirectory = options.createTempDirectory
    ?? ((ownerId: string) => createPrivateBrowserImportTempDirectory({ ownerId }));
  const tempDirectory = await createTempDirectory(options.ownerId);
  const cleanupTempDirectory = options.cleanupTempDirectory
    ?? ((directory: string) => fs.rm(directory, { recursive: true, force: true }));
  const createWorker = options.createWorker
    ?? ((data: BrowserCookieImportWorkerData) => new Worker(new URL(import.meta.url), { workerData: data }));

  try {
    return await new Promise((resolve, reject) => {
      let worker: Worker;
      try {
        worker = createWorker({ source, tempDirectory });
      } catch {
        reject(new Error("Browser data import failed."));
        return;
      }
      let settled = false;
      const finish = async (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", handleAbort);
        await worker.terminate().catch(() => undefined);
        callback();
      };
      const handleAbort = () => {
        void finish(() => reject(new Error("Browser data import canceled.")));
      };
      const timeout = setTimeout(() => {
        void finish(() => reject(new Error("Browser data import timed out.")));
      }, options.timeoutMs ?? 120_000);
      options.signal?.addEventListener("abort", handleAbort, { once: true });
      if (options.signal?.aborted) {
        handleAbort();
        return;
      }
      worker.once("message", (message: WorkerMessage) => {
        if (message?.ok === true) void finish(() => resolve(message.result));
        else void finish(() => reject(new Error("Browser data import failed.")));
      });
      worker.once("error", () => void finish(() => reject(new Error("Browser data import failed."))));
      worker.once("exit", () => {
        void finish(() => reject(new Error("Browser data import failed.")));
      });
    });
  } finally {
    await cleanupTempDirectory(tempDirectory);
  }
}

if (!isMainThread) {
  const input = workerData as BrowserCookieImportWorkerData;
  void processBrowserCookieImportSource(input.source, {
    createSnapshot: ({ sourcePath }) => createStableCookieDatabaseSnapshot({
      sourcePath,
      tempDirectory: input.tempDirectory,
    }),
  })
    .then((result) => parentPort?.postMessage({ ok: true, result } satisfies WorkerMessage))
    .catch(() => parentPort?.postMessage({ ok: false } satisfies WorkerMessage));
}
