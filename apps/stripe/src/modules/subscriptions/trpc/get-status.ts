/**
 * tRPC handler for `subscriptions.getStatus`.
 *
 * Input: { stripeSubscriptionId } or { fiefUserId }. Reads from the
 * DynamoDB cache (fast path). Returns subscription state for storefront
 * polling and OwlBooks settings UI.
 *
 * To be fully implemented in T23.
 */
import { type SubscriptionStatus } from "../repositories/subscription-record";

export const TODO_T23_GET_STATUS = "implement in T23";

export type GetStatusInput = { stripeSubscriptionId: string } | { fiefUserId: string };

export interface GetStatusOutput {
  status: SubscriptionStatus;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  lastSaleorOrderId: string | null;
  planName: string | null;
}
