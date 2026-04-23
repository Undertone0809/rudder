import { runCli } from "./program.js";

export { runCli } from "./program.js";

void runCli(process.argv).then(async (exitCode) => {
  // Ensure stdout is fully flushed before exiting to prevent truncated output
  // when the CLI is invoked via spawn/exec with large JSON payloads
  if (process.stdout.writableNeedDrain) {
    await new Promise<void>((resolve) => process.stdout.once('drain', resolve));
  }
  process.exit(exitCode);
});
