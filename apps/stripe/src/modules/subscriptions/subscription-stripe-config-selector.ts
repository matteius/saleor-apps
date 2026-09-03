import { TRPCError } from "@trpc/server";

/** Select one installed Stripe configuration without relying on database order. */
export const selectSubscriptionStripeConfig = <T extends { id: string }>(
  configurations: T[],
  configuredId?: string,
): T => {
  if (configuredId) {
    const selected = configurations.find((configuration) => configuration.id === configuredId);

    if (selected) return selected;

    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "The configured subscription Stripe configuration is not installed",
    });
  }

  if (configurations.length === 1) return configurations[0]!;

  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message:
      configurations.length === 0
        ? "No Stripe configuration is installed for this Saleor app"
        : "Multiple Stripe configurations are installed; configure SUBSCRIPTIONS_STRIPE_CONFIG_ID",
  });
};
