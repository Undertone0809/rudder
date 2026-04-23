import fs from "node:fs";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { getDisposableLocalEnvProfiles, resolveLocalEnvProfile } from "../cli/src/config/local-env.js";
import { describeLocalInstancePaths } from "../cli/src/config/home.js";

function parseArgs(argv: string[]) {
  let localEnv: string | undefined;
  let instance: string | undefined;
  let force = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--local-env") {
      localEnv = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--instance") {
      instance = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--force") {
      force = true;
    }
  }

  return { localEnv, instance, force };
}

async function main() {
  const { localEnv, instance, force } = parseArgs(process.argv.slice(2));
  const profile = resolveLocalEnvProfile(localEnv ?? process.env.RUDDER_LOCAL_ENV);

  if (!profile) {
    const allowed = getDisposableLocalEnvProfiles().map((item) => item.name).join(", ");
    throw new Error(`Missing or unsupported --local-env. Supported reset targets: ${allowed}.`);
  }
  if (!profile.resettable) {
    throw new Error(`Refusing to reset non-disposable local environment "${profile.name}".`);
  }
  if (instance && instance.trim().length > 0 && instance.trim() !== profile.instanceId) {
    throw new Error(
      `Explicit instance "${instance}" does not match local environment "${profile.name}" (${profile.instanceId}).`,
    );
  }

  const paths = describeLocalInstancePaths(profile.instanceId);
  p.intro(pc.bgCyan(pc.black(" rudder local reset ")));
  p.log.message(pc.dim(`Local env: ${profile.name}`));
  p.log.message(pc.dim(`Instance: ${paths.instanceId}`));
  p.log.message(pc.dim(`Root: ${paths.instanceRoot}`));

  if (!fs.existsSync(paths.instanceRoot)) {
    p.outro("Nothing to reset.");
    return;
  }

  let shouldDelete = force;
  if (!shouldDelete) {
    const answer = await p.confirm({
      message: `Delete all data under ${paths.instanceRoot}?`,
      initialValue: false,
    });
    if (p.isCancel(answer) || !answer) {
      p.cancel("Reset cancelled.");
      return;
    }
    shouldDelete = answer;
  }

  if (!shouldDelete) {
    p.cancel("Reset cancelled.");
    return;
  }

  fs.rmSync(paths.instanceRoot, { recursive: true, force: true });
  p.outro(pc.green(`Reset ${profile.name} instance data.`));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
