import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";

const MAX_PACKAGE_JSON_BYTES = 256 * 1024;

export type LocalAppFramework =
  | "astro"
  | "next"
  | "nuxt"
  | "react-vite"
  | "react-scripts"
  | "sveltekit"
  | "vite"
  | "vue-cli"
  | "vue-vite"
  | "generic";

type PackageMetadata = {
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
};

async function readBoundedPackage(root: string): Promise<PackageMetadata | null> {
  let file: FileHandle | null = null;
  try {
    file = await open(path.join(root, "package.json"), "r");
    const stats = await file.stat();
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_PACKAGE_JSON_BYTES) return null;
    const buffer = Buffer.allocUnsafe(stats.size);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const parsed = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as PackageMetadata;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

export async function detectLocalAppFramework(
  root: string,
  scriptName?: string,
): Promise<LocalAppFramework> {
  const metadata = await readBoundedPackage(root);
  if (!metadata) return "generic";
  const dependencies = {
    ...stringRecord(metadata.dependencies),
    ...stringRecord(metadata.devDependencies),
  };
  const scripts = stringRecord(metadata.scripts);
  const command = scriptName ? scripts[scriptName] ?? "" : Object.values(scripts).join("\n");
  const has = (dependency: string, pattern: RegExp) => dependency in dependencies || pattern.test(command);

  if (has("next", /(?:^|\s)next(?:\s|$)/)) return "next";
  if (has("nuxt", /(?:^|\s)(?:nuxi|nuxt)(?:\s|$)/)) return "nuxt";
  if (has("astro", /(?:^|\s)astro(?:\s|$)/)) return "astro";
  if ("@sveltejs/kit" in dependencies || /(?:^|\s)svelte-kit(?:\s|$)/.test(command)) return "sveltekit";
  if (has("@vue/cli-service", /(?:^|\s)vue-cli-service(?:\s|$)/)) return "vue-cli";
  if (has("react-scripts", /(?:^|\s)react-scripts(?:\s|$)/)) return "react-scripts";
  if (has("vite", /(?:^|\s)vite(?:\s|$)/)) {
    if ("react" in dependencies || "@vitejs/plugin-react" in dependencies) return "react-vite";
    if ("vue" in dependencies || "@vitejs/plugin-vue" in dependencies) return "vue-vite";
    return "vite";
  }
  return "generic";
}

function directFrameworkCommand(command: string): LocalAppFramework {
  const normalized = command.trim();
  if (/[|&;<\n\r>]/.test(normalized)) return "generic";
  const startsWith = (binary: string) => new RegExp(
    `^(?:(?:[A-Za-z_][A-Za-z0-9_]*=\\S+|cross-env)\\s+)*${binary}(?:\\s|$)`,
  ).test(normalized);
  if (startsWith("next")) return "next";
  if (startsWith("(?:nuxi|nuxt)")) return "nuxt";
  if (startsWith("astro")) return "astro";
  if (startsWith("svelte-kit")) return "sveltekit";
  if (startsWith("vue-cli-service")) return "vue-cli";
  if (startsWith("react-scripts")) return "react-scripts";
  if (startsWith("vite")) return "vite";
  return "generic";
}

export async function detectLocalAppLaunchFramework(
  root: string,
  scriptName: string,
): Promise<LocalAppFramework> {
  const metadata = await readBoundedPackage(root);
  if (!metadata) return "generic";
  const scripts = stringRecord(metadata.scripts);
  const directFramework = directFrameworkCommand(scripts[scriptName] ?? "");
  if (directFramework !== "vite") return directFramework;
  const dependencies = {
    ...stringRecord(metadata.dependencies),
    ...stringRecord(metadata.devDependencies),
  };
  if ("@sveltejs/kit" in dependencies) return "sveltekit";
  if ("react" in dependencies || "@vitejs/plugin-react" in dependencies) return "react-vite";
  if ("vue" in dependencies || "@vitejs/plugin-vue" in dependencies) return "vue-vite";
  return "vite";
}

function scriptNameFromArguments(argv: string[]): string | undefined {
  if (argv[0] !== "run") return undefined;
  const scriptName = argv[1]?.trim();
  return scriptName && !scriptName.startsWith("-") ? scriptName : undefined;
}

function packageManager(executable: string): "npm" | "other" | null {
  const executableName = path.basename(executable).toLowerCase();
  if (["npm", "npm.cmd", "npm-cli.js"].includes(executableName)) return "npm";
  if ([
    "bun",
    "bun.exe",
    "pnpm",
    "pnpm.cmd",
    "pnpm.cjs",
    "pnpm.js",
    "yarn",
    "yarn.cmd",
    "yarn.js",
    "yarn.cjs",
  ].includes(executableName)) return "other";
  return null;
}

export async function localAppRuntimeArguments(
  root: string,
  executable: string,
  argv: string[],
  port: number,
): Promise<string[]> {
  const manager = packageManager(executable);
  if (!manager) return argv;
  const scriptName = scriptNameFromArguments(argv);
  if (!scriptName) return argv;
  const framework = await detectLocalAppLaunchFramework(root, scriptName);
  const separator = argv.includes("--") || manager !== "npm" ? [] : ["--"];
  const common = [...separator, "--host", "127.0.0.1", "--port", String(port)];
  switch (framework) {
    case "vite":
    case "react-vite":
    case "vue-vite":
    case "sveltekit":
      return [...argv, ...common, "--strictPort"];
    case "astro":
    case "nuxt":
    case "vue-cli":
      return [...argv, ...common];
    case "next":
      return [...argv, ...separator, "--hostname", "127.0.0.1", "--port", String(port)];
    case "react-scripts":
    case "generic":
      return argv;
  }
}
