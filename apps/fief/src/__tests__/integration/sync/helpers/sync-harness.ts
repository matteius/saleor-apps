// cspell:ignore opensensor dedup

/**
 * @vitest-environment node
 *
 * T41 — shared sync-suite harness.
 *
 * Builds on `__tests__/integration/auth/harness.ts` (T40) with the bits the
 * sync suites need:
 *
 *   - `signFiefWebhook(...)` — produce a valid Fief webhook delivery
 *      (matching `opensensor-fief/fief/services/webhooks/delivery.py`'s
 *      `f"{ts}.{payload}"` HMAC-SHA256 hex contract).
 *   - `installFiefAdminMock(...)` — msw handlers covering `iterateUsers`,
 *      `createUser`, `getUser`, `updateUser` for a tenant base url.
 *   - `setupSaleorWebhookSdkMock(...)` — replace the SaleorAsyncWebhook SDK
 *      adapter so the saleor-to-fief webhook routes can be invoked with a
 *      synthetic ctx (the SDK auto-runs JWKS verification and we don't
 *      want to stand JWKS up here — the dedicated `verify-signature.test.ts`
 *      suite covers crypto).
 *   - `createInMemorySaleorClient` / `createInMemorySaleorDeactivateClient`
 *      — fake T7 write surfaces that record calls and let us simulate
 *      Saleor's CUSTOMER_UPDATED echo.
 *   - `seedIdentityMapRow` — seed an identity_map binding deterministically.
 *
 * No production code changes here. Everything is test infrastructure.
 */

import * as crypto from "node:crypto";

import { http, HttpResponse } from "msw";
import { type SetupServerApi } from "msw/node";
import { ok } from "neverthrow";

import {
  createSaleorUserId,
  createSyncSeq,
  type FiefUserId,
  type SaleorApiUrl,
  type SaleorUserId,
} from "@/modules/identity-map/identity-map";
import { type SaleorCustomerDeactivateClient } from "@/modules/sync/fief-to-saleor/user-delete.use-case";
import { type SaleorCustomerClient } from "@/modules/sync/fief-to-saleor/user-upsert.use-case";

/*
 * -------- Fief webhook signing ----------------------------------------------
 */

const hmacHex = (secret: string, message: string): string =>
  crypto.createHmac("sha256", Buffer.from(secret, "utf-8")).update(message, "utf-8").digest("hex");

export interface SignedFiefWebhook {
  body: string;
  signature: string;
  timestamp: string;
}

/**
 * Sign a Fief webhook delivery. Mirrors the wire format documented in T22
 * (`opensensor-fief/fief/services/webhooks/delivery.py`):
 *   - body: `JSON.stringify({ type, data })`
 *   - timestamp: integer seconds-since-epoch as a decimal string
 *   - signature: hex(`HMAC-SHA256(secret, "{timestamp}.{body}")`)
 */
export const signFiefWebhook = (args: {
  secret: string;
  type: string;
  data: Record<string, unknown>;
  timestamp?: number;
}): SignedFiefWebhook => {
  const body = JSON.stringify({ type: args.type, data: args.data });
  const timestamp = String(args.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = hmacHex(args.secret, `${timestamp}.${body}`);

  return { body, signature, timestamp };
};

/*
 * -------- Fief admin API mock (msw) -----------------------------------------
 *
 * The saleor-to-fief use cases (T26-T28) call:
 *   - `iterateUsers(adminToken, { extra: { email } })` — paginated GET on
 *      `/admin/api/users/?email=...`
 *   - `createUser(adminToken, { email, password, ... })` — POST on
 *      `/admin/api/users/`
 *   - `updateUser(adminToken, fiefUserId, patch)` — PATCH on
 *      `/admin/api/users/{id}`
 *
 * `getUser` is also wired for T25-style flows, though T41 keeps that
 * surface light because permission/role events are exercised via the Fief
 * webhook receiver path.
 */

interface FiefMockUser {
  id: string;
  email: string;
  is_active: boolean;
  email_verified: boolean;
  tenant_id: string;
  created_at: string;
  updated_at: string;
  fields: Record<string, unknown>;
}

export interface FiefAdminMockHandle {
  /** All users currently visible via the admin API mock. */
  users: Map<string, FiefMockUser>;
  createUserCalls: number;
  updateUserCalls: number;
  getUserCalls: number;
  iterateUserCalls: number;
  /**
   * Seed a Fief user (e.g. to simulate a pre-existing email-collision in
   * T26). Returns the seeded user.
   */
  seedUser(input: Partial<FiefMockUser> & { email: string }): FiefMockUser;
  reset(): void;
}

const isoNow = () => new Date().toISOString();

export const installFiefAdminMock = (
  server: SetupServerApi,
  baseUrl: string,
  tenantId: string,
): FiefAdminMockHandle => {
  const handle: FiefAdminMockHandle = {
    users: new Map<string, FiefMockUser>(),
    createUserCalls: 0,
    updateUserCalls: 0,
    getUserCalls: 0,
    iterateUserCalls: 0,
    seedUser: (input) => {
      const id = input.id ?? crypto.randomUUID();
      const user: FiefMockUser = {
        id,
        email: input.email,
        is_active: input.is_active ?? true,
        email_verified: input.email_verified ?? true,
        tenant_id: input.tenant_id ?? tenantId,
        created_at: input.created_at ?? isoNow(),
        updated_at: input.updated_at ?? isoNow(),
        fields: input.fields ?? {},
      };

      handle.users.set(id, user);

      return user;
    },
    reset: () => {
      handle.users.clear();
      handle.createUserCalls = 0;
      handle.updateUserCalls = 0;
      handle.getUserCalls = 0;
      handle.iterateUserCalls = 0;
    },
  };

  server.use(
    http.get(`${baseUrl}/admin/api/users/`, ({ request }) => {
      handle.iterateUserCalls += 1;
      const url = new URL(request.url);
      const email = url.searchParams.get("email");

      const allUsers = Array.from(handle.users.values());
      const filtered = email
        ? allUsers.filter((u) => u.email.toLowerCase() === email.toLowerCase())
        : allUsers;

      return HttpResponse.json({ count: filtered.length, results: filtered });
    }),

    http.get(`${baseUrl}/admin/api/users/:id`, ({ params }) => {
      handle.getUserCalls += 1;
      const id = String(params.id);
      const user = handle.users.get(id);

      if (!user) {
        return HttpResponse.json({ detail: "Not Found" }, { status: 404 });
      }

      return HttpResponse.json(user);
    }),

    http.post(`${baseUrl}/admin/api/users/`, async ({ request }) => {
      handle.createUserCalls += 1;
      const body = (await request.json()) as Record<string, unknown>;
      const id = crypto.randomUUID();
      const user: FiefMockUser = {
        id,
        email: String(body.email),
        is_active: typeof body.is_active === "boolean" ? body.is_active : true,
        email_verified: typeof body.email_verified === "boolean" ? body.email_verified : false,
        tenant_id: typeof body.tenant_id === "string" ? body.tenant_id : tenantId,
        created_at: isoNow(),
        updated_at: isoNow(),
        fields: (body.fields as Record<string, unknown> | undefined) ?? {},
      };

      handle.users.set(id, user);

      return HttpResponse.json(user, { status: 201 });
    }),

    http.patch(`${baseUrl}/admin/api/users/:id`, async ({ params, request }) => {
      handle.updateUserCalls += 1;
      const id = String(params.id);
      const existing = handle.users.get(id);

      if (!existing) {
        return HttpResponse.json({ detail: "Not Found" }, { status: 404 });
      }

      const patch = (await request.json()) as Record<string, unknown>;
      const updated: FiefMockUser = {
        ...existing,
        ...(typeof patch.email === "string" ? { email: patch.email } : {}),
        ...(typeof patch.is_active === "boolean" ? { is_active: patch.is_active } : {}),
        ...(typeof patch.email_verified === "boolean"
          ? { email_verified: patch.email_verified }
          : {}),
        fields: {
          ...existing.fields,
          ...((patch.fields as Record<string, unknown> | undefined) ?? {}),
        },
        updated_at: isoNow(),
      };

      handle.users.set(id, updated);

      return HttpResponse.json(updated);
    }),
  );

  return handle;
};

/*
 * -------- Saleor write surface fakes ----------------------------------------
 *
 * The composition root (`src/lib/composition-root.ts`) ships with a
 * placeholder `SaleorCustomerClient` that throws on any call. The sync
 * tests need a recording fake so we can assert which writes the use cases
 * issued. We also need a `SaleorCustomerDeactivateClient` for T24.
 */

export interface SaleorClientTrace {
  customerCreateCount: number;
  updateMetadataCount: number;
  updatePrivateMetadataCount: number;
  customerUpdateCount: number;
  /** Last metadata items seen by `updateMetadata`. */
  lastMetadataItems: Array<{ key: string; value: string }>;
  /** Last metadata items seen by `updatePrivateMetadata`. */
  lastPrivateMetadataItems: Array<{ key: string; value: string }>;
  /** Last `isActive` value seen by `customerUpdate`. */
  lastIsActive: boolean | undefined;
  /** Sequence of customer creates (one per call). */
  creates: Array<{ email: string; saleorUserId: SaleorUserId }>;
}

export interface InMemorySaleorClient extends SaleorCustomerClient {
  trace: SaleorClientTrace;
  reset(): void;
}

/**
 * Build the full Fief→Saleor client (used by T23/T25). Records every call
 * and mints a deterministic `saleorUserId` per email.
 */
export const createInMemorySaleorClient = (): InMemorySaleorClient => {
  const trace: SaleorClientTrace = {
    customerCreateCount: 0,
    updateMetadataCount: 0,
    updatePrivateMetadataCount: 0,
    customerUpdateCount: 0,
    lastMetadataItems: [],
    lastPrivateMetadataItems: [],
    lastIsActive: undefined,
    creates: [],
  };

  /*
   * Saleor user ids in production are base64-encoded `User:N` strings.
   * The id MUST satisfy `createSaleorUserId(...)`. We use a counter so
   * each `customerCreate` returns a distinct row.
   */
  let counter = 1;

  return {
    trace,
    reset() {
      trace.customerCreateCount = 0;
      trace.updateMetadataCount = 0;
      trace.updatePrivateMetadataCount = 0;
      trace.customerUpdateCount = 0;
      trace.lastMetadataItems = [];
      trace.lastPrivateMetadataItems = [];
      trace.lastIsActive = undefined;
      trace.creates = [];
    },
    async customerCreate(input) {
      trace.customerCreateCount += 1;
      const id = `VXNlcjo${counter}`;

      counter += 1;
      const branded = createSaleorUserId(id);

      if (branded.isErr()) {
        // Should be impossible — the brand accepts any non-empty string.
        throw branded.error;
      }
      const saleorUserId = branded.value;

      trace.creates.push({ email: input.email, saleorUserId });

      return ok({ saleorUserId, email: input.email });
    },
    async updateMetadata(input) {
      trace.updateMetadataCount += 1;
      trace.lastMetadataItems = [...input.items];

      return ok(undefined);
    },
    async updatePrivateMetadata(input) {
      trace.updatePrivateMetadataCount += 1;
      trace.lastPrivateMetadataItems = [...input.items];

      return ok(undefined);
    },
  };
};

export interface InMemorySaleorDeactivateClient extends SaleorCustomerDeactivateClient {
  trace: SaleorClientTrace;
  reset(): void;
}

/** Fake T24 deactivate-only client. */
export const createInMemorySaleorDeactivateClient = (): InMemorySaleorDeactivateClient => {
  const trace: SaleorClientTrace = {
    customerCreateCount: 0,
    updateMetadataCount: 0,
    updatePrivateMetadataCount: 0,
    customerUpdateCount: 0,
    lastMetadataItems: [],
    lastPrivateMetadataItems: [],
    lastIsActive: undefined,
    creates: [],
  };

  return {
    trace,
    reset() {
      trace.customerCreateCount = 0;
      trace.updateMetadataCount = 0;
      trace.updatePrivateMetadataCount = 0;
      trace.customerUpdateCount = 0;
      trace.lastMetadataItems = [];
      trace.lastPrivateMetadataItems = [];
      trace.lastIsActive = undefined;
      trace.creates = [];
    },
    async customerUpdate(input) {
      trace.customerUpdateCount += 1;
      trace.lastIsActive = input.isActive;

      return ok(undefined);
    },
    async updateMetadata(input) {
      trace.updateMetadataCount += 1;
      trace.lastMetadataItems = [...input.items];

      return ok(undefined);
    },
  };
};

/*
 * -------- identity_map seeder -----------------------------------------------
 *
 * Some tests (loop-prevention, T19↔T22 race) need to pre-seed the
 * identity_map row to simulate a race winner.
 */

export const seedIdentityMapRow = async (args: {
  saleorApiUrl: SaleorApiUrl;
  saleorUserId: SaleorUserId;
  fiefUserId: FiefUserId;
  syncSeq?: number;
}): Promise<void> => {
  const { MongoIdentityMapRepo } = await import(
    "@/modules/identity-map/repositories/mongodb/mongodb-identity-map-repo"
  );
  const repo = new MongoIdentityMapRepo();
  const seq = createSyncSeq(args.syncSeq ?? 1);

  if (seq.isErr()) {
    throw seq.error;
  }

  const result = await repo.upsert({
    saleorApiUrl: args.saleorApiUrl,
    saleorUserId: args.saleorUserId,
    fiefUserId: args.fiefUserId,
    syncSeq: seq.value,
  });

  if (result.isErr()) {
    throw result.error;
  }
};
