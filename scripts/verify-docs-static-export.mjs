#!/usr/bin/env node

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { activePages, loadManifest } from "./docs-content-map.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const requireFromServer = createRequire(new URL("../server/package.json", import.meta.url));
const { JSDOM } = requireFromServer("jsdom");
const DEFAULT_TIMEOUT_MS = 10_000;

function wildcardValue(pattern, value) {
  const marker = ":path*";
  if (!pattern.includes(marker)) return pattern === value ? "" : null;
  const prefix = pattern.slice(0, pattern.indexOf(marker));
  return value.startsWith(prefix) ? value.slice(prefix.length) : null;
}

export function staticVerificationChecks({
  manifest = loadManifest(),
  generatedConfig = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "docs/docs.json"), "utf8")),
} = {}) {
  const canonical = activePages(manifest).flatMap((page) =>
    Object.entries(page.urls).map(([locale, route]) => ({
      anchors: page.anchors[locale],
      locale,
      route,
    })),
  );
  const canonicalRoutes = canonical.map((entry) => entry.route);
  const aliases = new Map();

  for (const redirect of generatedConfig.redirects) {
    if (!redirect.source.includes(":path*")) {
      if (!aliases.has(redirect.source)) aliases.set(redirect.source, redirect.destination);
      continue;
    }
    for (const route of canonicalRoutes) {
      const value = wildcardValue(redirect.destination, route);
      if (value === null) continue;
      const source = redirect.source.replace(":path*", value);
      if (!aliases.has(source)) aliases.set(source, route);
    }
  }

  return {
    aliases: [...aliases].map(([source, destination]) => ({ source, destination })),
    canonical,
  };
}

export function assertDocumentMetadata(html, entry, manifest) {
  const document = new JSDOM(html).window.document;
  const canonical = `${manifest.base_url}${entry.route === "/" ? "" : entry.route}`;
  const canonicalMatches = [...document.querySelectorAll('link[rel~="canonical"]')]
    .some((link) => link.getAttribute("href") === canonical);
  if (!canonicalMatches) throw new Error(`${entry.route} is missing canonical ${canonical}`);

  const englishRoute = entry.locale === "zh"
    ? (entry.route === "/zh" ? "/" : entry.route.slice(3))
    : entry.route;
  const chineseRoute = entry.locale === "zh"
    ? entry.route
    : (entry.route === "/" ? "/zh" : `/zh${entry.route}`);
  const alternates = [...document.querySelectorAll('link[rel~="alternate"][hreflang]')];
  const requiredAlternates = [
    ["en", `${manifest.base_url}${englishRoute === "/" ? "" : englishRoute}`],
    ["zh-CN", `${manifest.base_url}${chineseRoute}`],
  ];
  for (const [language, href] of requiredAlternates) {
    const matches = alternates.some((link) =>
      link.getAttribute("hreflang") === language && link.getAttribute("href") === href
    );
    if (!matches) throw new Error(`${entry.route} is missing ${language} hreflang ${href}`);
  }
  for (const anchor of entry.anchors) {
    if (!document.getElementById(anchor)) {
      throw new Error(`${entry.route} is missing required anchor #${anchor}`);
    }
  }
}

async function fetchManual(url, timeoutMs) {
  try {
    return await fetch(url, {
      headers: { "user-agent": "rudder-docs-static-verifier/1.0" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error(`${url} timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}

export async function verifyStaticDocs(baseUrl, options = {}) {
  const manifest = options.manifest ?? loadManifest();
  const checks = staticVerificationChecks({ manifest, generatedConfig: options.generatedConfig });
  const origin = new URL(baseUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("timeoutMs must be a positive integer");

  for (const entry of checks.canonical) {
    const response = await fetchManual(new URL(entry.route, origin), timeoutMs);
    if (response.status !== 200) {
      throw new Error(`${entry.route} returned ${response.status}, expected 200`);
    }
    const html = await response.text();
    assertDocumentMetadata(html, entry, manifest);
  }

  for (const alias of checks.aliases) {
    const sourceUrl = new URL(alias.source, origin);
    const response = await fetchManual(sourceUrl, timeoutMs);
    if (![301, 308].includes(response.status)) {
      throw new Error(`${alias.source} returned ${response.status}, expected one 301 or 308 redirect`);
    }
    const location = response.headers.get("location");
    if (!location) throw new Error(`${alias.source} did not return a Location header`);
    const actual = new URL(location, sourceUrl);
    const expected = new URL(alias.destination, origin);
    if (actual.href !== expected.href) {
      throw new Error(`${alias.source} redirected to ${actual.href}, expected ${expected.href}`);
    }
    const finalResponse = await fetchManual(actual, timeoutMs);
    if (finalResponse.status !== 200) {
      throw new Error(`${alias.source} did not resolve in one redirect to a 200 ${alias.destination}`);
    }
  }

  return { aliases: checks.aliases.length, canonical: checks.canonical.length };
}

async function main() {
  const baseUrl = process.argv[2] ?? process.env.DOCS_STATIC_BASE_URL ?? "http://127.0.0.1:4179";
  try {
    const result = await verifyStaticDocs(baseUrl);
    console.log(`Static docs verification passed: ${result.canonical} canonical routes and ${result.aliases} active alias checks.`);
  } catch (error) {
    console.error(`Static docs verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
