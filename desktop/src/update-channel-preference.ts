import fs from "node:fs";
import path from "node:path";
import type { DesktopUpdateChannel } from "./update-check.js";

const UPDATE_CHANNEL_PREFERENCE_FILE = "desktop-update-channel.json";

type StoredUpdateChannelPreference = {
  channel?: unknown;
};

export function normalizeDesktopUpdateChannel(value: unknown): DesktopUpdateChannel {
  return value === "canary" ? "canary" : "stable";
}

export function readDesktopUpdateChannel(userDataPath: string): DesktopUpdateChannel {
  try {
    const raw = fs.readFileSync(path.join(userDataPath, UPDATE_CHANNEL_PREFERENCE_FILE), "utf8");
    const parsed = JSON.parse(raw) as StoredUpdateChannelPreference;
    return normalizeDesktopUpdateChannel(parsed.channel);
  } catch {
    return "stable";
  }
}

export function writeDesktopUpdateChannel(userDataPath: string, channel: DesktopUpdateChannel): DesktopUpdateChannel {
  const normalized = normalizeDesktopUpdateChannel(channel);
  fs.mkdirSync(userDataPath, { recursive: true });
  const targetPath = path.join(userDataPath, UPDATE_CHANNEL_PREFERENCE_FILE);
  const tempPath = `${targetPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify({ channel: normalized }, null, 2)}\n`);
  fs.renameSync(tempPath, targetPath);
  return normalized;
}
