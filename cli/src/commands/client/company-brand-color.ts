import type { Organization } from "@rudderhq/shared";
import type { Command } from "commander";
import { getAgentCliCapabilityById } from "../../agent-v1-registry.js";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface OrganizationBrandColorUpdateOptions extends BaseClientOptions {
  brandColor: string;
  idempotencyKey: string;
}

export function registerOrganizationBrandColorCommand(company: Command): void {
  const brandColor = company.command("brand-color").description("Organization brand color operations");
  addCommonClientOptions(
    brandColor
      .command("update")
      .description(getAgentCliCapabilityById("organization.brand_color.update").description)
      .requiredOption("--brand-color <hex>", "Hex brand color (for example #123456)")
      .requiredOption("--idempotency-key <key>", "Stable key for safe replay")
      .action(async (opts: OrganizationBrandColorUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const updated = await ctx.api.patch<Organization>(
            `/api/orgs/${encodeURIComponent(ctx.orgId!)}/branding`,
            { brandColor: opts.brandColor.trim() },
            {
              headers: {
                "x-rudder-idempotency-key": opts.idempotencyKey.trim(),
                "x-rudder-required-authority": "rust",
              },
            },
          );
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );
}
