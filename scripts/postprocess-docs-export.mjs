#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CANONICAL_ORIGIN = "https://docs.rudderhq.dev";
const SOCIAL_IMAGE_URL = `${CANONICAL_ORIGIN}/images/rudder-social-card.png`;
const SOCIAL_IMAGE_ALT = "Rudder - Build your self-improving Agent Team.";
const SOCIAL_META = [
  { attribute: "property", key: "og:image", content: SOCIAL_IMAGE_URL },
  { attribute: "property", key: "og:image:type", content: "image/png" },
  { attribute: "property", key: "og:image:width", content: "1200" },
  { attribute: "property", key: "og:image:height", content: "630" },
  { attribute: "property", key: "og:image:alt", content: SOCIAL_IMAGE_ALT },
  { attribute: "name", key: "twitter:card", content: "summary_large_image" },
  { attribute: "name", key: "twitter:image", content: SOCIAL_IMAGE_URL },
  { attribute: "name", key: "twitter:image:alt", content: SOCIAL_IMAGE_ALT },
];
const MARKDOWN_ALTERNATE_RE =
  /<link\b(?=[^>]*\brel=["']alternate["'])(?=[^>]*\btype=["']text\/markdown["'])[^>]*\/?\s*>/gi;
const HREFLANG_ALTERNATE_RE =
  /<link\b(?=[^>]*\brel=["']alternate["'])(?=[^>]*\bhreflang=["'][^"']+["'])[^>]*\/?\s*>/gi;
const SEO_GUARD_RE = /<script\b[^>]*\bdata-rudder-seo-guard[^>]*>[\s\S]*?<\/script>/gi;
const SEARCH_RUNTIME_RE = /<script\b[^>]*\bdata-rudder-search[^>]*><\/script>/gi;
const SEARCH_RUNTIME_SOURCE = fileURLToPath(new URL("./docs-static-search.js", import.meta.url));
const SEARCH_RUNTIME_TAG = '<script src="/rudder-search.js" defer data-rudder-search></script>';
const CHINESE_FOOTER_PATHS = [
  "/get-started/installation",
  "/get-started/first-organization",
  "/how-to/issue-lifecycle",
  "/how-to/configure-agent-runtime",
  "/concepts/chat-messenger",
  "/concepts/calendar",
  "/releases",
];

function collectPageFiles(exportDir) {
  const files = [];

  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
      } else if (entry.name === "index.html") {
        files.push(filePath);
      }
    }
  }

  visit(exportDir);
  return files.sort();
}

function normalizeStaticRuntimeEnvironment(exportDir) {
  const chunksDir = path.join(exportDir, "_next/static/chunks");
  if (!fs.existsSync(chunksDir)) return 0;

  let changedFiles = 0;
  for (const filename of fs.readdirSync(chunksDir)) {
    if (!filename.endsWith(".js")) continue;
    const filePath = path.join(chunksDir, filename);
    const source = fs.readFileSync(filePath, "utf8");
    const normalized = source
      .replaceAll('ENV:"cli"', 'ENV:"production"')
      .replace(
        /(?<![\w$|])([A-Za-z_$][\w$]*)\|\|\(console\.warn\("Connected to Socket\.io"\)/g,
        '$1||true||(console.warn("Connected to Socket.io")',
      );
    if (normalized === source) continue;
    fs.writeFileSync(filePath, normalized);
    changedFiles += 1;
  }
  return changedFiles;
}

function routeForFile(exportDir, filePath) {
  const relativePath = path.relative(exportDir, filePath).split(path.sep).join("/");
  if (relativePath === "index.html") return "/";
  return `/${relativePath.slice(0, -"/index.html".length)}`;
}

function canonicalUrl(route) {
  return route === "/" ? CANONICAL_ORIGIN : `${CANONICAL_ORIGIN}${route}`;
}

function decodeHtml(text) {
  return text
    .replace(/&#(\d+);/g, (_match, value) => String.fromCodePoint(Number(value)))
    .replace(/&#x([\da-f]+);/gi, (_match, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ");
}

function textFromMarkup(markup) {
  return decodeHtml(
    markup
      .replace(/<(script|style|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function extractMetaContent(html, name) {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const metaName = tag.match(/\bname=["']([^"']+)["']/i)?.[1];
    if (metaName !== name) continue;
    return decodeHtml(tag.match(/\bcontent=["']([^"']*)["']/i)?.[1] ?? "");
  }
  return "";
}

function extractSearchPage(route, html) {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  if (!main) return null;

  const titleMarkup = main.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const title = titleMarkup ? textFromMarkup(titleMarkup) : "";
  if (!title) return null;

  const headings = [...main.matchAll(/<h[2-3]\b[^>]*>([\s\S]*?)<\/h[2-3]>/gi)]
    .map((match) => textFromMarkup(match[1]))
    .filter(Boolean);

  return {
    content: textFromMarkup(main),
    description: extractMetaContent(html, "description"),
    headings,
    language: route === "/zh" || route.startsWith("/zh/") ? "zh-CN" : "en",
    path: route,
    title,
  };
}

function writeSearchAssets(exportDir, pageRoutes) {
  const searchPages = [];
  for (const [route, filePath] of pageRoutes) {
    if (route === "/index" && pageRoutes.has("/")) continue;
    const page = extractSearchPage(route, fs.readFileSync(filePath, "utf8"));
    if (page) searchPages.push(page);
  }

  fs.writeFileSync(
    path.join(exportDir, "rudder-search-index.json"),
    `${JSON.stringify(searchPages, null, 2)}\n`,
  );
  fs.copyFileSync(SEARCH_RUNTIME_SOURCE, path.join(exportDir, "rudder-search.js"));
  return searchPages.length;
}

function injectSearchRuntime(html) {
  html = html.replace(SEARCH_RUNTIME_RE, "");
  if (!html.includes("</head>")) {
    throw new Error("Exported docs page is missing </head>");
  }
  return html.replace("</head>", `${SEARCH_RUNTIME_TAG}</head>`);
}

function replaceHtmlLang(html, language) {
  return html.replace(
    /<html\b([^>]*?)\blang=(["'])[^"']*\2/i,
    (_match, before) => `<html${before}lang="${language}"`,
  );
}

function languageRoutes(route, routes) {
  const isChinese = route === "/zh" || route.startsWith("/zh/");
  const englishRoute = isChinese ? (route === "/zh" ? "/" : route.slice(3)) : route;
  const chineseRoute = isChinese ? route : route === "/" ? "/zh" : `/zh${route}`;

  if (!routes.has(englishRoute) || !routes.has(chineseRoute)) return null;
  return { chineseRoute, englishRoute };
}

function injectLanguageAlternates(html, pair) {
  const tags = [
    `<link rel="alternate" hreflang="en" href="${canonicalUrl(pair.englishRoute)}"/>`,
    `<link rel="alternate" hreflang="zh-CN" href="${canonicalUrl(pair.chineseRoute)}"/>`,
    `<link rel="alternate" hreflang="x-default" href="${canonicalUrl(pair.englishRoute)}"/>`,
  ].join("");

  if (!html.includes("</head>")) {
    throw new Error("Exported docs page is missing </head>");
  }
  return html.replace("</head>", `${tags}</head>`);
}

function injectSocialMeta(html) {
  for (const { key } of SOCIAL_META) {
    const tagRe = new RegExp(
      `<meta\\b(?=[^>]*\\b(?:name|property)=["']${key}["'])[^>]*\\/?\\s*>`,
      "gi",
    );
    html = html.replace(tagRe, "");
  }

  const tags = SOCIAL_META.map(
    ({ attribute, key, content }) => `<meta ${attribute}="${key}" content="${content}"/>`,
  ).join("");

  if (!html.includes("</head>")) {
    throw new Error("Exported docs page is missing </head>");
  }
  return html.replace("</head>", `${tags}</head>`);
}

function injectSeoGuard(html, isChinese) {
  const languageGuard = isChinese
    ? 'if(document.documentElement.lang!=="zh-CN")document.documentElement.lang="zh-CN";'
    : "";
  const socialGuard = SOCIAL_META.map(
    ({ attribute, key, content }) =>
      `setMeta(${JSON.stringify(attribute)},${JSON.stringify(key)},${JSON.stringify(content)});`,
  ).join("");
  const script = `<script data-rudder-seo-guard>(function(){const setMeta=function(a,k,v){const nodes=Array.from(document.querySelectorAll('meta[property="'+k+'"],meta[name="'+k+'"]'));let node=nodes.shift();if(!node){node=document.createElement("meta");document.head.appendChild(node)}if(node.getAttribute(a)!==k)node.setAttribute(a,k);const other=a==="property"?"name":"property";if(node.hasAttribute(other))node.removeAttribute(other);if(node.getAttribute("content")!==v)node.setAttribute("content",v);nodes.forEach(function(extra){extra.remove()})};const fix=function(){${languageGuard}document.querySelectorAll('link[rel="alternate"][type="text/markdown"]').forEach(function(link){link.remove()});${socialGuard}};fix();new MutationObserver(fix).observe(document.documentElement,{attributes:true,attributeFilter:["lang","content","name","property"],childList:true,subtree:true})})()</script>`;

  if (!html.includes("</head>")) {
    throw new Error("Exported docs page is missing </head>");
  }
  return html.replace("</head>", `${script}</head>`);
}

function localizeFooterMarkup(html) {
  const footerStart = html.indexOf('<footer id="footer"');
  if (footerStart === -1) return html;
  const footerEnd = html.indexOf("</footer>", footerStart);
  if (footerEnd === -1) throw new Error("Exported docs page has an unclosed footer");

  const before = html.slice(0, footerStart);
  let footer = html.slice(footerStart, footerEnd + "</footer>".length);
  const after = html.slice(footerEnd + "</footer>".length);

  for (const englishPath of CHINESE_FOOTER_PATHS) {
    footer = footer.replaceAll(`href="${englishPath}"`, `href="/zh${englishPath}"`);
  }
  return before + footer + after;
}

function localizeSerializedFooter(html) {
  const startMarker = '\\"footer\\":';
  const endMarker = ',\\"seo\\":';
  let searchFrom = 0;

  while (true) {
    const start = html.indexOf(startMarker, searchFrom);
    if (start === -1) return html;
    const configuredEnd = html.indexOf(endMarker, start);
    const scriptEnd = html.indexOf("</script>", start);
    const end = configuredEnd === -1 ? scriptEnd : configuredEnd;
    if (end === -1) throw new Error("Could not isolate serialized docs footer config");

    let footer = html.slice(start, end);
    for (const englishPath of CHINESE_FOOTER_PATHS) {
      footer = footer.replaceAll(
        `\\"href\\":\\"${englishPath}\\"`,
        `\\"href\\":\\"/zh${englishPath}\\"`,
      );
    }
    html = html.slice(0, start) + footer + html.slice(end);
    searchFrom = start + footer.length;
  }
}

function postprocessExport(exportDir) {
  const normalizedRuntimeChunks = normalizeStaticRuntimeEnvironment(exportDir);
  const pageFiles = collectPageFiles(exportDir);
  if (pageFiles.length === 0) throw new Error(`No exported docs pages found in ${exportDir}`);

  const pageRoutes = new Map(pageFiles.map((filePath) => [routeForFile(exportDir, filePath), filePath]));
  const routes = new Set(pageRoutes.keys());
  const indexedPages = writeSearchAssets(exportDir, pageRoutes);
  let pairedPages = 0;
  let chinesePages = 0;

  for (const [route, filePath] of pageRoutes) {
    const isChinese = route === "/zh" || route.startsWith("/zh/");
    let html = fs.readFileSync(filePath, "utf8");
    html = html
      .replace(MARKDOWN_ALTERNATE_RE, "")
      .replace(HREFLANG_ALTERNATE_RE, "")
      .replace(SEO_GUARD_RE, "");
    html = replaceHtmlLang(html, isChinese ? "zh-CN" : "en");

    const pair = languageRoutes(route, routes);
    if (pair) {
      html = injectLanguageAlternates(html, pair);
      pairedPages += 1;
    }

    html = injectSocialMeta(html);
    html = injectSeoGuard(html, isChinese);
    html = injectSearchRuntime(html);

    if (isChinese) {
      html = localizeSerializedFooter(localizeFooterMarkup(html));
      chinesePages += 1;
    }

    fs.writeFileSync(filePath, html);
  }

  console.log(
    `Postprocessed ${pageFiles.length} docs pages (${chinesePages} Chinese, ${pairedPages} with language alternates, ${indexedPages} searchable, ${normalizedRuntimeChunks} runtime chunks normalized).`,
  );
}

const exportDir = process.argv[2];
if (!exportDir) {
  console.error("Usage: node scripts/postprocess-docs-export.mjs <export-directory>");
  process.exit(1);
}

postprocessExport(path.resolve(exportDir));
