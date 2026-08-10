import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cancelAgentBrowserDownload } from "./browser-agent-downloads.js";
import { isAllowedBrowserNavigationUrl } from "./browser-profile.js";

type DebuggerMessageListener = (
  event: unknown,
  method: string,
  params: Record<string, unknown>,
) => void;

type BrowserDebugger = {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  detach(): void;
  sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<any>;
  on(event: "message", listener: DebuggerMessageListener): unknown;
  removeListener(event: "message", listener: DebuggerMessageListener): unknown;
};

type BrowserSessionFetch = (
  input: string,
  init?: { method?: string; redirect?: "follow"; signal?: AbortSignal },
) => Promise<Response>;

type BrowserAdvancedContents = {
  debugger: BrowserDebugger;
  session: {
    fetch: BrowserSessionFetch;
    cookies: {
      set(details: {
        url: string;
        name: string;
        value: string;
        path?: string;
        secure?: boolean;
        sameSite?: "lax";
        expirationDate?: number;
      }): Promise<void>;
    };
  };
  getURL(): string;
  getTitle(): string;
  isDestroyed(): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  removeAllListeners(event: string): unknown;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  executeJavaScriptInIsolatedWorld(
    worldId: number,
    scripts: Array<{ code: string; url?: string }>,
    userGesture?: boolean,
  ): Promise<unknown>;
};

type BrowserNativeImage = { toPNG(): Buffer };

type BrowserAdvancedWindow = {
  webContents: BrowserAdvancedContents;
  getContentSize(): number[];
  capturePage(rect?: { x: number; y: number; width: number; height: number }): Promise<BrowserNativeImage>;
};

type BrowserDialogState = {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultPrompt?: string;
  openedAt: string;
};

type BrowserLogEntry = {
  level: "debug" | "info" | "log" | "warn" | "error";
  message: string;
  timestamp: string;
  url?: string;
};

type PageAsset = {
  id: string;
  kind: "script" | "font" | "image" | "stylesheet" | "video" | "other";
  name: string;
  sources: Array<{ kind: "attribute" | "computedStyle" | "resource"; property?: string }>;
  url: string;
};

type AssetInventory = {
  id: string;
  pageUrl: string | null;
  navigationSequence: number;
  assets: PageAsset[];
  inlineSvgs: Array<{
    id: string;
    type: "image/svg+xml";
    origin: "inline";
    width: number | null;
    height: number | null;
  }>;
};

export type BrowserAdvancedAction =
  | "snapshot"
  | "locator"
  | "cua"
  | "dom_cua"
  | "dialog"
  | "clipboard"
  | "logs"
  | "download"
  | "assets"
  | "content"
  | "wait"
  | "screenshot";

export type BrowserAdvancedDriver = {
  execute(action: BrowserAdvancedAction, args: Record<string, unknown>): Promise<unknown>;
  dispose(): Promise<void>;
};

const ADVANCED_WORLD_ID = 10_002;
const MAX_RESULT_BYTES = 2_000_000;
const MAX_ASSET_BYTES = 25_000_000;
const MAX_ASSET_BUNDLE_BYTES = 100_000_000;
const MAX_CONTENT_EXPORT_BYTES = 25_000_000;
const MAX_LOG_ENTRIES = 500;
const CDP_SCREENSHOT_TIMEOUT_MS = 5_000;
const NATIVE_SCREENSHOT_TIMEOUT_MS = 5_000;

type VirtualClipboardItem = {
  entries: Array<{ mimeType: string; text?: string; base64?: string }>;
  presentationStyle?: "unspecified" | "inline" | "attachment";
};

function normalizeVirtualClipboardItems(value: unknown): VirtualClipboardItem[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error("Browser clipboard items are invalid.");
  const items = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Browser clipboard item is invalid.");
    const raw = item as Record<string, unknown>;
    if (!Array.isArray(raw.entries) || raw.entries.length > 20) throw new Error("Browser clipboard item is invalid.");
    const entries = raw.entries.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Browser clipboard entry is invalid.");
      const candidate = entry as Record<string, unknown>;
      const mimeType = typeof candidate.mimeType === "string" ? candidate.mimeType.slice(0, 200) : "";
      const text = typeof candidate.text === "string" ? candidate.text.slice(0, 500_000) : undefined;
      const base64 = typeof candidate.base64 === "string" ? candidate.base64.slice(0, 650_000) : undefined;
      if (!mimeType || (text === undefined) === (base64 === undefined)) throw new Error("Browser clipboard entry is invalid.");
      if (base64 !== undefined) {
        const bytes = Buffer.from(base64, "base64");
        if (bytes.length > 1_000_000 || bytes.toString("base64").replace(/=+$/u, "") !== base64.replace(/=+$/u, "")) {
          throw new Error("Browser clipboard binary payload is invalid.");
        }
      }
      return { mimeType, ...(text !== undefined ? { text } : { base64 }) };
    });
    const presentationStyle = raw.presentationStyle;
    if (presentationStyle !== undefined && !["unspecified", "inline", "attachment"].includes(String(presentationStyle))) {
      throw new Error("Browser clipboard presentation style is invalid.");
    }
    return {
      entries,
      ...(presentationStyle !== undefined
        ? { presentationStyle: presentationStyle as VirtualClipboardItem["presentationStyle"] }
        : {}),
    };
  });
  if (Buffer.byteLength(JSON.stringify(items), "utf8") > 750_000) throw new Error("Browser clipboard exceeded the session limit.");
  return items;
}

function encodedPayload(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function boundedResult<T>(value: T, maxBytes = MAX_RESULT_BYTES): T {
  const size = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (size > maxBytes) throw new Error("Browser result exceeded the response limit.");
  return value;
}

async function readBoundedResponseBytes(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        await reader.cancel("Browser asset exceeded the download limit.").catch(() => undefined);
        throw new Error("Browser asset exceeded the download limit.");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

function safeFileName(value: string, fallback: string): string {
  const file = path.basename(value).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180);
  return file && file !== "." && file !== ".." ? file : fallback;
}

function assetKind(url: string, tag = "", rel = ""): PageAsset["kind"] {
  const normalized = `${url} ${tag} ${rel}`.toLowerCase();
  if (/\.(?:png|jpe?g|gif|webp|avif|ico|svg)(?:[?#]|$)/.test(normalized) || tag === "img" || tag === "picture") return "image";
  if (/\.(?:woff2?|ttf|otf)(?:[?#]|$)/.test(normalized) || normalized.includes("font")) return "font";
  if (/\.css(?:[?#]|$)/.test(normalized) || rel.includes("stylesheet")) return "stylesheet";
  if (/\.(?:mp4|webm|mov|m3u8)(?:[?#]|$)/.test(normalized) || tag === "video" || tag === "source") return "video";
  if (/\.js(?:[?#]|$)/.test(normalized) || tag === "script") return "script";
  return "other";
}

function googleWorkspaceExport(rawUrl: string, format: string): { url: string; filename: string } {
  const current = new URL(rawUrl);
  if (current.hostname !== "docs.google.com") throw new Error("Browser document format requires a Google Workspace tab.");
  const match = /^\/(document|spreadsheets|presentation)\/d\/([^/]+)/u.exec(current.pathname);
  if (!match) throw new Error("Browser could not identify the Google Workspace document.");
  const [, kind, id] = match;
  if (kind === "document" && ["md", "docx", "pdf"].includes(format)) {
    const exportFormat = format === "md" ? "markdown" : format;
    return {
      url: `https://docs.google.com/document/d/${encodeURIComponent(id!)}/export?format=${exportFormat}`,
      filename: `document.${format}`,
    };
  }
  if (kind === "spreadsheets" && ["xlsx", "csv", "pdf"].includes(format)) {
    return {
      url: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id!)}/export?format=${format}`,
      filename: `spreadsheet.${format}`,
    };
  }
  if (kind === "presentation" && ["pptx", "pdf"].includes(format)) {
    return {
      url: `https://docs.google.com/presentation/d/${encodeURIComponent(id!)}/export/${format}`,
      filename: `presentation.${format}`,
    };
  }
  throw new Error("Browser export format is unsupported for this Google Workspace document.");
}

function domScript(
  action: "snapshot" | "locator" | "dom_cua" | "assets" | "wait" | "element_info" | "clipboard_copy" | "clipboard_paste",
  args: Record<string, unknown>,
): string {
  const payload = encodedPayload({ action, args });
  return `(() => {
    "RUDDER_BROWSER_ADVANCED_DOM_V1";
    const binary = atob("${payload}");
    const input = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0))));
    const normalize = (value) => String(value ?? "").trim().replace(/\\s+/g, " ");
    const isCredentialControl = (element) => element instanceof HTMLInputElement
      && ["password", "hidden"].includes(String(element.type || "").toLowerCase());
    const exactMatch = (actual, expected, exact) => exact ? normalize(actual) === normalize(expected) : normalize(actual).toLowerCase().includes(normalize(expected).toLowerCase());
    const visible = (element) => {
      if (!(element instanceof Element) || !element.isConnected) return false;
      let current = element;
      while (current) {
        const style = getComputedStyle(current);
        if (current.hidden || current.hasAttribute("inert") || current.getAttribute("aria-hidden") === "true" || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        current = current.parentElement;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const boundedText = (element, maxChars = 500, maxNodes = 100) => {
      if (!(element instanceof Element) || maxChars <= 0 || maxNodes <= 0) return "";
      const parts = [];
      let chars = 0;
      let inspected = 0;
      const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && inspected < maxNodes && chars < maxChars) {
        inspected += 1;
        const parent = node.parentElement;
        if (parent && !parent.closest("script,style,noscript,template")) {
          const value = String(node.nodeValue || "").slice(0, maxChars - chars);
          if (value) {
            parts.push(value);
            chars += value.length;
          }
        }
        if (chars >= maxChars) break;
        node = walker.nextNode();
      }
      return parts.join(" ").slice(0, maxChars);
    };
    const accessibleName = (element) => {
      const labelledBy = element.getAttribute("aria-labelledby");
      if (labelledBy) {
        let value = "";
        for (const id of labelledBy.slice(0, 2000).split(/\\s+/).slice(0, 20)) {
          const label = element.ownerDocument.getElementById(id);
          if (label) value += (value ? " " : "") + boundedText(label, 500 - value.length, 100);
          if (value.length >= 500) break;
        }
        if (normalize(value)) return normalize(value);
      }
      const direct = element.getAttribute("aria-label") || element.getAttribute("alt") || element.getAttribute("title") || element.getAttribute("placeholder");
      if (direct) return normalize(direct.slice(0, 500));
      if (element.id) {
        const label = element.ownerDocument.querySelector('label[for="' + CSS.escape(element.id) + '"]');
        if (label) return normalize(boundedText(label));
      }
      const wrappingLabel = element.closest("label");
      return normalize(boundedText(wrappingLabel || element));
    };
    const implicitRole = (element) => {
      const explicit = element.getAttribute("role");
      if (explicit) return explicit.split(/\\s+/)[0];
      const tag = element.tagName.toLowerCase();
      if (tag === "a" && element.hasAttribute("href")) return "link";
      if (/^h[1-6]$/.test(tag)) return "heading";
      if (tag === "button") return "button";
      if (tag === "summary") return "button";
      if (tag === "textarea") return "textbox";
      if (tag === "select") return element.multiple ? "listbox" : "combobox";
      if (tag === "option") return "option";
      if (tag === "img") return "img";
      if (tag === "nav") return "navigation";
      if (tag === "main") return "main";
      if (tag === "aside") return "complementary";
      if (tag === "form" && accessibleName(element)) return "form";
      if (tag === "section" && accessibleName(element)) return "region";
      if (tag === "table") return "table";
      if (tag === "tr") return "row";
      if (tag === "th") return element.getAttribute("scope") === "row" ? "rowheader" : "columnheader";
      if (tag === "td") return "cell";
      if (tag === "ul" || tag === "ol") return "list";
      if (tag === "li") return "listitem";
      if (tag === "progress") return "progressbar";
      if (tag === "input") {
        const type = String(element.type || "text").toLowerCase();
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (["button", "submit", "reset", "image"].includes(type)) return "button";
        if (type === "range") return "slider";
        if (type === "number") return "spinbutton";
        if (type === "search") return "searchbox";
        if (type !== "hidden") return "textbox";
      }
      return "generic";
    };
    const frameDocument = (selectors = []) => {
      let current = document;
      for (const selector of selectors) {
        const frame = current.querySelector(selector);
        if (!(frame instanceof Element) || frame.tagName.toLowerCase() !== "iframe" || !frame.contentDocument) throw new Error("Browser frame is missing or cross-origin.");
        current = frame.contentDocument;
      }
      return current;
    };
    const querySimple = (root, spec) => {
      const strategy = String(spec?.strategy || "css");
      const value = String(spec?.value || "");
      const exact = spec?.exact === true;
      let candidates = [];
      if (strategy === "css") candidates = Array.from(root.querySelectorAll(value));
      else if (strategy === "testId") candidates = Array.from(root.querySelectorAll('[data-testid="' + CSS.escape(value) + '"]'));
      else if (strategy === "placeholder") candidates = Array.from(root.querySelectorAll("[placeholder]")).filter((element) => exactMatch(element.getAttribute("placeholder"), value, exact));
      else if (strategy === "label") {
        const labels = Array.from(root.querySelectorAll("label")).filter((label) => exactMatch(label.textContent, value, exact));
        candidates = labels.map((label) => label.control || (label.htmlFor ? root.getElementById?.(label.htmlFor) : null) || label.querySelector("input,textarea,select,button")).filter(Boolean);
      } else if (strategy === "role") {
        candidates = Array.from(root.querySelectorAll("*")).filter((element) => implicitRole(element) === value && (!spec.name || exactMatch(accessibleName(element), spec.name, exact)));
      } else if (strategy === "text") {
        const matches = Array.from(root.querySelectorAll("*")).filter((element) => exactMatch(element.textContent, value, exact));
        candidates = matches.filter((element) => {
          const semantic = implicitRole(element) !== "generic";
          let ancestor = element.parentElement;
          while (ancestor && ancestor !== root) {
            if (implicitRole(ancestor) !== "generic" && exactMatch(ancestor.textContent, value, exact)) return false;
            ancestor = ancestor.parentElement;
          }
          if (semantic) return true;
          return !Array.from(element.children).some((child) => exactMatch(child.textContent, value, exact));
        });
      }
      else if (strategy === "href") candidates = Array.from(root.querySelectorAll("[href]")).filter((element) => exactMatch(element.getAttribute("href"), value, exact));
      else throw new Error("Browser locator strategy is unsupported.");
      const filter = spec?.filter || {};
      if (typeof filter.hasText === "string") candidates = candidates.filter((element) => normalize(element.textContent).toLowerCase().includes(normalize(filter.hasText).toLowerCase()));
      if (typeof filter.hasNotText === "string") candidates = candidates.filter((element) => !normalize(element.textContent).toLowerCase().includes(normalize(filter.hasNotText).toLowerCase()));
      if (typeof filter.visible === "boolean") candidates = candidates.filter((element) => visible(element) === filter.visible);
      if (filter.has) candidates = candidates.filter((element) => querySimple(element, filter.has).length > 0);
      if (filter.hasNot) candidates = candidates.filter((element) => querySimple(element, filter.hasNot).length === 0);
      if (spec?.and) {
        const allowed = new Set(querySimple(root, spec.and));
        candidates = candidates.filter((element) => allowed.has(element));
      }
      if (spec?.or) candidates = Array.from(new Set(candidates.concat(querySimple(root, spec.or))));
      if (Number.isInteger(spec?.index)) candidates = candidates[spec.index] ? [candidates[spec.index]] : [];
      else if (spec?.position === "first") candidates = candidates.length > 0 ? [candidates[0]] : [];
      else if (spec?.position === "last") candidates = candidates.length > 0 ? [candidates[candidates.length - 1]] : [];
      return candidates.slice(0, 500);
    };
    const resolve = (spec) => {
      const doc = frameDocument(Array.isArray(spec?.frame) ? spec.frame : []);
      let root = doc;
      if (spec?.scope) {
        const scopes = querySimple(doc, spec.scope);
        if (scopes.length !== 1) throw new Error("Browser locator scope must resolve to exactly one element.");
        root = scopes[0];
      }
      return querySimple(root, spec);
    };
    const strict = (spec) => {
      const matches = resolve(spec);
      if (matches.length !== 1) throw new Error("Browser locator must resolve to exactly one element; matched " + matches.length + ".");
      return matches[0];
    };
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      const hasFrameOffset = Number.isFinite(Number(input.args.__frameOffsetX)) && Number.isFinite(Number(input.args.__frameOffsetY));
      let x = rect.x + (hasFrameOffset ? Number(input.args.__frameOffsetX) : 0);
      let y = rect.y + (hasFrameOffset ? Number(input.args.__frameOffsetY) : 0);
      if (!hasFrameOffset) {
        let currentWindow = element.ownerDocument.defaultView;
        while (currentWindow?.frameElement) {
          const frameRect = currentWindow.frameElement.getBoundingClientRect();
          x += frameRect.x;
          y += frameRect.y;
          currentWindow = currentWindow.parent;
        }
      }
      return { x, y, width: rect.width, height: rect.height };
    };
    const interactionNode = (element) => implicitRole(element) !== "generic"
      || element.matches("input,textarea,select,button,a[href],[contenteditable=true],[tabindex]");
    const snapshot = (options = {}) => {
      const snapshotGeneration = Number(globalThis.__RUDDER_BROWSER_ADVANCED_SNAPSHOT_GENERATION_V1__ || 0) + 1;
      globalThis.__RUDDER_BROWSER_ADVANCED_SNAPSHOT_GENERATION_V1__ = snapshotGeneration;
      const maxDepth = Math.max(1, Math.min(Number(options.depth || 12), 30));
      const maxNodes = Math.max(1, Math.min(Number(options.maxNodes || 1500), 3000));
      let count = 0;
      let truncated = false;
      const visit = (element, depth, framePath) => {
        if (!(element instanceof Element) || count >= maxNodes) { truncated = true; return null; }
        count += 1;
        const role = implicitRole(element);
        const interactive = interactionNode(element);
        const nodeId = interactive ? "snapshot-" + snapshotGeneration + "-node-" + count : undefined;
        const attributes = {};
        for (const name of ["id", "name", "type", "href", "placeholder", "data-testid", "aria-label", "aria-checked", "aria-selected", "aria-expanded"]) {
          const value = element.getAttribute(name);
          if (value !== null) attributes[name] = String(value).slice(0, 500);
        }
        const node = {
          ...(nodeId ? { nodeId } : {}),
          tag: element.tagName.toLowerCase(),
          role,
          name: isCredentialControl(element) ? "" : accessibleName(element).slice(0, 500),
          text: element.childElementCount === 0 ? normalize(boundedText(element, 1000, 100)) : "",
          visible: visible(element),
          attributes,
          ...(options.boxes === true ? { box: box(element) } : {}),
          framePath,
          children: [],
        };
        if (depth < maxDepth && count < maxNodes) {
          const children = element.children;
          let childIndex = 0;
          for (; childIndex < children.length && count < maxNodes; childIndex += 1) {
            const child = children.item(childIndex);
            if (!(child instanceof Element)) continue;
            const childNode = visit(child, depth + 1, framePath);
            if (childNode) node.children.push(childNode);
            if (child.tagName.toLowerCase() === "iframe") {
              try {
                const frameRoot = child.contentDocument?.documentElement;
                if (frameRoot) {
                  const frameNode = visit(frameRoot, depth + 1, framePath.concat(child.getAttribute("name") || child.id || "iframe"));
                  if (frameNode) node.children.push(frameNode);
                } else {
                  node.children.push({ tag: "iframe-boundary", role: "document", name: "Cross-origin frame", text: "", visible: true, attributes: {}, framePath, children: [] });
                }
              } catch {
                node.children.push({ tag: "iframe-boundary", role: "document", name: "Cross-origin frame", text: "", visible: true, attributes: {}, framePath, children: [] });
              }
            }
          }
          if (childIndex < children.length) truncated = true;
        } else if (depth < maxDepth && element.childElementCount > 0) {
          truncated = true;
        }
        return node;
      };
      const root = document.documentElement ? visit(document.documentElement, 0, []) : null;
      return { url: String(location.href).slice(0, 8192), title: String(document.title || "").slice(0, 500), root, nodeCount: count, truncated };
    };
    const locatorAction = async (args) => {
      const operation = String(args.action || "count");
      const matches = resolve(args.locator || {});
      if (operation === "count") return { count: matches.length };
      if (operation === "allTextContents") return { values: matches.slice(0, 200).map((element) => String(element.textContent || "").slice(0, 5000)) };
      if (operation === "wait") {
        const timeoutMs = Math.max(0, Math.min(Number(args.timeoutMs || 10000), 30000));
        const state = String(args.state || "visible");
        const started = Date.now();
        while (Date.now() - started <= timeoutMs) {
          const current = resolve(args.locator || {});
          const satisfied = state === "attached" ? current.length > 0 : state === "detached" ? current.length === 0 : state === "visible" ? current.some(visible) : current.length === 0 || current.every((element) => !visible(element));
          if (satisfied) return { state, satisfied: true };
          await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        }
        throw new Error("Browser locator wait timed out.");
      }
      const element = strict(args.locator || {});
      if (operation === "textContent") return { value: element.textContent === null ? null : String(element.textContent).slice(0, 50000) };
      if (operation === "innerText") return { value: String(element.innerText || "").slice(0, 50000) };
      if (operation === "attribute") {
        const name = String(args.name || "").toLowerCase();
        const readable = new Set(["id", "name", "type", "href", "placeholder", "data-testid", "aria-label", "aria-checked", "aria-selected", "aria-expanded"]);
        if (!readable.has(name)) return { value: null, redacted: true };
        return { value: element.getAttribute(name) };
      }
      if (operation === "visible") return { value: visible(element) };
      if (operation === "enabled") return { value: !("disabled" in element && element.disabled) && element.getAttribute("aria-disabled") !== "true" };
      if (operation === "checked") return { value: Boolean(element.checked ?? element.getAttribute("aria-checked") === "true") };
      if (operation === "selected") return { value: element.tagName.toLowerCase() === "select" ? Array.from(element.selectedOptions).map((option) => option.value) : Boolean(element.selected ?? element.getAttribute("aria-selected") === "true") };
      if (operation === "box") return { value: box(element) };
      if (operation === "mediaUrl") {
        const raw = element.currentSrc || element.src || element.href || element.getAttribute("src") || element.getAttribute("href");
        if (!raw) throw new Error("Browser locator has no downloadable media URL.");
        return { url: new URL(raw, location.href).href, suggestedName: element.getAttribute("download") || "" };
      }
      throw new Error("Browser locator action is unsupported.");
    };
    const domCua = async (args) => {
      if (args.action === "get") return snapshot({ boxes: true, depth: args.depth, maxNodes: args.maxNodes });
      throw new Error("Browser DOM CUA is read-only; use a high-level ref or explicit coordinate action to interact.");
    };
    const listAssets = () => {
      const entries = new Map();
      const add = (rawUrl, tag, rel, source) => {
        if (!rawUrl) return;
        let url;
        try { url = new URL(rawUrl, location.href).href; } catch { return; }
        if (!/^https?:/.test(url)) return;
        const existing = entries.get(url) || { url, tag, rel, sources: [] };
        existing.sources.push(source);
        entries.set(url, existing);
      };
      for (const element of Array.from(document.querySelectorAll("img[src],source[src],video[src],link[href],script[src]"))) {
        add(element.currentSrc || element.getAttribute("src") || element.getAttribute("href"), element.tagName.toLowerCase(), element.getAttribute("rel") || "", { kind: "attribute", property: element.hasAttribute("href") ? "href" : "src" });
      }
      for (const entry of performance.getEntriesByType("resource").slice(0, 1000)) add(entry.name, "", "", { kind: "resource" });
      const inlineSvgs = [];
      const svgElements = document.querySelectorAll("svg");
      for (let index = 0; index < svgElements.length && index < 100; index += 1) {
        const svg = svgElements[index];
        const rect = svg.getBoundingClientRect();
        const dimension = (name, fallback) => {
          const value = Number.parseFloat(String(svg.getAttribute(name) || ""));
          const bounded = Number.isFinite(value) ? value : fallback;
          return Number.isFinite(bounded) && bounded >= 0 && bounded <= 1_000_000 ? bounded : null;
        };
        inlineSvgs.push({
          id: "inline-svg-" + (index + 1),
          type: "image/svg+xml",
          origin: "inline",
          width: dimension("width", rect.width),
          height: dimension("height", rect.height),
        });
      }
      return { entries: Array.from(entries.values()).slice(0, 1500), inlineSvgs };
    };
    const wait = async (args) => {
      const timeoutMs = Math.max(0, Math.min(Number(args.timeoutMs || 10000), 30000));
      if (Number(args.timeMs) > 0) {
        await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(Number(args.timeMs), timeoutMs)));
        return { satisfied: true, kind: "time" };
      }
      const started = Date.now();
      while (Date.now() - started <= timeoutMs) {
        const bodyText = normalize(document.body?.innerText || "");
        if (args.urlRegex === true) throw new Error("Browser URL regular expressions are unsupported; use a URL substring.");
        const urlMatches = !args.url || location.href.includes(String(args.url));
        const textMatches = !args.text || bodyText.toLowerCase().includes(normalize(args.text).toLowerCase());
        const goneMatches = !args.textGone || !bodyText.toLowerCase().includes(normalize(args.textGone).toLowerCase());
        if (urlMatches && textMatches && goneMatches) return { satisfied: true, url: location.href };
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      throw new Error("Browser wait timed out.");
    };
    const elementInfo = (args) => {
      const x = Number(args.x);
      const y = Number(args.y);
      return {
        x,
        y,
        elements: document.elementsFromPoint(x, y).slice(0, 20).map((element) => ({
          tag: element.tagName.toLowerCase(),
          role: implicitRole(element),
          name: isCredentialControl(element) ? "" : accessibleName(element).slice(0, 500),
          text: normalize(boundedText(element, 1_000, 100)),
          box: box(element),
          attributes: Object.fromEntries(Array.from(element.attributes)
            .filter((attribute) => ["id", "name", "type", "href", "placeholder", "data-testid", "aria-label", "aria-checked", "aria-selected", "aria-expanded"].includes(attribute.name))
            .slice(0, 20)
            .map((attribute) => [attribute.name.slice(0, 200), attribute.value.slice(0, 500)])),
        })),
      };
    };
    const clipboardCopy = (args) => {
      const target = document.activeElement;
      let text = "";
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        if (isCredentialControl(target)) throw new Error("Browser credential controls cannot be copied to the virtual clipboard.");
        const start = target.selectionStart ?? 0;
        const end = target.selectionEnd ?? start;
        text = target.value.slice(start, end);
        if (args.cut === true) {
          target.setRangeText("", start, end, "end");
          target.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "deleteByCut" }));
        }
      } else {
        text = globalThis.getSelection?.()?.toString() || "";
        if (args.cut === true) globalThis.getSelection?.()?.deleteFromDocument();
      }
      return { text: String(text).slice(0, 500000) };
    };
    const clipboardPaste = (args) => {
      const target = document.activeElement;
      const text = String(args.text || "").slice(0, 500000);
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        if (isCredentialControl(target)) throw new Error("Browser virtual clipboard cannot paste into credential controls.");
        const start = target.selectionStart ?? target.value.length;
        const end = target.selectionEnd ?? start;
        target.setRangeText(text, start, end, "end");
        target.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertFromPaste", data: text }));
        return { performed: true };
      }
      if (!target?.isContentEditable) throw new Error("Browser clipboard paste target is not editable.");
      const selection = globalThis.getSelection?.();
      if (!selection?.rangeCount) throw new Error("Browser clipboard paste selection is unavailable.");
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      target.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertFromPaste", data: text }));
      return { performed: true };
    };
    if (input.action === "snapshot") return snapshot(input.args);
    if (input.action === "locator") return locatorAction(input.args);
    if (input.action === "dom_cua") return domCua(input.args);
    if (input.action === "assets") return listAssets();
    if (input.action === "wait") return wait(input.args);
    if (input.action === "element_info") return elementInfo(input.args);
    if (input.action === "clipboard_copy") return clipboardCopy(input.args);
    if (input.action === "clipboard_paste") return clipboardPaste(input.args);
    throw new Error("Browser DOM operation is unsupported.");
  })()`;
}

function modifierMask(keys: string[]): number {
  let value = 0;
  for (const key of keys) {
    if (key === "Alt") value |= 1;
    if (key === "Control" || (key === "ControlOrMeta" && process.platform !== "darwin")) value |= 2;
    if (key === "Meta" || (key === "ControlOrMeta" && process.platform === "darwin")) value |= 4;
    if (key === "Shift") value |= 8;
  }
  return value;
}

function cdpKey(key: string): { key: string; code?: string; windowsVirtualKeyCode?: number } {
  const aliases: Record<string, { code: string; windowsVirtualKeyCode: number }> = {
    Enter: { code: "Enter", windowsVirtualKeyCode: 13 },
    Tab: { code: "Tab", windowsVirtualKeyCode: 9 },
    Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
    Backspace: { code: "Backspace", windowsVirtualKeyCode: 8 },
    Delete: { code: "Delete", windowsVirtualKeyCode: 46 },
    ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37 },
    ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38 },
    ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39 },
    ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40 },
    Home: { code: "Home", windowsVirtualKeyCode: 36 },
    End: { code: "End", windowsVirtualKeyCode: 35 },
    PageUp: { code: "PageUp", windowsVirtualKeyCode: 33 },
    PageDown: { code: "PageDown", windowsVirtualKeyCode: 34 },
  };
  return { key, ...(aliases[key] ?? {}) };
}

export async function createBrowserAdvancedDriver(options: {
  window: BrowserAdvancedWindow;
  getRudderAppOrigins?: () => string[];
}): Promise<BrowserAdvancedDriver> {
  const contents = options.window.webContents;
  const debug = contents.debugger;
  const logs: BrowserLogEntry[] = [];
  const inventories = new Map<string, AssetInventory>();
  const artifactDirectories = new Set<string>();
  const activeFetches = new Set<AbortController>();
  const dialogOpenedWaiters = new Set<() => void>();
  const dialogClosedWaiters = new Set<(params: Record<string, unknown>) => void>();
  let dialog: BrowserDialogState | null = null;
  let electronDialogCallback: ((accepted: boolean, promptText: string) => void) | null = null;
  let observedMainFrameId: string | null = null;
  let navigationSequence = 0;
  let disposed = false;
  let virtualClipboardItems: VirtualClipboardItem[] = [];

  const onElectronDialog = (
    info: { dialogType?: unknown; messageText?: unknown; defaultPromptText?: unknown; frame?: { url?: unknown } },
    callback: (accepted: boolean, promptText: string) => void,
  ) => {
    if (electronDialogCallback) electronDialogCallback(false, "");
    const rawType = String(info.dialogType || "alert");
    const rawMessage = String(info.messageText || "");
    dialog = {
      type: rawType === "confirm" || rawType === "prompt" || rawType === "beforeunload" ? rawType : "alert",
      message: rawMessage.slice(0, 10_000),
      ...(typeof info.defaultPromptText === "string"
        ? { defaultPrompt: info.defaultPromptText.slice(0, 10_000) }
        : {}),
      openedAt: new Date().toISOString(),
    };
    electronDialogCallback = callback;
    for (const resolve of dialogOpenedWaiters) resolve();
    dialogOpenedWaiters.clear();
  };
  const onElectronDialogsCancelled = () => {
    electronDialogCallback = null;
    dialog = null;
  };

  // Electron handles dialogs before CDP and rejects prompt() by default. This
  // BrowserWindow is dedicated to the run, so Rudder owns its dialog callback.
  contents.removeAllListeners("-run-dialog");
  contents.on("-run-dialog", onElectronDialog);
  contents.on("-cancel-dialogs", onElectronDialogsCancelled);

  const onDebuggerMessage: DebuggerMessageListener = (_event, method, params) => {
    if (method === "Page.frameNavigated") {
      const frame = params.frame as Record<string, unknown> | undefined;
      if (frame && typeof frame.id === "string" && !frame.parentId) {
        observedMainFrameId = frame.id;
        navigationSequence += 1;
      }
    }
    if (method === "Page.navigatedWithinDocument"
      && typeof params.frameId === "string"
      && (!observedMainFrameId || params.frameId === observedMainFrameId)) {
      observedMainFrameId = params.frameId;
      navigationSequence += 1;
    }
    if (method === "Page.javascriptDialogOpening") {
      const rawType = String(params.type || "alert");
      dialog = {
        type: rawType === "confirm" || rawType === "prompt" || rawType === "beforeunload" ? rawType : "alert",
        message: String(params.message || "").slice(0, 10_000),
        ...(typeof params.defaultPrompt === "string" ? { defaultPrompt: params.defaultPrompt.slice(0, 10_000) } : {}),
        openedAt: new Date().toISOString(),
      };
      for (const resolve of dialogOpenedWaiters) resolve();
      dialogOpenedWaiters.clear();
    }
    if (method === "Page.javascriptDialogClosed") {
      if (!electronDialogCallback) dialog = null;
      for (const resolve of dialogClosedWaiters) resolve(params);
      dialogClosedWaiters.clear();
    }
    if (method === "Log.entryAdded") {
      const entry = params.entry as Record<string, unknown> | undefined;
      if (entry) pushLog(String(entry.level || "log"), String(entry.text || ""), String(entry.url || ""));
    }
    if (method === "Runtime.exceptionThrown") {
      const details = params.exceptionDetails as Record<string, unknown> | undefined;
      if (details) pushLog("error", String(details.text || "Uncaught exception"), contents.getURL());
    }
  };
  debug.on("message", onDebuggerMessage);

  const pushLog = (rawLevel: string, rawMessage: string, rawUrl?: string) => {
    const level: BrowserLogEntry["level"] = rawLevel === "debug"
      ? "debug"
      : rawLevel === "info"
        ? "info"
        : rawLevel === "warning" || rawLevel === "warn"
          ? "warn"
          : rawLevel === "error"
            ? "error"
            : "log";
    logs.push({
      level,
      message: rawMessage.slice(0, 20_000),
      timestamp: new Date().toISOString(),
      ...(rawUrl ? { url: rawUrl.slice(0, 8_192) } : {}),
    });
    if (logs.length > MAX_LOG_ENTRIES) logs.splice(0, logs.length - MAX_LOG_ENTRIES);
  };

  const onConsoleMessage = (_event: unknown, detailsOrLevel: unknown, legacyMessage?: unknown) => {
    if (typeof detailsOrLevel === "object" && detailsOrLevel !== null) {
      const details = detailsOrLevel as Record<string, unknown>;
      pushLog(String(details.level || "log"), String(details.message || ""), String(details.sourceId || contents.getURL()));
      return;
    }
    const legacyLevel = typeof detailsOrLevel === "number"
      ? (["debug", "info", "warn", "error"][detailsOrLevel] ?? "log")
      : String(detailsOrLevel || "log");
    pushLog(legacyLevel, String(legacyMessage || ""), contents.getURL());
  };
  contents.on("console-message", onConsoleMessage);

  if (!debug.isAttached()) debug.attach("1.3");
  await Promise.all([
    debug.sendCommand("Page.enable").catch(() => undefined),
    debug.sendCommand("Runtime.enable").catch(() => undefined),
    debug.sendCommand("Log.enable").catch(() => undefined),
    debug.sendCommand("Network.enable").catch(() => undefined),
  ]);

  const mainFrameId = async (): Promise<string> => {
    const frameTree = await debug.sendCommand("Page.getFrameTree");
    const frameId = frameTree?.frameTree?.frame?.id;
    if (typeof frameId !== "string" || !frameId) throw new Error("Browser main frame is unavailable.");
    observedMainFrameId ??= frameId;
    return frameId;
  };

  const isolatedWorld = async (frameId: string, purpose: string): Promise<number> => {
    const created = await debug.sendCommand("Page.createIsolatedWorld", {
      frameId,
      worldName: `rudder-browser-${purpose}-v1`,
      grantUniveralAccess: false,
    });
    if (typeof created?.executionContextId !== "number") {
      throw new Error("Browser frame execution context is unavailable.");
    }
    return created.executionContextId;
  };

  const frameSelectors = (locator: unknown): string[] => {
    if (!locator || typeof locator !== "object" || Array.isArray(locator)) return [];
    const frame = (locator as Record<string, unknown>).frame;
    return Array.isArray(frame) ? frame.map(String) : [];
  };

  const locatorWithoutFrame = (locator: unknown): unknown => {
    if (!locator || typeof locator !== "object" || Array.isArray(locator)) return locator;
    const { frame: _frame, ...rest } = locator as Record<string, unknown>;
    return rest;
  };

  const resolveFrameContext = async (selectors: string[]) => {
    let frameId = await mainFrameId();
    let offsetX = 0;
    let offsetY = 0;
    for (const selector of selectors) {
      const contextId = await isolatedWorld(frameId, "frame-resolution");
      const evaluated = await debug.sendCommand("Runtime.evaluate", {
        expression: `(() => { const matches = document.querySelectorAll(${JSON.stringify(selector)}); if (matches.length !== 1) throw new Error("Browser frame selector must resolve to exactly one iframe; matched " + matches.length + "."); const frame = matches[0]; if (!(frame instanceof HTMLIFrameElement)) throw new Error("Browser frame selector did not resolve to an iframe."); return frame; })()`,
        contextId,
        returnByValue: false,
        awaitPromise: true,
      });
      if (evaluated.exceptionDetails) {
        throw new Error(String(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text || "Browser frame could not be resolved.").slice(0, 500));
      }
      const objectId = evaluated.result?.objectId;
      if (typeof objectId !== "string" || !objectId) throw new Error("Browser frame could not be resolved.");
      try {
        const [rectResult, described] = await Promise.all([
          debug.sendCommand("Runtime.callFunctionOn", {
            objectId,
            functionDeclaration: "function() { const rect = this.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, clientLeft: this.clientLeft, clientTop: this.clientTop }; }",
            returnByValue: true,
            throwOnSideEffect: true,
          }),
          debug.sendCommand("DOM.describeNode", { objectId, depth: 0, pierce: true }),
        ]);
        const rect = rectResult?.result?.value;
        if (!rect || !Number.isFinite(Number(rect.x)) || !Number.isFinite(Number(rect.y))) {
          throw new Error("Browser frame bounds are unavailable.");
        }
        offsetX += Number(rect.x) + Number(rect.clientLeft || 0);
        offsetY += Number(rect.y) + Number(rect.clientTop || 0);
        const childFrameId = described?.node?.frameId ?? described?.node?.contentDocument?.frameId;
        if (typeof childFrameId !== "string" || !childFrameId) {
          throw new Error("Browser frame execution target is unavailable.");
        }
        frameId = childFrameId;
      } finally {
        await debug.sendCommand("Runtime.releaseObject", { objectId }).catch(() => undefined);
      }
    }
    return {
      frameId,
      contextId: await isolatedWorld(frameId, "dom"),
      offsetX,
      offsetY,
    };
  };

  const executeDom = async (
    action: "snapshot" | "locator" | "dom_cua" | "assets" | "wait" | "element_info" | "clipboard_copy" | "clipboard_paste",
    args: Record<string, unknown>,
  ) => {
    const selectors = frameSelectors(args.locator);
    if (selectors.length > 0) {
      const context = await resolveFrameContext(selectors);
      const framedArgs = {
        ...args,
        locator: locatorWithoutFrame(args.locator),
        __frameOffsetX: context.offsetX,
        __frameOffsetY: context.offsetY,
      };
      const evaluated = await debug.sendCommand("Runtime.evaluate", {
        expression: domScript(action, framedArgs),
        contextId: context.contextId,
        awaitPromise: true,
        returnByValue: true,
      });
      if (evaluated.exceptionDetails) {
        throw new Error(String(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text || "Browser frame operation failed.").slice(0, 500));
      }
      return boundedResult(evaluated.result?.value ?? null);
    }
    const result = await contents.executeJavaScriptInIsolatedWorld(
      ADVANCED_WORLD_ID,
      [{ code: domScript(action, args) }],
      true,
    );
    return boundedResult(result);
  };

  const executeSnapshot = async (args: Record<string, unknown>) => executeDom("snapshot", args);

  const executeVirtualClipboardShortcut = async (kind: "copy" | "cut" | "paste") => {
    if (kind === "paste") {
      const text = virtualClipboardItems
        .flatMap((item) => item.entries)
        .find((entry) => entry.mimeType === "text/plain" && entry.text !== undefined)?.text ?? "";
      await executeDom("clipboard_paste", { text });
    } else {
      const copied = await executeDom("clipboard_copy", { cut: kind === "cut" }) as { text?: unknown };
      virtualClipboardItems = [{ entries: [{ mimeType: "text/plain", text: String(copied.text || "") }] }];
    }
    return { performed: true, clipboard: "virtual" };
  };

  const executeCua = async (args: Record<string, unknown>) => {
    const action = String(args.action || "");
    const x = Number(args.x || 0);
    const y = Number(args.y || 0);
    const keys = Array.isArray(args.keys) ? args.keys.map(String) : [];
    const modifiers = modifierMask(keys);
    if (action === "elementInfo") return executeDom("element_info", { x, y });
    if (action === "click" || action === "doubleClick") {
      const button = args.button === 2 || args.button === "middle" ? "middle" : args.button === 3 || args.button === "right" ? "right" : "left";
      const clickCount = action === "doubleClick" ? 2 : 1;
      await debug.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount, modifiers });
      let resolveDialogOpened: (() => void) | null = null;
      const dialogOpened = new Promise<"dialog">((resolve) => {
        resolveDialogOpened = () => resolve("dialog");
        dialogOpenedWaiters.add(resolveDialogOpened);
      });
      const released = debug.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount, modifiers });
      const outcome = args.waitForRelease === true
        ? await released.then(() => "released" as const)
        : await Promise.race([released.then(() => "released" as const), dialogOpened]);
      if (resolveDialogOpened) dialogOpenedWaiters.delete(resolveDialogOpened);
      if (outcome === "dialog") void released.catch(() => undefined);
      return { performed: true };
    }
    if (action === "move") {
      await debug.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
      return { performed: true };
    }
    if (action === "scroll") {
      await debug.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX: Number(args.scrollX || 0),
        deltaY: Number(args.scrollY || 0),
        modifiers,
      });
      return { performed: true };
    }
    if (action === "drag") {
      const pathPoints = Array.isArray(args.path) ? args.path.filter((point) => point && typeof point === "object") as Array<Record<string, unknown>> : [];
      if (pathPoints.length < 2) throw new Error("Browser drag requires at least two path points.");
      const first = pathPoints[0]!;
      await debug.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: Number(first.x), y: Number(first.y), button: "left", clickCount: 1, modifiers });
      for (const point of pathPoints.slice(1)) {
        await debug.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: Number(point.x), y: Number(point.y), button: "left", buttons: 1, modifiers });
      }
      const last = pathPoints[pathPoints.length - 1]!;
      await debug.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: Number(last.x), y: Number(last.y), button: "left", clickCount: 1, modifiers });
      return { performed: true };
    }
    if (action === "type") {
      await debug.sendCommand("Input.insertText", { text: String(args.text || "").slice(0, 100_000) });
      return { performed: true };
    }
    if (action === "keypress") {
      if (keys.length === 0) throw new Error("Browser keypress requires keys.");
      const modifierKeys = keys.filter((key) => ["Alt", "Control", "Meta", "ControlOrMeta", "Shift"].includes(key));
      const primary = keys.findLast((key) => !modifierKeys.includes(key));
      if (!primary) throw new Error("Browser keypress requires a non-modifier key.");
      const virtualShortcut = (modifierKeys.includes("Control") || modifierKeys.includes("Meta") || modifierKeys.includes("ControlOrMeta"))
        ? ({ c: "copy", x: "cut", v: "paste" } as const)[primary.toLowerCase() as "c" | "x" | "v"]
        : undefined;
      if (virtualShortcut) return executeVirtualClipboardShortcut(virtualShortcut);
      const key = cdpKey(primary);
      await debug.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", ...key, modifiers });
      await debug.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...key, modifiers });
      return { performed: true };
    }
    throw new Error("Browser CUA action is unsupported.");
  };

  const executeClipboard = async (args: Record<string, unknown>) => {
    const action = String(args.action || "read");
    if (action === "write") virtualClipboardItems = normalizeVirtualClipboardItems(args.items);
    else if (action === "clear") virtualClipboardItems = [];
    else if (action !== "read") throw new Error("Browser virtual clipboard action is unsupported.");
    return { items: structuredClone(virtualClipboardItems) };
  };

  const executeLocator = async (args: Record<string, unknown>) => {
    const action = String(args.action || "count");
    const readOnlyActions = new Set([
      "count", "allTextContents", "textContent", "innerText", "attribute",
      "visible", "enabled", "checked", "selected", "wait",
    ]);
    if (!readOnlyActions.has(action)) {
      throw new Error("Browser locator is read-only; use a high-level Browser click/type or explicit coordinate CUA action to interact.");
    }
    return executeDom("locator", args);
  };

  const executeScreenshot = async (args: Record<string, unknown>) => {
    let clip = args.clip && typeof args.clip === "object" ? args.clip as Record<string, unknown> : null;
    if (args.locator && typeof args.locator === "object") {
      const result = await executeDom("locator", { action: "box", locator: args.locator }) as { value?: Record<string, number> };
      clip = result.value ?? null;
    }
    const format = args.format === "jpeg" ? "jpeg" : "png";
    const command: Record<string, unknown> = {
      format,
      captureBeyondViewport: args.fullPage === true,
      // Agent Browser tabs use hidden BrowserWindows; view capture is stable on
      // Linux CI where surface capture can wait indefinitely for a compositor.
      fromSurface: false,
    };
    if (format === "jpeg") command.quality = Math.max(1, Math.min(Number(args.quality || 80), 100));
    if (clip) command.clip = {
      x: Number(clip.x),
      y: Number(clip.y),
      width: Number(clip.width),
      height: Number(clip.height),
      scale: 1,
    };
    if (args.fullPage === true && !clip) {
      const metrics = await debug.sendCommand("Page.getLayoutMetrics");
      const size = metrics.cssContentSize ?? metrics.contentSize;
      const width = Number(size?.width);
      const height = Number(size?.height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error("Browser full-page dimensions are unavailable.");
      }
      if (width > 16_384 || height > 16_384) {
        throw new Error("Browser full-page screenshot exceeds Chromium's 16384-pixel dimension limit.");
      }
      clip = { x: 0, y: 0, width, height };
      command.clip = { ...clip, scale: 1 };
    }
    const [viewportWidth = 0, viewportHeight = 0] = options.window.getContentSize();
    const dimensions = {
      width: clip ? Number(clip.width) : viewportWidth,
      height: clip ? Number(clip.height) : viewportHeight,
    };
    const toResult = (buffer: Buffer, mimeType: "image/jpeg" | "image/png") => {
      if (buffer.length > 10_000_000) throw new Error("Browser screenshot exceeded the response limit.");
      return {
        mimeType,
        base64: buffer.toString("base64"),
        ...dimensions,
        fullPage: args.fullPage === true,
      };
    };
    const withTimeout = async <T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          operation,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(message)), timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    try {
      const result = await withTimeout(
        debug.sendCommand("Page.captureScreenshot", command),
        CDP_SCREENSHOT_TIMEOUT_MS,
        "Browser CDP screenshot timed out.",
      );
      const buffer = Buffer.from(String(result.data || ""), "base64");
      return toResult(buffer, format === "jpeg" ? "image/jpeg" : "image/png");
    } catch (error) {
      if (format !== "png") throw error;
      // Hidden BrowserWindows can leave Chromium's CDP screenshot command
      // waiting on a Linux compositor. Electron's native capture remains
      // scoped to the same tab and provides a bounded fallback.
      const nativeCapture = options.window.capturePage(clip ? {
        x: Number(clip.x),
        y: Number(clip.y),
        width: Number(clip.width),
        height: Number(clip.height),
      } : undefined);
      const nativeImage = await withTimeout(
        nativeCapture,
        NATIVE_SCREENSHOT_TIMEOUT_MS,
        "Browser native screenshot timed out.",
      );
      return toResult(nativeImage.toPNG(), "image/png");
    }
  };

  const fetchToFile = async (
    url: string,
    directory: string,
    suggestedName: string,
    maxBytes = MAX_ASSET_BYTES,
  ) => {
    if (disposed) throw new Error("Browser tab was closed.");
    const rudderAppOrigins = options.getRudderAppOrigins?.() ?? [];
    if (!isAllowedBrowserNavigationUrl(url, rudderAppOrigins)) {
      throw new Error("Browser asset URL is unsafe.");
    }
    const controller = new AbortController();
    activeFetches.add(controller);
    try {
      const response = await contents.session.fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
      });
      const rejectResponse = async (message: string): Promise<never> => {
        controller.abort();
        await response.body?.cancel(message).catch(() => undefined);
        throw new Error(message);
      };
      const finalUrl = response.url || url;
      if (!isAllowedBrowserNavigationUrl(finalUrl, rudderAppOrigins)) {
        return await rejectResponse("Browser asset redirect target is unsafe.");
      }
      if (!response.ok) return await rejectResponse(`Browser asset request failed with status ${response.status}.`);
      const declared = Number.parseInt(response.headers.get("content-length") || "", 10);
      if (Number.isFinite(declared) && declared > maxBytes) {
        return await rejectResponse("Browser asset exceeded the download limit.");
      }
      const bytes = await readBoundedResponseBytes(response, maxBytes);
      const parsed = new URL(url);
      const filename = safeFileName(suggestedName || path.basename(parsed.pathname), "asset.bin");
      let outputPath = path.join(directory, filename);
      try {
        await fs.writeFile(outputPath, bytes, { flag: "wx" });
      } catch (error) {
        if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        outputPath = path.join(directory, `${randomUUID()}-${filename}`);
        await fs.writeFile(outputPath, bytes, { flag: "wx" });
      }
      return { filename, path: outputPath, contentType: response.headers.get("content-type"), byteSize: bytes.length };
    } finally {
      activeFetches.delete(controller);
    }
  };

  const newArtifactDirectory = async () => {
    if (disposed) throw new Error("Browser tab was closed.");
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-browser-run-"));
    if (disposed) {
      await fs.rm(directory, { recursive: true, force: true });
      throw new Error("Browser tab was closed.");
    }
    artifactDirectories.add(directory);
    return directory;
  };

  const executeDownload = async (args: Record<string, unknown>) => {
    const mode = String(args.mode || "media");
    if (mode !== "media") {
      throw new Error("Browser locator-triggered downloads are unsupported because locator operations are read-only.");
    }
    const directory = await newArtifactDirectory();
    const media = await executeDom("locator", { action: "mediaUrl", locator: args.locator }) as { url: string; suggestedName?: string };
    const file = await fetchToFile(media.url, directory, String(media.suggestedName || ""));
    return { mode, directoryPath: directory, url: media.url, state: "completed", ...file };
  };

  const executeAssets = async (args: Record<string, unknown>) => {
    const action = String(args.action || "list");
    if (action === "list") {
      const raw = await executeDom("assets", {}) as {
        entries: Array<{ url: string; tag: string; rel: string; sources: PageAsset["sources"] }>;
        inlineSvgs: AssetInventory["inlineSvgs"];
      };
      const assets = raw.entries.map((entry, index) => ({
        id: `asset-${index + 1}`,
        kind: assetKind(entry.url, entry.tag, entry.rel),
        name: safeFileName(path.basename(new URL(entry.url).pathname), `asset-${index + 1}`),
        sources: entry.sources.slice(0, 20),
        url: entry.url.slice(0, 8_192),
      }));
      const inventory: AssetInventory = {
        id: randomUUID(),
        pageUrl: contents.getURL() || null,
        navigationSequence,
        assets,
        inlineSvgs: raw.inlineSvgs,
      };
      inventories.set(inventory.id, inventory);
      return boundedResult({
        ...inventory,
        summary: {
          totalCount: assets.length,
          inlineSvgCount: inventory.inlineSvgs.length,
          byKind: assets.reduce<Record<string, number>>((summary, asset) => {
            summary[asset.kind] = (summary[asset.kind] ?? 0) + 1;
            return summary;
          }, {}),
        },
      });
    }
    if (action === "bundle") {
      const inventory = inventories.get(String(args.inventoryId || ""));
      if (!inventory) throw new Error("Browser asset inventory is missing or stale.");
      if (inventory.pageUrl !== (contents.getURL() || null) || inventory.navigationSequence !== navigationSequence) {
        throw new Error("Browser asset inventory is stale because the page navigated; list assets again.");
      }
      const requestedIds = Array.isArray(args.assetIds) ? new Set(args.assetIds.map(String)) : null;
      const requestedKinds = Array.isArray(args.kinds) ? new Set(args.kinds.map(String)) : null;
      if (!requestedIds?.size && !requestedKinds?.size) throw new Error("Browser asset bundle requires explicit asset ids or kinds.");
      if (requestedIds) {
        const knownIds = new Set(inventory.assets.map((asset) => asset.id));
        const unknownIds = Array.from(requestedIds).filter((id) => !knownIds.has(id));
        if (unknownIds.length > 0) throw new Error(`Browser asset ids are unknown or stale: ${unknownIds.slice(0, 10).join(", ")}.`);
      }
      const selected = inventory.assets.filter((asset) => (!requestedIds || requestedIds.has(asset.id)) && (!requestedKinds || requestedKinds.has(asset.kind))).slice(0, 100);
      if (selected.length === 0) throw new Error("Browser asset selection matched no current page assets.");
      const maxTotalBytes = Math.max(0, Math.min(Number(args.maxTotalBytes ?? MAX_ASSET_BUNDLE_BYTES), MAX_ASSET_BUNDLE_BYTES));
      if (maxTotalBytes <= 0) throw new Error("Browser asset run quota is exhausted.");
      const directory = await newArtifactDirectory();
      const startedAt = Date.now();
      let totalBytes = 0;
      const assets: Array<Record<string, unknown>> = [];
      const failures: Array<Record<string, unknown>> = [];
      for (const asset of selected) {
        try {
          const remainingBytes = maxTotalBytes - totalBytes;
          if (remainingBytes <= 0) throw new Error("Browser asset bundle exceeded the aggregate size limit.");
          const file = await fetchToFile(asset.url, directory, asset.name, Math.min(MAX_ASSET_BYTES, remainingBytes));
          totalBytes += file.byteSize;
          assets.push({ ...asset, ...file });
        } catch (error) {
          failures.push({ ...asset, reason: error instanceof Error ? error.message.slice(0, 300) : "Download failed." });
        }
      }
      const manifestPath = path.join(directory, "manifest.json");
      await fs.writeFile(manifestPath, JSON.stringify({ inventoryId: inventory.id, pageUrl: inventory.pageUrl, assets, failures }, null, 2), "utf8");
      return boundedResult({
        directoryPath: directory,
        manifestPath,
        assets,
        failures,
        summary: {
          requestedCount: selected.length,
          downloadedCount: assets.length,
          failedCount: failures.length,
          totalBytes,
          maxTotalBytes,
          elapsedMs: Date.now() - startedAt,
        },
      });
    }
    throw new Error("Browser asset action is unsupported.");
  };

  const executeContent = async (args: Record<string, unknown>) => {
    const format = String(args.format || "text");
    if (format === "html") throw new Error("Browser HTML export is disabled because raw markup can contain credentials.");
    const directory = await newArtifactDirectory();
    let filename = `page.${format === "text" ? "txt" : format}`;
    let mimeType = format === "text" ? "text/plain" : "application/octet-stream";
    let bytes: Buffer;
    if (format === "text") {
      const expression = "document.body?.innerText || ''";
      const result = await debug.sendCommand("Runtime.evaluate", {
        expression,
        returnByValue: true,
        throwOnSideEffect: true,
      });
      bytes = Buffer.from(String(result.result?.value || ""), "utf8");
    } else if (format === "pdf" && new URL(contents.getURL()).hostname !== "docs.google.com") {
      const result = await debug.sendCommand("Page.printToPDF", { printBackground: true, preferCSSPageSize: true });
      bytes = Buffer.from(String(result.data || ""), "base64");
      mimeType = "application/pdf";
    } else {
      const exportTarget = googleWorkspaceExport(contents.getURL(), format);
      const file = await fetchToFile(exportTarget.url, directory, exportTarget.filename, MAX_CONTENT_EXPORT_BYTES);
      return {
        directoryPath: directory,
        format,
        filename: file.filename,
        path: file.path,
        mimeType: file.contentType || "application/octet-stream",
        byteSize: file.byteSize,
      };
    }
    if (bytes.length > MAX_CONTENT_EXPORT_BYTES) throw new Error("Browser content export exceeded the size limit.");
    const outputPath = path.join(directory, filename);
    await fs.writeFile(outputPath, bytes, { flag: "wx" });
    return { directoryPath: directory, format, filename, path: outputPath, mimeType, byteSize: bytes.length };
  };

  return {
    async execute(action, args) {
      if (disposed || contents.isDestroyed()) throw new Error("Browser tab was closed.");
      if (action === "snapshot") return executeSnapshot(args);
      if (action === "locator") return executeLocator(args);
      if (action === "cua") return executeCua(args);
      if (action === "dom_cua") {
        return executeDom("dom_cua", args);
      }
      if (action === "clipboard") return executeClipboard(args);
      if (action === "dialog") {
        if (args.action === "get") return { dialog };
        if (!dialog) throw new Error("Browser dialog is not open.");
        const accept = args.action === "accept";
        const handled = dialog;
        const promptText = accept && typeof args.promptText === "string" ? args.promptText.slice(0, 10_000) : "";
        if (handled.type === "prompt") {
          if (electronDialogCallback) {
            const callback = electronDialogCallback;
            electronDialogCallback = null;
            dialog = null;
            callback(false, "");
          } else {
            await debug.sendCommand("Page.handleJavaScriptDialog", { accept: false });
            dialog = null;
          }
          if (accept) throw new Error("Browser prompt acceptance is unavailable in Electron; the prompt was dismissed safely.");
        } else if (electronDialogCallback) {
          const callback = electronDialogCallback;
          electronDialogCallback = null;
          dialog = null;
          let resolveClosed: ((params: Record<string, unknown>) => void) | null = null;
          const closed = new Promise<Record<string, unknown> | null>((resolve) => {
            const timer = setTimeout(() => {
              if (resolveClosed) dialogClosedWaiters.delete(resolveClosed);
              resolve(null);
            }, 1_000);
            resolveClosed = (params) => {
              clearTimeout(timer);
              resolve(params);
            };
            dialogClosedWaiters.add(resolveClosed);
          });
          callback(accept, promptText);
          const closedState = await closed;
          if (closedState && closedState.result !== accept) {
            throw new Error("Browser dialog closed with an unexpected result.");
          }
        } else {
          await debug.sendCommand("Page.handleJavaScriptDialog", {
            accept,
            ...(accept && typeof args.promptText === "string" ? { promptText } : {}),
          });
          electronDialogCallback = null;
          dialog = null;
        }
        return { handled: true, action: accept ? "accept" : "dismiss", type: handled.type };
      }
      if (action === "logs") {
        const requestedLevels = Array.isArray(args.levels) ? new Set(args.levels.map(String)) : null;
        const filter = typeof args.filter === "string" ? args.filter.toLowerCase() : null;
        const limit = Math.max(1, Math.min(Number(args.limit || 100), 500));
        const selected = logs.filter((entry) => (!requestedLevels || requestedLevels.has(entry.level)) && (!filter || entry.message.toLowerCase().includes(filter))).slice(-limit);
        if (args.clear === true) logs.length = 0;
        return { logs: selected, totalBuffered: logs.length };
      }
      if (action === "download") return executeDownload(args);
      if (action === "assets") return executeAssets(args);
      if (action === "content") return executeContent(args);
      if (action === "wait") return executeDom("wait", args);
      if (action === "screenshot") return executeScreenshot(args);
      throw new Error("Browser advanced action is unsupported.");
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const controller of activeFetches) controller.abort();
      activeFetches.clear();
      cancelAgentBrowserDownload(contents);
      if (electronDialogCallback) electronDialogCallback(false, "");
      electronDialogCallback = null;
      contents.removeListener("-run-dialog", onElectronDialog);
      contents.removeListener("-cancel-dialogs", onElectronDialogsCancelled);
      contents.removeListener("console-message", onConsoleMessage);
      debug.removeListener("message", onDebuggerMessage);
      if (debug.isAttached()) debug.detach();
      await Promise.all(Array.from(artifactDirectories, (directory) => fs.rm(directory, { recursive: true, force: true })));
      artifactDirectories.clear();
      inventories.clear();
      dialogOpenedWaiters.clear();
      dialogClosedWaiters.clear();
      logs.length = 0;
      dialog = null;
    },
  };
}
