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
      .argument("<tab-id>", "Run-owned Browser tab id"),
    { includeCompany: true },
  ).action((tabId: string, options: BaseClientOptions) =>
    runBrowserAction("screenshot", { tabId }, options));

  addCommonClientOptions(
    browser
      .command("close")
      .description(getAgentCliCapabilityById("browser.close").description)
      .argument("<tab-id>", "Run-owned Browser tab id"),
    { includeCompany: true },
  ).action((tabId: string, options: BaseClientOptions) => runBrowserAction("close", { tabId }, options));
}
