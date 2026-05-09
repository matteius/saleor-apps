/**
 * Domain model for a subscription cached in DynamoDB.
 *
 * Mirrors `transactions-recording/domain/recorded-transaction.ts`.
 *
 * The Postgres `UserSubscription` table in OwlBooks remains the durable system
 * of record; this DynamoDB record is a fast-lookup cache scoped to a Saleor
 * installation for webhook routing (avoids cross-system Postgres calls during
 * the webhook hot path).
 */
import type { Stripe } from "stripe";
import { z } from "zod";

/**
 * Branded ID types — mirrors `SaleorTransactionId` / `StripePaymentIntentId` patterns.
 */
const stripeSubscriptionIdSchema = z.string().min(1).brand("StripeSubscriptionId");

export const createStripeSubscriptionId = (raw: string) => stripeSubscriptionIdSchema.parse(raw);

export type StripeSubscriptionId = z.infer<typeof stripeSubscriptionIdSchema>;

const stripeCustomerIdSchema = z.string().min(1).brand("StripeCustomerId");

export const createStripeCustomerId = (raw: string) => stripeCustomerIdSchema.parse(raw);

export type StripeCustomerId = z.infer<typeof stripeCustomerIdSchema>;

const stripePriceIdSchema = z.string().min(1).brand("StripePriceId");

export const createStripePriceId = (raw: string) => stripePriceIdSchema.parse(raw);

export type StripePriceId = z.infer<typeof stripePriceIdSchema>;

const fiefUserIdSchema = z.string().min(1).brand("FiefUserId");

export const createFiefUserId = (raw: string) => fiefUserIdSchema.parse(raw);

export type FiefUserId = z.infer<typeof fiefUserIdSchema>;

const saleorChannelSlugSchema = z.string().min(1).brand("SaleorChannelSlug");

export const createSaleorChannelSlug = (raw: string) => saleorChannelSlugSchema.parse(raw);

export type SaleorChannelSlug = z.infer<typeof saleorChannelSlugSchema>;

const saleorEntityIdSchema = z.string().min(1).brand("SaleorEntityId");

export const createSaleorEntityId = (raw: string) => saleorEntityIdSchema.parse(raw);

export type SaleorEntityId = z.infer<typeof saleorEntityIdSchema>;

/**
 * Use Stripe SDK's authoritative subscription status type. Plan §5.2 specifies
 * `SubscriptionStatus` from generated Stripe types.
 */
export type SubscriptionStatus = Stripe.Subscription.Status;

export class SubscriptionRecord {
  readonly stripeSubscriptionId: StripeSubscriptionId;
  readonly stripeCustomerId: StripeCustomerId;
  readonly saleorChannelSlug: SaleorChannelSlug;
  readonly saleorUserId: string;
  readonly fiefUserId: FiefUserId;
  readonly saleorEntityId: SaleorEntityId | null;
  readonly stripePriceId: StripePriceId;
  readonly status: SubscriptionStatus;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly cancelAtPeriodEnd: boolean;
  readonly lastInvoiceId: string | null;
  readonly lastSaleorOrderId: string | null;
  /**
   * Human-readable plan name (e.g. Stripe Product `name`) cached on the
   * record by T20 (`create`) and T15 (`updated`) for the storefront /
   * settings UI to render without an extra Stripe API round-trip on every
   * `getStatus` poll.
   *
   * Nullable for forward/backward compat — pre-T23 records won't have it,
   * and T23 (`getStatus`) falls back to the `stripePriceId` string when
   * absent. See the T23 plan log for the rationale (option (b)).
   */
  readonly planName: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;

  constructor(args: {
    stripeSubscriptionId: StripeSubscriptionId;
    stripeCustomerId: StripeCustomerId;
    saleorChannelSlug: SaleorChannelSlug;
    saleorUserId: string;
    fiefUserId: FiefUserId;
    saleorEntityId?: SaleorEntityId | null;
    stripePriceId: StripePriceId;
    status: SubscriptionStatus;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    lastInvoiceId?: string | null;
    lastSaleorOrderId?: string | null;
    planName?: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    this.stripeSubscriptionId = args.stripeSubscriptionId;
    this.stripeCustomerId = args.stripeCustomerId;
    this.saleorChannelSlug = args.saleorChannelSlug;
    this.saleorUserId = args.saleorUserId;
    this.fiefUserId = args.fiefUserId;
    this.saleorEntityId = args.saleorEntityId ?? null;
    this.stripePriceId = args.stripePriceId;
    this.status = args.status;
    this.currentPeriodStart = args.currentPeriodStart;
    this.currentPeriodEnd = args.currentPeriodEnd;
    this.cancelAtPeriodEnd = args.cancelAtPeriodEnd;
    this.lastInvoiceId = args.lastInvoiceId ?? null;
    this.lastSaleorOrderId = args.lastSaleorOrderId ?? null;
    this.planName = args.planName ?? null;
    this.createdAt = args.createdAt;
    this.updatedAt = args.updatedAt;
  }
}
