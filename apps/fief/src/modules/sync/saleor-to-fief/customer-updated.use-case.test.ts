/*
 * @vitest-environment node
 *
 * T27 — Saleor → Fief CUSTOMER_UPDATED use case tests.
 *
 * Drives the worker-side handler (`customerUpdatedUseCase.execute(...)`) called
 * by the queue worker after the route enqueues a job. Mirrors T26's coverage
 * map but exercises the PATCH path (Fief user must already exist for an update
 * — discovered via identity_map first; if absent, fall back to email lookup).
 *
 * Coverage map:
 *   - happy path: identity_map hit → patches Fief user via T5's `updateUser`
 *     with allowed fields (email/email_verified/fields), bumps identity_map seq.
 *   - identity_map miss + email match: looks up Fief user by email
 *     (`iterateUsers`), patches the matched user, binds identity_map.
 *   - identity_map miss + email miss: returns `noFiefUser` outcome (no
 *     create — T26 owns provisioning; T27 only updates existing rows).
 *   - loop-prevention: payload carries `metadata.fief_sync_origin === "fief"`
 *     → use case returns `skipped` outcome; no Fief I/O.
 *   - kill switch: `isSaleorToFiefDisabled() === true` → returns `skipped`
 *     without any I/O.
 *   - missing channel-config → `noConnection`.
 *   - default-connection fallback path is implicit in happy-path (no slug).
 *   - disabled defaultConnectionId → `noConnection`.
 *   - getDecryptedSecrets failure → Err (queue retries).
 *   - updateUser failure → Err (queue retries).
 *   - identity_map upsert failure → Err (queue retries).
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
  type CustomerUpdatedJobPayload,
  CustomerUpdatedUseCase,
} from "./customer-updated.use-case";

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
const FIEF_USER_ID_BOUND = "44444444-4444-4444-8444-444444444444";
const FIEF_USER_ID_BY_EMAIL = "55555555-5555-4555-8555-555555555555";

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
  overrides: Partial<CustomerUpdatedJobPayload> = {},
): CustomerUpdatedJobPayload => ({
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
  id: FIEF_USER_ID_BOUND,
  created_at: "2026-05-09T00:00:00.000Z",
  updated_at: "2026-05-09T00:00:00.000Z",
  email: "alice@example.com",
  email_verified: true,
  is_active: true,
  tenant_id: FIEF_TENANT_ID,
  fields: {},
  ...overrides,
});

const buildIdentityMapRow = (overrides: Record<string, unknown> = {}) => ({
  saleorApiUrl: SALEOR_API_URL,
  saleorUserId: "VXNlcjox",
  fiefUserId: FIEF_USER_ID_BOUND,
  lastSyncSeq: 3,
  lastSyncedAt: new Date("2026-05-09T00:00:00.000Z"),
  ...overrides,
});

const buildDeps = (
  overrides: Partial<{
    listChannelConfig: () => unknown;
    getProviderConnection: () => unknown;
    getDecryptedSecrets: () => unknown;
    iterateUsersResults: ReadonlyArray<ReturnType<typeof buildFiefUser>>;
    updateUserResult: unknown;
    upsertIdentityMapResult: unknown;
    getBySaleorUserResult: unknown;
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
    updateUser: vi.fn(
      overrides.updateUserResult !== undefined
        ? () => Promise.resolve(overrides.updateUserResult)
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
                row: buildIdentityMapRow({ lastSyncSeq: 4 }),
                wasInserted: false,
              }),
            ),
    ),
    getBySaleorUser: vi.fn(
      overrides.getBySaleorUserResult !== undefined
        ? () => Promise.resolve(overrides.getBySaleorUserResult)
        : () => Promise.resolve(ok(buildIdentityMapRow())),
    ),
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

describe("CustomerUpdatedUseCase — T27", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("happy path: identity_map hit → patches Fief user, bumps seq", async () => {
    const deps = buildDeps();
    const useCase = new CustomerUpdatedUseCase(deps as never);

    const result = await useCase.execute(buildPayload());

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({ outcome: "synced", patched: true });

    expect(deps.identityMapRepo.getBySaleorUser).toHaveBeenCalledTimes(1);
    /*
     * iterateUsers is the email-lookup fallback — when identity_map already
     * has the binding we should patch directly without the extra Fief
     * round-trip.
     */
    expect(deps.fiefAdmin.iterateUsers).not.toHaveBeenCalled();
    expect(deps.fiefAdmin.updateUser).toHaveBeenCalledTimes(1);
    expect(deps.identityMapRepo.upsert).toHaveBeenCalledTimes(1);

    const updateArgs = (deps.fiefAdmin.updateUser.mock.calls as unknown as unknown[][])[0] as [
      string,
      string,
      { email?: string; email_verified?: boolean; fields?: Record<string, unknown> },
    ];

    expect(updateArgs[1]).toBe(FIEF_USER_ID_BOUND);
    expect(updateArgs[2]).toMatchObject({
      email: "alice@example.com",
      email_verified: true,
      fields: { first_name: "Alice", last_name: "Example" },
    });

    const upsertArgs = (
      deps.identityMapRepo.upsert.mock.calls as unknown as unknown[][]
    )[0]?.[0] as { saleorUserId: string; fiefUserId: string; syncSeq: number };

    expect(upsertArgs.saleorUserId).toBe("VXNlcjox");
    expect(upsertArgs.fiefUserId).toBe(FIEF_USER_ID_BOUND);
    /*
     * Existing row had lastSyncSeq=3; this update should monotonically bump
     * to 4. The repo's no-regression guard makes the actual stored value safe
     * even under out-of-order delivery, but the use case still computes the
     * next seq.
     */
    expect(upsertArgs.syncSeq).toBe(4);
  });

  it("identity_map miss + email match: patches matched Fief user and binds identity_map", async () => {
    const matched = buildFiefUser({ id: FIEF_USER_ID_BY_EMAIL });
    const deps = buildDeps({
      getBySaleorUserResult: ok(null),
      iterateUsersResults: [matched],
    });
    const useCase = new CustomerUpdatedUseCase(deps as never);

    const result = await useCase.execute(buildPayload());

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({ outcome: "synced", patched: true });

    expect(deps.fiefAdmin.iterateUsers).toHaveBeenCalledTimes(1);
    expect(deps.fiefAdmin.updateUser).toHaveBeenCalledTimes(1);

    const updateArgs = (deps.fiefAdmin.updateUser.mock.calls as unknown as unknown[][])[0] as [
      string,
      string,
      unknown,
    ];

    expect(updateArgs[1]).toBe(FIEF_USER_ID_BY_EMAIL);

    /*
     * First-time bind: seq=1 (no prior identity_map row).
     */
    const upsertArgs = (
      deps.identityMapRepo.upsert.mock.calls as unknown as unknown[][]
    )[0]?.[0] as { fiefUserId: string; syncSeq: number };

    expect(upsertArgs.fiefUserId).toBe(FIEF_USER_ID_BY_EMAIL);
    expect(upsertArgs.syncSeq).toBe(1);
  });

  it("identity_map miss + email miss: returns noFiefUser, no patch, no bind", async () => {
    const deps = buildDeps({
      getBySaleorUserResult: ok(null),
      iterateUsersResults: [],
    });
    const useCase = new CustomerUpdatedUseCase(deps as never);

    const result = await useCase.execute(buildPayload());

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({ outcome: "noFiefUser" });

    expect(deps.fiefAdmin.updateUser).not.toHaveBeenCalled();
    expect(deps.identityMapRepo.upsert).not.toHaveBeenCalled();
  });

  it("loop-prevention: payload with metadata.fief_sync_origin='fief' → skipped, no Fief I/O", async () => {
    const deps = buildDeps();
    const useCase = new CustomerUpdatedUseCase(deps as never);

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

    expect(deps.identityMapRepo.getBySaleorUser).not.toHaveBeenCalled();
    expect(deps.fiefAdmin.iterateUsers).not.toHaveBeenCalled();
    expect(deps.fiefAdmin.updateUser).not.toHaveBeenCalled();
    expect(deps.identityMapRepo.upsert).not.toHaveBeenCalled();
  });

  it("kill switch: isSaleorToFiefDisabled() === true → skipped without I/O", async () => {
    const deps = buildDeps({ isKillSwitched: true });
    const useCase = new CustomerUpdatedUseCase(deps as never);

    const result = await useCase.execute(buildPayload());

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({ outcome: "skipped", reason: "kill-switch" });

    expect(deps.channelConfigurationRepo.get).not.toHaveBeenCalled();
    expect(deps.fiefAdmin.iterateUsers).not.toHaveBeenCalled();
    expect(deps.fiefAdmin.updateUser).not.toHaveBeenCalled();
  });

  it("missing channel-config: returns noConnection without error", async () => {
    const deps = buildDeps({ listChannelConfig: () => Promise.resolve(ok(null)) });
    const useCase = new CustomerUpdatedUseCase(deps as never);

    const result = await useCase.execute(buildPayload());

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({ outcome: "noConnection" });

    expect(deps.fiefAdmin.iterateUsers).not.toHaveBeenCalled();
    expect(deps.fiefAdmin.updateUser).not.toHaveBeenCalled();
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
    const useCase = new CustomerUpdatedUseCase(deps as never);

    const result = await useCase.execute(buildPayload());

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({ outcome: "noConnection" });
  });

  it("getDecryptedSecrets failure → Err (queue retries)", async () => {
    const RepoError = class extends Error {};
    const deps = buildDeps({
      getDecryptedSecrets: () => Promise.resolve(err(new RepoError("decrypt failed"))),
    });
    const useCase = new CustomerUpdatedUseCase(deps as never);

    const result = await useCase.execute(buildPayload());

    expect(result.isErr()).toBe(true);
  });

  it("updateUser failure → Err (queue retries)", async () => {
    const ApiError = class extends Error {};
    const deps = buildDeps({
      updateUserResult: err(new ApiError("Fief 500")),
    });
    const useCase = new CustomerUpdatedUseCase(deps as never);

    const result = await useCase.execute(buildPayload());

    expect(result.isErr()).toBe(true);
    expect(deps.fiefAdmin.updateUser).toHaveBeenCalledTimes(1);
    expect(deps.identityMapRepo.upsert).not.toHaveBeenCalled();
  });

  it("identity_map upsert failure → Err (queue retries)", async () => {
    const RepoError = class extends Error {};
    const deps = buildDeps({
      upsertIdentityMapResult: err(new RepoError("mongo down")),
    });
    const useCase = new CustomerUpdatedUseCase(deps as never);

    const result = await useCase.execute(buildPayload());

    expect(result.isErr()).toBe(true);
  });
});
