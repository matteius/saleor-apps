/*
 * Public surface of the `webhook-management` module.
 *
 * T49: only the migration-runner wrapper is exposed today. T16 (post-register
 * hook) and T34 (operator-triggered tRPC procedure) will both consume
 * `RunWebhookMigrationsUseCase`. Keep the surface narrow: domain modules
 * outside this folder should not need anything else from `@saleor/webhook-utils`.
 */

export type {
  CreateMigrationRunner,
  CreateMigrationRunnerArgs,
  GetWebhookManifests,
  RunWebhookMigrationsArgs,
  WebhookMigrationRunnerLike,
} from "./run-migrations";
export {
  defaultCreateMigrationRunner,
  defaultGetWebhookManifests,
  RunWebhookMigrationsError,
  RunWebhookMigrationsUseCase,
} from "./run-migrations";
