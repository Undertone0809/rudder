import {
  asString,
  parseJson,
  parseObject,
} from "@rudderhq/agent-runtime-utils/server-utils";
import fs from "node:fs/promises";
import path from "node:path";

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function hasExplicitOpenCodeApiKey(env: NodeJS.ProcessEnv, runtimeEnv: Record<string, string>): boolean {
  return Boolean(nonEmpty(runtimeEnv.OPENCODE_API_KEY) ?? nonEmpty(env.OPENCODE_API_KEY));
}

function isOpenCodeAnonymousModel(modelId: string | null): boolean {
  if (!modelId) return false;
  return modelId === "big-pickle" || modelId.endsWith("-free");
}

async function readJsonObjectFile(filePath: string): Promise<Record<string, unknown>> {
  const content = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!content.trim()) return {};
  const parsed = parseJson(content);
  return parseObject(parsed);
}

export function parsePiModelProvider(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return null;
  return trimmed.slice(0, trimmed.indexOf("/")).trim() || null;
}

export function parsePiModelId(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return trimmed || null;
  return trimmed.slice(trimmed.indexOf("/") + 1).trim() || null;
}

export async function ensurePiOpenCodeAnonymousModelsConfig(input: {
  modelProvider: string | null;
  modelId: string | null;
  piAgentDir: string;
  sourceEnv: NodeJS.ProcessEnv;
  runtimeEnv: Record<string, string>;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}): Promise<string[]> {
  if (input.modelProvider !== "opencode") return [];
  if (!isOpenCodeAnonymousModel(input.modelId)) return [];
  if (hasExplicitOpenCodeApiKey(input.sourceEnv, input.runtimeEnv)) return [];

  await fs.mkdir(input.piAgentDir, { recursive: true });
  const modelsJsonPath = path.join(input.piAgentDir, "models.json");
  const existing = await fs.lstat(modelsJsonPath).catch(() => null);
  if (existing?.isDirectory()) {
    await input.onLog?.(
      "stderr",
      `[rudder] Skipped Pi OpenCode anonymous model compatibility config because ${modelsJsonPath} is a directory.\n`,
    );
    return [];
  }

  const modelsConfig = existing?.isSymbolicLink() ? {} : await readJsonObjectFile(modelsJsonPath);
  const providers = parseObject(modelsConfig.providers);
  const existingOpenCodeConfig = parseObject(providers.opencode);
  const existingHeaders = parseObject(existingOpenCodeConfig.headers);
  const nextConfig = {
    ...modelsConfig,
    providers: {
      ...providers,
      opencode: {
        ...existingOpenCodeConfig,
        apiKey: asString(existingOpenCodeConfig.apiKey, "RUDDER_OPENCODE_ANONYMOUS"),
        authHeader: false,
        headers: {
          ...existingHeaders,
          Authorization: "",
        },
      },
    },
  };

  if (existing?.isSymbolicLink()) {
    await fs.unlink(modelsJsonPath);
  }
  await fs.writeFile(modelsJsonPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");

  const settingsJsonPath = path.join(input.piAgentDir, "settings.json");
  const existingSettings = await fs.lstat(settingsJsonPath).catch(() => null);
  if (existingSettings?.isSymbolicLink()) {
    await fs.unlink(settingsJsonPath);
    await input.onLog?.(
      "stdout",
      `[rudder] Removed inherited Pi settings symlink for OpenCode anonymous model compatibility at ${settingsJsonPath}.\n`,
    );
  }

  await input.onLog?.(
    "stdout",
    `[rudder] Prepared managed Pi OpenCode anonymous model compatibility config at ${modelsJsonPath}.\n`,
  );
  return ["Prepared managed Pi OpenCode anonymous model compatibility config."];
}
