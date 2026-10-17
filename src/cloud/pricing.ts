// Skillhook Cloud's plans without a key (`skillhook pricing`, and get_pricing / create_checkout_link of
// `skillhook mcp --cloud` before anyone signed in): `GET /api/v1/pricing` and `POST /api/v1/billing/checkout` of the
// cloud, which answer anyone. One request each, only when a person runs the command or their agent calls the tool, to
// the cloud the kept key belongs to (else the machine's cloud), HTTPS only, never with a key or the machine token. The
// document is the cloud's (the shape all of Meter's products share), parsed loosely: a newer cloud may say more.
import { z } from "zod";
import {
  CLIENT_HEADER,
  CloudApiError,
  describeApiFailure,
  type SkillhookClient,
} from "./api.js";
import {
  cloudDisabledByEnv,
  InsecureCloudUrlError,
  isSecureCloudUrl,
  resolveCloudUrl,
} from "./config.js";
import { CloudHttpError, cloudRequest } from "./http.js";

const text = z.string().nullish();
const price = z
  .object({ monthly: z.number().nullish(), yearly: z.number().nullish() })
  .loose()
  .nullish();

export const PricingSchema = z
  .object({
    product: text,
    currency: text,
    updated_at: text,
    plans: z.array(
      z
        .object({
          id: text,
          code: text,
          name: z.string(),
          monthly_cents: z.number().nullish(),
          yearly_cents: z.number().nullish(),
          tagline: text,
          price,
          limits: z.record(z.string(), z.number().nullable()).nullish(),
          features: z.array(z.string()).nullish(),
          checkout_url: text,
          checkout_url_yearly: text,
          signup_url: text,
          contact: text,
        })
        .loose(),
    ),
    pricing_url: text,
    docs: text,
    enforced: z.boolean().nullish(),
  })
  .loose();
export type Pricing = z.infer<typeof PricingSchema>;

export const CheckoutLinkSchema = z
  .object({
    kind: text,
    url: z.string(),
    plan: text,
    interval: text,
    price: text,
    note: text,
  })
  .loose();
export type CheckoutLink = z.infer<typeof CheckoutLinkSchema>;

export interface PublicCloudOptions {
  /** The cloud the kept key belongs to, when there is one: pricing comes from the same cloud. */
  keptUrl?: string;
  client: SkillhookClient;
  fetchImpl?: typeof fetch;
}

function publicUrl(
  env: NodeJS.ProcessEnv,
  cloud: { url?: string },
  keptUrl: string | undefined,
): string {
  if (cloudDisabledByEnv(env))
    throw new CloudApiError(
      "SKILLHOOK_NO_CLOUD is set: nothing goes to Skillhook Cloud from this environment.",
      undefined,
      "disabled",
    );
  const url = resolveCloudUrl(env, cloud, keptUrl);
  if (!isSecureCloudUrl(url, env))
    throw new CloudApiError(
      new InsecureCloudUrlError(url).message,
      undefined,
      "insecure_url",
    );
  return url;
}

async function send<T>(
  url: string,
  method: "GET" | "POST",
  path: string,
  schema: z.ZodType<T>,
  body: unknown,
  options: PublicCloudOptions,
): Promise<{ data: T; raw: unknown; url: string }> {
  let response;
  try {
    response = await cloudRequest(url, `/api/v1${path}`, {
      method,
      body,
      fetchImpl: options.fetchImpl,
      timeoutMs: 15_000,
      headers: { [CLIENT_HEADER]: options.client },
    });
  } catch (error) {
    if (error instanceof CloudHttpError)
      throw new CloudApiError(
        describeApiFailure(error, url, method),
        error.status,
        error.code,
      );
    throw error;
  }
  const parsed = schema.safeParse(response.body);
  if (!parsed.success)
    throw new CloudApiError(
      `${url} answered ${method} /api/v1${path} with something this version does not understand`,
    );
  return { data: parsed.data, raw: response.body, url };
}

/** `GET /api/v1/pricing?ref=agent-<client>`: every plan, its price, limits, features and checkout link. */
export function fetchPricing(
  env: NodeJS.ProcessEnv,
  cloud: { url?: string },
  options: PublicCloudOptions,
) {
  return send(
    publicUrl(env, cloud, options.keptUrl),
    "GET",
    `/pricing?ref=agent-${options.client}`,
    PricingSchema,
    undefined,
    options,
  );
}

/** `POST /api/v1/billing/checkout` without a key: the plan's checkout link, which signs a person in (or up) first. */
export function publicCheckoutLink(
  env: NodeJS.ProcessEnv,
  cloud: { url?: string },
  input: { plan: string; interval: "month" | "year" },
  options: PublicCloudOptions,
) {
  return send(
    publicUrl(env, cloud, options.keptUrl),
    "POST",
    "/billing/checkout",
    CheckoutLinkSchema,
    {
      plan: input.plan,
      interval: input.interval,
      ref: `agent-${options.client}`,
    },
    options,
  );
}

function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return value === 0
    ? "$0"
    : `$${Number.isInteger(value) ? value.toLocaleString("en-US") : value.toFixed(2)}`;
}

function limit(value: number | null | undefined): string {
  return value === null
    ? "unlimited"
    : value === undefined
      ? ""
      : value.toLocaleString("en-US");
}

/** The plans as a terminal table: price, the main limits, how to buy. */
export function renderPricing(
  pricing: Pricing,
  table: (rows: string[][], headers: string[]) => string,
): string {
  const rows = pricing.plans.map((plan) => {
    // A cloud from before the shared shape says monthly_cents / yearly_cents instead of price.
    const monthly =
      plan.price !== undefined
        ? plan.price?.monthly
        : plan.monthly_cents === null
          ? null
          : (plan.monthly_cents ?? 0) / 100;
    const yearly =
      plan.price !== undefined
        ? plan.price?.yearly
        : plan.yearly_cents === null
          ? null
          : (plan.yearly_cents ?? 0) / 100;
    return [
      plan.name,
      monthly === null || monthly === undefined
        ? "by agreement"
        : monthly
          ? `${money(monthly)}/mo, ${money(yearly)}/yr`
          : "free",
      limit(plan.limits?.machines),
      limit(plan.limits?.members),
      limit(plan.limits?.hosted_urls),
      limit(plan.limits?.hosted_deliveries_per_month),
      plan.limits?.payload_retention_days
        ? `${plan.limits.payload_retention_days} d`
        : "",
    ];
  });
  const lines = [
    table(rows, [
      "plan",
      "price",
      "machines",
      "people",
      "hosted URLs",
      "deliveries/mo",
      "bodies kept",
    ]),
    "",
  ];
  for (const plan of pricing.plans) {
    const link = plan.checkout_url ?? plan.signup_url ?? plan.contact;
    if (link) lines.push(`${plan.name}: ${link}`);
  }
  lines.push(
    "",
    "A checkout link signs you in (or up) and goes to Stripe Checkout. With a key: skillhook cloud upgrade --plan pro [--yearly]; skillhook cloud billing shows the plan and usage.",
  );
  if (pricing.pricing_url)
    lines.push(`Every feature and limit: ${pricing.pricing_url}`);
  return lines.join("\n");
}
