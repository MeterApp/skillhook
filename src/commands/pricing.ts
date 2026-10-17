import { storedApiCredentials } from "../cloud/api.js";
import { fetchPricing, renderPricing } from "../cloud/pricing.js";
import { CommandError, table, type Ctx } from "./shared.js";
import { CloudApiError } from "../cloud/api.js";
import { printable } from "../util.js";

export const PRICING_USAGE = `Usage:
  skillhook pricing [--json]     Skillhook Cloud's plans: price, limits, features and the link that buys each (no key needed)

The plans come from the cloud this computer uses (the one its kept key belongs to, else cloud.url or https://skillhook.dev).
--json prints the cloud's pricing document as it is (the shape all of Meter's products share).`;

/** `skillhook pricing`: one GET to the cloud's public pricing, only when run. */
export async function pricingCommand(ctx: Ctx): Promise<number> {
  try {
    const { data, raw } = await fetchPricing(ctx.io.env, ctx.config().cloud, { keptUrl: storedApiCredentials(ctx.paths, ctx.io.env).url, client: "cli" });
    ctx.print(printable(renderPricing(data, table)), raw);
    return 0;
  } catch (error) {
    if (error instanceof CloudApiError) throw new CommandError(error.message);
    throw error;
  }
}
