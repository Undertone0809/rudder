import type {
  KeyboardShortcutActionId,
  KeyboardShortcutBinding,
  KeyboardShortcutSettings,
} from "@rudderhq/shared";

export type ShortcutRegistryActionId = KeyboardShortcutActionId | "system.escapeBack";

export type ShortcutScope = "Global" | "System";

export interface KeyboardShortcutRegistryEntry {
  actionId: ShortcutRegistryActionId;
  label: string;
  description: string;
  scope: ShortcutScope;
  defaultBindings: KeyboardShortcutBinding[];
  configurable: boolean;
  disableable: boolean;
}

export const KEYBOARD_SHORTCUT_REGISTRY: KeyboardShortcutRegistryEntry[] = [
  {
    actionId: "commandPalette.open",
    label: "Open command palette",
    description: "Search and jump across Rudder.",
    scope: "Global",
    defaultBindings: [
      { key: "k", metaKey: true },
      { key: "k", ctrlKey: true },
    ],
    configurable: true,
    disableable: true,
  },
  {
    actionId: "settings.open",
    label: "Open settings",
    description: "Open System Settings.",
    scope: "Global",
    defaultBindings: [
      { key: ",", metaKey: true },
      { key: ",", ctrlKey: true },
    ],
    configurable: true,
    disableable: true,
  },
  {
    actionId: "issue.create",
    label: "Create issue",
    description: "Open the new issue dialog.",
    scope: "Global",
    defaultBindings: [
      { key: "n", metaKey: true },
      { key: "c" },
    ],
    configurable: true,
    disableable: true,
  },
  {
    actionId: "sidebar.toggle",
    label: "Toggle sidebar",
    description: "Show or hide the workspace sidebar.",
    scope: "Global",
    defaultBindings: [{ key: "[" }],
    configurable: true,
    disableable: true,
  },
  {
    actionId: "panel.toggle",
    label: "Toggle panel",
    description: "Show or hide the context panel.",
    scope: "Global",
    defaultBindings: [{ key: "]" }],
    configurable: true,
    disableable: true,
  },
  {
    actionId: "system.escapeBack",
    label: "Navigate back / close detail",
    description: "System Escape behavior is read-only in this version.",
    scope: "System",
    defaultBindings: [{ key: "Escape" }],
    configurable: false,
    disableable: false,
  },
];

const CONFIGURABLE_ACTION_IDS = new Set<ShortcutRegistryActionId>(
  KEYBOARD_SHORTCUT_REGISTRY
    .filter((entry) => entry.configurable)
    .map((entry) => entry.actionId),
);

const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);

function isMacPlatform() {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

export function normalizeShortcutKey(key: string) {
  return key.length === 1 ? key.toLowerCase() : key;
}

export function normalizeShortcutBinding(binding: KeyboardShortcutBinding): KeyboardShortcutBinding {
  return {
    key: normalizeShortcutKey(binding.key.trim()),
    ...(binding.code ? { code: binding.code.trim() } : {}),
    ...(binding.metaKey ? { metaKey: true } : {}),
    ...(binding.ctrlKey ? { ctrlKey: true } : {}),
    ...(binding.altKey ? { altKey: true } : {}),
    ...(binding.shiftKey ? { shiftKey: true } : {}),
  };
}

export function bindingSignature(binding: KeyboardShortcutBinding) {
  const normalized = normalizeShortcutBinding(binding);
  return [
    normalized.metaKey ? "meta" : "",
    normalized.ctrlKey ? "ctrl" : "",
    normalized.altKey ? "alt" : "",
    normalized.shiftKey ? "shift" : "",
    normalized.key,
  ].filter(Boolean).join("+");
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  const tagName = target.tagName;
  return tagName === "INPUT"
    || tagName === "TEXTAREA"
    || tagName === "SELECT"
    || target.isContentEditable
    || Boolean(target.closest('[contenteditable="true"], [contenteditable="plaintext-only"]'));
}

export function shortcutEventToBinding(event: KeyboardEvent): KeyboardShortcutBinding | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  return normalizeShortcutBinding({
    key: event.key,
    code: event.code || undefined,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
  });
}

export function matchesShortcutBinding(event: KeyboardEvent, binding: KeyboardShortcutBinding) {
  const normalized = normalizeShortcutBinding(binding);
  return normalizeShortcutKey(event.key) === normalized.key
    && event.metaKey === Boolean(normalized.metaKey)
    && event.ctrlKey === Boolean(normalized.ctrlKey)
    && event.altKey === Boolean(normalized.altKey)
    && event.shiftKey === Boolean(normalized.shiftKey);
}

export function resolveKeyboardShortcutBindings(
  settings: KeyboardShortcutSettings | null | undefined,
): Record<KeyboardShortcutActionId, KeyboardShortcutBinding[]> {
  const resolved = {} as Record<KeyboardShortcutActionId, KeyboardShortcutBinding[]>;
  for (const entry of KEYBOARD_SHORTCUT_REGISTRY) {
    if (!CONFIGURABLE_ACTION_IDS.has(entry.actionId)) continue;
    resolved[entry.actionId as KeyboardShortcutActionId] = entry.defaultBindings.map(normalizeShortcutBinding);
  }

  for (const preference of settings?.shortcuts ?? []) {
    const entry = KEYBOARD_SHORTCUT_REGISTRY.find((item) => item.actionId === preference.actionId);
    if (!entry?.configurable) continue;
    if (preference.disabled === true) {
      resolved[preference.actionId] = [];
      continue;
    }
    if (preference.bindings && preference.bindings.length > 0) {
      resolved[preference.actionId] = preference.bindings.map(normalizeShortcutBinding);
    }
  }

  return resolved;
}

export function eventMatchesShortcutAction(
  event: KeyboardEvent,
  actionId: KeyboardShortcutActionId,
  settings: KeyboardShortcutSettings | null | undefined,
) {
  const bindings = resolveKeyboardShortcutBindings(settings)[actionId] ?? [];
  return bindings.some((binding) => matchesShortcutBinding(event, binding));
}

export function formatShortcutBinding(binding: KeyboardShortcutBinding) {
  const normalized = normalizeShortcutBinding(binding);
  const parts: string[] = [];
  if (normalized.metaKey) parts.push(isMacPlatform() ? "Cmd" : "Meta");
  if (normalized.ctrlKey) parts.push("Ctrl");
  if (normalized.altKey) parts.push(isMacPlatform() ? "Opt" : "Alt");
  if (normalized.shiftKey) parts.push("Shift");
  parts.push(formatShortcutKey(normalized.key));
  return parts.join("+");
}

function formatShortcutKey(key: string) {
  if (key === " ") return "Space";
  if (key === "Escape") return "Esc";
  if (key.length === 1) return key.toUpperCase();
  return key;
}

export function isReservedShortcut(binding: KeyboardShortcutBinding) {
  const normalized = normalizeShortcutBinding(binding);
  const key = normalized.key.toLowerCase();
  const commandLike = normalized.metaKey || normalized.ctrlKey;
  if (!commandLike) return false;
  return ["l", "r", "w", "q"].includes(key);
}

export function findShortcutConflict(
  actionId: KeyboardShortcutActionId,
  binding: KeyboardShortcutBinding,
  settings: KeyboardShortcutSettings | null | undefined,
) {
  const signature = bindingSignature(binding);
  const resolved = resolveKeyboardShortcutBindings(settings);
  for (const [candidateActionId, bindings] of Object.entries(resolved) as Array<[KeyboardShortcutActionId, KeyboardShortcutBinding[]]>) {
    if (candidateActionId === actionId) continue;
    if (bindings.some((candidate) => bindingSignature(candidate) === signature)) {
      return candidateActionId;
    }
  }
  return null;
}

export function setShortcutPreference(
  settings: KeyboardShortcutSettings,
  actionId: KeyboardShortcutActionId,
  preference: Omit<KeyboardShortcutSettings["shortcuts"][number], "actionId"> | null,
): KeyboardShortcutSettings {
  const next = settings.shortcuts.filter((shortcut) => shortcut.actionId !== actionId);
  if (preference) {
    next.push({ actionId, ...preference });
  }
  return { shortcuts: next };
}
