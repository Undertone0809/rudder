import { describe, expect, it, vi } from "vitest";
import {
  runElectronBuilderWithMirrorFallback,
  windowsCodeSignArtifactUrls,
} from "./dist.mjs";

describe("Desktop electron-builder downloads", () => {
  it("uses GitHub first and a mirror fallback for the verified winCodeSign archive", () => {
    expect(windowsCodeSignArtifactUrls({})).toEqual([
      "https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z",
      "https://npmmirror.com/mirrors/electron-builder-binaries/winCodeSign-2.6.0/winCodeSign-2.6.0.7z",
    ]);
    expect(windowsCodeSignArtifactUrls({
      ELECTRON_BUILDER_BINARIES_MIRROR: "https://example.test/artifacts",
    })).toEqual([
      "https://example.test/artifacts/winCodeSign-2.6.0/winCodeSign-2.6.0.7z",
    ]);
  });

  it("keeps the primary source when electron-builder succeeds", async () => {
    const execute = vi.fn(async () => undefined);

    await runElectronBuilderWithMirrorFallback(["electron-builder", "--win"], {
      execute,
      platform: "win32",
      environment: {},
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][2]).toBeUndefined();
  });

  it("retries a failed Windows build with the verified binary mirror", async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error("GitHub download timed out"))
      .mockResolvedValueOnce(undefined);

    await runElectronBuilderWithMirrorFallback(["electron-builder", "--win"], {
      execute,
      platform: "win32",
      environment: {},
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1][2]).toEqual({
      env: {
        ELECTRON_BUILDER_BINARIES_MIRROR:
          "https://npmmirror.com/mirrors/electron-builder-binaries/",
      },
    });
  });

  it("does not replace an explicitly configured binary mirror", async () => {
    const failure = new Error("custom mirror failed");
    const execute = vi.fn(async () => { throw failure; });

    await expect(runElectronBuilderWithMirrorFallback(["electron-builder", "--win"], {
      execute,
      platform: "win32",
      environment: { ELECTRON_BUILDER_BINARIES_MIRROR: "https://example.test/" },
    })).rejects.toBe(failure);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("reports both Windows download failures", async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error("primary failed"))
      .mockRejectedValueOnce(new Error("mirror failed"));

    await expect(runElectronBuilderWithMirrorFallback(["electron-builder", "--win"], {
      execute,
      platform: "win32",
      environment: {},
    })).rejects.toThrow(
      "electron-builder failed with both the primary binary source and fallback mirror",
    );
  });
});
