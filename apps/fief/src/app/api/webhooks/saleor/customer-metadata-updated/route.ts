import { compose } from "@saleor/apps-shared/compose";

import { type FiefCustomerMetadataUpdatedEventFragment } from "@/generated/graphql";
import { isSaleorToFiefDisabled } from "@/lib/kill-switches";
import { createLogger } from "@/lib/logger";
import { withLoggerContext } from "@/lib/logger-context";
import { withSaleorApiUrlAttributes } from "@/lib/observability-saleor-api-url";
import { type EnqueueJobInput } from "@/modules/queue/queue";
import { MongodbOutboundQueueRepo } from "@/modules/queue/repositories/mongodb/mongodb-queue-repo";
import { createSaleorApiUrl, type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { FIEF_SYNC_ORIGIN_KEY } from "@/modules/sync/loop-guard";
import { CUSTOMER_METADATA_UPDATED_EVENT_TYPE } from "@/modules/sync/saleor-to-fief/customer-metadata-updated.use-case";
import {
  createWebhookEventId,
  createWebhookLogConnectionId,
} from "@/modules/webhook-log/webhook-log";

import { customerMetadataUpdatedWebhookDefinition } from "./webhook-definition";

/*
 * T28 — `CUSTOMER_METADATA_UPDATED` async webhook route.
 *
 * Mirrors T26's route exactly — same kill-switch + origin-marker + enqueue
 * shape. The reverse-sync gate (the unique part of T28) lives in the use
 * case, not the route, because the route must respond in <3s and we want
 * to keep the queue I/O minimal regardless of whether the operator has
 * enabled reverse-sync.
 *
 * Order of operations:
 *
 *   1. Honor the `FIEF_SALEOR_TO_FIEF_DISABLED` kill switch (T54).
 *   2. Fast-path drop on origin marker `"fief"` (T13). The use case
 *      re-checks defensively, but we avoid the queue write here.
 *   3. Enqueue onto T52's outbound queue. Returns 200 immediately.
 *   4. If the enqueue write fails transiently (Mongo blip), return 5xx so
 *      Saleor retries. (Same contract as T26.)
 *
 * Connection scoping (same caveat as T26): Saleor's `User` payload does NOT
 * carry a channel slug; we extract an optional operator-stamped
 * `_fief_channel` metadata key as a hint; absence means the use case falls
 * back to `defaultConnectionId`.
 *
 * Job event id: derive a stable id from `(saleorApiUrl, saleorUserId,
 * "metadata_updated")` so a Saleor webhook redelivery within the queue's
 * de-dup window collapses to a single job. Note: this also means rapid
 * successive metadata-updated events for the same user collapse into one
 * job — the worker re-reads the latest payload at dispatch, so collapsing
 * is safe (we never lose the *latest* state).
 */

export const runtime = "nodejs";

const logger = createLogger("api.webhooks.saleor.customer-metadata-updated");

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

const handler = customerMetadataUpdatedWebhookDefinition.createHandler(async (_req, ctx) => {
  try {
    if (isSaleorToFiefDisabled()) {
      logger.warn("kill switch active; dropping CUSTOMER_METADATA_UPDATED webhook", {
        saleorApiUrl: ctx.authData?.saleorApiUrl,
      });

      return new Response(JSON.stringify({ error: "Service Unavailable", reason: "kill-switch" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }

    const payload = ctx.payload as FiefCustomerMetadataUpdatedEventFragment | null | undefined;
    const user = payload?.user;

    if (!user) {
      logger.warn("CUSTOMER_METADATA_UPDATED arrived without user payload; dropping", {
        saleorApiUrl: ctx.authData?.saleorApiUrl,
      });

      return new Response(JSON.stringify({ status: "skipped", reason: "no-user" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

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
     * Synthetic event id for queue de-duplication. See module doc-comment
     * for the collapsing semantics — last-write-wins is correct here
     * because the use case re-reads the payload, and only the *latest*
     * metadata state matters for the reverse-sync.
     */
    const eventIdResult = createWebhookEventId(
      `saleor:${saleorApiUrl}:${user.id}:customer_metadata_updated`,
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
      eventType: CUSTOMER_METADATA_UPDATED_EVENT_TYPE,
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
      logger.error("Failed to enqueue CUSTOMER_METADATA_UPDATED job; Saleor will retry", {
        cause: queueResult.error.message,
      });

      return new Response(
        JSON.stringify({ error: "Service Unavailable", reason: "queue-write-failed" }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    }

    logger.info("CUSTOMER_METADATA_UPDATED enqueued", {
      saleorApiUrl,
      saleorUserId: user.id,
      jobId: String(queueResult.value.id),
    });

    return new Response(
      JSON.stringify({ status: "accepted", jobId: String(queueResult.value.id) }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch (error) {
    logger.error("Unhandled error in CUSTOMER_METADATA_UPDATED route", {
      error: error instanceof Error ? error.message : String(error),
    });

    return new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});

export const POST = compose(withLoggerContext, withSaleorApiUrlAttributes)(handler);
