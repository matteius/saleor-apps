/*
 * @vitest-environment node
 *
 * T19 — `POST /api/auth/external-obtain-access-tokens` route handler test (Path A).
 *
 * The route is the apps/fief side of the Saleor `BasePlugin`'s
 * `external_obtain_access_tokens(...)` call (T56/T57). It is the canonical
 * first-login entry point for Path A. Pipeline:
 *
 *   1. Verify HMAC via T58.
 *   2. Verify inbound `branding_origin` (T15) and pull the Fief authorization
 *      code from the request body.
 *   3. Exchange the code at the Fief tenant via T6 (`exchangeCode`) using the
 *      dual-secret rotation array.
 *   4. **Race-safe identity bind** via T10's atomic upsert — `wasInserted=true`
 *      means we own the binding and must `customerCreate` against Saleor;
 *      `wasInserted=false` means another concurrent caller (T19 second device,
 *      OR the T22→T23 webhook) bound it first; we reuse that `saleorUserId`.
 *   5. Project claims (T14) and write split metadata via T7. Tag the write
 *      with `tagWrite("fief", seq)` so the loop guard (T13) drops the inevitable
 *      Saleor→Fief mirror echo.
 *   6. Return the shaped user-claims payload via T55 (`shapeUserClaimsForSaleorPlugin`).
 *
 * Mandatory race tests:
 *   - **Two-device first-login race** — two concurrent invocations bind the
 *     same identity, exactly one Saleor `customerCreate` survives.
 *   - **T19↔T22 race** — Fief's `user.created` webhook (T22→T23) writes the
 *     identity_map row in parallel with this endpoint's first-login flow;
 *     T19 must observe the existing row and skip the redundant create.
 *
 * Mandatory loop-prevention test: every metadata write carries the origin
 * marker `"fief"` (target side of the write) so a subsequent CUSTOMER_UPDATED
 * Saleor webhook is dropped by T13 — the canary against the Saleor↔Fief
 * infinite-loop regression.
 */

import * as crypto from "node:crypto";

import { err, ok, type Result } from "neverthrow";
import { type NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real implementations — wire format is locked by the test, not the dep.
import { sign as signBrandingOrigin } from "@/modules/branding/origin-signer";
import {
  type ChannelConfiguration,
  createConnectionId,
} from "@/modules/channel-configuration/channel-configuration";
import {
  type ChannelConfigurationRepoErrorInstance,
  type IChannelConfigurationRepo,
} from "@/modules/channel-configuration/channel-configuration-repo";
import {
  ChannelResolver,
  createChannelResolverCache,
} from "@/modules/channel-configuration/channel-resolver";
import {
  createSaleorUserId,
  type FiefUserId,
  type IdentityMapRow,
  type SaleorUserId,
} from "@/modules/identity-map/identity-map";
import {
  type GetByFiefUserInput,
  type GetBySaleorUserInput,
  type IdentityMapRepo,
  type IdentityMapRepoError,
  type UpsertIdentityMapInput,
} from "@/modules/identity-map/identity-map-repo";
import {
  createProviderConnectionId,
  type DecryptedProviderConnectionSecrets,
  type ProviderConnection,
  type ProviderConnectionId,
  type ProviderConnectionUpdateInput,
} from "@/modules/provider-connections/provider-connection";
import {
  type GetProviderConnectionAccess,
  type ProviderConnectionRepo,
  ProviderConnectionRepoError,
} from "@/modules/provider-connections/provider-connection-repo";
import { createSaleorApiUrl, type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { FIEF_SYNC_ORIGIN_KEY, FIEF_SYNC_SEQ_KEY } from "@/modules/sync/loop-guard";

/*
 * ----------------------------------------------------------------------------
 * Test constants
 * ----------------------------------------------------------------------------
 */

const PLUGIN_SECRET = "test_plugin_hmac_secret";
const SIGNING_KEY = "branding-signing-key-test";
const FIEF_BASE_URL = "https://tenant.fief.dev";
const ALLOWED_ORIGIN = "https://shop-1.example.com";
const REDIRECT_URI = "https://shop-1.example.com/callback";

const SALEOR_API_URL: SaleorApiUrl = createSaleorApiUrl(
  "https://shop-1.saleor.cloud/graphql/",
)._unsafeUnwrap();

const CONNECTION_ID = createProviderConnectionId("44444444-4444-4444-8444-444444444444");
const FIEF_USER_UUID = "55555555-5555-4555-8555-555555555555";
const FIEF_USER_ID = FIEF_USER_UUID as unknown as FiefUserId;

const ROUTE_PATHNAME = "/api/auth/external-obtain-access-tokens";
const ROUTE_URL = `https://app.test${ROUTE_PATHNAME}`;

/*
 * ----------------------------------------------------------------------------
 * HMAC sign helper (mirrors T58's wire spec, byte-for-byte)
 * ----------------------------------------------------------------------------
 */

const sha256Hex = (bytes: Uint8Array): string =>
  crypto.createHash("sha256").update(bytes).digest("hex");

const hmacHex = (secret: string, message: string): string =>
  crypto
    .createHmac("sha256", Buffer.from(secret, "utf-8"))
    .update(Buffer.from(message, "utf-8"))
    .digest("hex");

interface BuildSignedRequestOpts {
  body: unknown;
  secret?: string;
  timestamp?: number;
  saleorApiUrl?: string;
  channelSlug?: string;
  overrideSignature?: string;
}

const buildSignedRequest = (opts: BuildSignedRequestOpts): NextRequest => {
  const bodyStr = JSON.stringify(opts.body);
  const ts = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const bodyHex = sha256Hex(new TextEncoder().encode(bodyStr));
  const message = `POST\n${ROUTE_PATHNAME}\n${ts}\n${bodyHex}`;
  const signature = opts.overrideSignature ?? hmacHex(opts.secret ?? PLUGIN_SECRET, message);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "X-Fief-Plugin-Timestamp": String(ts),
    "X-Fief-Plugin-Signature": signature,
    "X-Fief-Plugin-Saleor-Url": opts.saleorApiUrl ?? SALEOR_API_URL,
  };

  if (opts.channelSlug !== undefined) {
    headers["X-Fief-Plugin-Channel"] = opts.channelSlug;
  }

  const req = new Request(ROUTE_URL, {
    method: "POST",
    body: bodyStr,
    headers: new Headers(headers),
  }) as unknown as NextRequest;

  Object.defineProperty(req, "nextUrl", {
    value: new URL(ROUTE_URL),
  });

  return req;
};

/*
 * ----------------------------------------------------------------------------
 * Fakes
 * ----------------------------------------------------------------------------
 */

const buildConnection = (
  overrides: Partial<{ allowedOrigins: string[]; clientId: string; baseUrl: string }> = {},
): ProviderConnection =>
  ({
    id: CONNECTION_ID,
    saleorApiUrl: SALEOR_API_URL,
    name: "test-conn" as ProviderConnection["name"],
    fief: {
      baseUrl: (overrides.baseUrl ?? FIEF_BASE_URL) as ProviderConnection["fief"]["baseUrl"],
      tenantId: "tenant-1" as ProviderConnection["fief"]["tenantId"],
      clientId: (overrides.clientId ?? "fief-client-abc") as ProviderConnection["fief"]["clientId"],
      webhookId: null,
      encryptedClientSecret: "enc" as ProviderConnection["fief"]["encryptedClientSecret"],
      encryptedPendingClientSecret: null,
      encryptedAdminToken: "enc" as ProviderConnection["fief"]["encryptedAdminToken"],
      encryptedWebhookSecret: "enc" as ProviderConnection["fief"]["encryptedWebhookSecret"],
      encryptedPendingWebhookSecret: null,
    },
    branding: {
      encryptedSigningKey: "enc" as ProviderConnection["branding"]["encryptedSigningKey"],
      allowedOrigins: (overrides.allowedOrigins ?? [
        ALLOWED_ORIGIN,
      ]) as ProviderConnection["branding"]["allowedOrigins"],
    },
    claimMapping: [
      { fiefClaim: "first_name", saleorMetadataKey: "fief.first_name", visibility: "public" },
      { fiefClaim: "last_name", saleorMetadataKey: "fief.last_name", visibility: "public" },
      { fiefClaim: "internal_tier", saleorMetadataKey: "fief.tier", visibility: "private" },
    ],
    softDeletedAt: null,
  }) as ProviderConnection;

class FakeChannelConfigurationRepo implements IChannelConfigurationRepo {
  public configsByUrl = new Map<string, ChannelConfiguration | null>();

  async get(
    url: SaleorApiUrl,
  ): Promise<Result<ChannelConfiguration | null, ChannelConfigurationRepoErrorInstance>> {
    return ok(this.configsByUrl.get(url) ?? null);
  }

  async upsert(): Promise<Result<void, ChannelConfigurationRepoErrorInstance>> {
    throw new Error("not used");
  }
}

class FakeProviderConnectionRepo implements ProviderConnectionRepo {
  public connectionsById = new Map<string, ProviderConnection>();
  public plaintextSigningKeyById = new Map<string, string>();
  public plaintextClientSecretById = new Map<string, string>();
  public plaintextPendingClientSecretById = new Map<string, string | null>();

  async create(): Promise<
    Result<ProviderConnection, InstanceType<(typeof ProviderConnectionRepoError)["FailureSaving"]>>
  > {
    throw new Error("not used");
  }

  async get(
    access: GetProviderConnectionAccess,
  ): Promise<
    Result<
      ProviderConnection,
      | InstanceType<(typeof ProviderConnectionRepoError)["NotFound"]>
      | InstanceType<(typeof ProviderConnectionRepoError)["FailureFetching"]>
    >
  > {
    const found = this.connectionsById.get(access.id as unknown as string);

    if (!found) {
      return err(new ProviderConnectionRepoError.NotFound(`no connection ${access.id}`));
    }

    return ok(found);
  }

  async list(): Promise<
    Result<
      ProviderConnection[],
      InstanceType<(typeof ProviderConnectionRepoError)["FailureFetching"]>
    >
  > {
    throw new Error("not used");
  }

  async update(
    _access: { saleorApiUrl: SaleorApiUrl; id: ProviderConnectionId },
    _patch: ProviderConnectionUpdateInput,
  ): Promise<
    Result<
      ProviderConnection,
      | InstanceType<(typeof ProviderConnectionRepoError)["NotFound"]>
      | InstanceType<(typeof ProviderConnectionRepoError)["FailureSaving"]>
    >
  > {
    throw new Error("not used");
  }

  async softDelete(): Promise<
    Result<
      void,
      | InstanceType<(typeof ProviderConnectionRepoError)["NotFound"]>
      | InstanceType<(typeof ProviderConnectionRepoError)["FailureDeleting"]>
    >
  > {
    throw new Error("not used");
  }

  async restore(): Promise<
    Result<
      ProviderConnection,
      | InstanceType<(typeof ProviderConnectionRepoError)["NotFound"]>
      | InstanceType<(typeof ProviderConnectionRepoError)["FailureSaving"]>
    >
  > {
    throw new Error("not used");
  }

  async getDecryptedSecrets(
    access: GetProviderConnectionAccess,
  ): Promise<
    Result<
      DecryptedProviderConnectionSecrets,
      | InstanceType<(typeof ProviderConnectionRepoError)["NotFound"]>
      | InstanceType<(typeof ProviderConnectionRepoError)["FailureFetching"]>
      | InstanceType<(typeof ProviderConnectionRepoError)["FailureDecrypting"]>
    >
  > {
    const id = access.id as unknown as string;

    if (!this.connectionsById.has(id)) {
      return err(new ProviderConnectionRepoError.NotFound(`no connection ${id}`));
    }

    return ok({
      fief: {
        clientSecret: this.plaintextClientSecretById.get(id) ?? "client-secret-current",
        pendingClientSecret: this.plaintextPendingClientSecretById.get(id) ?? null,
        adminToken: "admin-token-plain",
        webhookSecret: "webhook-secret-plain",
        pendingWebhookSecret: null,
      },
      branding: {
        signingKey: this.plaintextSigningKeyById.get(id) ?? SIGNING_KEY,
      },
    });
  }
}

interface FakeIdentityMapRepoOptions {
  beforeUpsertCommit?: (input: UpsertIdentityMapInput) => Promise<void> | void;
}

class FakeIdentityMapRepo implements IdentityMapRepo {
  private readonly rowsByFief = new Map<string, IdentityMapRow>();
  private readonly rowsBySaleor = new Map<string, IdentityMapRow>();

  public upsertCallCount = 0;
  public createSaleorRowsCount = 0;

  private readonly options: FakeIdentityMapRepoOptions;

  constructor(options: FakeIdentityMapRepoOptions = {}) {
    this.options = options;
  }

  async getByFiefUser(
    input: GetByFiefUserInput,
  ): Promise<Result<IdentityMapRow | null, InstanceType<typeof IdentityMapRepoError>>> {
    return ok(this.rowsByFief.get(`${input.saleorApiUrl}::${input.fiefUserId}`) ?? null);
  }

  async getBySaleorUser(
    input: GetBySaleorUserInput,
  ): Promise<Result<IdentityMapRow | null, InstanceType<typeof IdentityMapRepoError>>> {
    return ok(this.rowsBySaleor.get(`${input.saleorApiUrl}::${input.saleorUserId}`) ?? null);
  }

  async upsert(
    input: UpsertIdentityMapInput,
  ): Promise<
    Result<{ row: IdentityMapRow; wasInserted: boolean }, InstanceType<typeof IdentityMapRepoError>>
  > {
    this.upsertCallCount++;

    if (this.options.beforeUpsertCommit) {
      await this.options.beforeUpsertCommit(input);
    }

    const fiefKey = `${input.saleorApiUrl}::${input.fiefUserId}`;
    const existing = this.rowsByFief.get(fiefKey);

    if (existing) {
      if (input.syncSeq > existing.lastSyncSeq) {
        const updated: IdentityMapRow = {
          ...existing,
          lastSyncSeq: input.syncSeq,
          lastSyncedAt: new Date(),
        };

        this.rowsByFief.set(fiefKey, updated);
        this.rowsBySaleor.set(`${updated.saleorApiUrl}::${updated.saleorUserId}`, updated);

        return ok({ row: updated, wasInserted: false });
      }

      return ok({ row: existing, wasInserted: false });
    }

    const fresh: IdentityMapRow = {
      saleorApiUrl: input.saleorApiUrl,
      saleorUserId: input.saleorUserId,
      fiefUserId: input.fiefUserId,
      lastSyncSeq: input.syncSeq,
      lastSyncedAt: new Date(),
    };

    this.rowsByFief.set(fiefKey, fresh);
    this.rowsBySaleor.set(`${fresh.saleorApiUrl}::${fresh.saleorUserId}`, fresh);
    this.createSaleorRowsCount++;

    return ok({ row: fresh, wasInserted: true });
  }

  async delete(): Promise<Result<void, InstanceType<typeof IdentityMapRepoError>>> {
    return ok(undefined);
  }

  seedRow(row: IdentityMapRow): void {
    this.rowsByFief.set(`${row.saleorApiUrl}::${row.fiefUserId}`, row);
    this.rowsBySaleor.set(`${row.saleorApiUrl}::${row.saleorUserId}`, row);
  }
}

class FakeFiefOidcClient {
  public exchangeCallCount = 0;
  public lastExchangeInput?: {
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecrets: string[];
  };

  public exchangeImpl: (input: {
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecrets: string[];
  }) => Promise<Result<unknown, Error>> = async () =>
    ok({
      accessToken: "fief_access_xyz",
      idToken: "fief_id_xyz",
      refreshToken: "fief_refresh_xyz",
      expiresIn: 3600,
      tokenType: "Bearer",
      scope: "openid email profile",
    });

  async exchangeCode(input: {
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecrets: string[];
  }): Promise<Result<unknown, Error>> {
    this.exchangeCallCount++;
    this.lastExchangeInput = input;

    return this.exchangeImpl(input);
  }
}

interface FakeSaleorClientOptions {
  createdId?: string;
  failCreate?: boolean;
  failMetadataUpdate?: boolean;
  /** When set, customerCreate sleeps before returning. Used for race tests. */
  createDelayMs?: number;
}

class FakeSaleorClient {
  public readonly customerCreateCalls: Array<{
    saleorApiUrl: SaleorApiUrl;
    email: string;
    firstName?: string;
    lastName?: string;
    isActive?: boolean;
  }> = [];

  public readonly metadataUpdateCalls: Array<{
    saleorApiUrl: SaleorApiUrl;
    saleorUserId: SaleorUserId;
    items: Array<{ key: string; value: string }>;
  }> = [];

  public readonly privateMetadataUpdateCalls: Array<{
    saleorApiUrl: SaleorApiUrl;
    saleorUserId: SaleorUserId;
    items: Array<{ key: string; value: string }>;
  }> = [];

  private readonly options: FakeSaleorClientOptions;

  constructor(options: FakeSaleorClientOptions = {}) {
    this.options = options;
  }

  async customerCreate(input: {
    saleorApiUrl: SaleorApiUrl;
    email: string;
    firstName?: string;
    lastName?: string;
    isActive?: boolean;
  }): Promise<Result<{ saleorUserId: SaleorUserId; email: string }, Error>> {
    if (this.options.createDelayMs) {
      await new Promise((r) => setTimeout(r, this.options.createDelayMs));
    }

    this.customerCreateCalls.push(input);

    if (this.options.failCreate) {
      return err(new Error("forced create failure"));
    }

    const idRaw = this.options.createdId ?? "VXNlcjox";

    return ok({
      saleorUserId: createSaleorUserId(idRaw)._unsafeUnwrap(),
      email: input.email,
    });
  }

  async updateMetadata(input: {
    saleorApiUrl: SaleorApiUrl;
    saleorUserId: SaleorUserId;
    items: Array<{ key: string; value: string }>;
  }): Promise<Result<void, Error>> {
    this.metadataUpdateCalls.push(input);

    if (this.options.failMetadataUpdate) {
      return err(new Error("forced metadata failure"));
    }

    return ok(undefined);
  }

  async updatePrivateMetadata(input: {
    saleorApiUrl: SaleorApiUrl;
    saleorUserId: SaleorUserId;
    items: Array<{ key: string; value: string }>;
  }): Promise<Result<void, Error>> {
    this.privateMetadataUpdateCalls.push(input);

    return ok(undefined);
  }
}

/*
 * ----------------------------------------------------------------------------
 * Test harness
 * ----------------------------------------------------------------------------
 */

interface TestHarness {
  channelConfigRepo: FakeChannelConfigurationRepo;
  connectionRepo: FakeProviderConnectionRepo;
  channelResolver: ChannelResolver;
  identityMapRepo: FakeIdentityMapRepo;
  saleorClient: FakeSaleorClient;
  fiefOidcClient: FakeFiefOidcClient;
}

interface BuildHarnessOpts {
  connection?: ProviderConnection;
  channelConfig?: ChannelConfiguration | null;
  signingKey?: string;
  identityMapOptions?: FakeIdentityMapRepoOptions;
  saleorClientOptions?: FakeSaleorClientOptions;
  /** Pre-seed an identity_map row to simulate T22→T23 race winner. */
  seedRow?: IdentityMapRow;
  pendingClientSecret?: string | null;
}

const buildHarness = (opts: BuildHarnessOpts = {}): TestHarness => {
  const channelConfigRepo = new FakeChannelConfigurationRepo();
  const connectionRepo = new FakeProviderConnectionRepo();

  const conn = opts.connection ?? buildConnection();

  connectionRepo.connectionsById.set(conn.id as unknown as string, conn);
  connectionRepo.plaintextSigningKeyById.set(
    conn.id as unknown as string,
    opts.signingKey ?? SIGNING_KEY,
  );
  connectionRepo.plaintextClientSecretById.set(
    conn.id as unknown as string,
    "client-secret-current",
  );
  if (opts.pendingClientSecret !== undefined) {
    connectionRepo.plaintextPendingClientSecretById.set(
      conn.id as unknown as string,
      opts.pendingClientSecret,
    );
  }

  const config: ChannelConfiguration | null =
    opts.channelConfig === undefined
      ? {
          saleorApiUrl: SALEOR_API_URL,
          defaultConnectionId: createConnectionId(conn.id as unknown as string),
          overrides: [],
        }
      : opts.channelConfig;

  if (config) {
    channelConfigRepo.configsByUrl.set(SALEOR_API_URL, config);
  }

  const channelResolver = new ChannelResolver({
    channelConfigurationRepo: channelConfigRepo,
    providerConnectionRepo: connectionRepo,
    cache: createChannelResolverCache(),
  });

  const identityMapRepo = new FakeIdentityMapRepo(opts.identityMapOptions ?? {});

  if (opts.seedRow) {
    identityMapRepo.seedRow(opts.seedRow);
  }

  const saleorClient = new FakeSaleorClient(opts.saleorClientOptions ?? {});
  const fiefOidcClient = new FakeFiefOidcClient();

  return {
    channelConfigRepo,
    connectionRepo,
    channelResolver,
    identityMapRepo,
    saleorClient,
    fiefOidcClient,
  };
};

const buildBrandingOriginToken = (
  signingKey: string = SIGNING_KEY,
  origin: string = ALLOWED_ORIGIN,
): string => signBrandingOrigin(origin, signingKey);

const buildValidBody = (
  overrides: Partial<{
    code: string;
    redirectUri: string;
    origin: string;
    brandingOrigin: string;
    saleorApiUrl: string;
    channelSlug: string;
    fiefUser: Record<string, unknown>;
  }> = {},
) => ({
  saleorApiUrl: overrides.saleorApiUrl ?? SALEOR_API_URL,
  channelSlug: overrides.channelSlug ?? "default",
  input: {
    code: overrides.code ?? "fief_authcode_xyz",
    redirectUri: overrides.redirectUri ?? REDIRECT_URI,
    origin: overrides.origin ?? ALLOWED_ORIGIN,
    brandingOrigin: overrides.brandingOrigin ?? buildBrandingOriginToken(),
  },
});

/*
 * ----------------------------------------------------------------------------
 * Mocks
 * ----------------------------------------------------------------------------
 */

vi.mock("@/lib/env", () => ({
  env: {
    SECRET_KEY: "x".repeat(64),
    APP_LOG_LEVEL: "info",
    FIEF_SYNC_DISABLED: false,
    FIEF_SALEOR_TO_FIEF_DISABLED: false,
    FIEF_PLUGIN_HMAC_SECRET: PLUGIN_SECRET,
  },
}));

const { buildDepsMock } = vi.hoisted(() => ({
  buildDepsMock: vi.fn(),
}));

vi.mock("./build-deps", () => ({
  buildDeps: buildDepsMock,
}));

const { fiefOidcClientCtorMock, lastFiefOidcClientCtorInput } = vi.hoisted(() => ({
  fiefOidcClientCtorMock: vi.fn(),
  lastFiefOidcClientCtorInput: { value: undefined as { baseUrl: string } | undefined },
}));

vi.mock("@/modules/fief-client/oidc-client", () => ({
  FiefOidcClient: fiefOidcClientCtorMock,
}));

const wireDeps = (h: TestHarness) => {
  buildDepsMock.mockReturnValue({
    channelResolver: h.channelResolver,
    connectionRepo: h.connectionRepo,
    identityMapRepo: h.identityMapRepo,
    saleorClient: h.saleorClient,
  });
  fiefOidcClientCtorMock.mockImplementation((input: { baseUrl: string }) => {
    lastFiefOidcClientCtorInput.value = input;

    return h.fiefOidcClient;
  });
};

/*
 * ----------------------------------------------------------------------------
 * Tests
 * ----------------------------------------------------------------------------
 */

describe("POST /api/auth/external-obtain-access-tokens — T19", () => {
  beforeEach(() => {
    buildDepsMock.mockReset();
    fiefOidcClientCtorMock.mockReset();
    lastFiefOidcClientCtorInput.value = undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -- Cold first-login -------------------------------------------------------

  it("cold first-login: creates Saleor customer, identity_map row, tagged metadata, and returns shaped claims", async () => {
    const h = buildHarness({ saleorClientOptions: { createdId: "U2FsZW9yQzox" } });

    h.fiefOidcClient.exchangeImpl = async () =>
      ok({
        accessToken: "fief_at",
        idToken: "fief_id",
        refreshToken: "fief_rt",
        expiresIn: 3600,
        tokenType: "Bearer",
        scope: "openid email profile",
        /*
         * Decoded id_token claims would come via verifyIdToken; we surface the user fields
         * via a "claims" key the route reads. This contract is locked by the test.
         */
        claims: {
          sub: FIEF_USER_UUID,
          email: "alice@example.com",
          email_verified: true,
          first_name: "Alice",
          last_name: "Anderson",
          internal_tier: "gold",
        },
      });

    wireDeps(h);

    const { POST } = await import("./route");

    const res = await POST(buildSignedRequest({ body: buildValidBody(), channelSlug: "default" }));

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;

    // Wire-contract from T55's shapeUserClaimsForSaleorPlugin
    expect(json.id).toBe("U2FsZW9yQzox");
    expect(json.email).toBe("alice@example.com");
    expect(json.firstName).toBe("Alice");
    expect(json.lastName).toBe("Anderson");
    expect(json.isActive).toBe(true);
    expect(json.metadata).toMatchObject({
      "fief.first_name": "Alice",
      "fief.last_name": "Anderson",
    });
    expect((json.privateMetadata as Record<string, string>)["fief.tier"]).toBe("gold");

    // Saleor customer was created exactly once.
    expect(h.saleorClient.customerCreateCalls).toHaveLength(1);
    expect(h.saleorClient.customerCreateCalls[0]).toMatchObject({
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Anderson",
    });

    // identity_map upsert happened, wasInserted=true (cold path).
    expect(h.identityMapRepo.upsertCallCount).toBe(1);
    expect(h.identityMapRepo.createSaleorRowsCount).toBe(1);

    /*
     * Loop-prevention canary: write metadata carries the origin marker
     * "fief" so a subsequent CUSTOMER_UPDATED bouncing back via Fief will be
     * dropped by T13.
     */
    expect(h.saleorClient.metadataUpdateCalls).toHaveLength(1);
    const metadataMap = Object.fromEntries(
      h.saleorClient.metadataUpdateCalls[0].items.map((i) => [i.key, i.value]),
    );

    expect(metadataMap[FIEF_SYNC_ORIGIN_KEY]).toBe("fief");
    expect(metadataMap["fief.first_name"]).toBe("Alice");

    expect(h.saleorClient.privateMetadataUpdateCalls).toHaveLength(1);
    const privateMap = Object.fromEntries(
      h.saleorClient.privateMetadataUpdateCalls[0].items.map((i) => [i.key, i.value]),
    );

    expect(Number.parseInt(privateMap[FIEF_SYNC_SEQ_KEY], 10)).toBeGreaterThanOrEqual(0);
  });

  // -- Warm returning user ----------------------------------------------------

  it("warm returning user: no customerCreate; metadata refresh against existing binding", async () => {
    const existingId = "ExistingSaleorUserId";
    const h = buildHarness({
      seedRow: {
        saleorApiUrl: SALEOR_API_URL,
        saleorUserId: createSaleorUserId(existingId)._unsafeUnwrap(),
        fiefUserId: FIEF_USER_ID,
        lastSyncSeq: 5,
        lastSyncedAt: new Date(),
      },
    });

    h.fiefOidcClient.exchangeImpl = async () =>
      ok({
        accessToken: "fief_at",
        claims: {
          sub: FIEF_USER_UUID,
          email: "alice@example.com",
          first_name: "Alicia",
          last_name: "Anderson",
        },
      });

    wireDeps(h);

    const { POST } = await import("./route");

    const res = await POST(buildSignedRequest({ body: buildValidBody(), channelSlug: "default" }));

    expect(res.status).toBe(200);

    expect(h.saleorClient.customerCreateCalls).toHaveLength(0);
    // Metadata still refreshed against the bound id.
    expect(h.saleorClient.metadataUpdateCalls).toHaveLength(1);
    expect(h.saleorClient.metadataUpdateCalls[0].saleorUserId).toBe(existingId);

    const json = (await res.json()) as Record<string, unknown>;

    expect(json.id).toBe(existingId);
  });

  // -- Idempotent retry -------------------------------------------------------

  it("idempotent retry: same Fief code → equivalent response, single customerCreate net", async () => {
    const h = buildHarness({ saleorClientOptions: { createdId: "U2FsZW9yQzox" } });

    h.fiefOidcClient.exchangeImpl = async () =>
      ok({
        accessToken: "fief_at",
        claims: { sub: FIEF_USER_UUID, email: "alice@example.com", first_name: "Alice" },
      });

    wireDeps(h);

    const { POST } = await import("./route");

    const first = await POST(
      buildSignedRequest({ body: buildValidBody(), channelSlug: "default" }),
    );

    expect(first.status).toBe(200);

    const second = await POST(
      buildSignedRequest({ body: buildValidBody(), channelSlug: "default" }),
    );

    expect(second.status).toBe(200);

    // The second invocation observes the existing identity_map and skips create.
    expect(h.saleorClient.customerCreateCalls).toHaveLength(1);

    const firstJson = (await first.json()) as Record<string, unknown>;
    const secondJson = (await second.json()) as Record<string, unknown>;

    expect(secondJson.id).toBe(firstJson.id);
    expect(secondJson.email).toBe(firstJson.email);
  });

  // -- Two-device race --------------------------------------------------------

  it("two-device race: two parallel invocations bind the same identity, exactly one customerCreate", async () => {
    /*
     * Race semantics — drives the route TWICE concurrently. The fake
     * IdentityMapRepo's `beforeUpsertCommit` hook gates the first invocation
     * inside its upsert call so the second invocation's `getByFiefUser`
     * returns null; we then release the first to commit. The second's
     * subsequent `upsert` returns `wasInserted: false` and the route MUST
     * NOT call `customerCreate` a second time.
     */
    let firstUpsertEntered = false;
    let releaseFirstUpsert: () => void = () => undefined;
    const firstUpsertGate = new Promise<void>((resolve) => {
      releaseFirstUpsert = resolve;
    });

    const h = buildHarness({
      saleorClientOptions: { createdId: "RaceWinnerId" },
      identityMapOptions: {
        beforeUpsertCommit: async () => {
          if (!firstUpsertEntered) {
            firstUpsertEntered = true;
            await firstUpsertGate;
          }
        },
      },
    });

    h.fiefOidcClient.exchangeImpl = async () =>
      ok({
        accessToken: "fief_at",
        claims: { sub: FIEF_USER_UUID, email: "alice@example.com", first_name: "Alice" },
      });

    wireDeps(h);

    const { POST } = await import("./route");

    const firstPromise = POST(
      buildSignedRequest({ body: buildValidBody(), channelSlug: "default" }),
    );

    while (!firstUpsertEntered) {
      await new Promise((r) => setTimeout(r, 1));
    }

    releaseFirstUpsert();
    const firstRes = await firstPromise;

    expect(firstRes.status).toBe(200);

    /*
     * Now fire the second — its getByFiefUser sees the committed row,
     * so it skips customerCreate entirely.
     */
    const secondRes = await POST(
      buildSignedRequest({ body: buildValidBody(), channelSlug: "default" }),
    );

    expect(secondRes.status).toBe(200);

    // Exactly one Saleor customer was created across both runs.
    expect(h.saleorClient.customerCreateCalls).toHaveLength(1);
    expect(h.identityMapRepo.createSaleorRowsCount).toBe(1);

    // Both runs return the SAME saleor user id.
    const firstJson = (await firstRes.json()) as Record<string, unknown>;
    const secondJson = (await secondRes.json()) as Record<string, unknown>;

    expect(secondJson.id).toBe(firstJson.id);
  });

  // -- T19↔T22 webhook race ---------------------------------------------------

  it("T19↔T22 race: when T22→T23 webhook pre-creates the row, T19 reuses the binding", async () => {
    /*
     * Simulate the T22→T23 webhook winning the race by seeding the
     * identity_map row before the route fires. T19 must observe the row
     * via getByFiefUser → upsert and skip customerCreate.
     */
    const h = buildHarness({
      seedRow: {
        saleorApiUrl: SALEOR_API_URL,
        saleorUserId: createSaleorUserId("WebhookCreatedId")._unsafeUnwrap(),
        fiefUserId: FIEF_USER_ID,
        lastSyncSeq: 1,
        lastSyncedAt: new Date(),
      },
    });

    h.fiefOidcClient.exchangeImpl = async () =>
      ok({
        accessToken: "fief_at",
        claims: { sub: FIEF_USER_UUID, email: "alice@example.com", first_name: "Alice" },
      });

    wireDeps(h);

    const { POST } = await import("./route");

    const res = await POST(buildSignedRequest({ body: buildValidBody(), channelSlug: "default" }));

    expect(res.status).toBe(200);
    expect(h.saleorClient.customerCreateCalls).toHaveLength(0);

    const json = (await res.json()) as Record<string, unknown>;

    expect(json.id).toBe("WebhookCreatedId");

    // Seq is bumped above the pre-existing value.
    const privateMap = Object.fromEntries(
      h.saleorClient.privateMetadataUpdateCalls[0].items.map((i) => [i.key, i.value]),
    );

    expect(Number.parseInt(privateMap[FIEF_SYNC_SEQ_KEY], 10)).toBeGreaterThan(1);
  });

  // -- Loop-prevention --------------------------------------------------------

  it("loop-prevention: write carries origin=fief marker so subsequent CUSTOMER_UPDATED is dropped by T13", async () => {
    const h = buildHarness({ saleorClientOptions: { createdId: "LoopUserId" } });

    h.fiefOidcClient.exchangeImpl = async () =>
      ok({
        accessToken: "fief_at",
        claims: { sub: FIEF_USER_UUID, email: "alice@example.com", first_name: "Alice" },
      });

    wireDeps(h);

    const { POST } = await import("./route");

    const res = await POST(buildSignedRequest({ body: buildValidBody(), channelSlug: "default" }));

    expect(res.status).toBe(200);

    /*
     * Public metadata write MUST carry the origin marker for the loop guard
     * (T13). Without this the Saleor→Fief mirror would echo back via T26
     * and create an infinite loop. This is the canary test from the plan.
     */
    expect(h.saleorClient.metadataUpdateCalls).toHaveLength(1);
    const metadataMap = Object.fromEntries(
      h.saleorClient.metadataUpdateCalls[0].items.map((i) => [i.key, i.value]),
    );

    expect(metadataMap[FIEF_SYNC_ORIGIN_KEY]).toBe("fief");

    // Private metadata write MUST carry the seq marker.
    const privateMap = Object.fromEntries(
      h.saleorClient.privateMetadataUpdateCalls[0].items.map((i) => [i.key, i.value]),
    );

    expect(privateMap[FIEF_SYNC_SEQ_KEY]).toBeDefined();
    expect(Number.parseInt(privateMap[FIEF_SYNC_SEQ_KEY], 10)).toBeGreaterThanOrEqual(0);
  });

  // -- Bad HMAC ---------------------------------------------------------------

  it("returns 401 on bad HMAC signature", async () => {
    const h = buildHarness();

    wireDeps(h);

    const { POST } = await import("./route");

    const res = await POST(buildSignedRequest({ body: buildValidBody(), secret: "wrong-secret" }));

    expect(res.status).toBe(401);
    expect(h.fiefOidcClient.exchangeCallCount).toBe(0);
    expect(h.saleorClient.customerCreateCalls).toHaveLength(0);
  });

  // -- Bad branding_origin ----------------------------------------------------

  it("returns 400 when branding_origin token fails T15 verification", async () => {
    const h = buildHarness();

    wireDeps(h);

    const { POST } = await import("./route");

    const body = buildValidBody({
      brandingOrigin: signBrandingOrigin(ALLOWED_ORIGIN, "WRONG_SIGNING_KEY"),
    });

    const res = await POST(buildSignedRequest({ body, channelSlug: "default" }));

    expect(res.status).toBe(400);
    expect(h.fiefOidcClient.exchangeCallCount).toBe(0);
    expect(h.saleorClient.customerCreateCalls).toHaveLength(0);
  });

  it("returns 400 when branding_origin's parsed origin is not in allowedOrigins", async () => {
    const h = buildHarness();

    wireDeps(h);

    const { POST } = await import("./route");

    const body = buildValidBody({
      origin: "https://attacker.example.com",
      brandingOrigin: signBrandingOrigin("https://attacker.example.com", SIGNING_KEY),
    });

    const res = await POST(buildSignedRequest({ body, channelSlug: "default" }));

    expect(res.status).toBe(400);
  });

  // -- Fief code-exchange failure --------------------------------------------

  it("returns 502 when Fief exchangeCode returns Err (upstream error)", async () => {
    const h = buildHarness();

    h.fiefOidcClient.exchangeImpl = async () => err(new Error("invalid_grant"));

    wireDeps(h);

    const { POST } = await import("./route");

    const res = await POST(buildSignedRequest({ body: buildValidBody(), channelSlug: "default" }));

    expect(res.status).toBe(502);
    expect(h.saleorClient.customerCreateCalls).toHaveLength(0);
    expect(h.identityMapRepo.upsertCallCount).toBe(0);
  });

  it("dual-secret rotation: passes [current, pending] secrets to exchangeCode", async () => {
    const h = buildHarness({ pendingClientSecret: "client-secret-pending" });

    h.fiefOidcClient.exchangeImpl = async () =>
      ok({
        accessToken: "fief_at",
        claims: { sub: FIEF_USER_UUID, email: "alice@example.com", first_name: "Alice" },
      });

    wireDeps(h);

    const { POST } = await import("./route");

    const res = await POST(buildSignedRequest({ body: buildValidBody(), channelSlug: "default" }));

    expect(res.status).toBe(200);
    expect(h.fiefOidcClient.lastExchangeInput?.clientSecrets).toStrictEqual([
      "client-secret-current",
      "client-secret-pending",
    ]);
  });
});
