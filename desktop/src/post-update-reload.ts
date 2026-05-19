import fs from "node:fs";
import path from "node:path";

const POST_UPDATE_RELOAD_MARKER_FILE = "post-update-reload.json";
const POST_UPDATE_RELOAD_MARKER_VERSION = 1;
const DEFAULT_POST_UPDATE_RELOAD_DELAY_MS = 1_500;
const MAX_POST_UPDATE_RELOAD_AGE_MS = 30 * 60 * 1_000;

export type PostUpdateReloadMarker = {
  version: 1;
  requestedAt: string;
  targetVersion?: string;
  updateId?: string;
};

export function resolvePostUpdateReloadMarkerPath(userDataPath: string): string {
  return path.join(userDataPath, POST_UPDATE_RELOAD_MARKER_FILE);
}

export function writePostUpdateReloadMarker(
  userDataPath: string,
  marker: { targetVersion?: string; updateId?: string },
): void {
  const markerPath = resolvePostUpdateReloadMarkerPath(userDataPath);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(
    markerPath,
    `${JSON.stringify({
      version: POST_UPDATE_RELOAD_MARKER_VERSION,
      requestedAt: new Date().toISOString(),
      ...marker,
    })}\n`,
    "utf8",
  );
}

export function clearPostUpdateReloadMarker(userDataPath: string): void {
  fs.rmSync(resolvePostUpdateReloadMarkerPath(userDataPath), { force: true });
}

function isPostUpdateReloadMarker(value: unknown): value is PostUpdateReloadMarker {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.version === POST_UPDATE_RELOAD_MARKER_VERSION && typeof record.requestedAt === "string";
}

export function consumePostUpdateReloadMarker(
  userDataPath: string,
  options: { now?: Date; maxAgeMs?: number } = {},
): PostUpdateReloadMarker | null {
  const markerPath = resolvePostUpdateReloadMarkerPath(userDataPath);
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, "utf8")) as unknown;
    fs.rmSync(markerPath, { force: true });
    if (!isPostUpdateReloadMarker(parsed)) return null;

    const requestedAt = Date.parse(parsed.requestedAt);
    if (!Number.isFinite(requestedAt)) return null;
    const ageMs = (options.now ?? new Date()).getTime() - requestedAt;
    if (ageMs < 0 || ageMs > (options.maxAgeMs ?? MAX_POST_UPDATE_RELOAD_AGE_MS)) return null;
    return parsed;
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    if (code !== "ENOENT") {
      fs.rmSync(markerPath, { force: true });
    }
    return null;
  }
}

export function resolvePostUpdateReloadDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RUDDER_DESKTOP_POST_UPDATE_RELOAD_DELAY_MS?.trim();
  if (!raw) return DEFAULT_POST_UPDATE_RELOAD_DELAY_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : DEFAULT_POST_UPDATE_RELOAD_DELAY_MS;
}
