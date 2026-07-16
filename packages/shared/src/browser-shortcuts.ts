export const BROWSER_SHORTCUT_ACTIONS = [
  "reload",
  "reload_ignoring_cache",
  "new_tab",
  "focus_location",
  "go_back",
  "go_forward",
  "zoom_in",
  "zoom_out",
  "zoom_reset",
] as const;

export type BrowserShortcutAction = (typeof BROWSER_SHORTCUT_ACTIONS)[number];

export type BrowserShortcutInput = {
  type?: string;
  key?: string;
  code?: string;
  meta?: boolean;
  control?: boolean;
  alt?: boolean;
  shift?: boolean;
};

export function isBrowserShortcutAction(value: unknown): value is BrowserShortcutAction {
  return typeof value === "string" && BROWSER_SHORTCUT_ACTIONS.includes(value as BrowserShortcutAction);
}

export function resolveBrowserShortcutInput(
  input: BrowserShortcutInput,
  options: { isMac: boolean },
): BrowserShortcutAction | null {
  if (input.type === "keyUp" || input.alt) return null;
  const command = options.isMac
    ? Boolean(input.meta) && !input.control
    : Boolean(input.control) && !input.meta;
  if (!command) return null;

  const key = input.key?.toLowerCase();
  const code = input.code;
  const matches = (expectedKey: string, expectedCode: string) => key === expectedKey || code === expectedCode;

  if (matches("r", "KeyR")) return input.shift ? "reload_ignoring_cache" : "reload";
  if (input.shift) {
    if (key === "+" || code === "NumpadAdd" || code === "Equal") return "zoom_in";
    return null;
  }
  if (matches("t", "KeyT")) return "new_tab";
  if (matches("l", "KeyL")) return "focus_location";
  if (key === "[" || code === "BracketLeft") return "go_back";
  if (key === "]" || code === "BracketRight") return "go_forward";
  if (key === "+" || key === "=" || code === "Equal" || code === "NumpadAdd") return "zoom_in";
  if (key === "-" || code === "Minus" || code === "NumpadSubtract") return "zoom_out";
  if (key === "0" || code === "Digit0" || code === "Numpad0") return "zoom_reset";
  return null;
}
