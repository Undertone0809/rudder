#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const DOCS_DIR = fileURLToPath(new URL("../docs/", import.meta.url));
const LUCIDE_CDN_BASE = "https://d3gk2c5xim1je2.cloudfront.net/lucide/v1.16.0";
const DEFAULT_HOSTS = [
  "doc.rudder.zeeland.studio",
  "rudder-docs.vercel.app",
  "rudder-docs-zeelands-projects.vercel.app",
  "rudder-docs-zeeland-zeelands-projects.vercel.app",
];
const CANONICAL_ORIGIN = "https://doc.rudder.zeeland.studio";
const REQUIRED_PATHS = [
  { path: "/", status: 200, bodyIncludes: ["Rudder"], canonical: CANONICAL_ORIGIN },
  { path: "/about", status: 200, bodyIncludes: ["Rudder", "control plane"], canonical: `${CANONICAL_ORIGIN}/about` },
  { path: "/contact", status: 200, bodyIncludes: ["GitHub", "Report a bug"], canonical: `${CANONICAL_ORIGIN}/contact` },
  { path: "/home", status: 200, bodyIncludes: ["Rudder"], canonical: CANONICAL_ORIGIN, finalPath: "/" },
  { path: "/en", status: 200, bodyIncludes: ["Rudder"], canonical: CANONICAL_ORIGIN, finalPath: "/" },
  { path: "/get-started/installation", status: 200, bodyIncludes: ["Rudder"], canonical: `${CANONICAL_ORIGIN}/get-started/installation` },
  { path: "/zh", status: 200, bodyIncludes: ["Rudder"], canonical: `${CANONICAL_ORIGIN}/zh` },
  { path: "/zh/get-started/installation", status: 200, bodyIncludes: ["Rudder"], canonical: `${CANONICAL_ORIGIN}/zh/get-started/installation` },
  { path: "/robots.txt", status: 200, bodyIncludes: [`Sitemap: ${CANONICAL_ORIGIN}/sitemap.xml`] },
  { path: "/sitemap.xml", status: 200, bodyIncludes: [`<loc>${CANONICAL_ORIGIN}`, `${CANONICAL_ORIGIN}/zh`] },
  { path: "/llms.txt", status: 200, bodyIncludes: [CANONICAL_ORIGIN] },
  { path: "/favicon.svg", status: 200 },
  { path: "/favicon.ico", status: 200 },
  { path: "/favicon.png", status: 200 },
  { path: "/apple-touch-icon.png", status: 200 },
  { path: "/apple-touch-icon-precomposed.png", status: 200 },
  { path: "/site.webmanifest", status: 200, bodyIncludes: ["Rudder Docs", "/apple-touch-icon.png"] },
  { path: "/manifest.json", status: 200, bodyIncludes: ["Rudder Docs", "/apple-touch-icon.png"], finalPath: "/site.webmanifest" },
];

function parseArgs(argv) {
  const hosts = [];
  let attempts = 1;
  let checkIcons = process.env.DOCS_HEALTH_CHECK_ICONS !== "0";
  let retryDelayMs = 1000;
  let timeoutMs = 10_000;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--host") {
      const value = argv[++i];
      if (!value) throw new Error("--host requires a value");
      hosts.push(value);
      continue;
    }
    if (arg === "--hosts") {
      const value = argv[++i];
      if (!value) throw new Error("--hosts requires a value");
      hosts.push(...value.split(",").map((item) => item.trim()).filter(Boolean));
      continue;
    }
    if (arg === "--attempts") {
      attempts = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isInteger(attempts) || attempts < 1) throw new Error("--attempts must be a positive integer");
      continue;
    }
    if (arg === "--no-icon-check") {
      checkIcons = false;
      continue;
    }
    if (arg === "--retry-delay-ms") {
      retryDelayMs = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0) throw new Error("--retry-delay-ms must be a non-negative integer");
      continue;
    }
    if (arg === "--timeout-ms") {
      timeoutMs = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("--timeout-ms must be a positive integer");
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  const envHosts = (process.env.DOCS_HEALTH_HOSTS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const explicitHosts = [...hosts, ...envHosts];

  return {
    attempts,
    checkIcons,
    hosts: [...new Set(explicitHosts.length > 0 ? explicitHosts : DEFAULT_HOSTS)],
    retryDelayMs,
    timeoutMs,
  };
}

function findDocsIcons() {
  const icons = new Set();

  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
        continue;
      }
      if (!/\.(json|mdx)$/.test(entry.name)) {
        continue;
      }

      const source = fs.readFileSync(filePath, "utf8");
      for (const match of source.matchAll(/\bicon\s*[:=]\s*["']([^"']+)["']/g)) {
        const icon = match[1];
        if (icon && !icon.startsWith("/") && !/^https?:\/\//.test(icon)) {
          icons.add(icon);
        }
      }
    }
  }

  visit(DOCS_DIR);
  return [...icons].sort();
}

function normalizeHost(input) {
  return input.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

function assertCanonical(html, expected) {
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const canonicalPattern = new RegExp(`<link[^>]+rel=["']canonical["'][^>]+href=["']${escaped}["']|<link[^>]+href=["']${escaped}["'][^>]+rel=["']canonical["']`, "i");
  if (!canonicalPattern.test(html)) {
    throw new Error(`expected canonical link ${expected}`);
  }
}

async function fetchText(url, timeoutMs) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "rudder-docs-health/1.0",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  return { response, text };
}

async function checkLucideIcon(icon, timeoutMs) {
  const url = `${LUCIDE_CDN_BASE}/${icon}.svg`;
  const response = await fetch(url, {
    headers: {
      "user-agent": "rudder-docs-health/1.0",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status !== 200) {
    throw new Error(`${url} returned ${response.status}, expected 200`);
  }
  return {
    contentType: response.headers.get("content-type"),
    icon,
    status: response.status,
  };
}

async function checkIcons(timeoutMs) {
  const results = [];
  const failures = [];

  for (const icon of findDocsIcons()) {
    try {
      results.push(await checkLucideIcon(icon, timeoutMs));
    } catch (error) {
      failures.push(`${icon}: ${error.message}`);
    }
  }

  return { failures, results };
}

async function checkPath(host, check, timeoutMs) {
  const url = `https://${host}${check.path}`;
  let response;
  let text;

  try {
    ({ response, text } = await fetchText(url, timeoutMs));
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error(`${url} timed out after ${timeoutMs}ms`);
    }
    throw error;
  }

  if (response.status !== check.status) {
    throw new Error(`${url} returned ${response.status}, expected ${check.status}`);
  }

  if (check.finalPath) {
    const finalPath = new URL(response.url).pathname;
    if (finalPath !== check.finalPath) {
      throw new Error(`${url} resolved to path ${finalPath}, expected ${check.finalPath}`);
    }
  }

  for (const expected of check.bodyIncludes ?? []) {
    if (!text.includes(expected)) {
      throw new Error(`${url} missing expected content: ${expected}`);
    }
  }

  if (check.canonical) {
    assertCanonical(text, check.canonical);
  }

  return {
    cache: response.headers.get("x-vercel-cache"),
    contentType: response.headers.get("content-type"),
    path: check.path,
    status: response.status,
  };
}

async function checkHost(hostInput, timeoutMs) {
  const host = normalizeHost(hostInput);
  const results = [];
  const failures = [];

  for (const check of REQUIRED_PATHS) {
    try {
      results.push(await checkPath(host, check, timeoutMs));
    } catch (error) {
      failures.push(`${check.path}: ${error.message}`);
    }
  }

  if (failures.length > 0) {
    return { failures, host, results };
  }

  return { host, results };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const failures = [];
  const iconCheck = options.checkIcons ? await checkIcons(options.timeoutMs) : null;
  const successes = [];

  for (const host of options.hosts) {
    let lastError = null;
    for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
      try {
        const result = await checkHost(host, options.timeoutMs);
        if (result.failures?.length > 0) {
          throw new Error(result.failures.join("; "));
        }
        successes.push(result);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < options.attempts) {
          await delay(options.retryDelayMs);
        }
      }
    }
    if (lastError) {
      failures.push({ host: normalizeHost(host), message: lastError.message });
    }
  }

  for (const success of successes) {
    console.log(`ok ${success.host}`);
    for (const result of success.results) {
      const cache = result.cache ? ` cache=${result.cache}` : "";
      console.log(`  ${result.status} ${result.path}${cache}`);
    }
  }

  if (iconCheck) {
    if (iconCheck.failures.length > 0) {
      failures.push({ host: "lucide-icons", message: iconCheck.failures.join("; ") });
    } else {
      console.log("ok lucide-icons");
      for (const result of iconCheck.results) {
        console.log(`  ${result.status} ${result.icon}`);
      }
    }
  }

  if (failures.length > 0) {
    console.error("Docs public health check failed:");
    for (const failure of failures) {
      console.error(`- ${failure.host}: ${failure.message}`);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
