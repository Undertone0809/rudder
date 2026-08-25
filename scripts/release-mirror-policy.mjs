import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function resolveBooleanInput(value, name) {
  if (value === undefined || value === "" || value === false || value === "false") return false;
  if (value === true || value === "true") return true;
  throw new Error(`${name} must be a boolean input.`);
}

export function resolveMirrorCos({ eventName, input, skipMirror }) {
  if (eventName === "workflow_run") return false;
  if (eventName !== "workflow_dispatch") {
    throw new Error(`Unsupported release event for mirror_cos: ${eventName || "<empty>"}`);
  }

  const mirrorCos = resolveBooleanInput(input, "mirror_cos");
  const skip = resolveBooleanInput(skipMirror, "skip_mirror");
  if (mirrorCos && skip) {
    throw new Error("mirror_cos and skip_mirror cannot both be true.");
  }
  return mirrorCos;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mirrorCos = resolveMirrorCos({
      eventName: process.env.EVENT_NAME,
      input: process.env.MIRROR_COS,
      skipMirror: process.env.SKIP_MIRROR,
    });
    process.stdout.write(`${mirrorCos}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
