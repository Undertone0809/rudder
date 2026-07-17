#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CONFIG = fileURLToPath(new URL("./architecture-boundaries.json", import.meta.url));
const IMPORT_SPECIFIER_PATTERN = /(?:\b(?:import|export)\s+(?:type\s+)?(?:[^;]*?\s+from\s+)?|\bimport\s*\(|\brequire\s*\()\s*(?:["']([^"']+)["']|`([^`$]+)`)/g;

function parseArgs(argv) {
  const options = { config: DEFAULT_CONFIG, json: false, root: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--root" || arg === "--config") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = path.resolve(value);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/architecture-boundaries.mjs [options]

Checks cycles and public-facade bypasses only for domains declared in the config.
Unmigrated areas stay visible as observed scope and are not reported as enforced.

Options:
  --root <path>    Repository root. Defaults to cwd.
  --config <path>  Boundary declaration JSON.
  --json           Print machine-readable JSON.
  -h, --help       Show this help.`);
}

function auditBoundaries(root, configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  validateConfig(config);
  const normalizedRoot = path.resolve(root);
  const files = walkSourceFiles(normalizedRoot, config.productionRoots);
  const domains = config.domains.map((domain) => compileDomain(domain));
  const domainByFile = new Map();

  for (const file of files) {
    const owners = domains.filter((domain) => domain.include.some((pattern) => pattern.test(file)));
    if (owners.length > 1) {
      throw new Error(`${file} belongs to multiple declared domains: ${owners.map((domain) => domain.id).join(", ")}`);
    }
    if (owners[0]) domainByFile.set(file, owners[0]);
  }
  for (const domain of domains) {
    const ownedFiles = [...domainByFile.values()].filter((owner) => owner.id === domain.id).length;
    if (ownedFiles === 0) throw new Error(`${domain.id} does not match any production source files`);
    for (const entrypoint of domain.publicEntrypoints) {
      if (!fs.existsSync(path.join(normalizedRoot, entrypoint))) {
        throw new Error(`${domain.id} public entrypoint does not exist: ${entrypoint}`);
      }
    }
  }

  const graph = new Map(domains.map((domain) => [domain.id, new Set()]));
  const facadeBypasses = [];
  for (const sourceFile of files) {
    const sourceDomain = domainByFile.get(sourceFile) ?? null;
    const content = fs.readFileSync(path.join(normalizedRoot, sourceFile), "utf8");
    for (const specifier of readImportSpecifiers(content)) {
      const target = resolveImport({ config, domains, root: normalizedRoot, sourceFile, specifier });
      if (!target) continue;
      const targetDomain = domainByFile.get(target.path) ?? target.domain ?? null;
      if (!targetDomain || targetDomain.id === sourceDomain?.id) continue;

      if (sourceDomain) graph.get(sourceDomain.id).add(targetDomain.id);
      if (!isPublicImport(targetDomain, target.path, specifier)) {
        facadeBypasses.push({
          domain: targetDomain.id,
          importedPath: target.path,
          source: sourceFile,
          specifier,
        });
      }
    }
  }

  const cycles = findCycles(graph);
  facadeBypasses.sort((left, right) => left.source.localeCompare(right.source) || left.specifier.localeCompare(right.specifier));
  return {
    config: toPosix(path.relative(normalizedRoot, configPath)),
    cycles,
    declaredDomains: domains.map(({ area, id }) => ({ area, id })),
    facadeBypasses,
    observed: config.observed,
    root: normalizedRoot,
    scannedFiles: files.length,
    scope: config.scope,
    violations: cycles.length + facadeBypasses.length,
  };
}

function validateConfig(config) {
  if (config?.version !== 1) throw new Error("boundary config version must be 1");
  if (config.scope !== "declared-only") throw new Error('boundary config scope must be "declared-only"');
  if (!Array.isArray(config.productionRoots) || config.productionRoots.length === 0) {
    throw new Error("boundary config requires productionRoots");
  }
  if (!Array.isArray(config.domains) || config.domains.length === 0) {
    throw new Error("boundary config requires domains");
  }
  const ids = new Set();
  for (const domain of config.domains) {
    if (typeof domain.id !== "string" || !domain.id) throw new Error("declared domain requires id");
    if (ids.has(domain.id)) throw new Error(`duplicate declared domain: ${domain.id}`);
    ids.add(domain.id);
    if (typeof domain.area !== "string" || !domain.area) throw new Error(`${domain.id} requires area`);
    if (!Array.isArray(domain.include) || domain.include.length === 0) throw new Error(`${domain.id} requires include patterns`);
    if (!Array.isArray(domain.publicEntrypoints) || domain.publicEntrypoints.length === 0) {
      throw new Error(`${domain.id} requires publicEntrypoints`);
    }
    for (const entrypoint of domain.publicEntrypoints) {
      if (!domain.include.some((pattern) => globToRegExp(pattern).test(entrypoint))) {
        throw new Error(`${domain.id} public entrypoint is outside its declared include scope: ${entrypoint}`);
      }
    }
    for (const [specifier, entrypoint] of Object.entries(domain.entrypoints ?? {})) {
      if (!domain.publicEntrypoints.includes(entrypoint)) {
        throw new Error(`${domain.id} specifier ${specifier} does not resolve to a public entrypoint: ${entrypoint}`);
      }
    }
  }
}

function compileDomain(domain) {
  return {
    ...domain,
    include: domain.include.map(globToRegExp),
    publicEntrypoints: new Set(domain.publicEntrypoints),
    publicSpecifiers: new Set(Object.keys(domain.entrypoints ?? {})),
  };
}

function walkSourceFiles(root, productionRoots) {
  const files = [];
  const stack = productionRoots.map((entry) => path.join(root, entry)).filter((entry) => fs.existsSync(entry));
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      const relativePath = toPosix(path.relative(root, fullPath));
      if (entry.isDirectory()) {
        if (!["build", "coverage", "dist", "generated", "node_modules"].includes(entry.name)) stack.push(fullPath);
      } else if (entry.isFile() && isProductionSourceFile(relativePath)) {
        files.push(relativePath);
      }
    }
  }
  return files.sort();
}

function isProductionSourceFile(filePath) {
  return /\.(?:ts|tsx)$/.test(filePath) && !/\.d\.ts$/.test(filePath) && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(filePath) && !filePath.includes("/__tests__/") && !filePath.startsWith("packages/plugins/examples/");
}

function readImportSpecifiers(content) {
  const specifiers = [];
  for (const match of content.matchAll(IMPORT_SPECIFIER_PATTERN)) specifiers.push(match[1] ?? match[2]);
  return specifiers;
}

function resolveImport({ config, domains, root, sourceFile, specifier }) {
  for (const domain of domains) {
    const entrypoint = domain.entrypoints?.[specifier];
    if (entrypoint) return { domain, path: entrypoint };
    const prefix = domain.specifierRoot?.prefix;
    if (prefix && specifier.startsWith(`${prefix}/`)) {
      const subpath = specifier.slice(prefix.length + 1);
      return {
        domain,
        path: resolveSourcePath(root, `${domain.specifierRoot.path}/${subpath}`) ?? `${domain.specifierRoot.path}/${subpath}.ts`,
      };
    }
  }

  let candidate = null;
  if (specifier.startsWith(".")) {
    candidate = toPosix(path.posix.normalize(path.posix.join(path.posix.dirname(sourceFile), specifier)));
  } else {
    for (const [prefix, targetRoot] of Object.entries(config.aliases ?? {})) {
      if (specifier.startsWith(prefix)) {
        candidate = `${targetRoot}${specifier.slice(prefix.length)}`;
        break;
      }
    }
  }
  if (!candidate) return null;
  const resolved = resolveSourcePath(root, candidate);
  return resolved ? { domain: null, path: resolved } : null;
}

function resolveSourcePath(root, candidate) {
  const withoutExtension = candidate.replace(/\.(?:js|jsx|mjs|cjs)$/, "");
  const candidates = [candidate, `${withoutExtension}.ts`, `${withoutExtension}.tsx`, `${withoutExtension}/index.ts`, `${withoutExtension}/index.tsx`];
  return candidates.find((entry) => fs.existsSync(path.join(root, entry))) ?? null;
}

function isPublicImport(domain, targetPath, specifier) {
  return domain.publicEntrypoints.has(targetPath) && (!specifier.startsWith(domain.specifierRoot?.prefix ?? "\0") || domain.publicSpecifiers.has(specifier));
}

function findCycles(graph) {
  const cycles = new Set();
  const visited = new Set();
  const active = [];
  const activeSet = new Set();

  function visit(node) {
    if (activeSet.has(node)) {
      const start = active.indexOf(node);
      const cycle = [...active.slice(start), node];
      const body = cycle.slice(0, -1);
      const rotations = body.map((_, index) => [...body.slice(index), ...body.slice(0, index)]);
      rotations.sort((left, right) => left.join(" -> ").localeCompare(right.join(" -> ")));
      cycles.add([...rotations[0], rotations[0][0]].join(" -> "));
      return;
    }
    if (visited.has(node)) return;
    active.push(node);
    activeSet.add(node);
    for (const dependency of graph.get(node) ?? []) visit(dependency);
    active.pop();
    activeSet.delete(node);
    visited.add(node);
  }

  for (const node of graph.keys()) visit(node);
  return [...cycles].sort().map((cycle) => ({ cycle }));
}

function globToRegExp(glob) {
  let pattern = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*" && glob[index + 2] === "/") {
      pattern += "(?:.*/)?";
      index += 2;
    } else if (char === "*" && glob[index + 1] === "*") {
      pattern += ".*";
      index += 1;
    } else if (char === "*") {
      pattern += "[^/]*";
    } else {
      pattern += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${pattern}$`);
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function printText(result) {
  console.log(`Architecture boundaries (${result.scope})`);
  console.log(`Scanned production files: ${result.scannedFiles}`);
  console.log(`Declared domains: ${result.declaredDomains.map((domain) => `${domain.area}:${domain.id}`).join(", ")}`);
  console.log(`Declared cycles: ${result.cycles.length === 0 ? "none" : result.cycles.map((entry) => entry.cycle).join("; ")}`);
  console.log(`Facade bypasses: ${result.facadeBypasses.length === 0 ? "none" : result.facadeBypasses.length}`);
  for (const bypass of result.facadeBypasses) {
    console.log(`- ${bypass.source} imports ${bypass.specifier} (${bypass.domain} internal ${bypass.importedPath})`);
  }
  console.log("Observed, not enforced:");
  for (const entry of result.observed) console.log(`- ${entry.area}: ${entry.paths.join(", ")} (${entry.reason})`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    process.exit(0);
  }
  const result = auditBoundaries(options.root, options.config);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printText(result);
  if (result.violations > 0) process.exit(1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
