/*
 * @vitest-environment node
 *
 * T26 — Saleor → Fief CUSTOMER_CREATED use case tests.
 *
 * Drives the worker-side handler (`customerCreatedUseCase.execute(...)`)
 * called by the queue worker after T26's webhook route enqueues a job.
 *
 * Coverage map (per the plan):
 *   - happy path: new customer email, no Fief match → creates Fief user via
 *     T5's `createUser`, binds identity_map via T10's `upsert`.
 *   - email-collision: incoming email matches an existing Fief user
 *     (`iterateUsers` yields a hit) → bind identity_map only; no `createUser`.
 *   - loop-prevention: payload carries `metadata.fief_sync_origin === "fief"`
 *     → use case returns `skipped` outcome and performs no Fief I/O.
 *     (The route already filters this case to avoid enqueueing — the use case
 *     re-checks defensively because the queue may carry pre-loop-guard rows
 *     after a deploy bump.)
 *   - kill switch: `isSaleorToFiefDisabled() === true` → returns `skipped`
 *     without any I/O.
 *   - missing config: no channel-configuration row for `saleorApiUrl` →
 *     returns `noConnection` (use case doesn't error; operator hasn't wired
 *     the install yet).
 *   - default-connection fallback: config exists with no override matching
 *     the (absent) channel slug + non-null `defaultConnectionId` → loads
 *     that connection.
 *   - disabled-default: config exists but `defaultConnectionId === null` →
 *     returns `noConnection`.
 *   - getDecryptedSecrets failure → returns `Err` (transient; queue retries).
 *   - createUser failure → returns `Err` (transient; queue retries).
 *   - identity_map upsert failure → returns `Err` (transient; queue retries).
 */

import { err, ok } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ChannelConfiguration,
  createConnectionId,
} from "@/modules/channel-configuration/channel-configuration";
import {
  createProviderConnectionId,
  type ProviderConnection,
} from "@/modules/provider-connections/provider-connection";
import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import {
  type CustomerCreatedJobPayload,
  CustomerCreatedUseCase,
} from "./customer-created.use-case";

vi.mock("@/lib/env", () => ({
  env: {
    SECRET_KEY: "x".repeat(64),
    APP_LOG_LEVEL: "info",
    FIEF_SYNC_DISABLED: false,
    FIEF_SALEOR_TO_FIEF_DISABLED: false,
  },
}));

const SALEOR_API_URL = createSaleorApiUrl("https://shop.example.com/graphql/")._unsafeUnwrap();
const CONNECTION_ID = createConnectionId("11111111-1111-1111-1111-111111111111");
const PROVIDER_CONNECTION_ID = createProviderConnectionId("11111111-1111-1111-1111-111111111111");

const FIEF_TENANT_ID = "22222222-2222-4222-8222-222222222222";
const FIEF_CLIENT_ID = "33333333-3333-4333-8333-333333333333";

const buildProviderConnection = (): ProviderConnection => ({
  id: PROVIDER_CONNECTION_ID,
  saleorApiUrl: SALEOR_API_URL,
  name: "Test connection" as ProviderConnection["name"],
  fief: {
    baseUrl: "https://fief.example.com" as ProviderConnection["fief"]["baseUrl"],
    tenantId: FIEF_TENANT_ID as ProviderConnection["fief"]["tenantId"],
    clientId: FIEF_CLIENT_ID as ProviderConnection["fief"]["clientId"],
    webhookId: null,
    encryptedClientSecret: "ct:client" as ProviderConnection["fief"]["encryptedClientSecret"],
    encryptedPendingClientSecret: null,
    encryptedAdminToken: "ct:admin" as ProviderConnection["fief"]["encryptedAdminToken"],
    encryptedWebhookSecret: "ct:webhook" as ProviderConnection["fief"]["encryptedWebhookSecret"],
    encryptedPendingWebhookSecret: null,
  },
  branding: {
    encryptedSigningKey: "ct:signing" as ProviderConnection["branding"]["encryptedSigningKey"],
    allowedOrigins: [],
  },
  claimMapping: [],
  softDeletedAt: null,
});

const buildConfig = (): ChannelConfiguration => ({
  saleorApiUrl: SALEOR_API_URL,
  defaultConnectionId: CONNECTION_ID,
  overrides: [],
});

const buildPayload = (
  overrides: Partial<CustomerCreatedJobPayload> = {},
): CustomerCreatedJobPayload => ({
  saleorApiUrl: SALEOR_API_URL,
  user: {
    id: "VXNlcjox",
    email: "alice@example.com",
    firstName: "Alice",
    lastName: "Example",
    isActive: true,
    isConfirmed: true,
    languageCode: "EN_US",
    metadata: [],
    privateMetadata: [],
  },
  channelSlug: null,
  ...overrides,
});

const buildFiefUser = (overrides: Record<string, unknown> = {}) => ({
  id: "44444444-4444-4444-8444-444444444444",
  created_at: "2026-05-09T00:00:00.000Z",
  updated_at: "2026-05-09T00:00:00.000Z",
  email: "alice@example.com",
  email_verified: true,
  is_active: true,
  tenant_id: FIEF_TENANT_ID,
  fields: {},
  ...overrides,
});

const buildDeps = (
  overrides: Partial<{
    listChannelConfig: () => unknown;
    getProviderConnection: () => unknown;
    getDecryptedSecrets: () => unknown;
    iterateUsersResults: ReadonlyArray<ReturnType<typeof buildFiefUser>>;
    createUserResult: unknown;
    upsertIdentityMapResult: unknown;
    isKillSwitched: boolean;
  }> = {},
) => {
  const channelConfigurationRepo = {
    get: vi.fn(overrides.listChannelConfig ?? (() => Promise.resolve(ok(buildConfig())))),
    upsert: vi.fn(),
  };
  const providerConnectionRepo = {
    get: vi.fn(
      overrides.getProviderConnection ?? (() => Promise.resolve(ok(buildProviderConnection()))),
    ),
    getDecryptedSecrets: vi.fn(
      overrides.getDecryptedSecrets ??
        (() =>
          Promise.resolve(
            ok({
              fief: {
                clientSecret: "secret",
                pendingClientSecret: null,
                adminToken: "admin-token",
                webhookSecret: "wh-secret",
                pendingWebhookSecret: null,
              },
              branding: { signingKey: "signing" },
            }),
          )),
    ),
    create: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
    restore: vi.fn(),
  };

  const fiefUsers = overrides.iterateUsersResults ?? [];
  const fiefAdmin = {
    iterateUsers: vi.fn(async function* () {
      for (const u of fiefUsers) yield u;
    }),
    createUser: vi.fn(
      overrides.createUserResult !== undefined
        ? () => Promise.resolve(overrides.createUserResult)
        : () => Promise.resolve(ok(buildFiefUser())),
    ),
  };

  const identityMapRepo = {
    upsert: vi.fn(
      overrides.upsertIdentityMapResult !== undefined
        ? () => Promise.resolve(overrides.upsertIdentityMapResult)
        : () =>
            Promise.resolve(
              ok({
                row: {
                  saleorApiUrl: SALEOR_API_URL,
                  saleorUserId: "VXNlcjox",
                  fiefUserId: "44444444-4444-4444-8444-444444444444",
                  lastSyncSeq: 1,
                  lastSyncedAt: new Date(),
                },
                wasInserted: true,
              }),
            ),
    ),
    getBySaleorUser: vi.fn(),
    getByFiefUser: vi.fn(),
    delete: vi.fn(),
  };

  return {
    channelConfigurationRepo,
    providerConnectionRepo,
    fiefAdmin,
    identityMapRepo,
    isSaleorToFiefDisabled: () => overrides.isKillSwitched ?? false,
  };
};

describe("CustomerCreatedUseCase — T26", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("happy path: creates Fief user when no email match, then binds identity_map", async () => {
    const deps = buildDeps();
    const useCase = new CustomerCreatedUseCase(deps as never);

    const result = await useCase.execute(buildPayload());

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({ outcome: "synced", createdFiefUser: true });

    expect(deps.fiefAdmin.iterateUsers).toHaveBeenCalledTimes(1);
    expect(deps.fiefAdmin.createUser).toHaveBeenCalledTimes(1);
    expect(deps.identityMapRepo.upsert).toHaveBeenCalledTimes(1);

    const upsertArgs = (
      deps.identityMapRepo.upsert.mock.calls as unknown as unknown[][]
    )[0]?.[0] as {
      saleorApiUrl: string;
      saleorUserId: string;
      fiefUserId: string;
    };

    expect(upsertArgs.saleorUserId).toBe("VXNlcjox");
    expect(upsertArgs.fiefUserId).toBe("44444444-4444-4444-8444-444444444444");
  });

  it("email-collision: existing Fief user found by email → binds identity_map and skips createUser", async () => {
    const existing = buildFiefUser({ id: "55555555-5555-4555-8555-555555555555" });
    const deps = buildDeps({ iterateUsersResults: [existing] });
    const useCase = new CustomerCreatedUseCase(deps as never);

    const result = await useCase.execute(buildPayload());

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({ outcome: "synced", createdFiefUser: false });

    expect(deps.fiefAdmin.createUser).not.toHaveBeenCalled();
    expect(deps.identityMapRepo.upsert).toHaveBeenCalledTimes(1);

    const upsertArgs = (
      deps.identityMapRepo.upsert.mock.calls as unknown as unknown[][]
    )[0]?.[0] as {
      fiefUserId: string;
    };

    expect(upsertArgs.fiefUserId).toBe("55555555-5555-4555-8555-555555555555");
  });

  it("loop-prevention: payload with metadata.fief_sync_origin='fief' → skipped, no Fief I/O", async () => {
    const deps = buildDeps();
    const useCase = new CustomerCreatedUseCase(deps as never);

    const result = await useCase.execute(
      buildPayload({
        user: {
          ...buildPayload().user,
          metadata: [{ key: "fief_sync_origin", value: "fief" }],
        },
      }),
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({ outcome: "skipped", reason: "origin-fief" });

    expect(deps.fiefAdmin.iterateUsers).not.toHaveBeenCalled();
    expect(deps.fiefAdmin.createUser).not.toHaveBeenCalled();
    expect(deps.identityMapRepo.upsert).not.toHaveBeenCalled();
  });

  it("kill switch: isSaleorToFiefDisabled() === true → skipped without I/O", async () => {
    const deps = buildDeps({ isKillSwitched: true });
    const useCase = new CustomerCreatedUseCase(deps as never);

    const result = await useCase.execute(buildPayload());

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({ outcome: "skipped", reason: "kill-switch" });

    expect(deps.channelConfigurationRepo.get).not.toHaveBeenCalled();
    expect(deps.fiefAdmin.iterateUsers).not.toHaveBeenCalled();
    expect(deps.fiefAdmin.createUser).not.toHaveBeenCalled();
  });

  it("missing channel-config: returns noConnection without error", async () => {
    const deps = buildDeps({ listChannelConfig: () => Promise.resolve(ok(null)) });
    const useCase = new CustomerCreatedUseCase(deps as never);

    const result = await useCase.execute(buildPayload());

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({ outcome: "noConnection" });

    expect(deps.fiefAdmin.iterateUsers).not.toHaveBeenCalled();
    expect(deps.fiefAdmin.createUser).not.toHaveBeenCalled();
  });

  it("config has null defaultConnectionId + no slug match → noConnection", async () => {
    const deps = buildDeps({
      listChannelConfig: () =>
        Promise.resolve(
          ok({
            saleorApiUrl: SALEOR_API_URL,
            defaultConnectionId: null,
            overrides: [],
          }),
        ),
    });
    const useCase = new CustomerCreatedUseCase(deps as never);

    const result = await useCase.execute(buildPayload());

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({ outcome: "noConnection" });
  });

  it("getDecryptedSecrets failure → Err (queue retries)", async () => {
    const RepoError = class extends Error {};
    const deps = buildDeps({
      getDecryptedSecrets: () => Promise.resolve(err(new RepoError("decrypt failed"))),
    });
    const useCase = new CustomerCreatedUseCase(deps as never);

    const result = await useCase.execute(buildPayload());

    expect(result.isErr()).toBe(true);
  });

  it("createUser failure → Err (queue retries)", async () => {
    const ApiError = class extends Error {};
    const deps = buildDeps({
      createUserResult: err(new ApiError("Fief 500")),
    });
    const useCase = new CustomerCreatedUseCase(deps as never);

    const result = await useCase.execute(buildPayload());

    expect(result.isErr()).toBe(true);
    expect(deps.fiefAdmin.createUser).toHaveBeenCalledTimes(1);
    expect(deps.identityMapRepo.upsert).not.toHaveBeenCalled();
  });

  it("identity_map upsert failure → Err (queue retries)", async () => {
    const RepoError = class extends Error {};
    const deps = buildDeps({
      upsertIdentityMapResult: err(new RepoError("mongo down")),
    });
    const useCase = new CustomerCreatedUseCase(deps as never);

    const result = await useCase.execute(buildPayload());

    expect(result.isErr()).toBe(true);
  });
});
