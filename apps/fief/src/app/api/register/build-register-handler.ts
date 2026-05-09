import { createAppRegisterHandler } from "@saleor/app-sdk/handlers/next-app-router";

import { createLogger } from "@/lib/logger";
import { saleorApp } from "@/lib/saleor-app";
import { type RunWebhookMigrationsUseCase } from "@/modules/webhook-management";

import { isAllowedSaleorUrl } from "./is-allowed-saleor-url";

/*
 * T16 — Custom App Router register handler factory.
 *
 * Extracted out of `route.ts` because Next.js App Router rejects any
 * non-standard exports from `route.ts` (it only allows `GET`/`POST`/etc. and
 * route-config symbols). Keeping the factory here lets tests import it without
 * tripping the route-export contract during `next build`.
 *
 * Wraps `createAppRegisterHandler` from `@saleor/app-sdk` with:
 *   - `ALLOWED_DOMAIN_PATTERN` install allowlist (Stripe-pattern, extracted to
 *     `./is-allowed-saleor-url.ts` so the gate is unit-testable in isolation).
 *   - **Post-APL-set hook** that drives `RunWebhookMigrationsUseCase` (T49) to
 *     reconcile the live Saleor app's webhook subscriptions against the
 *     manifest. The manifest is currently empty (T1 ships `webhooks: []`); the
 *     runner correctly no-ops in that case. T26-T29 will populate the manifest
 *     and the same code path picks up the new webhook definitions automatically
 *     — this is the "one place to wire everything in" promised by R14.
 *   - **Explicit non-goal**: we do NOT auto-provision a `ProviderConnection`
 *     here. The operator opts in to a tenant via the T35 UI (per PRD §F1.4 the
 *     fact that the app is installed does not imply Fief sync is wanted —
 *     credentials must be entered first).
 *   - `onAplSetFailed` logs a structured error so operators can diagnose Mongo
 *     write failures during install.
 */

const logger = createLogger("createAppRegisterHandler");

/**
 * Factory exposed primarily as a testing seam: `route.ts` imports this with
 * the production singleton (`runWebhookMigrations`); tests can inject a fake
 * `RunWebhookMigrationsUseCase` to assert the post-APL-set contract without
 * standing up urql + a real Saleor.
 */
export const buildRegisterHandler = (deps: {
  runWebhookMigrations: Pick<RunWebhookMigrationsUseCase, "execute">;
  allowedDomainPattern: string | undefined;
}) =>
  createAppRegisterHandler({
    apl: saleorApp.apl,
    /**
     * Prohibit installation from Saleor instances other than those matched by
     * the regex. Source is an env variable controlled by the operator — if it
     * is unset, all installations are allowed (matches Stripe's default).
     */
    allowedSaleorUrls: [(url) => isAllowedSaleorUrl(url, deps.allowedDomainPattern)],
    onAplSetFailed: async (_req, context) => {
      logger.error("Failed to set APL during install", {
        saleorApiUrl: context.authData.saleorApiUrl,
        error: context.error,
      });
    },
    onAuthAplSaved: async (_req, context) => {
      const { saleorApiUrl, token } = context.authData;

      logger.info("App configuration set up successfully", { saleorApiUrl });

      /*
       * Reconcile the live Saleor app's webhook subscriptions against the
       * declared manifest. We do this **after** the APL has been written so
       * that, if migration fails, the operator can re-trigger it (T34) without
       * losing the auth row. The runner returns a Result; a failure is logged
       * but is **not** surfaced as an HTTP error — install completed
       * successfully, the migration step just needs a retry.
       */
      const result = await deps.runWebhookMigrations.execute({ saleorApiUrl, token });

      if (result.isErr()) {
        logger.error(
          "Webhook migration failed during install — install completed but webhook reconciliation must be re-run",
          {
            saleorApiUrl,
            error: result.error,
          },
        );

        return;
      }

      logger.info("Webhook migration completed during install", { saleorApiUrl });
    },
  });
