import { Command } from "commander";
import { getAgentCliCapabilityById } from "../../agent-v1-registry.js";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface BrowserTypeOptions extends BaseClientOptions {
  text: string;
  submit?: boolean;
}

interface BrowserViewportOptions extends BaseClientOptions {
  action: "get" | "set" | "reset";
  width?: number;
  height?: number;
}

interface BrowserVisibilityOptions extends BaseClientOptions {
  visible?: string;
}

interface BrowserJsonOptions extends BaseClientOptions {
  input?: string;
}

function parseBrowserInput(input: string | undefined): Record<string, unknown> {
  if (!input) return {};
  try {
    const parsed = JSON.parse(input) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new TypeError("--input must be a JSON object");
  }
}

async function runBrowserAction(
  action: string,
  payload: Record<string, unknown>,
  options: BaseClientOptions,
) {
  try {
    const context = resolveCommandContext(options, { requireCompany: true });
    const result = await context.api.post(`/api/browser/${action}`, payload);
    printOutput(result ?? {}, { json: context.json });
  } catch (error) {
    handleCommandError(error);
  }
}

export function registerBrowserCommands(program: Command): void {
  const browser = program.command("browser").description("Control the run-owned Rudder Browser");

  addCommonClientOptions(
    browser.command("tabs").description(getAgentCliCapabilityById("browser.tabs").description),
    { includeCompany: true },
  ).action((options: BaseClientOptions) => runBrowserAction("tabs", {}, options));

  addCommonClientOptions(
    browser.command("user-tabs").description(getAgentCliCapabilityById("browser.user-tabs").description),
    { includeCompany: true },
  ).action((options: BaseClientOptions) => runBrowserAction("user_tabs", {}, options));

  addCommonClientOptions(
    browser
      .command("open")
      .description(getAgentCliCapabilityById("browser.open").description)
      .argument("<url>", "HTTP or HTTPS URL"),
    { includeCompany: true },
  ).action((url: string, options: BaseClientOptions) => runBrowserAction("open", { url }, options));

  addCommonClientOptions(
    browser
      .command("navigate")
      .description(getAgentCliCapabilityById("browser.navigate").description)
      .argument("<tab-id>", "Run-owned Browser tab id")
      .argument("<url>", "HTTP or HTTPS URL"),
    { includeCompany: true },
  ).action((tabId: string, url: string, options: BaseClientOptions) =>
    runBrowserAction("navigate", { tabId, url }, options));

  for (const action of ["back", "forward", "reload"] as const) {
    addCommonClientOptions(
      browser
        .command(action)
        .description(getAgentCliCapabilityById(`browser.${action}`).description)
        .argument("<tab-id>", "Run-owned Browser tab id"),
      { includeCompany: true },
    ).action((tabId: string, options: BaseClientOptions) =>
      runBrowserAction(action, { tabId }, options));
  }

  addCommonClientOptions(
    browser
      .command("viewport")
      .description(getAgentCliCapabilityById("browser.viewport").description)
      .requiredOption("--action <action>", "get, set, or reset")
      .option("--width <pixels>", "Viewport width", Number)
      .option("--height <pixels>", "Viewport height", Number),
    { includeCompany: true },
  ).action((options: BrowserViewportOptions) => runBrowserAction("viewport", {
    action: options.action,
    ...(options.width !== undefined ? { width: options.width } : {}),
    ...(options.height !== undefined ? { height: options.height } : {}),
  }, options));

  addCommonClientOptions(
    browser
      .command("visibility")
      .description(getAgentCliCapabilityById("browser.visibility").description)
      .option("--visible <boolean>", "Show or hide the selected Agent Browser tab"),
    { includeCompany: true },
  ).action((options: BrowserVisibilityOptions) => {
    const visible = options.visible === undefined
      ? undefined
      : options.visible === "true"
        ? true
        : options.visible === "false"
          ? false
          : (() => { throw new TypeError("--visible must be true or false"); })();
    return runBrowserAction("visibility", {
      ...(visible !== undefined ? { visible } : {}),
    }, options);
  });

  for (const action of [
    "snapshot",
    "locator",
    "cua",
    "dom-cua",
    "dialog",
    "logs",
    "download",
    "assets",
    "content",
    "wait",
  ] as const) {
    addCommonClientOptions(
      browser
        .command(action)
        .description(getAgentCliCapabilityById(`browser.${action}`).description)
        .argument("<tab-id>", "Run-owned Browser tab id")
        .option("--input <json>", "JSON object with bounded Browser action arguments"),
      { includeCompany: true },
    ).action((tabId: string, options: BrowserJsonOptions) => runBrowserAction(
      action === "dom-cua" ? "dom_cua" : action,
      { tabId, ...parseBrowserInput(options.input) },
      options,
    ));
  }

  addCommonClientOptions(
    browser
      .command("clipboard")
      .description(getAgentCliCapabilityById("browser.clipboard").description)
      .requiredOption("--input <json>", "JSON object with virtual clipboard action arguments"),
    { includeCompany: true },
  ).action((options: BrowserJsonOptions) => runBrowserAction(
    "clipboard",
    parseBrowserInput(options.input),
    options,
  ));

  addCommonClientOptions(
    browser
      .command("read")
      .description(getAgentCliCapabilityById("browser.read").description)
      .argument("<tab-id>", "Run-owned Browser tab id"),
    { includeCompany: true },
  ).action((tabId: string, options: BaseClientOptions) => runBrowserAction("read", { tabId }, options));

  addCommonClientOptions(
    browser
      .command("click")
      .description(getAgentCliCapabilityById("browser.click").description)
      .argument("<tab-id>", "Run-owned Browser tab id")
      .argument("<ref>", "Element reference returned by browser read"),
    { includeCompany: true },
  ).action((tabId: string, ref: string, options: BaseClientOptions) =>
    runBrowserAction("click", { tabId, ref }, options));

  addCommonClientOptions(
    browser
      .command("type")
      .description(getAgentCliCapabilityById("browser.type").description)
      .argument("<tab-id>", "Run-owned Browser tab id")
      .argument("<ref>", "Element reference returned by browser read")
      .requiredOption("--text <text>", "Text to enter")
      .option("--submit", "Submit the form after typing", false),
    { includeCompany: true },
  ).action((tabId: string, ref: string, options: BrowserTypeOptions) =>
    runBrowserAction("type", {
      tabId,
      ref,
      text: options.text,
      ...(options.submit ? { submit: true } : {}),
    }, options));

  addCommonClientOptions(
    browser
      .command("screenshot")
      .description(getAgentCliCapabilityById("browser.screenshot").description)
      .argument("<tab-id>", "Run-owned Browser tab id")
      .option("--input <json>", "JSON object with full-page, clip, locator, or format options"),
    { includeCompany: true },
  ).action((tabId: string, options: BrowserJsonOptions) =>
    runBrowserAction("screenshot", { tabId, ...parseBrowserInput(options.input) }, options));

  addCommonClientOptions(
    browser
      .command("close")
      .description(getAgentCliCapabilityById("browser.close").description)
      .argument("<tab-id>", "Run-owned Browser tab id"),
    { includeCompany: true },
  ).action((tabId: string, options: BaseClientOptions) => runBrowserAction("close", { tabId }, options));
}
