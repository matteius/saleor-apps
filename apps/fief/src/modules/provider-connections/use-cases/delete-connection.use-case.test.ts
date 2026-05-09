// @vitest-environment node

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { FiefAdminApiClient } from "@/modules/fief-client/admin-api-client";
import { FiefBaseUrlSchema } from "@/modules/fief-client/admin-api-types";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import {
  type AllowedOrigin,
  createAllowedOrigin,
  createFiefBaseUrl,
  createFiefClientId,
  createFiefTenantId,
  createFiefWebhookId,
  createProviderConnectionId,
  createProviderConnectionName,
} from "../provider-connection";
import { DeleteConnectionError, DeleteConnectionUseCase } from "./delete-connection.use-case";
import { InMemoryProviderConnectionRepo } from "./in-memory-provider-connection-repo";

const FIEF_HOST = "https://fief.test";
const ADMIN_BASE = `${FIEF_HOST}/admin/api`;
const SALEOR_API_URL = "https://shop.example.com/graphql/" as SaleorApiUrl;

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const CLIENT_UUID = "00000000-0000-4000-8000-000000000002";
const WEBHOOK_UUID = "00000000-0000-4000-8000-000000000003";

const buildFiefClient = () =>
  FiefAdminApiClient.create({
    baseUrl: FiefBaseUrlSchema.parse(FIEF_HOST),
    retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 5 },
  });

const seed = async (repo: InMemoryProviderConnectionRepo) => {
  const created = await repo.create(SALEOR_API_URL, {
    saleorApiUrl: SALEOR_API_URL as never,
    name: createProviderConnectionName("Default"),
    fief: {
      baseUrl: createFiefBaseUrl(FIEF_HOST),
      tenantId: createFiefTenantId(TENANT_ID),
      clientId: createFiefClientId(CLIENT_UUID),
      webhookId: createFiefWebhookId(WEBHOOK_UUID),
      clientSecret: "current-client-secret",
      pendingClientSecret: null,
      adminToken: "admin-token-plaintext",
      webhookSecret: "current-webhook-secret",
      pendingWebhookSecret: null,
    },
    branding: {
      signingKey: "deadbeef".repeat(8),
      allowedOrigins: [createAllowedOrigin("https://storefront.example.com")] as AllowedOrigin[],
    },
    claimMapping: [],
  });

  return created._unsafeUnwrap();
};

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("DeleteConnectionUseCase — happy paths", () => {
  it("deletes Fief client + webhook, soft-deletes the connection (preserves doc + identity_map)", async () => {
    const repo = new InMemoryProviderConnectionRepo();
    const seeded = await seed(repo);

    let clientDeletes = 0;
    let webhookDeletes = 0;

    server.use(
      http.delete(`${ADMIN_BASE}/clients/${CLIENT_UUID}`, () => {
        clientDeletes += 1;

        return HttpResponse.text("", { status: 204 });
      }),
      http.delete(`${ADMIN_BASE}/webhooks/${WEBHOOK_UUID}`, () => {
        webhookDeletes += 1;

        return HttpResponse.text("", { status: 204 });
      }),
    );

    const useCase = new DeleteConnectionUseCase({ repo, fiefAdmin: buildFiefClient() });
    const result = await useCase.execute({ saleorApiUrl: SALEOR_API_URL, id: seeded.id });

    expect(result.isOk()).toBe(true);
    expect(clientDeletes).toBe(1);
    expect(webhookDeletes).toBe(1);

    // The connection persists but is soft-deleted (identity_map preserved).
    const peeked = repo.peek(seeded.id);

    expect(peeked).toBeDefined();
    expect(peeked!.softDeletedAt).not.toBeNull();

    // Default get() excludes soft-deleted.
    const refetch = await repo.get({ saleorApiUrl: SALEOR_API_URL, id: seeded.id });

    expect(refetch.isErr()).toBe(true);
  });

  it("treats Fief 404s on client / webhook as success (idempotent re-delete)", async () => {
    const repo = new InMemoryProviderConnectionRepo();
    const seeded = await seed(repo);

    server.use(
      http.delete(`${ADMIN_BASE}/clients/${CLIENT_UUID}`, () =>
        HttpResponse.json({ detail: "already gone" }, { status: 404 }),
      ),
      http.delete(`${ADMIN_BASE}/webhooks/${WEBHOOK_UUID}`, () =>
        HttpResponse.json({ detail: "already gone" }, { status: 404 }),
      ),
    );

    const useCase = new DeleteConnectionUseCase({ repo, fiefAdmin: buildFiefClient() });
    const result = await useCase.execute({ saleorApiUrl: SALEOR_API_URL, id: seeded.id });

    expect(result.isOk()).toBe(true);
  });
});

describe("DeleteConnectionUseCase — failure modes", () => {
  it("returns NotFound when the connection does not exist", async () => {
    const repo = new InMemoryProviderConnectionRepo();
    const useCase = new DeleteConnectionUseCase({ repo, fiefAdmin: buildFiefClient() });

    const result = await useCase.execute({
      saleorApiUrl: SALEOR_API_URL,
      id: createProviderConnectionId("00000000-0000-4000-8000-0000000000ff"),
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(DeleteConnectionError.NotFound);
  });

  it("aborts the soft-delete if Fief client delete fails with non-404 (no orphan Fief client)", async () => {
    const repo = new InMemoryProviderConnectionRepo();
    const seeded = await seed(repo);

    server.use(
      http.delete(`${ADMIN_BASE}/clients/${CLIENT_UUID}`, () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );

    const useCase = new DeleteConnectionUseCase({ repo, fiefAdmin: buildFiefClient() });
    const result = await useCase.execute({ saleorApiUrl: SALEOR_API_URL, id: seeded.id });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(
      DeleteConnectionError.FiefDeprovisioningFailed,
    );

    // Local connection is still active.
    const refetch = await repo.get({ saleorApiUrl: SALEOR_API_URL, id: seeded.id });

    expect(refetch.isOk()).toBe(true);
    expect(refetch._unsafeUnwrap().softDeletedAt).toBeNull();
  });
});
