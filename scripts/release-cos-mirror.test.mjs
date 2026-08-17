import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assumeTencentRoleWithWebIdentity,
  CosReleaseMirror,
  createCosAuthorization,
  exitCodeForMirrorError,
  getTencentStsCredentials,
  mirrorDesktopReleaseToCos,
  objectKeyForReleaseAsset,
  requestGitHubOidcToken,
  RetryableNetworkError,
} from "./mirror-desktop-release-to-cos.mjs";

const tempDirs = [];
const credentials = {
  secretId: "temporary-secret-id",
  secretKey: "temporary-secret-key",
  token: "temporary-security-token",
};
const bucket = "rudder-releases-1250000000";
const region = "ap-guangzhou";
const endpoint = `https://${bucket}.cos.${region}.myqcloud.com`;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("Tencent COS Desktop release mirror", () => {
  it("creates deterministic COS V5 signatures with temporary-token headers", () => {
    const headers = new Headers({
      "content-length": "14",
      "content-md5": "CY9rzUYh03PK3k6DJie09g==",
      "content-type": "application/zip",
      host: `${bucket}.cos.${region}.myqcloud.com`,
      "x-cos-forbid-overwrite": "true",
      "x-cos-meta-sha256": "deadbeef",
      "x-cos-security-token": "temporary-token",
    });
    expect(
      createCosAuthorization({
        headers,
        keyTime: "1700000000;1700000900",
        method: "PUT",
        pathname: "/releases/canary/v0.7.5-canary.1/Rudder-test.zip",
        secretId: "temporary-id",
        secretKey: "temporary-secret",
      }),
    ).toBe(
      "q-sign-algorithm=sha1&q-ak=temporary-id&q-sign-time=1700000000;1700000900&q-key-time=1700000000;1700000900&q-header-list=content-length;content-md5;content-type;host;x-cos-forbid-overwrite;x-cos-meta-sha256;x-cos-security-token&q-url-param-list=&q-signature=3d7da12e8616452ebf93e55de5f3173589c6c08e",
    );
  });

  it("uses slash-preserving tags and rejects unsafe or non-allowlisted paths", () => {
    expect(
      objectKeyForReleaseAsset(
        "releases",
        "canary/v0.7.5-canary.1",
        "Rudder-0.7.5-canary.1-linux-x64.AppImage",
      ),
    ).toBe("releases/canary/v0.7.5-canary.1/Rudder-0.7.5-canary.1-linux-x64.AppImage");
    expect(() => objectKeyForReleaseAsset("releases", "../v0.7.5", "Rudder.zip")).toThrow(
      "Invalid release tag",
    );
    expect(() => objectKeyForReleaseAsset("releases", "v0.7.5", "notes.txt")).toThrow(
      "non-allowlisted",
    );
    expect(() => objectKeyForReleaseAsset("releases", "v0.7.5?delete", "Rudder.zip")).toThrow(
      "Invalid release tag",
    );
  });

  it("requests GitHub OIDC then exchanges all required fields for Tencent STS credentials", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const requests = [];
    const result = await getTencentStsCredentials({
      durationSeconds: 1800,
      fetchImpl: async (input, init = {}) => {
        const url = new URL(input);
        requests.push({ init, url });
        if (url.hostname === "oidc.actions.test") {
          expect(url.searchParams.get("audience")).toBe("sts.cloud.tencent.com");
          expect(init.headers.authorization).toBe("Bearer oidc-request-token");
          return jsonResponse({ value: "github-oidc-jwt" });
        }
        expect(url.href).toBe("https://sts.tencentcloudapi.com/");
        expect(init.method).toBe("POST");
        expect(init.headers.authorization).toBe("SKIP");
        expect(init.headers["x-tc-action"]).toBe("AssumeRoleWithWebIdentity");
        expect(init.headers["x-tc-region"]).toBe(region);
        expect(init.headers["x-tc-version"]).toBe("2018-08-13");
        expect(init.headers["x-tc-timestamp"]).toBe("1700000000");
        expect(JSON.parse(init.body)).toEqual({
          DurationSeconds: 1800,
          ProviderId: "github-provider",
          RoleArn: "qcs::cam::uin/1250000000:roleName/rudder-release",
          RoleSessionName: "rudder-release-42",
          WebIdentityToken: "github-oidc-jwt",
        });
        return jsonResponse({
          Response: {
            Credentials: {
              TmpSecretId: "tmp-id",
              TmpSecretKey: "tmp-key",
              Token: "tmp-token",
            },
          },
        });
      },
      providerId: "github-provider",
      region,
      requestToken: "oidc-request-token",
      requestUrl: "https://oidc.actions.test/token?job=publish",
      roleArn: "qcs::cam::uin/1250000000:roleName/rudder-release",
      roleSessionName: "rudder-release-42",
    });
    expect(result).toEqual({ secretId: "tmp-id", secretKey: "tmp-key", token: "tmp-token" });
    expect(requests).toHaveLength(2);
  });

  it("retries transient OIDC and Tencent STS network failures", async () => {
    const attempts = new Map();
    const fetchImpl = async (input, init = {}) => {
      const url = new URL(input);
      const key = url.hostname;
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      if (attempt === 1) {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
        });
      }
      if (key === "oidc.actions.test") return jsonResponse({ value: "github-oidc-jwt" });
      expect(init.method).toBe("POST");
      return jsonResponse({
        Response: {
          Credentials: {
            TmpSecretId: "tmp-id",
            TmpSecretKey: "tmp-key",
            Token: "tmp-token",
          },
        },
      });
    };

    await expect(getTencentStsCredentials({
      networkRetries: 3,
      providerId: "github-provider",
      region,
      requestToken: "oidc-request-token",
      requestUrl: "https://oidc.actions.test/token?job=publish",
      retryDelayMs: 0,
      roleArn: "qcs::cam::uin/1250000000:roleName/rudder-release",
      roleSessionName: "rudder-release-42",
      sleep: async () => {},
      fetchImpl,
    })).resolves.toEqual({ secretId: "tmp-id", secretKey: "tmp-key", token: "tmp-token" });
    expect(attempts).toEqual(new Map([
      ["oidc.actions.test", 2],
      ["sts.tencentcloudapi.com", 2],
    ]));
  });

  it.each([
    ["AbortError", Object.assign(new Error("cancelled"), { name: "AbortError" })],
    ["arbitrary error", new Error("programming failure")],
    [
      "non-retryable fetch cause",
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("EINVAL"), { code: "EINVAL" }),
      }),
    ],
  ])("does not retry %s", async (_label, failure) => {
    let attempts = 0;
    await expect(
      requestGitHubOidcToken({
        fetchImpl: async () => {
          attempts += 1;
          throw failure;
        },
        networkRetries: 3,
        requestToken: "oidc-request-token",
        requestUrl: "https://oidc.actions.test/token",
        retryDelayMs: 0,
        sleep: async () => {},
      }),
    ).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });

  it("marks exhausted transient fetch failures for workflow-level retry", async () => {
    let attempts = 0;
    await expect(
      requestGitHubOidcToken({
        fetchImpl: async () => {
          attempts += 1;
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
          });
        },
        networkRetries: 3,
        requestToken: "oidc-request-token",
        requestUrl: "https://oidc.actions.test/token",
        retryDelayMs: 0,
        sleep: async () => {},
      }),
    ).rejects.toBeInstanceOf(RetryableNetworkError);
    expect(attempts).toBe(3);
  });

  it("maps a raw retryable COS fetch failure to the workflow retry exit code", async () => {
    const failure = new TypeError("fetch failed", {
      cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
    });
    const mirror = new CosReleaseMirror({
      bucket,
      credentials,
      fetchImpl: async () => {
        throw failure;
      },
      region,
    });

    let observed;
    try {
      await mirror.readObject("releases/v0.7.9/Rudder-test.zip", false);
    } catch (error) {
      observed = error;
    }

    expect(observed).toBe(failure);
    expect(exitCodeForMirrorError(observed)).toBe(75);
    expect(exitCodeForMirrorError(new Error("checksum conflict"))).toBe(1);
  });

  it("does not retry HTTP authorization failures", async () => {
    let attempts = 0;
    await expect(
      requestGitHubOidcToken({
        fetchImpl: async () => {
          attempts += 1;
          return new Response("forbidden", { status: 403 });
        },
        networkRetries: 3,
        requestToken: "oidc-request-token",
        requestUrl: "https://oidc.actions.test/token",
        retryDelayMs: 0,
        sleep: async () => {},
      }),
    ).rejects.toThrow("HTTP 403");
    expect(attempts).toBe(1);
  });

  it("rejects Tencent STS responses missing the temporary credential triplet", async () => {
    await expect(
      assumeTencentRoleWithWebIdentity({
        fetchImpl: async () => jsonResponse({ Response: { Credentials: { TmpSecretId: "only-id" } } }),
        providerId: "github-provider",
        region,
        roleArn: "role-arn",
        roleSessionName: "session",
        webIdentityToken: "jwt",
      }),
    ).rejects.toThrow("TmpSecretId, TmpSecretKey, and Token");
  });

  it("verifies GitHub binaries, mirrors all allowlisted assets, and proves anonymous policy bounds", async () => {
    const assetDir = await releaseFixture("desktop-binary");
    const binary = Buffer.from("desktop-binary");
    const checksum = checksumBytes();
    const objects = new Map();
    const methods = [];

    const fetchImpl = async (input, init = {}) => {
      const url = new URL(input);
      if (url.hostname === "api.github.test") {
        return jsonResponse({ assets: [githubAsset("Rudder-test.zip", binary)], draft: false });
      }
      if (url.hostname === "github-assets.test") return new Response(binary);
      const headers = new Headers(init.headers);
      const method = init.method || "GET";
      if (url.searchParams.has("prefix")) return new Response("denied", { status: 403 });
      const key = decodeURIComponent(url.pathname.slice(1));
      methods.push({ authorization: headers.get("authorization"), key, method });
      if (method === "PUT" && !headers.get("authorization")) {
        expect(headers.get("x-cos-forbid-overwrite")).toBe("true");
        expect(key).toMatch(/^releases\/\.rudder-anonymous-write-probe-1700000000000-\d+$/);
        expect(objects.has(key)).toBe(false);
        return new Response("denied", { status: 403 });
      }
      if (headers.get("authorization")) {
        expect(headers.get("authorization")).toContain("q-sign-algorithm=sha1");
        expect(headers.get("x-cos-security-token")).toBe(credentials.token);
      }
      if (method === "HEAD") {
        return new Response(null, { status: objects.has(key) ? 200 : 404 });
      }
      if (method === "PUT") {
        expect(headers.get("x-cos-forbid-overwrite")).toBe("true");
        expect(headers.get("x-cos-acl")).toBeNull();
        objects.set(key, await streamBytes(init.body));
        return new Response(null, { status: 200 });
      }
      const bytes = objects.get(key);
      return bytes ? new Response(bytes) : new Response(null, { status: 404 });
    };

    const result = await mirrorDesktopReleaseToCos({
      assetDir,
      bucket,
      credentials,
      endpoint,
      fetchImpl,
      githubApiBase: "https://api.github.test",
      githubToken: "github-token",
      log: () => {},
      now: () => 1_700_000_000_000,
      region,
      repo: "Undertone0809/rudder",
      tag: "canary/v0.7.5-canary.1",
    });

    expect(result).toEqual({ assets: 2, prefix: "releases/canary/v0.7.5-canary.1" });
    expect([...objects]).toEqual([
      ["releases/canary/v0.7.5-canary.1/Rudder-test.zip", binary],
      ["releases/canary/v0.7.5-canary.1/SHASUMS256.txt", checksum],
    ]);
    expect(methods.filter(({ method }) => method === "HEAD")).toHaveLength(2);
    expect(methods.filter(({ method, authorization }) => method === "PUT" && authorization)).toHaveLength(2);
    expect(methods.filter(({ method, authorization }) => method === "GET" && authorization)).toHaveLength(2);
    expect(methods.filter(({ method, authorization }) => method === "GET" && !authorization)).toHaveLength(2);
    expect(
      methods.filter(({ method, authorization, key }) =>
        method === "PUT" && !authorization && key.includes(".rudder-anonymous-write-probe-"),
      ),
    ).toHaveLength(1);
  });

  it("uses GitHub asset digests without re-downloading large release binaries", async () => {
    const assetDir = await releaseFixture("desktop-binary");
    const binary = Buffer.from("desktop-binary");
    const objects = new Map();
    let githubAssetDownloads = 0;
    const fetchImpl = async (input, init = {}) => {
      const url = new URL(input);
      if (url.hostname === "api.github.test") {
        return jsonResponse({
          assets: [githubAsset("Rudder-test.zip", binary, { digest: `sha256:${sha256(binary)}` })],
          draft: false,
        });
      }
      if (url.hostname === "github-assets.test") {
        githubAssetDownloads += 1;
        return new Response(binary);
      }
      if (url.searchParams.has("prefix")) return new Response("denied", { status: 403 });
      const headers = new Headers(init.headers);
      const key = decodeURIComponent(url.pathname.slice(1));
      if (init.method === "PUT" && !headers.get("authorization")) return new Response("denied", { status: 403 });
      if (init.method === "HEAD") return new Response(null, { status: objects.has(key) ? 200 : 404 });
      if (init.method === "PUT") {
        objects.set(key, await streamBytes(init.body));
        return new Response(null, { status: 200 });
      }
      return objects.has(key) ? new Response(objects.get(key)) : new Response(null, { status: 404 });
    };

    await expect(mirrorDesktopReleaseToCos({
      assetDir,
      bucket,
      credentials,
      endpoint,
      fetchImpl,
      githubApiBase: "https://api.github.test",
      githubToken: "github-token",
      log: () => {},
      now: () => 1_700_000_000_000,
      region,
      repo: "Undertone0809/rudder",
      tag: "v0.7.5",
    })).resolves.toEqual({ assets: 2, prefix: "releases/v0.7.5" });
    expect(githubAssetDownloads).toBe(0);
  });

  it("accepts a byte-identical existing GitHub checksum marker for an immutable retry", async () => {
    const assetDir = await releaseFixture("desktop-binary");
    const binary = Buffer.from("desktop-binary");
    const checksum = checksumBytes();
    const objects = new Map([
      ["releases/v0.7.5/Rudder-test.zip", binary],
      ["releases/v0.7.5/SHASUMS256.txt", checksum],
    ]);
    const fetchImpl = async (input, init = {}) => {
      const url = new URL(input);
      if (url.hostname === "api.github.test") {
        return jsonResponse({
          assets: [githubAsset("Rudder-test.zip", binary), githubAsset("SHASUMS256.txt", checksum)],
          draft: false,
        });
      }
      if (url.hostname === "github-assets.test") {
        return new Response(url.pathname.includes("SHASUMS256") ? checksum : binary);
      }
      const headers = new Headers(init.headers);
      if (url.searchParams.has("prefix")) return new Response("denied", { status: 403 });
      const key = decodeURIComponent(url.pathname.slice(1));
      if (init.method === "PUT" && !headers.get("authorization")) {
        return new Response("denied", { status: 403 });
      }
      if (init.method === "HEAD") return new Response(null, { status: objects.has(key) ? 200 : 404 });
      return new Response(objects.get(key) ?? null, { status: objects.has(key) ? 200 : 404 });
    };
    await expect(mirrorDesktopReleaseToCos({
      allowExistingChecksumMarker: true,
      assetDir,
      bucket,
      credentials,
      endpoint,
      fetchImpl,
      githubApiBase: "https://api.github.test",
      githubToken: "github-token",
      log: () => {},
      now: () => 1_700_000_000_000,
      region,
      repo: "Undertone0809/rudder",
      tag: "v0.7.5",
    })).resolves.toEqual({ assets: 2, prefix: "releases/v0.7.5" });
  });

  it("rejects a conflicting GitHub checksum marker before COS access", async () => {
    const assetDir = await releaseFixture("desktop-binary");
    const binary = Buffer.from("desktop-binary");
    const conflictingChecksum = Buffer.from("x".repeat(checksumBytes().length));
    let cosAccessed = false;
    await expect(mirrorDesktopReleaseToCos({
      allowExistingChecksumMarker: true,
      assetDir,
      bucket,
      credentials,
      endpoint,
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.hostname === "api.github.test") {
          return jsonResponse({
            assets: [githubAsset("Rudder-test.zip", binary), githubAsset("SHASUMS256.txt", conflictingChecksum)],
            draft: false,
          });
        }
        if (url.hostname === "github-assets.test") {
          return new Response(url.pathname.includes("SHASUMS256") ? conflictingChecksum : binary);
        }
        cosAccessed = true;
        throw new Error("COS must not be reached");
      },
      githubApiBase: "https://api.github.test",
      githubToken: "github-token",
      region,
      repo: "Undertone0809/rudder",
      tag: "v0.7.5",
    })).rejects.toThrow("Immutable GitHub Release asset conflict");
    expect(cosAccessed).toBe(false);
  });

  it("sets forbid-overwrite and accepts an identical object created by a racing retry", async () => {
    const file = await fileFixture("same bytes");
    let putCount = 0;
    let getCount = 0;
    const mirror = createMirror(async (_input, init = {}) => {
      const headers = new Headers(init.headers);
      if (init.method === "HEAD") return new Response(null, { status: 404 });
      if (init.method === "PUT") {
        putCount += 1;
        expect(headers.get("x-cos-forbid-overwrite")).toBe("true");
        return new Response("already exists", { status: 409 });
      }
      getCount += 1;
      return new Response("same bytes");
    });
    await mirror.mirrorFile("releases/v0.7.5/Rudder-test.zip", file);
    expect(putCount).toBe(1);
    expect(getCount).toBe(2);
  });

  it("accepts an identical existing object without uploading it again", async () => {
    const file = await fileFixture("same bytes");
    let putCount = 0;
    const mirror = createMirror(async (_input, init = {}) => {
      if (init.method === "PUT") putCount += 1;
      if (init.method === "HEAD") return new Response(null, { status: 200 });
      return new Response("same bytes");
    });
    await mirror.mirrorFile("releases/v0.7.5/Rudder-test.zip", file);
    expect(putCount).toBe(0);
  });

  it("uses resumable multipart uploads for large files and completes them immutably", async () => {
    const file = await fileFixture(Buffer.alloc(1024 * 1024, 7));
    const objectKey = "releases/v0.7.5/Rudder-test.zip";
    const objects = new Map();
    const parts = new Map();
    const partAttempts = new Map();
    const calls = [];
    const mirror = createMirror(async (input, init = {}) => {
      const url = new URL(input);
      const headers = new Headers(init.headers);
      const method = init.method || "GET";
      calls.push({ method, query: url.search, key: url.pathname.slice(1) });
      if (url.searchParams.has("prefix")) return new Response("denied", { status: 403 });
      if (method === "PUT" && !headers.get("authorization")) return new Response("denied", { status: 403 });
      if (method === "HEAD") return new Response(null, { status: objects.has(objectKey) ? 200 : 404 });
      if (url.searchParams.has("uploads")) {
        expect(method).toBe("POST");
        return new Response("<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>", { status: 200 });
      }
      if (url.searchParams.has("partNumber")) {
        expect(method).toBe("PUT");
        const partNumber = Number(url.searchParams.get("partNumber"));
        const attempt = (partAttempts.get(partNumber) ?? 0) + 1;
        partAttempts.set(partNumber, attempt);
        if (partNumber === 1 && attempt === 1) {
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("HeadersTimeoutError"), { code: "UND_ERR_HEADERS_TIMEOUT" }),
          });
        }
        if (partNumber === 1 && attempt === 2) {
          return new Response("<Code>UserNetworkTooSlow</Code>", { status: 400 });
        }
        parts.set(partNumber, await streamBytes(init.body));
        return new Response(null, { status: 200, headers: { etag: `"etag-${partNumber}"` } });
      }
      if (url.searchParams.has("uploadId")) {
        if (method === "POST") {
          const body = await streamBytes(init.body);
          expect(body.toString()).toContain("<ETag>&quot;etag-1&quot;</ETag>");
          objects.set(objectKey, parts.get(1));
          return new Response(null, { status: 200 });
        }
        expect(method).toBe("DELETE");
        return new Response(null, { status: 204 });
      }
      if (method === "GET") return objects.has(objectKey) ? new Response(objects.get(objectKey)) : new Response(null, { status: 404 });
      throw new Error(`Unexpected COS request: ${method} ${url}`);
    }, {
      multipartPartSize: 1024 * 1024,
      multipartThreshold: 1,
      sleep: async () => {},
    });

    await mirror.mirrorFile(objectKey, file);

    expect(objects.get(objectKey)).toEqual(Buffer.alloc(1024 * 1024, 7));
    expect(calls.filter(({ query }) => query.includes("partNumber=")).map(({ query }) => query)).toEqual([
      "?partNumber=1&uploadId=upload-1",
      "?partNumber=1&uploadId=upload-1",
      "?partNumber=1&uploadId=upload-1",
    ]);
    expect(partAttempts).toEqual(new Map([[1, 3]]));
  }, 15_000);

  it("uses a smaller default multipart part size for slow cross-region uploads", () => {
    const mirror = createMirror(async () => new Response(null));
    expect(mirror.multipartPartSize).toBe(1024 * 1024);
    expect(mirror.multipartConcurrency).toBe(4);
  });

  it("reuses a byte-identical object when multipart completion loses an overwrite race", async () => {
    const file = await fileFixture(Buffer.alloc(1024 * 1024, 3));
    const objectKey = "releases/v0.7.5/Rudder-test.zip";
    const objects = new Map([[objectKey, Buffer.alloc(1024 * 1024, 3)]]);
    let abortCount = 0;
    const mirror = createMirror(async (input, init = {}) => {
      const url = new URL(input);
      const method = init.method || "GET";
      if (method === "HEAD") return new Response(null, { status: 404 });
      if (url.searchParams.has("uploads")) return new Response("<UploadId>upload-race</UploadId>", { status: 200 });
      if (url.searchParams.has("partNumber")) return new Response(null, { status: 200, headers: { etag: '"etag-1"' } });
      if (url.searchParams.has("uploadId") && method === "POST") return new Response("race", { status: 412 });
      if (url.searchParams.has("uploadId") && method === "DELETE") {
        abortCount += 1;
        return new Response(null, { status: 204 });
      }
      if (method === "GET") return new Response(objects.get(objectKey));
      throw new Error(`Unexpected COS request: ${method} ${url}`);
    }, {
      multipartPartSize: 1024 * 1024,
      multipartThreshold: 1,
      sleep: async () => {},
    });

    await expect(mirror.mirrorFile(objectKey, file)).resolves.toBeUndefined();
    expect(abortCount).toBe(1);
  });

  it("aborts a multipart upload after a non-retryable part failure", async () => {
    const file = await fileFixture(Buffer.alloc(1024 * 1024, 4));
    let abortCount = 0;
    const mirror = createMirror(async (input, init = {}) => {
      const url = new URL(input);
      const method = init.method || "GET";
      if (method === "HEAD") return new Response(null, { status: 404 });
      if (url.searchParams.has("uploads")) return new Response("<UploadId>upload-fail</UploadId>", { status: 200 });
      if (url.searchParams.has("partNumber")) return new Response("denied", { status: 403 });
      if (url.searchParams.has("uploadId") && method === "DELETE") {
        abortCount += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected COS request: ${method} ${url}`);
    }, {
      multipartPartSize: 1024 * 1024,
      multipartThreshold: 1,
      sleep: async () => {},
    });

    await expect(mirror.mirrorFile("releases/v0.7.5/Rudder-test.zip", file)).rejects.toThrow(
      "upload COS multipart part 1",
    );
    expect(abortCount).toBe(1);
  });

  it("does not retry a deterministic multipart request failure", async () => {
    const file = await fileFixture(Buffer.alloc(1024 * 1024, 5));
    const failure = new Error("multipart programming failure");
    let abortCount = 0;
    let partAttempts = 0;
    const mirror = createMirror(async (input, init = {}) => {
      const url = new URL(input);
      const method = init.method || "GET";
      if (method === "HEAD") return new Response(null, { status: 404 });
      if (url.searchParams.has("uploads")) return new Response("<UploadId>upload-fail</UploadId>", { status: 200 });
      if (url.searchParams.has("partNumber")) {
        partAttempts += 1;
        throw failure;
      }
      if (url.searchParams.has("uploadId") && method === "DELETE") {
        abortCount += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected COS request: ${method} ${url}`);
    }, {
      multipartPartSize: 1024 * 1024,
      multipartThreshold: 1,
      sleep: async () => {},
    });

    await expect(mirror.mirrorFile("releases/v0.7.5/Rudder-test.zip", file)).rejects.toBe(failure);
    expect(partAttempts).toBe(1);
    expect(abortCount).toBe(1);
  });

  it("prioritizes deterministic concurrent failures and stops scheduling new parts", async () => {
    const file = await fileFixture(Buffer.alloc(4 * 1024 * 1024, 6));
    const deterministicFailure = new Error("multipart programming failure");
    const networkFailure = new RetryableNetworkError("multipart network failure");
    const scheduledParts = [];
    let abortCount = 0;
    let deterministicStarted;
    const deterministicStart = new Promise((resolve) => {
      deterministicStarted = resolve;
    });
    const mirror = createMirror(async (input, init = {}) => {
      const url = new URL(input);
      const method = init.method || "GET";
      if (method === "HEAD") return new Response(null, { status: 404 });
      if (url.searchParams.has("uploads")) return new Response("<UploadId>upload-mixed</UploadId>", { status: 200 });
      if (url.searchParams.has("uploadId") && method === "DELETE") {
        abortCount += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected COS request: ${method} ${url}`);
    }, {
      multipartConcurrency: 2,
      multipartPartSize: 1024 * 1024,
      multipartThreshold: 1,
      sleep: async () => {},
    });
    mirror.uploadMultipartPart = async (_key, _uploadId, partNumber) => {
      scheduledParts.push(partNumber);
      if (partNumber === 1) {
        await deterministicStart;
        throw networkFailure;
      }
      deterministicStarted();
      throw deterministicFailure;
    };

    let observed;
    try {
      await mirror.mirrorFile("releases/v0.7.5/Rudder-test.zip", file);
    } catch (error) {
      observed = error;
    }

    expect(observed).toBe(deterministicFailure);
    expect(exitCodeForMirrorError(observed)).toBe(1);
    expect(scheduledParts).toEqual([1, 2]);
    expect(abortCount).toBe(1);
  });

  it("stops scheduling new parts after a concurrent short read", async () => {
    const file = await fileFixture(Buffer.alloc(4 * 1024 * 1024, 7));
    await writeFile(file.path, Buffer.alloc(1024 * 1024, 7));
    const uploadedParts = [];
    let abortCount = 0;
    const mirror = createMirror(async (input, init = {}) => {
      const url = new URL(input);
      const method = init.method || "GET";
      if (method === "HEAD") return new Response(null, { status: 404 });
      if (url.searchParams.has("uploads")) return new Response("<UploadId>upload-short-read</UploadId>", { status: 200 });
      if (url.searchParams.has("uploadId") && method === "DELETE") {
        abortCount += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected COS request: ${method} ${url}`);
    }, {
      multipartConcurrency: 2,
      multipartPartSize: 1024 * 1024,
      multipartThreshold: 1,
      sleep: async () => {},
    });
    mirror.uploadMultipartPart = async (_key, _uploadId, partNumber) => {
      uploadedParts.push(partNumber);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return `"etag-${partNumber}"`;
    };

    await expect(mirror.mirrorFile("releases/v0.7.5/Rudder-test.zip", file)).rejects.toThrow(
      "Read 0 bytes for COS multipart part 2; expected 1048576.",
    );
    expect(uploadedParts).toEqual([1]);
    expect(abortCount).toBe(1);
  });

  it("explains that COS HEAD checks require the distinct HeadObject action", async () => {
    const file = await fileFixture("missing permission");
    const mirror = createMirror(async (_input, init = {}) => {
      if (init.method === "HEAD") return new Response(null, { status: 403 });
      throw new Error("unexpected request after denied HEAD");
    });

    await expect(mirror.mirrorFile("releases/v0.7.5/Rudder-test.zip", file)).rejects.toThrow(
      "name/cos:HeadObject CAM action",
    );
  });

  it("fails when an immutable COS key contains conflicting bytes", async () => {
    const file = await fileFixture("expected bytes");
    const mirror = createMirror(async (_input, init = {}) => {
      if (init.method === "HEAD") return new Response(null, { status: 200 });
      return new Response("different bytes");
    });
    await expect(mirror.mirrorFile("releases/v0.7.5/Rudder-test.zip", file)).rejects.toThrow(
      "Immutable COS object conflict",
    );
  });

  it("rejects local bytes that do not match SHASUMS256.txt before network access", async () => {
    const assetDir = await releaseFixture("unexpected-binary");
    await writeFile(
      path.join(assetDir, "SHASUMS256.txt"),
      `${sha256(Buffer.from("expected-binary"))}  Rudder-test.zip\n`,
    );
    await expect(
      mirrorDesktopReleaseToCos({
        assetDir,
        bucket,
        credentials,
        endpoint,
        fetchImpl: async () => {
          throw new Error("network must not be reached");
        },
        githubToken: "github-token",
        region,
        repo: "Undertone0809/rudder",
        tag: "v0.7.5",
      }),
    ).rejects.toThrow("does not match SHASUMS256.txt");
  });
});

function createMirror(fetchImpl, options = {}) {
  return new CosReleaseMirror({
    bucket,
    credentials,
    endpoint,
    fetchImpl,
    ...options,
    now: () => 1_700_000_000_000,
    region,
  });
}

async function releaseFixture(binaryText) {
  const dir = await makeTempDir();
  const binary = Buffer.from(binaryText);
  await writeFile(path.join(dir, "Rudder-test.zip"), binary);
  await writeFile(path.join(dir, "SHASUMS256.txt"), `${sha256(binary)}  Rudder-test.zip\n`);
  return dir;
}

function checksumBytes() {
  return Buffer.from(`${sha256(Buffer.from("desktop-binary"))}  Rudder-test.zip\n`);
}

async function fileFixture(text) {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "Rudder-test.zip");
  const bytes = Buffer.from(text);
  await writeFile(filePath, bytes);
  return {
    contentType: "application/zip",
    md5: createHash("md5").update(bytes).digest("base64"),
    name: "Rudder-test.zip",
    path: filePath,
    sha256: sha256(bytes),
    size: bytes.length,
  };
}

async function makeTempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "rudder-cos-mirror-test."));
  tempDirs.push(dir);
  return dir;
}

function githubAsset(name, bytes, { digest } = {}) {
  return {
    ...(digest ? { digest } : {}),
    name,
    size: bytes.length,
    url: `https://github-assets.test/${encodeURIComponent(name)}`,
  };
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

async function streamBytes(stream) {
  if (Buffer.isBuffer(stream)) return stream;
  if (typeof stream === "string") return Buffer.from(stream);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
