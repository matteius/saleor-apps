/*
 * @vitest-environment node
 *
 * T29 — Saleor → Fief CUSTOMER_DELETED use case tests.
 *
 * Drives the worker-side handler (`customerDeletedUseCase.execute(...)`) called
 * by the queue worker after the route enqueues a job. Mirrors T26/T27's
 * coverage map but exercises the **deactivate path**: per PRD §F2.5 we DO NOT
 * hard-delete the Fief user (preserves order history + audit trail), and the
 * identity_map row stays in place so that future reconciliation runs (T30/T32)
 * can detect the mismatch.
 *
 * Coverage map (per task brief):
 *   - happy path: identity_map hit → Fief user deactivated via T5's
 *     `updateUser({ is_active: false })`; identity_map row remains intact
 *     (no `delete` call on the repo).
 *   - identity_map miss: idempotent no-op — no Fief I/O, no error. Saleor may
 *     emit CUSTOMER_DELETED for a customer the operator never wired into Fief
 *     (e.g. wired the install AFTER the customer was created and before
 *     reconciliation backfilled the binding). Returns `noFiefUser` — same shape
 *     T27 uses for its email-miss path.
 *   - loop-prevention: payload carries `metadata.fief_sync_origin === "fief"`
 *     → use case returns `skipped`; no Fief I/O. (The CUSTOMER_DELETED echo
 *     case is somewhat theoretical — Fief's UserDeleted handler T24 deactivates
 *     Saleor not deletes — but T13 is a defense-in-depth invariant and we
 *     uphold it symmetrically across all four customer events.)
 *   - kill switch: `isSaleorToFiefDisabled() === true` → returns `skipped`
 *     without I/O.
 *   - missing channel-config → `noConnection`.
 *   - disabled defaultConnectionId → `noConnection`.
 *   - getDecryptedSecrets failure → Err (queue retries).
 *   - updateUser failure → Err (queue retries).
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
  type CustomerDeletedJobPayload,
  CustomerDeletedUseCase,
} from "./customer-deleted.use-case";

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
  overrides: Partial<CustomerDeletedJobPayload> = {},
): CustomerDeletedJobPayload => ({
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

const buildIdentityRow = () => ({
  saleorApiUrl: SALEOR_API_URL,
  saleorUserId: "VXNlcjox",
  fiefUserId: FIEF_USER_ID_BOUND,
  lastSyncSeq: 3,
  lastSyncedAt: new Date(),
});

const buildFiefUser = (overrides: Record<string, unknown> = {}) => ({
  id: FIEF_USER_ID_BOUND,
  created_at: "2026-05-09T00:00:00.000Z",
  updated_at: "2026-05-09T00:00:00.000Z",
  email: "alice@example.com",
  email_verified: true,
  is_active: false,
  tenant_id: FIEF_TENANT_ID,
  fields: {},
  ...overrides,
});

const buildDeps = (
  overrides: Partial<{
    listChannelConfig: () => unknown;
    getProviderConnection: () => unknown;
    getDecryptedSecrets: () => unknown;
    getBySaleorUserResult: unknown;
    updateUserResult: unknown;
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

  const fiefAdmin = {
    updateUser: vi.fn(
      overrides.updateUserResult !== undefined
        ? () => Promise.resolve(overrides.updateUserResult)
        : () => Promise.resolve(ok(buildFiefUser())),
    ),
  };

  const identityMapRepo = {
    getBySaleorUser: vi.fn(
      overrides.getBySaleorUserResult !== undefined
        ? () => Promise.resolve(overrides.getBySaleorUserResult)
        : () => Promise.resolve(ok(buildIdentityRow())),
    ),
    getByFiefUser: vi.fn(),
    upsert: vi.fn(),
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

describe("CustomerDeletedUseCase — T29", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("happy path: identity_map hit → deactivates Fief user via updateUser({ is_active: false }); identity_map remains untouched", async () => {
    const deps = buildDeps();
    const useCase = new CustomerDeletedUseCase(deps as never);

    const result = await useCase.execute(buildPayload());

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      outcome: "deactivated",
      fiefUserId: FIEF_USER_ID_BOUND,
    });

    expect(deps.identityMapRepo.getBySaleorUser).toHaveBeenCalledTimes(1);
    expect(deps.fiefAdmin.updateUser).toHaveBeenCalledTimes(1);

    const updateArgs = (deps.fiefAdmin.updateUser.mock.calls as unknown as unknown[][])[0] as [
      string,
      string,
      { is_active?: boolean },
    ];

    /*
     * Critical T29 contract: the Fief PATCH must carry `is_active: false`
     * (deactivate, not hard-delete). Hard delete is intentionally NOT exposed
     * via T5 — the audit trail matters more than the storage.
     */
    expect(updateArgs[1]).toBe(FIEF_USER_ID_BOUND);
    expect(updateArgs[2]).toMatchObject({ is_active: false });

    /*
     * The identity_map row MUST remain bound for audit per the brief's
     * "Leave identity_map intact" policy. We assert the absence of any
     * delete/upsert/seq-bump call.
     */
    expect(deps.identityMapRepo.delete).not.toHaveBeenCalled();
    expect(deps.identityMapRepo.upsert).not.toHaveBeenCalled();
  });

  it("identity_map miss: idempotent no-op — returns noFiefUser without Fief I/O", async () => {
    /*
     * Saleor delivered CUSTOMER_DELETED for a customer that was never wired
     * into Fief. This is operator-actionable but not an error: the queue
     * worker should not retry. Same outcome shape as T27's email-miss path.
     */
    const deps = buildDeps({ getBySaleorUserResult: ok(null) });
    const useCase = new CustomerDeletedUseCase(deps as never);

    const result = await useCase.execute(buildPayload());

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      outcome: "noFiefUser",
      reason: "no-binding",
    });

    expect(deps.fiefAdmin.updateUser).not.toHaveBeenCalled();
    expect(deps.identityMapRepo.delete).not.toHaveBeenCalled();
    expect(deps.identityMapRepo.upsert).not.toHaveBeenCalled();
  });

  it("loop-prevention: payload with metadata.fief_sync_origin='fief' → skipped, no Fief I/O", async () => {
    const deps = buildDeps();
    const useCase = new CustomerDeletedUseCase(deps as never);

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
    expect(deps.fiefAdmin.updateUser).not.toHaveBeenCalled();
  });

  it("kill switch: isSaleorToFiefDisabled() === true → skipped without I/O", async () => {
    const deps = buildDeps({ isKillSwitched: true });
    const useCase = new CustomerDeletedUseCase(deps as never);

    const result = await useCase.execute(buildPayload());

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({ outcome: "skipped", reason: "kill-switch" });

    expect(deps.channelConfigurationRepo.get).not.toHaveBeenCalled();
    expect(deps.identityMapRepo.getBySaleorUser).not.toHaveBeenCalled();
    expect(deps.fiefAdmin.updateUser).not.toHaveBeenCalled();
  });

  it("missing channel-config: returns noConnection without error", async () => {
    const deps = buildDeps({ listChannelConfig: () => Promise.resolve(ok(null)) });
    const useCase = new CustomerDeletedUseCase(deps as never);

    const result = await useCase.execute(buildPayload());

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({ outcome: "noConnection" });

    expect(deps.identityMapRepo.getBySaleorUser).not.toHaveBeenCalled();
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
    const useCase = new CustomerDeletedUseCase(deps as never);

    const result = await useCase.execute(buildPayload());

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({ outcome: "noConnection" });
    expect(deps.fiefAdmin.updateUser).not.toHaveBeenCalled();
  });

  it("getDecryptedSecrets failure → Err (queue retries)", async () => {
    const RepoError = class extends Error {};
    const deps = buildDeps({
      getDecryptedSecrets: () => Promise.resolve(err(new RepoError("decrypt failed"))),
    });
    const useCase = new CustomerDeletedUseCase(deps as never);

    const result = await useCase.execute(buildPayload());

    expect(result.isErr()).toBe(true);
    expect(deps.fiefAdmin.updateUser).not.toHaveBeenCalled();
  });

  it("updateUser failure → Err (queue retries); identity_map untouched", async () => {
    const ApiError = class extends Error {};
    const deps = buildDeps({
      updateUserResult: err(new ApiError("Fief 500")),
    });
    const useCase = new CustomerDeletedUseCase(deps as never);

    const result = await useCase.execute(buildPayload());

    expect(result.isErr()).toBe(true);
    expect(deps.fiefAdmin.updateUser).toHaveBeenCalledTimes(1);
    expect(deps.identityMapRepo.delete).not.toHaveBeenCalled();
    expect(deps.identityMapRepo.upsert).not.toHaveBeenCalled();
  });

  it("identity_map repo error on lookup → Err (queue retries)", async () => {
    const RepoError = class extends Error {};
    const deps = buildDeps({
      getBySaleorUserResult: err(new RepoError("mongo down")),
    });
    const useCase = new CustomerDeletedUseCase(deps as never);

    const result = await useCase.execute(buildPayload());

    expect(result.isErr()).toBe(true);
    expect(deps.fiefAdmin.updateUser).not.toHaveBeenCalled();
  });
});
