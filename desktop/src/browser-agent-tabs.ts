import { randomUUID } from "node:crypto";
import type { BrowserAdvancedAction } from "./browser-agent-advanced.js";
import { isAllowedBrowserNavigationUrl } from "./browser-profile.js";

export const BROWSER_AGENT_ACTIONS = [
  "tabs",
  "user_tabs",
  "open",
  "navigate",
  "back",
  "forward",
  "reload",
  "viewport",
  "visibility",
  "snapshot",
  "locator",
  "cua",
  "dom_cua",
  "dialog",
  "clipboard",
  "logs",
  "download",
  "assets",
  "content",
  "wait",
  "read",
  "click",
  "type",
  "screenshot",
  "close",
] as const;

export type BrowserAgentAction = typeof BROWSER_AGENT_ACTIONS[number];

export type BrowserRuntimeIdentity = {
  orgId: string;
  agentId: string;
  runId: string;
};

export type BrowserAgentCommand = {
  identity: BrowserRuntimeIdentity;
  action: BrowserAgentAction;
  args: Record<string, unknown>;
  deadlineAt?: number;
  signal?: AbortSignal;
};

export type BrowserAgentTab = {
  loadURL(url: string): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  getViewport(): { width: number; height: number };
  setViewport(width: number, height: number): void;
  resetViewport(): void;
  isVisible(): boolean;
  setVisible(visible: boolean): void;
  advanced(action: BrowserAdvancedAction, args: Record<string, unknown>): Promise<unknown>;
  getURL(): string;
  getTitle(): string;
  isDestroyed(): boolean;
  stop(): void;
  close(): Promise<void>;
  onDestroyed(listener: () => void): void;
  executeIsolatedJavaScript(script: string): Promise<unknown>;
  capturePng(): Promise<Buffer>;
};

export type BrowserAgentTabFactory = (input: {
  tabId: string;
  identity: BrowserRuntimeIdentity;
}) => Promise<BrowserAgentTab>;

export class BrowserAgentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

type BrowserTabRecord = {
  tabId: string;
  identity: BrowserRuntimeIdentity;
  ownerKey: string;
  createdAt: string;
  tab: BrowserAgentTab;
  snapshotId: string | null;
  refs: Set<string>;
  operationQueue: Promise<void>;
  releaseCapacity: () => void;
};

type BrowserRunState = {
  identity: BrowserRuntimeIdentity;
  selectedTabId: string | null;
  viewport: { width: number; height: number } | null;
  visible: boolean;
  clipboard: Array<{
    entries: Array<{ mimeType: string; text?: string; base64?: string }>;
    presentationStyle?: "unspecified" | "inline" | "attachment";
  }>;
  assetBundleBytes: number;
  assetBundleQueue: Promise<void>;
};

type BrowserReadRef = {
  ref: string;
  role: string;
  name: string;
  href?: string;
};

type BrowserReadResult = {
  url: string;
  title: string;
  text: string;
  refs: BrowserReadRef[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, maxLength = 8_192): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new BrowserAgentError("browser_invalid_argument", `Browser ${field} is invalid.`);
  }
  return value;
}

function optionalString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new BrowserAgentError("browser_invalid_argument", `Browser ${field} is invalid.`);
  }
  return value;
}

function boundedClipboardItems(value: unknown): BrowserRunState["clipboard"] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new BrowserAgentError("browser_invalid_argument", "Browser clipboard items are invalid.");
  }
  const items = value.map((item) => {
    if (!isRecord(item) || !Array.isArray(item.entries) || item.entries.length > 20) {
      throw new BrowserAgentError("browser_invalid_argument", "Browser clipboard item is invalid.");
    }
    const entries = item.entries.map((entry) => {
      if (!isRecord(entry)) throw new BrowserAgentError("browser_invalid_argument", "Browser clipboard entry is invalid.");
      const mimeType = requiredString(entry.mimeType, "clipboard MIME type", 200);
      const text = optionalString(entry.text, "clipboard text", 500_000);
      const base64 = optionalString(entry.base64, "clipboard binary payload", 650_000);
      if ((text === undefined) === (base64 === undefined)) {
        throw new BrowserAgentError("browser_invalid_argument", "Browser clipboard entry requires exactly one text or Base64 payload.");
      }
      if (base64 !== undefined) {
        const bytes = Buffer.from(base64, "base64");
        if (bytes.length > 1_000_000 || bytes.toString("base64").replace(/=+$/u, "") !== base64.replace(/=+$/u, "")) {
          throw new BrowserAgentError("browser_invalid_argument", "Browser clipboard Base64 payload is invalid.");
        }
      }
      return { mimeType, ...(text !== undefined ? { text } : { base64 }) };
    });
    const presentationStyle = item.presentationStyle;
    if (presentationStyle !== undefined && !["unspecified", "inline", "attachment"].includes(String(presentationStyle))) {
      throw new BrowserAgentError("browser_invalid_argument", "Browser clipboard presentation style is invalid.");
    }
    return {
      entries,
      ...(presentationStyle !== undefined ? { presentationStyle: presentationStyle as "unspecified" | "inline" | "attachment" } : {}),
    };
  });
  if (Buffer.byteLength(JSON.stringify(items), "utf8") > 750_000) {
    throw new BrowserAgentError("browser_result_too_large", "Browser clipboard exceeded the session limit.");
  }
  return items;
}

function requiredIdentity(value: unknown): BrowserRuntimeIdentity {
  if (!isRecord(value)) {
    throw new BrowserAgentError("browser_invalid_argument", "Browser runtime identity is invalid.");
  }
  return {
    orgId: requiredString(value.orgId, "organization identity", 160),
    agentId: requiredString(value.agentId, "agent identity", 160),
    runId: requiredString(value.runId, "run identity", 160),
  };
}

function ownerKey(identity: BrowserRuntimeIdentity): string {
  return JSON.stringify([identity.orgId, identity.agentId, identity.runId]);
}

export function createBrowserAgentTabCapacity(options: {
  maxTabsPerRun?: number;
  maxTabsTotal?: number;
} = {}) {
  const maxTabsPerRun = options.maxTabsPerRun ?? 8;
  const maxTabsTotal = options.maxTabsTotal ?? 32;
  const reservedByOwner = new Map<string, number>();
  let reservedTotal = 0;

  return {
    reserve(identity: BrowserRuntimeIdentity): (() => void) | null {
      const key = ownerKey(identity);
      const reservedForOwner = reservedByOwner.get(key) ?? 0;
      if (reservedForOwner >= maxTabsPerRun || reservedTotal >= maxTabsTotal) return null;
      reservedByOwner.set(key, reservedForOwner + 1);
      reservedTotal += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const nextForOwner = (reservedByOwner.get(key) ?? 1) - 1;
        if (nextForOwner > 0) reservedByOwner.set(key, nextForOwner);
        else reservedByOwner.delete(key);
        reservedTotal = Math.max(0, reservedTotal - 1);
      };
    },
    count(): number {
      return reservedTotal;
    },
  };
}

function safeWebUrl(url: string, rudderAppOrigins: string[]): string {
  if (!isAllowedBrowserNavigationUrl(url, rudderAppOrigins)) {
    throw new BrowserAgentError("browser_unsafe_url", "Browser navigation requires an approved HTTP or HTTPS URL.");
  }
  return url;
}

function scriptPayload(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function browserDomHelpers(): string {
  return `
    const decodePayload = (encoded) => {
      const binary = atob(encoded);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    };
    const elementName = (element) => (element.getAttribute("aria-label") || element.getAttribute("alt") || element.getAttribute("placeholder") || element.getAttribute("title") || element.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 500);
    const owningForm = (element) => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLButtonElement ? element.form : element.closest("form");
    const fingerprint = (element) => {
      const form = owningForm(element);
      return JSON.stringify({
        tag: element.tagName.toLowerCase(),
        type: element instanceof HTMLInputElement || element instanceof HTMLButtonElement ? element.type : "",
        role: element.getAttribute("role") || "",
        name: elementName(element),
        controlName: element.getAttribute("name") || "",
        formAssociation: element.getAttribute("form") || "",
        href: element instanceof HTMLAnchorElement ? String(element.href || "").slice(0, 8192) : "",
        formId: form?.id || "",
        formAction: String((element instanceof HTMLInputElement || element instanceof HTMLButtonElement ? element.getAttribute("formaction") : "") || form?.action || "").slice(0, 8192),
        formMethod: String((element instanceof HTMLInputElement || element instanceof HTMLButtonElement ? element.getAttribute("formmethod") : "") || form?.method || "").toLowerCase().slice(0, 20),
        formTarget: String((element instanceof HTMLInputElement || element instanceof HTMLButtonElement ? element.getAttribute("formtarget") : "") || form?.target || "").slice(0, 500),
        formEnctype: String((element instanceof HTMLInputElement || element instanceof HTMLButtonElement ? element.getAttribute("formenctype") : "") || form?.enctype || "").toLowerCase().slice(0, 100),
        readOnly: "readOnly" in element && Boolean(element.readOnly),
        editable: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable,
      });
    };
    const immutableFingerprint = (element) => {
      const value = JSON.parse(fingerprint(element));
      delete value.name;
      return JSON.stringify(value);
    };
    const isRendered = (element) => {
      if (!(element instanceof Element) || !element.isConnected) return false;
      let current = element;
      while (current) {
        const style = window.getComputedStyle(current);
        if (current.hidden || current.hasAttribute("inert") || current.getAttribute("aria-hidden") === "true" || style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
        current = current.parentElement;
      }
      return true;
    };
    const isInteractable = (element) => {
      if (!isRendered(element)) return false;
      if (element.closest("fieldset[disabled]")) return false;
      let current = element;
      while (current) {
        if (window.getComputedStyle(current).pointerEvents === "none") return false;
        current = current.parentElement;
      }
      const disabled = "disabled" in element && Boolean(element.disabled);
      if (disabled || element.getAttribute("aria-disabled") === "true") return false;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) return false;
      const x = Math.min(Math.max(rect.left + rect.width / 2, 0), Math.max(window.innerWidth - 1, 0));
      const y = Math.min(Math.max(rect.top + rect.height / 2, 0), Math.max(window.innerHeight - 1, 0));
      const topmost = document.elementFromPoint(x, y);
      return Boolean(topmost && (topmost === element || element.contains(topmost)));
    };
    const isEditableElement = (element) => {
      if (element instanceof HTMLTextAreaElement) return !element.readOnly;
      if (element instanceof HTMLInputElement) {
        const unsupported = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);
        return !element.readOnly && !unsupported.has(element.type.toLowerCase());
      }
      return element.isContentEditable;
    };
  `;
}

function browserReadScript(snapshotId: string): string {
  const payload = scriptPayload({ snapshotId });
  return `(() => {
    "RUDDER_BROWSER_READ_V1";
    ${browserDomHelpers()}
    const { snapshotId } = decodePayload("${payload}");
    const selector = "a,button,input,textarea,select,[contenteditable='true'],[role='button'],[role='link'],[role='textbox'],[role='checkbox'],[role='radio'],[role='combobox'],[tabindex]";
    const candidates = [];
    const root = document.body || document.documentElement;
    if (root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let inspected = 0;
      let current = root;
      while (current && inspected < 5000 && candidates.length < 200) {
        inspected += 1;
        if (current instanceof Element && current.matches(selector) && isInteractable(current)) candidates.push(current);
        current = walker.nextNode();
      }
    }
    const elements = new Map();
    const refs = candidates.map((element, index) => {
      const ref = snapshotId + ":" + index;
      elements.set(ref, { element, fingerprint: fingerprint(element) });
      const tag = element.tagName.toLowerCase();
      const role = element.getAttribute("role") || ({ a: "link", button: "button", input: "textbox", textarea: "textbox", select: "combobox" }[tag] || tag);
      const name = elementName(element);
      const href = tag === "a" && typeof element.href === "string" ? element.href.slice(0, 8192) : undefined;
      return { ref, role, name, ...(href ? { href } : {}) };
    });
    globalThis.__RUDDER_BROWSER_REFS_V1__ = { snapshotId, document, elements };
    const textParts = [];
    let textLength = 0;
    if (root) {
      const textWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let inspected = 0;
      let node = textWalker.nextNode();
      while (node && inspected < 5000 && textLength < 50000) {
        inspected += 1;
        const parent = node.parentElement;
        if (parent && !parent.closest("script,style,noscript,template") && isRendered(parent)) {
          const value = String(node.nodeValue || "").slice(0, Math.max(0, 50000 - textLength)).trim().replace(/\\s+/g, " ");
          if (value) {
            const bounded = value.slice(0, 50000 - textLength);
            textParts.push(bounded);
            textLength += bounded.length + 1;
          }
        }
        node = textWalker.nextNode();
      }
    }
    return {
      url: String(location.href).slice(0, 8192),
      title: String(document.title || "").slice(0, 500),
      text: textParts.join(" ").slice(0, 50000),
      refs,
    };
  })()`;
}

function browserClickScript(snapshotId: string, ref: string): string {
  const payload = scriptPayload({ snapshotId, ref });
  return `(() => {
    "RUDDER_BROWSER_CLICK_V1";
    ${browserDomHelpers()}
    const { snapshotId, ref } = decodePayload("${payload}");
    const state = globalThis.__RUDDER_BROWSER_REFS_V1__;
    if (!state || state.snapshotId !== snapshotId || state.document !== document) return { clicked: false };
    const entry = state.elements.get(ref);
    const element = entry?.element;
    if (!(element instanceof HTMLElement) || !element.isConnected || element.ownerDocument !== document) return { clicked: false };
    if (fingerprint(element) !== entry.fingerprint) return { clicked: false };
    element.scrollIntoView({ block: "center", inline: "center" });
    if (fingerprint(element) !== entry.fingerprint || !isInteractable(element)) return { clicked: false };
    globalThis.__RUDDER_BROWSER_REFS_V1__ = null;
    element.click();
    return { clicked: true };
  })()`;
}

function browserTypeScript(snapshotId: string, ref: string, text: string, submit: boolean): string {
  const payload = scriptPayload({ snapshotId, ref, text, submit });
  return `(() => {
    "RUDDER_BROWSER_TYPE_V1";
    ${browserDomHelpers()}
    const { snapshotId, ref, text, submit } = decodePayload("${payload}");
    const state = globalThis.__RUDDER_BROWSER_REFS_V1__;
    if (!state || state.snapshotId !== snapshotId || state.document !== document) return { typed: false, submitted: false };
    const entry = state.elements.get(ref);
    const element = entry?.element;
    if (!(element instanceof HTMLElement) || !element.isConnected || element.ownerDocument !== document) return { typed: false, submitted: false };
    if (fingerprint(element) !== entry.fingerprint) return { typed: false, submitted: false };
    element.scrollIntoView({ block: "center", inline: "center" });
    if (fingerprint(element) !== entry.fingerprint || !isInteractable(element) || !isEditableElement(element)) return { typed: false, submitted: false };
    element.focus();
    if (fingerprint(element) !== entry.fingerprint || !isInteractable(element) || !isEditableElement(element)) {
      globalThis.__RUDDER_BROWSER_REFS_V1__ = null;
      return { typed: false, submitted: false };
    }
    globalThis.__RUDDER_BROWSER_REFS_V1__ = null;
    const immutableIdentity = immutableFingerprint(element);
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(element, text); else element.value = text;
    } else if (element.isContentEditable) {
      element.textContent = text;
    } else {
      return { typed: false, submitted: false };
    }
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    if (immutableFingerprint(element) !== immutableIdentity) return { typed: true, submitted: false };
    element.dispatchEvent(new Event("change", { bubbles: true }));
    if (immutableFingerprint(element) !== immutableIdentity) return { typed: true, submitted: false };
    let submitted = false;
    if (submit) {
      const form = owningForm(element);
      if (form instanceof HTMLFormElement && typeof form.requestSubmit === "function") {
        let submitEvent = null;
        const observeSubmit = (event) => {
          if (event.target === form) submitEvent = event;
        };
        const validateSubmit = (event) => {
          if (event.target !== form) return;
          if (owningForm(element) !== form || immutableFingerprint(element) !== immutableIdentity) event.preventDefault();
        };
        window.addEventListener("submit", observeSubmit, true);
        form.addEventListener("submit", validateSubmit);
        try {
          if (immutableFingerprint(element) !== immutableIdentity || !isInteractable(element)) {
            return { typed: true, submitted: false };
          }
          form.requestSubmit();
          submitted = Boolean(submitEvent && !submitEvent.defaultPrevented && owningForm(element) === form && immutableFingerprint(element) === immutableIdentity);
        } finally {
          form.removeEventListener("submit", validateSubmit);
          window.removeEventListener("submit", observeSubmit, true);
        }
      }
      else element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    }
    return { typed: true, submitted };
  })()`;
}

function normalizedReadResult(value: unknown, snapshotId: string): BrowserReadResult {
  if (!isRecord(value)) {
    throw new BrowserAgentError("browser_broker_protocol_error", "Browser page snapshot was invalid.");
  }
  const refs = Array.isArray(value.refs)
    ? value.refs.flatMap((candidate): BrowserReadRef[] => {
        if (!isRecord(candidate)
          || typeof candidate.ref !== "string"
          || !candidate.ref.startsWith(`${snapshotId}:`)) return [];
        return [{
          ref: candidate.ref.slice(0, 160),
          role: typeof candidate.role === "string" ? candidate.role.slice(0, 80) : "element",
          name: typeof candidate.name === "string" ? candidate.name.slice(0, 500) : "",
          ...(typeof candidate.href === "string" ? { href: candidate.href.slice(0, 8_192) } : {}),
        }];
      }).slice(0, 200)
    : [];
  return {
    url: typeof value.url === "string" ? value.url.slice(0, 8_192) : "",
    title: typeof value.title === "string" ? value.title.slice(0, 500) : "",
    text: typeof value.text === "string" ? value.text.slice(0, 50_000) : "",
    refs,
  };
}

function tabSummary(record: BrowserTabRecord) {
  return {
    tabId: record.tabId,
    url: record.tab.getURL().slice(0, 8_192),
    title: record.tab.getTitle().slice(0, 500),
    createdAt: record.createdAt,
  };
}

function privacySafeUserTabs(
  tabs: Array<{ id: string; title?: string; url?: string }>,
): Array<{ id: string; title: string; url: string }> {
  return tabs.flatMap((tab) => {
    if (typeof tab.id !== "string" || typeof tab.url !== "string") return [];
    try {
      const parsed = new URL(tab.url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return [];
      return [{
        id: tab.id.slice(0, 160),
        title: parsed.hostname.slice(0, 500),
        url: `${parsed.origin}/`,
      }];
    } catch {
      return [];
    }
  });
}

export function createBrowserAgentTabController(options: {
  createTab: BrowserAgentTabFactory;
  getRudderAppOrigins(): string[];
  listUserTabs?(): Array<{ id: string; title?: string; url?: string }>;
  createId?: () => string;
  createSnapshotId?: () => string;
  now?: () => Date;
  clock?: () => number;
  maxTabsPerRun?: number;
  maxTabsTotal?: number;
  commandTimeoutMs?: number;
  maxScreenshotBytes?: number;
  maxAssetBundleBytesPerRun?: number;
  maxRunStatusFailures?: number;
  capacity?: ReturnType<typeof createBrowserAgentTabCapacity>;
}) {
  const records = new Map<string, BrowserTabRecord>();
  const pendingOpensByOwner = new Map<string, number>();
  const ownerGenerations = new Map<string, number>();
  const runStates = new Map<string, BrowserRunState>();
  let pendingOpensTotal = 0;
  let globalGeneration = 0;
  const createId = options.createId ?? randomUUID;
  const createSnapshotId = options.createSnapshotId ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const clock = options.clock ?? Date.now;
  const maxTabsPerRun = options.maxTabsPerRun ?? 8;
  const maxTabsTotal = options.maxTabsTotal ?? 32;
  const commandTimeoutMs = options.commandTimeoutMs ?? 35_000;
  const maxScreenshotBytes = options.maxScreenshotBytes ?? 10_000_000;
  const maxAssetBundleBytesPerRun = options.maxAssetBundleBytesPerRun ?? 250_000_000;
  const maxRunStatusFailures = options.maxRunStatusFailures ?? 3;
  const runStatusFailures = new Map<string, number>();

  const cleanupOwnerState = (key: string) => {
    const hasRecord = Array.from(records.values()).some((record) => record.ownerKey === key);
    if (hasRecord || (pendingOpensByOwner.get(key) ?? 0) > 0) return;
    ownerGenerations.delete(key);
    runStatusFailures.delete(key);
  };

  const runState = (identity: BrowserRuntimeIdentity): BrowserRunState => {
    const key = ownerKey(identity);
    const current = runStates.get(key);
    if (current) return current;
    const created = {
      identity: { ...identity },
      selectedTabId: null,
      viewport: null,
      visible: false,
      clipboard: [],
      assetBundleBytes: 0,
      assetBundleQueue: Promise.resolve(),
    };
    runStates.set(key, created);
    return created;
  };

  const closeRecord = async (record: BrowserTabRecord) => {
    records.delete(record.tabId);
    const state = runStates.get(record.ownerKey);
    if (state?.selectedTabId === record.tabId) {
      const replacement = Array.from(records.values()).find((candidate) => candidate.ownerKey === record.ownerKey);
      state.selectedTabId = replacement?.tabId ?? null;
      if (replacement && state.visible) replacement.tab.setVisible(true);
    }
    record.refs.clear();
    try {
      if (!record.tab.isDestroyed()) await record.tab.close();
    } finally {
      if (record.tab.isDestroyed()) record.releaseCapacity();
      cleanupOwnerState(record.ownerKey);
    }
  };

  const runAssetBundleOperation = <T>(state: BrowserRunState, operation: () => Promise<T>): Promise<T> => {
    const result = state.assetBundleQueue.then(operation);
    state.assetBundleQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  const withDeadline = async <T>(
    record: BrowserTabRecord,
    deadlineAt: number,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const remainingMs = deadlineAt - clock();
    if (remainingMs <= 0) {
      throw new BrowserAgentError("browser_timeout", "Browser action expired before execution.");
    }
    let timeout: NodeJS.Timeout | null = null;
    let abortListener: (() => void) | null = null;
    const revoke = (reject: (error: BrowserAgentError) => void, error: BrowserAgentError) => {
      try {
        record.tab.stop();
      } catch {
        // The tab is closed below even when Chromium cannot stop an operation.
      }
      void closeRecord(record).catch(() => undefined);
      reject(error);
    };
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            revoke(reject, new BrowserAgentError(
              "browser_timeout",
              "Browser action timed out and the tab was closed.",
            ));
          }, remainingMs);
        }),
        new Promise<never>((_resolve, reject) => {
          abortListener = () => revoke(reject, new BrowserAgentError(
            "browser_unavailable",
            "Browser action was cancelled and the tab was closed.",
          ));
          if (signal?.aborted) abortListener();
          else signal?.addEventListener("abort", abortListener, { once: true });
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abortListener) signal?.removeEventListener("abort", abortListener);
    }
  };

  const runRecordOperation = <T>(
    record: BrowserTabRecord,
    deadlineAt: number,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const result = record.operationQueue.then(() => {
      if (records.get(record.tabId) !== record || record.tab.isDestroyed()) {
        throw new BrowserAgentError("browser_tab_not_found", "Browser tab was not found.");
      }
      return withDeadline(record, deadlineAt, signal, operation);
    });
    record.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  const ownedRecord = (tabId: string, identity: BrowserRuntimeIdentity): BrowserTabRecord => {
    const record = records.get(tabId);
    if (!record) throw new BrowserAgentError("browser_tab_not_found", "Browser tab was not found.");
    if (record.ownerKey !== ownerKey(identity)) {
      throw new BrowserAgentError("browser_tab_forbidden", "This Browser tab belongs to another run.");
    }
    if (record.tab.isDestroyed()) {
      records.delete(tabId);
      record.releaseCapacity();
      throw new BrowserAgentError("browser_tab_not_found", "Browser tab was not found.");
    }
    return record;
  };

  const openTab = async (
    identity: BrowserRuntimeIdentity,
    rawUrl: unknown,
    deadlineAt = clock() + commandTimeoutMs,
    signal?: AbortSignal,
  ) => {
    const url = safeWebUrl(requiredString(rawUrl, "URL"), options.getRudderAppOrigins());
    const key = ownerKey(identity);
    const expectedGlobalGeneration = globalGeneration;
    const expectedOwnerGeneration = ownerGenerations.get(key) ?? 0;
    const ownedCount = Array.from(records.values()).filter((record) => record.ownerKey === key).length;
    const pendingOwned = pendingOpensByOwner.get(key) ?? 0;
    const releaseCapacity = options.capacity?.reserve(identity) ?? null;
    if ((options.capacity && !releaseCapacity)
      || (!options.capacity && (ownedCount + pendingOwned >= maxTabsPerRun
        || records.size + pendingOpensTotal >= maxTabsTotal))) {
      throw new BrowserAgentError("browser_tab_limit", "Rudder Browser tab limit reached for this run.");
    }
    pendingOpensByOwner.set(key, pendingOwned + 1);
    pendingOpensTotal += 1;
    const tabId = createId();
    let capacityTransferred = false;
    try {
      const tab = await options.createTab({
        tabId,
        identity,
      });
      // Once a native tab exists, its real destruction owns the shared slot.
      // A failed cancellation/close must stay fail-closed across controller replacement.
      capacityTransferred = true;
      try {
        tab.onDestroyed(() => releaseCapacity?.());
      } catch (error) {
        try {
          if (!tab.isDestroyed()) await tab.close();
        } catch {
          // Without a destruction signal, retain the slot rather than exceed the process limit.
        }
        if (tab.isDestroyed()) releaseCapacity?.();
        throw error;
      }
      if (tab.isDestroyed()) releaseCapacity?.();
      if (globalGeneration !== expectedGlobalGeneration
        || (ownerGenerations.get(key) ?? 0) !== expectedOwnerGeneration) {
        if (!tab.isDestroyed()) await tab.close();
        throw new BrowserAgentError("browser_tab_not_found", "Browser tab open was cancelled.");
      }
      const record: BrowserTabRecord = {
        tabId,
        identity: { ...identity },
        ownerKey: key,
        createdAt: now().toISOString(),
        tab,
        snapshotId: null,
        refs: new Set(),
        operationQueue: Promise.resolve(),
        releaseCapacity: releaseCapacity ?? (() => undefined),
      };
      const state = runState(identity);
      records.set(tabId, record);
      try {
        if (state.viewport) tab.setViewport(state.viewport.width, state.viewport.height);
        state.selectedTabId = tabId;
        tab.setVisible(state.visible);
        tab.onDestroyed(() => {
          if (records.get(tabId) === record) records.delete(tabId);
          record.releaseCapacity();
          cleanupOwnerState(record.ownerKey);
        });
      } catch (error) {
        records.delete(tabId);
        try {
          if (!tab.isDestroyed()) await tab.close();
        } catch {
          // A still-live native tab retains its shared capacity reservation.
        }
        if (tab.isDestroyed()) record.releaseCapacity();
        throw error;
      }
      try {
        await withDeadline(record, deadlineAt, signal, () => tab.loadURL(url));
      } catch (error) {
        await closeRecord(record);
        if (error instanceof BrowserAgentError) throw error;
        throw new BrowserAgentError("browser_navigation_failed", "Browser navigation failed.");
      }
      return tabSummary(record);
    } finally {
      if (!capacityTransferred) releaseCapacity?.();
      const remaining = (pendingOpensByOwner.get(key) ?? 1) - 1;
      if (remaining > 0) pendingOpensByOwner.set(key, remaining);
      else pendingOpensByOwner.delete(key);
      pendingOpensTotal -= 1;
      cleanupOwnerState(key);
    }
  };

  const closeRun = async (rawIdentity: BrowserRuntimeIdentity) => {
    const identity = requiredIdentity(rawIdentity);
    const key = ownerKey(identity);
    ownerGenerations.set(key, (ownerGenerations.get(key) ?? 0) + 1);
    runStates.delete(key);
    runStatusFailures.delete(key);
    let firstError: unknown = null;
    for (const record of Array.from(records.values())) {
      if (record.ownerKey !== key) continue;
      try {
        await closeRecord(record);
      } catch (error) {
        firstError ??= error;
      }
    }
    cleanupOwnerState(key);
    if (firstError) throw firstError;
  };

  const closeAll = async () => {
    globalGeneration += 1;
    runStates.clear();
    runStatusFailures.clear();
    let firstError: unknown = null;
    for (const record of Array.from(records.values())) {
      try {
        await closeRecord(record);
      } catch (error) {
        firstError ??= error;
      }
    }
    for (const key of ownerGenerations.keys()) cleanupOwnerState(key);
    if (firstError) throw firstError;
  };

  const execute = async (rawCommand: BrowserAgentCommand): Promise<unknown> => {
    if (!isRecord(rawCommand)) {
      throw new BrowserAgentError("browser_invalid_argument", "Browser command is invalid.");
    }
    const identity = requiredIdentity(rawCommand.identity);
    const defaultDeadline = clock() + commandTimeoutMs;
    const deadlineAt = typeof rawCommand.deadlineAt === "number" && Number.isFinite(rawCommand.deadlineAt)
      ? Math.min(rawCommand.deadlineAt, defaultDeadline)
      : defaultDeadline;
    if (deadlineAt <= clock()) {
      throw new BrowserAgentError("browser_timeout", "Browser action expired before execution.");
    }
    const action = rawCommand.action;
    if (typeof action !== "string" || !BROWSER_AGENT_ACTIONS.includes(action as BrowserAgentAction)) {
      throw new BrowserAgentError("browser_invalid_argument", "Browser action is invalid.");
    }
    const args = isRecord(rawCommand.args) ? rawCommand.args : {};
    const signal = rawCommand.signal;
    if (signal?.aborted) throw new BrowserAgentError("browser_unavailable", "Browser action was cancelled.");

    if (action === "user_tabs") {
      return { tabs: privacySafeUserTabs(options.listUserTabs?.() ?? []) };
    }
    if (action === "tabs") {
      const key = ownerKey(identity);
      const state = runStates.get(key);
      return {
        tabs: Array.from(records.values())
          .filter((record) => record.ownerKey === key && !record.tab.isDestroyed())
          .map(tabSummary),
        selectedTabId: state?.selectedTabId ?? null,
      };
    }
    if (action === "viewport") {
      const state = runState(identity);
      const operation = requiredString(args.action, "viewport action", 20);
      if (operation === "set") {
        const width = typeof args.width === "number" && Number.isInteger(args.width) && args.width >= 320 && args.width <= 3_840
          ? args.width
          : (() => { throw new BrowserAgentError("browser_invalid_argument", "Browser viewport width is invalid."); })();
        const height = typeof args.height === "number" && Number.isInteger(args.height) && args.height >= 240 && args.height <= 2_160
          ? args.height
          : (() => { throw new BrowserAgentError("browser_invalid_argument", "Browser viewport height is invalid."); })();
        state.viewport = { width, height };
        for (const candidate of records.values()) {
          if (candidate.ownerKey === ownerKey(identity)) candidate.tab.setViewport(width, height);
        }
      } else if (operation === "reset") {
        state.viewport = null;
        for (const candidate of records.values()) {
          if (candidate.ownerKey === ownerKey(identity)) candidate.tab.resetViewport();
        }
      } else if (operation !== "get") {
        throw new BrowserAgentError("browser_invalid_argument", "Browser viewport action is invalid.");
      }
      const selected = state.selectedTabId ? records.get(state.selectedTabId) : null;
      return {
        viewport: state.viewport ?? selected?.tab.getViewport() ?? null,
        overridden: state.viewport !== null,
      };
    }
    if (action === "visibility") {
      const state = runState(identity);
      if (args.visible !== undefined && typeof args.visible !== "boolean") {
        throw new BrowserAgentError("browser_invalid_argument", "Browser visibility is invalid.");
      }
      if (typeof args.visible === "boolean") state.visible = args.visible;
      for (const candidate of records.values()) {
        if (candidate.ownerKey !== ownerKey(identity)) continue;
        candidate.tab.setVisible(state.visible && candidate.tabId === state.selectedTabId);
      }
      return { visible: state.visible, selectedTabId: state.selectedTabId };
    }
    if (action === "clipboard") {
      const state = runState(identity);
      const operation = requiredString(args.action, "clipboard action", 30);
      if (operation === "writeText") {
        const text = optionalString(args.text, "clipboard text", 500_000) ?? "";
        state.clipboard = [{ entries: [{ mimeType: "text/plain", text }] }];
      } else if (operation === "write") {
        state.clipboard = boundedClipboardItems(args.items);
      } else if (operation === "clear") {
        state.clipboard = [];
      } else if (operation === "readText") {
        const selected = state.selectedTabId ? records.get(state.selectedTabId) : null;
        if (selected && selected.ownerKey === ownerKey(identity) && !selected.tab.isDestroyed()) {
          const result = await runRecordOperation(selected, deadlineAt, signal, () => (
            selected.tab.advanced("clipboard", { action: "read" })
          ));
          if (isRecord(result)) state.clipboard = boundedClipboardItems(result.items);
        }
        const text = state.clipboard
          .flatMap((item) => item.entries)
          .find((entry) => entry.mimeType === "text/plain" && entry.text !== undefined)?.text ?? "";
        return { text };
      } else if (operation !== "read") {
        throw new BrowserAgentError("browser_invalid_argument", "Browser clipboard action is invalid.");
      }
      if (operation === "read") {
        const selected = state.selectedTabId ? records.get(state.selectedTabId) : null;
        if (selected && selected.ownerKey === ownerKey(identity) && !selected.tab.isDestroyed()) {
          const result = await runRecordOperation(selected, deadlineAt, signal, () => (
            selected.tab.advanced("clipboard", { action: "read" })
          ));
          if (isRecord(result)) state.clipboard = boundedClipboardItems(result.items);
        }
      } else {
        const ownedTabs = Array.from(records.values()).filter((record) => (
          record.ownerKey === ownerKey(identity) && !record.tab.isDestroyed()
        ));
        await Promise.all(ownedTabs.map((record) => runRecordOperation(record, deadlineAt, signal, () => (
          record.tab.advanced("clipboard", { action: "write", items: state.clipboard })
        ))));
      }
      return { items: structuredClone(state.clipboard) };
    }
    if (action === "open") return openTab(identity, args.url, deadlineAt, signal);

    const tabId = requiredString(args.tabId, "tab ID", 160);
    const record = ownedRecord(tabId, identity);
    const state = runState(identity);
    state.selectedTabId = tabId;
    if (state.visible) {
      for (const candidate of records.values()) {
        if (candidate.ownerKey === record.ownerKey) candidate.tab.setVisible(candidate.tabId === tabId);
      }
    }
    if (action === "navigate") {
      return runRecordOperation(record, deadlineAt, signal, async () => {
        const url = safeWebUrl(requiredString(args.url, "URL"), options.getRudderAppOrigins());
        record.snapshotId = null;
        record.refs.clear();
        try {
          await record.tab.loadURL(url);
        } catch {
          throw new BrowserAgentError("browser_navigation_failed", "Browser navigation failed.");
        }
        return tabSummary(record);
      });
    }
    if (["snapshot", "locator", "cua", "dom_cua", "dialog", "logs", "download", "assets", "content", "wait"].includes(action)) {
      return runRecordOperation(record, deadlineAt, signal, async () => {
        const performAdvancedAction = async () => {
          try {
          const advancedArgs = action === "assets" && args.action === "bundle"
            ? {
                ...args,
                maxTotalBytes: Math.min(100_000_000, maxAssetBundleBytesPerRun - state.assetBundleBytes),
              }
            : args;
          if (action === "assets" && args.action === "bundle" && Number(advancedArgs.maxTotalBytes) <= 0) {
            throw new BrowserAgentError("browser_result_too_large", "Browser asset run quota is exhausted.");
          }
          const shortcutKeys = action === "cua" && args.action === "keypress" && Array.isArray(args.keys)
            ? args.keys.map(String)
            : [];
          const primary = shortcutKeys.findLast((key) => !["Alt", "Control", "Meta", "ControlOrMeta", "Shift"].includes(key));
          const usesVirtualClipboard = Boolean(primary
            && ["c", "v", "x"].includes(primary.toLowerCase())
            && shortcutKeys.some((key) => ["Control", "Meta", "ControlOrMeta"].includes(key)));
          if (usesVirtualClipboard) {
            await record.tab.advanced("clipboard", { action: "write", items: state.clipboard });
          }
          const result = await record.tab.advanced(action as BrowserAdvancedAction, advancedArgs);
          if (usesVirtualClipboard) {
            const clipboardResult = await record.tab.advanced("clipboard", { action: "read" });
            if (isRecord(clipboardResult)) state.clipboard = boundedClipboardItems(clipboardResult.items);
          }
          if (action === "assets" && args.action === "bundle" && isRecord(result) && isRecord(result.summary)) {
            const totalBytes = Number(result.summary.totalBytes || 0);
            if (Number.isFinite(totalBytes) && totalBytes > 0) state.assetBundleBytes += totalBytes;
          }
          return { tabId, url: record.tab.getURL().slice(0, 8_192), ...(isRecord(result) ? result : { result }) };
          } catch (error) {
            if (error instanceof BrowserAgentError) throw error;
            const message = error instanceof Error && error.message.trim()
              ? error.message.trim().slice(0, 500)
              : "Browser action failed.";
            if (/timed out/iu.test(message)) throw new BrowserAgentError("browser_timeout", message);
            if (/missing|stale|resolve|matched/iu.test(message)) throw new BrowserAgentError("browser_ref_not_found", message);
            throw new BrowserAgentError("browser_action_failed", message);
          }
        };
        if (action !== "assets" || args.action !== "bundle") return performAdvancedAction();
        return runAssetBundleOperation(state, async () => {
          if (records.get(record.tabId) !== record || record.tab.isDestroyed()) {
            throw new BrowserAgentError("browser_tab_not_found", "Browser tab was not found.");
          }
          return performAdvancedAction();
        });
      });
    }
    if (action === "back" || action === "forward" || action === "reload") {
      return runRecordOperation(record, deadlineAt, signal, async () => {
        record.snapshotId = null;
        record.refs.clear();
        try {
          if (action === "back") await record.tab.goBack();
          else if (action === "forward") await record.tab.goForward();
          else await record.tab.reload();
        } catch {
          throw new BrowserAgentError("browser_navigation_failed", `Browser ${action} failed.`);
        }
        return tabSummary(record);
      });
    }
    if (action === "read") {
      return runRecordOperation(record, deadlineAt, signal, async () => {
        const snapshotId = createSnapshotId();
        const result = normalizedReadResult(
          await record.tab.executeIsolatedJavaScript(browserReadScript(snapshotId)),
          snapshotId,
        );
        record.snapshotId = snapshotId;
        record.refs = new Set(result.refs.map((ref) => ref.ref));
        return { tabId, ...result };
      });
    }
    if (action === "click" || action === "type") {
      const ref = requiredString(args.ref, "element reference", 160);
      return runRecordOperation(record, deadlineAt, signal, async () => {
        if (!record.snapshotId || !record.refs.has(ref)) {
          throw new BrowserAgentError("browser_ref_not_found", "Browser element reference is missing or stale.");
        }
        if (action === "click") {
          const result = await record.tab.executeIsolatedJavaScript(browserClickScript(record.snapshotId, ref));
          if (!isRecord(result) || result.clicked !== true) {
            throw new BrowserAgentError("browser_ref_not_found", "Browser element reference is missing or stale.");
          }
          return { tabId, url: record.tab.getURL().slice(0, 8_192), clicked: true };
        }
        const text = typeof args.text === "string" && args.text.length <= 100_000
          ? args.text
          : (() => { throw new BrowserAgentError("browser_invalid_argument", "Browser input text is invalid."); })();
        const submit = args.submit === true;
        const result = await record.tab.executeIsolatedJavaScript(browserTypeScript(record.snapshotId, ref, text, submit));
        if (!isRecord(result) || result.typed !== true) {
          throw new BrowserAgentError("browser_ref_not_found", "Browser element reference is missing, stale, or not editable.");
        }
        return { tabId, url: record.tab.getURL().slice(0, 8_192), typed: true, submitted: result.submitted === true };
      });
    }
    if (action === "screenshot") {
      return runRecordOperation(record, deadlineAt, signal, async () => {
        let capture: {
          base64: string;
          mimeType: string;
          width?: number;
          height?: number;
          fullPage?: boolean;
        };
        try {
          capture = await record.tab.advanced("screenshot", args) as typeof capture;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/16384-pixel dimension limit|screenshot exceeded the response limit/iu.test(message)) {
            throw new BrowserAgentError("browser_result_too_large", message.slice(0, 300));
          }
          throw error;
        }
        const bytes = Buffer.from(capture.base64, "base64");
        if (bytes.length > maxScreenshotBytes) {
          throw new BrowserAgentError("browser_result_too_large", "Browser screenshot exceeded the response limit.");
        }
        return {
          tabId,
          url: record.tab.getURL().slice(0, 8_192),
          ...capture,
        };
      });
    }
    return runRecordOperation(record, deadlineAt, signal, async () => {
      await closeRecord(record);
      return { tabId, closed: true };
    });
  };

  const reapInactiveRuns = async (isRunActive: (identity: BrowserRuntimeIdentity) => Promise<boolean>) => {
    const identities = new Map<string, BrowserRuntimeIdentity>();
    for (const record of records.values()) identities.set(record.ownerKey, record.identity);
    for (const [key, state] of runStates) identities.set(key, state.identity);
    await Promise.all(Array.from(identities.entries()).map(async ([key, identity]) => {
      try {
        const active = await isRunActive(identity);
        runStatusFailures.delete(key);
        if (!active) await closeRun(identity);
      } catch {
        const failures = (runStatusFailures.get(key) ?? 0) + 1;
        runStatusFailures.set(key, failures);
        if (failures >= maxRunStatusFailures) await closeRun(identity);
      }
    }));
  };

  return { execute, closeRun, closeAll, reapInactiveRuns };
}
