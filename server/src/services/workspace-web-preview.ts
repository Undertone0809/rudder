import type { Db } from "@rudderhq/db";
import type {
  OrganizationWorkspaceWebPreviewSession,
  WorkspaceWebPreviewNetworkMode,
} from "@rudderhq/shared";
import type { Request, Response } from "express";
import { JSDOM } from "jsdom";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { HttpError, badRequest, forbidden, notFound, unprocessable } from "../errors.js";
import { resolveOrganizationWorkspaceRoot } from "../home-paths.js";

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 64;
const MAX_HTML_OVERRIDE_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEW_ASSET_BYTES = 32 * 1024 * 1024;
const PREVIEW_PATH_PREFIX = "/workspace-preview/";
const PROTECTED_LIBRARY_ROOTS = new Set(["agents", "skills"]);
const HTML_EXTENSIONS = new Set([".htm", ".html"]);
const execFileAsync = promisify(execFile);
const MAX_CONCURRENT_DARWIN_FD_LOOKUPS = 8;
let activeDarwinFdLookups = 0;

const CONTENT_TYPES = new Map<string, string>([
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".htm", "text/html; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".oga", "audio/ogg"],
  [".ogg", "audio/ogg"],
  [".ogv", "video/ogg"],
  [".otf", "font/otf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".wav", "audio/wav"],
  [".webm", "video/webm"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml; charset=utf-8"],
]);

interface PreviewSessionRecord {
  tokenHash: string;
  orgId: string;
  artifactRelativePath: string;
  entryAssetPath: string;
  networkMode: WorkspaceWebPreviewNetworkMode;
  htmlOverride: string | null;
  canonicalOrgRoot: string;
  canonicalArtifactRoot: string;
  previewOrigin: string;
  parentOrigin: string;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface WorkspaceWebPreviewRuntimeOptions {
  previewOrigin: string;
  requireLoopbackParent?: boolean;
  now?: () => number;
  randomToken?: () => string;
  sessionTtlMs?: number;
  maxSessions?: number;
  resolveWorkspaceRoot?: (orgId: string) => string;
  beforeFileOpen?: (canonicalTarget: string) => Promise<void>;
  resolveOpenedFilePath?: (handle: FileHandle) => Promise<string>;
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function isPathWithin(rootPath: string, targetPath: string) {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function hasHiddenPathSegment(value: string) {
  return value.split("/").some((segment) => segment.startsWith("."));
}

function canonicalRelativePathSegments(rootPath: string, targetPath: string) {
  const relative = path.relative(rootPath, targetPath);
  if (!relative) return [];
  return relative.split(path.sep);
}

function violatesCanonicalLibraryPolicy(input: {
  canonicalOrgRoot: string;
  canonicalArtifactRoot: string;
  canonicalTarget?: string;
}) {
  const artifactSegments = canonicalRelativePathSegments(
    input.canonicalOrgRoot,
    input.canonicalArtifactRoot,
  );
  if (
    artifactSegments.length === 0
    || artifactSegments.some((segment) => segment.startsWith("."))
    || PROTECTED_LIBRARY_ROOTS.has((artifactSegments[0] ?? "").toLowerCase())
  ) {
    return true;
  }
  if (!input.canonicalTarget) return false;
  const targetSegments = canonicalRelativePathSegments(
    input.canonicalArtifactRoot,
    input.canonicalTarget,
  );
  return targetSegments.length === 0
    || targetSegments.some((segment) => segment.startsWith("."));
}

function normalizeEntryPath(value: string) {
  const normalized = value.trim();
  const segments = normalized.split("/");
  if (
    !normalized
    || normalized.includes("\\")
    || normalized.includes("\0")
    || path.posix.isAbsolute(normalized)
    || path.win32.isAbsolute(normalized)
    || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))
  ) {
    throw unprocessable("Website preview entry must stay inside an ordinary Library artifact directory");
  }
  return segments.join("/");
}

async function openStableRegularFile(input: {
  canonicalTarget: string;
  maxBytes: number;
  invalid: () => HttpError;
  oversized: () => HttpError;
  beforeOpen?: (canonicalTarget: string) => Promise<void>;
  resolveOpenedPath: (handle: FileHandle) => Promise<string>;
}) {
  await input.beforeOpen?.(input.canonicalTarget);
  let expectedStat;
  try {
    expectedStat = await fs.stat(input.canonicalTarget);
  } catch {
    throw input.invalid();
  }
  if (!expectedStat.isFile()) throw input.invalid();
  if (expectedStat.size > input.maxBytes) throw input.oversized();

  let handle: FileHandle;
  try {
    handle = await fs.open(
      input.canonicalTarget,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch {
    throw input.invalid();
  }
  try {
    const openedStat = await handle.stat();
    const openedPath = await input.resolveOpenedPath(handle).catch(() => {
      throw input.invalid();
    });
    if (
      !openedStat.isFile()
      || openedStat.dev !== expectedStat.dev
      || openedStat.ino !== expectedStat.ino
      || path.resolve(openedPath) !== path.resolve(input.canonicalTarget)
    ) {
      throw input.invalid();
    }
    if (openedStat.size > input.maxBytes) throw input.oversized();
    return { handle, stat: openedStat };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function readStableFile(handle: FileHandle, size: number) {
  if (size === 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset === size ? buffer : buffer.subarray(0, offset);
}

async function resolveOpenedFilePath(handle: FileHandle) {
  if (process.platform === "linux") {
    return fs.realpath(`/proc/self/fd/${handle.fd}`);
  }
  if (process.platform === "darwin") {
    if (activeDarwinFdLookups >= MAX_CONCURRENT_DARWIN_FD_LOOKUPS) {
      throw new Error("Stable opened-file path verification is busy");
    }
    activeDarwinFdLookups += 1;
    try {
      const { stdout } = await execFileAsync(
        "/usr/sbin/lsof",
        ["-p", String(process.pid), "-a", "-d", String(handle.fd), "-F0n"],
        {
          encoding: "utf8",
          env: { LANG: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
          maxBuffer: 64 * 1024,
          timeout: 5_000,
        },
      );
      const fields = stdout
        .split("\0")
        .map((field) => field.replace(/^\n+/, ""))
        .filter(Boolean);
      const pidFields = fields.filter((field) => field.startsWith("p"));
      const fdFields = fields.filter((field) => field.startsWith("f"));
      const nameFields = fields.filter((field) => field.startsWith("n"));
      const openedPath = nameFields[0]?.slice(1);
      if (
        pidFields.length === 1
        && pidFields[0] === `p${process.pid}`
        && fdFields.length === 1
        && fdFields[0] === `f${handle.fd}`
        && nameFields.length === 1
        && openedPath
        && !/[\u0000-\u001f\u007f]/.test(openedPath)
      ) {
        return openedPath;
      }
    } finally {
      activeDarwinFdLookups -= 1;
    }
  }
  throw new Error("Stable opened-file path resolution is unavailable on this platform");
}

function normalizeParentOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw badRequest("Website preview requires a valid browser origin");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== value) {
    throw badRequest("Website preview requires an HTTP(S) browser origin");
  }
  return url.origin;
}

function isLoopbackParentOrigin(origin: string) {
  const hostname = new URL(origin).hostname;
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname === "[::1]";
}

function isExternalNavigationTarget(value: string) {
  const normalized = value
    .replace(/[\t\n\r]/g, "")
    .replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");
  return normalized.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(normalized);
}

export function sanitizeOfflinePreviewHtml(content: string) {
  const dom = new JSDOM(content);
  const document = dom.window.document;

  document.querySelectorAll("meta[http-equiv]").forEach((element) => {
    if (element.getAttribute("http-equiv")?.trim().toLowerCase() === "refresh") {
      element.remove();
    }
  });
  document.querySelectorAll("base").forEach((element) => element.remove());
  document.querySelectorAll<HTMLElement>("a[href],area[href]").forEach((element) => {
    const href = element.getAttribute("href");
    if (element.hasAttribute("download")) {
      element.removeAttribute("download");
      element.removeAttribute("href");
      element.setAttribute("data-rudder-blocked-href", "download");
    } else if (href && isExternalNavigationTarget(href)) {
      element.removeAttribute("href");
      element.setAttribute("data-rudder-blocked-href", "external");
    }
    element.removeAttribute("ping");
  });

  return dom.serialize();
}

export function sanitizeConnectedPreviewHtml(content: string) {
  const dom = new JSDOM(content);
  const document = dom.window.document;
  document.querySelectorAll<HTMLElement>("a[download],area[download]").forEach((element) => {
    element.removeAttribute("download");
    element.removeAttribute("href");
    element.removeAttribute("ping");
    element.setAttribute("data-rudder-blocked-href", "download");
  });
  return dom.serialize();
}

export function workspaceWebPreviewContentType(assetPath: string) {
  return CONTENT_TYPES.get(path.extname(assetPath).toLowerCase()) ?? "application/octet-stream";
}

export function buildWorkspaceWebPreviewCsp(input: {
  mode: WorkspaceWebPreviewNetworkMode;
  previewOrigin: string;
  parentOrigin: string;
}) {
  const local = input.previewOrigin;
  const connected = input.mode === "connected" ? " https:" : "";
  const scriptSource = input.mode === "connected"
    ? `${local} 'unsafe-inline' blob: https:`
    : "'none'";
  const workerSource = input.mode === "connected" ? `${local} blob:` : "'none'";
  const sandbox = input.mode === "connected" ? "sandbox allow-scripts" : "sandbox";
  return [
    "default-src 'none'",
    "base-uri 'none'",
    `frame-ancestors ${input.parentOrigin}`,
    `${sandbox}`,
    `script-src ${scriptSource}`,
    `style-src ${local} 'unsafe-inline' data: blob:${connected}`,
    `img-src ${local} data: blob:${connected}`,
    `font-src ${local} data: blob:${connected}`,
    `media-src ${local} data: blob:${connected}`,
    `manifest-src ${local}${connected}`,
    `worker-src ${workerSource}`,
    "connect-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "object-src 'none'",
  ].join("; ");
}

function decodePreviewPathSegment(rawSegment: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawSegment);
  } catch {
    throw notFound("Website preview asset not found");
  }

  let securityDecoded = decoded;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const next = decodeURIComponent(securityDecoded);
      if (next === securityDecoded) break;
      securityDecoded = next;
    } catch {
      break;
    }
  }
  if (
    !decoded
    || decoded.startsWith(".")
    || securityDecoded === "."
    || securityDecoded === ".."
    || securityDecoded.includes("/")
    || securityDecoded.includes("\\")
    || securityDecoded.includes("\0")
  ) {
    throw notFound("Website preview asset not found");
  }
  return decoded;
}

function parsePreviewAssetRequest(originalUrl: string) {
  const rawPath = originalUrl.split("?", 1)[0] ?? "";
  if (!rawPath.startsWith(PREVIEW_PATH_PREFIX)) {
    throw notFound("Website preview asset not found");
  }
  const segments = rawPath.slice(PREVIEW_PATH_PREFIX.length).split("/");
  const rawToken = segments.shift() ?? "";
  if (!/^[A-Za-z0-9_-]{32,}$/.test(rawToken) || segments.length === 0) {
    throw notFound("Website preview asset not found");
  }
  return {
    token: rawToken,
    assetPath: segments.map(decodePreviewPathSegment).join("/"),
  };
}

function setCommonPreviewHeaders(res: Response) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Permissions-Policy",
    "accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), usb=()",
  );
}

function sendPreviewError(res: Response, error: unknown) {
  const status = error instanceof HttpError ? error.status : 500;
  const message = status === 410
    ? "This preview session expired. Reload the preview from Rudder."
    : status === 404
      ? "This preview resource is not available."
      : "This website preview could not be loaded.";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preview unavailable</title><style>body{margin:0;padding:24px;background:#fff;color:#242625;font:14px/1.5 system-ui,sans-serif}p{max-width:42rem}</style></head><body><p>${message}</p></body></html>`;
  setCommonPreviewHeaders(res);
  res.status(status).setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
  res.setHeader("Content-Length", String(Buffer.byteLength(html)));
  res.end(html);
}

export function workspaceWebPreviewRuntime(db: Db, options: WorkspaceWebPreviewRuntimeOptions) {
  void db;
  const previewUrl = new URL(options.previewOrigin);
  const previewHost = previewUrl.host.toLowerCase();
  const previewOrigin = previewUrl.origin;
  const now = options.now ?? Date.now;
  const createToken = options.randomToken ?? (() => randomBytes(32).toString("base64url"));
  const resolveWorkspaceRoot = options.resolveWorkspaceRoot ?? resolveOrganizationWorkspaceRoot;
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const resolveOpenPath = options.resolveOpenedFilePath ?? resolveOpenedFilePath;
  const sessions = new Map<string, PreviewSessionRecord>();

  function pruneSessions() {
    const currentTime = now();
    for (const [hash, session] of sessions) {
      if (session.expiresAtMs <= currentTime) sessions.delete(hash);
    }
    while (sessions.size >= maxSessions) {
      const oldest = sessions.keys().next().value as string | undefined;
      if (!oldest) break;
      sessions.delete(oldest);
    }
  }

  function isPreviewHostRequest(req: Request) {
    return req.header("host")?.trim().toLowerCase() === previewHost;
  }

  async function createSession(input: {
    orgId: string;
    entryPath: string;
    networkMode: WorkspaceWebPreviewNetworkMode;
    htmlContent?: string;
    parentOrigin: string;
  }): Promise<OrganizationWorkspaceWebPreviewSession> {
    const parentOrigin = normalizeParentOrigin(input.parentOrigin);
    if (options.requireLoopbackParent && !isLoopbackParentOrigin(parentOrigin)) {
      throw unprocessable(
        "Website preview for non-loopback Rudder access requires RUDDER_WORKSPACE_PREVIEW_ORIGIN",
      );
    }
    if (new URL(parentOrigin).host.toLowerCase() === previewHost) {
      throw forbidden("Website preview cannot use the Preview Host as its parent origin");
    }
    if (input.htmlContent !== undefined && Buffer.byteLength(input.htmlContent) > MAX_HTML_OVERRIDE_BYTES) {
      throw unprocessable("Website preview HTML must be 2 MB or smaller");
    }

    const entryPath = normalizeEntryPath(input.entryPath);
    const extension = path.posix.extname(entryPath).toLowerCase();
    const artifactRelativePath = path.posix.dirname(entryPath);
    const firstSegment = entryPath.split("/")[0] ?? "";
    if (!HTML_EXTENSIONS.has(extension)) {
      throw unprocessable("Website preview requires a readable HTML entry file");
    }
    if (
      artifactRelativePath === "."
      || artifactRelativePath === ""
      || PROTECTED_LIBRARY_ROOTS.has(firstSegment.toLowerCase())
      || hasHiddenPathSegment(entryPath)
    ) {
      throw unprocessable("Website preview requires an ordinary non-root Library artifact directory");
    }

    const orgRootPath = resolveWorkspaceRoot(input.orgId);
    const artifactPath = path.resolve(orgRootPath, artifactRelativePath);
    const entryFilePath = path.resolve(orgRootPath, entryPath);
    let canonicalOrgRoot: string;
    let canonicalArtifactRoot: string;
    let canonicalEntryFile: string;
    try {
      [canonicalOrgRoot, canonicalArtifactRoot, canonicalEntryFile] = await Promise.all([
        fs.realpath(orgRootPath),
        fs.realpath(artifactPath),
        fs.realpath(entryFilePath),
      ]);
    } catch {
      throw unprocessable("Website preview requires a readable HTML entry file");
    }
    if (
      !isPathWithin(canonicalOrgRoot, canonicalArtifactRoot)
      || !isPathWithin(canonicalArtifactRoot, canonicalEntryFile)
      || violatesCanonicalLibraryPolicy({
        canonicalOrgRoot,
        canonicalArtifactRoot,
        canonicalTarget: canonicalEntryFile,
      })
    ) {
      throw unprocessable("Website preview entry must stay inside its Library artifact directory");
    }
    const openedEntry = await openStableRegularFile({
      canonicalTarget: canonicalEntryFile,
      maxBytes: MAX_HTML_OVERRIDE_BYTES,
      invalid: () => unprocessable("Website preview requires a stable regular HTML entry file"),
      oversized: () => unprocessable("Website preview HTML must be 2 MB or smaller"),
      beforeOpen: options.beforeFileOpen,
      resolveOpenedPath: resolveOpenPath,
    });
    await openedEntry.handle.close();

    pruneSessions();
    const token = createToken();
    const hash = tokenHash(token);
    const createdAtMs = now();
    const expiresAtMs = createdAtMs + sessionTtlMs;
    sessions.set(hash, {
      tokenHash: hash,
      orgId: input.orgId,
      artifactRelativePath,
      entryAssetPath: path.posix.basename(entryPath),
      networkMode: input.networkMode,
      htmlOverride: input.htmlContent ?? null,
      canonicalOrgRoot,
      canonicalArtifactRoot,
      previewOrigin,
      parentOrigin,
      createdAtMs,
      expiresAtMs,
    });

    const encodedEntryPath = path.posix.basename(entryPath)
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    return {
      previewUrl: `${previewOrigin}${PREVIEW_PATH_PREFIX}${token}/${encodedEntryPath}`,
      networkMode: input.networkMode,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  async function resolveAsset(token: string, assetPath: string, includeBody: boolean) {
    const hash = tokenHash(token);
    const session = sessions.get(hash);
    if (!session) throw notFound("Website preview session not found");
    if (session.expiresAtMs <= now()) {
      sessions.delete(hash);
      throw new HttpError(410, "Website preview session expired");
    }

    const currentOrgRootPath = resolveWorkspaceRoot(session.orgId);
    const currentArtifactPath = path.resolve(currentOrgRootPath, session.artifactRelativePath);
    const targetPath = path.resolve(currentArtifactPath, ...assetPath.split("/"));
    const [currentOrgRoot, currentArtifactRoot, canonicalTarget] = await Promise.all([
      fs.realpath(currentOrgRootPath),
      fs.realpath(currentArtifactPath),
      fs.realpath(targetPath),
    ]).catch(() => {
      throw notFound("Website preview asset not found");
    });
    if (
      currentOrgRoot !== session.canonicalOrgRoot
      || currentArtifactRoot !== session.canonicalArtifactRoot
      || !isPathWithin(currentOrgRoot, currentArtifactRoot)
      || !isPathWithin(currentArtifactRoot, canonicalTarget)
      || violatesCanonicalLibraryPolicy({
        canonicalOrgRoot: currentOrgRoot,
        canonicalArtifactRoot: currentArtifactRoot,
        canonicalTarget,
      })
    ) {
      throw forbidden("Website preview boundary changed");
    }
    const isEntryOverride = assetPath === session.entryAssetPath && session.htmlOverride !== null;
    const contentType = workspaceWebPreviewContentType(assetPath);
    const maxBytes = contentType.startsWith("text/html")
      ? MAX_HTML_OVERRIDE_BYTES
      : MAX_PREVIEW_ASSET_BYTES;
    const opened = await openStableRegularFile({
      canonicalTarget,
      maxBytes,
      invalid: () => forbidden("Website preview asset boundary changed"),
      oversized: () => new HttpError(413, "Website preview asset exceeds the size limit"),
      beforeOpen: options.beforeFileOpen,
      resolveOpenedPath: resolveOpenPath,
    });
    try {
      const buffer = includeBody
        ? isEntryOverride
          ? Buffer.from(session.htmlOverride!, "utf8")
          : await readStableFile(opened.handle, opened.stat.size)
        : null;
      return { session, buffer, contentType };
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  }

  async function handlePreviewHostRequest(req: Request, res: Response) {
    if (!isPreviewHostRequest(req)) return false;
    if (req.method !== "GET" && req.method !== "HEAD") {
      setCommonPreviewHeaders(res);
      res.setHeader("Allow", "GET, HEAD");
      res.status(405).end();
      return true;
    }

    try {
      const { token, assetPath } = parsePreviewAssetRequest(req.originalUrl);
      const asset = await resolveAsset(token, assetPath, req.method !== "HEAD");
      const isHtml = asset.contentType.startsWith("text/html");
      const body = asset.buffer && isHtml
        ? Buffer.from(
          asset.session.networkMode === "offline"
            ? sanitizeOfflinePreviewHtml(asset.buffer.toString("utf8"))
            : sanitizeConnectedPreviewHtml(asset.buffer.toString("utf8")),
          "utf8",
        )
        : asset.buffer;

      setCommonPreviewHeaders(res);
      res.status(200);
      res.setHeader("Content-Type", asset.contentType);
      res.setHeader("Content-Disposition", `inline; filename="${path.posix.basename(assetPath).replaceAll('"', "")}"`);
      if (body) res.setHeader("Content-Length", String(body.length));
      if (isHtml) {
        res.setHeader("Content-Security-Policy", buildWorkspaceWebPreviewCsp({
          mode: asset.session.networkMode,
          previewOrigin: asset.session.previewOrigin,
          parentOrigin: asset.session.parentOrigin,
        }));
      } else if (asset.contentType === "image/svg+xml") {
        res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      }
      if (req.method === "HEAD") res.end();
      else res.end(body ?? undefined);
    } catch (error) {
      sendPreviewError(res, error);
    }
    return true;
  }

  return {
    createSession,
    handlePreviewHostRequest,
    isPreviewHostRequest,
  };
}

export type WorkspaceWebPreviewRuntime = ReturnType<typeof workspaceWebPreviewRuntime>;
