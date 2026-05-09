import { type WebhookManifest } from "@saleor/app-sdk/types";
import { createGraphQLClient } from "@saleor/apps-shared/create-graphql-client";
import { type AppDetails, WebhookMigrationRunner } from "@saleor/webhook-utils";
import { err, ok, type Result } from "neverthrow";
import { type Client } from "urql";

import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";

/*
 * `SaleorInstanceDetails` is only re-exported from a deep path inside
 * `@saleor/webhook-utils` (not via its index). We mirror the structural shape
 * here so we don't reach into the package's internals.
 */
type SaleorInstanceDetails = {
  version: number | null;
};

/*
 * T49 — wrap `@saleor/webhook-utils`'s `WebhookMigrationRunner` so the rest of
 * the app can reconcile a tenant's live Saleor app webhooks against the
 * declared manifest with one call:
 *
 *   const result = await runWebhookMigrations.execute({ saleorApiUrl, token });
 *
 * The runner is the canonical place where webhook drift is healed:
 *   - on install / re-install (T16 wires this into the post-register hook),
 *   - on operator demand from a tRPC procedure (T34),
 *   - from the offline migration script that other apps ship under
 *     `scripts/run-webhooks-migration.ts`.
 *
 * The webhook manifest list is intentionally empty at T1 (`webhooks: []` in
 * `pages/api/manifest.ts`); T26-T29 will populate it once the customer-event
 * webhook definitions land. The wrapper still calls the runner so that, when
 * the list becomes non-empty, the same code path picks it up — this is the
 * "one place to wire everything in" promised by R14 in the plan.
 *
 * Design notes:
 *   - We never throw across the module boundary. Errors come back as a typed
 *     `RunWebhookMigrationsError` via `neverthrow`'s `Result`.
 *   - Construction of the underlying `WebhookMigrationRunner` (and the urql
 *     `Client`) is hidden behind a `createMigrationRunner` factory injected via
 *     constructor args. Production wiring uses `defaultCreateMigrationRunner`,
 *     which builds a real urql client; tests inject a fake to keep the unit
 *     boundary at "wrapper invokes runner with the right args".
 *   - The `getWebhookManifests` source-of-truth is also injected. The default
 *     implementation lives in `webhook-manifests.ts` and currently returns an
 *     empty list (mirroring the manifest endpoint). Replacing the default at
 *     the call site (e.g. T16) is preferred to mutating the file every time a
 *     new webhook lands.
 */

/** Args the runner factory needs to build a `WebhookMigrationRunner`. */
export interface CreateMigrationRunnerArgs {
  saleorApiUrl: string;
  token: string;
  dryRun: boolean;
  logger: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    debug: (message: string, meta?: Record<string, unknown>) => void;
    error: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
  };
  getManifests: (args: {
    appDetails: AppDetails;
    instanceDetails: SaleorInstanceDetails;
  }) => Promise<Array<WebhookManifest>>;
}

/** Minimal "thing the use-case calls .migrate() on" — both the real runner and the test fake satisfy this. */
export interface WebhookMigrationRunnerLike {
  migrate: () => Promise<void>;
}

/** Factory shape used both in production and in unit tests. */
export type CreateMigrationRunner = (args: CreateMigrationRunnerArgs) => WebhookMigrationRunnerLike;

/** Source of webhook manifests — what we want the live Saleor app webhooks to converge to. */
export type GetWebhookManifests = (args: {
  appDetails: AppDetails;
  instanceDetails: SaleorInstanceDetails;
}) => Promise<Array<WebhookManifest>>;

/**
 * Default runner factory. Builds the urql client + `WebhookMigrationRunner`
 * with the canonical Saleor-apps shared client (no instrumentation — the
 * Fief app deliberately ships without OTel/Sentry per T47).
 */
export const defaultCreateMigrationRunner: CreateMigrationRunner = (args) => {
  const client: Client = createGraphQLClient({
    saleorApiUrl: args.saleorApiUrl,
    token: args.token,
  });

  return new WebhookMigrationRunner({
    dryRun: args.dryRun,
    logger: args.logger,
    client,
    saleorApiUrl: args.saleorApiUrl,
    getManifests: args.getManifests,
  });
};

/**
 * Default manifest source — empty list, matching the T1 manifest baseline.
 *
 * T26-T29 will replace this with a list backed by the per-event
 * `getWebhookManifest(apiBaseUrl)` calls. Until then the runner correctly
 * no-ops (`WebhookUpdater` over an empty target list is a no-op).
 */
export const defaultGetWebhookManifests: GetWebhookManifests = async () => [];

export const RunWebhookMigrationsError = BaseError.subclass("RunWebhookMigrationsError", {
  props: {
    _brand: "WebhookManagement.RunWebhookMigrationsError" as const,
  },
});

export type RunWebhookMigrationsError = InstanceType<typeof RunWebhookMigrationsError>;

export interface RunWebhookMigrationsArgs {
  saleorApiUrl: string;
  token: string;
  /**
   * When true, the runner only logs the diff against the live webhooks; no
   * mutations are sent. Mirrors the `--dry-run` flag of the equivalent
   * Stripe / segment / np-atobarai migration scripts.
   */
  dryRun?: boolean;
}

/**
 * Use case wrapping the shared `WebhookMigrationRunner`. Single public entry
 * point so the rest of the app does not import `@saleor/webhook-utils` directly.
 */
export class RunWebhookMigrationsUseCase {
  private readonly createMigrationRunner: CreateMigrationRunner;
  private readonly getWebhookManifests: GetWebhookManifests;
  private readonly logger = createLogger("webhook-management.run-migrations");

  constructor(
    args: {
      createMigrationRunner?: CreateMigrationRunner;
      getWebhookManifests?: GetWebhookManifests;
    } = {},
  ) {
    this.createMigrationRunner = args.createMigrationRunner ?? defaultCreateMigrationRunner;
    this.getWebhookManifests = args.getWebhookManifests ?? defaultGetWebhookManifests;
  }

  async execute(args: RunWebhookMigrationsArgs): Promise<Result<void, RunWebhookMigrationsError>> {
    const { saleorApiUrl, token, dryRun = false } = args;

    /*
     * Adapt our app's structured logger (whose default record shape is
     * `(message, attributes)`) to the runner's `Logger` contract — both
     * happen to be the same shape but we keep the bind explicit so future
     * divergence is loud.
     */
    const runnerLogger = {
      info: (message: string, meta?: Record<string, unknown>) =>
        this.logger.info(message, meta ?? {}),
      debug: (message: string, meta?: Record<string, unknown>) =>
        this.logger.debug(message, meta ?? {}),
      error: (message: string, meta?: Record<string, unknown>) =>
        this.logger.error(message, meta ?? {}),
      warn: (message: string, meta?: Record<string, unknown>) =>
        this.logger.warn(message, meta ?? {}),
    };

    const runner = this.createMigrationRunner({
      saleorApiUrl,
      token,
      dryRun,
      logger: runnerLogger,
      getManifests: this.getWebhookManifests,
    });

    try {
      await runner.migrate();

      return ok(undefined);
    } catch (cause) {
      this.logger.error("Webhook migration failed", { saleorApiUrl, error: cause });

      return err(
        new RunWebhookMigrationsError("Webhook migration failed", {
          cause: cause instanceof Error ? cause : new Error(String(cause)),
        }),
      );
    }
  }
}
