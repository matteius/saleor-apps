// cspell:ignore upsert opensensor

import { err, ok, type Result } from "neverthrow";
import { describe, expect, it } from "vitest";

import { type ClaimMappingProjectionEntry } from "@/modules/claims-mapping/projector";
import {
  createSaleorUserId,
  type FiefUserId,
  type IdentityMapRow,
  type SaleorApiUrl,
  type SaleorUserId,
} from "@/modules/identity-map/identity-map";
import {
  type GetByFiefUserInput,
  type GetBySaleorUserInput,
  type IdentityMapRepo,
  IdentityMapRepoError,
  type UpsertIdentityMapInput,
} from "@/modules/identity-map/identity-map-repo";
import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { FIEF_SYNC_ORIGIN_KEY, FIEF_SYNC_SEQ_KEY } from "@/modules/sync/loop-guard";

import { type WebhookEventPayload } from "./event-router";
import {
  type SaleorCustomerDeactivateClient,
  type SaleorCustomerDeactivateError,
  UserDeleteUseCase,
  UserDeleteUseCaseError,
} from "./user-delete.use-case";

/*
 * T24 — UserDeleteUseCase unit tests.
 *
 * Per PRD §F2.5 + plan.T24: `user.deleted` from Fief MUST deactivate the
 * Saleor customer (preserves order history) — NOT hard-delete. The
 * identity_map row is left intact for audit, private metadata is left
 * intact for audit, and the public claim metadata is wiped (set to ""
 * via T7's `FiefCustomerUpdate` / `FiefUpdateMetadata`). The origin
 * marker `"fief"` is written on the deactivation so the Saleor→Fief
 * loop guard (T26-T29) can drop the echo.
 */

// --------------------------- in-memory fakes ----------------------------

const SALEOR_URL = createSaleorApiUrl("https://shop.example/graphql/")._unsafeUnwrap();
const FIEF_USER_ID = "11111111-1111-4111-8111-111111111111" as unknown as FiefUserId;

const sUserId = (raw: string): SaleorUserId => createSaleorUserId(raw)._unsafeUnwrap();

class FakeIdentityMapRepo implements IdentityMapRepo {
  private readonly rowsByFief = new Map<string, IdentityMapRow>();
  private readonly rowsBySaleor = new Map<string, IdentityMapRow>();

  public deleteCallCount = 0;
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
    _input: UpsertIdentityMapInput,
  ): Promise<
    Result<{ row: IdentityMapRow; wasInserted: boolean }, InstanceType<typeof IdentityMapRepoError>>
  > {
    this.upsertCallCount++;

    return err(new IdentityMapRepoError("upsert should not be called from UserDeleteUseCase"));
  }

  async delete(): Promise<Result<void, InstanceType<typeof IdentityMapRepoError>>> {
    this.deleteCallCount++;

    return ok(undefined);
  }

  // Test helper.
  seedRow(row: IdentityMapRow): void {
    this.rowsByFief.set(`${row.saleorApiUrl}::${row.fiefUserId}`, row);
    this.rowsBySaleor.set(`${row.saleorApiUrl}::${row.saleorUserId}`, row);
  }

  hasRow(input: GetByFiefUserInput): boolean {
    return this.rowsByFief.has(`${input.saleorApiUrl}::${input.fiefUserId}`);
  }
}

interface FakeSaleorClientOptions {
  /** When true, `customerUpdate` returns a write error. */
  failCustomerUpdate?: boolean;
  /** When true, `updateMetadata` returns a write error. */
  failMetadataUpdate?: boolean;
}

class FakeSaleorClient implements SaleorCustomerDeactivateClient {
  public readonly customerUpdateCalls: Array<{
    saleorApiUrl: SaleorApiUrl;
    saleorUserId: SaleorUserId;
    isActive: boolean;
  }> = [];

  public readonly metadataUpdateCalls: Array<{
    saleorApiUrl: SaleorApiUrl;
    saleorUserId: SaleorUserId;
    items: Array<{ key: string; value: string }>;
  }> = [];

  private readonly options: FakeSaleorClientOptions;

  constructor(options: FakeSaleorClientOptions = {}) {
    this.options = options;
  }

  async customerUpdate(input: {
    saleorApiUrl: SaleorApiUrl;
    saleorUserId: SaleorUserId;
    isActive: boolean;
  }): Promise<Result<void, SaleorCustomerDeactivateError>> {
    this.customerUpdateCalls.push(input);

    if (this.options.failCustomerUpdate) {
      return err(
        new UserDeleteUseCaseError.SaleorCustomerUpdateFailed("forced customer update failure"),
      );
    }

    return ok(undefined);
  }

  async updateMetadata(input: {
    saleorApiUrl: SaleorApiUrl;
    saleorUserId: SaleorUserId;
    items: Array<{ key: string; value: string }>;
  }): Promise<Result<void, SaleorCustomerDeactivateError>> {
    this.metadataUpdateCalls.push(input);

    if (this.options.failMetadataUpdate) {
      return err(
        new UserDeleteUseCaseError.SaleorMetadataWriteFailed("forced metadata wipe failure"),
      );
    }

    return ok(undefined);
  }
}

// --------------------------- payload helpers ----------------------------

const buildDeletedPayload = (
  overrides: {
    fiefUserId?: string;
    fields?: Record<string, unknown>;
    tenantId?: string;
  } = {},
): WebhookEventPayload => ({
  type: "user.deleted",
  eventId: "evt_test_delete_1",
  data: {
    id: overrides.fiefUserId ?? FIEF_USER_ID,
    email: "alice@example.com",
    is_active: false,
    tenant_id: overrides.tenantId ?? "22222222-2222-4222-8222-222222222222",
    fields: overrides.fields ?? {},
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-09T12:00:00Z",
  },
});

const DEFAULT_CLAIM_MAPPING: ClaimMappingProjectionEntry[] = [
  { fiefClaim: "first_name", saleorMetadataKey: "fief.first_name", visibility: "public" },
  { fiefClaim: "last_name", saleorMetadataKey: "fief.last_name", visibility: "public" },
  { fiefClaim: "internal_tier", saleorMetadataKey: "fief.tier", visibility: "private" },
];

// --------------------------- helpers -----------------------------------

const buildUseCase = (overrides?: {
  identityMap?: FakeIdentityMapRepo;
  saleorClient?: FakeSaleorClient;
}) => {
  const identityMap = overrides?.identityMap ?? new FakeIdentityMapRepo();
  const saleorClient = overrides?.saleorClient ?? new FakeSaleorClient();

  return {
    useCase: new UserDeleteUseCase({ identityMapRepo: identityMap, saleorClient }),
    identityMap,
    saleorClient,
  };
};

// --------------------------- tests --------------------------------------

describe("UserDeleteUseCase — T24", () => {
  describe("happy path — existing identity_map row", () => {
    it("deactivates the Saleor customer (isActive: false)", async () => {
      const identityMap = new FakeIdentityMapRepo();

      identityMap.seedRow({
        saleorApiUrl: SALEOR_URL,
        saleorUserId: sUserId("ExistingUserId"),
        fiefUserId: FIEF_USER_ID,
        lastSyncSeq: 7,
        lastSyncedAt: new Date(),
      });

      const { useCase, saleorClient } = buildUseCase({ identityMap });

      const result = await useCase.execute({
        saleorApiUrl: SALEOR_URL,
        claimMapping: DEFAULT_CLAIM_MAPPING,
        payload: buildDeletedPayload(),
      });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().kind).toBe("deactivated");

      // Customer was deactivated against the bound saleorUserId.
      expect(saleorClient.customerUpdateCalls).toHaveLength(1);
      expect(saleorClient.customerUpdateCalls[0]).toStrictEqual({
        saleorApiUrl: SALEOR_URL,
        saleorUserId: "ExistingUserId",
        isActive: false,
      });
    });

    it("wipes the public claim metadata keys (sets each to '')", async () => {
      const identityMap = new FakeIdentityMapRepo();

      identityMap.seedRow({
        saleorApiUrl: SALEOR_URL,
        saleorUserId: sUserId("ExistingUserId"),
        fiefUserId: FIEF_USER_ID,
        lastSyncSeq: 7,
        lastSyncedAt: new Date(),
      });

      const { useCase, saleorClient } = buildUseCase({ identityMap });

      const result = await useCase.execute({
        saleorApiUrl: SALEOR_URL,
        claimMapping: DEFAULT_CLAIM_MAPPING,
        payload: buildDeletedPayload(),
      });

      expect(result.isOk()).toBe(true);

      expect(saleorClient.metadataUpdateCalls).toHaveLength(1);
      const items = saleorClient.metadataUpdateCalls[0].items;
      const itemMap = Object.fromEntries(items.map((i) => [i.key, i.value]));

      // Public claim keys are cleared.
      expect(itemMap["fief.first_name"]).toBe("");
      expect(itemMap["fief.last_name"]).toBe("");

      // Private-visibility mapping is NOT wiped (left intact for audit per F2.5).
      expect(items.find((i) => i.key === "fief.tier")).toBeUndefined();
    });

    it("writes the origin marker 'fief' on the deactivation (loop-guard mark)", async () => {
      const identityMap = new FakeIdentityMapRepo();

      identityMap.seedRow({
        saleorApiUrl: SALEOR_URL,
        saleorUserId: sUserId("ExistingUserId"),
        fiefUserId: FIEF_USER_ID,
        lastSyncSeq: 7,
        lastSyncedAt: new Date(),
      });

      const { useCase, saleorClient } = buildUseCase({ identityMap });

      const result = await useCase.execute({
        saleorApiUrl: SALEOR_URL,
        claimMapping: DEFAULT_CLAIM_MAPPING,
        payload: buildDeletedPayload(),
      });

      expect(result.isOk()).toBe(true);

      /*
       * Origin marker "fief" lands on the public metadata write so T26-T29
       * see the echo and skip.
       */
      const items = saleorClient.metadataUpdateCalls[0].items;
      const itemMap = Object.fromEntries(items.map((i) => [i.key, i.value]));

      expect(itemMap[FIEF_SYNC_ORIGIN_KEY]).toBe("fief");
    });

    it("preserves the identity_map row (does NOT call delete)", async () => {
      const identityMap = new FakeIdentityMapRepo();

      identityMap.seedRow({
        saleorApiUrl: SALEOR_URL,
        saleorUserId: sUserId("ExistingUserId"),
        fiefUserId: FIEF_USER_ID,
        lastSyncSeq: 7,
        lastSyncedAt: new Date(),
      });

      const { useCase } = buildUseCase({ identityMap });

      const result = await useCase.execute({
        saleorApiUrl: SALEOR_URL,
        claimMapping: DEFAULT_CLAIM_MAPPING,
        payload: buildDeletedPayload(),
      });

      expect(result.isOk()).toBe(true);
      // F2.5: identity_map row must remain for audit.
      expect(identityMap.deleteCallCount).toBe(0);
      expect(identityMap.hasRow({ saleorApiUrl: SALEOR_URL, fiefUserId: FIEF_USER_ID })).toBe(true);
    });
  });

  describe("idempotency — no identity_map row", () => {
    it("returns ok no-op when no identity_map row exists for the fief user", async () => {
      const { useCase, saleorClient, identityMap } = buildUseCase();

      const result = await useCase.execute({
        saleorApiUrl: SALEOR_URL,
        claimMapping: DEFAULT_CLAIM_MAPPING,
        payload: buildDeletedPayload(),
      });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().kind).toBe("noop-no-binding");

      // No Saleor side effects.
      expect(saleorClient.customerUpdateCalls).toHaveLength(0);
      expect(saleorClient.metadataUpdateCalls).toHaveLength(0);
      // No identity_map deletion either.
      expect(identityMap.deleteCallCount).toBe(0);
    });
  });

  describe("loop-prevention — origin marker says we wrote this", () => {
    it("skips when Fief event carries origin=saleor (Saleor→Fief delete echo)", async () => {
      const identityMap = new FakeIdentityMapRepo();

      identityMap.seedRow({
        saleorApiUrl: SALEOR_URL,
        saleorUserId: sUserId("ExistingUserId"),
        fiefUserId: FIEF_USER_ID,
        lastSyncSeq: 20,
        lastSyncedAt: new Date(),
      });

      const { useCase, saleorClient } = buildUseCase({ identityMap });

      const payload = buildDeletedPayload({
        fields: {
          [FIEF_SYNC_ORIGIN_KEY]: "saleor",
          [FIEF_SYNC_SEQ_KEY]: "999",
        },
      });

      const result = await useCase.execute({
        saleorApiUrl: SALEOR_URL,
        claimMapping: DEFAULT_CLAIM_MAPPING,
        payload,
      });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().kind).toBe("skipped-by-loop-guard");

      // CRITICAL: no Saleor write at all.
      expect(saleorClient.customerUpdateCalls).toHaveLength(0);
      expect(saleorClient.metadataUpdateCalls).toHaveLength(0);
    });
  });

  describe("payload validation", () => {
    it("returns InvalidPayload err when data.id is missing or not a uuid", async () => {
      const { useCase, saleorClient, identityMap } = buildUseCase();

      const result = await useCase.execute({
        saleorApiUrl: SALEOR_URL,
        claimMapping: DEFAULT_CLAIM_MAPPING,
        payload: {
          type: "user.deleted",
          eventId: "evt_bad",
          data: { email: "a@b.test" },
        },
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(UserDeleteUseCaseError.InvalidPayload);
      expect(saleorClient.customerUpdateCalls).toHaveLength(0);
      expect(identityMap.deleteCallCount).toBe(0);
    });
  });

  describe("error propagation", () => {
    it("propagates SaleorCustomerUpdateFailed when customerUpdate fails", async () => {
      const identityMap = new FakeIdentityMapRepo();

      identityMap.seedRow({
        saleorApiUrl: SALEOR_URL,
        saleorUserId: sUserId("ExistingUserId"),
        fiefUserId: FIEF_USER_ID,
        lastSyncSeq: 7,
        lastSyncedAt: new Date(),
      });

      const saleorClient = new FakeSaleorClient({ failCustomerUpdate: true });
      const { useCase } = buildUseCase({ identityMap, saleorClient });

      const result = await useCase.execute({
        saleorApiUrl: SALEOR_URL,
        claimMapping: DEFAULT_CLAIM_MAPPING,
        payload: buildDeletedPayload(),
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        UserDeleteUseCaseError.SaleorCustomerUpdateFailed,
      );
    });

    it("propagates SaleorMetadataWriteFailed when metadata wipe fails", async () => {
      const identityMap = new FakeIdentityMapRepo();

      identityMap.seedRow({
        saleorApiUrl: SALEOR_URL,
        saleorUserId: sUserId("ExistingUserId"),
        fiefUserId: FIEF_USER_ID,
        lastSyncSeq: 7,
        lastSyncedAt: new Date(),
      });

      const saleorClient = new FakeSaleorClient({ failMetadataUpdate: true });
      const { useCase } = buildUseCase({ identityMap, saleorClient });

      const result = await useCase.execute({
        saleorApiUrl: SALEOR_URL,
        claimMapping: DEFAULT_CLAIM_MAPPING,
        payload: buildDeletedPayload(),
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        UserDeleteUseCaseError.SaleorMetadataWriteFailed,
      );
    });

    it("propagates IdentityMapWriteFailed when getByFiefUser fails", async () => {
      const identityMap = new FakeIdentityMapRepo();

      identityMap.getByFiefUser = async () =>
        err(new IdentityMapRepoError("forced lookup failure"));

      const { useCase } = buildUseCase({ identityMap });

      const result = await useCase.execute({
        saleorApiUrl: SALEOR_URL,
        claimMapping: DEFAULT_CLAIM_MAPPING,
        payload: buildDeletedPayload(),
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        UserDeleteUseCaseError.IdentityMapReadFailed,
      );
    });
  });
});
