import fs from "node:fs/promises";

const UNSUPPORTED_FILE_SYNC_ERROR_CODES = new Set(["EINVAL", "ENOTSUP", "EPERM"]);

function errorCode(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && code.trim().length > 0 ? code : null;
}

export async function syncFileHandle(
  handle: { sync(): Promise<void> },
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    if (platform === "win32" && UNSUPPORTED_FILE_SYNC_ERROR_CODES.has(errorCode(error) ?? "")) return;
    throw error;
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(directory, "r");
  } catch (error) {
    if (["EISDIR", "EINVAL", "ENOTSUP"].includes(errorCode(error) ?? "")) return;
    throw error;
  }
  try {
    await handle.sync().catch((error) => {
      if (!["EINVAL", "ENOTSUP"].includes(errorCode(error) ?? "")) throw error;
    });
  } finally {
    await handle.close();
  }
}
