/**
 * DynamoDB schema for the subscription cache record.
 *
 * Mirrors `transactions-recording/repositories/dynamodb/recorded-transaction-db-model.ts`.
 *
 * Single-table design: PK scoped to Saleor installation, SK keyed by
 * Stripe subscription ID.
 *
 * To be fully implemented in T8.
 */
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

export const TODO_T8_SUBSCRIPTION_DB_MODEL = "implement in T8";

export class SubscriptionAccessPattern {
  static getSKforSubscription({ stripeSubscriptionId }: { stripeSubscriptionId: string }) {
    return `SUBSCRIPTION#${stripeSubscriptionId}` as const;
  }

  static getSKforCustomerLookup({ stripeCustomerId }: { stripeCustomerId: string }) {
    return `SUBSCRIPTION_BY_CUSTOMER#${stripeCustomerId}` as const;
  }

  static getSKforFiefUserLookup({ fiefUserId }: { fiefUserId: string }) {
    return `SUBSCRIPTION_BY_FIEF_USER#${fiefUserId}` as const;
  }
}

export interface SubscriptionDbModelAccess {
  saleorApiUrl: SaleorApiUrl;
  appId: string;
}
