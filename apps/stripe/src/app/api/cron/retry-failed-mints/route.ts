/**
 * POST /api/cron/retry-failed-mints
 *
 * Cron-driven sweeper for the failed-mint DLQ (T32).
 *
 * Auth: `Authorization: Bearer ${env.CRON_SECRET}`. Vercel Cron injects this
 * header automatically when CRON_SECRET is set in the deployment env. The
 * request is rejected with 401 when the secret is missing or mismatched.
 *
 * The route handler is intentionally THIN — Next.js App Router rejects any
 * non-Route exports from `route.ts` (causes `next build` to fail with
 * `"X" is not a valid Route export field.`). The full implementation,
 * including the `executeRetryCron` sweeper and the test-facing helpers, lives
 * in `@/modules/subscriptions/cron/retry-failed-mints.ts`.
 */
import { captureException } from "@sentry/nextjs";
import { type NextRequest } from "next/server";

import { env } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import {
  executeRetryCron,
  productionDeps,
  verifyCronAuth,
} from "@/modules/subscriptions/cron/retry-failed-mints";

const logger = createLogger("RetryFailedMintsCronRoute");

export const POST = async (request: NextRequest): Promise<Response> => {
  const authError = verifyCronAuth(request, env.CRON_SECRET);

  if (authError) return authError;

  try {
    const summary = await executeRetryCron(productionDeps());

    logger.info("retry-failed-mints cron run complete", {
      processed: summary.processed,
      succeeded: summary.succeeded,
      failedRetries: summary.failedRetries,
      finalFailures: summary.finalFailures,
      totalErrors: summary.totalErrors,
    });

    return new Response(JSON.stringify(summary), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    /*
     * Outer catch — only fires for truly unexpected errors (the inner sweeper
     * already swallows per-entry failures into the summary). Surface a 500
     * here AND fire Sentry; Vercel will retry but at-least-once is acceptable
     * because every per-entry path is itself idempotent.
     */
    logger.error("retry-failed-mints cron run threw unexpectedly", { error: e });
    captureException(e, { level: "error", tags: { route: "retry-failed-mints" } });

    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
