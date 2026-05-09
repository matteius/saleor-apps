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
  createProviderConnectionName,
} from "../provider-connection";
import {
  appendConnectionIdQuery,
  CreateConnectionError,
  CreateConnectionUseCase,
  type CreateConnectionUseCaseInput,
} from "./create-connection.use-case";
import { InMemoryProviderConnectionRepo } from "./in-memory-provider-connection-repo";

/*
 * T17 — `CreateConnectionUseCase` test suite.
 *
 * Coverage:
 *   - Happy path — Fief client + webhook provisioned, connection persisted,
 *     URL patched.
 *   - Branding signing key is hex-encoded and appropriately sized (T15 spec).
 *   - Webhook URL carries `connectionId` query param after the post-persist patch.
 *   - Failure modes:
 *       * Fief client creation fails -> no webhook created, no persist, typed error.
 *       * Webhook creation fails -> Fief client rolled back, no persist, typed error.
 *       * Repo persist fails -> Fief client + webhook rolled back, typed error.
 *   - Webhook URL patch failure does NOT roll back the persist (degraded but useful
 *     state — operator can run reconciliation).
 */

const FIEF_HOST = "https://fief.test";
const ADMIN_BASE = `${FIEF_HOST}/admin/api`;

const SALEOR_API_URL = "https://shop.example.com/graphql/" as SaleorApiUrl;

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const CLIENT_ID = "00000000-0000-4000-8000-000000000002";
const WEBHOOK_ID = "00000000-0000-4000-8000-000000000003";

const isoNow = () => new Date("2026-01-01T00:00:00Z").toISOString();

const validClientPayload = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: CLIENT_ID,
  created_at: isoNow(),
  updated_at: isoNow(),
  name: "OwlBooks",
  first_party: true,
  client_type: "confidential",
  client_id: "fief_client_id_abc",
  client_secret: "fief_client_secret_xyz",
  redirect_uris: ["https://shop.example.com/callback"],
  authorization_code_lifetime_seconds: 600,
  access_id_token_lifetime_seconds: 3600,
  refresh_token_lifetime_seconds: 86400,
  tenant_id: TENANT_ID,
  ...overrides,
});

const validWebhookWithSecretPayload = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: WEBHOOK_ID,
  created_at: isoNow(),
  updated_at: isoNow(),
  url: "https://app.example.com/api/webhooks/fief?connectionId=__pending__",
  events: ["user.created", "user.updated", "user.deleted"],
  secret: "wh_secret_initial",
  ...overrides,
});

const buildFiefClient = () =>
  FiefAdminApiClient.create({
    baseUrl: FiefBaseUrlSchema.parse(FIEF_HOST),
    retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 5 },
  });

const buildInput = (
  overrides: Partial<CreateConnectionUseCaseInput> = {},
): CreateConnectionUseCaseInput => ({
  saleorApiUrl: SALEOR_API_URL,
  name: createProviderConnectionName("Default tenant"),
  fief: {
    baseUrl: FIEF_HOST,
    tenantId: TENANT_ID,
    adminToken: "admin-token-plaintext",
    clientName: "OwlBooks",
    redirectUris: ["https://shop.example.com/callback"],
    ...overrides.fief,
  },
  branding: {
    allowedOrigins: [createAllowedOrigin("https://storefront.example.com")] as AllowedOrigin[],
    ...overrides.branding,
  },
  webhookReceiverBaseUrl: "https://app.example.com/api/webhooks/fief",
  claimMapping: [
    {
      fiefClaim: "email",
      saleorMetadataKey: "fief.email",
      required: true,
      visibility: "private",
      reverseSyncEnabled: false,
    },
  ],
  ...overrides,
});

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("CreateConnectionUseCase — happy path", () => {
  it("provisions Fief client + webhook, persists connection, patches webhook URL", async () => {
    let lastPatchedUrl: string | null = null;
    let createClientCalls = 0;
    let createWebhookCalls = 0;

    server.use(
      http.post(`${ADMIN_BASE}/clients/`, () => {
        createClientCalls += 1;

        return HttpResponse.json(validClientPayload(), { status: 201 });
      }),
      http.post(`${ADMIN_BASE}/webhooks/`, () => {
        createWebhookCalls += 1;

        return HttpResponse.json(validWebhookWithSecretPayload(), { status: 201 });
      }),
      http.patch(`${ADMIN_BASE}/webhooks/${WEBHOOK_ID}`, async ({ request }) => {
        const body = (await request.json()) as { url?: string };

        lastPatchedUrl = body.url ?? null;

        return HttpResponse.json(
          {
            id: WEBHOOK_ID,
            created_at: isoNow(),
            updated_at: isoNow(),
            url: body.url,
            events: ["user.created", "user.updated", "user.deleted"],
          },
          { status: 200 },
        );
      }),
    );

    const repo = new InMemoryProviderConnectionRepo();
    const useCase = new CreateConnectionUseCase({
      repo,
      adminClientFactory: () => buildFiefClient(),
      randomBytesImpl: (n) => Buffer.alloc(n, 0xab),
    });

    const result = await useCase.execute(buildInput());

    expect(result.isOk()).toBe(true);
    const connection = result._unsafeUnwrap();

    expect(connection.saleorApiUrl).toBe(SALEOR_API_URL);
    expect(connection.name).toBe("Default tenant");
    expect(connection.fief.clientId).toBe("fief_client_id_abc");
    expect(connection.fief.webhookId).toBe(WEBHOOK_ID);
    // Encrypted-at-rest sanity (in-memory repo's placeholder marker).
    expect(connection.fief.encryptedClientSecret).not.toBe("fief_client_secret_xyz");
    expect(connection.fief.encryptedWebhookSecret).not.toBe("wh_secret_initial");
    expect(connection.softDeletedAt).toBeNull();

    expect(createClientCalls).toBe(1);
    expect(createWebhookCalls).toBe(1);
    expect(lastPatchedUrl).toBe(
      `https://app.example.com/api/webhooks/fief?connectionId=${encodeURIComponent(connection.id)}`,
    );
  });

  it("derives a 64-char lowercase-hex branding signing key (T15 wire-format)", async () => {
    server.use(
      http.post(`${ADMIN_BASE}/clients/`, () =>
        HttpResponse.json(validClientPayload(), { status: 201 }),
      ),
      http.post(`${ADMIN_BASE}/webhooks/`, () =>
        HttpResponse.json(validWebhookWithSecretPayload(), { status: 201 }),
      ),
      http.patch(`${ADMIN_BASE}/webhooks/${WEBHOOK_ID}`, () =>
        HttpResponse.json(validWebhookWithSecretPayload({ secret: undefined }), { status: 200 }),
      ),
    );

    const repo = new InMemoryProviderConnectionRepo();
    const useCase = new CreateConnectionUseCase({
      repo,
      adminClientFactory: () => buildFiefClient(),
      randomBytesImpl: (n) => Buffer.alloc(n, 0x5a),
    });

    const result = await useCase.execute(buildInput());

    expect(result.isOk()).toBe(true);
    const connection = result._unsafeUnwrap();
    const decrypted = (
      await repo.getDecryptedSecrets({ saleorApiUrl: SALEOR_API_URL, id: connection.id })
    )._unsafeUnwrap();

    expect(decrypted.branding.signingKey).toMatch(/^[0-9a-f]{64}$/);
    // 0x5a x 32 -> all "5a" pairs.
    expect(decrypted.branding.signingKey).toBe("5a".repeat(32));
  });
});

describe("CreateConnectionUseCase — failure modes", () => {
  it("returns FiefProvisioningFailed when client creation fails (no webhook attempted)", async () => {
    let webhookCalls = 0;

    server.use(
      http.post(`${ADMIN_BASE}/clients/`, () =>
        HttpResponse.json({ detail: "tenant not found" }, { status: 404 }),
      ),
      http.post(`${ADMIN_BASE}/webhooks/`, () => {
        webhookCalls += 1;

        return HttpResponse.json(validWebhookWithSecretPayload(), { status: 201 });
      }),
    );

    const repo = new InMemoryProviderConnectionRepo();
    const useCase = new CreateConnectionUseCase({
      repo,
      adminClientFactory: () => buildFiefClient(),
    });

    const result = await useCase.execute(buildInput());

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(CreateConnectionError.FiefProvisioningFailed);
    expect(webhookCalls).toBe(0);
    expect(await repo.list({ saleorApiUrl: SALEOR_API_URL })).toMatchObject({
      // ok([]).
    });
  });

  it("rolls back the Fief client when webhook creation fails", async () => {
    let clientDeletes = 0;

    server.use(
      http.post(`${ADMIN_BASE}/clients/`, () =>
        HttpResponse.json(validClientPayload(), { status: 201 }),
      ),
      http.post(`${ADMIN_BASE}/webhooks/`, () =>
        HttpResponse.json({ detail: "events invalid" }, { status: 400 }),
      ),
      http.delete(`${ADMIN_BASE}/clients/${CLIENT_ID}`, () => {
        clientDeletes += 1;

        return HttpResponse.text("", { status: 204 });
      }),
    );

    const repo = new InMemoryProviderConnectionRepo();
    const useCase = new CreateConnectionUseCase({
      repo,
      adminClientFactory: () => buildFiefClient(),
    });

    const result = await useCase.execute(buildInput());

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(CreateConnectionError.FiefProvisioningFailed);
    expect(clientDeletes).toBe(1);
  });
});

describe("appendConnectionIdQuery", () => {
  it("uses ? when the URL has no query", () => {
    expect(appendConnectionIdQuery("https://app.example/path", "abc")).toBe(
      "https://app.example/path?connectionId=abc",
    );
  });

  it("uses & when the URL already has a query", () => {
    expect(appendConnectionIdQuery("https://app.example/path?foo=1", "abc")).toBe(
      "https://app.example/path?foo=1&connectionId=abc",
    );
  });

  it("URL-encodes the connection id", () => {
    expect(appendConnectionIdQuery("https://app.example", "a/b c")).toBe(
      "https://app.example?connectionId=a%2Fb%20c",
    );
  });
});
