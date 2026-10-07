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
  brandColor?: string;
  clearBrandColor?: boolean;
  logoAssetId?: string;
  clearLogo?: boolean;
  idempotencyKey: string;
}

export function registerOrganizationBrandColorCommand(company: Command): void {
  const brandColor = company.command("brand-color").description("Organization branding operations");
  addCommonClientOptions(
    brandColor
      .command("update")
      .description(getAgentCliCapabilityById("organization.brand_color.update").description)
      .option("--brand-color <hex>", "Hex brand color (for example #123456)")
      .option("--clear-brand-color", "Clear the current brand color")
      .option("--logo-asset-id <uuid>", "Link an existing asset from this organization as its logo")
      .option("--clear-logo", "Clear the current logo link")
      .requiredOption("--idempotency-key <key>", "Stable key for safe replay")
      .action(async (opts: OrganizationBrandColorUpdateOptions) => {
        try {
          if (opts.brandColor !== undefined && opts.clearBrandColor) {
            throw new Error("Choose either --brand-color or --clear-brand-color");
          }
          if (opts.logoAssetId !== undefined && opts.clearLogo) {
            throw new Error("Choose either --logo-asset-id or --clear-logo");
          }
          const patch: { brandColor?: string | null; logoAssetId?: string | null } = {};
          if (opts.brandColor !== undefined) patch.brandColor = opts.brandColor.trim();
          else if (opts.clearBrandColor) patch.brandColor = null;
          if (opts.logoAssetId !== undefined) patch.logoAssetId = opts.logoAssetId.trim();
          else if (opts.clearLogo) patch.logoAssetId = null;
          if (Object.keys(patch).length === 0) {
            throw new Error("Provide a branding field to update");
          }
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const updated = await ctx.api.patch<Organization>(
            `/api/orgs/${encodeURIComponent(ctx.orgId!)}/branding`,
            patch,
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
