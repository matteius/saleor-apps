import { compose } from "@saleor/apps-shared/compose";

import { type FiefCustomerCreatedEventFragment } from "@/generated/graphql";
import { isSaleorToFiefDisabled } from "@/lib/kill-switches";
import { createLogger } from "@/lib/logger";
import { withLoggerContext } from "@/lib/logger-context";
import { withSaleorApiUrlAttributes } from "@/lib/observability-saleor-api-url";
import { type EnqueueJobInput } from "@/modules/queue/queue";
import { MongodbOutboundQueueRepo } from "@/modules/queue/repositories/mongodb/mongodb-queue-repo";
import { createSaleorApiUrl, type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { FIEF_SYNC_ORIGIN_KEY } from "@/modules/sync/loop-guard";
import { CUSTOMER_CREATED_EVENT_TYPE } from "@/modules/sync/saleor-to-fief/customer-created.use-case";
import {
  createWebhookEventId,
  createWebhookLogConnectionId,
} from "@/modules/webhook-log/webhook-log";

import { customerCreatedWebhookDefinition } from "./webhook-definition";

/*
 * T26 — `CUSTOMER_CREATED` async webhook route.
 *
 * The SDK auto-runs the signature check (we wired
 * `verifyWebhookSignature` into the webhook-definition); this handler only
 * sees a verified `ctx.payload`. Order of operations:
 *
 *   1. Honor the `FIEF_SALEOR_TO_FIEF_DISABLED` kill switch (T54). Active
 *      → 503 (Saleor will retry, which is what we want when the operator
 *      flips the switch transiently during an incident).
 *
 *   2. Fast-path drop on origin marker `"fief"` (T13). The customer was
 *      just synced from Fief — propagating it back would loop. The use
 *      case re-checks defensively, but we avoid even the queue write here.
 *
 *   3. Enqueue onto T52's outbound queue. Returns 200 immediately so
 *      Saleor's 3s timeout is never tested. The queue worker dispatches
 *      to `CustomerCreatedUseCase` asynchronously with retry + DLQ.
 *
 *   4. If the enqueue write fails transiently (Mongo blip), return 5xx so
 *      Saleor retries. This is the only failure mode that should NOT be
 *      swallowed — losing an enqueue with a 200 would silently drop the
 *      sync.
 *
 * Connection scoping: per the plan ("using customer's channel"), Saleor's
 * `User` payload does NOT carry a channel slug. We extract an optional
 * operator-stamped `_fief_channel` metadata key as a best-effort hint;
 * absence means the use case falls back to `defaultConnectionId`.
 *
 * Job event id: derive a stable id from `(saleorApiUrl, saleorUserId,
 * "created")` so a Saleor webhook redelivery within the queue's de-dup
 * window collapses to a single job. (Saleor doesn't include a webhook event
 * id in the subscription payload, so we synthesize one from the customer
 * stable id — the queue's unique-on-eventId index does the rest.)
 *
 * `connectionId` on the queue row is the *channel-config-resolved*
 * connection. Since channel resolution depends on slug-or-default and we
 * don't load Mongo from the route, we pass a sentinel "pending" id: the
 * worker resolves the connection at dispatch time. (Wire shape: we use
 * the Saleor api-url itself as the connection id sentinel — there is one
 * "pending" job per tenant, and the worker is the only consumer that
 * resolves to a concrete connection.)
 */

export const runtime = "nodejs";

const logger = createLogger("api.webhooks.saleor.customer-created");

/**
 * Build the queue repo lazily so unit tests can mock the constructor
 * without booting Mongo at module load. Production wiring instantiates the
 * Mongo-backed repo on first invocation; the singleton lives at module
 * scope across requests.
 */
let cachedQueueRepo: MongodbOutboundQueueRepo | undefined;

const getQueueRepo = (): MongodbOutboundQueueRepo => {
  if (cachedQueueRepo) return cachedQueueRepo;
  cachedQueueRepo = new MongodbOutboundQueueRepo();

  return cachedQueueRepo;
};

const FIEF_CHANNEL_HINT_KEY = "_fief_channel" as const;

const extractChannelHint = (
  metadata: ReadonlyArray<{ key: string; value: string }>,
): string | null => {
  const entry = metadata.find((m) => m.key === FIEF_CHANNEL_HINT_KEY);

  return entry?.value ?? null;
};

const findOriginMarker = (
  metadata: ReadonlyArray<{ key: string; value: string }>,
): string | undefined => {
  return metadata.find((m) => m.key === FIEF_SYNC_ORIGIN_KEY)?.value;
};

const handler = customerCreatedWebhookDefinition.createHandler(async (_req, ctx) => {
  try {
    /*
     * Step 1 — kill switch.
     */
    if (isSaleorToFiefDisabled()) {
      logger.warn("kill switch active; dropping CUSTOMER_CREATED webhook", {
        saleorApiUrl: ctx.authData?.saleorApiUrl,
      });

      return new Response(JSON.stringify({ error: "Service Unavailable", reason: "kill-switch" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }

    const payload = ctx.payload as FiefCustomerCreatedEventFragment | null | undefined;
    const user = payload?.user;

    if (!user) {
      /*
       * Saleor delivered a CUSTOMER_CREATED event with no user attached —
       * shouldn't happen with a healthy subscription document but the
       * type union allows it. Drop with 200 so Saleor doesn't retry.
       */
      logger.warn("CUSTOMER_CREATED arrived without user payload; dropping", {
        saleorApiUrl: ctx.authData?.saleorApiUrl,
      });

      return new Response(JSON.stringify({ status: "skipped", reason: "no-user" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    /*
     * Step 2 — origin-marker echo defense. The use case re-checks; we
     * filter here too so loop echoes don't cost a Mongo write.
     */
    const origin = findOriginMarker(user.metadata);

    if (origin === "fief") {
      logger.debug("origin=fief; skipping enqueue (loop-guard)", {
        saleorApiUrl: ctx.authData?.saleorApiUrl,
        saleorUserId: user.id,
      });

      return new Response(JSON.stringify({ status: "skipped", reason: "origin-fief" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    /*
     * Step 3 — enqueue. The job carries the full payload (the use case
     * does not re-fetch from Saleor), the optional channel hint, and the
     * tenant's saleor-api-url. The connectionId field on the queue row
     * is filled with the saleor-api-url as a "pending resolution"
     * sentinel (the worker resolves to a concrete ProviderConnectionId
     * via T9 channel config).
     */
    const saleorApiUrlResult = createSaleorApiUrl(ctx.authData.saleorApiUrl);

    if (saleorApiUrlResult.isErr()) {
      logger.error("Saleor api-url failed validation; dropping", {
        cause: saleorApiUrlResult.error.message,
      });

      return new Response(
        JSON.stringify({ error: "Bad Request", reason: "invalid-saleor-api-url" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    const saleorApiUrl: SaleorApiUrl = saleorApiUrlResult.value;
    const channelSlug = extractChannelHint(user.metadata);

    /*
     * Synthetic event id for queue de-duplication. Saleor's subscription
     * payload does not include a webhook event id; using the customer's
     * stable id + event-name suffix means a redelivered webhook for the
     * same created customer collapses to one job.
     */
    const eventIdResult = createWebhookEventId(
      `saleor:${saleorApiUrl}:${user.id}:customer_created`,
    );
    const connectionIdResult = createWebhookLogConnectionId(saleorApiUrl as unknown as string);

    if (eventIdResult.isErr() || connectionIdResult.isErr()) {
      const cause = eventIdResult.isErr()
        ? eventIdResult.error
        : connectionIdResult._unsafeUnwrapErr();

      logger.error("Failed to construct queue identifiers", {
        cause: cause.message,
      });

      return new Response(JSON.stringify({ error: "Internal Server Error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }

    const enqueueInput: EnqueueJobInput = {
      saleorApiUrl,
      connectionId: connectionIdResult.value,
      eventType: CUSTOMER_CREATED_EVENT_TYPE,
      eventId: eventIdResult.value,
      payload: {
        saleorApiUrl,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          isActive: user.isActive,
          isConfirmed: user.isConfirmed,
          languageCode: user.languageCode,
          metadata: user.metadata,
          privateMetadata: user.privateMetadata,
        },
        channelSlug,
      },
    };

    const queueResult = await getQueueRepo().enqueue(enqueueInput);

    if (queueResult.isErr()) {
      logger.error("Failed to enqueue CUSTOMER_CREATED job; Saleor will retry", {
        cause: queueResult.error.message,
      });

      return new Response(
        JSON.stringify({ error: "Service Unavailable", reason: "queue-write-failed" }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    }

    logger.info("CUSTOMER_CREATED enqueued", {
      saleorApiUrl,
      saleorUserId: user.id,
      jobId: String(queueResult.value.id),
    });

    return new Response(
      JSON.stringify({ status: "accepted", jobId: String(queueResult.value.id) }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch (error) {
    logger.error("Unhandled error in CUSTOMER_CREATED route", {
      error: error instanceof Error ? error.message : String(error),
    });

    return new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});

export const POST = compose(withLoggerContext, withSaleorApiUrlAttributes)(handler);
