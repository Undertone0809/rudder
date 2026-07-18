import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts/postprocess-docs-export.mjs");

function writePage(exportDir, route, body) {
  const relativePath = route === "/" ? "index.html" : `${route.slice(1)}/index.html`;
  const filePath = path.join(exportDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body);
  return filePath;
}

function fixturePage(markdownHref, footer = "") {
  return [
    '<!doctype html><html lang="en"><head>',
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
    'const runtime={ENV:"cli"};let o=false;o||(console.warn("Connected to Socket.io"),connect());',
  );
  const footer = [
    '<a href="/get-started/installation">Quick Start</a>',
    '<a href="/concepts/calendar">Calendar</a>',
    '<a href="/about">About</a>',
    '<script>self.__next_f.push([1,"\\\"footer\\\":{\\\"links\\\":[{\\\"items\\\":[{\\\"label\\\":\\\"Quick Start\\\",\\\"href\\\":\\\"/get-started/installation\\\"},{\\\"label\\\":\\\"Calendar\\\",\\\"href\\\":\\\"/concepts/calendar\\\"},{\\\"label\\\":\\\"About\\\",\\\"href\\\":\\\"/about\\\"}]}]}"])</script>',
  ].join("");

  const englishPath = writePage(exportDir, "/", fixturePage("/index.md", footer));
  const chinesePath = writePage(exportDir, "/zh", fixturePage("/zh.md", footer));
  const englishGuidePath = writePage(
    exportDir,
    "/get-started/installation",
    fixturePage("/get-started/installation.md"),
  );
  const chineseGuidePath = writePage(
    exportDir,
    "/zh/get-started/installation",
    fixturePage("/zh/get-started/installation.md", footer),
  );
  const unpairedPath = writePage(exportDir, "/about", fixturePage("/about.md"));

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
    assert.match(html, /attributeFilter:\["lang","content","name","property"\]/);
    assert.doesNotMatch(html, /mintlify\.example\/generated-card\.png/);
    assert.equal((html.match(/<meta property="og:image"/g) ?? []).length, 1);
    assert.equal((html.match(/<meta name="twitter:image"/g) ?? []).length, 1);
  }

  assert.match(english, /<html lang="en">/);
  assert.match(chinese, /<html lang="zh-CN">/);
  assert.match(chinese, /document\.documentElement\.lang!=="zh-CN"/);
  assert.match(chinese, /document\.documentElement\.lang="zh-CN"/);
  assert.match(englishGuide, /hreflang="zh-CN" href="https:\/\/docs\.rudderhq\.dev\/zh\/get-started\/installation"/);
  assert.match(chineseGuide, /hreflang="en" href="https:\/\/docs\.rudderhq\.dev\/get-started\/installation"/);
  assert.match(chineseGuide, /hreflang="x-default" href="https:\/\/docs\.rudderhq\.dev\/get-started\/installation"/);
  assert.doesNotMatch(unpaired, /hreflang=/);

  assert.match(chinese, /href="\/zh\/get-started\/installation">Quick Start/);
  assert.match(chinese, /href="\/zh\/concepts\/calendar">Calendar/);
  assert.match(chinese, /href="\/about">About/);
  assert.match(chinese, /\\"href\\":\\"\/zh\/get-started\/installation\\"/);
  assert.match(chinese, /\\"href\\":\\"\/zh\/concepts\/calendar\\"/);
  assert.match(chinese, /\\"href\\":\\"\/about\\"/);
  assert.match(runtimeChunk, /ENV:"production"/);
  assert.doesNotMatch(runtimeChunk, /ENV:"cli"/);
  assert.match(runtimeChunk, /o\|\|true\|\|\(console\.warn\("Connected to Socket\.io"\)/);
  assert.doesNotMatch(runtimeChunk, /o\|\|\(console\.warn\("Connected to Socket\.io"\)/);
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
