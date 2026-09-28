import type { Organization } from "@rudderhq/shared";
import type { Command } from "commander";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

export function registerOrganizationGetCommand(company: Command): void {
  addCommonClientOptions(
    company
      .command("get")
      .description("Get one organization")
      .argument("<orgId>", "Organization ID")
      .action(async (orgId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<Organization>(`/api/orgs/${orgId}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}
