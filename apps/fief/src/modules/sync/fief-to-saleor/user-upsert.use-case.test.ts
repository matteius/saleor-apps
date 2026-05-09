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
  type CreatedSaleorCustomer,
  type SaleorCustomerClient,
  type SaleorCustomerWriteError,
  UserUpsertUseCase,
  UserUpsertUseCaseError,
} from "./user-upsert.use-case";

/*
 * T23 — UserUpsertUseCase unit tests.
 *
 * The use case is invoked by the registered handler (T22's eventRouter)
 * for `user.created` AND `user.updated` Fief webhook events. Per T23 of
 * `fief-app-plan.md` it must:
 *
 *   1. Verify loop-guard (T13) BEFORE any side effect — drop incoming
 *      events whose origin marker says they originated from the side we
 *      are about to write into ("saleor"). This is the canary against
 *      infinite Fief↔Saleor loops.
 *   2. Look up the identity_map row by `(saleorApiUrl, fiefUserId)`. If
 *      present → reuse the bound `saleorUserId`; if absent → create a
 *      Saleor customer first, then atomically `upsert` the row.
 *   3. **Race-aware with T19**: if T19's `external-obtain-access-tokens`
 *      flow has already provisioned the customer + identity_map row,
 *      T23 MUST observe the existing row and skip the create step.
 *      Symmetric: if T23 wins the race, T19 sees the existing row.
 *   4. Project Fief claims → Saleor metadata via T14, merged with
 *      `tagWrite("fief", newSeq)` markers (T13). The marker MUST land
 *      on the Saleor write.
 *   5. Write split metadata via T7's `FiefUpdateMetadata` +
 *      `FiefUpdatePrivateMetadata` mutations.
 *
 * The tests below build in-memory fakes for `IdentityMapRepo` and
 * `SaleorCustomerClient`. The race test uses a controllable barrier so
 * we can drive two concurrent invocations with overlapping `getByFiefUser`
 * → `upsert` windows and assert convergence.
 */

// --------------------------- in-memory fakes ----------------------------

const SALEOR_URL = createSaleorApiUrl("https://shop.example/graphql/")._unsafeUnwrap();
const FIEF_USER_ID = "11111111-1111-4111-8111-111111111111" as unknown as FiefUserId;

const sUserId = (raw: string): SaleorUserId => createSaleorUserId(raw)._unsafeUnwrap();

interface FakeIdentityMapRepoOptions {
  /**
   * Optional hook that runs INSIDE `upsert` before the row is committed.
   * Used by the race-resolution test to interleave a second caller.
   */
  beforeUpsertCommit?: (input: UpsertIdentityMapInput) => Promise<void> | void;
}

class FakeIdentityMapRepo implements IdentityMapRepo {
  // Keyed by `${saleorApiUrl}::${fiefUserId}`.
  private readonly rowsByFief = new Map<string, IdentityMapRow>();

  // Keyed by `${saleorApiUrl}::${saleorUserId}`.
  private readonly rowsBySaleor = new Map<string, IdentityMapRow>();

  // Counts for assertions.
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
      /*
       * Mirror the Mongo monotonic-seq contract from T10: an upsert with
       * `syncSeq <= existing.lastSyncSeq` does NOT regress the row.
       * Either way, `wasInserted: false` because we did not establish
       * the binding.
       */
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

  // Test helper.
  seedRow(row: IdentityMapRow): void {
    this.rowsByFief.set(`${row.saleorApiUrl}::${row.fiefUserId}`, row);
    this.rowsBySaleor.set(`${row.saleorApiUrl}::${row.saleorUserId}`, row);
  }
}

interface FakeSaleorClientOptions {
  /** Forced id returned by `customerCreate`. Defaults to a stable string. */
  createdId?: string;
  /** When true, `customerCreate` returns a write error (e.g. duplicate email). */
  failCreate?: boolean;
  /** When true, `updateMetadata` returns a write error. */
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

    if (this.options.failCreate) {
      return err(new UserUpsertUseCaseError.SaleorCustomerCreateFailed("forced create failure"));
    }

    const idRaw = this.options.createdId ?? "VXNlcjox";

    return ok({
      saleorUserId: sUserId(idRaw),
      email: input.email,
    });
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

// --------------------------- payload helpers ----------------------------

/**
 * Build a Fief `WebhookEvent` payload for `user.created` / `user.updated`.
 * Matches `opensensor-fief/fief/services/webhooks/models.py:WebhookEvent`
 * + `fief/schemas/user.py:UserRead` exactly: top-level `{type, data,
 * eventId}`, with `data` carrying `{id, email, email_verified, is_active,
 * tenant_id, fields, created_at, updated_at}`.
 */
const buildUserPayload = (overrides: {
  type?: "user.created" | "user.updated";
  fiefUserId?: string;
  email?: string;
  fields?: Record<string, unknown>;
  tenantId?: string;
}): WebhookEventPayload => ({
  type: overrides.type ?? "user.created",
  eventId: "evt_test_1",
  data: {
    id: overrides.fiefUserId ?? FIEF_USER_ID,
    email: overrides.email ?? "alice@example.com",
    email_verified: true,
    is_active: true,
    tenant_id: overrides.tenantId ?? "22222222-2222-4222-8222-222222222222",
    fields: overrides.fields ?? {
      first_name: "Alice",
      last_name: "Anderson",
    },
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-09T12:00:00Z",
  },
});

const DEFAULT_CLAIM_MAPPING: ClaimMappingProjectionEntry[] = [
  { fiefClaim: "first_name", saleorMetadataKey: "fief.first_name", visibility: "public" },
  { fiefClaim: "last_name", saleorMetadataKey: "fief.last_name", visibility: "public" },
  {
    fiefClaim: "internal_tier",
    saleorMetadataKey: "fief.tier",
    visibility: "private",
  },
];

// --------------------------- helpers -----------------------------------

const buildUseCase = (overrides?: {
  identityMap?: FakeIdentityMapRepo;
  saleorClient?: FakeSaleorClient;
}) => {
  const identityMap = overrides?.identityMap ?? new FakeIdentityMapRepo();
  const saleorClient = overrides?.saleorClient ?? new FakeSaleorClient();

  return {
    useCase: new UserUpsertUseCase({ identityMapRepo: identityMap, saleorClient }),
    identityMap,
    saleorClient,
  };
};

// --------------------------- tests --------------------------------------

describe("UserUpsertUseCase — T23", () => {
  describe("user.created — cold path (no prior identity_map row)", () => {
    it("creates a Saleor customer, upserts identity_map, writes tagged metadata", async () => {
      const { useCase, identityMap, saleorClient } = buildUseCase();

      const payload = buildUserPayload({ type: "user.created" });

      const result = await useCase.execute({
        saleorApiUrl: SALEOR_URL,
        claimMapping: DEFAULT_CLAIM_MAPPING,
        payload,
      });

      expect(result.isOk()).toBe(true);
      const outcome = result._unsafeUnwrap();

      expect(outcome.kind).toBe("written");

      // Saleor customer was created (cold path).
      expect(saleorClient.customerCreateCalls).toHaveLength(1);
      expect(saleorClient.customerCreateCalls[0]).toMatchObject({
        saleorApiUrl: SALEOR_URL,
        email: "alice@example.com",
        firstName: "Alice",
        lastName: "Anderson",
      });

      // identity_map row was written exactly once.
      expect(identityMap.upsertCallCount).toBe(1);
      expect(identityMap.createSaleorRowsCount).toBe(1);

      // Metadata write — projected claims + the origin-marker key.
      expect(saleorClient.metadataUpdateCalls).toHaveLength(1);
      const metadataItems = saleorClient.metadataUpdateCalls[0].items;
      const metadataMap = Object.fromEntries(metadataItems.map((i) => [i.key, i.value]));

      expect(metadataMap["fief.first_name"]).toBe("Alice");
      expect(metadataMap["fief.last_name"]).toBe("Anderson");
      expect(metadataMap[FIEF_SYNC_ORIGIN_KEY]).toBe("fief");

      // Private metadata write — bumped seq lives here.
      expect(saleorClient.privateMetadataUpdateCalls).toHaveLength(1);
      const privateMap = Object.fromEntries(
        saleorClient.privateMetadataUpdateCalls[0].items.map((i) => [i.key, i.value]),
      );

      expect(privateMap[FIEF_SYNC_SEQ_KEY]).toBeDefined();
      // Seq should be a non-negative integer string.
      expect(Number.parseInt(privateMap[FIEF_SYNC_SEQ_KEY], 10)).toBeGreaterThanOrEqual(0);
    });

    it("returns a 'written' outcome carrying the assigned saleorUserId", async () => {
      const saleorClient = new FakeSaleorClient({ createdId: "U1NleHkid" });
      const { useCase } = buildUseCase({ saleorClient });

      const result = await useCase.execute({
        saleorApiUrl: SALEOR_URL,
        claimMapping: DEFAULT_CLAIM_MAPPING,
        payload: buildUserPayload({ type: "user.created" }),
      });

      expect(result.isOk()).toBe(true);
      const outcome = result._unsafeUnwrap();

      if (outcome.kind === "written") {
        expect(outcome.saleorUserId).toBe("U1NleHkid");
        expect(outcome.wasInserted).toBe(true);
      }
    });
  });

  describe("user.created — race with T19 (identity_map already exists)", () => {
    it("skips Saleor customerCreate when identity_map row already exists", async () => {
      const identityMap = new FakeIdentityMapRepo();

      // Simulate T19 (or a concurrent T22 retry) winning the race.
      identityMap.seedRow({
        saleorApiUrl: SALEOR_URL,
        saleorUserId: sUserId("PreExistingUserId"),
        fiefUserId: FIEF_USER_ID,
        lastSyncSeq: 5,
        lastSyncedAt: new Date(),
      });

      const { useCase, saleorClient } = buildUseCase({ identityMap });

      const result = await useCase.execute({
        saleorApiUrl: SALEOR_URL,
        claimMapping: DEFAULT_CLAIM_MAPPING,
        payload: buildUserPayload({ type: "user.created" }),
      });

      expect(result.isOk()).toBe(true);
      const outcome = result._unsafeUnwrap();

      expect(outcome.kind).toBe("written");
      // No customer create — we reused the existing binding.
      expect(saleorClient.customerCreateCalls).toHaveLength(0);

      // Metadata was still refreshed against the existing customer.
      expect(saleorClient.metadataUpdateCalls).toHaveLength(1);
      expect(saleorClient.metadataUpdateCalls[0].saleorUserId).toBe("PreExistingUserId");

      // Seq is bumped above the previously-stored seq.
      const privateMap = Object.fromEntries(
        saleorClient.privateMetadataUpdateCalls[0].items.map((i) => [i.key, i.value]),
      );

      expect(Number.parseInt(privateMap[FIEF_SYNC_SEQ_KEY], 10)).toBeGreaterThan(5);
    });

    it("converges with T19 when both fire concurrently — single Saleor customer, same final row", async () => {
      /*
       * Race semantics — drives the use case TWICE concurrently. We arrange
       * that during the first invocation's `upsert`, the second invocation's
       * `getByFiefUser` already runs (returning null) and we let the first
       * commit before the second runs `upsert`. The second `upsert` then
       * sees the row and returns `wasInserted: false` — the loser MUST NOT
       * call `customerCreate`. End state: exactly one identity_map row,
       * exactly one Saleor customer create.
       */
      let firstUpsertEntered = false;
      let releaseFirstUpsert: () => void = () => undefined;
      const firstUpsertGate = new Promise<void>((resolve) => {
        releaseFirstUpsert = resolve;
      });

      const identityMap = new FakeIdentityMapRepo({
        beforeUpsertCommit: async () => {
          if (!firstUpsertEntered) {
            firstUpsertEntered = true;
            await firstUpsertGate;
          }
        },
      });
      const saleorClient = new FakeSaleorClient({ createdId: "RaceWinnerId" });

      const useCase = new UserUpsertUseCase({ identityMapRepo: identityMap, saleorClient });

      const payload = buildUserPayload({ type: "user.created" });

      const firstPromise = useCase.execute({
        saleorApiUrl: SALEOR_URL,
        claimMapping: DEFAULT_CLAIM_MAPPING,
        payload,
      });

      // Wait until the first invocation is INSIDE its upsert call.

      while (!firstUpsertEntered) {
        await new Promise((r) => setTimeout(r, 1));
      }

      // Now release the first upsert so it commits the row.
      releaseFirstUpsert();
      await firstPromise;

      /*
       * Now fire the second — its getByFiefUser sees the committed row,
       * so it skips customerCreate entirely.
       */
      const secondResult = await useCase.execute({
        saleorApiUrl: SALEOR_URL,
        claimMapping: DEFAULT_CLAIM_MAPPING,
        payload,
      });

      expect(secondResult.isOk()).toBe(true);
      // Exactly one Saleor customer was created across both runs.
      expect(saleorClient.customerCreateCalls).toHaveLength(1);
      // Single identity_map row was inserted.
      expect(identityMap.createSaleorRowsCount).toBe(1);
      // Both runs landed metadata writes.
      expect(saleorClient.metadataUpdateCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("user.updated — refresh metadata only", () => {
    it("does not re-create the Saleor customer; refreshes metadata against the bound id", async () => {
      const identityMap = new FakeIdentityMapRepo();

      identityMap.seedRow({
        saleorApiUrl: SALEOR_URL,
        saleorUserId: sUserId("ExistingUser"),
        fiefUserId: FIEF_USER_ID,
        lastSyncSeq: 10,
        lastSyncedAt: new Date(),
      });

      const { useCase, saleorClient } = buildUseCase({ identityMap });

      const payload = buildUserPayload({
        type: "user.updated",
        fields: { first_name: "Alicia", last_name: "Anderson", internal_tier: "gold" },
      });

      const result = await useCase.execute({
        saleorApiUrl: SALEOR_URL,
        claimMapping: DEFAULT_CLAIM_MAPPING,
        payload,
      });

      expect(result.isOk()).toBe(true);
      expect(saleorClient.customerCreateCalls).toHaveLength(0);

      const metadataMap = Object.fromEntries(
        saleorClient.metadataUpdateCalls[0].items.map((i) => [i.key, i.value]),
      );

      expect(metadataMap["fief.first_name"]).toBe("Alicia");
      expect(metadataMap[FIEF_SYNC_ORIGIN_KEY]).toBe("fief");

      // Private metadata received the private claim AND the seq marker.
      const privateMap = Object.fromEntries(
        saleorClient.privateMetadataUpdateCalls[0].items.map((i) => [i.key, i.value]),
      );

      expect(privateMap["fief.tier"]).toBe("gold");
      expect(Number.parseInt(privateMap[FIEF_SYNC_SEQ_KEY], 10)).toBeGreaterThan(10);
    });
  });

  describe("loop-prevention — origin marker says this event came from us (saleor side wrote it)", () => {
    it("skips when Fief event carries origin=saleor + a stale seq (already-applied loop echo)", async () => {
      const identityMap = new FakeIdentityMapRepo();

      identityMap.seedRow({
        saleorApiUrl: SALEOR_URL,
        saleorUserId: sUserId("ExistingUser"),
        fiefUserId: FIEF_USER_ID,
        lastSyncSeq: 20,
        lastSyncedAt: new Date(),
      });

      const { useCase, saleorClient } = buildUseCase({ identityMap });

      /*
       * Marker injected into Fief user `fields` — this is what the
       * Saleor→Fief writer (T26-T29) puts there before writing.
       */
      const payload = buildUserPayload({
        type: "user.updated",
        fields: {
          first_name: "Alicia",
          [FIEF_SYNC_ORIGIN_KEY]: "saleor",
          [FIEF_SYNC_SEQ_KEY]: "15",
        },
      });

      const result = await useCase.execute({
        saleorApiUrl: SALEOR_URL,
        claimMapping: DEFAULT_CLAIM_MAPPING,
        payload,
      });

      expect(result.isOk()).toBe(true);
      const outcome = result._unsafeUnwrap();

      expect(outcome.kind).toBe("skipped-by-loop-guard");
      // CRITICAL: no Saleor write at all — that's the canary.
      expect(saleorClient.customerCreateCalls).toHaveLength(0);
      expect(saleorClient.metadataUpdateCalls).toHaveLength(0);
      expect(saleorClient.privateMetadataUpdateCalls).toHaveLength(0);
    });

    it("skips when origin=saleor even with a fresh seq (origin trumps within-side)", async () => {
      /*
       * If Fief is echoing back a write we just made (origin=saleor) and
       * the seq happens to be fresh (newer than what we have stored),
       * `shouldSkip` MUST still drop it — origin-on-same-side is the
       * stricter loop check.
       */
      const identityMap = new FakeIdentityMapRepo();

      identityMap.seedRow({
        saleorApiUrl: SALEOR_URL,
        saleorUserId: sUserId("ExistingUser"),
        fiefUserId: FIEF_USER_ID,
        lastSyncSeq: 10,
        lastSyncedAt: new Date(),
      });

      const { useCase, saleorClient } = buildUseCase({ identityMap });

      const payload = buildUserPayload({
        type: "user.updated",
        fields: {
          [FIEF_SYNC_ORIGIN_KEY]: "saleor",
          /*
           * Wait — for T23 we are writing INTO Saleor. processingSide = "saleor".
           * Marker origin "saleor" === processingSide → loop. Skip even with fresh seq.
           */
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
      expect(saleorClient.metadataUpdateCalls).toHaveLength(0);
    });

    it("does NOT skip when marker absent (legacy / new event) — proceed with write", async () => {
      const { useCase, saleorClient } = buildUseCase();

      const payload = buildUserPayload({
        type: "user.created",
        fields: { first_name: "Bob" }, // no markers
      });

      const result = await useCase.execute({
        saleorApiUrl: SALEOR_URL,
        claimMapping: DEFAULT_CLAIM_MAPPING,
        payload,
      });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().kind).toBe("written");
      expect(saleorClient.metadataUpdateCalls).toHaveLength(1);
    });
  });

  describe("payload validation", () => {
    it("returns InvalidPayload err when data.id is missing or not a Fief uuid", async () => {
      const { useCase, saleorClient, identityMap } = buildUseCase();

      const result = await useCase.execute({
        saleorApiUrl: SALEOR_URL,
        claimMapping: DEFAULT_CLAIM_MAPPING,
        payload: {
          type: "user.created",
          eventId: "evt_bad",
          data: { email: "a@b.test" }, // no `id`
        },
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(UserUpsertUseCaseError.InvalidPayload);
      expect(saleorClient.customerCreateCalls).toHaveLength(0);
      expect(identityMap.upsertCallCount).toBe(0);
    });

    it("returns InvalidPayload err when data.email is missing", async () => {
      const { useCase } = buildUseCase();

      const result = await useCase.execute({
        saleorApiUrl: SALEOR_URL,
        claimMapping: DEFAULT_CLAIM_MAPPING,
        payload: {
          type: "user.updated",
          eventId: "evt_bad",
          data: { id: FIEF_USER_ID, fields: {} },
        },
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(UserUpsertUseCaseError.InvalidPayload);
    });
  });

  describe("error propagation", () => {
    it("propagates SaleorCustomerCreateFailed when create fails on cold path", async () => {
      const saleorClient = new FakeSaleorClient({ failCreate: true });
      const { useCase } = buildUseCase({ saleorClient });

      const result = await useCase.execute({
        saleorApiUrl: SALEOR_URL,
        claimMapping: DEFAULT_CLAIM_MAPPING,
        payload: buildUserPayload({ type: "user.created" }),
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        UserUpsertUseCaseError.SaleorCustomerCreateFailed,
      );
    });

    it("propagates IdentityMapWriteFailed when upsert fails", async () => {
      const identityMap = new FakeIdentityMapRepo();

      /*
       * Force upsert to fail by overriding the method directly. Using
       * `vi.spyOn(...).mockResolvedValueOnce(...)` chokes on the
       * `Result<X, never>` vs `Result<X, E>` variance — assigning the
       * method directly is the simplest workaround.
       */
      identityMap.upsert = async () => err(new IdentityMapRepoError("forced-upsert-failure"));

      const { useCase } = buildUseCase({ identityMap });

      const result = await useCase.execute({
        saleorApiUrl: SALEOR_URL,
        claimMapping: DEFAULT_CLAIM_MAPPING,
        payload: buildUserPayload({ type: "user.created" }),
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        UserUpsertUseCaseError.IdentityMapWriteFailed,
      );
    });

    it("propagates SaleorMetadataWriteFailed when metadata mutation fails", async () => {
      const saleorClient = new FakeSaleorClient({ failMetadataUpdate: true });
      const { useCase } = buildUseCase({ saleorClient });

      const result = await useCase.execute({
        saleorApiUrl: SALEOR_URL,
        claimMapping: DEFAULT_CLAIM_MAPPING,
        payload: buildUserPayload({ type: "user.created" }),
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        UserUpsertUseCaseError.SaleorMetadataWriteFailed,
      );
    });
  });
});
