export type DesktopCloseShortcutInput = {
  type?: string;
  key?: string;
  code?: string;
  meta?: boolean;
  control?: boolean;
  alt?: boolean;
  shift?: boolean;
};

export function isSidePanelCloseShortcutInput(
  input: DesktopCloseShortcutInput,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (input.type === "keyUp") return false;
  const key = input.key?.toLowerCase();
  const isCloseKey = key === "w" || input.code === "KeyW";
  if (!isCloseKey || input.alt || input.shift) return false;
  if (platform === "darwin") return Boolean(input.meta) && !input.control;
  return Boolean(input.control) && !input.meta;
}
