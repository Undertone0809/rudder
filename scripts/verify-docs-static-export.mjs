#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { activePages, loadManifest } from "./docs-content-map.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requireMatch(html, pattern, message) {
  if (!pattern.test(html)) throw new Error(message);
}

async function fetchManual(url) {
  return fetch(url, {
    headers: { "user-agent": "rudder-docs-static-verifier/1.0" },
    redirect: "manual",
  });
}

export async function verifyStaticDocs(baseUrl, options = {}) {
  const manifest = options.manifest ?? loadManifest();
  const checks = staticVerificationChecks({ manifest, generatedConfig: options.generatedConfig });
  const origin = new URL(baseUrl);

  for (const entry of checks.canonical) {
    const response = await fetchManual(new URL(entry.route, origin));
    if (response.status !== 200) {
      throw new Error(`${entry.route} returned ${response.status}, expected 200`);
    }
    const html = await response.text();
    const canonical = `${manifest.base_url}${entry.route === "/" ? "" : entry.route}`;
    requireMatch(
      html,
      new RegExp(`<link[^>]+rel=["']canonical["'][^>]+href=["']${escapeRegExp(canonical)}["']|<link[^>]+href=["']${escapeRegExp(canonical)}["'][^>]+rel=["']canonical["']`, "i"),
      `${entry.route} is missing canonical ${canonical}`,
    );

    const englishRoute = entry.locale === "zh"
      ? (entry.route === "/zh" ? "/" : entry.route.slice(3))
      : entry.route;
    const chineseRoute = entry.locale === "zh"
      ? entry.route
      : (entry.route === "/" ? "/zh" : `/zh${entry.route}`);
    const englishUrl = `${manifest.base_url}${englishRoute === "/" ? "" : englishRoute}`;
    const chineseUrl = `${manifest.base_url}${chineseRoute}`;
    requireMatch(
      html,
      new RegExp(`<link[^>]+rel=["']alternate["'][^>]+hreflang=["']en["'][^>]+href=["']${escapeRegExp(englishUrl)}["']|<link[^>]+href=["']${escapeRegExp(englishUrl)}["'][^>]+hreflang=["']en["'][^>]+rel=["']alternate["']`, "i"),
      `${entry.route} is missing English hreflang ${englishUrl}`,
    );
    requireMatch(
      html,
      new RegExp(`<link[^>]+rel=["']alternate["'][^>]+hreflang=["']zh-CN["'][^>]+href=["']${escapeRegExp(chineseUrl)}["']|<link[^>]+href=["']${escapeRegExp(chineseUrl)}["'][^>]+hreflang=["']zh-CN["'][^>]+rel=["']alternate["']`, "i"),
      `${entry.route} is missing Chinese hreflang ${chineseUrl}`,
    );
    for (const anchor of entry.anchors) {
      requireMatch(
        html,
        new RegExp(`\\bid=["']${escapeRegExp(anchor)}["']`),
        `${entry.route} is missing required anchor #${anchor}`,
      );
    }
  }

  for (const alias of checks.aliases) {
    const sourceUrl = new URL(alias.source, origin);
    const response = await fetchManual(sourceUrl);
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
    const finalResponse = await fetchManual(actual);
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
