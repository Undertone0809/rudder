import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const gaSource = await readFile(new URL("../docs/ga.js", import.meta.url), "utf8");
const vercelConfig = JSON.parse(
  await readFile(new URL("../docs/vercel.production.redirects.json", import.meta.url), "utf8"),
);

function runDocsAnalytics({
  url = "https://docs.rudderhq.dev/get-started/quickstart?utm_source=rollout_check&utm_medium=qa&utm_campaign=dup1&utm_campaign=dup2&secret=sk-test1234567890abcdef#priv",
  referrer = "https://news.ycombinator.com/item?id=123",
  umamiDisabled = null,
  doNotTrack = undefined,
  globalPrivacyControl = false,
} = {}) {
  const scripts = [];
  const umamiPayloads = [];
  const fetchCalls = [];
  const winListeners = new Map();
  const storage = new Map();
  if (umamiDisabled !== null) storage.set("umami.disabled", umamiDisabled);

  const parsedUrl = new URL(url);
  const window = {
    location: {
      href: parsedUrl.href,
      origin: parsedUrl.origin,
      hostname: parsedUrl.hostname,
      pathname: parsedUrl.pathname,
      search: parsedUrl.search,
      hash: parsedUrl.hash,
    },
    screen: { width: 1440, height: 900 },
    localStorage: {
      getItem: (k) => storage.get(k) ?? null,
    },
    performance: {
      getEntriesByType: (t) => (t === "navigation" ? [{ responseStart: 140 }] : []),
    },
    setTimeout: (fn) => fn(),
    addEventListener: (type, fn) => winListeners.set(type, fn),
    fetch: async (reqUrl, init) => {
      fetchCalls.push({ reqUrl, init });
      return new Response(null, { status: 200 });
    },
  };
  const document = {
    title: "Untrusted Dynamic Docs Title",
    referrer,
    visibilityState: "visible",
    head: { appendChild: (el) => scripts.push(el) },
    createElement: () => {
      const listeners = new Map();
      return {
        dataset: {},
        addEventListener: (type, fn) => listeners.set(type, fn),
        dispatchLoad: () => listeners.get("load")?.(),
      };
    },
    addEventListener: () => {},
  };
  const navigator = { language: "en-US", doNotTrack, globalPrivacyControl };
  const history = { pushState() {}, replaceState() {} };

  vm.runInNewContext(gaSource, {
    window,
    document,
    navigator,
    history,
    URL,
    Response,
    crypto: globalThis.crypto,
    Element: class {},
  });

  window.umami = {
    track(fn) {
      const res = typeof fn === "function" ? fn({ screen: "1440x900", language: "en-US", referrer }) : fn;
      umamiPayloads.push(JSON.parse(JSON.stringify(res)));
    },
  };

  return { window, scripts, umamiPayloads, fetchCalls, winListeners };
}

test("docs vercel config proxies /u/s.js and /u/api/send same-origin with strict-origin Referrer-Policy", () => {
  assert.deepEqual(vercelConfig.rewrites, [
    { source: "/u/s.js", destination: "https://umami.foundria.dev/script.js" },
    { source: "/u/api/send", destination: "https://umami.foundria.dev/api/send" },
  ]);
  assert.ok(
    vercelConfig.headers.some((h) =>
      h.headers.some((pair) => pair.key === "Referrer-Policy" && pair.value === "strict-origin"),
    ),
  );
  assert.ok(gaSource.includes("__RUDDER_GA_MEASUREMENT_ID__"));
});

test("docs Umami loads same-origin /u/s.js, enforces strict 6-key UTM, static titles, and external origin referrer", () => {
  const { scripts, umamiPayloads } = runDocsAnalytics();
  assert.equal(scripts.length, 1);
  const script = scripts[0];
  assert.equal(script.src, "/u/s.js");
  assert.equal(script.dataset.hostUrl, "/u");
  assert.equal(script.dataset.websiteId, "5e86d3bf-9ddc-46a0-93e0-5441be8a5df4");
  assert.equal(script.dataset.autoTrack, "false");
  assert.equal(script.dataset.doNotTrack, "true");
  assert.equal(script.dataset.excludeHash, "true");
  assert.equal(script.dataset.fetchCredentials, "omit");
  assert.equal(script.dataset.beforeSend, "__rudderDocsUmamiBeforeSend");
  assert.equal(script.referrerPolicy, "strict-origin");

  script.dispatchLoad();
  assert.deepEqual(umamiPayloads, [
    {
      website: "5e86d3bf-9ddc-46a0-93e0-5441be8a5df4",
      hostname: "docs.rudderhq.dev",
      url: "/get-started/quickstart?utm_source=rollout_check&utm_medium=qa",
      title: "Rudder Docs",
      referrer: "https://news.ycombinator.com",
      screen: "1440x900",
      language: "en-US",
    },
  ]);
});

test("docs Umami respects umami.disabled / DNT / GPC and guards fetch with valid 204 null response", async () => {
  for (const opts of [
    { umamiDisabled: "1" },
    { doNotTrack: "1" },
    { globalPrivacyControl: true },
  ]) {
    const { window, scripts, fetchCalls } = runDocsAnalytics(opts);
    assert.equal(scripts.length, 0);
    assert.equal(window.__rudderDocsUmamiBeforeSend("event", { url: "/" }), false);
    const res = await window.fetch("/u/api/send", { method: "POST", body: "{}" });
    assert.equal(res.status, 204);
    assert.equal(await res.text(), "");
    assert.equal(fetchCalls.length, 0);
  }
});

test("docs Umami emits independent numeric performance and closed-enum scrubbed errors", () => {
  const { winListeners, fetchCalls } = runDocsAnalytics({ url: "https://docs.rudderhq.dev/zh/get-started/quickstart" });
  winListeners.get("pagehide")?.();
  winListeners.get("error")?.({ error: new TypeError("Sensitive stack trace") });

  const perfReq = fetchCalls.find((c) => JSON.parse(c.init.body).type === "performance");
  const errReq = fetchCalls.find((c) => JSON.parse(c.init.body).type === "error");
  assert.ok(perfReq);
  assert.equal(perfReq.init.credentials, "omit");
  assert.deepEqual(JSON.parse(perfReq.init.body).payload, {
    website: "5e86d3bf-9ddc-46a0-93e0-5441be8a5df4",
    hostname: "docs.rudderhq.dev",
    url: "/zh/get-started/quickstart",
    title: "Rudder 文档",
    screen: "1440x900",
    language: "en-US",
    ttfb: 140,
  });
  assert.ok(errReq);
  assert.equal(JSON.parse(errReq.init.body).payload.name, "TypeError");
  assert.equal(JSON.parse(errReq.init.body).payload.message, "");
  assert.doesNotMatch(errReq.init.body, /Sensitive/);
});
