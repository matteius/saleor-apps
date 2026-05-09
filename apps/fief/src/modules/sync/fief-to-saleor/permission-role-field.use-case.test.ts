// cspell:ignore upsert opensensor

import { err, ok, type Result } from "neverthrow";
import { describe, expect, it } from "vitest";

import { type ClaimMappingProjectionEntry } from "@/modules/claims-mapping/projector";
import {
  type AnyFiefAdminApiError,
  FiefAdminApiNotFoundError,
} from "@/modules/fief-client/admin-api-errors";
import {
  type FiefAdminToken,
  type FiefUser,
  type FiefUserId,
} from "@/modules/fief-client/admin-api-types";
import {
  createSaleorUserId,
  type IdentityMapRow,
  type SaleorApiUrl,
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
  type RaiseReconciliationFlagInput,
  type ReconciliationFlagError,
  ReconciliationFlagError as ReconciliationFlagErrors,
  type ReconciliationFlagRow,
} from "@/modules/reconciliation/reconciliation-flag";
import { type ReconciliationFlagRepo } from "@/modules/reconciliation/reconciliation-flag-repo";
import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { FIEF_SYNC_ORIGIN_KEY, FIEF_SYNC_SEQ_KEY } from "@/modules/sync/loop-guard";

import { type WebhookEventPayload } from "./event-router";
import {
  PermissionRoleFieldUseCase,
  PermissionRoleFieldUseCaseError,
} from "./permission-role-field.use-case";
import {
  type CreatedSaleorCustomer,
  type SaleorCustomerClient,
  type SaleorCustomerWriteError,
  UserUpsertUseCaseError,
} from "./user-upsert.use-case";

/*
 * T25 — `PermissionRoleFieldUseCase` unit tests.
 *
 * Five Fief webhook event types collapse into ONE use case because they
 * share the same downstream behavior: re-fetch the affected user, re-
 * project claims, re-write Saleor metadata. The lone exception is
 * `user_field.updated` which is a SCHEMA-LEVEL change — we intentionally
 * do NOT fan out per-user; we raise a "reconciliation recommended" flag
 * that T38's UI surfaces, then return ok.
 *
 * Event payload shapes (from `opensensor-fief/fief/services/webhooks/models.py`
 * + `opensensor-fief/fief/schemas/user_permission.py` /
 * `user_role.py` / `user_field.py`):
 *
 *   - `user_permission.created` / `user_permission.deleted`:
 *       data: { user_id, permission_id, from_role_id?, permission, from_role,
 *               created_at, updated_at }
 *
 *   - `user_role.created` / `user_role.deleted`:
 *       data: { user_id, role_id, role, created_at, updated_at }
 *
 *   - `user_field.updated`:
 *       data: { id, name, slug, type, configuration, created_at, updated_at }
 *       (NB: `id` here is the user_field id, NOT a user id.)
 *
 * Loop-guard semantics: these events do NOT carry a user `fields` bag in
 * the payload (the event is about the permission/role join row). When we
 * re-fetch the user via T5's `getUser`, the resulting `FiefUser.fields`
 * IS the loop-guard surface. If that `fields` bag has origin="saleor"
 * (because the permission grant was triggered by a Saleor-side write
 * that we reflected through Fief), we skip the re-projection.
 */

// --------------------------- in-memory fakes ----------------------------

const SALEOR_URL = createSaleorApiUrl("https://shop.example/graphql/")._unsafeUnwrap();
const FIEF_USER_ID = "11111111-1111-4111-8111-111111111111" as unknown as FiefUserId;
const PERMISSION_ID = "33333333-3333-4333-8333-333333333333";
const ROLE_ID = "44444444-4444-4444-8444-444444444444";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const ADMIN_TOKEN = "admin_test_token" as unknown as FiefAdminToken;

const sUserId = (raw: string): SaleorUserId => createSaleorUserId(raw)._unsafeUnwrap();

class FakeIdentityMapRepo implements IdentityMapRepo {
  private readonly rowsByFief = new Map<string, IdentityMapRow>();
  private readonly rowsBySaleor = new Map<string, IdentityMapRow>();

  public upsertCallCount = 0;

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

interface FakeSaleorClientOptions {
  failMetadataUpdate?: boolean;
}

class FakeSaleorClient implements SaleorCustomerClient {
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
  }): Promise<Result<CreatedSaleorCustomer, SaleorCustomerWriteError>> {
    this.customerCreateCalls.push(input);

    return ok({ saleorUserId: sUserId("ShouldNotBeCalled"), email: input.email });
  }

  async updateMetadata(input: {
    saleorApiUrl: SaleorApiUrl;
    saleorUserId: SaleorUserId;
    items: Array<{ key: string; value: string }>;
  }): Promise<Result<void, SaleorCustomerWriteError>> {
    this.metadataUpdateCalls.push(input);

    if (this.options.failMetadataUpdate) {
      return err(new UserUpsertUseCaseError.SaleorMetadataWriteFailed("forced metadata failure"));
    }

    return ok(undefined);
  }

  async updatePrivateMetadata(input: {
    saleorApiUrl: SaleorApiUrl;
    saleorUserId: SaleorUserId;
    items: Array<{ key: string; value: string }>;
  }): Promise<Result<void, SaleorCustomerWriteError>> {
    this.privateMetadataUpdateCalls.push(input);

    return ok(undefined);
  }
}

interface FakeFiefAdminOptions {
  /** When set, `getUser` returns this row regardless of input. */
  user?: FiefUser;
  /** When true, `getUser` returns NotFound. */
  notFound?: boolean;
}

class FakeFiefAdmin {
  public getUserCalls: Array<{ token: FiefAdminToken; userId: FiefUserId }> = [];

  private readonly options: FakeFiefAdminOptions;

  constructor(options: FakeFiefAdminOptions = {}) {
    this.options = options;
  }

  async getUser(
    token: FiefAdminToken,
    userId: FiefUserId,
  ): Promise<Result<FiefUser, AnyFiefAdminApiError>> {
    this.getUserCalls.push({ token, userId });

    if (this.options.notFound) {
      return err(
        new FiefAdminApiNotFoundError("not found", {
          props: { statusCode: 404, detail: "user not found" },
        }),
      );
    }

    return ok(this.options.user ?? buildFiefUser({}));
  }
}

class FakeReconciliationFlagRepo implements ReconciliationFlagRepo {
  public raised: RaiseReconciliationFlagInput[] = [];
  public failOnRaise = false;

  async raise(
    input: RaiseReconciliationFlagInput,
  ): Promise<Result<ReconciliationFlagRow, ReconciliationFlagError>> {
    this.raised.push(input);

    if (this.failOnRaise) {
      return err(new ReconciliationFlagErrors.WriteFailed("forced write failure"));
    }

    return ok({
      saleorApiUrl: input.saleorApiUrl,
      reason: input.reason,
      raisedByEventId: input.raisedByEventId,
      raisedAt: new Date(),
      clearedAt: null,
    });
  }

  async get(): Promise<Result<ReconciliationFlagRow | null, ReconciliationFlagError>> {
    return ok(null);
  }
}

// --------------------------- payload helpers ----------------------------

const buildFiefUser = (overrides: {
  fields?: Record<string, unknown>;
  email?: string;
  isActive?: boolean;
}): FiefUser => ({
  id: FIEF_USER_ID,
  created_at: "2026-05-01T00:00:00Z" as unknown as FiefUser["created_at"],
  updated_at: "2026-05-09T12:00:00Z" as unknown as FiefUser["updated_at"],
  email: overrides.email ?? "alice@example.com",
  email_verified: true,
  is_active: overrides.isActive ?? true,
  tenant_id: TENANT_ID as unknown as FiefUser["tenant_id"],
  fields: overrides.fields ?? {
    first_name: "Alice",
    last_name: "Anderson",
    internal_tier: "gold",
  },
});

const buildPermissionPayload = (overrides: {
  type?: "user_permission.created" | "user_permission.deleted";
  userId?: string;
  eventId?: string;
}): WebhookEventPayload => ({
  type: overrides.type ?? "user_permission.created",
  eventId: overrides.eventId ?? "evt_perm_1",
  data: {
    user_id: overrides.userId ?? FIEF_USER_ID,
    permission_id: PERMISSION_ID,
    from_role_id: null,
    permission: { id: PERMISSION_ID, codename: "users.read", name: "Read Users" },
    from_role: null,
    created_at: "2026-05-09T12:00:00Z",
    updated_at: "2026-05-09T12:00:00Z",
  },
});

const buildRolePayload = (overrides: {
  type?: "user_role.created" | "user_role.deleted";
  userId?: string;
  eventId?: string;
}): WebhookEventPayload => ({
  type: overrides.type ?? "user_role.created",
  eventId: overrides.eventId ?? "evt_role_1",
  data: {
    user_id: overrides.userId ?? FIEF_USER_ID,
    role_id: ROLE_ID,
    role: { id: ROLE_ID, name: "Admin" },
    created_at: "2026-05-09T12:00:00Z",
    updated_at: "2026-05-09T12:00:00Z",
  },
});

const buildFieldPayload = (overrides: {
  fieldId?: string;
  slug?: string;
  eventId?: string;
}): WebhookEventPayload => ({
  type: "user_field.updated",
  eventId: overrides.eventId ?? "evt_field_1",
  data: {
    id: overrides.fieldId ?? "55555555-5555-4555-8555-555555555555",
    name: "Internal Tier",
    slug: overrides.slug ?? "internal_tier",
    type: "STRING",
    configuration: { at_registration: false, required: false, at_update: true },
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-09T12:00:00Z",
  },
});

const DEFAULT_CLAIM_MAPPING: ClaimMappingProjectionEntry[] = [
  { fiefClaim: "first_name", saleorMetadataKey: "fief.first_name", visibility: "public" },
  { fiefClaim: "last_name", saleorMetadataKey: "fief.last_name", visibility: "public" },
  { fiefClaim: "internal_tier", saleorMetadataKey: "fief.tier", visibility: "private" },
];

interface BuildOverrides {
  identityMap?: FakeIdentityMapRepo;
  saleorClient?: FakeSaleorClient;
  fiefAdmin?: FakeFiefAdmin;
  reconciliationFlagRepo?: FakeReconciliationFlagRepo;
  adminToken?: FiefAdminToken;
}

const buildUseCase = (overrides: BuildOverrides = {}) => {
  const identityMap = overrides.identityMap ?? new FakeIdentityMapRepo();
  const saleorClient = overrides.saleorClient ?? new FakeSaleorClient();
  const fiefAdmin = overrides.fiefAdmin ?? new FakeFiefAdmin();
  const reconciliationFlagRepo =
    overrides.reconciliationFlagRepo ?? new FakeReconciliationFlagRepo();

  // Seed an identity_map row by default so re-fetch flows have a Saleor binding.
  if (!overrides.identityMap) {
    identityMap.seedRow({
      saleorApiUrl: SALEOR_URL,
      saleorUserId: sUserId("BoundSaleorUser"),
      fiefUserId: FIEF_USER_ID,
      lastSyncSeq: 5,
      lastSyncedAt: new Date(),
    });
  }

  return {
    useCase: new PermissionRoleFieldUseCase({
      identityMapRepo: identityMap,
      saleorClient,
      fiefAdmin,
      reconciliationFlagRepo,
    }),
    identityMap,
    saleorClient,
    fiefAdmin,
    reconciliationFlagRepo,
  };
};

const baseExecuteInput = {
  saleorApiUrl: SALEOR_URL,
  claimMapping: DEFAULT_CLAIM_MAPPING,
  adminToken: ADMIN_TOKEN,
};

// --------------------------- tests --------------------------------------

describe("PermissionRoleFieldUseCase — T25", () => {
  describe("user_permission.created", () => {
    it("re-fetches the user, re-projects claims, writes tagged metadata to Saleor", async () => {
      const fiefAdmin = new FakeFiefAdmin({
        user: buildFiefUser({
          fields: { first_name: "Alice", last_name: "Anderson", internal_tier: "platinum" },
        }),
      });
      const { useCase, saleorClient, identityMap, reconciliationFlagRepo } = buildUseCase({
        fiefAdmin,
      });

      const result = await useCase.execute({
        ...baseExecuteInput,
        payload: buildPermissionPayload({ type: "user_permission.created" }),
      });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().kind).toBe("written");

      // T5 re-fetch happened with the user_id from the event payload.
      expect(fiefAdmin.getUserCalls).toHaveLength(1);
      expect(fiefAdmin.getUserCalls[0].userId).toBe(FIEF_USER_ID);
      expect(fiefAdmin.getUserCalls[0].token).toBe(ADMIN_TOKEN);

      // No customer create — we always reuse the binding.
      expect(saleorClient.customerCreateCalls).toHaveLength(0);

      // Metadata write — projected claims + origin marker.
      expect(saleorClient.metadataUpdateCalls).toHaveLength(1);
      const items = saleorClient.metadataUpdateCalls[0].items;
      const map = Object.fromEntries(items.map((i) => [i.key, i.value]));

      expect(map["fief.first_name"]).toBe("Alice");
      expect(map[FIEF_SYNC_ORIGIN_KEY]).toBe("fief");

      // Private metadata write — claim + bumped seq.
      const priv = Object.fromEntries(
        saleorClient.privateMetadataUpdateCalls[0].items.map((i) => [i.key, i.value]),
      );

      expect(priv["fief.tier"]).toBe("platinum");
      expect(Number.parseInt(priv[FIEF_SYNC_SEQ_KEY], 10)).toBeGreaterThan(5);

      // identity_map row was upserted with bumped seq.
      expect(identityMap.upsertCallCount).toBe(1);

      // No reconciliation flag for permission events.
      expect(reconciliationFlagRepo.raised).toHaveLength(0);
    });
  });

  describe("user_permission.deleted", () => {
    it("re-fetches the user, re-projects claims, writes tagged metadata to Saleor", async () => {
      const fiefAdmin = new FakeFiefAdmin({
        user: buildFiefUser({ fields: { first_name: "Alice", internal_tier: "silver" } }),
      });
      const { useCase, saleorClient, fiefAdmin: usedAdmin } = buildUseCase({ fiefAdmin });

      const result = await useCase.execute({
        ...baseExecuteInput,
        payload: buildPermissionPayload({ type: "user_permission.deleted" }),
      });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().kind).toBe("written");
      expect(usedAdmin.getUserCalls).toHaveLength(1);
      expect(saleorClient.metadataUpdateCalls).toHaveLength(1);

      const priv = Object.fromEntries(
        saleorClient.privateMetadataUpdateCalls[0].items.map((i) => [i.key, i.value]),
      );

      expect(priv["fief.tier"]).toBe("silver");
    });
  });

  describe("user_role.created / user_role.deleted", () => {
    it("re-fetches and re-projects on user_role.created", async () => {
      const fiefAdmin = new FakeFiefAdmin({
        user: buildFiefUser({ fields: { first_name: "Bob", internal_tier: "gold" } }),
      });
      const { useCase, saleorClient } = buildUseCase({ fiefAdmin });

      const result = await useCase.execute({
        ...baseExecuteInput,
        payload: buildRolePayload({ type: "user_role.created" }),
      });

      expect(result.isOk()).toBe(true);
      expect(saleorClient.metadataUpdateCalls).toHaveLength(1);

      const items = saleorClient.metadataUpdateCalls[0].items;
      const map = Object.fromEntries(items.map((i) => [i.key, i.value]));

      expect(map["fief.first_name"]).toBe("Bob");
    });

    it("re-fetches and re-projects on user_role.deleted", async () => {
      const fiefAdmin = new FakeFiefAdmin({
        user: buildFiefUser({ fields: { first_name: "Bob", internal_tier: "bronze" } }),
      });
      const { useCase, saleorClient } = buildUseCase({ fiefAdmin });

      const result = await useCase.execute({
        ...baseExecuteInput,
        payload: buildRolePayload({ type: "user_role.deleted" }),
      });

      expect(result.isOk()).toBe(true);

      const priv = Object.fromEntries(
        saleorClient.privateMetadataUpdateCalls[0].items.map((i) => [i.key, i.value]),
      );

      expect(priv["fief.tier"]).toBe("bronze");
    });
  });

  describe("loop guard — origin=saleor on the re-fetched user means we wrote it; skip", () => {
    it("skips re-projection + Saleor write when fetched user fields say origin=saleor", async () => {
      const fiefAdmin = new FakeFiefAdmin({
        user: buildFiefUser({
          fields: {
            first_name: "Alice",
            [FIEF_SYNC_ORIGIN_KEY]: "saleor",
            [FIEF_SYNC_SEQ_KEY]: "999",
          },
        }),
      });
      const { useCase, saleorClient } = buildUseCase({ fiefAdmin });

      const result = await useCase.execute({
        ...baseExecuteInput,
        payload: buildPermissionPayload({ type: "user_permission.created" }),
      });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().kind).toBe("skipped-by-loop-guard");

      // Critical: NO Saleor write at all.
      expect(saleorClient.metadataUpdateCalls).toHaveLength(0);
      expect(saleorClient.privateMetadataUpdateCalls).toHaveLength(0);
    });
  });

  describe("user_field.updated — does NOT fan out per-user; raises reconciliation flag", () => {
    it("does NOT re-fetch any user, does NOT write Saleor metadata, raises the flag", async () => {
      const fiefAdmin = new FakeFiefAdmin();
      const {
        useCase,
        saleorClient,
        fiefAdmin: usedAdmin,
        reconciliationFlagRepo,
        identityMap,
      } = buildUseCase({ fiefAdmin });

      const result = await useCase.execute({
        ...baseExecuteInput,
        payload: buildFieldPayload({ slug: "internal_tier" }),
      });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().kind).toBe("reconciliation-flag-raised");

      // Critical: did NOT touch the admin API or Saleor or identity_map.
      expect(usedAdmin.getUserCalls).toHaveLength(0);
      expect(saleorClient.customerCreateCalls).toHaveLength(0);
      expect(saleorClient.metadataUpdateCalls).toHaveLength(0);
      expect(saleorClient.privateMetadataUpdateCalls).toHaveLength(0);
      expect(identityMap.upsertCallCount).toBe(0);

      // Flag was raised exactly once with the saleorApiUrl + a meaningful reason.
      expect(reconciliationFlagRepo.raised).toHaveLength(1);
      expect(reconciliationFlagRepo.raised[0].saleorApiUrl).toBe(SALEOR_URL);
      expect(reconciliationFlagRepo.raised[0].raisedByEventId).toBe("evt_field_1");
      expect(String(reconciliationFlagRepo.raised[0].reason)).toContain("user_field.updated");
    });

    it("returns ok when reconciliation flag write fails (soft failure — log + 200)", async () => {
      const reconciliationFlagRepo = new FakeReconciliationFlagRepo();

      reconciliationFlagRepo.failOnRaise = true;

      const { useCase } = buildUseCase({ reconciliationFlagRepo });

      const result = await useCase.execute({
        ...baseExecuteInput,
        payload: buildFieldPayload({}),
      });

      /*
       * The flag-store outage MUST NOT take down receiver acceptance: we
       * surface this as a typed error so the receiver can log it visibly,
       * but it's a separate error class so the operator knows the failure
       * mode (no user-data corruption — the flag just isn't recorded).
       */
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        PermissionRoleFieldUseCaseError.ReconciliationFlagWriteFailed,
      );
    });
  });

  describe("payload validation", () => {
    it("returns InvalidPayload when user_id missing from a permission event", async () => {
      const { useCase, fiefAdmin, saleorClient } = buildUseCase();

      const result = await useCase.execute({
        ...baseExecuteInput,
        payload: {
          type: "user_permission.created",
          eventId: "evt_bad",
          data: { permission_id: PERMISSION_ID }, // no user_id
        },
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        PermissionRoleFieldUseCaseError.InvalidPayload,
      );
      expect(fiefAdmin.getUserCalls).toHaveLength(0);
      expect(saleorClient.metadataUpdateCalls).toHaveLength(0);
    });

    it("returns InvalidPayload when user_id missing from a role event", async () => {
      const { useCase } = buildUseCase();

      const result = await useCase.execute({
        ...baseExecuteInput,
        payload: {
          type: "user_role.created",
          eventId: "evt_bad",
          data: { role_id: ROLE_ID }, // no user_id
        },
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        PermissionRoleFieldUseCaseError.InvalidPayload,
      );
    });

    it("returns InvalidPayload when the event type is not one of the five", async () => {
      const { useCase } = buildUseCase();

      const result = await useCase.execute({
        ...baseExecuteInput,
        payload: {
          type: "user.created", // wrong event for THIS use case
          eventId: "evt_wrong",
          data: { user_id: FIEF_USER_ID },
        },
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        PermissionRoleFieldUseCaseError.InvalidPayload,
      );
    });
  });

  describe("error propagation", () => {
    it("propagates FiefUserFetchFailed when admin API getUser returns not-found", async () => {
      const fiefAdmin = new FakeFiefAdmin({ notFound: true });
      const { useCase } = buildUseCase({ fiefAdmin });

      const result = await useCase.execute({
        ...baseExecuteInput,
        payload: buildPermissionPayload({ type: "user_permission.created" }),
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        PermissionRoleFieldUseCaseError.FiefUserFetchFailed,
      );
    });

    it("returns NoIdentityMapping when no identity_map row exists for the user", async () => {
      // No seed; map is empty.
      const identityMap = new FakeIdentityMapRepo();

      const { useCase, saleorClient } = buildUseCase({ identityMap });

      const result = await useCase.execute({
        ...baseExecuteInput,
        payload: buildPermissionPayload({ type: "user_permission.created" }),
      });

      /*
       * No mapping → we cannot know which Saleor user to write to. We don't
       * create a customer here (that's T23's job; permission/role events
       * arriving before user.created would be out-of-order from Fief and
       * T23 will follow shortly). Surface as a typed error the receiver
       * can log + ack.
       */
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        PermissionRoleFieldUseCaseError.NoIdentityMapping,
      );
      expect(saleorClient.metadataUpdateCalls).toHaveLength(0);
    });

    it("propagates SaleorMetadataWriteFailed when the metadata mutation fails", async () => {
      const saleorClient = new FakeSaleorClient({ failMetadataUpdate: true });
      const { useCase } = buildUseCase({ saleorClient });

      const result = await useCase.execute({
        ...baseExecuteInput,
        payload: buildPermissionPayload({ type: "user_permission.created" }),
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        PermissionRoleFieldUseCaseError.SaleorMetadataWriteFailed,
      );
    });
  });
});
