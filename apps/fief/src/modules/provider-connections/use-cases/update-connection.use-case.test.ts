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
import { InMemoryProviderConnectionRepo } from "./in-memory-provider-connection-repo";
import { UpdateConnectionError, UpdateConnectionUseCase } from "./update-connection.use-case";

const FIEF_HOST = "https://fief.test";
const ADMIN_BASE = `${FIEF_HOST}/admin/api`;
const SALEOR_API_URL = "https://shop.example.com/graphql/" as SaleorApiUrl;

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const CLIENT_UUID = "00000000-0000-4000-8000-000000000002";
const WEBHOOK_UUID = "00000000-0000-4000-8000-000000000003";
const FIEF_CLIENT_ID_STR = "fief_client_id_abc";

const isoNow = () => new Date("2026-01-01T00:00:00Z").toISOString();

const buildFiefClient = () =>
  FiefAdminApiClient.create({
    baseUrl: FiefBaseUrlSchema.parse(FIEF_HOST),
    retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 5 },
  });

const seedConnection = async (repo: InMemoryProviderConnectionRepo, allowed: string[]) => {
  const seeded = await repo.create(SALEOR_API_URL, {
    saleorApiUrl: SALEOR_API_URL as never,
    name: createProviderConnectionName("Default"),
    fief: {
      baseUrl: createFiefBaseUrl(FIEF_HOST),
      tenantId: createFiefTenantId(TENANT_ID),
      /*
       * Use a Fief-style id (not necessarily UUID) for the OIDC client; the
       * brand only requires `min(1)`.
       */
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
      allowedOrigins: allowed.map((o) => createAllowedOrigin(o)) as AllowedOrigin[],
    },
    claimMapping: [],
  });

  return seeded._unsafeUnwrap();
};

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("UpdateConnectionUseCase — happy paths", () => {
  it("patches name without touching Fief", async () => {
    const repo = new InMemoryProviderConnectionRepo();
    const seeded = await seedConnection(repo, ["https://storefront.example.com"]);

    server.use(
      http.patch(`${ADMIN_BASE}/clients/${CLIENT_UUID}`, () =>
        HttpResponse.json({ detail: "should not be called" }, { status: 500 }),
      ),
    );

    const useCase = new UpdateConnectionUseCase({ repo, fiefAdmin: buildFiefClient() });
    const result = await useCase.execute({
      saleorApiUrl: SALEOR_API_URL,
      id: seeded.id,
      patch: { name: createProviderConnectionName("Renamed") },
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().name).toBe("Renamed");
  });

  it("patches Fief redirect_uris when allowedOrigins changes", async () => {
    const repo = new InMemoryProviderConnectionRepo();
    const seeded = await seedConnection(repo, ["https://storefront.example.com"]);

    let lastBody: { redirect_uris?: string[] } | null = null;

    server.use(
      http.patch(`${ADMIN_BASE}/clients/${CLIENT_UUID}`, async ({ request }) => {
        lastBody = (await request.json()) as { redirect_uris?: string[] };

        return HttpResponse.json(
          {
            id: CLIENT_UUID,
            created_at: isoNow(),
            updated_at: isoNow(),
            name: "OwlBooks",
            first_party: true,
            client_type: "confidential",
            client_id: FIEF_CLIENT_ID_STR,
            client_secret: "fief_client_secret_xyz",
            redirect_uris: lastBody.redirect_uris,
            authorization_code_lifetime_seconds: 600,
            access_id_token_lifetime_seconds: 3600,
            refresh_token_lifetime_seconds: 86400,
            tenant_id: TENANT_ID,
          },
          { status: 200 },
        );
      }),
    );

    const useCase = new UpdateConnectionUseCase({ repo, fiefAdmin: buildFiefClient() });
    const result = await useCase.execute({
      saleorApiUrl: SALEOR_API_URL,
      id: seeded.id,
      patch: {
        branding: {
          allowedOrigins: [
            createAllowedOrigin("https://storefront.example.com"),
            createAllowedOrigin("https://shop2.example.com"),
          ] as AllowedOrigin[],
        },
      },
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().branding.allowedOrigins).toHaveLength(2);
    expect(lastBody).not.toBeNull();
    expect(lastBody!.redirect_uris).toStrictEqual([
      "https://storefront.example.com",
      "https://shop2.example.com",
    ]);
  });

  it("does NOT call Fief if allowedOrigins is unchanged (deep equal)", async () => {
    const repo = new InMemoryProviderConnectionRepo();
    const seeded = await seedConnection(repo, [
      "https://storefront.example.com",
      "https://shop2.example.com",
    ]);

    let calls = 0;

    server.use(
      http.patch(`${ADMIN_BASE}/clients/${CLIENT_UUID}`, () => {
        calls += 1;

        return HttpResponse.json({}, { status: 500 });
      }),
    );

    const useCase = new UpdateConnectionUseCase({ repo, fiefAdmin: buildFiefClient() });
    const result = await useCase.execute({
      saleorApiUrl: SALEOR_API_URL,
      id: seeded.id,
      patch: {
        // Reordered but identical content.
        branding: {
          allowedOrigins: [
            createAllowedOrigin("https://shop2.example.com"),
            createAllowedOrigin("https://storefront.example.com"),
          ] as AllowedOrigin[],
        },
      },
    });

    expect(result.isOk()).toBe(true);
    expect(calls).toBe(0);
  });
});

describe("UpdateConnectionUseCase — failure modes", () => {
  it("returns NotFound when the connection does not exist", async () => {
    const repo = new InMemoryProviderConnectionRepo();
    const useCase = new UpdateConnectionUseCase({ repo, fiefAdmin: buildFiefClient() });

    const result = await useCase.execute({
      saleorApiUrl: SALEOR_API_URL,
      id: createProviderConnectionId("00000000-0000-4000-8000-000000000099"),
      patch: { name: createProviderConnectionName("nope") },
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(UpdateConnectionError.NotFound);
  });

  it("returns FiefSyncFailed when the Fief redirect_uris patch fails", async () => {
    const repo = new InMemoryProviderConnectionRepo();
    const seeded = await seedConnection(repo, ["https://storefront.example.com"]);

    server.use(
      http.patch(`${ADMIN_BASE}/clients/${CLIENT_UUID}`, () =>
        HttpResponse.json({ detail: "redirect uri rejected" }, { status: 400 }),
      ),
    );

    const useCase = new UpdateConnectionUseCase({ repo, fiefAdmin: buildFiefClient() });
    const result = await useCase.execute({
      saleorApiUrl: SALEOR_API_URL,
      id: seeded.id,
      patch: {
        branding: {
          allowedOrigins: [createAllowedOrigin("https://other.example.com")] as AllowedOrigin[],
        },
      },
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(UpdateConnectionError.FiefSyncFailed);
  });
});
