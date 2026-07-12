import { randomUUID } from "node:crypto";
import { isAllowedBrowserNavigationUrl } from "./browser-profile.js";

export const BROWSER_AGENT_ACTIONS = [
  "tabs",
  "open",
  "navigate",
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
};

export type BrowserAgentTab = {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  isDestroyed(): boolean;
  stop(): void;
  close(): void;
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

function safeWebUrl(url: string, controlPlaneOrigins: string[]): string {
  if (!isAllowedBrowserNavigationUrl(url, controlPlaneOrigins)) {
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

export function createBrowserAgentTabController(options: {
  createTab: BrowserAgentTabFactory;
  getControlPlaneOrigins(): string[];
  createId?: () => string;
  createSnapshotId?: () => string;
  now?: () => Date;
  clock?: () => number;
  maxTabsPerRun?: number;
  maxTabsTotal?: number;
  commandTimeoutMs?: number;
  maxScreenshotBytes?: number;
  maxRunStatusFailures?: number;
}) {
  const records = new Map<string, BrowserTabRecord>();
  const pendingOpensByOwner = new Map<string, number>();
  const ownerGenerations = new Map<string, number>();
  let pendingOpensTotal = 0;
  let globalGeneration = 0;
  const createId = options.createId ?? randomUUID;
  const createSnapshotId = options.createSnapshotId ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const clock = options.clock ?? Date.now;
  const maxTabsPerRun = options.maxTabsPerRun ?? 8;
  const maxTabsTotal = options.maxTabsTotal ?? 32;
  const commandTimeoutMs = options.commandTimeoutMs ?? 12_000;
  const maxScreenshotBytes = options.maxScreenshotBytes ?? 10_000_000;
  const maxRunStatusFailures = options.maxRunStatusFailures ?? 3;
  const runStatusFailures = new Map<string, number>();

  const cleanupOwnerState = (key: string) => {
    const hasRecord = Array.from(records.values()).some((record) => record.ownerKey === key);
    if (hasRecord || (pendingOpensByOwner.get(key) ?? 0) > 0) return;
    ownerGenerations.delete(key);
    runStatusFailures.delete(key);
  };

  const closeRecord = (record: BrowserTabRecord) => {
    records.delete(record.tabId);
    record.refs.clear();
    try {
      if (!record.tab.isDestroyed()) record.tab.close();
    } finally {
      cleanupOwnerState(record.ownerKey);
    }
  };

  const withDeadline = async <T>(
    record: BrowserTabRecord,
    deadlineAt: number,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const remainingMs = deadlineAt - clock();
    if (remainingMs <= 0) {
      throw new BrowserAgentError("browser_timeout", "Browser action expired before execution.");
    }
    let timeout: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            try {
              record.tab.stop();
            } catch {
              // The tab is closed below even when Chromium cannot stop a pending load.
            }
            try {
              closeRecord(record);
            } catch {
              // Rejecting the command remains mandatory even if native cleanup fails.
            }
            reject(new BrowserAgentError("browser_timeout", "Browser action timed out and the tab was closed."));
          }, remainingMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  const runRecordOperation = <T>(
    record: BrowserTabRecord,
    deadlineAt: number,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const result = record.operationQueue.then(() => {
      if (records.get(record.tabId) !== record || record.tab.isDestroyed()) {
        throw new BrowserAgentError("browser_tab_not_found", "Browser tab was not found.");
      }
      return withDeadline(record, deadlineAt, operation);
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
      throw new BrowserAgentError("browser_tab_not_found", "Browser tab was not found.");
    }
    return record;
  };

  const openTab = async (
    identity: BrowserRuntimeIdentity,
    rawUrl: unknown,
    deadlineAt = clock() + commandTimeoutMs,
  ) => {
    const url = safeWebUrl(requiredString(rawUrl, "URL"), options.getControlPlaneOrigins());
    const key = ownerKey(identity);
    const expectedGlobalGeneration = globalGeneration;
    const expectedOwnerGeneration = ownerGenerations.get(key) ?? 0;
    const ownedCount = Array.from(records.values()).filter((record) => record.ownerKey === key).length;
    const pendingOwned = pendingOpensByOwner.get(key) ?? 0;
    if (ownedCount + pendingOwned >= maxTabsPerRun || records.size + pendingOpensTotal >= maxTabsTotal) {
      throw new BrowserAgentError("browser_tab_limit", "Rudder Browser tab limit reached for this run.");
    }
    pendingOpensByOwner.set(key, pendingOwned + 1);
    pendingOpensTotal += 1;
    const tabId = createId();
    try {
      const tab = await options.createTab({
        tabId,
        identity,
      });
      if (globalGeneration !== expectedGlobalGeneration
        || (ownerGenerations.get(key) ?? 0) !== expectedOwnerGeneration) {
        if (!tab.isDestroyed()) tab.close();
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
      };
      records.set(tabId, record);
      tab.onDestroyed(() => records.delete(tabId));
      try {
        await withDeadline(record, deadlineAt, () => tab.loadURL(url));
      } catch (error) {
        closeRecord(record);
        if (error instanceof BrowserAgentError) throw error;
        throw new BrowserAgentError("browser_navigation_failed", "Browser navigation failed.");
      }
      return tabSummary(record);
    } finally {
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
    runStatusFailures.delete(key);
    let firstError: unknown = null;
    for (const record of Array.from(records.values())) {
      if (record.ownerKey !== key) continue;
      try {
        closeRecord(record);
      } catch (error) {
        firstError ??= error;
      }
    }
    cleanupOwnerState(key);
    if (firstError) throw firstError;
  };

  const closeAll = async () => {
    globalGeneration += 1;
    runStatusFailures.clear();
    let firstError: unknown = null;
    for (const record of Array.from(records.values())) {
      try {
        closeRecord(record);
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

    if (action === "tabs") {
      return {
        tabs: Array.from(records.values())
          .filter((record) => record.ownerKey === ownerKey(identity) && !record.tab.isDestroyed())
          .map(tabSummary),
      };
    }
    if (action === "open") return openTab(identity, args.url, deadlineAt);

    const tabId = requiredString(args.tabId, "tab ID", 160);
    const record = ownedRecord(tabId, identity);
    if (action === "navigate") {
      return runRecordOperation(record, deadlineAt, async () => {
        const url = safeWebUrl(requiredString(args.url, "URL"), options.getControlPlaneOrigins());
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
    if (action === "read") {
      return runRecordOperation(record, deadlineAt, async () => {
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
      return runRecordOperation(record, deadlineAt, async () => {
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
      return runRecordOperation(record, deadlineAt, async () => {
        const png = await record.tab.capturePng();
        if (png.length > maxScreenshotBytes) {
          throw new BrowserAgentError("browser_result_too_large", "Browser screenshot exceeded the response limit.");
        }
        return {
          tabId,
          url: record.tab.getURL().slice(0, 8_192),
          mimeType: "image/png",
          base64: png.toString("base64"),
        };
      });
    }
    return runRecordOperation(record, deadlineAt, async () => {
      closeRecord(record);
      return { tabId, closed: true };
    });
  };

  const reapInactiveRuns = async (isRunActive: (identity: BrowserRuntimeIdentity) => Promise<boolean>) => {
    const identities = new Map<string, BrowserRuntimeIdentity>();
    for (const record of records.values()) identities.set(record.ownerKey, record.identity);
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
