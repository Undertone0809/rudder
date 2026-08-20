import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function resolveMirrorCos({ eventName, input }) {
  if (eventName === "workflow_run") return false;
  if (eventName !== "workflow_dispatch") {
    throw new Error(`Unsupported release event for mirror_cos: ${eventName || "<empty>"}`);
  }

  if (input === undefined || input === "" || input === false || input === "false") return false;
  if (input === true || input === "true") return true;
  throw new Error("mirror_cos must be a boolean input.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mirrorCos = resolveMirrorCos({
      eventName: process.env.EVENT_NAME,
      input: process.env.MIRROR_COS,
    });
    process.stdout.write(`${mirrorCos}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
