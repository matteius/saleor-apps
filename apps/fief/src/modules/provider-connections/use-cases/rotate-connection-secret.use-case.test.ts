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
  createProviderConnectionName,
} from "../provider-connection";
import { InMemoryProviderConnectionRepo } from "./in-memory-provider-connection-repo";
import {
  RotateConnectionSecretError,
  RotateConnectionSecretUseCase,
} from "./rotate-connection-secret.use-case";

const FIEF_HOST = "https://fief.test";
const ADMIN_BASE = `${FIEF_HOST}/admin/api`;
const SALEOR_API_URL = "https://shop.example.com/graphql/" as SaleorApiUrl;

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const CLIENT_UUID = "00000000-0000-4000-8000-000000000002";
const WEBHOOK_UUID = "00000000-0000-4000-8000-000000000003";

const isoNow = () => new Date("2026-01-01T00:00:00Z").toISOString();

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

const stubWebhookRotate = (newSecret: string) =>
  http.post(`${ADMIN_BASE}/webhooks/${WEBHOOK_UUID}/secret`, () =>
    HttpResponse.json(
      {
        id: WEBHOOK_UUID,
        created_at: isoNow(),
        updated_at: isoNow(),
        url: "https://app.example.com/api/webhooks/fief?connectionId=x",
        events: ["user.created"],
        secret: newSecret,
      },
      { status: 201 },
    ),
  );

describe("RotateConnectionSecretUseCase — full lifecycle", () => {
  it("initiate then confirm: pending→current promotion clears pending, both webhook + client secret rolled", async () => {
    const repo = new InMemoryProviderConnectionRepo();
    const connection = await seed(repo);

    server.use(stubWebhookRotate("wh_secret_NEW"));

    const useCase = new RotateConnectionSecretUseCase({
      repo,
      fiefAdmin: buildFiefClient(),
    });

    /* --- Initiate. --- */
    const initiateResult = await useCase.initiateRotation({
      saleorApiUrl: SALEOR_API_URL,
      id: connection.id,
      clientSecretSource: { mode: "operator-supplied", newClientSecret: "client_secret_NEW" },
    });

    expect(initiateResult.isOk()).toBe(true);
    const initiated = initiateResult._unsafeUnwrap();

    expect(initiated.newWebhookSecretPlaintext).toBe("wh_secret_NEW");
    expect(initiated.connection.fief.encryptedPendingClientSecret).not.toBeNull();
    expect(initiated.connection.fief.encryptedPendingWebhookSecret).not.toBeNull();

    /* During the rotation window: BOTH secrets must be readable. */
    const decryptedDuring = (
      await repo.getDecryptedSecrets({ saleorApiUrl: SALEOR_API_URL, id: connection.id })
    )._unsafeUnwrap();

    expect(decryptedDuring.fief.clientSecret).toBe("current-client-secret");
    expect(decryptedDuring.fief.pendingClientSecret).toBe("client_secret_NEW");
    expect(decryptedDuring.fief.webhookSecret).toBe("current-webhook-secret");
    expect(decryptedDuring.fief.pendingWebhookSecret).toBe("wh_secret_NEW");

    /* --- Confirm. --- */
    const confirmResult = await useCase.confirmRotation({
      saleorApiUrl: SALEOR_API_URL,
      id: connection.id,
    });

    expect(confirmResult.isOk()).toBe(true);
    const confirmed = confirmResult._unsafeUnwrap();

    expect(confirmed.fief.encryptedPendingClientSecret).toBeNull();
    expect(confirmed.fief.encryptedPendingWebhookSecret).toBeNull();

    const decryptedAfter = (
      await repo.getDecryptedSecrets({ saleorApiUrl: SALEOR_API_URL, id: connection.id })
    )._unsafeUnwrap();

    expect(decryptedAfter.fief.clientSecret).toBe("client_secret_NEW");
    expect(decryptedAfter.fief.pendingClientSecret).toBeNull();
    expect(decryptedAfter.fief.webhookSecret).toBe("wh_secret_NEW");
    expect(decryptedAfter.fief.pendingWebhookSecret).toBeNull();
  });

  it("initiate with locally-generated client secret produces hex pending value without operator input", async () => {
    const repo = new InMemoryProviderConnectionRepo();
    const connection = await seed(repo);

    server.use(stubWebhookRotate("wh_secret_NEW2"));

    const useCase = new RotateConnectionSecretUseCase({
      repo,
      fiefAdmin: buildFiefClient(),
      randomBytesImpl: (n) => Buffer.alloc(n, 0xcd),
    });

    const result = await useCase.initiateRotation({
      saleorApiUrl: SALEOR_API_URL,
      id: connection.id,
      clientSecretSource: { mode: "locally-generated" },
    });

    expect(result.isOk()).toBe(true);

    const decrypted = (
      await repo.getDecryptedSecrets({ saleorApiUrl: SALEOR_API_URL, id: connection.id })
    )._unsafeUnwrap();

    expect(decrypted.fief.pendingClientSecret).toBe("cd".repeat(32));
  });
});

describe("RotateConnectionSecretUseCase — guards + failure modes", () => {
  it("rejects a second initiateRotation when one is already in progress", async () => {
    const repo = new InMemoryProviderConnectionRepo();
    const connection = await seed(repo);

    server.use(stubWebhookRotate("wh_secret_NEW3"));

    const useCase = new RotateConnectionSecretUseCase({
      repo,
      fiefAdmin: buildFiefClient(),
    });

    const first = await useCase.initiateRotation({
      saleorApiUrl: SALEOR_API_URL,
      id: connection.id,
      clientSecretSource: { mode: "operator-supplied", newClientSecret: "first" },
    });

    expect(first.isOk()).toBe(true);

    const second = await useCase.initiateRotation({
      saleorApiUrl: SALEOR_API_URL,
      id: connection.id,
      clientSecretSource: { mode: "operator-supplied", newClientSecret: "second" },
    });

    expect(second.isErr()).toBe(true);
    expect(second._unsafeUnwrapErr()).toBeInstanceOf(RotateConnectionSecretError.AlreadyRotating);
  });

  it("returns NoPendingRotation when confirmRotation is called without an open rotation", async () => {
    const repo = new InMemoryProviderConnectionRepo();
    const connection = await seed(repo);

    const useCase = new RotateConnectionSecretUseCase({
      repo,
      fiefAdmin: buildFiefClient(),
    });

    const result = await useCase.confirmRotation({
      saleorApiUrl: SALEOR_API_URL,
      id: connection.id,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(RotateConnectionSecretError.NoPendingRotation);
  });

  it("returns FiefSyncFailed when Fief webhook rotate fails", async () => {
    const repo = new InMemoryProviderConnectionRepo();
    const connection = await seed(repo);

    server.use(
      http.post(`${ADMIN_BASE}/webhooks/${WEBHOOK_UUID}/secret`, () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );

    const useCase = new RotateConnectionSecretUseCase({
      repo,
      fiefAdmin: buildFiefClient(),
    });

    const result = await useCase.initiateRotation({
      saleorApiUrl: SALEOR_API_URL,
      id: connection.id,
      clientSecretSource: { mode: "operator-supplied", newClientSecret: "nope" },
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(RotateConnectionSecretError.FiefSyncFailed);
  });

  it("returns InvalidInput when operator-supplied newClientSecret is empty", async () => {
    const repo = new InMemoryProviderConnectionRepo();
    const connection = await seed(repo);

    server.use(stubWebhookRotate("wh_secret_NEW4"));

    const useCase = new RotateConnectionSecretUseCase({
      repo,
      fiefAdmin: buildFiefClient(),
    });

    const result = await useCase.initiateRotation({
      saleorApiUrl: SALEOR_API_URL,
      id: connection.id,
      clientSecretSource: { mode: "operator-supplied", newClientSecret: "" },
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(RotateConnectionSecretError.InvalidInput);
  });
});
