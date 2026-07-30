#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

const manifestPath = path.resolve(process.argv[2] ?? "rudder.app.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

function fail(message) {
  throw new Error(`Invalid App Builder manifest: ${message}`);
}

function safeRoute(value, label) {
  if (typeof value !== "string"
    || !value.startsWith("/")
    || value.startsWith("//")
    || value.includes("://")
    || value.includes("\\")) fail(`${label} must be an app-relative route`);
}

function safeRelative(value, label) {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value)) {
    fail(`${label} must be a non-empty relative path`);
  }
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    fail(`${label} escapes the app root`);
  }
}

if (manifest?.schemaVersion !== 1) fail("schemaVersion must be 1");
if (manifest?.template?.id !== "rudder-next-sqlite") fail("unsupported template id");
if (!Number.isInteger(manifest?.template?.revision) || manifest.template.revision < 1) {
  fail("template revision must be a positive integer");
}
if (typeof manifest?.app?.name !== "string" || manifest.app.name.trim().length === 0) {
  fail("app name is required");
}
if (typeof manifest?.app?.slug !== "string"
  || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.app.slug)) fail("app slug is invalid");
safeRoute(manifest?.runtime?.openPath, "runtime.openPath");
safeRoute(manifest?.runtime?.readinessPath, "runtime.readinessPath");
if (manifest?.runtime?.engine !== "managed-node-22"
  || manifest?.runtime?.packageManager !== "managed-pnpm") fail("unsupported managed runtime");
if (manifest?.data?.provider !== "sqlite") fail("data provider must be sqlite");
safeRelative(manifest?.data?.productionPath, "data.productionPath");
safeRelative(manifest?.data?.developmentPath, "data.developmentPath");
safeRelative(manifest?.data?.migrationsDir, "data.migrationsDir");
if (manifest?.jobs?.mode !== "in_process" || manifest?.jobs?.lifecycle !== "with_rudder") {
  fail("unsupported jobs lifecycle");
}
if (!Array.isArray(manifest?.secrets)
  || manifest.secrets.some((secret) => (
    !secret
    || typeof secret !== "object"
    || typeof secret.id !== "string"
    || !/^[a-z][a-z0-9_]*$/.test(secret.id)
    || typeof secret.label !== "string"
    || typeof secret.required !== "boolean"
    || Object.hasOwn(secret, "value")
  ))) fail("secrets must be logical bindings without values");

process.stdout.write(`${manifestPath} is a valid App Builder manifest\n`);
