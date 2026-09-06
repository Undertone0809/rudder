#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const MANIFEST_PATH = "scripts/docs-content-map.yml";
const DOCS_JSON_PATH = "docs/docs.json";
const LLMS_PATH = "docs/llms.txt";
const VERCEL_PRODUCTION_REDIRECTS_PATH = "docs/vercel.production.redirects.json";

const PAGE_KINDS = new Set(["home", "get_started", "concept", "how_to", "reference", "project"]);
const PAGE_STATUSES = new Set(["active", "transitional_active", "reserved_batch_3"]);
const METADATA_ENFORCEMENT = new Set(["strict", "reserved"]);
const EXAMPLE_CLASSES = new Set(["real_rudder_case", "anonymized_real_case", "illustrative_case"]);
const REDIRECT_STATUSES = new Set(["active", "reserved_batch_3"]);
const REDIRECT_TARGETS = new Set(["mintlify", "vercel"]);
const DEPLOYMENT_ENVIRONMENTS = new Set(["production"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateString(errors, value, fieldPath, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || value.length === 0) errors.push(`${fieldPath}: expected nonempty string`);
}

function validateStringArray(errors, value, fieldPath, { nonempty = false } = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${fieldPath}: expected array`);
    return;
  }
  if (nonempty && value.length === 0) errors.push(`${fieldPath}: expected nonempty array`);
  value.forEach((item, index) => validateString(errors, item, `${fieldPath}[${index}]`));
}

function validateLocaleMap(errors, value, fieldPath, locales, valueValidator) {
  if (!isObject(value)) {
    errors.push(`${fieldPath}: expected locale map object`);
    return [];
  }
  const keys = Object.keys(value);
  if (keys.length === 0) errors.push(`${fieldPath}: expected at least one locale`);
  for (const locale of keys) {
    if (!locales.includes(locale)) errors.push(`${fieldPath}.${locale}: unknown locale`);
    valueValidator(value[locale], `${fieldPath}.${locale}`);
  }
  return keys;
}

export function validateManifestSchema(manifest) {
  const errors = [];
  if (!isObject(manifest)) return ["manifest: expected object"];
  if (manifest.version !== 1) errors.push("manifest.version: expected 1");
  validateString(errors, manifest.base_url, "manifest.base_url");
  validateStringArray(errors, manifest.locales, "manifest.locales", { nonempty: true });
  const locales = Array.isArray(manifest.locales)
    ? manifest.locales.filter((locale) => typeof locale === "string")
    : [];

  if (!isObject(manifest.navigation_baseline)) {
    errors.push("manifest.navigation_baseline: expected object");
  } else {
    if (!Number.isInteger(manifest.navigation_baseline.groups) || manifest.navigation_baseline.groups < 1) {
      errors.push("manifest.navigation_baseline.groups: expected positive integer");
    }
    validateStringArray(errors, manifest.navigation_baseline.concepts, "manifest.navigation_baseline.concepts");
  }

  if (!isObject(manifest.redirect_policy)) {
    errors.push("manifest.redirect_policy: expected object");
  } else {
    validateStringArray(errors, manifest.redirect_policy.infrastructure_alias_ids, "manifest.redirect_policy.infrastructure_alias_ids");
    validateStringArray(errors, manifest.redirect_policy.static_asset_destinations, "manifest.redirect_policy.static_asset_destinations");
    if (!Array.isArray(manifest.redirect_policy.locale_prefix_transforms)) {
      errors.push("manifest.redirect_policy.locale_prefix_transforms: expected array");
    } else {
      manifest.redirect_policy.locale_prefix_transforms.forEach((transform, index) => {
        const itemPath = `manifest.redirect_policy.locale_prefix_transforms[${index}]`;
        if (!isObject(transform)) {
          errors.push(`${itemPath}: expected object`);
          return;
        }
        validateString(errors, transform.source, `${itemPath}.source`);
        validateString(errors, transform.destination, `${itemPath}.destination`);
      });
    }
    if (!Array.isArray(manifest.redirect_policy.legacy_host_redirects)) {
      errors.push("manifest.redirect_policy.legacy_host_redirects: expected array");
    } else {
      manifest.redirect_policy.legacy_host_redirects.forEach((rule, index) => {
        const itemPath = `manifest.redirect_policy.legacy_host_redirects[${index}]`;
        if (!isObject(rule)) {
          errors.push(`${itemPath}: expected object`);
          return;
        }
        validateString(errors, rule.source_host, `${itemPath}.source_host`);
        validateString(errors, rule.destination_origin, `${itemPath}.destination_origin`);
        validateStringArray(errors, rule.environments, `${itemPath}.environments`, { nonempty: true });
        if (Array.isArray(rule.environments)) rule.environments.forEach((environment) => {
          if (typeof environment === "string" && !DEPLOYMENT_ENVIRONMENTS.has(environment)) {
            errors.push(`${itemPath}.environments: unknown deployment environment ${environment}`);
          }
        });
      });
    }
  }

  if (!Array.isArray(manifest.pages)) {
    errors.push("manifest.pages: expected array");
  } else {
    manifest.pages.forEach((page, index) => {
      const pagePath = `manifest.pages[${index}]`;
      if (!isObject(page)) {
        errors.push(`${pagePath}: expected object`);
        return;
      }
      validateString(errors, page.id, `${pagePath}.id`);
      validateString(errors, page.kind, `${pagePath}.kind`);
      if (typeof page.kind === "string" && !PAGE_KINDS.has(page.kind)) errors.push(`${pagePath}.kind: unknown page kind ${page.kind}`);
      validateString(errors, page.user_job, `${pagePath}.user_job`);
      validateString(errors, page.status, `${pagePath}.status`);
      if (typeof page.status === "string" && !PAGE_STATUSES.has(page.status)) errors.push(`${pagePath}.status: unknown page status ${page.status}`);
      const fileLocales = validateLocaleMap(errors, page.files, `${pagePath}.files`, locales, (value, itemPath) => validateString(errors, value, itemPath));
      const urlLocales = validateLocaleMap(errors, page.urls, `${pagePath}.urls`, locales, (value, itemPath) => validateString(errors, value, itemPath));
      const anchorLocales = validateLocaleMap(errors, page.anchors, `${pagePath}.anchors`, locales, (value, itemPath) => validateStringArray(errors, value, itemPath));
      const expectedLocales = [...fileLocales].sort().join("\0");
      if ([...urlLocales].sort().join("\0") !== expectedLocales) errors.push(`${pagePath}.urls: locale keys must match files`);
      if ([...anchorLocales].sort().join("\0") !== expectedLocales) errors.push(`${pagePath}.anchors: locale keys must match files`);
      for (const field of ["composes", "source_docs", "aliases", "example_ids"]) {
        validateStringArray(errors, page[field], `${pagePath}.${field}`);
      }
      if (typeof page.llms !== "boolean") errors.push(`${pagePath}.llms: expected boolean`);
      validateString(errors, page.pairing_exception, `${pagePath}.pairing_exception`, { nullable: true });
      if (!isObject(page.contracts)) {
        errors.push(`${pagePath}.contracts: expected object`);
      } else {
        validateStringArray(errors, page.contracts.primary, `${pagePath}.contracts.primary`);
        validateStringArray(errors, page.contracts.supporting, `${pagePath}.contracts.supporting`);
      }
      validateString(errors, page.metadata_enforcement, `${pagePath}.metadata_enforcement`);
      if (typeof page.metadata_enforcement === "string" && !METADATA_ENFORCEMENT.has(page.metadata_enforcement)) {
        errors.push(`${pagePath}.metadata_enforcement: unknown value ${page.metadata_enforcement}`);
      }
    });
  }

  if (!Array.isArray(manifest.transitional_files)) {
    errors.push("manifest.transitional_files: expected array");
  } else {
    manifest.transitional_files.forEach((item, index) => {
      const itemPath = `manifest.transitional_files[${index}]`;
      if (!isObject(item)) {
        errors.push(`${itemPath}: expected object`);
        return;
      }
      validateStringArray(errors, item.files, `${itemPath}.files`, { nonempty: true });
      validateString(errors, item.retire_in, `${itemPath}.retire_in`);
      validateString(errors, item.replacement_page, `${itemPath}.replacement_page`);
    });
  }

  if (!Array.isArray(manifest.contract_ownership)) {
    errors.push("manifest.contract_ownership: expected array");
  } else {
    manifest.contract_ownership.forEach((ownership, index) => {
      const itemPath = `manifest.contract_ownership[${index}]`;
      if (!isObject(ownership)) {
        errors.push(`${itemPath}: expected object`);
        return;
      }
      validateString(errors, ownership.id, `${itemPath}.id`);
      if (!new Set(["public", "internal_only"]).has(ownership.visibility)) errors.push(`${itemPath}.visibility: expected public or internal_only`);
      if (ownership.visibility === "public") {
        validateString(errors, ownership.primary_page, `${itemPath}.primary_page`);
        validateStringArray(errors, ownership.supporting_pages, `${itemPath}.supporting_pages`);
      } else if (ownership.visibility === "internal_only") {
        validateString(errors, ownership.reason, `${itemPath}.reason`);
      }
    });
  }

  if (!Array.isArray(manifest.redirects)) {
    errors.push("manifest.redirects: expected array");
  } else {
    manifest.redirects.forEach((redirect, index) => {
      const itemPath = `manifest.redirects[${index}]`;
      if (!isObject(redirect)) {
        errors.push(`${itemPath}: expected object`);
        return;
      }
      for (const field of ["id", "source", "destination", "status"]) validateString(errors, redirect[field], `${itemPath}.${field}`);
      if (typeof redirect.status === "string" && !REDIRECT_STATUSES.has(redirect.status)) errors.push(`${itemPath}.status: unknown redirect status ${redirect.status}`);
      if (redirect.permanent !== true) errors.push(`${itemPath}.permanent: expected true`);
      validateStringArray(errors, redirect.targets, `${itemPath}.targets`, { nonempty: true });
      if (Array.isArray(redirect.targets)) redirect.targets.forEach((target) => {
        if (typeof target === "string" && !REDIRECT_TARGETS.has(target)) errors.push(`${itemPath}.targets: unknown redirect target ${target}`);
      });
      validateString(errors, redirect.owner_page, `${itemPath}.owner_page`, { nullable: true });
      validateString(errors, redirect.locale, `${itemPath}.locale`, { nullable: true });
      if (typeof redirect.locale === "string" && !locales.includes(redirect.locale)) errors.push(`${itemPath}.locale: unknown locale ${redirect.locale}`);
      if (redirect.has !== undefined && !Array.isArray(redirect.has)) {
        errors.push(`${itemPath}.has: expected array`);
      } else if (Array.isArray(redirect.has)) {
        redirect.has.forEach((condition, conditionIndex) => {
          const conditionPath = `${itemPath}.has[${conditionIndex}]`;
          if (!isObject(condition)) {
            errors.push(`${conditionPath}: expected object`);
            return;
          }
          validateString(errors, condition.type, `${conditionPath}.type`);
          validateString(errors, condition.value, `${conditionPath}.value`);
        });
      }
    });
  }

  if (!Array.isArray(manifest.examples)) {
    errors.push("manifest.examples: expected array");
  } else {
    manifest.examples.forEach((example, index) => {
      const itemPath = `manifest.examples[${index}]`;
      if (!isObject(example)) {
        errors.push(`${itemPath}: expected object`);
        return;
      }
      for (const field of ["id", "class", "permission", "starting_request", "surface_choice", "intervention", "outcome"]) {
        validateString(errors, example[field], `${itemPath}.${field}`);
      }
      if (typeof example.class === "string" && !EXAMPLE_CLASSES.has(example.class)) errors.push(`${itemPath}.class: unknown example class ${example.class}`);
      for (const field of ["human_roles", "agent_roles", "artifacts", "evidence"]) validateStringArray(errors, example[field], `${itemPath}.${field}`);
      if (example.permission_evidence !== undefined || example.class === "real_rudder_case") {
        validateStringArray(errors, example.permission_evidence, `${itemPath}.permission_evidence`, { nonempty: example.class === "real_rudder_case" });
      }
    });
  }
  validateString(errors, manifest.alignment_reviews, "manifest.alignment_reviews");
  return errors;
}

export function loadManifest(root = REPO_ROOT) {
  const source = fs.readFileSync(path.join(root, MANIFEST_PATH), "utf8");
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch (error) {
    throw new Error(`${MANIFEST_PATH} must remain JSON-compatible YAML: ${error.message}`);
  }
  const schemaErrors = validateManifestSchema(manifest);
  if (schemaErrors.length > 0) throw new Error(`${MANIFEST_PATH} schema validation failed:\n- ${schemaErrors.join("\n- ")}`);
  return manifest;
}

export function parseFrontmatter(source) {
  if (!source.startsWith("---\n")) return {};
  const end = source.indexOf("\n---", 4);
  if (end === -1) return {};
  const values = {};
  for (const line of source.slice(4, end).split("\n")) {
    const match = line.match(/^(?:"([^"]+)"|([A-Za-z0-9_-]+)):\s*(.*)$/);
    if (!match) continue;
    const key = match[1] ?? match[2];
    const raw = match[3].trim();
    if (!raw || raw === "|") continue;
    values[key] = raw.replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}

export function activePages(manifest) {
  return manifest.pages.filter((page) => ["active", "transitional_active"].includes(page.status));
}

function localeEntries(manifest, { llmsOnly = false } = {}) {
  return activePages(manifest).flatMap((page) => {
    if (llmsOnly && !page.llms) return [];
    return Object.keys(page.files).map((locale) => ({
      locale,
      page,
      file: page.files[locale],
      url: page.urls[locale],
    }));
  });
}

function hostCondition(host) {
  return [{ type: "host", value: host }];
}

function absoluteRedirectDestination(origin, destination) {
  if (/^https?:\/\//u.test(destination)) return destination;
  return `${origin}${destination}`;
}

function replaceRedirectWildcard(pattern, value) {
  return pattern.replace(":path*", value);
}

function composePrefixAliases(aliases) {
  const concreteSources = new Set(
    aliases
      .filter((redirect) => typeof redirect.source === "string" && !redirect.source.includes(":path*"))
      .map((redirect) => `${redirectHostCondition(redirect) ?? ""}\0${redirect.source}`),
  );
  const composed = [];
  for (const prefix of aliases) {
    if (typeof prefix.source !== "string"
      || typeof prefix.destination !== "string"
      || !prefix.source.includes(":path*")
      || !prefix.destination.includes(":path*")) continue;
    const prefixHost = redirectHostCondition(prefix);
    for (const alias of aliases) {
      if (typeof alias.source !== "string"
        || typeof alias.destination !== "string"
        || alias.source.includes(":path*")) continue;
      const aliasHost = redirectHostCondition(alias);
      if (aliasHost && aliasHost !== prefixHost) continue;
      const wildcardValue = matchRedirectSource(prefix.destination, alias.source);
      if (wildcardValue === null) continue;
      const source = replaceRedirectWildcard(prefix.source, wildcardValue);
      const sourceKey = `${prefixHost ?? ""}\0${source}`;
      if (concreteSources.has(sourceKey)) continue;
      concreteSources.add(sourceKey);
      const redirect = { source, destination: alias.destination };
      if ("permanent" in prefix) redirect.permanent = prefix.permanent;
      if (prefix.has) redirect.has = prefix.has;
      composed.push(redirect);
    }
  }
  return [...composed, ...aliases];
}

export function expectedRedirects(manifest, target, { environment = "production" } = {}) {
  if (!DEPLOYMENT_ENVIRONMENTS.has(environment)) throw new Error(`unknown deployment environment ${environment}`);
  const aliases = composePrefixAliases(manifest.redirects
    .filter((redirect) => redirect.status === "active" && redirect.targets.includes(target))
    .map(({ source, destination, permanent, has }) => {
      const result = { source, destination };
      if (target === "vercel") result.permanent = permanent;
      if (target === "vercel" && has) result.has = has;
      return result;
    }));
  if (target !== "vercel") return aliases;

  const legacyRules = manifest.redirect_policy.legacy_host_redirects
    .filter((rule) => rule.environments.includes(environment));
  const expanded = [];
  for (const rule of legacyRules) {
    for (const alias of aliases.filter((item) => !item.has)) {
      expanded.push({
        source: alias.source,
        destination: absoluteRedirectDestination(rule.destination_origin, alias.destination),
        permanent: true,
        has: hostCondition(rule.source_host),
      });
    }
    expanded.push(
      {
        source: "/",
        destination: `${rule.destination_origin}/`,
        permanent: true,
        has: hostCondition(rule.source_host),
      },
      {
        source: "/:path*",
        destination: `${rule.destination_origin}/:path*`,
        permanent: true,
        has: hostCondition(rule.source_host),
      },
    );
  }
  return [...expanded, ...aliases];
}

function matchRedirectSource(source, requestPath) {
  if (typeof source !== "string" || typeof requestPath !== "string") return null;
  const wildcard = ":path*";
  if (!source.includes(wildcard)) return source === requestPath ? "" : null;
  const prefix = source.slice(0, source.indexOf(wildcard));
  if (!requestPath.startsWith(prefix)) return null;
  return requestPath.slice(prefix.length);
}

export function resolveRedirect(redirects, { host, path: requestPath }) {
  for (const redirect of redirects) {
    const requiredHost = redirect.has?.find((condition) => condition.type === "host")?.value;
    if (requiredHost && requiredHost !== host) continue;
    const wildcardValue = matchRedirectSource(redirect.source, requestPath);
    if (wildcardValue === null) continue;
    if (typeof redirect.destination !== "string") continue;
    return replaceRedirectWildcard(redirect.destination, wildcardValue);
  }
  return null;
}

function redirectRequest(destination, currentHost) {
  try {
    const url = new URL(destination);
    return { host: url.host, path: url.pathname };
  } catch {
    return { host: currentHost, path: destination };
  }
}

function redirectWitnesses(redirects, canonicalHost, declaredRedirects = redirects) {
  const witnesses = [];
  const add = (redirect, requestPath) => {
    const host = redirectHostCondition(redirect) ?? canonicalHost;
    if (typeof requestPath === "string" && requestPath.startsWith("/")) witnesses.push({ host, path: requestPath });
  };
  for (const redirect of redirects) {
    if (typeof redirect.source !== "string") continue;
    add(redirect, replaceRedirectWildcard(redirect.source, "__docs_chain_probe__"));
    if (!redirect.source.includes(":path*") || typeof redirect.destination !== "string") continue;
    for (const candidate of declaredRedirects) {
      if (typeof candidate.source !== "string" || candidate.source.includes(":path*")) continue;
      const wildcardValue = matchRedirectSource(redirect.destination, candidate.source);
      if (wildcardValue !== null) add(redirect, replaceRedirectWildcard(redirect.source, wildcardValue));
    }
  }
  return [...new Map(witnesses.map((witness) => [`${witness.host}\0${witness.path}`, witness])).values()];
}

function collectGeneratedRedirectChainErrors(redirects, label, canonicalHost, declaredRedirects) {
  const errors = new Set();
  for (const witness of redirectWitnesses(redirects, canonicalHost, declaredRedirects)) {
    const seen = new Map([[`${witness.host}\0${witness.path}`, 0]]);
    const hops = [];
    let request = witness;
    for (let index = 0; index <= redirects.length; index += 1) {
      const destination = resolveRedirect(redirects, request);
      if (destination === null) break;
      hops.push({ source: request.path, destination });
      if (hops.length === 2) {
        errors.add(`redirect chain for ${label}: ${hops[0].source} -> ${hops[0].destination}`);
      }
      const nextRequest = redirectRequest(destination, request.host);
      const stateKey = `${nextRequest.host}\0${nextRequest.path}`;
      if (seen.has(stateKey)) {
        const cycleStart = seen.get(stateKey);
        const cycle = hops.slice(cycleStart).map((hop) => hop.source);
        errors.add(`redirect loop for ${label}: ${[...cycle, nextRequest.path].join(" -> ")}`);
        break;
      }
      seen.set(stateKey, hops.length);
      request = nextRequest;
    }
  }
  return [...errors];
}

function readPageMetadata(root, entry) {
  const source = fs.readFileSync(path.join(root, entry.file), "utf8");
  return parseFrontmatter(source);
}

export function renderLlms(manifest, root = REPO_ROOT) {
  const kindLabels = {
    home: "Start here",
    get_started: "Get started",
    concept: "Concepts",
    how_to: "How-to guides",
    reference: "Reference",
    project: "Project",
  };
  const localeLabels = { en: "English", zh: "简体中文" };
  const entries = localeEntries(manifest, { llmsOnly: true });
  const lines = [
    "# Rudder Docs",
    "",
    "> Canonical public documentation for Rudder, generated from scripts/docs-content-map.yml.",
    "",
    "Rudder gives humans and agents a shared place to move work from a goal to a reviewable result. Choose Chat for conversational work or an Issue when named ownership, dependencies, or a review path help.",
  ];
  for (const locale of manifest.locales) {
    lines.push("", `## ${localeLabels[locale]}`);
    for (const kind of Object.keys(kindLabels)) {
      const selected = entries.filter((entry) => entry.locale === locale && entry.page.kind === kind);
      if (selected.length === 0) continue;
      lines.push("", `### ${kindLabels[kind]}`);
      for (const entry of selected) {
        const metadata = readPageMetadata(root, entry);
        const description = metadata.description || entry.page.user_job;
        lines.push(`- [${metadata.title || entry.page.id}](${manifest.base_url}${entry.url === "/" ? "" : entry.url}): ${description}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

export function generatedArtifacts(manifest, root = REPO_ROOT) {
  const docsJson = JSON.parse(fs.readFileSync(path.join(root, DOCS_JSON_PATH), "utf8"));
  docsJson.redirects = expectedRedirects(manifest, "mintlify");
  return {
    docsJson: `${JSON.stringify(docsJson, null, 2)}\n`,
    llms: renderLlms(manifest, root),
    vercelProduction: `${JSON.stringify({ redirects: expectedRedirects(manifest, "vercel", { environment: "production" }) }, null, 2)}\n`,
  };
}

function atomicWriteError(message, cause, { phase, committed = false, recoveryArtifacts = [], rollbackErrors = [] }) {
  const error = new Error(message, { cause });
  error.phase = phase;
  error.committed = committed;
  error.recoveryArtifacts = recoveryArtifacts;
  error.rollbackErrors = rollbackErrors;
  return error;
}

function existingRecoveryArtifacts(fileSystem, staged) {
  return staged.flatMap((item) => [item.temporaryPath, item.backupPath, item.destination])
    .filter((artifactPath) => fileSystem.existsSync(artifactPath));
}

export function writeArtifactsAtomically(
  root,
  artifacts,
  { fileSystem = fs, nonceFactory = () => `${process.pid}-${Math.random().toString(16).slice(2)}` } = {},
) {
  const staged = [];
  let phase = "stage";
  try {
    for (const [relativePath, content] of artifacts) {
      const destination = path.join(root, relativePath);
      const nonce = nonceFactory();
      const temporaryPath = `${destination}.tmp-${nonce}`;
      const backupPath = `${destination}.bak-${nonce}`;
      const item = {
        temporaryPath,
        destination,
        backupPath,
        hadDestination: fileSystem.existsSync(destination),
        backupCreated: false,
        installed: false,
      };
      staged.push(item);
      fileSystem.writeFileSync(temporaryPath, content);
    }

    phase = "backup";
    for (const item of staged) {
      if (!item.hadDestination) continue;
      fileSystem.renameSync(item.destination, item.backupPath);
      item.backupCreated = true;
    }

    phase = "install";
    for (const item of staged) {
      fileSystem.renameSync(item.temporaryPath, item.destination);
      item.installed = true;
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const item of [...staged].reverse()) {
      if (item.installed && fileSystem.existsSync(item.destination)) {
        try {
          fileSystem.renameSync(item.destination, item.temporaryPath);
          item.installed = false;
        } catch (rollbackError) {
          rollbackErrors.push(`cannot preserve new artifact ${item.destination} at ${item.temporaryPath}: ${rollbackError.message}`);
        }
      }
      if (item.backupCreated && fileSystem.existsSync(item.backupPath)) {
        if (fileSystem.existsSync(item.destination)) {
          rollbackErrors.push(`cannot restore ${item.backupPath}: destination remains occupied at ${item.destination}`);
          continue;
        }
        try {
          fileSystem.renameSync(item.backupPath, item.destination);
          item.backupCreated = false;
        } catch (rollbackError) {
          rollbackErrors.push(`cannot restore ${item.backupPath} to ${item.destination}: ${rollbackError.message}`);
        }
      }
    }
    const recoveryArtifacts = existingRecoveryArtifacts(fileSystem, staged);
    const rollbackSummary = rollbackErrors.length > 0
      ? `; rollback incomplete: ${rollbackErrors.join("; ")}`
      : "";
    throw atomicWriteError(
      `docs artifact write failed during ${phase}: ${error.message}${rollbackSummary}; recovery artifacts: ${recoveryArtifacts.join(", ") || "none"}`,
      error,
      { phase, recoveryArtifacts, rollbackErrors },
    );
  }

  const cleanupErrors = [];
  for (const item of staged) {
    if (!item.backupCreated || !fileSystem.existsSync(item.backupPath)) continue;
    try {
      fileSystem.unlinkSync(item.backupPath);
      item.backupCreated = false;
    } catch (error) {
      cleanupErrors.push(`cannot delete committed backup ${item.backupPath}: ${error.message}`);
    }
  }
  return {
    committed: true,
    cleanupWarnings: cleanupErrors,
    recoveryArtifacts: existingRecoveryArtifacts(fileSystem, staged),
  };
}

export function generateMetadata(root = REPO_ROOT) {
  const manifest = loadManifest(root);
  const output = generatedArtifacts(manifest, root);
  const writeResult = writeArtifactsAtomically(root, [
    [DOCS_JSON_PATH, output.docsJson],
    [LLMS_PATH, output.llms],
    [VERCEL_PRODUCTION_REDIRECTS_PATH, output.vercelProduction],
  ]);
  for (const warning of writeResult.cleanupWarnings) console.warn(`WARNING: ${warning}`);
  return output;
}

function routeForNavEntry(entry) {
  if (entry === "index") return "/";
  return `/${entry}`;
}

function collectRegistryIds(root) {
  const source = fs.readFileSync(path.join(root, "doc/product/registry.yml"), "utf8");
  return new Set([...source.matchAll(/^  ([A-Z][A-Z0-9_.]+):$/gm)].map((match) => match[1]));
}

function registryContractDocs(root) {
  const registryPath = path.join(root, "doc/product/registry.yml");
  if (!fs.existsSync(registryPath)) return new Map();
  const result = new Map();
  let contractId = null;
  let readingDocs = false;
  for (const line of fs.readFileSync(registryPath, "utf8").split(/\r?\n/u)) {
    const contractMatch = line.match(/^  ([A-Z][A-Z0-9_.]+):\s*$/u);
    if (contractMatch) {
      contractId = contractMatch[1];
      readingDocs = false;
      result.set(contractId, []);
      continue;
    }
    if (!contractId) continue;
    if (/^    docs:\s*$/u.test(line)) {
      readingDocs = true;
      continue;
    }
    if (readingDocs) {
      const docMatch = line.match(/^      -\s+(.+?)\s*$/u);
      if (docMatch) {
        result.get(contractId).push(docMatch[1].replace(/^(?:"(.*)"|'(.*)')$/u, "$1$2"));
        continue;
      }
    }
    if (/^    \S/u.test(line)) readingDocs = false;
  }
  return result;
}

function headingAnchor(text) {
  return text
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-|-$/g, "");
}

function hasAnchor(source, anchor) {
  if (source.includes(`id="${anchor}"`) || source.includes(`id='${anchor}'`)) return true;
  return source
    .split("\n")
    .filter((line) => /^#{2,6}\s+/.test(line))
    .some((line) => headingAnchor(line.replace(/^#{2,6}\s+/, "")) === anchor);
}

function expectedCanonical(manifest, url) {
  return `${manifest.base_url}${url === "/" ? "" : url}`;
}

function readSitemapUrls(root) {
  const source = fs.readFileSync(path.join(root, "docs/sitemap.xml"), "utf8");
  return new Set([...source.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1].replace(/\/$/, "")));
}

function redirectHostCondition(redirect) {
  return redirect.has?.find((condition) => condition.type === "host")?.value;
}

function routeLocale(route) {
  if (typeof route !== "string") return null;
  if (route === "/zh" || route.startsWith("/zh/")) return "zh";
  if (route.startsWith("/")) return "en";
  return null;
}

function collectRedirectErrors(manifest, canonicalUrls, declaredUrls = canonicalUrls) {
  const errors = [];
  const allowedStatuses = new Set(["active", "reserved_batch_3"]);
  const allowedTargets = new Set(["mintlify", "vercel"]);
  const policy = manifest.redirect_policy ?? {};
  const infrastructureIds = new Set(policy.infrastructure_alias_ids ?? []);
  const staticDestinations = new Set(policy.static_asset_destinations ?? []);
  const localeTransforms = new Set(
    (policy.locale_prefix_transforms ?? []).map(({ source, destination }) => `${source}\0${destination}`),
  );
  const legacyHostRules = policy.legacy_host_redirects ?? [];
  const allowedLegacyHosts = new Set(legacyHostRules.map((rule) => rule.source_host));
  const redirectsById = new Map();

  for (const [index, redirect] of manifest.redirects.entries()) {
    const hasId = typeof redirect.id === "string" && redirect.id.length > 0;
    const label = hasId ? redirect.id : `redirect at index ${index}`;
    if (!hasId) {
      errors.push(`redirect at index ${index}: missing id`);
    } else {
      const matches = redirectsById.get(redirect.id) ?? [];
      matches.push(redirect);
      redirectsById.set(redirect.id, matches);
    }
    if (!allowedStatuses.has(redirect.status)) {
      errors.push(`${label}: unknown redirect status ${redirect.status}`);
    }
    if (!Array.isArray(redirect.targets) || redirect.targets.length === 0) {
      errors.push(`${label}: targets must be a nonempty array`);
    } else {
      for (const target of redirect.targets) {
        if (!allowedTargets.has(target)) errors.push(`${label}: unknown redirect target ${target}`);
      }
    }
    if (redirect.permanent !== true) errors.push(`${label}: permanent must be true`);
  }
  for (const [id, redirects] of redirectsById) {
    if (redirects.length > 1) errors.push(`duplicate redirect id: ${id}`);
  }

  const active = manifest.redirects.filter((redirect) => redirect.status === "active");
  const governed = manifest.redirects.filter((redirect) => allowedStatuses.has(redirect.status));
  const sourcesByTarget = new Map();
  for (const [index, redirect] of governed.entries()) {
    const label = typeof redirect.id === "string" && redirect.id.length > 0
      ? redirect.id
      : `active redirect at index ${index}`;
    const hasSource = typeof redirect.source === "string" && redirect.source.startsWith("/");
    const hasDestination = typeof redirect.destination === "string" && redirect.destination.length > 0;
    if (!hasSource) errors.push(`${label}: invalid or missing redirect source`);
    if (!hasDestination) errors.push(`${label}: missing redirect destination`);
    const targets = Array.isArray(redirect.targets) ? redirect.targets : [];
    for (const target of redirect.status === "active" ? targets : []) {
      const key = `${target}\0${redirect.source}`;
      if (sourcesByTarget.has(key)) {
        errors.push(`duplicate active redirect source for ${target}: ${redirect.source}`);
      } else {
        sourcesByTarget.set(key, redirect.id);
      }
    }

    const hostCondition = redirectHostCondition(redirect);
    const isCanonical = declaredUrls.has(redirect.destination);
    const isStaticAsset = staticDestinations.has(redirect.destination);
    const isLocaleTransform = localeTransforms.has(`${redirect.source}\0${redirect.destination}`);
    let isPermittedAbsolute = false;
    try {
      const destination = new URL(redirect.destination);
      isPermittedAbsolute = legacyHostRules.some(
        (rule) => rule.source_host === hostCondition && rule.destination_origin === destination.origin,
      );
    } catch {
      // Relative destinations are checked against canonical and policy routes above.
    }
    if (hasDestination && !isCanonical && !isStaticAsset && !isLocaleTransform && !isPermittedAbsolute) {
      errors.push(`${label}: invalid active redirect destination ${redirect.destination}`);
    }

    const hasApprovedVercelHostScope = Boolean(hostCondition)
      && allowedLegacyHosts.has(hostCondition)
      && targets.length > 0
      && targets.every((target) => target === "vercel");
    if (hostCondition && targets.some((target) => target !== "vercel")) {
      errors.push(`${label}: conditional redirects may target only vercel`);
    }
    if (redirect.status === "active" && hasSource && canonicalUrls.has(redirect.source) && !hasApprovedVercelHostScope) {
      errors.push(`${label}: active redirect source collides with canonical URL ${redirect.source}`);
    }

    const sourceLocale = hasSource ? routeLocale(redirect.source) : null;
    const destinationLocale = hasDestination && redirect.destination.startsWith("/")
      ? routeLocale(redirect.destination)
      : null;
    if (sourceLocale === "zh" && destinationLocale !== "zh") {
      errors.push(`${label}: Chinese alias redirects across languages to ${redirect.destination}`);
    }
    if (sourceLocale === "en" && destinationLocale === "zh") {
      errors.push(`${label}: English alias redirects across languages to ${redirect.destination}`);
    }
  }

  const redirectTargets = new Set(active.flatMap((redirect) => Array.isArray(redirect.targets) ? redirect.targets : []));
  let canonicalHost = "canonical.example";
  try {
    canonicalHost = new URL(manifest.base_url).host;
  } catch {
    // Schema validation reports an invalid base URL; chain checks can use a neutral host.
  }
  for (const target of redirectTargets) {
    const declaredRedirects = active.filter(
      (redirect) => Array.isArray(redirect.targets) && redirect.targets.includes(target),
    );
    const configurations = [{
      environment: "production",
      label: target === "vercel" ? "vercel/production" : target,
    }];
    for (const configuration of configurations) {
      const generatedRedirects = expectedRedirects(manifest, target, { environment: configuration.environment });
      errors.push(...collectGeneratedRedirectChainErrors(
        generatedRedirects,
        configuration.label,
        canonicalHost,
        declaredRedirects,
      ));
    }
  }

  const aliasOwners = new Map();
  for (const page of manifest.pages) {
    for (const aliasId of page.aliases ?? []) {
      const priorOwner = aliasOwners.get(aliasId);
      if (priorOwner && priorOwner !== page.id) {
        errors.push(`${aliasId}: alias identifier is owned by both ${priorOwner} and ${page.id}`);
      } else {
        aliasOwners.set(aliasId, page.id);
      }
      const matches = redirectsById.get(aliasId) ?? [];
      if (matches.length !== 1) {
        errors.push(`${page.id}: alias ${aliasId} must resolve to exactly one manifest redirect`);
        continue;
      }
      const redirect = matches[0];
      if (infrastructureIds.has(aliasId)) continue;
      if (redirect.owner_page !== page.id) {
        errors.push(`${page.id}: alias ${aliasId} owner_page must be ${page.id}`);
      }
      const locale = redirect.locale;
      if (!locale || routeLocale(redirect.source) !== locale) {
        errors.push(`${page.id}: alias ${aliasId} locale must match its source route`);
      }
      const expectedDestination = page.urls[locale];
      const isDeclaredLocaleTransform = localeTransforms.has(`${redirect.source}\0${redirect.destination}`);
      if (!isDeclaredLocaleTransform && (!expectedDestination || redirect.destination !== expectedDestination)) {
        errors.push(`${page.id}: alias ${aliasId} must redirect to ${expectedDestination ?? "a matching locale URL"}`);
      }
    }
  }

  for (const id of infrastructureIds) {
    if ((redirectsById.get(id) ?? []).length !== 1) {
      errors.push(`infrastructure alias ${id} must resolve to exactly one manifest redirect`);
    }
  }

  for (const redirect of governed) {
    if (infrastructureIds.has(redirect.id)) continue;
    if (!redirect.owner_page) {
      errors.push(`${redirect.id}: non-infrastructure redirect requires owner_page`);
      continue;
    }
    const owner = manifest.pages.find((page) => page.id === redirect.owner_page);
    if (!owner) {
      errors.push(`${redirect.id}: unknown redirect owner_page ${redirect.owner_page}`);
      continue;
    }
    if (!(owner.aliases ?? []).includes(redirect.id)) {
      errors.push(`${redirect.id}: owner page ${owner.id} must list the redirect in aliases`);
    }
  }

  return errors;
}

function canCollectSemanticErrors(manifest) {
  const isStringArray = (value) => Array.isArray(value)
    && value.every((item) => typeof item === "string");
  const isStringMap = (value) => isObject(value)
    && Object.values(value).every((item) => typeof item === "string");
  const isStringArrayMap = (value) => isObject(value)
    && Object.values(value).every((item) => isStringArray(item));

  if (!isObject(manifest)) return false;
  if (!isStringArray(manifest.locales)
    || !isObject(manifest.navigation_baseline)
    || !isStringArray(manifest.navigation_baseline.concepts)
    || !isObject(manifest.redirect_policy)
    || !isStringArray(manifest.redirect_policy.infrastructure_alias_ids)
    || !isStringArray(manifest.redirect_policy.static_asset_destinations)
    || !Array.isArray(manifest.redirect_policy.locale_prefix_transforms)
    || !Array.isArray(manifest.redirect_policy.legacy_host_redirects)
    || !Array.isArray(manifest.pages)
    || !Array.isArray(manifest.transitional_files)
    || !Array.isArray(manifest.contract_ownership)
    || !Array.isArray(manifest.redirects)
    || !Array.isArray(manifest.examples)) return false;

  return manifest.redirect_policy.locale_prefix_transforms.every((item) => isObject(item))
    && manifest.redirect_policy.legacy_host_redirects.every((item) => isObject(item)
      && isStringArray(item.environments))
    && manifest.pages.every((page) => isObject(page)
      && isStringMap(page.files)
      && isStringMap(page.urls)
      && isStringArrayMap(page.anchors)
      && isStringArray(page.composes)
      && isStringArray(page.source_docs)
      && isStringArray(page.aliases)
      && isStringArray(page.example_ids)
      && isObject(page.contracts)
      && isStringArray(page.contracts.primary)
      && isStringArray(page.contracts.supporting))
    && manifest.transitional_files.every((item) => isObject(item)
      && isStringArray(item.files)
      && typeof item.replacement_page === "string")
    && manifest.contract_ownership.every((ownership) => isObject(ownership)
      && (ownership.visibility !== "public" || isStringArray(ownership.supporting_pages)))
    && manifest.redirects.every((redirect) => isObject(redirect)
      && isStringArray(redirect.targets))
    && manifest.examples.every((example) => isObject(example)
      && isStringArray(example.evidence)
      && (example.class !== "real_rudder_case" || isStringArray(example.permission_evidence)));
}

export function collectIntegrityErrors({ root = REPO_ROOT, manifest = loadManifest(root) } = {}) {
  const schemaErrors = validateManifestSchema(manifest);
  const errors = schemaErrors.map((error) => `manifest schema: ${error}`);
  if (!canCollectSemanticErrors(manifest)) return errors;
  const pageIds = new Set();
  const urlOwners = new Map();
  const exampleIds = new Set(manifest.examples.map((example) => example.id));
  const registryIds = collectRegistryIds(root);
  const active = activePages(manifest);

  for (const page of manifest.pages) {
    if (pageIds.has(page.id)) errors.push(`duplicate page id: ${page.id}`);
    pageIds.add(page.id);
    for (const field of ["kind", "user_job", "status", "files", "urls", "anchors", "composes", "source_docs", "llms", "aliases", "example_ids", "contracts"]) {
      if (!(field in page)) errors.push(`${page.id}: missing ${field}`);
    }
    for (const exampleId of page.example_ids ?? []) {
      if (!exampleIds.has(exampleId)) errors.push(`${page.id}: unknown example ${exampleId}`);
    }
    for (const sourceDoc of page.source_docs ?? []) {
      if (!fs.existsSync(path.join(root, sourceDoc))) errors.push(`${page.id}: missing source document ${sourceDoc}`);
    }
    for (const contractId of [...(page.contracts.primary ?? []), ...(page.contracts.supporting ?? [])]) {
      if (!registryIds.has(contractId)) errors.push(`${page.id}: unknown product contract ${contractId}`);
    }
    if (!["active", "transitional_active"].includes(page.status)) continue;
    const locales = Object.keys(page.files);
    if (locales.length < manifest.locales.length && !page.pairing_exception) {
      errors.push(`${page.id}: locale pair missing without pairing_exception`);
    }
    for (const locale of locales) {
      const relativeFile = page.files[locale];
      const absoluteFile = path.join(root, relativeFile);
      if (!fs.existsSync(absoluteFile)) {
        errors.push(`${page.id}/${locale}: missing file ${relativeFile}`);
        continue;
      }
      const url = page.urls[locale];
      if (!url?.startsWith("/")) errors.push(`${page.id}/${locale}: invalid URL ${url}`);
      if (urlOwners.has(url)) errors.push(`${page.id}/${locale}: duplicate canonical URL ${url}`);
      urlOwners.set(url, `${page.id}/${locale}`);
      const source = fs.readFileSync(absoluteFile, "utf8");
      const metadata = parseFrontmatter(source);
      const canonical = expectedCanonical(manifest, url);
      if (metadata.canonical !== canonical) errors.push(`${page.id}/${locale}: canonical must be ${canonical}`);
      if (metadata["og:url"] !== canonical) errors.push(`${page.id}/${locale}: og:url must be ${canonical}`);
      if (page.metadata_enforcement === "strict") {
        for (const [alternateLocale, alternateUrl] of Object.entries(page.urls)) {
          const expected = expectedCanonical(manifest, alternateUrl);
          if (metadata[`hreflang_${alternateLocale}`] !== expected) {
            errors.push(`${page.id}/${locale}: hreflang_${alternateLocale} must be ${expected}`);
          }
        }
      }
      for (const anchor of page.anchors[locale] ?? []) {
        if (!hasAnchor(source, anchor)) errors.push(`${page.id}/${locale}: missing stable anchor #${anchor}`);
      }
    }
  }

  const declaredUrls = new Set(manifest.pages.flatMap((page) => Object.values(page.urls)));
  errors.push(...collectRedirectErrors(manifest, new Set(urlOwners.keys()), declaredUrls));

  for (const page of manifest.pages) {
    for (const composedId of page.composes ?? []) {
      if (!pageIds.has(composedId)) errors.push(`${page.id}: unknown composed page ${composedId}`);
    }
  }

  for (const [index, transition] of manifest.transitional_files.entries()) {
    for (const relativeFile of transition.files) {
      if (!fs.existsSync(path.join(root, relativeFile))) {
        errors.push(`transitional_files[${index}]: missing transitional file ${relativeFile}`);
      }
    }
    const replacement = manifest.pages.find((page) => page.id === transition.replacement_page);
    if (!replacement) {
      errors.push(`transitional_files[${index}]: unknown replacement page ${transition.replacement_page}`);
    } else if (!["active", "transitional_active"].includes(replacement.status)) {
      errors.push(`transitional_files[${index}]: replacement page ${transition.replacement_page} must be active or transitional_active`);
    }
  }

  const publicOwners = new Map();
  for (const ownership of manifest.contract_ownership) {
    if (!registryIds.has(ownership.id)) errors.push(`unknown product contract: ${ownership.id}`);
    if (ownership.visibility === "internal_only") {
      if (!ownership.reason) errors.push(`${ownership.id}: internal_only requires reason`);
      if (ownership.primary_page) errors.push(`${ownership.id}: internal_only cannot have a public primary_page`);
      continue;
    }
    const primaryPage = manifest.pages.find((page) => page.id === ownership.primary_page);
    if (!primaryPage) {
      errors.push(`${ownership.id}: unknown primary page ${ownership.primary_page}`);
    } else if (!["active", "transitional_active"].includes(primaryPage.status)) {
      errors.push(`${ownership.id}: primary page ${ownership.primary_page} must be active or transitional_active`);
    }
    if (publicOwners.has(ownership.id)) errors.push(`${ownership.id}: multiple primary owners`);
    publicOwners.set(ownership.id, ownership.primary_page);
    for (const supporting of ownership.supporting_pages ?? []) {
      if (!pageIds.has(supporting)) errors.push(`${ownership.id}: unknown supporting page ${supporting}`);
    }
    const declaredPrimary = manifest.pages.filter((page) => page.contracts.primary.includes(ownership.id));
    if (declaredPrimary.length !== 1 || declaredPrimary[0].id !== ownership.primary_page) {
      errors.push(`${ownership.id}: primary ownership does not match page declaration`);
    }
    const declaredSupporting = manifest.pages
      .filter((page) => page.contracts.supporting.includes(ownership.id))
      .map((page) => page.id)
      .sort();
    const ownedSupporting = [...(ownership.supporting_pages ?? [])].sort();
    if (JSON.stringify(declaredSupporting) !== JSON.stringify(ownedSupporting)) {
      errors.push(`${ownership.id}: supporting ownership does not match page declarations`);
    }
  }

  for (const example of manifest.examples) {
    if (example.class === "real_rudder_case") {
      for (const field of ["starting_request", "surface_choice", "human_roles", "agent_roles", "intervention", "artifacts", "outcome", "evidence", "permission"]) {
        if (!example[field] || (Array.isArray(example[field]) && example[field].length === 0)) {
          errors.push(`${example.id}: real case missing ${field}`);
        }
      }
      if (!["rudder-0-5-0-release", "steer-fix"].includes(example.id)) errors.push(`${example.id}: is not approved as a real case`);
      for (const field of ["permission_evidence", "evidence"]) {
        for (const locator of example[field]) {
          const hashIndex = locator.indexOf("#");
          const relativeFile = hashIndex === -1 ? locator : locator.slice(0, hashIndex);
          const anchor = hashIndex === -1 ? null : locator.slice(hashIndex + 1);
          if (!relativeFile || (hashIndex !== -1 && !anchor)) {
            errors.push(`${example.id}: ${field} locator must be a file path with an optional nonempty anchor: ${locator}`);
            continue;
          }
          const absoluteRoot = path.resolve(root);
          const absoluteFile = path.resolve(absoluteRoot, relativeFile);
          const relativeToRoot = path.relative(absoluteRoot, absoluteFile);
          if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
            errors.push(`${example.id}: ${field} locator must stay within the repository root: ${locator}`);
            continue;
          }
          if (!fs.existsSync(absoluteFile)) {
            errors.push(`${example.id}: ${field} locator is missing ${relativeFile}`);
            continue;
          }
          if (!fs.statSync(absoluteFile).isFile()) {
            errors.push(`${example.id}: ${field} locator must reference a file: ${relativeFile}`);
            continue;
          }
          if (anchor && !hasAnchor(fs.readFileSync(absoluteFile, "utf8"), anchor)) {
            errors.push(`${example.id}: ${field} locator is missing anchor #${anchor} in ${relativeFile}`);
          }
        }
      }
    }
    if (/performance|contract-audit|operations/.test(example.id) && example.class !== "illustrative_case") {
      errors.push(`${example.id}: must remain illustrative until evidence and permission are complete`);
    }
  }

  const docsJson = JSON.parse(fs.readFileSync(path.join(root, DOCS_JSON_PATH), "utf8"));
  const languages = docsJson.navigation?.languages ?? [];
  for (const language of languages) {
    if (language.groups.length !== manifest.navigation_baseline.groups) {
      errors.push(`navigation/${language.language}: expected ${manifest.navigation_baseline.groups} groups`);
    }
    const conceptGroup = language.groups[1];
    const conceptOrder = conceptGroup.pages.map((entry) => entry.split("/").at(-1));
    if (JSON.stringify(conceptOrder) !== JSON.stringify(manifest.navigation_baseline.concepts)) {
      errors.push(`navigation/${language.language}: Concepts order differs from baseline`);
    }
    for (const navPage of language.groups.flatMap((group) => group.pages)) {
      const route = routeForNavEntry(navPage);
      if (!urlOwners.has(route)) errors.push(`navigation/${language.language}: ${route} has no active canonical page`);
    }
  }
  const navRoutes = new Set(languages.flatMap((language) => language.groups.flatMap((group) => group.pages.map(routeForNavEntry))));
  for (const page of active) {
    for (const url of Object.values(page.urls)) {
      if (!navRoutes.has(url)) errors.push(`${page.id}: active canonical URL ${url} is missing from navigation`);
    }
  }

  const sitemapUrls = readSitemapUrls(root);
  for (const entry of localeEntries(manifest)) {
    const canonical = expectedCanonical(manifest, entry.url).replace(/\/$/, "");
    if (!sitemapUrls.has(canonical)) errors.push(`${entry.page.id}/${entry.locale}: missing from sitemap.xml`);
  }

  let generated;
  try {
    generated = generatedArtifacts(manifest, root);
  } catch (error) {
    errors.push(`cannot generate metadata: ${error.message}`);
  }
  if (generated) {
    if (fs.readFileSync(path.join(root, DOCS_JSON_PATH), "utf8") !== generated.docsJson) errors.push("docs/docs.json redirects are not generated from the manifest");
    if (!fs.existsSync(path.join(root, VERCEL_PRODUCTION_REDIRECTS_PATH)) || fs.readFileSync(path.join(root, VERCEL_PRODUCTION_REDIRECTS_PATH), "utf8") !== generated.vercelProduction) errors.push("docs/vercel.production.redirects.json is stale or missing");
    if (fs.readFileSync(path.join(root, LLMS_PATH), "utf8") !== generated.llms) errors.push("docs/llms.txt is stale");
  }

  const llms = fs.readFileSync(path.join(root, LLMS_PATH), "utf8");
  for (const entry of localeEntries(manifest, { llmsOnly: true })) {
    const canonical = expectedCanonical(manifest, entry.url);
    if (!llms.includes(`](${canonical})`)) errors.push(`${entry.page.id}/${entry.locale}: missing from llms.txt`);
  }
  for (const redirect of manifest.redirects.filter((item) => item.status === "active")) {
    if (llms.includes(`](${manifest.base_url}${redirect.source})`)) errors.push(`alias ${redirect.source} must not appear in llms.txt`);
  }

  for (const relativeFile of fs.readdirSync(path.join(root, "docs"), { recursive: true }).filter((file) => file.endsWith(".mdx"))) {
    const source = fs.readFileSync(path.join(root, "docs", relativeFile), "utf8");
    if (/structured task|结构化任务/i.test(source)) errors.push(`docs/${relativeFile}: forbidden public Issue phrase`);
  }
  return errors;
}

function contentDigest(root, paths) {
  const hash = createHash("sha256");
  for (const relativePath of [...new Set(paths)].sort()) {
    const absolutePath = path.join(root, relativePath);
    hash.update(relativePath);
    if (!fs.existsSync(absolutePath)) {
      hash.update("\0missing\0");
      continue;
    }
    const stat = fs.statSync(absolutePath);
    const files = stat.isDirectory()
      ? fs.readdirSync(absolutePath, { recursive: true })
        .filter((entry) => fs.statSync(path.join(absolutePath, entry)).isFile())
        .sort()
        .map((entry) => path.join(relativePath, entry))
      : [relativePath];
    for (const file of files) {
      hash.update(file);
      hash.update(fs.readFileSync(path.join(root, file)));
    }
  }
  return hash.digest("hex");
}

export function alignmentReminderRecords({ root = REPO_ROOT, manifest = loadManifest(root) } = {}) {
  const records = [];
  const contractDocs = registryContractDocs(root);
  for (const page of activePages(manifest)) {
    const resolvedContractDocs = [...page.contracts.primary, ...page.contracts.supporting]
      .flatMap((contractId) => contractDocs.get(contractId) ?? []);
    const inputs = [...Object.values(page.files), ...page.source_docs, ...resolvedContractDocs];
    const fingerprint = contentDigest(root, inputs);
    if (Object.keys(page.files).length > 1) records.push({
      reminder: `${page.id}: reviewer should compare English and Chinese counterparts`,
      fingerprint,
    });
    if (Object.keys(page.files).length === 1) records.push({
      reminder: `${page.id}: ${page.pairing_exception}`,
      fingerprint,
    });
    if (page.contracts.primary.length + page.contracts.supporting.length > 0) records.push({
      reminder: `${page.id}: reviewer should compare public facts with ${[...page.contracts.primary, ...page.contracts.supporting].join(", ")}`,
      fingerprint,
    });
  }
  return records;
}

export function runAlignment({ root = REPO_ROOT, manifest = loadManifest(root), reviews: suppliedReviews } = {}) {
  const reviewPath = path.join(root, manifest.alignment_reviews);
  const reviews = suppliedReviews ?? JSON.parse(fs.readFileSync(reviewPath, "utf8"));
  const warnings = [];
  const isNonblankString = (value) => typeof value === "string" && value.trim().length > 0;
  for (const item of reviews.classifications) {
    if (!reviews.allowed_classifications.includes(item.classification)) {
      warnings.push(`review classification for ${item.reminder} must be fixed, intentional, or false-positive`);
    }
    if (!isNonblankString(item.fingerprint) || !isNonblankString(item.reviewed_revision)) {
      warnings.push(`review classification for ${item.reminder} requires fingerprint and reviewed_revision`);
    }
  }
  const classified = new Set(reviews.classifications
    .filter((item) => reviews.allowed_classifications.includes(item.classification)
      && isNonblankString(item.fingerprint)
      && isNonblankString(item.reviewed_revision))
    .map((item) => `${item.reminder}\0${item.fingerprint}`));
  const records = alignmentReminderRecords({ root, manifest });
  warnings.push(...records
    .filter((record) => !classified.has(`${record.reminder}\0${record.fingerprint}`))
    .map((record) => record.reminder));
  return { warnings, records, exitCode: 0 };
}

function main() {
  const command = process.argv[2];
  if (command === "generate") {
    generateMetadata();
    console.log("Generated docs metadata from scripts/docs-content-map.yml");
    return;
  }
  if (command === "integrity") {
    const errors = collectIntegrityErrors();
    if (errors.length > 0) {
      for (const error of errors) console.error(`ERROR: ${error}`);
      process.exitCode = 1;
    } else {
      console.log("Docs integrity checks passed");
    }
    return;
  }
  if (command === "alignment") {
    const result = runAlignment();
    for (const warning of result.warnings) console.warn(`REMINDER: ${warning}`);
    console.log(`Docs alignment reported ${result.warnings.length} reminder(s); semantic validation requires reviewer judgment.`);
    process.exitCode = 0;
    return;
  }
  console.error("Usage: node scripts/docs-content-map.mjs <generate|integrity|alignment>");
  process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
