/**
 * Domain model for a subscription cached in DynamoDB.
 *
 * Mirrors `transactions-recording/domain/recorded-transaction.ts`.
 *
 * The Postgres `UserSubscription` table in OwlBooks remains the durable system
 * of record; this DynamoDB record is a fast-lookup cache scoped to a Saleor
 * installation for webhook routing (avoids cross-system Postgres calls during
 * the webhook hot path).
 *
 * To be fully implemented in T8.
 */

export const TODO_T8_SUBSCRIPTION_RECORD = "implement in T8";

export type SubscriptionStatus =
  | "active"
  | "past_due"
  | "canceled"
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "unpaid";

export class SubscriptionRecord {
  readonly stripeSubscriptionId: string;
  readonly stripeCustomerId: string;
  readonly stripePriceId: string;
  readonly fiefUserId: string;
  readonly saleorUserId: string | null;
  readonly status: SubscriptionStatus;
  readonly currentPeriodStart: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly lastInvoiceId: string | null;
  readonly lastSaleorOrderId: string | null;

  constructor(args: {
    stripeSubscriptionId: string;
    stripeCustomerId: string;
    stripePriceId: string;
    fiefUserId: string;
    saleorUserId: string | null;
    status: SubscriptionStatus;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
    lastInvoiceId: string | null;
    lastSaleorOrderId: string | null;
  }) {
    this.stripeSubscriptionId = args.stripeSubscriptionId;
    this.stripeCustomerId = args.stripeCustomerId;
    this.stripePriceId = args.stripePriceId;
    this.fiefUserId = args.fiefUserId;
    this.saleorUserId = args.saleorUserId;
    this.status = args.status;
    this.currentPeriodStart = args.currentPeriodStart;
    this.currentPeriodEnd = args.currentPeriodEnd;
    this.cancelAtPeriodEnd = args.cancelAtPeriodEnd;
    this.lastInvoiceId = args.lastInvoiceId;
    this.lastSaleorOrderId = args.lastSaleorOrderId;
  }
}
