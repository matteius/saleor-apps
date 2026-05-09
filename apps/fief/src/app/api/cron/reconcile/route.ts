import { compose } from "@saleor/apps-shared/compose";
import { type NextRequest } from "next/server";

import { env } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { withLoggerContext } from "@/lib/logger-context";
import { withSaleorApiUrlAttributes } from "@/lib/observability-saleor-api-url";
import { saleorApp } from "@/lib/saleor-app";
import { ReconciliationRunner, type RunOutcome } from "@/modules/reconciliation/runner";

import { buildReconciliationRunnerDeps } from "./deps";

/*
 * T32 — `POST /api/cron/reconcile`
 *
 * Shared-secret guarded cron endpoint. Vercel Cron / external scheduler
 * pings this URL with the `X-Cron-Secret` header set to `env.CRON_SECRET`.
 * The handler:
 *
 *   1. Validates the header (401 on miss / mismatch — never echo the
 *      provided secret in errors).
 *   2. Lists every install in the APL (`saleorApp.apl.getAll()`).
 *   3. For each install, runs `runner.runForInstall(...)` SEQUENTIALLY. We
 *      do this serially across installs so a single cron tick can't
 *      stampede every Fief tenant in parallel.
 *   4. Returns 200 with a per-install summary payload. Errors during a
 *      single install's run are captured on the response (NOT propagated
 *      to a non-200) so a transient failure on install A doesn't block
 *      install B from running.
 *
 * Why no body parsing? — Cron clients post no payload. The handler accepts
 * POST with an empty body to keep cache-friendly behavior (POST is the
 * canonical "side-effecting" verb for triggers).
 *
 * Why route-level shared secret instead of a Saleor token? — There is no
 * Saleor user behind a cron tick; the endpoint is a privileged operator
 * surface. The shared secret is rotated independently of the per-connection
 * webhook secrets via `env.CRON_SECRET`.
 */

const logger = createLogger("api.cron.reconcile");

const unauthorizedResponse = (): Response =>
  new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });

const noopResponse = (reason: string): Response =>
  new Response(JSON.stringify({ ok: true, reason, installs: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

interface InstallReport {
  saleorApiUrl: string;
  outcomes: RunOutcome[];
  error?: string;
}

const handler = async (req: NextRequest): Promise<Response> => {
  const provided = req.headers.get("x-cron-secret");
  const expected = env.CRON_SECRET;

  if (expected === undefined || expected.length === 0) {
    /*
     * Closed-by-default. If the operator has not configured CRON_SECRET, the
     * endpoint is unreachable rather than open. This is the safer failure
     * mode (we deliberately do NOT auto-disable the route in production: the
     * 401 surfaces the misconfiguration to whoever scheduled the cron).
     */
    logger.warn("CRON_SECRET not configured — refusing reconciliation cron tick");

    return unauthorizedResponse();
  }

  if (provided === null || provided !== expected) {
    logger.warn("Reconciliation cron tick rejected: bad or missing X-Cron-Secret");

    return unauthorizedResponse();
  }

  let installs: { saleorApiUrl: string }[] = [];

  try {
    const all = await saleorApp.apl.getAll();

    installs = all.map((row) => ({ saleorApiUrl: row.saleorApiUrl }));
  } catch (cause) {
    logger.error("Failed to list installs from APL", {
      errorMessage: cause instanceof Error ? cause.message : String(cause),
    });

    return noopResponse("apl-unavailable");
  }

  if (installs.length === 0) {
    return noopResponse("no-installs");
  }

  const runnerDeps = buildReconciliationRunnerDeps();
  const runner = new ReconciliationRunner(runnerDeps);

  const reports: InstallReport[] = [];

  for (const install of installs) {
    try {
      const outcomes = await runner.runForInstall({
        saleorApiUrl: install.saleorApiUrl as never,
      });

      reports.push({
        saleorApiUrl: install.saleorApiUrl,
        outcomes,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);

      logger.error("Reconciliation runForInstall threw", {
        saleorApiUrl: install.saleorApiUrl,
        errorMessage: message,
      });

      reports.push({
        saleorApiUrl: install.saleorApiUrl,
        outcomes: [],
        error: message,
      });
    }
  }

  return new Response(JSON.stringify({ ok: true, installs: reports }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

export const POST = compose(withLoggerContext, withSaleorApiUrlAttributes)(handler);
