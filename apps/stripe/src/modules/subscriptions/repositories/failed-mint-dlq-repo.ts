/**
 * Failed-mint dead-letter queue (T32).
 *
 * When T14's `invoice.paid` handler successfully receives a Stripe webhook —
 * meaning the customer's card was already charged — but the subsequent Saleor
 * `mintOrderFromInvoice` call fails (network blip, GraphQL error, transient
 * Saleor outage), we are in the dangerous "money taken, no Saleor order"
 * state described in PRD §10.
 *
 * The webhook MUST NOT bubble this as an Err: doing so makes Stripe retry the
 * delivery, but the underlying Saleor failure is unlikely to resolve in the
 * Stripe retry window AND the retry would re-enter the same handler with no
 * additional information.
 *
 * Instead, the handler records the failure here (the DLQ owns retry from this
 * point onward) and returns Ok so Stripe sees the webhook as acknowledged. A
 * separate cron-driven retry route ({@link
 * app/api/cron/retry-failed-mints/route.ts}) sweeps pending entries with the
 * exponential backoff schedule defined in
 * {@link webhooks/dlq-backoff.ts}. After {@link MAX_DLQ_ATTEMPTS}
 * attempts the entry is flagged via {@link FailedMintDlqRepo.markFinalFailure}
 * and a fatal-level Sentry alert pages on-call. Per PRD §10 we **never**
 * auto-refund — that decision requires a human in the loop.
 *
 * Mirrors the T17 RefundDlqRepo pattern (single-table DynamoDB scoped per
 * installation; PutItem upserts on retry; PK derived from saleorApiUrl#appId,
 * SK = `failed-mint#${stripeInvoiceId}`).
 */
import { type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

export const FailedMintDlqRepoError = {
  PersistenceFailedError: BaseError.subclass("FailedMintDlqRepo.PersistenceFailedError", {
    props: {
      _internalName: "FailedMintDlqRepo.PersistenceFailedError" as const,
    },
  }),
};

export type FailedMintDlqRepoError = InstanceType<
  typeof FailedMintDlqRepoError.PersistenceFailedError
>;

export interface FailedMintDlqAccess {
  saleorApiUrl: SaleorApiUrl;
  appId: string;
}

/**
 * Domain shape persisted in the DLQ. Note: `invoicePayload` is the JSON-
 * serialized `Stripe.Invoice` so the retry route can reconstruct
 * `mintOrderFromInvoice` arguments without re-fetching from Stripe.
 */
export interface FailedMintRecord {
  stripeInvoiceId: string;
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  fiefUserId: string;
  saleorChannelSlug: string;
  saleorVariantId: string;
  amountCents: number;
  currency: string;
  taxCents: number;
  errorMessage: string;
  /**
   * Coarse-grained taxonomy for triage / dashboarding (e.g. `"GraphQLError"`,
   * `"NetworkError"`, `"DraftOrderCreateFailedError"`).
   */
  errorClass: string;
  /** 1-indexed; first failure stores attemptCount=1, etc. */
  attemptCount: number;
  /** Unix epoch seconds. The retry sweeper picks up entries with `nextRetryAt <= now`. */
  nextRetryAt: number;
  /** Unix epoch seconds. Set on first record write and never updated. */
  firstAttemptAt: number;
  /** Unix epoch seconds. Updated on every record write. */
  lastAttemptAt: number;
  /** JSON-serialized {@link Stripe.Invoice}. Replayed verbatim by the retry route. */
  invoicePayload: string;
  /**
   * Set by {@link FailedMintDlqRepo.markFinalFailure} once attemptCount has
   * exhausted MAX_DLQ_ATTEMPTS. Entry intentionally stays in the queue (rather
   * than being deleted) so ops can review the full payload + history.
   */
  finalFailureAlertedAt?: number;
}

export interface FailedMintDlqRepo {
  /** Initial write OR upsert on a subsequent failed retry. */
  record(
    access: FailedMintDlqAccess,
    record: FailedMintRecord,
  ): Promise<Result<null, FailedMintDlqRepoError>>;

  /** Read a single entry by its Stripe invoice id. */
  getById(
    access: FailedMintDlqAccess,
    stripeInvoiceId: string,
  ): Promise<Result<FailedMintRecord | null, FailedMintDlqRepoError>>;

  /**
   * Partition-scoped Query returning entries whose `nextRetryAt` is at or
   * before `beforeUnixSeconds`. Used by the cron sweeper.
   */
  listPendingRetries(
    access: FailedMintDlqAccess,
    beforeUnixSeconds: number,
  ): Promise<Result<FailedMintRecord[], FailedMintDlqRepoError>>;

  /** Hard delete — called after a successful retry. */
  delete(
    access: FailedMintDlqAccess,
    stripeInvoiceId: string,
  ): Promise<Result<null, FailedMintDlqRepoError>>;

  /**
   * Flips `finalFailureAlertedAt`. The entry stays in the DLQ for ops review
   * (see header comment).
   */
  markFinalFailure(
    access: FailedMintDlqAccess,
    stripeInvoiceId: string,
  ): Promise<Result<null, FailedMintDlqRepoError>>;
}
