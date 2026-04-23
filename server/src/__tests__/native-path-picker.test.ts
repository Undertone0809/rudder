import { describe, expect, it, vi } from "vitest";
import { createNativePathPicker, NativePathPickerUnsupportedError } from "../services/native-path-picker.js";

describe("native path picker", () => {
  it("returns a selected macOS directory path", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "/Users/test/project\n", stderr: "" });
    const picker = createNativePathPicker({ platform: "darwin", execFileAsync: exec });

    await expect(picker.pick("directory")).resolves.toBe("/Users/test/project");
    expect(exec).toHaveBeenCalledWith(
      "osascript",
      ["-e", 'POSIX path of (choose folder with prompt "Select directory")'],
      { encoding: "utf8" },
    );
  });

  it("treats macOS cancellation as a null selection", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("execution error: User canceled. (-128)"));
    const picker = createNativePathPicker({ platform: "darwin", execFileAsync: exec });

    await expect(picker.pick("file")).resolves.toBeNull();
  });

  it("returns null when Windows picker is cancelled", async () => {
    const cancelled = new Error("cancelled");
    (cancelled as Error & { code: number }).code = 2;
    const exec = vi.fn().mockRejectedValue(cancelled);
    const picker = createNativePathPicker({ platform: "win32", execFileAsync: exec });

    await expect(picker.pick("file")).resolves.toBeNull();
  });

  it("falls back to kdialog on Linux when zenity is missing", async () => {
    const exec = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("not found"), { code: "ENOENT" }))
      .mockResolvedValueOnce({ stdout: "/home/test/project\n", stderr: "" });
    const picker = createNativePathPicker({
      platform: "linux",
      execFileAsync: exec,
      env: { HOME: "/home/test" },
    });

    await expect(picker.pick("directory")).resolves.toBe("/home/test/project");
  });

  it("reports unsupported Linux environments when no picker is installed", async () => {
    const exec = vi.fn().mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOENT" }));
    const picker = createNativePathPicker({
      platform: "linux",
      execFileAsync: exec,
      env: { HOME: "/home/test" },
    });

    await expect(picker.pick("file")).rejects.toBeInstanceOf(NativePathPickerUnsupportedError);
  });
});
