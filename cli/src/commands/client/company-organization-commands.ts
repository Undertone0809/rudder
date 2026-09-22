import type { Organization } from "@rudderhq/shared";
import { Command } from "commander";
import { getAgentCliCapabilityById } from "../../agent-v1-registry.js";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface OrganizationBrandColorUpdateOptions extends BaseClientOptions {
  brandColor: string;
  idempotencyKey: string;
}

interface OrganizationMembersOptions extends BaseClientOptions {
  query?: string;
  type?: "human" | "agent" | "all";
  limit?: string;
  cursor?: string;
}

export function registerOrganizationMemberAndBrandCommands(company: Command): void {
  addCommonClientOptions(
    company
      .command("members")
      .description("List active visible human and agent members in an organization")
      .option("-O, --org-id <id>", "Organization ID")
      .option("--query <text>", "Filter by member name")
      .option("--type <human|agent|all>", "Filter by member type", "all")
      .option("--limit <n>", "Page size")
      .option("--cursor <cursor>", "Opaque page cursor")
      .action(async (opts: OrganizationMembersOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams();
          if (opts.query?.trim()) params.set("query", opts.query.trim());
          if (opts.type && opts.type !== "all") params.set("type", opts.type);
          if (opts.limit?.trim()) params.set("limit", opts.limit.trim());
          if (opts.cursor?.trim()) params.set("cursor", opts.cursor.trim());
          if (opts.fullIds) params.set("fullIds", "true");
          const query = params.toString();
          const page = (await ctx.api.get<{
            total: number;
            items: Array<{ name: string; type: string; role: string; ref: string }>;
            nextCursor: string | null;
            hasMore: boolean;
          }>(`/api/orgs/${encodeURIComponent(ctx.orgId!)}/members/directory${query ? `?${query}` : ""}`)) ?? {
            total: 0,
            items: [],
            nextCursor: null,
            hasMore: false,
          };
          if (ctx.json) {
            printOutput(page, { json: true });
            return;
          }
          console.log(`total=${page.total}`);
          for (const member of page.items) console.log(formatInlineRecord(member));
          if (page.nextCursor) console.log(`nextCursor=${page.nextCursor}`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

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
            { headers: {
              "x-rudder-idempotency-key": opts.idempotencyKey.trim(),
              "x-rudder-required-authority": "rust",
            } },
          );
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );
}
