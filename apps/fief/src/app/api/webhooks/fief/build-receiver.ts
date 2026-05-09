import { createLogger } from "@/lib/logger";
import { createFiefEncryptor } from "@/modules/crypto/encryptor";
import { eventRouter } from "@/modules/sync/fief-to-saleor/event-router";
import { FiefReceiver, type FindConnectionById } from "@/modules/sync/fief-to-saleor/receiver";

/*
 * T22 — Fief receiver factory.
 *
 * Extracted out of `route.ts` so tests can import it without violating
 * Next.js' Route export contract (App Router rejects any non-standard
 * exports from `route.ts` and would fail `next build` with
 * "buildReceiver is not a valid Route export field.")
 *
 * The `findConnectionById` placeholder returns "not found" — production
 * deployment (T34 follow-up) will plug in the Mongo lookup. This means
 * the route currently always 410s even with a valid signature; the
 * receiver-level test suite covers the happy path.
 */

const logger = createLogger("api.webhooks.fief.build-receiver");

/**
 * Build the production receiver. Exported for tests so they can build
 * an isolated receiver with stubbed deps and exercise the full
 * route-level translation table without standing up Mongo.
 */
export const buildReceiver = (overrides?: { findConnectionById?: FindConnectionById }) => {
  const findConnectionById: FindConnectionById =
    overrides?.findConnectionById ??
    (async () => {
      logger.error(
        "FiefReceiver.findConnectionById not wired — every webhook delivery will 410. Wire the Mongo lookup before enabling Fief subscribers in production.",
      );

      // Lazy-import to avoid pulling repo errors when overridden.
      const { ProviderConnectionRepoError } = await import(
        "@/modules/provider-connections/provider-connection-repo"
      );

      return (await import("neverthrow")).err(
        new ProviderConnectionRepoError.NotFound(
          "FiefReceiver.findConnectionById not wired in route handler",
        ),
      ) as never;
    });

  /*
   * Placeholder webhook log repo + provider-connection repo so the
   * receiver constructor doesn't blow up at module load. Production
   * wiring lands when T34 (admin-side wiring) connects the MongoDB
   * implementations into a central composition root.
   */
  const stubWebhookLogRepo = {
    record: async () => (await import("neverthrow")).ok({} as never),
    dedupCheck: async () => (await import("neverthrow")).ok(false),
    recordAttempt: async () => {
      throw new Error("recordAttempt not used by T22 receiver");
    },
    moveToDlq: async () => {
      throw new Error("moveToDlq not used by T22 receiver");
    },
    list: async () => (await import("neverthrow")).ok([]),
    getById: async () => (await import("neverthrow")).ok(null),
  };

  const stubProviderConnectionRepo = {
    create: async () => {
      throw new Error("not used by T22 receiver");
    },
    get: async () => {
      throw new Error("not used by T22 receiver");
    },
    list: async () => {
      throw new Error("not used by T22 receiver");
    },
    update: async () => {
      throw new Error("not used by T22 receiver");
    },
    softDelete: async () => {
      throw new Error("not used by T22 receiver");
    },
    restore: async () => {
      throw new Error("not used by T22 receiver");
    },
    getDecryptedSecrets: async () => {
      throw new Error("not used by T22 receiver");
    },
  };

  return new FiefReceiver({
    providerConnectionRepo: stubProviderConnectionRepo as never,
    findConnectionById,
    webhookLogRepo: stubWebhookLogRepo as never,
    encryptor: createFiefEncryptor(),
    eventRouter,
  });
};
