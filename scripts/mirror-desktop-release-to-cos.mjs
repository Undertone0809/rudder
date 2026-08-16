#!/usr/bin/env node

import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const DEFAULT_PREFIX = "releases";
const DEFAULT_STS_ENDPOINT = "https://sts.tencentcloudapi.com";
const DEFAULT_STS_DURATION_SECONDS = 3600;
const DEFAULT_OIDC_AUDIENCE = "sts.cloud.tencent.com";
const SIGNABLE_HEADERS = new Set([
  "cache-control",
  "content-disposition",
  "content-encoding",
  "content-length",
  "content-md5",
  "content-type",
  "expect",
  "expires",
  "host",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-unmodified-since",
  "origin",
  "range",
  "transfer-encoding",
]);

export function objectKeyForReleaseAsset(prefix, tag, assetName) {
  const prefixSegments = validateObjectPath(prefix, "COS prefix");
  const tagSegments = validateObjectPath(tag, "release tag");
  validateAssetName(assetName);
  return [...prefixSegments, ...tagSegments, assetName].join("/");
}

export function createCosAuthorization({
  secretId,
  secretKey,
  method,
  pathname,
  headers,
  query = new URLSearchParams(),
  keyTime,
}) {
  if (!secretId || !secretKey) throw new Error("Tencent COS credentials are required for signing.");
  if (!/^\d+;\d+$/.test(keyTime)) throw new Error(`Invalid COS key time: ${keyTime}`);

  const signedHeaders = canonicalEntries(headers, (name) =>
    SIGNABLE_HEADERS.has(name) || name.startsWith("x-cos-"),
  );
  const signedQuery = canonicalEntries(query);
  const headerList = signedHeaders.map(([name]) => camSafeEncode(name)).join(";");
  const queryList = signedQuery.map(([name]) => camSafeEncode(name)).join(";");
  const canonicalRequest = [
    method.toLowerCase(),
    pathname,
    canonicalString(signedQuery),
    canonicalString(signedHeaders),
    "",
  ].join("\n");
  const signKey = createHmac("sha1", secretKey).update(keyTime).digest("hex");
  const stringToSign = [
    "sha1",
    keyTime,
    createHash("sha1").update(canonicalRequest).digest("hex"),
    "",
  ].join("\n");
  const signature = createHmac("sha1", signKey).update(stringToSign).digest("hex");
  return [
    "q-sign-algorithm=sha1",
    `q-ak=${secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    `q-header-list=${headerList}`,
    `q-url-param-list=${queryList}`,
    `q-signature=${signature}`,
  ].join("&");
}

export async function requestGitHubOidcToken({
  requestUrl,
  requestToken,
  audience = DEFAULT_OIDC_AUDIENCE,
  fetchImpl = fetch,
}) {
  if (!requestUrl || !requestToken) {
    throw new Error("GitHub Actions OIDC request URL and token are required.");
  }
  const url = new URL(requestUrl);
  url.searchParams.set("audience", audience);
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${requestToken}` },
  });
  if (!response.ok) throw await httpError("request GitHub OIDC token", response);
  const payload = await response.json();
  if (!payload?.value || typeof payload.value !== "string") {
    throw new Error("GitHub OIDC response did not include a token value.");
  }
  return payload.value;
}

export async function assumeTencentRoleWithWebIdentity({
  providerId,
  region,
  roleArn,
  roleSessionName,
  webIdentityToken,
  durationSeconds = DEFAULT_STS_DURATION_SECONDS,
  endpoint = DEFAULT_STS_ENDPOINT,
  fetchImpl = fetch,
}) {
  if (!providerId || !region || !roleArn || !roleSessionName || !webIdentityToken) {
    throw new Error(
      "ProviderId, Region, RoleArn, RoleSessionName, and WebIdentityToken are required for Tencent STS.",
    );
  }
  validateRegion(region);
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 900 || durationSeconds > 43_200) {
    throw new Error("Tencent STS DurationSeconds must be an integer from 900 through 43200.");
  }
  const url = normalizeStsEndpoint(endpoint);
  const body = JSON.stringify({
    ProviderId: providerId,
    RoleArn: roleArn,
    RoleSessionName: roleSessionName,
    WebIdentityToken: webIdentityToken,
    DurationSeconds: durationSeconds,
  });
  const response = await fetchImpl(url, {
    body,
    headers: {
      authorization: "SKIP",
      "content-type": "application/json; charset=utf-8",
      host: url.hostname,
      "x-tc-action": "AssumeRoleWithWebIdentity",
      "x-tc-region": region,
      "x-tc-timestamp": String(Math.floor(Date.now() / 1000)),
      "x-tc-version": "2018-08-13",
    },
    method: "POST",
  });
  if (!response.ok) throw await httpError("assume Tencent role with web identity", response);
  const payload = await response.json();
  if (payload?.Response?.Error) {
    const { Code, Message } = payload.Response.Error;
    throw new Error(`Tencent STS AssumeRoleWithWebIdentity failed: ${Code}: ${Message}`);
  }
  const credentials = payload?.Response?.Credentials;
  if (!credentials?.TmpSecretId || !credentials?.TmpSecretKey || !credentials?.Token) {
    throw new Error("Tencent STS response did not include TmpSecretId, TmpSecretKey, and Token.");
  }
  return {
    secretId: credentials.TmpSecretId,
    secretKey: credentials.TmpSecretKey,
    token: credentials.Token,
  };
}

export async function getTencentStsCredentials(options) {
  const webIdentityToken = await requestGitHubOidcToken(options);
  return assumeTencentRoleWithWebIdentity({ ...options, webIdentityToken });
}

export class CosReleaseMirror {
  constructor({ bucket, region, endpoint, credentials, fetchImpl = fetch, now = Date.now }) {
    this.bucket = validateBucket(bucket);
    this.region = validateRegion(region);
    this.endpoint = normalizeCosEndpoint(endpoint, this.bucket, this.region);
    this.credentials = validateCredentials(credentials);
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async mirrorFile(key, file) {
    const existing = await this.requestObject("HEAD", key);
    if (existing.status === 200) {
      await existing.body?.cancel();
      const current = await this.readObject(key, true);
      if (current.status !== 200) {
        throw await httpError(`read existing COS object ${key}`, current.response);
      }
      assertMatchingBytes(key, file, current);
    } else if (existing.status === 404) {
      await existing.body?.cancel();
      const upload = await this.putObject(key, file);
      if (![200, 201, 409, 412].includes(upload.status)) {
        throw await httpError(`upload COS object ${key}`, upload);
      }
      await upload.body?.cancel();
      const stored = await this.readObject(key, true);
      if (stored.status !== 200) {
        throw await httpError(`verify authenticated COS object ${key}`, stored.response);
      }
      assertMatchingBytes(key, file, stored);
    } else {
      const error = await httpError(`inspect COS object ${key}`, existing);
      if (existing.status === 403) {
        error.message +=
          " Tencent COS requires the distinct name/cos:HeadObject CAM action for this signed HEAD check; " +
          "name/cos:GetObject alone is insufficient.";
      }
      throw error;
    }

    const publicObject = await this.readObject(key, false);
    if (publicObject.status !== 200) {
      throw await httpError(`verify anonymous COS object ${key}`, publicObject.response);
    }
    assertMatchingBytes(key, file, publicObject);
  }

  async assertAnonymousAccessDenied(prefix = DEFAULT_PREFIX) {
    const normalizedPrefix = validateObjectPath(prefix, "COS prefix").join("/");
    const listUrl = new URL(this.endpoint);
    listUrl.searchParams.set("prefix", `${normalizedPrefix}/`);
    listUrl.searchParams.set("max-keys", "1");
    const listResponse = await this.fetchImpl(listUrl, { redirect: "manual" });
    if (listResponse.status !== 403) {
      throw new Error(`Anonymous COS bucket listing must return 403, received ${listResponse.status}.`);
    }
    await listResponse.body?.cancel();

    const probeKey = `${normalizedPrefix}/.rudder-anonymous-write-probe-${this.now()}-${process.pid}`;
    const writeResponse = await this.fetchImpl(this.objectUrl(probeKey), {
      body: Buffer.alloc(0),
      headers: {
        "content-length": "0",
        "x-cos-forbid-overwrite": "true",
      },
      method: "PUT",
      redirect: "manual",
    });
    if (writeResponse.status !== 403) {
      throw new Error(`Anonymous COS object write must return 403, received ${writeResponse.status}.`);
    }
    await writeResponse.body?.cancel();
  }

  async readObject(key, authenticated) {
    const response = await this.requestObject("GET", key, { authenticated });
    if (response.status !== 200 || !response.body) return { response, status: response.status };
    return { response, ...(await hashResponse(response)), status: response.status };
  }

  putObject(key, file) {
    return this.requestObject("PUT", key, {
      body: createReadStream(file.path),
      headers: {
        "content-length": String(file.size),
        "content-md5": file.md5,
        "content-type": file.contentType,
        "x-cos-forbid-overwrite": "true",
        "x-cos-meta-sha256": file.sha256,
      },
    });
  }

  requestObject(method, key, { authenticated = true, body, headers = {} } = {}) {
    const url = this.objectUrl(key);
    const requestHeaders = new Headers(headers);
    if (authenticated) this.authorize(requestHeaders, method, url);
    return this.fetchImpl(url, {
      ...(body === undefined ? {} : { body, duplex: "half" }),
      headers: requestHeaders,
      method,
      redirect: "manual",
    });
  }

  authorize(headers, method, url) {
    const { secretId, secretKey, token } = this.credentials;
    headers.set("host", url.hostname);
    headers.set("x-cos-security-token", token);
    const start = Math.floor(this.now() / 1000) - 1;
    const keyTime = `${start};${start + 900}`;
    headers.set(
      "authorization",
      createCosAuthorization({
        headers,
        keyTime,
        method,
        pathname: url.pathname,
        query: url.searchParams,
        secretId,
        secretKey,
      }),
    );
  }

  objectUrl(key) {
    validateObjectPath(key);
    const url = new URL(this.endpoint);
    url.pathname = `/${key.split("/").map(camSafeEncode).join("/")}`;
    return url;
  }
}

export async function mirrorDesktopReleaseToCos(options) {
  const {
    repo,
    tag,
    bucket,
    region,
    endpoint,
    prefix = DEFAULT_PREFIX,
    githubToken,
    assetDir,
    fetchImpl = fetch,
    githubApiBase = "https://api.github.com",
    log = console.log,
  } = options;
  validateRepo(repo);
  validateObjectPath(tag, "release tag");
  if (!assetDir) throw new Error("--asset-dir is required.");
  if (!githubToken) throw new Error("GH_TOKEN or GITHUB_TOKEN is required.");

  const files = await readLocalReleaseFiles(assetDir);
  await verifyChecksumManifest(files);
  const release = await readPublishedGitHubRelease({
    fetchImpl,
    githubApiBase,
    githubToken,
    repo,
    tag,
  });
  await verifyGithubReleaseAssets({
    allowExistingChecksumMarker: options.allowExistingChecksumMarker === true,
    fetchImpl,
    files,
    githubToken,
    release,
    repo,
    tag,
  });

  const credentials = options.credentials ?? await getTencentStsCredentials({
    audience: options.oidcAudience,
    durationSeconds: options.durationSeconds,
    endpoint: options.stsEndpoint,
    fetchImpl,
    providerId: options.providerId,
    region,
    requestToken: options.oidcRequestToken,
    requestUrl: options.oidcRequestUrl,
    roleArn: options.roleArn,
    roleSessionName: options.roleSessionName,
  });
  const mirror = new CosReleaseMirror({
    bucket,
    credentials,
    endpoint,
    fetchImpl,
    now: options.now,
    region,
  });
  const keys = [];
  for (const file of files) {
    const key = objectKeyForReleaseAsset(prefix, tag, file.name);
    await mirror.mirrorFile(key, file);
    keys.push(key);
    log(`verified\t${file.sha256}\tcos://${bucket}/${key}`);
  }
  await mirror.assertAnonymousAccessDenied(prefix);
  return {
    assets: files.length,
    prefix: [...validateObjectPath(prefix), ...validateObjectPath(tag)].join("/"),
  };
}

async function readPublishedGitHubRelease({ fetchImpl, githubApiBase, githubToken, repo, tag }) {
  const url = `${githubApiBase.replace(/\/$/, "")}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const response = await fetchImpl(url, {
    headers: githubHeaders(githubToken, "application/vnd.github+json"),
  });
  if (!response.ok) throw await httpError(`read GitHub Release ${repo}@${tag}`, response);
  const release = await response.json();
  if (release.draft) throw new Error(`GitHub Release ${repo}@${tag} is still a draft.`);
  if (!Array.isArray(release.assets) || release.assets.length === 0) {
    throw new Error(`GitHub Release ${repo}@${tag} has no published assets.`);
  }
  const names = new Set();
  for (const asset of release.assets) {
    if (!asset?.name || !asset?.url || !Number.isSafeInteger(asset.size) || asset.size < 0) {
      throw new Error(`GitHub Release ${repo}@${tag} returned invalid asset metadata.`);
    }
    if (asset.digest !== undefined && asset.digest !== null && !/^sha256:[0-9a-f]{64}$/i.test(asset.digest)) {
      throw new Error(`GitHub Release ${repo}@${tag} returned an invalid SHA-256 digest for ${asset.name}.`);
    }
    validateAssetName(asset.name);
    if (names.has(asset.name)) throw new Error(`Duplicate GitHub Release asset name: ${asset.name}`);
    names.add(asset.name);
  }
  return release;
}

async function readLocalReleaseFiles(assetDir) {
  const entries = await readdir(assetDir, { withFileTypes: true });
  const names = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  const invalid = names.filter((name) => !isAllowedAssetName(name));
  if (invalid.length > 0) {
    throw new Error(`Release directory contains non-allowlisted assets: ${invalid.join(", ")}.`);
  }
  if (!names.includes("SHASUMS256.txt")) throw new Error(`${assetDir} is missing SHASUMS256.txt.`);
  if (!names.some((name) => name.startsWith("Rudder-"))) {
    throw new Error(`${assetDir} has no Rudder release binaries.`);
  }
  return Promise.all(names.map((name) => describeFile(path.join(assetDir, name), name)));
}

async function verifyGithubReleaseAssets({
  allowExistingChecksumMarker,
  fetchImpl,
  files,
  githubToken,
  release,
  repo,
  tag,
}) {
  const localByName = new Map(files.map((file) => [file.name, file]));
  const requiredNames = files.map((file) => file.name).filter((name) => name !== "SHASUMS256.txt");
  const releaseByName = new Map(release.assets.map((asset) => [asset.name, asset]));
  const existingChecksumMarker = releaseByName.get("SHASUMS256.txt");
  if (existingChecksumMarker && !allowExistingChecksumMarker) {
    throw new Error(`GitHub Release ${repo}@${tag} exposed SHASUMS256.txt before the COS mirror completed.`);
  }
  if (existingChecksumMarker) {
    const localChecksum = localByName.get("SHASUMS256.txt");
    if (existingChecksumMarker.size !== localChecksum.size) {
      throw new Error(
        `GitHub Release checksum marker conflict: expected ${localChecksum.size} bytes, received ${existingChecksumMarker.size}.`,
      );
    }
    const checksumResponse = await fetchImpl(existingChecksumMarker.url, {
      headers: githubHeaders(githubToken, "application/octet-stream"),
      redirect: "follow",
    });
    if (!checksumResponse.ok || !checksumResponse.body) {
      throw await httpError("download GitHub Release asset SHASUMS256.txt", checksumResponse);
    }
    assertMatchingBytes(
      `GitHub Release ${repo}@${tag}/SHASUMS256.txt`,
      localChecksum,
      await hashResponse(checksumResponse),
      "GitHub Release asset",
    );
  }
  const releaseAssets = release.assets.filter((asset) => asset.name !== "SHASUMS256.txt");
  const unexpected = releaseAssets.map((asset) => asset.name).filter((name) => !localByName.has(name));
  const missing = requiredNames.filter((name) => !releaseByName.has(name));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `GitHub Release ${repo}@${tag} asset set differs from the local release set: missing ${missing.join(", ") || "<none>"}; unexpected ${unexpected.join(", ") || "<none>"}.`,
    );
  }
  for (const asset of releaseAssets) {
    const local = localByName.get(asset.name);
    if (asset.size !== local.size) {
      throw new Error(
        `GitHub Release asset conflict for ${asset.name}: expected ${local.size} bytes, received ${asset.size}.`,
      );
    }
    if (asset.digest) {
      const remoteSha256 = asset.digest.slice("sha256:".length).toLowerCase();
      if (remoteSha256 !== local.sha256) {
        throw new Error(
          `GitHub Release asset conflict for ${asset.name}: expected ${local.sha256}, received ${remoteSha256}.`,
        );
      }
      continue;
    }
    const response = await fetchImpl(asset.url, {
      headers: githubHeaders(githubToken, "application/octet-stream"),
      redirect: "follow",
    });
    if (!response.ok || !response.body) {
      throw await httpError(`download GitHub Release asset ${asset.name}`, response);
    }
    assertMatchingBytes(
      `GitHub Release ${repo}@${tag}/${asset.name}`,
      local,
      await hashResponse(response),
      "GitHub Release asset",
    );
  }
}

async function describeFile(filePath, name) {
  const [sha256, md5, fileStat] = await Promise.all([
    hashFile(filePath, "sha256", "hex"),
    hashFile(filePath, "md5", "base64"),
    stat(filePath),
  ]);
  return {
    contentType: contentTypeForAsset(name),
    md5,
    name,
    path: filePath,
    sha256,
    size: fileStat.size,
  };
}

async function hashFile(filePath, algorithm, encoding) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest(encoding);
}

async function hashResponse(response) {
  const digest = createHash("sha256");
  let size = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    digest.update(chunk);
    size += chunk.length;
  }
  return { sha256: digest.digest("hex"), size };
}

async function verifyChecksumManifest(files) {
  const checksumFile = files.find((file) => file.name === "SHASUMS256.txt");
  const text = await readFile(checksumFile.path, "utf8");
  const checksums = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (!match) throw new Error(`Invalid SHASUMS256.txt line: ${line}`);
    validateAssetName(match[2]);
    if (checksums.has(match[2])) throw new Error(`Duplicate SHASUMS256.txt entry: ${match[2]}.`);
    checksums.set(match[2], match[1].toLowerCase());
  }
  const binaries = files.filter((file) => file.name !== "SHASUMS256.txt");
  const unexpected = [...checksums.keys()].filter((name) => !binaries.some((file) => file.name === name));
  if (unexpected.length > 0) {
    throw new Error(`SHASUMS256.txt contains assets absent from the release directory: ${unexpected.join(", ")}.`);
  }
  for (const file of binaries) {
    const expected = checksums.get(file.name);
    if (!expected) throw new Error(`SHASUMS256.txt is missing ${file.name}.`);
    if (expected !== file.sha256) throw new Error(`GitHub asset ${file.name} does not match SHASUMS256.txt.`);
  }
}

function assertMatchingBytes(key, file, remote, kind = "COS object") {
  if (
    (remote.status !== undefined && remote.status !== 200) ||
    remote.size !== file.size ||
    remote.sha256 !== file.sha256
  ) {
    throw new Error(
      `Immutable ${kind} conflict for ${key}: expected ${file.sha256}/${file.size}, received ${remote.sha256 ?? "unknown"}/${remote.size ?? "unknown"}.`,
    );
  }
}

function githubHeaders(token, accept) {
  return {
    accept,
    authorization: `Bearer ${token}`,
    "user-agent": "rudder-release-cos-mirror",
    "x-github-api-version": "2022-11-28",
  };
}

function contentTypeForAsset(name) {
  if (name.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (name.endsWith(".zip")) return "application/zip";
  return "application/octet-stream";
}

function canonicalEntries(source, predicate = () => true) {
  const entries = source instanceof Headers || source instanceof URLSearchParams
    ? [...source.entries()]
    : Object.entries(source);
  return entries
    .map(([name, value]) => [name.toLowerCase(), String(value).trim()])
    .filter(([name]) => predicate(name))
    .sort(([left], [right]) => left.localeCompare(right));
}

function canonicalString(entries) {
  return entries.map(([name, value]) => `${camSafeEncode(name)}=${camSafeEncode(value)}`).join("&");
}

function camSafeEncode(value) {
  return encodeURIComponent(value)
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A");
}

function normalizeCosEndpoint(endpoint, bucket, region) {
  const url = new URL(endpoint || `https://${bucket}.cos.${region}.myqcloud.com`);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("COS_ENDPOINT must be an HTTPS Tencent COS endpoint.");
  }
  if (url.pathname !== "/" && url.pathname !== "") throw new Error("COS_ENDPOINT must not include a path.");
  const expectedHost = `${bucket}.cos.${region}.myqcloud.com`;
  if (url.hostname !== expectedHost) {
    throw new Error(`COS_ENDPOINT must use ${expectedHost}.`);
  }
  url.pathname = "/";
  return url.toString();
}

function normalizeStsEndpoint(endpoint) {
  const url = new URL(endpoint || DEFAULT_STS_ENDPOINT);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("TENCENT_STS_ENDPOINT must be HTTPS.");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("TENCENT_STS_ENDPOINT must not include a path.");
  }
  return url;
}

function validateBucket(bucket) {
  if (!bucket || !/^[a-z0-9][a-z0-9-]{1,48}-\d{5,20}$/.test(bucket)) {
    throw new Error("COS_BUCKET must include a valid Tencent COS bucket name and APPID suffix.");
  }
  return bucket;
}

function validateRegion(region) {
  if (!region || !/^[-a-z0-9]+$/.test(region)) throw new Error("COS_REGION is required and invalid.");
  return region;
}

function validateCredentials(credentials) {
  if (!credentials?.secretId || !credentials?.secretKey || !credentials?.token) {
    throw new Error("Tencent STS temporary SecretId, SecretKey, and Token are required.");
  }
  return credentials;
}

function validateObjectPath(value, label = "object path") {
  if (!value || value.startsWith("/") || value.endsWith("/") || /[\\?#]/.test(value)) {
    throw new Error(`Invalid ${label}: ${value || "<empty>"}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return segments;
}

function isAllowedAssetName(name) {
  return name === "SHASUMS256.txt" || (name.startsWith("Rudder-") && !/[\\/?#]/.test(name));
}

function validateAssetName(name) {
  if (!name || name === "." || name === ".." || !isAllowedAssetName(name)) {
    throw new Error(`Invalid or non-allowlisted release asset name: ${name || "<empty>"}`);
  }
}

function validateRepo(repo) {
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`Invalid GitHub repository: ${repo || "<empty>"}`);
  }
}

async function httpError(action, response) {
  let detail = "";
  try {
    detail = (await response.text()).trim().slice(0, 500);
  } catch {
    // The status is sufficient when a response body cannot be read.
  }
  return new Error(`${action} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
}

function parseArgs(argv, env) {
  const options = {
    assetDir: "",
    bucket: env.TENCENT_COS_BUCKET || env.COS_BUCKET,
    durationSeconds: Number(env.TENCENT_STS_DURATION_SECONDS || DEFAULT_STS_DURATION_SECONDS),
    endpoint: env.TENCENT_COS_ENDPOINT || env.COS_ENDPOINT,
    githubToken: env.GH_TOKEN || env.GITHUB_TOKEN,
    oidcAudience: env.TENCENT_OIDC_AUDIENCE || DEFAULT_OIDC_AUDIENCE,
    oidcRequestToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    oidcRequestUrl: env.ACTIONS_ID_TOKEN_REQUEST_URL,
    prefix: env.COS_PREFIX || DEFAULT_PREFIX,
    providerId: env.TENCENT_CLOUD_OIDC_PROVIDER_ID || env.TENCENT_OIDC_PROVIDER_ID,
    region: env.TENCENT_COS_REGION || env.COS_REGION,
    repo: env.GITHUB_REPOSITORY || "Undertone0809/rudder",
    roleArn: env.TENCENT_CLOUD_ROLE_ARN || env.TENCENT_ROLE_ARN,
    roleSessionName: env.TENCENT_ROLE_SESSION_NAME || `rudder-desktop-release-${env.GITHUB_RUN_ID || "local"}`,
    stsEndpoint: env.TENCENT_STS_ENDPOINT || DEFAULT_STS_ENDPOINT,
    tag: "",
    allowExistingChecksumMarker: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") options.repo = argv[++index];
    else if (arg === "--tag") options.tag = argv[++index];
    else if (arg === "--asset-dir") options.assetDir = argv[++index];
    else if (arg === "--bucket") options.bucket = argv[++index];
    else if (arg === "--region") options.region = argv[++index];
    else if (arg === "--endpoint") options.endpoint = argv[++index];
    else if (arg === "--prefix") options.prefix = argv[++index];
    else if (arg === "--provider-id") options.providerId = argv[++index];
    else if (arg === "--role-arn") options.roleArn = argv[++index];
    else if (arg === "--role-session-name") options.roleSessionName = argv[++index];
    else if (arg === "--duration-seconds") options.durationSeconds = Number(argv[++index]);
    else if (arg === "--allow-existing-checksum-marker") options.allowExistingChecksumMarker = true;
    else if (arg === "--help" || arg === "-h") return null;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!options.tag) throw new Error("--tag is required.");
  return options;
}

function usage() {
  console.error(
    "Usage: node scripts/mirror-desktop-release-to-cos.mjs --tag <tag> --asset-dir <dir> [--repo <owner/repo>] [--bucket <bucket-appid>] [--region <region>] [--endpoint <endpoint>] [--prefix <prefix>] [--provider-id <provider>] [--role-arn <arn>] [--role-session-name <name>] [--duration-seconds <seconds>] [--allow-existing-checksum-marker]",
  );
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2), process.env);
    if (!options) return usage();
    const result = await mirrorDesktopReleaseToCos(options);
    console.log(`ok\t${options.repo}@${options.tag}\tassets=${result.assets}\tprefix=${result.prefix}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    usage();
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
