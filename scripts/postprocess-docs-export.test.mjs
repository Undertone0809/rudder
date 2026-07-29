import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertDocumentMetadata,
  staticVerificationChecks,
  verifyStaticDocs,
} from "./verify-docs-static-export.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts/postprocess-docs-export.mjs");

function writePage(exportDir, route, body) {
  const relativePath = route === "/" ? "index.html" : `${route.slice(1)}/index.html`;
  const filePath = path.join(exportDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body);
  return filePath;
}

function fixturePage(markdownHref, footer = "", language = "en") {
  return [
    `<!doctype html><html lang="${language}"><head>`,
    '<link rel="alternate" type="application/xml" href="/sitemap.xml"/>',
    `<link rel="alternate" type="text/markdown" href="${markdownHref}"/>`,
    '<meta property="og:image" content="https://mintlify.example/generated-card.png"/>',
    '<meta name="twitter:image" content="https://mintlify.example/generated-card.png"/>',
    "</head><body>",
    `<footer id="footer">${footer}</footer>`,
    "</body></html>",
  ].join("");
}

test("postprocesses paired English and Simplified Chinese export pages", () => {
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-docs-export-"));
  const runtimeChunkPath = path.join(exportDir, "_next/static/chunks/runtime.js");
  fs.mkdirSync(path.dirname(runtimeChunkPath), { recursive: true });
  fs.writeFileSync(
    runtimeChunkPath,
    'const runtime={ENV:"cli"};let o=false;o||(console.warn("Connected to Socket.io"),connect());let i=false;i||(console.warn("Connected to Socket.io"),connect());',
  );
  const englishFooter = [
    "<h3>Docs</h3>",
    '<a href="/get-started/installation">Quick Start</a>',
    "<h3>Product</h3>",
    '<a href="/concepts/built-in-browser">Built-in Browser</a>',
    '<a href="/concepts/calendar">Calendar</a>',
    "<h3>Project</h3>",
    '<a href="/contact">Contact</a>',
    '<a href="/releases">Changelog</a>',
    '<script>self.__next_f.push([1,"\\\"footer\\\":{\\\"links\\\":[{\\\"header\\\":\\\"Docs\\\",\\\"items\\\":[{\\\"label\\\":\\\"Quick Start\\\",\\\"href\\\":\\\"/get-started/installation\\\"}]},{\\\"header\\\":\\\"Product\\\",\\\"items\\\":[{\\\"label\\\":\\\"Built-in Browser\\\",\\\"href\\\":\\\"/concepts/built-in-browser\\\"},{\\\"label\\\":\\\"Calendar\\\",\\\"href\\\":\\\"/concepts/calendar\\\"}]},{\\\"header\\\":\\\"Project\\\",\\\"items\\\":[{\\\"label\\\":\\\"Contact\\\",\\\"href\\\":\\\"/contact\\\"},{\\\"label\\\":\\\"Changelog\\\",\\\"href\\\":\\\"/releases\\\"}]}]}"])</script>',
  ].join("");
  const chineseFooter = [
    "<h3>文档</h3>",
    '<a href="/zh/get-started/installation">快速开始</a>',
    "<h3>产品</h3>",
    '<a href="/zh/concepts/built-in-browser">内置浏览器</a>',
    '<a href="/zh/concepts/calendar">日历</a>',
    "<h3>项目</h3>",
    '<a href="/zh/contact">联系方式</a>',
    '<a href="/zh/releases">更新日志</a>',
    '<script>self.__next_f.push([1,"\\\"footer\\\":{\\\"links\\\":[{\\\"header\\\":\\\"文档\\\",\\\"items\\\":[{\\\"label\\\":\\\"快速开始\\\",\\\"href\\\":\\\"/zh/get-started/installation\\\"}]},{\\\"header\\\":\\\"产品\\\",\\\"items\\\":[{\\\"label\\\":\\\"内置浏览器\\\",\\\"href\\\":\\\"/zh/concepts/built-in-browser\\\"},{\\\"label\\\":\\\"日历\\\",\\\"href\\\":\\\"/zh/concepts/calendar\\\"}]},{\\\"header\\\":\\\"项目\\\",\\\"items\\\":[{\\\"label\\\":\\\"联系方式\\\",\\\"href\\\":\\\"/zh/contact\\\"},{\\\"label\\\":\\\"更新日志\\\",\\\"href\\\":\\\"/zh/releases\\\"}]}]}"])</script>',
  ].join("");

  const englishPath = writePage(exportDir, "/", fixturePage("/index.md", englishFooter));
  const chinesePath = writePage(exportDir, "/zh", fixturePage("/zh.md", chineseFooter, "cn"));
  const englishGuidePath = writePage(
    exportDir,
    "/get-started/installation",
    fixturePage("/get-started/installation.md"),
  );
  const chineseGuidePath = writePage(
    exportDir,
    "/zh/get-started/installation",
    fixturePage("/zh/get-started/installation.md", chineseFooter, "cn"),
  );
  const unpairedPath = writePage(
    exportDir,
    "/benchmarks/gdpval-harness",
    fixturePage("/benchmarks/gdpval-harness.md"),
  );

  const result = spawnSync(process.execPath, [SCRIPT_PATH, exportDir], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const repeatedResult = spawnSync(process.execPath, [SCRIPT_PATH, exportDir], { encoding: "utf8" });
  assert.equal(repeatedResult.status, 0, repeatedResult.stderr);

  const english = fs.readFileSync(englishPath, "utf8");
  const chinese = fs.readFileSync(chinesePath, "utf8");
  const englishGuide = fs.readFileSync(englishGuidePath, "utf8");
  const chineseGuide = fs.readFileSync(chineseGuidePath, "utf8");
  const unpaired = fs.readFileSync(unpairedPath, "utf8");
  const runtimeChunk = fs.readFileSync(runtimeChunkPath, "utf8");

  for (const html of [english, chinese, englishGuide, chineseGuide, unpaired]) {
    assert.doesNotMatch(html, /<link\b[^>]*type="text\/markdown"/);
    assert.match(html, /data-rudder-seo-guard/);
    assert.match(html, /MutationObserver/);
    assert.match(html, /link\[rel="alternate"\]\[type="text\/markdown"\]/);
    assert.match(
      html,
      /<meta property="og:image" content="https:\/\/docs\.rudderhq\.dev\/images\/rudder-social-card\.png"\/>/,
    );
    assert.match(html, /<meta property="og:image:type" content="image\/png"\/>/);
    assert.match(html, /<meta property="og:image:width" content="1200"\/>/);
    assert.match(html, /<meta property="og:image:height" content="630"\/>/);
    assert.match(
      html,
      /<meta property="og:image:alt" content="Rudder - Build your self-improving Agent Team\."\/>/,
    );
    assert.match(html, /<meta name="twitter:card" content="summary_large_image"\/>/);
    assert.match(
      html,
      /<meta name="twitter:image" content="https:\/\/docs\.rudderhq\.dev\/images\/rudder-social-card\.png"\/>/,
    );
    assert.match(html, /setMeta\("property","og:image"/);
    assert.match(html, /setMeta\("name","twitter:image"/);
    assert.match(html, /attributeFilter:\["content","name","property"\]/);
    assert.doesNotMatch(html, /mintlify\.example\/generated-card\.png/);
    assert.equal((html.match(/<meta property="og:image"/g) ?? []).length, 1);
    assert.equal((html.match(/<meta name="twitter:image"/g) ?? []).length, 1);
  }

  assert.match(english, /<html lang="en">/);
  assert.match(chinese, /<html lang="cn">/);
  assert.doesNotMatch(chinese, /document\.documentElement\.lang/);
  assert.match(englishGuide, /hreflang="zh-CN" href="https:\/\/docs\.rudderhq\.dev\/zh\/get-started\/installation"/);
  assert.match(chineseGuide, /hreflang="en" href="https:\/\/docs\.rudderhq\.dev\/get-started\/installation"/);
  assert.match(chineseGuide, /hreflang="x-default" href="https:\/\/docs\.rudderhq\.dev\/get-started\/installation"/);
  assert.doesNotMatch(unpaired, /hreflang=/);

  assert.match(chinese, />文档<.*>产品<.*>项目</s);
  assert.match(chinese, /href="\/zh\/get-started\/installation">快速开始/);
  assert.match(chinese, /href="\/zh\/concepts\/built-in-browser">内置浏览器/);
  assert.match(chinese, /href="\/zh\/concepts\/calendar">日历/);
  assert.match(chinese, /href="\/zh\/contact">联系方式/);
  assert.match(chinese, /href="\/zh\/releases">更新日志/);
  assert.match(chinese, /\\"label\\":\\"快速开始\\",\\"href\\":\\"\/zh\/get-started\/installation\\"/);
  assert.match(chinese, /\\"header\\":\\"文档\\"/);
  assert.match(chinese, /\\"header\\":\\"产品\\"/);
  assert.match(chinese, /\\"header\\":\\"项目\\"/);
  assert.match(chinese, /\\"label\\":\\"内置浏览器\\",\\"href\\":\\"\/zh\/concepts\/built-in-browser\\"/);
  assert.match(chinese, /\\"label\\":\\"日历\\",\\"href\\":\\"\/zh\/concepts\/calendar\\"/);
  assert.match(chinese, /\\"label\\":\\"联系方式\\",\\"href\\":\\"\/zh\/contact\\"/);
  assert.match(chinese, /\\"label\\":\\"更新日志\\",\\"href\\":\\"\/zh\/releases\\"/);
  assert.match(runtimeChunk, /ENV:"production"/);
  assert.doesNotMatch(runtimeChunk, /ENV:"cli"/);
  assert.match(runtimeChunk, /o\|\|true\|\|\(console\.warn\("Connected to Socket\.io"\)/);
  assert.match(runtimeChunk, /i\|\|true\|\|\(console\.warn\("Connected to Socket\.io"\)/);
  assert.doesNotMatch(
    runtimeChunk,
    /(?<![\w$|])[A-Za-z_$][\w$]*\|\|\(console\.warn\("Connected to Socket\.io"\)/,
  );
});

test("adds a self-contained search index and runtime to the static export", () => {
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-docs-search-export-"));
  const englishPath = writePage(
    exportDir,
    "/concepts/agents",
    [
      '<!doctype html><html lang="en"><head>',
      '<meta name="description" content="Durable AI team members."/>',
      "</head><body><main>",
      "<h1>Agents</h1>",
      "<p>Agents have explicit roles, runtime configuration, budgets, and skills.</p>",
      "<h2>Runtime model</h2>",
      "</main></body></html>",
    ].join(""),
  );
  const chinesePath = writePage(
    exportDir,
    "/zh/concepts/agents",
    [
      '<!doctype html><html lang="zh-CN"><head>',
      '<meta name="description" content="Rudder 里的 agent 团队成员。"/>',
      "</head><body><main>",
      "<h1>Agents</h1>",
      "<p>Agent 有自己的角色、运行时、预算、技能和能力边界。</p>",
      "<h2>运行时模型</h2>",
      "</main></body></html>",
    ].join(""),
  );

  const result = spawnSync(process.execPath, [SCRIPT_PATH, exportDir], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const searchIndex = JSON.parse(
    fs.readFileSync(path.join(exportDir, "rudder-search-index.json"), "utf8"),
  );
  assert.deepEqual(searchIndex, [
    {
      content: "Agents Agents have explicit roles, runtime configuration, budgets, and skills. Runtime model",
      description: "Durable AI team members.",
      headings: ["Runtime model"],
      language: "en",
      path: "/concepts/agents",
      title: "Agents",
    },
    {
      content: "Agents Agent 有自己的角色、运行时、预算、技能和能力边界。 运行时模型",
      description: "Rudder 里的 agent 团队成员。",
      headings: ["运行时模型"],
      language: "zh-CN",
      path: "/zh/concepts/agents",
      title: "Agents",
    },
  ]);
  assert.equal(
    fs.readFileSync(path.join(exportDir, "rudder-search.js"), "utf8"),
    fs.readFileSync(path.join(REPO_ROOT, "scripts/docs-static-search.js"), "utf8"),
  );

  for (const filePath of [englishPath, chinesePath]) {
    const html = fs.readFileSync(filePath, "utf8");
    assert.match(html, /<script src="\/rudder-search\.js" defer data-rudder-search><\/script>/);
    assert.equal((html.match(/data-rudder-search/g) ?? []).length, 1);
  }
});

test("Simplified Chinese reference pages use localized titles", () => {
  const referenceDir = path.join(REPO_ROOT, "docs/zh/reference");
  for (const filename of fs.readdirSync(referenceDir).filter((name) => name.endsWith(".mdx"))) {
    const source = fs.readFileSync(path.join(referenceDir, filename), "utf8");
    const title = source.match(/^title:\s*["']?([^"'\n]+)["']?$/m)?.[1];
    assert.ok(title, `${filename} must declare a title`);
    assert.match(title, /[\u3400-\u9fff]/, `${filename} title must be localized`);
  }
});

test("docs config declares the shared social preview image", () => {
  const config = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "docs/docs.json"), "utf8"));
  assert.equal(config.seo.metatags["og:image"], "https://docs.rudderhq.dev/images/rudder-social-card.png");
  assert.equal(config.seo.metatags["og:image:width"], "1200");
  assert.equal(config.seo.metatags["og:image:height"], "630");
  assert.equal(config.seo.metatags["twitter:card"], "summary_large_image");
  assert.equal(config.seo.metatags["twitter:image"], "https://docs.rudderhq.dev/images/rudder-social-card.png");
  assert.deepEqual(
    config.navigation.languages.map(({ language }) => language),
    ["en", "cn"],
  );
});

test("staging and production workflows postprocess exported docs", () => {
  for (const workflow of ["docs-staging.yml", "docs-production.yml"]) {
    const source = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows", workflow), "utf8");
    assert.match(
      source,
      /node scripts\/postprocess-docs-export\.mjs "\$RUNNER_TEMP\/rudder-docs-export"/,
      `${workflow} must postprocess the static export before deployment`,
    );
  }
});

test("static acceptance checks cover every canonical route and generated active alias", () => {
  const checks = staticVerificationChecks();
  assert.equal(checks.canonical.length, 66);
  assert.ok(checks.aliases.length > 27);
  assert.ok(checks.canonical.some((entry) => entry.route === "/benchmarks/gdpval-harness"));
  assert.ok(checks.canonical.some((entry) => entry.route === "/zh/benchmarks/gdpval-harness"));
  assert.deepEqual(
    checks.aliases.find((entry) => entry.source === "/concepts/control-plane"),
    {
      source: "/concepts/control-plane",
      destination: "/reference/approvals-budgets-activity",
    },
  );
  assert.deepEqual(
    checks.aliases.find((entry) => entry.source === "/en/zh/reference/workspace-boundaries"),
    {
      source: "/en/zh/reference/workspace-boundaries",
      destination: "/zh/reference/workspace-boundaries",
    },
  );
});

test("static metadata checks reject non-rendered markup and links outside head", () => {
  const manifest = { base_url: "https://docs.rudderhq.dev" };
  const entry = { anchors: ["definition"], locale: "en", route: "/concepts/agents" };
  const fakeMarkup = [
    '<link rel="canonical" href="https://docs.rudderhq.dev/concepts/agents">',
    '<link rel="alternate" hreflang="en" href="https://docs.rudderhq.dev/concepts/agents">',
    '<link rel="alternate" hreflang="zh-CN" href="https://docs.rudderhq.dev/zh/concepts/agents">',
    '<div id="definition"></div>',
  ].join("");
  for (const container of ["script", "style", "textarea", "xmp"]) {
    const html = `<html><head><${container}>${fakeMarkup}</${container}></head><body></body></html>`;
    assert.throws(
      () => assertDocumentMetadata(html, entry, manifest),
      /missing canonical/u,
      `${container} content must not satisfy static metadata checks`,
    );
  }

  assert.throws(
    () => assertDocumentMetadata(`<html><head></head><body>${fakeMarkup}</body></html>`, entry, manifest),
    /missing canonical/u,
    "link metadata outside head must not satisfy static metadata checks",
  );
});

test("static verification times out stalled responses", async () => {
  const originalFetch = globalThis.fetch;
  const keepAlive = setTimeout(() => {}, 1_000);
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  });
  try {
    const manifest = {
      base_url: "https://docs.rudderhq.dev",
      pages: [{
        status: "active",
        urls: { en: "/" },
        anchors: { en: [] },
      }],
    };
    await assert.rejects(
      verifyStaticDocs("http://127.0.0.1:4179", {
        generatedConfig: { redirects: [] },
        manifest,
        timeoutMs: 25,
      }),
      /timed out after 25ms/u,
    );
  } finally {
    clearTimeout(keepAlive);
    globalThis.fetch = originalFetch;
  }
});

test("public health, package scripts, CI, and staging cover static docs search", () => {
  const healthCheck = fs.readFileSync(
    path.join(REPO_ROOT, "scripts/check-docs-public-health.mjs"),
    "utf8",
  );
  assert.match(healthCheck, /path: "\/rudder-search-index\.json"/);
  assert.match(healthCheck, /path: "\/rudder-search\.js"/);
  assert.match(healthCheck, /source: "\/about", destination: "\/"/);
  assert.match(healthCheck, /source: "\/zh\/about", destination: "\/zh"/);
  assert.match(healthCheck, /path: "\/zh\/contact"/);
  assert.match(healthCheck, /bodyIncludes: \["GitHub", "Bug reports"\]/);
  assert.match(healthCheck, /fetchText\(url, timeoutMs, "manual"\)/);
  assert.match(healthCheck, /const LEGACY_HOST = "doc\.rudder\.zeeland\.studio"/);
  assert.match(healthCheck, /destinationUrl\.href !== expectedUrl\.href/);
  assert.match(healthCheck, /fetchText\(destinationUrl, timeoutMs, "manual"\)/);
  for (const alias of [
    "/concepts/control-plane",
    "/zh/concepts/control-plane",
    "/concepts/approvals-budgets-activity",
    "/zh/concepts/approvals-budgets-activity",
    "/concepts/chat",
    "/concepts/messenger",
    "/zh/concepts/chat",
    "/zh/concepts/messenger",
  ]) {
    assert.ok(healthCheck.includes(`source: "${alias}"`), `${alias} must be checked after deployment`);
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts["test:docs-search"],
    "playwright test --config tests/docs-search/playwright.config.ts",
  );

  const ci = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /pnpm exec playwright install --with-deps chromium/);
  assert.match(ci, /pnpm test:docs-search/);

  const staging = fs.readFileSync(
    path.join(REPO_ROOT, ".github/workflows/docs-staging.yml"),
    "utf8",
  );
  assert.match(staging, /scripts\/docs-static-search\.js/);
  assert.match(staging, /scripts\/postprocess-docs-export\.mjs/);
});

test("docs production requires explicit target confirmation before deployment", () => {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, ".github/workflows", "docs-production.yml"),
    "utf8",
  );
  const confirmationIndex = source.indexOf("Confirm production target");
  const deployIndex = source.indexOf("Deploy to Vercel production");

  assert.match(source, /confirm_domain:/);
  assert.match(source, /explicit operator approval/);
  assert.match(source, /CONFIRM_DOMAIN: \$\{\{ inputs\.confirm_domain \}\}/);
  assert.match(source, /test "\$CONFIRM_DOMAIN" = "\$DOCS_PRODUCTION_DOMAIN"/);
  assert.doesNotMatch(source, /test "\$\{\{ inputs\.confirm_domain \}\}"/);
  assert.ok(confirmationIndex > -1 && confirmationIndex < deployIndex);
});
