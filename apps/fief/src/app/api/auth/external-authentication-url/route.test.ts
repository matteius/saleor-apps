/*
 * @vitest-environment node
 *
 * T18 — `POST /api/auth/external-authentication-url` route handler test (Path A).
 *
 * The route is the apps/fief side of the Saleor `BasePlugin`'s
 * `external_authentication_url(...)` call (T56/T57). It:
 *
 *   1. Verifies HMAC via T58 (`verifyPluginRequest`) using the install-level
 *      shared secret (`FIEF_PLUGIN_HMAC_SECRET` from env).
 *   2. Resolves the channel-scope via T12's `ChannelResolver`.
 *   3. Builds an OIDC `/authorize` URL on the connection's Fief base URL,
 *      with a signed `branding_origin` query param produced by T15.
 *   4. Returns `{ authorizationUrl }`.
 *
 * These tests exercise the full pipeline end-to-end with in-memory fakes
 * for every IO boundary (no Mongo, no real Fief). The verifier and signer
 * are NOT mocked — we want the wire format locked in by these tests, not
 * just by the verifier/signer module tests in isolation.
 *
 * The `branding_origin` allowlist check lives in T15's `verify()`. Per the
 * route's documented behavior we surface a structurally-bad allowlist as
 * a **400 Bad Request** (origin-not-allowed is a *client* error — the
 * Saleor plugin gave us an origin we don't trust — and 400 is the more
 * accurate signal than 403, which we reserve for "the operator opted this
 * channel out of Fief auth"). Choice documented here so the contract is
 * explicit.
 */

import * as crypto from "node:crypto";

import { err, ok, type Result } from "neverthrow";
import { type NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real implementations — we want the wire format pinned by the test.
import { verify as verifyBrandingOrigin } from "@/modules/branding/origin-signer";
import {
  type ChannelConfiguration,
  createChannelSlug,
  createConnectionId,
  DISABLED_CHANNEL,
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

const SALEOR_API_URL: SaleorApiUrl = createSaleorApiUrl(
  "https://shop-1.saleor.cloud/graphql/",
)._unsafeUnwrap();

const PLUGIN_SECRET = "test_plugin_hmac_secret";
const SIGNING_KEY = "branding-signing-key-test";
const FIEF_BASE_URL = "https://tenant.fief.dev";
const ALLOWED_ORIGIN = "https://shop-1.example.com";

const CONNECTION_ID = createProviderConnectionId("33333333-3333-4333-8333-333333333333");

// -- HMAC sign helper (mirrors T58's wire spec) --------------------------------

const sha256Hex = (bytes: Uint8Array): string =>
  crypto.createHash("sha256").update(bytes).digest("hex");

const hmacHex = (secret: string, message: string): string =>
  crypto
    .createHmac("sha256", Buffer.from(secret, "utf-8"))
    .update(Buffer.from(message, "utf-8"))
    .digest("hex");

interface SignedRequestParts {
  method: string;
  pathname: string;
  body: string;
  timestamp: number;
  signature: string;
}

interface SignRequestArgs {
  pathname: string;
  body: string;
  secret: string;
  timestamp?: number;
}

const signRequest = (args: SignRequestArgs): SignedRequestParts => {
  const timestamp = args.timestamp ?? Math.floor(Date.now() / 1000);
  const bodyHex = sha256Hex(new TextEncoder().encode(args.body));
  const message = `POST\n${args.pathname}\n${timestamp}\n${bodyHex}`;

  return {
    method: "POST",
    pathname: args.pathname,
    body: args.body,
    timestamp,
    signature: hmacHex(args.secret, message),
  };
};

const ROUTE_PATHNAME = "/api/auth/external-authentication-url";
const ROUTE_URL = `https://app.test${ROUTE_PATHNAME}`;

const buildSignedRequest = (
  body: unknown,
  opts: {
    secret?: string;
    timestamp?: number;
    saleorApiUrl?: string;
    channelSlug?: string;
    overrideSignature?: string;
  } = {},
): NextRequest => {
  const bodyStr = JSON.stringify(body);
  const signed = signRequest({
    pathname: ROUTE_PATHNAME,
    body: bodyStr,
    secret: opts.secret ?? PLUGIN_SECRET,
    timestamp: opts.timestamp,
  });

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "X-Fief-Plugin-Timestamp": String(signed.timestamp),
    "X-Fief-Plugin-Signature": opts.overrideSignature ?? signed.signature,
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

// -- Connection + repo fakes ---------------------------------------------------

const buildConnection = (
  overrides: Partial<{ allowedOrigins: string[]; clientId: string; baseUrl: string }> = {},
): ProviderConnection =>
  ({
    id: CONNECTION_ID,
    saleorApiUrl: SALEOR_API_URL,
    name: "test-conn" as ProviderConnection["name"],
    fief: {
      baseUrl: (overrides.baseUrl ?? FIEF_BASE_URL) as ProviderConnection["fief"]["baseUrl"],
      tenantId: "tenant" as ProviderConnection["fief"]["tenantId"],
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
    claimMapping: [],
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
  /**
   * Plaintext secrets returned by `getDecryptedSecrets`. Mirrors the
   * production repo's behavior of decrypting the persisted ciphertext.
   */
  public plaintextSigningKeyById = new Map<string, string>();

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
        clientSecret: "client-secret-plain",
        pendingClientSecret: null,
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

// -- Test harness --------------------------------------------------------------

interface TestHarness {
  channelConfigRepo: FakeChannelConfigurationRepo;
  connectionRepo: FakeProviderConnectionRepo;
  channelResolver: ChannelResolver;
}

const buildHarness = (
  opts: {
    /** Wire a connection bound to (saleorApiUrl, default) by default. */
    connection?: ProviderConnection;
    channelConfig?: ChannelConfiguration | null;
    /** Per-connection plaintext signing key override. */
    signingKey?: string;
  } = {},
): TestHarness => {
  const channelConfigRepo = new FakeChannelConfigurationRepo();
  const connectionRepo = new FakeProviderConnectionRepo();

  const conn = opts.connection ?? buildConnection();

  connectionRepo.connectionsById.set(conn.id as unknown as string, conn);
  connectionRepo.plaintextSigningKeyById.set(
    conn.id as unknown as string,
    opts.signingKey ?? SIGNING_KEY,
  );

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

  return { channelConfigRepo, connectionRepo, channelResolver };
};

// -- Mocks ---------------------------------------------------------------------

vi.mock("@/lib/env", () => ({
  env: {
    SECRET_KEY: "x".repeat(64),
    APP_LOG_LEVEL: "info",
    FIEF_SYNC_DISABLED: false,
    FIEF_SALEOR_TO_FIEF_DISABLED: false,
    FIEF_PLUGIN_HMAC_SECRET: PLUGIN_SECRET,
  },
}));

const { buildResolverMock } = vi.hoisted(() => ({
  buildResolverMock: vi.fn(),
}));

vi.mock("./build-deps", () => ({
  buildDeps: buildResolverMock,
}));

// -- Tests ---------------------------------------------------------------------

describe("POST /api/auth/external-authentication-url — T18", () => {
  beforeEach(() => {
    buildResolverMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns a Fief authorize URL with all required OIDC params + a signed branding_origin", async () => {
    const harness = buildHarness();

    buildResolverMock.mockReturnValue({
      channelResolver: harness.channelResolver,
      connectionRepo: harness.connectionRepo,
    });

    const { POST } = await import("./route");

    const req = buildSignedRequest(
      { redirectUri: "https://shop-1.example.com/callback" },
      { channelSlug: "default" },
    );

    const res = await POST(req);

    expect(res.status).toBe(200);

    const json = (await res.json()) as { authorizationUrl: string };

    expect(typeof json.authorizationUrl).toBe("string");

    const url = new URL(json.authorizationUrl);

    // Authorize endpoint is on the Fief base URL.
    expect(url.origin).toBe(new URL(FIEF_BASE_URL).origin);
    expect(url.pathname).toBe("/authorize");

    // Required OIDC params.
    expect(url.searchParams.get("client_id")).toBe("fief-client-abc");
    expect(url.searchParams.get("redirect_uri")).toBe("https://shop-1.example.com/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    // State is now an HMAC-signed token: payload_b64.signature_hex
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/u);

    // Signed branding_origin verifies via T15 against the per-connection key.
    const brandingOrigin = url.searchParams.get("branding_origin");

    expect(brandingOrigin).toBeTruthy();

    const verifyResult = verifyBrandingOrigin(brandingOrigin!, SIGNING_KEY, [ALLOWED_ORIGIN]);

    expect(verifyResult.isOk()).toBe(true);
    expect(verifyResult._unsafeUnwrap().origin).toBe(ALLOWED_ORIGIN);
  });

  it("returns 401 on bad HMAC signature", async () => {
    const harness = buildHarness();

    buildResolverMock.mockReturnValue({
      channelResolver: harness.channelResolver,
      connectionRepo: harness.connectionRepo,
    });

    const { POST } = await import("./route");

    const req = buildSignedRequest(
      { redirectUri: "https://shop-1.example.com/cb" },
      { secret: "wrong-secret", channelSlug: "default" },
    );

    const res = await POST(req);

    expect(res.status).toBe(401);
  });

  it("returns 403 when the channel-resolver reports DISABLED", async () => {
    const harness = buildHarness({
      channelConfig: {
        saleorApiUrl: SALEOR_API_URL,
        defaultConnectionId: createConnectionId(CONNECTION_ID as unknown as string),
        overrides: [
          {
            channelSlug: createChannelSlug("opted-out"),
            connectionId: DISABLED_CHANNEL,
          },
        ],
      },
    });

    buildResolverMock.mockReturnValue({
      channelResolver: harness.channelResolver,
      connectionRepo: harness.connectionRepo,
    });

    const { POST } = await import("./route");

    const req = buildSignedRequest(
      { redirectUri: "https://shop-1.example.com/cb" },
      { channelSlug: "opted-out" },
    );

    const res = await POST(req);

    expect(res.status).toBe(403);
  });

  it("returns 404 when no connection is bound to the channel/install", async () => {
    /*
     * No channel config at all for this saleorApiUrl => resolver returns
     * `null` => 404.
     */
    const harness = buildHarness({ channelConfig: null });

    buildResolverMock.mockReturnValue({
      channelResolver: harness.channelResolver,
      connectionRepo: harness.connectionRepo,
    });

    const { POST } = await import("./route");

    const req = buildSignedRequest(
      { redirectUri: "https://shop-1.example.com/cb" },
      { channelSlug: "default" },
    );

    const res = await POST(req);

    expect(res.status).toBe(404);
  });

  it("returns 400 when the redirectUri's origin is not in the connection's allowedOrigins", async () => {
    /*
     * Choice (documented in route + plan): a request whose `redirectUri`
     * resolves to an origin not in the per-connection allowlist is a
     * *client* mistake (the Saleor plugin gave us a redirect URI we don't
     * trust), so 400 — distinct from 403 which we reserve for "operator
     * opted this channel out of Fief auth".
     */
    const harness = buildHarness();

    buildResolverMock.mockReturnValue({
      channelResolver: harness.channelResolver,
      connectionRepo: harness.connectionRepo,
    });

    const { POST } = await import("./route");

    const req = buildSignedRequest(
      { redirectUri: "https://attacker.example.com/cb" },
      { channelSlug: "default" },
    );

    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it("returns 400 when the body is missing required fields", async () => {
    const harness = buildHarness();

    buildResolverMock.mockReturnValue({
      channelResolver: harness.channelResolver,
      connectionRepo: harness.connectionRepo,
    });

    const { POST } = await import("./route");

    // Missing `redirectUri`.
    const req = buildSignedRequest({}, { channelSlug: "default" });

    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it("returns 400 when the channelSlug header is missing", async () => {
    const harness = buildHarness();

    buildResolverMock.mockReturnValue({
      channelResolver: harness.channelResolver,
      connectionRepo: harness.connectionRepo,
    });

    const { POST } = await import("./route");

    // No channelSlug in opts ⇒ no X-Fief-Plugin-Channel header sent.
    const req = buildSignedRequest({ redirectUri: "https://shop-1.example.com/cb" });

    const res = await POST(req);

    expect(res.status).toBe(400);
  });
});
