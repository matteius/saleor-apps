/**
 * @vitest-environment node
 *
 * T40 — shared integration-test harness.
 *
 * Boots:
 *   1. `mongodb-memory-server` for the Mongo dependency (T3 singleton).
 *   2. `msw` for the Fief OIDC + admin endpoints (T6's `FiefOidcClient`
 *      uses Node's `globalThis.fetch`, which msw intercepts cleanly).
 *   3. Mongo migrations for every collection touched by the auth plane
 *      (T8 provider_connections, T9 channel_configuration,
 *      T10 identity_map, T11 webhook_log + dlq).
 *   4. A real `RotatingFiefEncryptor` so the `provider_connections` round
 *      trip exercises the encryption seam (T4).
 *
 * Exposes:
 *   - `startHarness()`   — call from `beforeAll`. Returns the harness handle.
 *   - `stopHarness()`    — call from `afterAll`. Tears down msw + Mongo.
 *   - `seedConnection()` — write a `ProviderConnection` + matching
 *                           `ChannelConfiguration` so the auth-plane resolver
 *                           hits real data.
 *   - `signRequest()` / `buildSignedRequest()` — produce HMAC-signed
 *                           plugin-auth headers matching T58's wire spec.
 *   - `installFiefOidcMock()` — register msw handlers for the per-test
 *                           tenant base URL.
 *
 * Why msw and not an in-process Express stub: T6 calls `globalThis.fetch`
 * directly. msw's request interceptor hooks the global fetch so the
 * production code path stays unchanged.
 */

import * as crypto from "node:crypto";

import { exportJWK, generateKeyPair, type KeyLike, SignJWT } from "jose";
import { type Db, MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { http, HttpResponse } from "msw";
import { setupServer, type SetupServerApi } from "msw/node";
import { vi } from "vitest";

import {
  type ChannelConfiguration,
  channelConfigurationSchema,
  createChannelSlug,
  createConnectionId,
} from "@/modules/channel-configuration/channel-configuration";
import {
  createAllowedOrigin,
  createFiefBaseUrl,
  createFiefClientId,
  createFiefTenantId,
  createProviderConnectionId,
  createProviderConnectionName,
  type ProviderConnection,
  type ProviderConnectionCreateInput,
} from "@/modules/provider-connections/provider-connection";
import { createSaleorApiUrl, type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

/*
 * -------- Constants ---------------------------------------------------------
 */

export const PLUGIN_SECRET = "test_plugin_hmac_secret_integration";
export const SALEOR_API_URL: SaleorApiUrl = createSaleorApiUrl(
  "https://shop-1.saleor.cloud/graphql/",
)._unsafeUnwrap();
export const CHANNEL_SLUG = createChannelSlug("default-channel");
export const CONNECTION_ID = createProviderConnectionId("11111111-1111-4111-8111-111111111111");
export const FIEF_BASE_URL = "https://tenant.test-fief.invalid";
export const FIEF_CLIENT_ID = "22222222-2222-4222-8222-222222222222";
export const FIEF_TENANT_ID = "33333333-3333-4333-8333-333333333333";
export const ALLOWED_ORIGIN = "https://shop-1.example.com";
export const REDIRECT_URI = "https://shop-1.example.com/auth/callback";
export const SIGNING_KEY = "branding-signing-key-integration";
export const FIEF_USER_ID = "44444444-4444-4444-8444-444444444444";

/*
 * Default Fief secrets used by the seeded connection. Plaintext — the repo
 * encrypts before write via the env-driven `RotatingFiefEncryptor`.
 */
export const FIEF_CLIENT_SECRET = "fief-client-secret-test";
export const FIEF_ADMIN_TOKEN = "fief-admin-token-test";
export const FIEF_WEBHOOK_SECRET = "fief-webhook-secret-test";

/*
 * -------- HMAC sign helpers -------------------------------------------------
 */

const sha256Hex = (bytes: Uint8Array): string =>
  crypto.createHash("sha256").update(bytes).digest("hex");

const hmacHex = (secret: string, message: string): string =>
  crypto
    .createHmac("sha256", Buffer.from(secret, "utf-8"))
    .update(Buffer.from(message, "utf-8"))
    .digest("hex");

export interface SignedRequestParts {
  method: string;
  pathname: string;
  body: string;
  timestamp: number;
  signature: string;
}

export const signRequest = (args: {
  pathname: string;
  body: string;
  secret?: string;
  timestamp?: number;
  method?: string;
}): SignedRequestParts => {
  const method = args.method ?? "POST";
  const timestamp = args.timestamp ?? Math.floor(Date.now() / 1000);
  const bodyHex = sha256Hex(new TextEncoder().encode(args.body));
  const message = `${method}\n${args.pathname}\n${timestamp}\n${bodyHex}`;
  const signature = hmacHex(args.secret ?? PLUGIN_SECRET, message);

  return { method, pathname: args.pathname, body: args.body, timestamp, signature };
};

export interface BuildSignedRequestArgs {
  pathname: string;
  body: unknown;
  secret?: string;
  timestamp?: number;
  saleorApiUrl?: string;
  channelSlug?: string;
  connectionId?: string;
}

export const buildSignedRequest = (args: BuildSignedRequestArgs): Request => {
  const bodyStr = JSON.stringify(args.body);
  const signed = signRequest({
    pathname: args.pathname,
    body: bodyStr,
    secret: args.secret,
    timestamp: args.timestamp,
  });

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "X-Fief-Plugin-Timestamp": String(signed.timestamp),
    "X-Fief-Plugin-Signature": signed.signature,
    "X-Fief-Plugin-Saleor-Url": args.saleorApiUrl ?? (SALEOR_API_URL as unknown as string),
  };

  if (args.channelSlug !== undefined) {
    headers["X-Fief-Plugin-Channel"] = args.channelSlug;
  } else {
    headers["X-Fief-Plugin-Channel"] = CHANNEL_SLUG as unknown as string;
  }

  if (args.connectionId !== undefined) {
    headers["X-Fief-Plugin-Connection"] = args.connectionId;
  }

  const reqUrl = `https://app.test${args.pathname}`;
  const req = new Request(reqUrl, {
    method: "POST",
    body: bodyStr,
    headers: new Headers(headers),
  });

  /*
   * The composed `withLoggerContext` middleware reads `req.nextUrl.pathname`
   * (Next.js's `NextRequest` exposes this), which the standard `Request`
   * constructor does NOT attach. Polyfill it so the integration tests
   * exercise the same compose chain as production without forking the
   * route handler under test.
   */
  Object.defineProperty(req, "nextUrl", {
    value: new URL(reqUrl),
    writable: false,
  });

  return req;
};

/*
 * -------- Fief OIDC mock (msw) ---------------------------------------------
 */

export interface FiefMockState {
  codeExchangeCount: number;
  refreshCount: number;
  revokeCount: number;
  discoveryCount: number;
  jwksCount: number;
  rejectNextRefresh: boolean;
  rejectNextExchange: boolean;
  nextRefreshClaims?: Record<string, unknown>;
}

export interface FiefMockHandle {
  state: FiefMockState;
  issueIdToken(args?: { subject?: string; extraClaims?: Record<string, unknown> }): Promise<string>;
  reset(): void;
}

interface KeyMaterial {
  privateKey: KeyLike;
  publicJwk: Record<string, unknown>;
  kid: string;
}

let cachedKey: KeyMaterial | undefined;

const ensureKeyMaterial = async (): Promise<KeyMaterial> => {
  if (cachedKey) {
    return cachedKey;
  }

  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);

  cachedKey = {
    privateKey: privateKey as KeyLike,
    publicJwk: { ...publicJwk, kid: "test-key-1", alg: "RS256", use: "sig" },
    kid: "test-key-1",
  };

  return cachedKey;
};

export const installFiefOidcMock = (server: SetupServerApi): FiefMockHandle => {
  const state: FiefMockState = {
    codeExchangeCount: 0,
    refreshCount: 0,
    revokeCount: 0,
    discoveryCount: 0,
    jwksCount: 0,
    rejectNextRefresh: false,
    rejectNextExchange: false,
  };

  const baseUrl = FIEF_BASE_URL;

  const handle: FiefMockHandle = {
    state,
    issueIdToken: async ({ subject = FIEF_USER_ID, extraClaims = {} } = {}) => {
      const key = await ensureKeyMaterial();

      return new SignJWT({
        email: "alice@example.com",
        first_name: "Alice",
        last_name: "Example",
        is_active: true,
        ...extraClaims,
      })
        .setProtectedHeader({ alg: "RS256", kid: key.kid })
        .setIssuer(baseUrl)
        .setAudience(FIEF_CLIENT_ID)
        .setSubject(subject)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(key.privateKey);
    },
    reset: () => {
      state.codeExchangeCount = 0;
      state.refreshCount = 0;
      state.revokeCount = 0;
      state.discoveryCount = 0;
      state.jwksCount = 0;
      state.rejectNextRefresh = false;
      state.rejectNextExchange = false;
      state.nextRefreshClaims = undefined;
    },
  };

  server.use(
    http.get(`${baseUrl}/.well-known/openid-configuration`, () => {
      state.discoveryCount += 1;

      return HttpResponse.json({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/api/token`,
        userinfo_endpoint: `${baseUrl}/api/userinfo`,
        jwks_uri: `${baseUrl}/.well-known/jwks.json`,
        revocation_endpoint: `${baseUrl}/api/token/revoke`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }),

    http.get(`${baseUrl}/.well-known/jwks.json`, async () => {
      state.jwksCount += 1;
      const key = await ensureKeyMaterial();

      return HttpResponse.json({ keys: [key.publicJwk] });
    }),

    http.post(`${baseUrl}/api/token`, async ({ request }) => {
      const formData = await request.formData();
      const grantType = formData.get("grant_type")?.toString();

      if (grantType === "authorization_code") {
        state.codeExchangeCount += 1;

        if (state.rejectNextExchange) {
          state.rejectNextExchange = false;

          return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
        }

        const idToken = await handle.issueIdToken();

        return HttpResponse.json({
          access_token: "fief-access-token-1",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "fief-refresh-token-1",
          id_token: idToken,
          scope: "openid email profile",
        });
      }

      if (grantType === "refresh_token") {
        state.refreshCount += 1;

        if (state.rejectNextRefresh) {
          state.rejectNextRefresh = false;

          return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
        }

        const idToken = await handle.issueIdToken({ extraClaims: state.nextRefreshClaims });

        return HttpResponse.json({
          access_token: `fief-access-token-${state.refreshCount + 1}`,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: `fief-refresh-token-${state.refreshCount + 1}`,
          id_token: idToken,
          scope: "openid email profile",
        });
      }

      return HttpResponse.json({ error: "unsupported_grant_type" }, { status: 400 });
    }),

    http.post(`${baseUrl}/api/token/revoke`, () => {
      state.revokeCount += 1;

      return new HttpResponse(null, { status: 200 });
    }),
  );

  return handle;
};

/*
 * -------- Mongo + composition-root harness ---------------------------------
 */

export interface IntegrationHarness {
  mongoServer: MongoMemoryServer;
  mongoClient: MongoClient;
  db: Db;
  server: SetupServerApi;
  fiefMock: FiefMockHandle;
  /**
   * Number of distinct `MongoClient.connect()` calls observed during the
   * suite — used to assert the T3 singleton invariant.
   */
  getConnectCallCount(): number;
}

let harness: IntegrationHarness | undefined;

export const startHarness = async (): Promise<IntegrationHarness> => {
  if (harness) {
    return harness;
  }

  const mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();

  vi.stubEnv("MONGODB_URL", uri);

  vi.resetModules();

  const { resetProductionDepsForTests } = await import("@/lib/composition-root");

  resetProductionDepsForTests();

  /*
   * Patch the Mongo singleton so we can observe how many times
   * `MongoClient.connect()` is called across the run.
   */
  let connectCallCount = 0;
  const mongoClientModule = await import("@/modules/db/mongo-client");
  const realConnect = MongoClient.prototype.connect;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (MongoClient.prototype as any).connect = function patchedConnect(this: MongoClient) {
    connectCallCount += 1;

    return realConnect.call(this);
  };

  const mongoClient = await mongoClientModule.getMongoClient();
  const db = mongoClient.db("fief_app_integration_test");

  /*
   * Register + run all auth-plane migrations.
   */
  const { resetMigrationRegistryForTests, runMigrations, registerMigration } = await import(
    "@/modules/db/migration-runner"
  );

  resetMigrationRegistryForTests();

  await import("@/modules/provider-connections/migrations");
  await import("@/modules/channel-configuration/migrations");
  const { identityMapIndexMigration } = await import("@/modules/identity-map/migrations");

  registerMigration(identityMapIndexMigration);

  const { registerWebhookLogAndDlqMigrations } = await import("@/modules/webhook-log/migrations");

  registerWebhookLogAndDlqMigrations();

  await runMigrations();

  const server = setupServer();

  server.listen({ onUnhandledRequest: "warn" });

  const fiefMock = installFiefOidcMock(server);

  harness = {
    mongoServer,
    mongoClient,
    db,
    server,
    fiefMock,
    getConnectCallCount: () => connectCallCount,
  };

  return harness;
};

export const stopHarness = async (): Promise<void> => {
  if (!harness) {
    return;
  }

  harness.server.close();

  const { closeMongoClient } = await import("@/modules/db/mongo-client");

  await closeMongoClient();

  await harness.mongoServer.stop();
  vi.unstubAllEnvs();

  harness = undefined;
};

/*
 * -------- Seed helpers ------------------------------------------------------
 */

export interface SeedConnectionOverrides {
  fiefBaseUrl?: string;
  fiefClientId?: string;
  channelSlug?: string;
  signingKey?: string;
  allowedOrigins?: string[];
  claimMapping?: ProviderConnectionCreateInput["claimMapping"];
}

export const seedConnection = async (
  overrides: SeedConnectionOverrides = {},
): Promise<ProviderConnection> => {
  const { MongodbProviderConnectionRepo } = await import(
    "@/modules/provider-connections/repositories/mongodb/mongodb-provider-connection-repo"
  );
  const { MongoChannelConfigurationRepo } = await import(
    "@/modules/channel-configuration/repositories/mongodb/mongodb-channel-configuration-repo"
  );

  const connectionRepo = new MongodbProviderConnectionRepo();
  const configRepo = new MongoChannelConfigurationRepo();

  const channelSlugRaw = overrides.channelSlug ?? (CHANNEL_SLUG as unknown as string);
  const allowedOrigins = (overrides.allowedOrigins ?? [ALLOWED_ORIGIN]).map(createAllowedOrigin);

  const createInput: ProviderConnectionCreateInput = {
    saleorApiUrl: SALEOR_API_URL,
    name: createProviderConnectionName("integration-test-conn"),
    fief: {
      baseUrl: createFiefBaseUrl(overrides.fiefBaseUrl ?? FIEF_BASE_URL),
      tenantId: createFiefTenantId(FIEF_TENANT_ID),
      clientId: createFiefClientId(overrides.fiefClientId ?? FIEF_CLIENT_ID),
      webhookId: null,
      clientSecret: FIEF_CLIENT_SECRET,
      pendingClientSecret: null,
      adminToken: FIEF_ADMIN_TOKEN,
      webhookSecret: FIEF_WEBHOOK_SECRET,
      pendingWebhookSecret: null,
    },
    branding: {
      signingKey: overrides.signingKey ?? SIGNING_KEY,
      allowedOrigins,
    },
    claimMapping: overrides.claimMapping ?? [],
  };

  const createResult = await connectionRepo.create(SALEOR_API_URL, createInput);

  if (createResult.isErr()) {
    throw createResult.error;
  }

  const connection = createResult.value;

  /*
   * Override the connection id to the deterministic test value so test
   * code can reference `CONNECTION_ID` directly.
   */
  if (connection.id !== CONNECTION_ID) {
    const collection = harness!.db.collection("provider_connections");

    await collection.updateOne(
      { id: connection.id as unknown as string },
      { $set: { id: CONNECTION_ID as unknown as string } },
    );
  }

  const configInput: ChannelConfiguration = channelConfigurationSchema.parse({
    saleorApiUrl: SALEOR_API_URL as unknown as string,
    defaultConnectionId: createConnectionId(CONNECTION_ID as unknown as string),
    overrides: [
      {
        channelSlug: channelSlugRaw,
        connectionId: createConnectionId(CONNECTION_ID as unknown as string),
      },
    ],
  });

  const upsertConfig = await configRepo.upsert(configInput);

  if (upsertConfig.isErr()) {
    throw upsertConfig.error;
  }

  const refetchResult = await connectionRepo.get({
    saleorApiUrl: SALEOR_API_URL,
    id: CONNECTION_ID,
  });

  if (refetchResult.isErr()) {
    throw refetchResult.error;
  }

  return refetchResult.value;
};

/*
 * -------- Latency utilities -------------------------------------------------
 */

export interface LatencySample {
  totalMs: number;
  perRequestMs: number[];
}

export const percentile = (sample: number[], p: number): number => {
  if (sample.length === 0) {
    return 0;
  }
  const sorted = [...sample].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;

  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))]!;
};

export const measureLatency = async (
  count: number,
  fn: () => Promise<unknown>,
): Promise<LatencySample> => {
  const perRequestMs: number[] = [];
  const total0 = performance.now();

  for (let i = 0; i < count; i += 1) {
    const t0 = performance.now();

    await fn();
    perRequestMs.push(performance.now() - t0);
  }

  const totalMs = performance.now() - total0;

  return { totalMs, perRequestMs };
};
