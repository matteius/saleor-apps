/**
 * T18a Part 2 — one-shot migration to extend `enabled_events` on the Stripe
 * webhook endpoint of every already-installed Saleor instance.
 *
 * Why this script exists:
 *   T18a Part 1 changed `supportedStripeEvents` so NEW installs subscribe to
 *   `customer.subscription.*`, `invoice.*` from `webhookEndpoints.create`.
 *   But existing installations (e.g. live prod + tester instances) keep
 *   the original `payment_intent.*` + `charge.refund.updated` set on the live
 *   Stripe webhook endpoint until something explicitly calls
 *   `webhookEndpoints.update` on each one. That's what this script does.
 *
 * Pattern mirrors `scripts/run-webhooks-migration.ts` (read APL → fan out per
 * installation → log + Sentry on failure) and `scripts/rotate-secret-key.ts`
 * (CLI flags, dry-run, exit-code semantics). It does NOT use
 * `@saleor/webhook-utils` because that runner targets Saleor-side webhooks via
 * GraphQL; here we target Stripe-side webhook endpoints via the Stripe SDK.
 *
 * NOTE: This file is intentionally NOT executed by Part 1. The user gates the
 * actual run separately (Part 2) so they can target a tester instance first,
 * verify in the Stripe Dashboard, then promote to production.
 *
 * Usage:
 *   pnpm tsx --env-file-if-exists=.env scripts/run-subscription-webhook-events-migration.ts [--dry-run] [--installation-only=<saleorApiUrl>]
 *
 * Flags:
 *   --dry-run                    List endpoints that WOULD be updated without
 *                                calling webhookEndpoints.update.
 *   --installation-only=<url>    Limit to the single installation whose APL
 *                                saleorApiUrl exactly matches <url>. Useful
 *                                for piloting against a tester instance first.
 */
import { parseArgs } from "node:util";

import * as Sentry from "@sentry/nextjs";
import type { Stripe } from "stripe";

import { env } from "@/lib/env";
import { saleorApp } from "@/lib/saleor-app";
import { appConfigRepoImpl } from "@/modules/app-config/repositories/app-config-repo-impl";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { StripeClient } from "@/modules/stripe/stripe-client";
import { supportedStripeEvents } from "@/modules/stripe/supported-stripe-events";

import { createMigrationScriptLogger } from "./migration-logger";

const {
  values: { "dry-run": dryRun, "installation-only": installationOnly },
} = parseArgs({
  options: {
    "dry-run": {
      type: "boolean",
      default: false,
    },
    "installation-only": {
      type: "string",
    },
  },
});

const logger = createMigrationScriptLogger("SubscriptionWebhookEventsMigration");

Sentry.init({
  dsn: env.NEXT_PUBLIC_SENTRY_DSN,
  environment: env.ENV,
  includeLocalVariables: true,
  skipOpenTelemetrySetup: true,
  ignoreErrors: [],
  integrations: [],
});

type Counters = {
  installationsProcessed: number;
  installationsSkipped: number;
  endpointsUpdated: number;
  endpointsAlreadyCurrent: number;
  errors: number;
};

const counters: Counters = {
  installationsProcessed: 0,
  installationsSkipped: 0,
  endpointsUpdated: 0,
  endpointsAlreadyCurrent: 0,
  errors: 0,
};

/**
 * Stripe `webhookEndpoints.list` returns every endpoint on the account, not
 * just those created by this app. Match by metadata first (the create call
 * stamps `saleorAppConfigurationId`), then fall back to URL containment in
 * case some legacy endpoint predates the metadata stamp.
 */
const isAppOwnedEndpoint = (
  endpoint: { id: string; url: string; metadata?: Record<string, string> | null },
  configurationId: string,
): boolean => {
  if (endpoint.metadata?.saleorAppConfigurationId === configurationId) {
    return true;
  }

  // Defensive: legacy endpoints (pre-metadata) — match by URL containing the configurationId query param.
  if (endpoint.url.includes(`configurationId=${configurationId}`)) {
    return true;
  }

  return false;
};

const desiredEnabledEvents = supportedStripeEvents.slice().sort();

const arraysEqualAsSets = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean => {
  if (a.length !== b.length) return false;
  const sa = new Set(a);

  for (const v of b) if (!sa.has(v)) return false;

  return true;
};

const migrateOneInstallation = async (saleorApiUrl: SaleorApiUrl, appId: string) => {
  const rootConfigResult = await appConfigRepoImpl.getRootConfig({
    saleorApiUrl,
    appId,
  });

  if (rootConfigResult.isErr()) {
    counters.errors++;
    logger.error("Failed to fetch root config for installation", {
      saleorApiUrl,
      appId,
      error: rootConfigResult.error.message,
    });
    Sentry.captureException(rootConfigResult.error);

    return;
  }

  const stripeConfigs = rootConfigResult.value.getAllConfigsAsList();

  if (stripeConfigs.length === 0) {
    logger.warn("Installation has no Stripe configs — nothing to migrate", {
      saleorApiUrl,
      appId,
    });
    counters.installationsSkipped++;

    return;
  }

  for (const stripeConfig of stripeConfigs) {
    const client = StripeClient.createFromRestrictedKey(stripeConfig.restrictedKey);

    /**
     * We could `webhookEndpoints.retrieve(stripeConfig.webhookId)` directly,
     * but list-and-filter is more forgiving when the stored webhookId has
     * drifted (e.g. the endpoint was recreated in the Stripe Dashboard and
     * the app's stored ID points to a deleted endpoint). It also surfaces
     * orphan duplicates we can warn on.
     */
    let candidateEndpoints: Array<{
      id: string;
      url: string;
      enabled_events: string[];
      metadata?: Record<string, string> | null;
    }> = [];

    try {
      const list = await client.nativeClient.webhookEndpoints.list({ limit: 100 });

      candidateEndpoints = list.data
        .map((e) => ({
          id: e.id,
          url: e.url,
          enabled_events: e.enabled_events as string[],
          metadata: e.metadata,
        }))
        .filter((e) => isAppOwnedEndpoint(e, stripeConfig.id));
    } catch (e) {
      counters.errors++;
      logger.error("Failed to list Stripe webhook endpoints", {
        saleorApiUrl,
        appId,
        configurationId: stripeConfig.id,
        error: e instanceof Error ? e.message : String(e),
      });
      Sentry.captureException(e);
      continue;
    }

    if (candidateEndpoints.length === 0) {
      logger.warn("No Stripe webhook endpoint found for this Stripe config", {
        saleorApiUrl,
        appId,
        configurationId: stripeConfig.id,
        storedWebhookId: stripeConfig.webhookId,
      });
      counters.installationsSkipped++;
      continue;
    }

    if (candidateEndpoints.length > 1) {
      logger.warn(
        "Found multiple Stripe webhook endpoints belonging to this configuration; updating all of them",
        {
          saleorApiUrl,
          appId,
          configurationId: stripeConfig.id,
          endpointIds: candidateEndpoints.map((e) => e.id),
        },
      );
    }

    for (const endpoint of candidateEndpoints) {
      const current = endpoint.enabled_events.slice().sort();

      if (arraysEqualAsSets(current, desiredEnabledEvents)) {
        logger.info("Endpoint already has the full event set — skipping", {
          endpointId: endpoint.id,
          saleorApiUrl,
        });
        counters.endpointsAlreadyCurrent++;
        continue;
      }

      const toAdd = desiredEnabledEvents.filter((evt) => !current.includes(evt));

      if (dryRun) {
        logger.info("[DRY RUN] Would update endpoint enabled_events", {
          endpointId: endpoint.id,
          saleorApiUrl,
          configurationId: stripeConfig.id,
          currentEventCount: current.length,
          desiredEventCount: desiredEnabledEvents.length,
          eventsToAdd: toAdd,
        });
        counters.endpointsUpdated++; // count as "would-update" for the summary
        continue;
      }

      try {
        await client.nativeClient.webhookEndpoints.update(endpoint.id, {
          enabled_events:
            supportedStripeEvents as Array<Stripe.WebhookEndpointUpdateParams.EnabledEvent>,
        });

        logger.info("Updated endpoint enabled_events", {
          endpointId: endpoint.id,
          saleorApiUrl,
          configurationId: stripeConfig.id,
          eventsAdded: toAdd,
        });
        counters.endpointsUpdated++;
      } catch (e) {
        counters.errors++;
        logger.error("Failed to update endpoint enabled_events", {
          endpointId: endpoint.id,
          saleorApiUrl,
          configurationId: stripeConfig.id,
          error: e instanceof Error ? e.message : String(e),
        });
        Sentry.captureException(e);
      }
    }
  }

  counters.installationsProcessed++;
};

const runMigrations = async () => {
  logger.info("Starting subscription webhook events migration", {
    dryRun: dryRun ?? false,
    installationOnly: installationOnly ?? null,
    desiredEventCount: desiredEnabledEvents.length,
  });

  const saleorAPL = saleorApp.apl;

  const installations = await saleorAPL.getAll().catch((e: unknown) => {
    logger.error(`Could not fetch instances from the ${env.APL} APL`, {
      error: e instanceof Error ? e.message : String(e),
    });
    process.exit(1);
  });

  const filtered = installationOnly
    ? installations.filter((i) => i.saleorApiUrl === installationOnly)
    : installations;

  if (installationOnly && filtered.length === 0) {
    logger.error("--installation-only did not match any installation in the APL", {
      requested: installationOnly,
      availableSaleorApiUrls: installations.map((i) => i.saleorApiUrl),
    });
    process.exit(1);
  }

  logger.info(`Will process ${filtered.length} installation(s)`);

  await Promise.allSettled(
    filtered.map(async (saleorEnv) => {
      const { saleorApiUrl, appId } = saleorEnv;

      logger.info(`Processing installation`, { saleorApiUrl, appId });

      try {
        await migrateOneInstallation(saleorApiUrl as SaleorApiUrl, appId);
      } catch (e) {
        counters.errors++;
        logger.error("Unhandled error processing installation", {
          saleorApiUrl,
          appId,
          error: e instanceof Error ? e.message : String(e),
        });
        Sentry.captureException(e);
      }
    }),
  );
};

runMigrations()
  .then(async () => {
    logger.info("Subscription webhook events migration complete", {
      ...counters,
      dryRun: dryRun ?? false,
    });
    await Sentry.flush(5000);
    process.exit(counters.errors > 0 ? 1 : 0);
  })
  .catch(async (e) => {
    logger.error("Fatal error during subscription webhook events migration", {
      error: e instanceof Error ? e.message : String(e),
    });
    Sentry.captureException(e);
    await Sentry.flush(5000);
    process.exit(1);
  });
