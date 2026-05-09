/**
 * Root tRPC router for `saleor-app-fief`.
 *
 * Composition map:
 *   - T34 — `connections` + `channelConfig` (this file)
 *   - T36 — `claimsMapping`           (TODO)
 *   - T37 — `webhookLog` + `dlq.list` (this file)
 *   - T38 — `reconciliation`          (this file)
 *   - T51 — `dlq.replay`              (this file)
 *
 * The browser guard mirrors `apps/stripe/src/modules/trpc/trpc-router.ts` —
 * this module transitively imports server-only deps (Mongo client lifetime
 * via `protected-client-procedure` -> APL -> Mongo, plus the use cases which
 * pull in `node:crypto`) and must not be bundled into the iframe.
 * `trpc-client.ts` uses `import type` to stay browser-safe.
 *
 * Why production wiring lives here
 * --------------------------------
 *
 * Each sub-router is a `build*Router(deps)` factory so unit tests can pass
 * stubs (no Mongo, no Fief HTTP). Production composition happens here once,
 * at module load — the repos / use cases are stateless after construction so
 * a single shared instance per Node process is correct.
 */
if (typeof window !== "undefined") {
  throw new Error(
    "trpc-router.ts must not be imported in the browser — use `import type` instead.",
  );
}

/* eslint-disable import/first */
import { ok } from "neverthrow";

import { buildReconciliationRunnerDeps } from "@/app/api/cron/reconcile/deps";
import { createLogger } from "@/lib/logger";
import { MongoChannelConfigurationRepo } from "@/modules/channel-configuration/repositories/mongodb/mongodb-channel-configuration-repo";
import { buildChannelConfigRouter } from "@/modules/channel-configuration/trpc-router";
import { DlqReplayUseCase } from "@/modules/dlq/replay.use-case";
import { MongodbDlqRepo } from "@/modules/dlq/repositories/mongodb/mongodb-dlq-repo";
import { buildDlqRouter } from "@/modules/dlq/trpc-router";
import { FiefAdminApiClient } from "@/modules/fief-client/admin-api-client";
import { type FiefBaseUrl, FiefBaseUrlSchema } from "@/modules/fief-client/admin-api-types";
import { FiefOidcClient } from "@/modules/fief-client/oidc-client";
import { MongodbProviderConnectionRepo } from "@/modules/provider-connections/repositories/mongodb/mongodb-provider-connection-repo";
import { buildConnectionsRouter } from "@/modules/provider-connections/trpc-router";
import { CreateConnectionUseCase } from "@/modules/provider-connections/use-cases/create-connection.use-case";
import { DeleteConnectionUseCase } from "@/modules/provider-connections/use-cases/delete-connection.use-case";
import { RotateConnectionSecretUseCase } from "@/modules/provider-connections/use-cases/rotate-connection-secret.use-case";
import { UpdateConnectionUseCase } from "@/modules/provider-connections/use-cases/update-connection.use-case";
import { MongodbOutboundQueueRepo } from "@/modules/queue/repositories/mongodb/mongodb-queue-repo";
import { type ReconciliationFlagRepo } from "@/modules/reconciliation/reconciliation-flag-repo";
import { ReconciliationRunner } from "@/modules/reconciliation/runner";
import { buildReconciliationRouter } from "@/modules/reconciliation/trpc-router";
import { eventRouter } from "@/modules/sync/fief-to-saleor/event-router";
import { MongodbWebhookLogRepo } from "@/modules/webhook-log/repositories/mongodb/mongodb-webhook-log-repo";
import { buildWebhookLogRouter } from "@/modules/webhook-log/trpc-router";

import { router } from "./trpc-server";

/*
 * Production wiring. Repositories + use cases are stateless after construction
 * so we can hold module-scoped singletons. The Fief admin client construction
 * is per-call (it's keyed by `baseUrl` which is per-connection); we do that
 * inside the use cases. For the rotate / update / delete use cases we still
 * need a single admin-client per process — but the per-tenant base URL is
 * carried on the connection record, so the use cases construct their clients
 * lazily from the decrypted admin token + baseUrl.
 *
 * For the `testConnection` probe, the connections router builds a fresh
 * `FiefOidcClient` and `FiefAdminApiClient` per call — there's no value in
 * caching one per arbitrary baseUrl supplied by the form.
 */
const providerConnectionRepo = new MongodbProviderConnectionRepo();
const channelConfigurationRepo = new MongoChannelConfigurationRepo();

/*
 * The four lifecycle use cases all need a `FiefAdminApiClient`, and the
 * client's `baseUrl` is locked at construction time. But connection-lifecycle
 * calls run against ONE Fief tenant per call — the tenant's base URL is on
 * the connection record (or, for `create`, on the form input), NOT a single
 * deployment-wide constant. So we inject an `adminClientFactory` and let each
 * `execute()` call construct a fresh client from the right baseUrl.
 *
 * Tests pass their own factory (`() => mockFiefAdmin`) at the router boundary.
 */
const adminClientFactory = ({ baseUrl }: { baseUrl: FiefBaseUrl }) =>
  FiefAdminApiClient.create({ baseUrl });

const connectionsRouter = buildConnectionsRouter({
  repo: providerConnectionRepo,
  useCases: {
    createConnection: new CreateConnectionUseCase({
      repo: providerConnectionRepo,
      adminClientFactory,
    }),
    updateConnection: new UpdateConnectionUseCase({
      repo: providerConnectionRepo,
      adminClientFactory,
    }),
    rotateConnectionSecret: new RotateConnectionSecretUseCase({
      repo: providerConnectionRepo,
      adminClientFactory,
    }),
    deleteConnection: new DeleteConnectionUseCase({
      repo: providerConnectionRepo,
      adminClientFactory,
    }),
  },
  oidcClientFactory: ({ baseUrl }) => new FiefOidcClient({ baseUrl }),
  adminClientFactory: ({ baseUrl }) =>
    FiefAdminApiClient.create({ baseUrl: FiefBaseUrlSchema.parse(baseUrl) }),
});

const channelConfigRouter = buildChannelConfigRouter({
  repo: channelConfigurationRepo,
});

/*
 * T51 — DLQ replay sub-router.
 *
 * Wires the production `DlqReplayUseCase`. Every collaborator is a
 * shared singleton (Mongo repos, the module-level `eventRouter` from
 * T22, and the outbound queue repo from T52). The `fiefReceiver` seam
 * adapts `eventRouter.dispatch(payload)` so the use case doesn't have
 * to import receiver internals.
 *
 * T37 also adds `dlq.list` to the same sub-router and a separate
 * `webhookLog` sub-router; both share the Mongo DLQ + webhook-log
 * singletons constructed below.
 */
const dlqRepo = new MongodbDlqRepo();
const webhookLogRepo = new MongodbWebhookLogRepo();

const dlqReplayUseCase = new DlqReplayUseCase({
  dlqRepo,
  webhookLogRepo,
  providerConnectionRepo,
  fiefReceiver: {
    dispatch: (payload) => eventRouter.dispatch(payload),
  },
  outboundQueue: new MongodbOutboundQueueRepo(),
  logger: createLogger("trpc.dlq.replay"),
});

const dlqRouter = buildDlqRouter({ useCase: dlqReplayUseCase, repo: dlqRepo });

/*
 * T37 — webhook health sub-router. Reads the `webhook_log` collection
 * via the existing T11 repo; payloads are fetched lazily by the
 * dashboard via `webhookLog.getPayload`.
 */
const webhookLogRouter = buildWebhookLogRouter({ repo: webhookLogRepo });

/*
 * T38 — reconciliation sub-router.
 *
 * Reuses the cron route's composition seam (`buildReconciliationRunnerDeps`)
 * for the runner + run-history repo so we don't duplicate the drift /
 * repair / kill-switch wiring. The flag repo doesn't have a production
 * Mongo impl yet (T25 shipped the interface + writer plumbing, but the
 * Mongo-backed reader is a follow-up). Until the impl lands, the read
 * surface returns `ok(null)` so `flags.getForInstall` cleanly resolves
 * to `null` and the UI banner stays hidden. The writer side (T25's
 * `permission-role-field.use-case`) continues to function with whatever
 * impl is wired into its handler chain.
 */
const reconciliationDeps = buildReconciliationRunnerDeps();
const reconciliationRunner = new ReconciliationRunner(reconciliationDeps);

const placeholderFlagRepo: ReconciliationFlagRepo = {
  raise() {
    throw new Error("placeholderFlagRepo.raise must not be called from the tRPC layer");
  },
  async get() {
    return ok(null);
  },
};

const reconciliationRouter = buildReconciliationRouter({
  runHistoryRepo: reconciliationDeps.runHistoryRepo,
  flagRepo: placeholderFlagRepo,
  runner: reconciliationRunner,
});

export const trpcRouter = router({
  connections: connectionsRouter,
  channelConfig: channelConfigRouter,
  dlq: dlqRouter,
  reconciliation: reconciliationRouter,
  webhookLog: webhookLogRouter,
});

export type TrpcRouter = typeof trpcRouter;
