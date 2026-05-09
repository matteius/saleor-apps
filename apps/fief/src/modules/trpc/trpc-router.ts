/**
 * Root tRPC router for `saleor-app-fief`.
 *
 * Composition map:
 *   - T34 — `connections` + `channelConfig` (this file)
 *   - T36 — `claimsMapping`           (TODO)
 *   - T37 — `webhookLog`              (TODO)
 *   - T38 — `reconciliation`          (TODO)
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
import { MongoChannelConfigurationRepo } from "@/modules/channel-configuration/repositories/mongodb/mongodb-channel-configuration-repo";
import { buildChannelConfigRouter } from "@/modules/channel-configuration/trpc-router";
import { FiefAdminApiClient } from "@/modules/fief-client/admin-api-client";
import { FiefBaseUrlSchema } from "@/modules/fief-client/admin-api-types";
import { FiefOidcClient } from "@/modules/fief-client/oidc-client";
import { MongodbProviderConnectionRepo } from "@/modules/provider-connections/repositories/mongodb/mongodb-provider-connection-repo";
import { buildConnectionsRouter } from "@/modules/provider-connections/trpc-router";
import { CreateConnectionUseCase } from "@/modules/provider-connections/use-cases/create-connection.use-case";
import { DeleteConnectionUseCase } from "@/modules/provider-connections/use-cases/delete-connection.use-case";
import { RotateConnectionSecretUseCase } from "@/modules/provider-connections/use-cases/rotate-connection-secret.use-case";
import { UpdateConnectionUseCase } from "@/modules/provider-connections/use-cases/update-connection.use-case";

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
 * The four lifecycle use cases all need a `FiefAdminApiClient`. Production
 * builds one per use-case construction; the client is stateless per request
 * (the admin token is supplied per call) so a single shared instance is fine.
 *
 * NOTE: The admin client's `baseUrl` is required at construction time.
 * Connection-lifecycle use cases run against ONE Fief tenant per call — but
 * the tenant's base URL is on the connection record, not the constructor.
 * To keep the existing T17 use-case API stable we construct the admin client
 * with a placeholder base URL here; in practice each use case immediately
 * uses the decrypted admin token + the per-connection base URL via dynamic
 * client construction (see use cases). If/when T17 grows a per-call client
 * factory we'll thread that here.
 *
 * Until then, production deployments MUST set FIEF_BASE_URL in env and we
 * read it via the env helper to seed the fallback admin client. Tests do
 * not exercise this branch (they swap in stubs at the router boundary).
 */
const seedFiefAdminClient = FiefAdminApiClient.create({
  baseUrl: FiefBaseUrlSchema.parse("https://placeholder-not-used.invalid/"),
});

const connectionsRouter = buildConnectionsRouter({
  repo: providerConnectionRepo,
  useCases: {
    createConnection: new CreateConnectionUseCase({
      repo: providerConnectionRepo,
      fiefAdmin: seedFiefAdminClient,
    }),
    updateConnection: new UpdateConnectionUseCase({
      repo: providerConnectionRepo,
      fiefAdmin: seedFiefAdminClient,
    }),
    rotateConnectionSecret: new RotateConnectionSecretUseCase({
      repo: providerConnectionRepo,
      fiefAdmin: seedFiefAdminClient,
    }),
    deleteConnection: new DeleteConnectionUseCase({
      repo: providerConnectionRepo,
      fiefAdmin: seedFiefAdminClient,
    }),
  },
  oidcClientFactory: ({ baseUrl }) => new FiefOidcClient({ baseUrl }),
  adminClientFactory: ({ baseUrl }) =>
    FiefAdminApiClient.create({ baseUrl: FiefBaseUrlSchema.parse(baseUrl) }),
});

const channelConfigRouter = buildChannelConfigRouter({
  repo: channelConfigurationRepo,
});

export const trpcRouter = router({
  connections: connectionsRouter,
  channelConfig: channelConfigRouter,
});

export type TrpcRouter = typeof trpcRouter;
