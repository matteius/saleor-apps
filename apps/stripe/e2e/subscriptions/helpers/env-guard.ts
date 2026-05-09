/**
 * Centralized env-presence checks for subscription E2E.
 *
 * Each scenario calls `requireEnvOrSkip` at the top of its `test(...)` body.
 * When variables are missing, the test prints a clear, actionable skip
 * message instead of crashing with a cryptic Stripe SDK / fetch error.
 *
 * Used together with `test.skip(condition, message)` from Playwright.
 */

export type SubscriptionE2EEnv = {
  stripeSecretKey: string;
  stripePublishableKey: string;
  stripeWebhookSecret: string;
  stripePriceBasic: string;
  stripePricePro: string;
  saleorApiUrl: string;
  saleorChannelSlug: string;
  saleorVariantBasic: string;
  saleorVariantPro: string;
  fiefUserId: string;
  fiefUserEmail: string;
};

const REQUIRED_VARS = [
  "E2E_STRIPE_TEST_SECRET_KEY",
  "E2E_STRIPE_PUBLISHABLE_KEY",
  "E2E_STRIPE_WEBHOOK_SECRET",
  "E2E_STRIPE_PRICE_BASIC_MONTHLY",
  "E2E_STRIPE_PRICE_PRO_MONTHLY",
  "E2E_SALEOR_API_URL",
  "E2E_SALEOR_VARIANT_BASIC",
  "E2E_SALEOR_VARIANT_PRO",
  "E2E_FIEF_TEST_USER_ID",
  "E2E_FIEF_TEST_USER_EMAIL",
] as const;

export type EnvCheckResult =
  | { ok: true; env: SubscriptionE2EEnv }
  | { ok: false; missing: string[]; message: string };

export function checkSubscriptionEnv(): EnvCheckResult {
  const missing = REQUIRED_VARS.filter((k) => !process.env[k] || process.env[k]?.trim() === "");

  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      message:
        `Skipping subscription E2E — missing env vars: ${missing.join(", ")}. ` +
        `See apps/stripe/e2e/subscriptions/README.md for setup.`,
    };
  }

  return {
    ok: true,
    env: {
      stripeSecretKey: process.env.E2E_STRIPE_TEST_SECRET_KEY!,
      stripePublishableKey: process.env.E2E_STRIPE_PUBLISHABLE_KEY!,
      stripeWebhookSecret: process.env.E2E_STRIPE_WEBHOOK_SECRET!,
      stripePriceBasic: process.env.E2E_STRIPE_PRICE_BASIC_MONTHLY!,
      stripePricePro: process.env.E2E_STRIPE_PRICE_PRO_MONTHLY!,
      saleorApiUrl: process.env.E2E_SALEOR_API_URL!,
      saleorChannelSlug: process.env.E2E_SALEOR_OWLBOOKS_CHANNEL_SLUG ?? "owlbooks",
      saleorVariantBasic: process.env.E2E_SALEOR_VARIANT_BASIC!,
      saleorVariantPro: process.env.E2E_SALEOR_VARIANT_PRO!,
      fiefUserId: process.env.E2E_FIEF_TEST_USER_ID!,
      fiefUserEmail: process.env.E2E_FIEF_TEST_USER_EMAIL!,
    },
  };
}

/**
 * Auth + base-URL inputs for actually exercising the storefront-protected
 * endpoint. Kept separate from the price/variant env so the latter can be
 * enforced uniformly while these "deployment glue" vars are checked
 * scenario-by-scenario with their own skip messages.
 */
export type StorefrontCallEnv = {
  hmacSecret: string;
  fiefJwt: string;
  baseUrl: string;
};

export type StorefrontCallEnvCheck =
  | { ok: true; env: StorefrontCallEnv }
  | { ok: false; message: string };

export function checkStorefrontCallEnv(): StorefrontCallEnvCheck {
  const hmacSecret =
    process.env.STOREFRONT_BRIDGE_SECRET ?? process.env.E2E_STOREFRONT_BRIDGE_SECRET;
  const fiefJwt = process.env.E2E_FIEF_TEST_JWT;
  const baseUrl = process.env.E2E_BASE_URL;

  if (!hmacSecret || !fiefJwt || !baseUrl) {
    return {
      ok: false,
      message:
        "Skipping — set STOREFRONT_BRIDGE_SECRET (or E2E_STOREFRONT_BRIDGE_SECRET), E2E_FIEF_TEST_JWT, and E2E_BASE_URL to exercise the storefront-protected endpoint.",
    };
  }

  return { ok: true, env: { hmacSecret, fiefJwt, baseUrl } };
}
