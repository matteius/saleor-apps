/*
 * @vitest-environment node
 *
 * T28 — Saleor → Fief CUSTOMER_METADATA_UPDATED use case tests.
 *
 * Mirrors T26's test layout but exercises the **reverse-sync gate** that is
 * unique to T28: only `claimMapping` entries with `reverseSyncEnabled: true`
 * propagate Saleor metadata changes back to Fief user_field. Default
 * (everything off) is a no-op — we keep Fief as source-of-truth unless the
 * operator explicitly opts in per claim mapping (PRD §F3.4 / T36 UI).
 *
 * Coverage:
 *   - reverse-sync ON for one mapping → updateUser called with that field only
 *   - reverse-sync OFF for a mapping (default) → no Fief I/O even when the
 *     mapped saleor metadata key is present in the payload
 *   - default `claimMapping = []` → no-op (returns `noChanges`)
 *   - mixed mappings (one on, one off) → only the opted-in field forwarded
 *   - loop-prevention: payload origin marker `"fief"` → skipped, no I/O
 *   - kill switch on → skipped, no I/O
 *   - missing identity-map row (Saleor user not yet bound) → no-op
 *     (`noBinding` outcome — T28 does not auto-bind; T26 owns that path)
 *   - missing channel-config or no connection → noConnection
 *   - updateUser failure → Err (queue retries)
 *   - identity_map upsert failure (seq bump) → Err
 *   - mapping has reverseSyncEnabled but the saleor metadata key is NOT
 *     present in the payload → that mapping does nothing (changed-keys logic)
 */

import { err, ok } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ChannelConfiguration,
  createConnectionId,
} from "@/modules/channel-configuration/channel-configuration";
import {
  type ClaimMappingEntry,
  createProviderConnectionId,
  type ProviderConnection,
} from "@/modules/provider-connections/provider-connection";
import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import {
  type CustomerMetadataUpdatedJobPayload,
  CustomerMetadataUpdatedUseCase,
} from "./customer-metadata-updated.use-case";

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
const FIEF_USER_ID = "44444444-4444-4444-8444-444444444444";

const buildClaim = (overrides: Partial<ClaimMappingEntry> = {}): ClaimMappingEntry => ({
  fiefClaim: overrides.fiefClaim ?? "first_name",
  saleorMetadataKey: overrides.saleorMetadataKey ?? "fief.first_name",
  required: overrides.required ?? false,
  visibility: overrides.visibility ?? "private",
  reverseSyncEnabled: overrides.reverseSyncEnabled ?? false,
});

const buildProviderConnection = (claimMapping: ClaimMappingEntry[] = []): ProviderConnection => ({
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
  claimMapping,
  softDeletedAt: null,
});

const buildConfig = (): ChannelConfiguration => ({
  saleorApiUrl: SALEOR_API_URL,
  defaultConnectionId: CONNECTION_ID,
  overrides: [],
});

const buildPayload = (
  overrides: Partial<CustomerMetadataUpdatedJobPayload> = {},
): CustomerMetadataUpdatedJobPayload => ({
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

const buildIdentityMapRow = () => ({
  saleorApiUrl: SALEOR_API_URL as unknown as string,
  saleorUserId: "VXNlcjox",
  fiefUserId: FIEF_USER_ID,
  lastSyncSeq: 7,
  lastSyncedAt: new Date("2026-05-09T00:00:00.000Z"),
});

const buildFiefUser = (overrides: Record<string, unknown> = {}) => ({
  id: FIEF_USER_ID,
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
    getBySaleorUser: () => unknown;
    updateUserResult: unknown;
    upsertIdentityMapResult: unknown;
    isKillSwitched: boolean;
    claimMapping: ClaimMappingEntry[];
  }> = {},
) => {
  const channelConfigurationRepo = {
    get: vi.fn(overrides.listChannelConfig ?? (() => Promise.resolve(ok(buildConfig())))),
    upsert: vi.fn(),
  };
  const providerConnectionRepo = {
    get: vi.fn(
      overrides.getProviderConnection ??
        (() => Promise.resolve(ok(buildProviderConnection(overrides.claimMapping ?? [])))),
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
      overrides.getBySaleorUser ?? (() => Promise.resolve(ok(buildIdentityMapRow()))),
    ),
    getByFiefUser: vi.fn(),
    upsert: vi.fn(
      overrides.upsertIdentityMapResult !== undefined
        ? () => Promise.resolve(overrides.upsertIdentityMapResult)
        : () =>
            Promise.resolve(
              ok({
                row: { ...buildIdentityMapRow(), lastSyncSeq: 8 },
                wasInserted: false,
              }),
            ),
    ),
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

describe("CustomerMetadataUpdatedUseCase — T28", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reverse-sync ON: opted-in mapping forwards changed key as Fief user_field", async () => {
    const claim = buildClaim({
      fiefClaim: "first_name",
      saleorMetadataKey: "fief.first_name",
      reverseSyncEnabled: true,
    });
    const deps = buildDeps({ claimMapping: [claim] });
    const useCase = new CustomerMetadataUpdatedUseCase(deps as never);

    const result = await useCase.execute(
      buildPayload({
        user: {
          ...buildPayload().user,
          metadata: [{ key: "fief.first_name", value: "Bob" }],
        },
      }),
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      outcome: "synced",
      fieldsForwarded: 1,
      fiefUserId: FIEF_USER_ID,
    });

    expect(deps.fiefAdmin.updateUser).toHaveBeenCalledTimes(1);

    const callArgs = (deps.fiefAdmin.updateUser.mock.calls as unknown as unknown[][])[0] as [
      unknown,
      unknown,
      { fields: Record<string, unknown> },
    ];
    const updateInput = callArgs[2];

    expect(updateInput.fields).toStrictEqual({ first_name: "Bob" });

    expect(deps.identityMapRepo.upsert).toHaveBeenCalledTimes(1);
  });

  it("reverse-sync OFF (default): mapped key present but mapping not opted-in → no Fief I/O", async () => {
    const claim = buildClaim({
      fiefClaim: "first_name",
      saleorMetadataKey: "fief.first_name",
      reverseSyncEnabled: false,
    });
    const deps = buildDeps({ claimMapping: [claim] });
    const useCase = new CustomerMetadataUpdatedUseCase(deps as never);

    const result = await useCase.execute(
      buildPayload({
        user: {
          ...buildPayload().user,
          metadata: [{ key: "fief.first_name", value: "Bob" }],
        },
      }),
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({ outcome: "noChanges" });

    expect(deps.fiefAdmin.updateUser).not.toHaveBeenCalled();
    expect(deps.identityMapRepo.upsert).not.toHaveBeenCalled();
  });

  it("default empty claimMapping: no reverse-sync mappings configured → no-op", async () => {
    const deps = buildDeps({ claimMapping: [] });
    const useCase = new CustomerMetadataUpdatedUseCase(deps as never);

    const result = await useCase.execute(
      buildPayload({
        user: {
          ...buildPayload().user,
          metadata: [
            { key: "anything", value: "value" },
            { key: "fief.first_name", value: "Bob" },
          ],
        },
      }),
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({ outcome: "noChanges" });

    expect(deps.fiefAdmin.updateUser).not.toHaveBeenCalled();
  });

  it("mixed mappings: only the opted-in mapping's field is forwarded", async () => {
    const onClaim = buildClaim({
      fiefClaim: "first_name",
      saleorMetadataKey: "fief.first_name",
      reverseSyncEnabled: true,
    });
    const offClaim = buildClaim({
      fiefClaim: "last_name",
      saleorMetadataKey: "fief.last_name",
      reverseSyncEnabled: false,
    });
    const deps = buildDeps({ claimMapping: [onClaim, offClaim] });
    const useCase = new CustomerMetadataUpdatedUseCase(deps as never);

    const result = await useCase.execute(
      buildPayload({
        user: {
          ...buildPayload().user,
          metadata: [
            { key: "fief.first_name", value: "Bob" },
            { key: "fief.last_name", value: "Builder" },
          ],
        },
      }),
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({ outcome: "synced", fieldsForwarded: 1 });

    expect(deps.fiefAdmin.updateUser).toHaveBeenCalledTimes(1);
    const callArgs = (deps.fiefAdmin.updateUser.mock.calls as unknown as unknown[][])[0] as [
      unknown,
      unknown,
      { fields: Record<string, unknown> },
    ];
    const updateInput = callArgs[2];

    expect(updateInput.fields).toStrictEqual({ first_name: "Bob" });
    expect(updateInput.fields).not.toHaveProperty("last_name");
  });

  it("opted-in mapping but key absent from payload → that mapping is a no-op", async () => {
    const claim = buildClaim({
      fiefClaim: "first_name",
      saleorMetadataKey: "fief.first_name",
      reverseSyncEnabled: true,
    });
    const deps = buildDeps({ claimMapping: [claim] });
    const useCase = new CustomerMetadataUpdatedUseCase(deps as never);

    const result = await useCase.execute(
      buildPayload({
        user: {
          ...buildPayload().user,
          metadata: [{ key: "unrelated", value: "ignored" }],
        },
      }),
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({ outcome: "noChanges" });

    expect(deps.fiefAdmin.updateUser).not.toHaveBeenCalled();
  });

  it("loop-prevention: payload origin='fief' → skipped, no Fief I/O, no identity-map I/O", async () => {
    const claim = buildClaim({
      fiefClaim: "first_name",
      saleorMetadataKey: "fief.first_name",
      reverseSyncEnabled: true,
    });
    const deps = buildDeps({ claimMapping: [claim] });
    const useCase = new CustomerMetadataUpdatedUseCase(deps as never);

    const result = await useCase.execute(
      buildPayload({
        user: {
          ...buildPayload().user,
          metadata: [
            { key: "fief_sync_origin", value: "fief" },
            { key: "fief.first_name", value: "Bob" },
          ],
        },
      }),
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({ outcome: "skipped", reason: "origin-fief" });

    expect(deps.fiefAdmin.updateUser).not.toHaveBeenCalled();
    expect(deps.identityMapRepo.getBySaleorUser).not.toHaveBeenCalled();
    expect(deps.identityMapRepo.upsert).not.toHaveBeenCalled();
  });

  it("kill switch: isSaleorToFiefDisabled() === true → skipped without I/O", async () => {
    const deps = buildDeps({ isKillSwitched: true });
    const useCase = new CustomerMetadataUpdatedUseCase(deps as never);

    const result = await useCase.execute(buildPayload());

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({ outcome: "skipped", reason: "kill-switch" });

    expect(deps.channelConfigurationRepo.get).not.toHaveBeenCalled();
    expect(deps.fiefAdmin.updateUser).not.toHaveBeenCalled();
  });

  it("missing identity-map binding: Saleor user not yet bound → noBinding (no-op)", async () => {
    const claim = buildClaim({
      fiefClaim: "first_name",
      saleorMetadataKey: "fief.first_name",
      reverseSyncEnabled: true,
    });
    const deps = buildDeps({
      claimMapping: [claim],
      getBySaleorUser: () => Promise.resolve(ok(null)),
    });
    const useCase = new CustomerMetadataUpdatedUseCase(deps as never);

    const result = await useCase.execute(
      buildPayload({
        user: {
          ...buildPayload().user,
          metadata: [{ key: "fief.first_name", value: "Bob" }],
        },
      }),
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({ outcome: "noBinding" });

    expect(deps.fiefAdmin.updateUser).not.toHaveBeenCalled();
  });

  it("missing channel-config: returns noConnection without error", async () => {
    const deps = buildDeps({ listChannelConfig: () => Promise.resolve(ok(null)) });
    const useCase = new CustomerMetadataUpdatedUseCase(deps as never);

    const result = await useCase.execute(buildPayload());

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({ outcome: "noConnection" });

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
    const useCase = new CustomerMetadataUpdatedUseCase(deps as never);

    const result = await useCase.execute(buildPayload());

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({ outcome: "noConnection" });
  });

  it("updateUser failure → Err (queue retries)", async () => {
    const ApiError = class extends Error {};
    const claim = buildClaim({
      fiefClaim: "first_name",
      saleorMetadataKey: "fief.first_name",
      reverseSyncEnabled: true,
    });
    const deps = buildDeps({
      claimMapping: [claim],
      updateUserResult: err(new ApiError("Fief 500")),
    });
    const useCase = new CustomerMetadataUpdatedUseCase(deps as never);

    const result = await useCase.execute(
      buildPayload({
        user: {
          ...buildPayload().user,
          metadata: [{ key: "fief.first_name", value: "Bob" }],
        },
      }),
    );

    expect(result.isErr()).toBe(true);
    expect(deps.fiefAdmin.updateUser).toHaveBeenCalledTimes(1);
    expect(deps.identityMapRepo.upsert).not.toHaveBeenCalled();
  });

  it("identity_map upsert failure (seq bump) → Err", async () => {
    const RepoError = class extends Error {};
    const claim = buildClaim({
      fiefClaim: "first_name",
      saleorMetadataKey: "fief.first_name",
      reverseSyncEnabled: true,
    });
    const deps = buildDeps({
      claimMapping: [claim],
      upsertIdentityMapResult: err(new RepoError("mongo down")),
    });
    const useCase = new CustomerMetadataUpdatedUseCase(deps as never);

    const result = await useCase.execute(
      buildPayload({
        user: {
          ...buildPayload().user,
          metadata: [{ key: "fief.first_name", value: "Bob" }],
        },
      }),
    );

    expect(result.isErr()).toBe(true);
  });
});
