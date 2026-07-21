import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const docsDir = path.join(repoRoot, "docs");
const port = Number.parseInt(process.argv[2] ?? "4179", 10);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-docs-search-e2e-"));
const archivePath = path.join(tempDir, "docs.zip");
const exportDir = path.join(tempDir, "site");
const redirects = JSON.parse(fs.readFileSync(path.join(docsDir, "docs.json"), "utf8")).redirects;

function run(command, args, { attempts = 1, ...options } = {}) {
  let result;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = spawnSync(command, args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
      ...options,
    });
    if (result.status === 0) return;
    if (attempt < attempts) {
      process.stderr.write(`Command failed; retrying (${attempt}/${attempts})...\n`);
    }
  }

  process.stderr.write(result?.stdout ?? "");
  process.stderr.write(result?.stderr ?? "");
  process.exit(result?.status ?? 1);
}

run("npx", ["-y", "mint@4.2.637", "export", "--output", archivePath], {
  attempts: 3,
  cwd: docsDir,
});
fs.mkdirSync(exportDir);
run("unzip", ["-q", archivePath, "-d", exportDir]);
run(process.execPath, [path.join(repoRoot, "scripts/postprocess-docs-export.mjs"), exportDir]);

const mimeTypes = new Map([
  [".css", "text/css"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "application/javascript"],
  [".json", "application/json"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml"],
]);

function resolveFile(urlPath) {
  const requested = path.resolve(exportDir, urlPath.replace(/^\/+/, ""));
  if (requested !== exportDir && !requested.startsWith(`${exportDir}${path.sep}`)) return null;
  const candidates = [requested, path.join(requested, "index.html"), `${requested}.html`];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;
}

function matchRedirectSource(source, requestPath) {
  const wildcard = ":path*";
  if (!source.includes(wildcard)) return source === requestPath ? "" : null;
  const prefix = source.slice(0, source.indexOf(wildcard));
  return requestPath.startsWith(prefix) ? requestPath.slice(prefix.length) : null;
}

function redirectDestination(requestPath) {
  for (const redirect of redirects) {
    const wildcardValue = matchRedirectSource(redirect.source, requestPath);
    if (wildcardValue === null) continue;
    return redirect.destination.replace(":path*", wildcardValue);
  }
  return null;
}

const server = http.createServer((request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? "/", `http://127.0.0.1:${port}`).pathname);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("404 Not Found");
    return;
  }

  const destination = redirectDestination(pathname);
  if (destination !== null) {
    response.writeHead(308, { Location: destination });
    response.end();
    return;
  }

  const filePath = resolveFile(pathname);
  if (!filePath) {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("404 Not Found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": mimeTypes.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream",
  });
  fs.createReadStream(filePath).pipe(response);
});

function stop() {
  server.close(() => {
    fs.rmSync(tempDir, { force: true, recursive: true });
    process.exit(0);
  });
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Serving exported docs at http://127.0.0.1:${port}\n`);
});
