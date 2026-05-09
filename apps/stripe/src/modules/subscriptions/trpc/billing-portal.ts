/**
 * tRPC handler for `subscriptions.createBillingPortalSession` (T22).
 *
 * Mints a Stripe Customer Portal session URL the storefront / OwlBooks UI
 * can redirect the customer to for card updates, cancellation, plan
 * changes, and invoice history.
 *
 * Security:
 *  - `returnUrl` MUST be HTTPS to prevent open-redirect-style abuse where
 *    an attacker tricks the portal into bouncing the user back to a
 *    plaintext / attacker-controlled URL.
 *  - When `STOREFRONT_PUBLIC_URL` env is set (comma-separated), the
 *    `returnUrl` host MUST appear in that allowlist. If unset, all HTTPS
 *    URLs are accepted (dev/test convenience; production is expected to
 *    set the var per T19a).
 *
 * Wiring:
 *  - Mirrors the constructor-injected dependency pattern used by
 *    `NewStripeConfigTrpcHandler` (and the future T20/T21 handlers): the
 *    Stripe Subscriptions API factory and the app config repo are passed
 *    in via deps so unit tests can swap them out wholesale.
 *  - The Stripe restricted key is resolved from `AppRootConfig`. The
 *    subscriptions surface is single-tenant per Saleor app installation
 *    (one Stripe restricted key per install), so we select the first
 *    config. If/when multi-Stripe-config-per-install is needed for
 *    subscriptions, the input schema gains a `configId` (TODO).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { env } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { type AppConfigRepo } from "@/modules/app-config/repositories/app-config-repo";
import { appConfigRepoImpl } from "@/modules/app-config/repositories/app-config-repo-impl";
import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { protectedClientProcedure } from "@/modules/trpc/protected-client-procedure";

import {
  type IStripeSubscriptionsApiFactory,
  StripeSubscriptionsApiFactory,
} from "../api/stripe-subscriptions-api-factory";

const logger = createLogger("billingPortalTrpcHandler");

export const billingPortalInputSchema = z.object({
  stripeCustomerId: z.string().min(1).startsWith("cus_"),
  returnUrl: z.string().url(),
});

export const billingPortalOutputSchema = z.object({
  url: z.string().url(),
});

export type BillingPortalInput = z.infer<typeof billingPortalInputSchema>;
export type BillingPortalOutput = z.infer<typeof billingPortalOutputSchema>;

/**
 * Parses the comma-separated `STOREFRONT_PUBLIC_URL` env var into a Set of
 * lowercase host strings. Returns `null` when the env is unset/empty,
 * signalling "no allowlist configured — accept any HTTPS URL".
 *
 * Exported for tests; production code should not need to call directly.
 */
export const parseAllowlistedHosts = (raw: string | undefined): Set<string> | null => {
  if (!raw || raw.trim().length === 0) return null;

  const hosts = new Set<string>();

  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();

    if (trimmed.length === 0) continue;

    try {
      /*
       * Allow either bare hosts or full URLs in the env var; both are useful in
       * practice (the same var is also read by the public-API CORS layer where
       * origin URLs are natural).
       */
      const url = new URL(trimmed);

      hosts.add(url.host.toLowerCase());
    } catch {
      hosts.add(trimmed.toLowerCase());
    }
  }

  return hosts.size > 0 ? hosts : null;
};

/**
 * Validates the supplied returnUrl. Throws `TRPCError(BAD_REQUEST)` on
 * failure with a message that surfaces in dev tools but does NOT leak the
 * allowlist contents — we say "not permitted" rather than enumerating
 * allowed hosts to keep the error surface tight.
 */
export const validateReturnUrl = (returnUrl: string, allowlistRaw: string | undefined): void => {
  let parsed: URL;

  try {
    parsed = new URL(returnUrl);
  } catch {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "returnUrl is not a valid URL",
    });
  }

  if (parsed.protocol !== "https:") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "returnUrl must use HTTPS",
    });
  }

  const allowlist = parseAllowlistedHosts(allowlistRaw);

  if (allowlist === null) {
    // No allowlist configured — accept any HTTPS URL.
    return;
  }

  if (!allowlist.has(parsed.host.toLowerCase())) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "returnUrl host is not permitted",
    });
  }
};

export interface BillingPortalTrpcHandlerDeps {
  stripeSubscriptionsApiFactory: IStripeSubscriptionsApiFactory;
  appConfigRepo: AppConfigRepo;
}

/**
 * Handler class. Mirrors `NewStripeConfigTrpcHandler` shape so the router
 * can do `new BillingPortalTrpcHandler(...).getTrpcProcedure()`.
 */
export class BillingPortalTrpcHandler {
  baseProcedure = protectedClientProcedure;
  private readonly stripeSubscriptionsApiFactory: IStripeSubscriptionsApiFactory;
  private readonly appConfigRepo: AppConfigRepo;

  constructor(deps?: Partial<BillingPortalTrpcHandlerDeps>) {
    this.stripeSubscriptionsApiFactory =
      deps?.stripeSubscriptionsApiFactory ?? new StripeSubscriptionsApiFactory();
    this.appConfigRepo = deps?.appConfigRepo ?? appConfigRepoImpl;
  }

  getTrpcProcedure() {
    return this.baseProcedure
      .input(billingPortalInputSchema)
      .output(billingPortalOutputSchema)
      .mutation(async ({ input, ctx }): Promise<BillingPortalOutput> => {
        /*
         * Belt-and-suspenders: the Zod schema already enforces non-empty,
         * but explicit checks keep error semantics correct if the schema
         * is ever loosened.
         */
        if (!input.stripeCustomerId || input.stripeCustomerId.length === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "stripeCustomerId is required",
          });
        }

        validateReturnUrl(input.returnUrl, env.STOREFRONT_PUBLIC_URL);

        const saleorApiUrl = createSaleorApiUrl(ctx.saleorApiUrl);

        if (saleorApiUrl.isErr()) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Malformed saleorApiUrl",
          });
        }

        const rootConfigResult = await this.appConfigRepo.getRootConfig({
          saleorApiUrl: saleorApiUrl.value,
          appId: ctx.appId,
        });

        if (rootConfigResult.isErr()) {
          logger.error("Failed to load root config", { error: rootConfigResult.error });

          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to load Stripe configuration",
          });
        }

        const stripeConfigs = rootConfigResult.value.getAllConfigsAsList();

        if (stripeConfigs.length === 0) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "No Stripe configuration is installed for this Saleor app",
          });
        }

        /*
         * Single-tenant subscription model: pick the first config. See file
         * header for the upgrade path.
         */
        const stripeConfig = stripeConfigs[0];

        const stripeSubscriptionsApi = this.stripeSubscriptionsApiFactory.createSubscriptionsApi({
          key: stripeConfig.restrictedKey,
        });

        const sessionResult = await stripeSubscriptionsApi.createBillingPortalSession({
          customerId: input.stripeCustomerId,
          returnUrl: input.returnUrl,
        });

        if (sessionResult.isErr()) {
          logger.error("Stripe billing portal session creation failed", {
            error: sessionResult.error,
            customerId: input.stripeCustomerId,
          });

          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Failed to create Stripe billing portal session",
          });
        }

        return { url: sessionResult.value.url };
      });
  }
}
