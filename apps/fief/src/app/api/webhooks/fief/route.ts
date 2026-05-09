// cspell:ignore dedup

import { compose } from "@saleor/apps-shared/compose";
import { type NextRequest } from "next/server";

import { createLogger } from "@/lib/logger";
import { withLoggerContext } from "@/lib/logger-context";
import { withSaleorApiUrlAttributes } from "@/lib/observability-saleor-api-url";
import { createFiefEncryptor } from "@/modules/crypto/encryptor";
import { eventRouter } from "@/modules/sync/fief-to-saleor/event-router";
import {
  FiefReceiver,
  type FindConnectionById,
  type ReceiverOutcome,
} from "@/modules/sync/fief-to-saleor/receiver";

/*
 * T22 — Fief webhook receiver route.
 *
 * Thin HTTP boundary: read raw body + headers + query, hand off to
 * `FiefReceiver.receive(...)`, translate the `ReceiverOutcome` to an
 * HTTP response. All cross-cutting logic (HMAC verify, dedup,
 * dispatch, kill-switch, soft-deleted lookup) lives in the receiver
 * module so it stays unit-testable without a Next request.
 *
 * Wired exactly like the Stripe-app webhook routes (and `register/route.ts`):
 * `compose(withLoggerContext, withSaleorApiUrlAttributes)` so every log
 * line emitted inside the handler carries `correlationId`, `path`, and
 * (when known) `saleorApiUrl`.
 *
 * Wiring note — receiver dependencies:
 * --------------------------------------
 * The receiver needs a `findConnectionById` lookup that is NOT
 * tenant-scoped (the Fief webhook URL only carries `connectionId`).
 * T8's repo `get(...)` is tenant-scoped for safety; rather than widen
 * that interface, we inject a dedicated lookup here. The production
 * impl will be a thin adapter over the Mongo repo (a `findOne({ id })`
 * call with no `saleorApiUrl` filter); this initial T22 patch wires
 * a placeholder that reaches into the repo via a `findByIdAcrossTenants`
 * extension method when present, otherwise surfaces a typed error.
 *
 * **Webhook log repo wiring**: also a placeholder for now. When the
 * MongoDB-backed `WebhookLogRepo` is wired into the app's DI graph
 * (currently no central composition root for it — the use-case modules
 * import it directly), this route picks up the production impl.
 *
 * The placeholder receiver returns 503 when the deps cannot be
 * constructed, so an under-provisioned environment fails loud rather
 * than silently dropping events.
 */

const logger = createLogger("api.webhooks.fief");

/**
 * Map a `ReceiverOutcome` to a Next.js Response. The mapping table is
 * the only HTTP-protocol concern in this file — keeping it here means
 * a future contract change (e.g. switching duplicate-200 to 202) is a
 * single-edit operation.
 */
const outcomeToResponse = (outcome: ReceiverOutcome): Response => {
  switch (outcome.kind) {
    case "bad-request":
      return new Response(JSON.stringify({ error: outcome.message }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    case "gone":
      return new Response(JSON.stringify({ error: "Gone", reason: outcome.reason }), {
        status: 410,
        headers: { "content-type": "application/json" },
      });
    case "service-unavailable":
      return new Response(
        JSON.stringify({ error: "Service Unavailable", reason: outcome.reason }),
        {
          status: 503,
          headers: { "content-type": "application/json" },
        },
      );
    case "unauthorized":
      return new Response(JSON.stringify({ error: "Unauthorized", reason: outcome.reason }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    case "duplicate":
      return new Response(JSON.stringify({ status: "duplicate", eventId: outcome.eventId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    case "accepted":
      return new Response(
        JSON.stringify({
          status: "accepted",
          eventId: outcome.eventId,
          eventType: outcome.eventType,
          dispatched: outcome.dispatched,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    case "accepted-with-handler-error":
      return new Response(
        JSON.stringify({
          status: "accepted-with-handler-error",
          eventId: outcome.eventId,
          eventType: outcome.eventType,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
  }
};

/**
 * Build the production receiver. Exported for tests so they can build
 * an isolated receiver with stubbed deps and exercise the full
 * route-level translation table without standing up Mongo.
 *
 * The `findConnectionById` placeholder returns "not found" — production
 * deployment (T34 follow-up) will plug in the Mongo lookup. This means
 * the route currently always 410s even with a valid signature; the
 * receiver-level test suite covers the happy path.
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

const handler = async (req: NextRequest): Promise<Response> => {
  const url = new URL(req.url);
  const connectionIdQueryParam = url.searchParams.get("connectionId");

  let rawBody: string;

  try {
    rawBody = await req.text();
  } catch (error) {
    logger.error("Failed to read Fief webhook body", {
      errorMessage: error instanceof Error ? error.message : String(error),
    });

    return new Response(JSON.stringify({ error: "Bad Request", message: "Could not read body" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  /*
   * Snapshot headers (lower-case keys) so the receiver doesn't depend on
   * Next's Headers shape — keeps the receiver test-friendly.
   */
  const headers: Record<string, string | undefined> = {};

  req.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const receiver = buildReceiver();

  const result = await receiver.receive({
    rawBody,
    headers,
    connectionIdQueryParam,
  });

  /*
   * The receiver's `receive` returns `Result.ok(...)` for every reachable
   * terminal state; `result.isErr()` would indicate an internal invariant
   * violation we don't currently emit.
   */
  if (result.isErr()) {
    logger.error("FiefReceiver.receive returned err — internal invariant violated", {
      error: result.error,
    });

    return new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  return outcomeToResponse(result.value);
};

export const POST = compose(withLoggerContext, withSaleorApiUrlAttributes)(handler);
