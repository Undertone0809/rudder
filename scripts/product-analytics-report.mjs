#!/usr/bin/env node

function usage() {
  process.stderr.write(`Usage: pnpm analytics:report -- [--from ISO] [--to ISO] [--output PATH]\n`);
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--from" || arg === "--to" || arg === "--output") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      result[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function validIso(value, name) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} must be an ISO timestamp`);
  return date.toISOString();
}

export async function fetchProductAnalyticsReport({ baseUrl, secret, from, to, fetchImpl = fetch }) {
  const endpoint = new URL(baseUrl);
  if (from) endpoint.searchParams.set("from", from);
  if (to) endpoint.searchParams.set("to", to);
  const response = await fetchImpl(endpoint, {
    headers: { accept: "application/json", authorization: `Bearer ${secret}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = typeof body?.errorCode === "string" ? body.errorCode : `http_${response.status}`;
    throw new Error(`Product analytics report failed: ${code}`);
  }
  if (!body || typeof body !== "object" || !body.window || !body.metrics || !body.quality) {
    throw new Error("Product analytics report returned an invalid aggregate contract");
  }
  return body;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = process.env.PRODUCT_ANALYTICS_REPORT_URL?.trim();
  const secret = process.env.PRODUCT_ANALYTICS_REPORT_SECRET?.trim();
  if (!baseUrl || !secret) throw new Error("PRODUCT_ANALYTICS_REPORT_URL and PRODUCT_ANALYTICS_REPORT_SECRET are required");
  const endpoint = new URL(baseUrl);
  if (endpoint.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(endpoint.hostname)) {
    throw new Error("PRODUCT_ANALYTICS_REPORT_URL must use HTTPS outside local development");
  }
  const report = await fetchProductAnalyticsReport({
    baseUrl: endpoint,
    secret,
    from: validIso(args.from, "--from"),
    to: validIso(args.to, "--to"),
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (args.output) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(args.output, serialized, { mode: 0o600 });
    process.stdout.write(`Wrote aggregate report to ${args.output}\n`);
    return;
  }
  process.stdout.write(serialized);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    usage();
    process.exitCode = 1;
  });
}
