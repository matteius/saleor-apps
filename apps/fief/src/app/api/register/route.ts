import { compose } from "@saleor/apps-shared/compose";

import { env } from "@/lib/env";
import { withLoggerContext } from "@/lib/logger-context";
import { withSaleorApiUrlAttributes } from "@/lib/observability-saleor-api-url";
import { RunWebhookMigrationsUseCase } from "@/modules/webhook-management";

import { buildRegisterHandler } from "./build-register-handler";

/*
 * Route file is intentionally thin — the handler factory and its hooks live in
 * `./build-register-handler.ts` so they're importable from tests without
 * tripping Next.js' Route export contract (App Router rejects any non-standard
 * exports from `route.ts` and would fail `next build` with
 * "buildRegisterHandler is not a valid Route export field.")
 */

/**
 * Module-level singleton — the use case is stateless apart from its injected
 * collaborators, so re-creating it per request would be pure waste. Tests that
 * want a different instance pass one to `buildRegisterHandler` directly.
 */
const runWebhookMigrations = new RunWebhookMigrationsUseCase();

const handler = buildRegisterHandler({
  runWebhookMigrations,
  allowedDomainPattern: env.ALLOWED_DOMAIN_PATTERN,
});

export const POST = compose(withLoggerContext, withSaleorApiUrlAttributes)(handler);
