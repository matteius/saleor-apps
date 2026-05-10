/**
 * Implementation backing POST /api/cron/retry-failed-mints (T32).
 *
 * Lives outside the App Router segment so non-Route exports (`executeRetryCron`,
 * `RetryCronSummary`, `RetryCronDeps`, `MintFn`, `verifyCronAuth`, `__testing`)
 * don't collide with Next.js' route-export contract — the route file would
 * otherwise fail `next build` with
 * `"executeRetryCron" is not a valid Route export field.`
 *
 * The route file at `src/app/api/cron/retry-failed-mints/route.ts` re-exports
 * only `POST` and wires it via `productionDeps()`.
 *
 * Algorithm:
 *   for each installation in APL:
 *     for each DLQ entry where nextRetryAt <= now:
 *       deserialize invoicePayload back into a Stripe.Invoice
 *       call mintOrderFromInvoice (idempotent on subscription state via
 *           the underlying Saleor order metadata + Postgres @unique)
 *       if Ok:
 *         notify OwlBooks of the now-paid invoice
 *         delete DLQ entry
 *       if Err:
 *         attemptCount++
 *         if attemptCount > MAX: markFinalFailure + Sentry.captureException(level=fatal)
 *         else: re-record with computeNextRetryAt(attemptCount, now)
 *
 * The sweeper deliberately NEVER throws — partial failures are surfaced through
 * the summary and via Sentry, never via a 5xx (Vercel Cron retries on 5xx,
 * which would re-enter installations that already succeeded).
 */
import { type Span, trace } from "@opentelemetry/api";
import { type APL } from "@saleor/app-sdk/APL";
import { addBreadcrumb, captureException } from "@sentry/nextjs";
import { ok, type Result } from "neverthrow";
import type Stripe from "stripe";

import { env } from "@/lib/env";
import { createInstrumentedGraphqlClient } from "@/lib/graphql-client";
import { createLogger } from "@/lib/logger";
import { saleorApp } from "@/lib/saleor-app";
import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import {
  HttpOwlBooksWebhookNotifier,
  type OwlBooksWebhookNotifier,
  type OwlBooksWebhookPayload,
} from "@/modules/subscriptions/notifiers/owlbooks-notifier";
import {
  type FailedMintDlqRepo,
  type FailedMintRecord,
} from "@/modules/subscriptions/repositories/failed-mint-dlq-repo";
import { failedMintDlqRepo } from "@/modules/subscriptions/repositories/failed-mint-dlq-repo-impl";
import {
  createStripeSubscriptionId,
  type SubscriptionRecord,
} from "@/modules/subscriptions/repositories/subscription-record";
import { type SubscriptionRepo } from "@/modules/subscriptions/repositories/subscription-repo";
import { subscriptionRepo } from "@/modules/subscriptions/repositories/subscription-repo-impl";
import {
  mintOrderFromInvoice as defaultMintOrderFromInvoice,
  type MintOrderFromInvoiceArgs,
  type MintOrderFromInvoiceResult,
  type SaleorOrderFromInvoiceError,
} from "@/modules/subscriptions/saleor-bridge/saleor-order-from-invoice";
import { computeNextRetryAt, MAX_DLQ_ATTEMPTS } from "@/modules/subscriptions/webhooks/dlq-backoff";

const logger = createLogger("RetryFailedMintsCron");

/**
 * T34 — shared OTEL tracer for the DLQ retry cron. The cron is tagged in its
 * own root span when run via Vercel Cron; this gives us per-installation child
 * spans we can drill into.
 */
const subscriptionsTracer = trace.getTracer("subscriptions");

export interface RetryCronSummary {
  processed: number;
  succeeded: number;
  failedRetries: number;
  finalFailures: number;
  totalErrors: number;
}

export type MintFn = (
  args: MintOrderFromInvoiceArgs,
) => Promise<Result<MintOrderFromInvoiceResult, SaleorOrderFromInvoiceError>>;

export interface RetryCronDeps {
  apl: APL;
  failedMintDlqRepo: FailedMintDlqRepo;
  subscriptionRepo: SubscriptionRepo;
  owlbooksWebhookNotifier: OwlBooksWebhookNotifier;
  mintOrderFromInvoice: MintFn;
  graphqlClientFactory: (authData: {
    saleorApiUrl: string;
    token: string;
  }) => MintOrderFromInvoiceArgs["graphqlClient"];
  nowUnixSeconds: () => number;
  /** Hook for tests; production uses `@sentry/nextjs` `captureException`. */
  captureException: typeof captureException;
}

const isoOrUndefined = (d: Date | null | undefined): string | undefined =>
  d ? d.toISOString() : undefined;

/**
 * Core sweeper, exported for direct unit-testing without spinning up Next.js
 * routing internals.
 */
export async function executeRetryCron(deps: RetryCronDeps): Promise<RetryCronSummary> {
  return subscriptionsTracer.startActiveSpan("cron.retry-failed-mints", async (span) => {
    try {
      return await executeRetryCronImpl(deps, span);
    } finally {
      span.end();
    }
  });
}

async function executeRetryCronImpl(
  deps: RetryCronDeps,
  rootSpan: Span,
): Promise<RetryCronSummary> {
  const summary: RetryCronSummary = {
    processed: 0,
    succeeded: 0,
    failedRetries: 0,
    finalFailures: 0,
    totalErrors: 0,
  };

  /*
   * T34 — gauges aggregated across installations:
   *   - failed_mints_pending: total rows currently in the DLQ that are
   *     eligible for retry (nextRetryAt <= now)
   *   - dlq_age_max: oldest pending entry's firstAttemptAt-to-now age in
   *     seconds, the SLO-tracking signal for "stuck money"
   */
  let pendingTotal = 0;
  let dlqAgeMaxSeconds = 0;

  const installations = await deps.apl.getAll();

  for (const authData of installations) {
    const apiUrlResult = createSaleorApiUrl(authData.saleorApiUrl);

    if (apiUrlResult.isErr()) {
      logger.warn("Skipping installation with un-parseable saleorApiUrl", {
        saleorApiUrl: authData.saleorApiUrl,
        error: apiUrlResult.error,
      });
      summary.totalErrors += 1;
      continue;
    }

    const access = { saleorApiUrl: apiUrlResult.value, appId: authData.appId };
    const now = deps.nowUnixSeconds();

    const pendingResult = await deps.failedMintDlqRepo.listPendingRetries(access, now);

    if (pendingResult.isErr()) {
      logger.error("Failed to list pending DLQ entries for installation", {
        saleorApiUrl: authData.saleorApiUrl,
        appId: authData.appId,
        error: pendingResult.error,
      });
      summary.totalErrors += 1;
      continue;
    }

    pendingTotal += pendingResult.value.length;
    for (const e of pendingResult.value) {
      const age = Math.max(0, now - e.firstAttemptAt);

      if (age > dlqAgeMaxSeconds) {
        dlqAgeMaxSeconds = age;
      }
    }

    for (const entry of pendingResult.value) {
      summary.processed += 1;

      // Skip entries that have already been escalated (still in DLQ for ops review).
      if (entry.finalFailureAlertedAt) {
        continue;
      }

      const subResult = await deps.subscriptionRepo.getBySubscriptionId(
        access,
        createStripeSubscriptionId(entry.stripeSubscriptionId),
      );

      if (subResult.isErr() || !subResult.value) {
        logger.error("DLQ retry: subscription record missing or unreadable", {
          stripeInvoiceId: entry.stripeInvoiceId,
          stripeSubscriptionId: entry.stripeSubscriptionId,
          error: subResult.isErr() ? subResult.error : "subscription_record_null",
        });

        await escalateOrReschedule({
          deps,
          access,
          entry,
          now,
          reason: "subscription_record_missing",
        });
        summary.totalErrors += 1;

        if (entry.attemptCount + 1 > MAX_DLQ_ATTEMPTS) {
          summary.finalFailures += 1;
        } else {
          summary.failedRetries += 1;
        }
        continue;
      }

      const subscriptionRecord: SubscriptionRecord = subResult.value;

      let invoice: Stripe.Invoice;

      try {
        invoice = JSON.parse(entry.invoicePayload) as Stripe.Invoice;
      } catch (e) {
        logger.error("DLQ retry: invoicePayload is not valid JSON — escalating immediately", {
          stripeInvoiceId: entry.stripeInvoiceId,
          parseError: e,
        });

        await deps.failedMintDlqRepo.markFinalFailure(access, entry.stripeInvoiceId);
        deps.captureException(e, {
          level: "fatal",
          tags: {
            stripeInvoiceId: entry.stripeInvoiceId,
            stripeSubscriptionId: entry.stripeSubscriptionId,
            errorClass: "InvoicePayloadCorrupted",
            attemptCount: String(entry.attemptCount),
          },
        });
        summary.finalFailures += 1;
        summary.totalErrors += 1;
        continue;
      }

      const graphqlClient = deps.graphqlClientFactory({
        saleorApiUrl: authData.saleorApiUrl,
        token: authData.token,
      });

      const mintResult = await deps.mintOrderFromInvoice({
        invoice,
        subscriptionRecord,
        saleorChannelSlug: entry.saleorChannelSlug,
        saleorVariantId: entry.saleorVariantId,
        graphqlClient,
      });

      if (mintResult.isOk()) {
        const minted = mintResult.value;

        // Notify OwlBooks (best-effort; logged but does NOT abort the cleanup).
        const payload: OwlBooksWebhookPayload = {
          type: "invoice.paid",
          stripeSubscriptionId: subscriptionRecord.stripeSubscriptionId,
          stripeCustomerId: subscriptionRecord.stripeCustomerId,
          fiefUserId: subscriptionRecord.fiefUserId,
          saleorUserId: subscriptionRecord.saleorUserId || undefined,
          stripeEventCreatedAt: now,
          status: subscriptionRecord.status.toUpperCase() as OwlBooksWebhookPayload["status"],
          stripePriceId: subscriptionRecord.stripePriceId,
          currentPeriodStart: isoOrUndefined(subscriptionRecord.currentPeriodStart),
          currentPeriodEnd: isoOrUndefined(subscriptionRecord.currentPeriodEnd),
          cancelAtPeriodEnd: subscriptionRecord.cancelAtPeriodEnd,
          lastInvoiceId: entry.stripeInvoiceId,
          lastSaleorOrderId: minted.saleorOrderId,
          saleorChannelSlug: entry.saleorChannelSlug,
          amountCents: entry.amountCents,
          taxCents: entry.taxCents,
          currency: entry.currency,
          stripeChargeId: minted.stripeChargeId,
        };

        const notifyResult = await deps.owlbooksWebhookNotifier.notify(payload);

        if (notifyResult.isErr()) {
          logger.warn("DLQ retry: OwlBooks notifier failed after successful mint — continuing", {
            stripeInvoiceId: entry.stripeInvoiceId,
            error: notifyResult.error,
          });
        }

        const deleteResult = await deps.failedMintDlqRepo.delete(access, entry.stripeInvoiceId);

        if (deleteResult.isErr()) {
          logger.error("DLQ retry: mint succeeded but failed to delete DLQ entry", {
            stripeInvoiceId: entry.stripeInvoiceId,
            error: deleteResult.error,
          });
          summary.totalErrors += 1;
        }

        /*
         * T34 — structured success log so dashboards can count
         * `dlq_retry_succeeded_total` over time.
         */
        logger.info("DLQ retry succeeded", {
          stripeInvoiceId: entry.stripeInvoiceId,
          stripeSubscriptionId: entry.stripeSubscriptionId,
          saleorOrderId: minted.saleorOrderId,
          attemptCount: entry.attemptCount,
          dlqAgeSeconds: Math.max(0, now - entry.firstAttemptAt),
        });

        addBreadcrumb({
          category: "subscriptions.dlq",
          message: `DLQ retry succeeded for invoice ${entry.stripeInvoiceId}`,
          level: "info",
          data: {
            stripeInvoiceId: entry.stripeInvoiceId,
            attemptCount: entry.attemptCount,
          },
        });

        summary.succeeded += 1;
        continue;
      }

      // Mint failed again.
      const nextAttempt = entry.attemptCount + 1;

      if (nextAttempt > MAX_DLQ_ATTEMPTS) {
        await deps.failedMintDlqRepo.markFinalFailure(access, entry.stripeInvoiceId);

        deps.captureException(mintResult.error, {
          level: "fatal",
          tags: {
            stripeInvoiceId: entry.stripeInvoiceId,
            stripeSubscriptionId: entry.stripeSubscriptionId,
            stripeCustomerId: entry.stripeCustomerId,
            fiefUserId: entry.fiefUserId,
            saleorChannelSlug: entry.saleorChannelSlug,
            errorClass: entry.errorClass,
            attemptCount: String(MAX_DLQ_ATTEMPTS),
            dlq: "failed-mint-final",
          },
        });

        logger.error(
          "[DLQ retry] FINAL FAILURE — entry marked + Sentry paged; PRD §10 'money taken, no Saleor order'",
          {
            stripeInvoiceId: entry.stripeInvoiceId,
            stripeSubscriptionId: entry.stripeSubscriptionId,
            attemptCount: MAX_DLQ_ATTEMPTS,
          },
        );

        /*
         * T34 — distinct "exhausted" structured log so the metrics pipeline
         * can count `dlq_entries_exhausted_total` separately from earlier
         * retry failures.
         */
        logger.info("DLQ entry exhausted", {
          stripeInvoiceId: entry.stripeInvoiceId,
          stripeSubscriptionId: entry.stripeSubscriptionId,
          attemptCount: MAX_DLQ_ATTEMPTS,
          errorClass: entry.errorClass,
          dlqAgeSeconds: Math.max(0, now - entry.firstAttemptAt),
        });

        addBreadcrumb({
          category: "subscriptions.dlq",
          message: `DLQ entry exhausted for invoice ${entry.stripeInvoiceId}`,
          level: "error",
          data: {
            stripeInvoiceId: entry.stripeInvoiceId,
            attemptCount: MAX_DLQ_ATTEMPTS,
            errorClass: entry.errorClass,
          },
        });

        summary.finalFailures += 1;
        summary.totalErrors += 1;
        continue;
      }

      const updatedRecord: FailedMintRecord = {
        ...entry,
        attemptCount: nextAttempt,
        nextRetryAt: computeNextRetryAt(nextAttempt, now) ?? now,
        lastAttemptAt: now,
        errorMessage: String(mintResult.error?.message ?? mintResult.error),
        errorClass: mintResult.error?.name ?? entry.errorClass,
      };

      const recordResult = await deps.failedMintDlqRepo.record(access, updatedRecord);

      if (recordResult.isErr()) {
        logger.error("DLQ retry: failed to update DLQ entry after mint failure", {
          stripeInvoiceId: entry.stripeInvoiceId,
          error: recordResult.error,
        });
        summary.totalErrors += 1;
      }

      summary.failedRetries += 1;
      summary.totalErrors += 1;
    }
  }

  /*
   * T34 — emit dashboard-card gauges. We log these as a structured info line
   * (the metrics scraper picks them up by message) AND set them on the active
   * OTEL span so traces also carry the snapshot.
   */
  rootSpan.setAttribute("dlq.pending_total", pendingTotal);
  rootSpan.setAttribute("dlq.age_max_seconds", dlqAgeMaxSeconds);
  rootSpan.setAttribute("dlq.summary.processed", summary.processed);
  rootSpan.setAttribute("dlq.summary.succeeded", summary.succeeded);
  rootSpan.setAttribute("dlq.summary.final_failures", summary.finalFailures);

  logger.info("DLQ gauges", {
    failed_mints_pending: pendingTotal,
    dlq_age_max: dlqAgeMaxSeconds,
    processed: summary.processed,
    succeeded: summary.succeeded,
    failedRetries: summary.failedRetries,
    finalFailures: summary.finalFailures,
  });

  return summary;
}

type DlqAccess = Parameters<FailedMintDlqRepo["record"]>[0];

async function escalateOrReschedule(args: {
  deps: RetryCronDeps;
  access: DlqAccess;
  entry: FailedMintRecord;
  now: number;
  reason: string;
}) {
  const { deps, access, entry, now, reason } = args;
  const nextAttempt = entry.attemptCount + 1;

  if (nextAttempt > MAX_DLQ_ATTEMPTS) {
    await deps.failedMintDlqRepo.markFinalFailure(access, entry.stripeInvoiceId);
    deps.captureException(new Error(`DLQ retry escalated: ${reason}`), {
      level: "fatal",
      tags: {
        stripeInvoiceId: entry.stripeInvoiceId,
        stripeSubscriptionId: entry.stripeSubscriptionId,
        reason,
        attemptCount: String(MAX_DLQ_ATTEMPTS),
      },
    });

    return ok(null);
  }

  const updated: FailedMintRecord = {
    ...entry,
    attemptCount: nextAttempt,
    nextRetryAt: computeNextRetryAt(nextAttempt, now) ?? now,
    lastAttemptAt: now,
    errorMessage: reason,
    errorClass: reason,
  };

  return deps.failedMintDlqRepo.record(access, updated);
}

export const productionDeps = (): RetryCronDeps => ({
  apl: saleorApp.apl,
  failedMintDlqRepo,
  subscriptionRepo,
  owlbooksWebhookNotifier: new HttpOwlBooksWebhookNotifier({
    url: env.OWLBOOKS_WEBHOOK_URL,
    secret: env.OWLBOOKS_WEBHOOK_SECRET,
  }),
  mintOrderFromInvoice: defaultMintOrderFromInvoice,
  graphqlClientFactory: (authData) =>
    createInstrumentedGraphqlClient({
      saleorApiUrl: authData.saleorApiUrl,
      token: authData.token,
    }),
  nowUnixSeconds: () => Math.floor(Date.now() / 1000),
  captureException,
});

/**
 * Verify the Vercel-Cron Bearer auth header. Exported and parameterised on
 * `expectedSecret` so tests don't have to fight `@t3-oss/env-nextjs`'s
 * import-time validation cache; production callers pass `env.CRON_SECRET`.
 */
export const verifyCronAuth = (
  request: Request,
  expectedSecret: string | undefined,
): Response | null => {
  if (!expectedSecret) {
    logger.error("CRON_SECRET is not configured — rejecting all cron invocations");

    return new Response(JSON.stringify({ error: "CRON_SECRET not configured" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const auth = request.headers.get("authorization") ?? request.headers.get("Authorization");

  if (auth !== `Bearer ${expectedSecret}`) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  return null;
};

// Helper export for tests that want to exercise just the auth gate.
export const __testing = { verifyCronAuth, logger };
