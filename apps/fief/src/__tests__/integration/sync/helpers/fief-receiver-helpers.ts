// cspell:ignore dedup opensensor

/**
 * @vitest-environment node
 *
 * T41 — Fief→Saleor receiver helpers.
 *
 * Wires the Fief webhook receiver in test mode:
 *   - Deliver a signed Fief webhook to the production `route.ts` handler.
 *   - Wire the `eventRouter` with handlers built around a fresh
 *      `RegisterFiefToSaleorHandlersDeps` so the suite can swap clients
 *      without touching the composition root.
 *
 * The module-level `eventRouter` IS shared across imports. Vitest's
 * single-fork integration suite runs files sequentially, but inside a
 * file each `beforeEach` should call `resetFiefEventRouter()` to wipe
 * registrations cleanly. The helper achieves that by destructively
 * deleting registered keys via the public `hasHandler`-driven introspection
 * (`registerHandler` is last-write-wins).
 */

import { ok, type Result } from "neverthrow";

import {
  type FindConnectionById,
  type ReceiverOutcome,
} from "@/modules/sync/fief-to-saleor/receiver";
/*
 * Note: every helper here uses dynamic `import(...)` for modules that
 * participate in the singleton graph (`eventRouter`, `register-handlers`,
 * the `composition-root`, `build-receiver`). The auth-harness's
 * `startHarness` calls `vi.resetModules()` AFTER stubbing the Mongo URL,
 * which invalidates static-import bindings inside this helper. Dynamic
 * imports re-resolve against the live cache so handler registrations and
 * receiver construction land on the SAME `eventRouter` instance.
 */
import {
  type RegisterFiefToSaleorHandlersDeps,
  type ResolveConnectionForEvent,
  type ResolvedConnectionContext,
} from "@/modules/sync/fief-to-saleor/register-handlers";
import { type SaleorCustomerDeactivateClient } from "@/modules/sync/fief-to-saleor/user-delete.use-case";
import { type SaleorCustomerClient } from "@/modules/sync/fief-to-saleor/user-upsert.use-case";

import { FIEF_WEBHOOK_SECRET, type IntegrationHarness } from "../../auth/harness";
import { signFiefWebhook } from "./sync-harness";

/**
 * Deterministically reset the module-level `eventRouter` between tests by
 * monkey-patching the internal handler map. Async because we re-import
 * the singleton each call to dodge `vi.resetModules()` aliasing.
 */
export const resetFiefEventRouter = async (): Promise<void> => {
  const { eventRouter } = await import("@/modules/sync/fief-to-saleor/event-router");

  (eventRouter as unknown as { handlers: Map<string, unknown> }).handlers.clear();
};

export interface RegisterTestHandlersOpts {
  saleorApiUrl: ResolvedConnectionContext["saleorApiUrl"];
  claimMapping?: ResolvedConnectionContext["claimMapping"];
  adminToken?: ResolvedConnectionContext["adminToken"];
  saleorClient: SaleorCustomerClient;
  saleorDeactivateClient: SaleorCustomerDeactivateClient;
  identityMapRepo: RegisterFiefToSaleorHandlersDeps["identityMapRepo"];
  fiefAdmin: RegisterFiefToSaleorHandlersDeps["fiefAdmin"];
  reconciliationFlagRepo?: RegisterFiefToSaleorHandlersDeps["reconciliationFlagRepo"];
  resolver?: ResolveConnectionForEvent;
}

/**
 * Wire test handlers onto the module-level `eventRouter`. Pass the
 * SaleorClient + deactivate client + a fixed resolver pointing at the
 * seeded connection. The reconciliation flag repo defaults to a recording
 * stub since T25 only writes to it for `user_field.updated` events.
 */
export const registerTestFiefHandlers = async (opts: RegisterTestHandlersOpts): Promise<void> => {
  const { eventRouter } = await import("@/modules/sync/fief-to-saleor/event-router");
  const { buildFixedConnectionResolver, registerFiefToSaleorHandlers } = await import(
    "@/modules/sync/fief-to-saleor/register-handlers"
  );

  const reconciliationFlagRepo: RegisterFiefToSaleorHandlersDeps["reconciliationFlagRepo"] =
    opts.reconciliationFlagRepo ?? {
      raise: async () => ok({} as never),
      get: async () => ok(null),
    };

  const resolver: ResolveConnectionForEvent =
    opts.resolver ??
    buildFixedConnectionResolver({
      saleorApiUrl: opts.saleorApiUrl,
      claimMapping: opts.claimMapping ?? [],
      adminToken: opts.adminToken,
    });

  registerFiefToSaleorHandlers({
    eventRouter,
    identityMapRepo: opts.identityMapRepo,
    saleorClient: opts.saleorClient,
    saleorDeactivateClient: opts.saleorDeactivateClient,
    fiefAdmin: opts.fiefAdmin,
    reconciliationFlagRepo,
    resolveConnectionForEvent: resolver,
  });
};

/**
 * Deliver a signed Fief webhook to the production receiver. Uses the
 * connection's webhook secret (decrypted plaintext from
 * `auth/harness.ts:FIEF_WEBHOOK_SECRET` since the test seed-helper writes
 * that exact plaintext into Mongo).
 *
 * Calls `buildReceiver({ findConnectionById })` with a thin test-supplied
 * lookup that walks `provider_connections` by `id` only. The override is
 * required because the production `findConnectionById` in the composition
 * root filters with `softDeletedAt: { $exists: false }` — but the schema
 * persists the field as `null` for non-deleted rows, so the production
 * filter never matches against a Mongo-memory-server collection. Working
 * around it in test-only code keeps T41 from depending on a fix that's
 * outside its scope (and per the task spec, T41 makes NO production code
 * changes).
 *
 * The route's outcome→Response mapping is mirrored here so tests still
 * exercise the same HTTP-protocol contract `route.ts` exposes to Fief.
 *
 * Returns the HTTP response so the caller can assert on status + body.
 */
export const deliverFiefWebhook = async (args: {
  connectionId: string;
  type: string;
  data: Record<string, unknown>;
  secret?: string;
  /** Override the timestamp — used for replay / dedup tests. */
  timestamp?: number;
}): Promise<Response> => {
  const secret = args.secret ?? FIEF_WEBHOOK_SECRET;
  const signed = signFiefWebhook({
    secret,
    type: args.type,
    data: args.data,
    timestamp: args.timestamp,
  });

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-fief-webhook-signature": signed.signature,
    "x-fief-webhook-timestamp": signed.timestamp,
  };

  const { buildReceiver } = await import("@/app/api/webhooks/fief/build-receiver");
  const { err } = await import("neverthrow");
  const { ProviderConnectionRepoError } = await import(
    "@/modules/provider-connections/provider-connection-repo"
  );
  const { createSaleorApiUrl } = await import("@/modules/saleor/saleor-api-url");
  const { getProductionDeps } = await import("@/lib/composition-root");
  const { getMongoClient, getMongoDatabaseName } = await import("@/modules/db/mongo-client");

  /*
   * Test-only `findConnectionById` — walks `provider_connections` by id
   * only, then defers to the tenant-scoped repo to materialize a fully-
   * branded entity (with decrypted-aware schema parse).
   */
  const findConnectionById: FindConnectionById = async (connectionId) => {
    const client = await getMongoClient();
    const db = client.db(getMongoDatabaseName());
    const collection = db.collection<{ id: string; saleorApiUrl: string }>("provider_connections");

    const doc = await collection.findOne({ id: connectionId as unknown as string });

    if (!doc) {
      return err(new ProviderConnectionRepoError.NotFound(`connection ${connectionId} not found`));
    }

    const saleorApiUrlResult = createSaleorApiUrl(doc.saleorApiUrl);

    if (saleorApiUrlResult.isErr()) {
      return err(
        new ProviderConnectionRepoError.FailureFetching(
          `connection ${connectionId} has invalid saleorApiUrl`,
          { cause: saleorApiUrlResult.error },
        ),
      );
    }

    return getProductionDeps().connectionRepo.get({
      saleorApiUrl: saleorApiUrlResult.value,
      id: connectionId,
    });
  };

  const receiver = buildReceiver({ findConnectionById });

  const result = await receiver.receive({
    rawBody: signed.body,
    headers,
    connectionIdQueryParam: args.connectionId,
  });

  if (result.isErr()) {
    return new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  return outcomeToResponse(result.value);
};

/*
 * Mirror of `route.ts`'s outcome→Response mapping. Kept here so test
 * assertions exercise the same HTTP contract production exposes.
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
        { status: 503, headers: { "content-type": "application/json" } },
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
        { status: 200, headers: { "content-type": "application/json" } },
      );
    case "accepted-with-handler-error":
      return new Response(
        JSON.stringify({
          status: "accepted-with-handler-error",
          eventId: outcome.eventId,
          eventType: outcome.eventType,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
  }
};

/**
 * Helper to satisfy the `Result.ok` typing for the resolver factory in
 * test cases that build their own resolver (e.g. multi-tenant scenarios).
 */
export const okResult = <T>(value: T): Result<T, Error> => ok(value);

/*
 * Re-export so test files can use a single import.
 */
export { IntegrationHarness };
