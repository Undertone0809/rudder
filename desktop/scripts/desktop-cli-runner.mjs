import { runCli } from "./desktop-cli.js";

// Electron has already selected Node mode by the time this module runs. Do not
// leak it into Desktop processes launched by commands such as `rudder start`.
delete process.env.ELECTRON_RUN_AS_NODE;

process.exitCode = await runCli(process.argv);
