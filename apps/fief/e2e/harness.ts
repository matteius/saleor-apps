/**
 * @vitest-environment node
 *
 * T42 — End-to-end harness for the full SSO + bidirectional sync round trip.
 *
 * Boots:
 *   1. `mongodb-memory-server` for the Mongo dependency (T3 singleton).
 *   2. `msw` for the Fief OIDC + Fief admin endpoints. The admin handler
 *      is stateful — it tracks PATCHes so the assertion phase can verify
 *      Saleor → Fief writes landed.
 *   3. Mongo migrations for every collection touched by the round trip
 *      (T8 provider_connections, T9 channel_configuration, T10 identity_map,
 *      T11 webhook_log + dlq, T52 outbound_queue).
 *   4. A real `RotatingFiefEncryptor` so per-connection secrets exercise the
 *      production encrypt/decrypt seam.
 *   5. An in-process Saleor GraphQL fake (`SaleorFake`) — exposes the narrow
 *      `customerCreate / updateMetadata / updatePrivateMetadata` surface the
 *      use cases consume, plus a `mutateCustomer(...)` method the test uses
 *      to drive the Saleor → Fief direction.
 *
 * The "live" E2E (against a staging Saleor + a real opensensor-fief deploy)
 * is a manual-run target — see `apps/fief/e2e/README.md`. Mocked mode is the
 * gate the CI runs on every PR; the live run is the production-rollout gate.
 */

// cspell:ignore upsert opensensor

import * as crypto from "node:crypto";

import { exportJWK, generateKeyPair, type KeyLike, SignJWT } from "jose";
import { type Db, type MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { http, HttpResponse } from "msw";
import { setupServer, type SetupServerApi } from "msw/node";
import { err, ok, type Result } from "neverthrow";
import { vi } from "vitest";

import {
  type ChannelConfiguration,
  channelConfigurationSchema,
  createChannelSlug,
  createConnectionId,
} from "@/modules/channel-configuration/channel-configuration";
import { createSaleorUserId, type SaleorUserId } from "@/modules/identity-map/identity-map";
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
import { type SaleorCustomerClient } from "@/modules/sync/fief-to-saleor/user-upsert.use-case";

/*
 * -------- Constants ---------------------------------------------------------
 */

export const PLUGIN_SECRET = "test_plugin_hmac_secret_e2e";
export const SALEOR_API_URL: SaleorApiUrl = createSaleorApiUrl(
  "https://shop-e2e.saleor.cloud/graphql/",
)._unsafeUnwrap();
export const CHANNEL_SLUG = createChannelSlug("default-channel");
export const CONNECTION_ID = createProviderConnectionId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
export const FIEF_BASE_URL = "https://tenant.e2e-fief.invalid";
export const FIEF_CLIENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const FIEF_TENANT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const ALLOWED_ORIGIN = "https://shop-e2e.example.com";
export const REDIRECT_URI = "https://shop-e2e.example.com/auth/callback";
export const SIGNING_KEY = "branding-signing-key-e2e";
export const FIEF_USER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

/* Plaintext Fief secrets used by the seeded connection. */
export const FIEF_CLIENT_SECRET = "fief-client-secret-e2e";
export const FIEF_ADMIN_TOKEN = "fief-admin-token-e2e";
export const FIEF_WEBHOOK_SECRET = "fief-webhook-secret-e2e";

/* The deterministic Saleor customer id minted by the SaleorFake. */
export const SALEOR_USER_ID_RAW = "VXNlcjplMmU=";

/*
 * -------- HMAC sign helpers (mirrors T40 harness) --------------------------
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

  Object.defineProperty(req, "nextUrl", {
    value: new URL(reqUrl),
    writable: false,
  });

  return req;
};

/*
 * -------- Fief OIDC + admin mocks (msw) ------------------------------------
 *
 * The OIDC mock matches the T40 harness shape so the auth-plane endpoints
 * resolve discovery + jwks + token-exchange against a real RS256 key pair.
 *
 * The admin mock is the new piece for T42 — it tracks PATCH /admin/api/users
 * + GET /admin/api/users (iterate by email). The test uses this surface to
 * (1) drive the Saleor → Fief direction (assert that a Saleor mutation
 * propagates a PATCH) and (2) drive the Fief → Saleor direction (mutate the
 * stored user record then signal the receiver).
 */

export interface FiefMockState {
  codeExchangeCount: number;
  refreshCount: number;
  revokeCount: number;
  discoveryCount: number;
  jwksCount: number;
  /** Number of admin PATCH /admin/api/users/{id} calls received. */
  adminUserPatchCount: number;
  /** Number of admin GET /admin/api/users (iterate) calls received. */
  adminUserListCount: number;
  /** Last PATCH body, surfaced for assertions. */
  lastUserPatchBody: Record<string, unknown> | undefined;
  rejectNextRefresh: boolean;
  rejectNextExchange: boolean;
  nextExchangeClaims?: Record<string, unknown>;
}

export interface FiefMockHandle {
  state: FiefMockState;
  /**
   * Sign a fresh id_token against the harness key. Useful when a future
   * extension wants to assert id_token decoding; the e2e flow currently
   * consumes claims directly from the exchange response.
   */
  issueIdToken(args?: { subject?: string; extraClaims?: Record<string, unknown> }): Promise<string>;
  /**
   * Pre-write or update a Fief admin user record. The receiver-driven
   * Fief→Saleor direction relies on this to surface a "the Fief side
   * mutated" signal.
   */
  upsertAdminUser(user: AdminUserDoc): void;
  /** Read a stored admin user record (for assertions). */
  getAdminUser(id: string): AdminUserDoc | undefined;
  reset(): void;
}

export interface AdminUserDoc {
  id: string;
  email: string;
  email_verified: boolean;
  is_active: boolean;
  tenant_id: string;
  created_at: string;
  updated_at: string;
  fields: Record<string, unknown>;
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
    publicJwk: { ...publicJwk, kid: "e2e-key-1", alg: "RS256", use: "sig" },
    kid: "e2e-key-1",
  };

  return cachedKey;
};

export const installFiefMocks = (server: SetupServerApi): FiefMockHandle => {
  const state: FiefMockState = {
    codeExchangeCount: 0,
    refreshCount: 0,
    revokeCount: 0,
    discoveryCount: 0,
    jwksCount: 0,
    adminUserPatchCount: 0,
    adminUserListCount: 0,
    lastUserPatchBody: undefined,
    rejectNextRefresh: false,
    rejectNextExchange: false,
  };

  const adminUsers = new Map<string, AdminUserDoc>();

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
    upsertAdminUser: (user) => {
      adminUsers.set(user.id, user);
    },
    getAdminUser: (id) => adminUsers.get(id),
    reset: () => {
      state.codeExchangeCount = 0;
      state.refreshCount = 0;
      state.revokeCount = 0;
      state.discoveryCount = 0;
      state.jwksCount = 0;
      state.adminUserPatchCount = 0;
      state.adminUserListCount = 0;
      state.lastUserPatchBody = undefined;
      state.rejectNextRefresh = false;
      state.rejectNextExchange = false;
      state.nextExchangeClaims = undefined;
      adminUsers.clear();
    },
  };

  server.use(
    /* OIDC discovery */
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
          access_token: "fief-access-token-e2e-1",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "fief-refresh-token-e2e-1",
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

        const idToken = await handle.issueIdToken();

        return HttpResponse.json({
          access_token: `fief-access-token-e2e-${state.refreshCount + 1}`,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: `fief-refresh-token-e2e-${state.refreshCount + 1}`,
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

    /* Admin API: GET /admin/api/users/?email=... → iterateUsers fallback. */
    http.get(`${baseUrl}/admin/api/users/`, ({ request }) => {
      state.adminUserListCount += 1;
      const url = new URL(request.url);
      const emailFilter = url.searchParams.get("email");
      const all = Array.from(adminUsers.values());
      const filtered = emailFilter
        ? all.filter((u) => u.email.toLowerCase() === emailFilter.toLowerCase())
        : all;

      return HttpResponse.json({ count: filtered.length, results: filtered });
    }),

    /* Admin API: GET /admin/api/users/{id} */
    http.get(`${baseUrl}/admin/api/users/:id`, ({ params }) => {
      const id = params.id as string;
      const user = adminUsers.get(id);

      if (!user) {
        return HttpResponse.json({ error: "not found" }, { status: 404 });
      }

      return HttpResponse.json(user);
    }),

    /*
     * Admin API: PATCH /admin/api/users/{id} — production code uses this for
     * the Saleor → Fief PATCH (T27).
     */
    http.patch(`${baseUrl}/admin/api/users/:id`, async ({ request, params }) => {
      state.adminUserPatchCount += 1;
      const id = params.id as string;
      const body = (await request.json()) as Record<string, unknown>;

      state.lastUserPatchBody = body;

      const existing = adminUsers.get(id) ?? {
        id,
        email: typeof body.email === "string" ? body.email : "alice@example.com",
        email_verified: false,
        is_active: true,
        tenant_id: FIEF_TENANT_ID,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        fields: {},
      };

      const updated: AdminUserDoc = {
        ...existing,
        email: typeof body.email === "string" ? body.email : existing.email,
        email_verified:
          typeof body.email_verified === "boolean" ? body.email_verified : existing.email_verified,
        is_active: typeof body.is_active === "boolean" ? body.is_active : existing.is_active,
        fields: {
          ...existing.fields,
          ...((body.fields as Record<string, unknown> | undefined) ?? {}),
        },
        updated_at: new Date().toISOString(),
      };

      adminUsers.set(id, updated);

      return HttpResponse.json(updated);
    }),
  );

  return handle;
};

/*
 * -------- Saleor GraphQL fake ----------------------------------------------
 *
 * The auth-plane (T19) and the Fief→Saleor sync (T23) both consume the
 * narrow `SaleorCustomerClient` interface (T7's GraphQL surface as seen by
 * use cases). We supply an in-memory fake so the e2e exercises the full
 * pipeline — claims projection, loop-guard tagging, race-safe identity bind
 * — without standing up a real Saleor instance.
 *
 * The fake also captures every metadata write so the test can assert that
 * the `fief_sync_origin = "fief"` marker (T13) lands on the Saleor side as
 * expected, and that the loop-guard correctly suppresses the echo when the
 * Saleor → Fief direction sees its own marker round-trip.
 */

export interface SaleorCustomerRecord {
  id: SaleorUserId;
  email: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
  isConfirmed: boolean;
  metadata: Array<{ key: string; value: string }>;
  privateMetadata: Array<{ key: string; value: string }>;
}

export interface SaleorFakeCallTrace {
  customerCreateCount: number;
  metadataUpdateCount: number;
  privateMetadataUpdateCount: number;
}

export class SaleorFake {
  private customers = new Map<string, SaleorCustomerRecord>();
  private nextIdCounter = 1;
  public readonly trace: SaleorFakeCallTrace = {
    customerCreateCount: 0,
    metadataUpdateCount: 0,
    privateMetadataUpdateCount: 0,
  };

  reset(): void {
    this.customers.clear();
    this.nextIdCounter = 1;
    this.trace.customerCreateCount = 0;
    this.trace.metadataUpdateCount = 0;
    this.trace.privateMetadataUpdateCount = 0;
  }

  /** Implements the narrow `SaleorCustomerClient` interface (T7/T19/T23). */
  client: SaleorCustomerClient = {
    customerCreate: async (input) => {
      this.trace.customerCreateCount += 1;
      const idStr = SALEOR_USER_ID_RAW;
      const branded = createSaleorUserId(idStr);

      if (branded.isErr()) {
        return err(branded.error as never);
      }

      const record: SaleorCustomerRecord = {
        id: branded.value,
        email: input.email,
        firstName: input.firstName ?? "",
        lastName: input.lastName ?? "",
        isActive: input.isActive ?? true,
        isConfirmed: false,
        metadata: [],
        privateMetadata: [],
      };

      this.customers.set(idStr, record);

      return ok({ saleorUserId: branded.value, email: input.email });
    },
    updateMetadata: async (input) => {
      this.trace.metadataUpdateCount += 1;
      const id = input.saleorUserId as unknown as string;
      const record = this.customers.get(id);

      if (record) {
        const merged = mergeMetadata(record.metadata, input.items);

        record.metadata = merged;
        this.customers.set(id, record);
      }

      return ok(undefined);
    },
    updatePrivateMetadata: async (input) => {
      this.trace.privateMetadataUpdateCount += 1;
      const id = input.saleorUserId as unknown as string;
      const record = this.customers.get(id);

      if (record) {
        const merged = mergeMetadata(record.privateMetadata, input.items);

        record.privateMetadata = merged;
        this.customers.set(id, record);
      }

      return ok(undefined);
    },
  };

  /**
   * Direct accessor for assertions. Returns a defensive copy so test code
   * can't accidentally mutate the fake's state.
   */
  getCustomer(id: SaleorUserId | string): SaleorCustomerRecord | undefined {
    const idStr = id as unknown as string;
    const record = this.customers.get(idStr);

    if (!record) return undefined;

    return {
      ...record,
      metadata: record.metadata.map((m) => ({ ...m })),
      privateMetadata: record.privateMetadata.map((m) => ({ ...m })),
    };
  }

  /**
   * Drive the Saleor → Fief direction. The test calls this to "mutate"
   * the customer in Saleor; the fake updates the record + returns the
   * resulting user shape that the sync use case will receive.
   *
   * The optional `stripFiefOriginMarker` flag (default `true`) simulates an
   * operator-driven Saleor-side edit that overwrites the `fief_sync_origin`
   * public metadata key. Without this strip, the loop guard (T13) correctly
   * treats the mutation as a Fief echo and the Saleor → Fief sync skips —
   * which is the production-correct behavior but not what an E2E driving
   * a "fresh operator change" wants to test.
   */
  mutateCustomer(
    id: SaleorUserId | string,
    patch: Partial<
      Pick<SaleorCustomerRecord, "email" | "firstName" | "lastName" | "isActive" | "isConfirmed">
    >,
    options: { stripFiefOriginMarker?: boolean } = {},
  ): SaleorCustomerRecord {
    const idStr = id as unknown as string;
    const record = this.customers.get(idStr);

    if (!record) {
      throw new Error(`SaleorFake.mutateCustomer: no customer with id ${idStr}`);
    }

    const stripFiefOriginMarker = options.stripFiefOriginMarker ?? true;
    const nextMetadata = stripFiefOriginMarker
      ? record.metadata.filter((m) => m.key !== "fief_sync_origin")
      : record.metadata;

    const next: SaleorCustomerRecord = {
      ...record,
      ...patch,
      metadata: nextMetadata,
    };

    this.customers.set(idStr, next);

    return next;
  }
}

const mergeMetadata = (
  existing: Array<{ key: string; value: string }>,
  incoming: Array<{ key: string; value: string }>,
): Array<{ key: string; value: string }> => {
  const map = new Map(existing.map((m) => [m.key, m.value]));

  for (const { key, value } of incoming) {
    map.set(key, value);
  }

  return Array.from(map.entries()).map(([key, value]) => ({ key, value }));
};

/*
 * -------- Mongo + composition-root harness ---------------------------------
 */

export interface E2EHarness {
  mongoServer: MongoMemoryServer;
  mongoClient: MongoClient;
  db: Db;
  server: SetupServerApi;
  fiefMock: FiefMockHandle;
  saleorFake: SaleorFake;
}

let harness: E2EHarness | undefined;

export const startHarness = async (): Promise<E2EHarness> => {
  if (harness) {
    return harness;
  }

  const mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();

  vi.stubEnv("MONGODB_URL", uri);

  vi.resetModules();

  const { resetProductionDepsForTests } = await import("@/lib/composition-root");

  resetProductionDepsForTests();

  const mongoClientModule = await import("@/modules/db/mongo-client");
  const mongoClient = await mongoClientModule.getMongoClient();
  const db = mongoClient.db("fief_app_e2e_test");

  /* Register + run all migrations the e2e flow exercises. */
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

  /* T52 outbound queue indexes — registered if the module exposes them. */
  try {
    const queueMigrations = (await import("@/modules/queue/migrations")) as {
      registerOutboundQueueMigrations?: () => void;
    };

    queueMigrations.registerOutboundQueueMigrations?.();
  } catch {
    /* Module shape may differ across in-flight refactors; tolerated. */
  }

  await runMigrations();

  const server = setupServer();

  server.listen({ onUnhandledRequest: "warn" });

  const fiefMock = installFiefMocks(server);
  const saleorFake = new SaleorFake();

  harness = {
    mongoServer,
    mongoClient,
    db,
    server,
    fiefMock,
    saleorFake,
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
 * -------- Seed helper ------------------------------------------------------
 */

export const seedConnection = async (): Promise<ProviderConnection> => {
  const { MongodbProviderConnectionRepo } = await import(
    "@/modules/provider-connections/repositories/mongodb/mongodb-provider-connection-repo"
  );
  const { MongoChannelConfigurationRepo } = await import(
    "@/modules/channel-configuration/repositories/mongodb/mongodb-channel-configuration-repo"
  );

  const connectionRepo = new MongodbProviderConnectionRepo();
  const configRepo = new MongoChannelConfigurationRepo();

  const channelSlugRaw = CHANNEL_SLUG as unknown as string;

  const createInput: ProviderConnectionCreateInput = {
    saleorApiUrl: SALEOR_API_URL,
    name: createProviderConnectionName("e2e-test-conn"),
    fief: {
      baseUrl: createFiefBaseUrl(FIEF_BASE_URL),
      tenantId: createFiefTenantId(FIEF_TENANT_ID),
      clientId: createFiefClientId(FIEF_CLIENT_ID),
      webhookId: null,
      clientSecret: FIEF_CLIENT_SECRET,
      pendingClientSecret: null,
      adminToken: FIEF_ADMIN_TOKEN,
      webhookSecret: FIEF_WEBHOOK_SECRET,
      pendingWebhookSecret: null,
    },
    branding: {
      signingKey: SIGNING_KEY,
      allowedOrigins: [createAllowedOrigin(ALLOWED_ORIGIN)],
    },
    /*
     * Project two example claims into Saleor metadata + privateMetadata so
     * the e2e can assert claims projection landed in both buckets.
     */
    claimMapping: [
      {
        fiefClaim: "first_name",
        saleorMetadataKey: "fief_first_name",
        required: false,
        visibility: "public",
        reverseSyncEnabled: true,
      },
      {
        fiefClaim: "loyalty_tier",
        saleorMetadataKey: "fief_loyalty_tier",
        required: false,
        visibility: "private",
        reverseSyncEnabled: false,
      },
    ],
  };

  const createResult = await connectionRepo.create(SALEOR_API_URL, createInput);

  if (createResult.isErr()) {
    throw createResult.error;
  }

  const connection = createResult.value;

  /* Force the deterministic CONNECTION_ID for downstream test assertions. */
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
 * -------- Fief webhook signing helper --------------------------------------
 *
 * Fief signs webhooks as `HMAC-SHA256(secret, "{ts}.{rawBody}")`, hex-encoded
 * in the `X-Fief-Webhook-Signature` header (matches the receiver in T22).
 * The e2e drives the Fief → Saleor direction by hitting the webhook receiver
 * route with this exact wire shape.
 */

export interface SignedFiefWebhook {
  rawBody: string;
  signatureHex: string;
  timestamp: string;
}

export const signFiefWebhook = (
  rawBody: string,
  secret: string = FIEF_WEBHOOK_SECRET,
): SignedFiefWebhook => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const message = `${timestamp}.${rawBody}`;
  const signatureHex = hmacHex(secret, message);

  return { rawBody, signatureHex, timestamp };
};

/*
 * -------- Saleor → Fief direction helpers ---------------------------------
 *
 * The production CUSTOMER_UPDATED webhook route (T27) invokes Saleor's
 * `app-sdk` `createHandler(...)` factory which is awkward to drive from a
 * test harness — it expects a real signed Saleor webhook with a JWKS-backed
 * signature. The use case (`CustomerUpdatedUseCase`) is the architectural
 * boundary between transport and domain, so the e2e drives that directly,
 * which exercises the same code path the queue worker (T52) drives in
 * production.
 */

export interface DriveSaleorMutationArgs {
  /** The mutated customer (post-mutation) — what Saleor would have shipped in CUSTOMER_UPDATED. */
  customer: SaleorCustomerRecord;
  /** The Saleor api url under which the customer lives. */
  saleorApiUrl: SaleorApiUrl;
}

export const driveSaleorCustomerUpdated = async (
  args: DriveSaleorMutationArgs,
): Promise<Result<unknown, Error>> => {
  const { CustomerUpdatedUseCase } = await import(
    "@/modules/sync/saleor-to-fief/customer-updated.use-case"
  );
  const { MongoChannelConfigurationRepo } = await import(
    "@/modules/channel-configuration/repositories/mongodb/mongodb-channel-configuration-repo"
  );
  const { MongodbProviderConnectionRepo } = await import(
    "@/modules/provider-connections/repositories/mongodb/mongodb-provider-connection-repo"
  );
  const { MongoIdentityMapRepo } = await import(
    "@/modules/identity-map/repositories/mongodb/mongodb-identity-map-repo"
  );
  const { FiefAdminApiClient } = await import("@/modules/fief-client/admin-api-client");
  const { createFiefBaseUrl: brandFiefBaseUrl } = await import(
    "@/modules/provider-connections/provider-connection"
  );

  const fiefAdmin = FiefAdminApiClient.create({ baseUrl: brandFiefBaseUrl(FIEF_BASE_URL) });

  const useCase = new CustomerUpdatedUseCase({
    channelConfigurationRepo: new MongoChannelConfigurationRepo(),
    providerConnectionRepo: new MongodbProviderConnectionRepo(),
    fiefAdmin,
    identityMapRepo: new MongoIdentityMapRepo(),
    isSaleorToFiefDisabled: () => false,
  });

  return useCase.execute({
    saleorApiUrl: args.saleorApiUrl,
    user: {
      id: args.customer.id as unknown as string,
      email: args.customer.email,
      firstName: args.customer.firstName,
      lastName: args.customer.lastName,
      isActive: args.customer.isActive,
      isConfirmed: args.customer.isConfirmed,
      languageCode: "EN_US",
      metadata: args.customer.metadata,
      privateMetadata: args.customer.privateMetadata,
    },
    channelSlug: CHANNEL_SLUG as unknown as string,
  });
};
