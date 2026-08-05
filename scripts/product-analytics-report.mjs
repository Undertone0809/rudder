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

function hasOnlyKeys(value, allowed) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function matchesShape(value, schema) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => typeof schema[key] === "function")
    && Object.entries(value).every(([key, entry]) => schema[key](entry));
}

function isOptionalRecord(value, schema) {
  return value === undefined || matchesShape(value, schema);
}

function isOptionalArray(value, schema) {
  return value === undefined || (Array.isArray(value) && value.every((entry) => matchesShape(entry, schema)));
}

const isString = (value) => typeof value === "string";
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isBoolean = (value) => typeof value === "boolean";
const isNullableNumber = (value) => value === null || isNumber(value);

export async function fetchProductAnalyticsReport({ baseUrl, secret, from, to, fetchImpl = fetch }) {
  const endpoint = new URL(baseUrl);
  if (endpoint.protocol !== "https:" && !["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname)) {
    throw new Error("PRODUCT_ANALYTICS_REPORT_URL must use HTTPS outside local development");
  }
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
  const allowedTopLevel = new Set(["window", "metrics", "quality", "privacy", "coverage", "retention"]);
  const validShape = body && typeof body === "object"
    && Object.keys(body).every((key) => allowedTopLevel.has(key))
    && matchesShape(body.window, { from: isString, to: isString, timezone: isString })
    && matchesShape(body.metrics, {
      meaningfulActiveInstallations1d: isNumber,
      meaningfulActiveInstallations7d: isNumber,
      productiveInstallations7d: isNumber,
      weeklyCompletedWorkLoops: isNumber,
      meaningfulDau: isNumber,
      productiveWau: isNumber,
    })
    && matchesShape(body.quality, {
      receivedBatchCount: isNumber,
      acceptedEventCount: isNumber,
      lateEventCount: isNumber,
      duplicateEventCount: isNumber,
      rejectedEventCount: isNumber,
      aggregateRows: isNumber,
    })
    && isOptionalRecord(body.privacy, { aggregateRows: (value) => Array.isArray(value) })
    && isOptionalArray(body.privacy?.aggregateRows, {
      metricName: isString,
      metricValue: isNumber,
      contributingInstallations: isNumber,
      privacyThreshold: isNumber,
    })
    && isOptionalRecord(body.coverage, { accountLinkedEventCount: isNumber, anonymousEventCount: isNumber })
    && isOptionalArray(body.retention, {
      cohortDay: isString,
      eligibleInstallations: isNullableNumber,
      meaningfulW1: isNullableNumber,
      loopW1: isNullableNumber,
      loopW4: isNullableNumber,
      suppressed: isBoolean,
    });
  if (!validShape) {
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
    const { chmod, writeFile } = await import("node:fs/promises");
    await writeFile(args.output, serialized, { mode: 0o600 });
    await chmod(args.output, 0o600);
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
