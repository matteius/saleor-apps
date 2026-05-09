/*
 * @vitest-environment node
 *
 * T34 — provider-connections tRPC router tests.
 *
 * Surface under test (sub-router mounted at `appRouter.connections`):
 *   - list           (read; redacts encrypted slots to booleans)
 *   - create         (write; delegates to CreateConnectionUseCase)
 *   - update         (write; delegates to UpdateConnectionUseCase)
 *   - rotateSecret   (write; delegates to RotateConnectionSecretUseCase.initiateRotation)
 *   - confirmRotation(write; delegates to RotateConnectionSecretUseCase.confirmRotation)
 *   - cancelRotation (write; delegates to RotateConnectionSecretUseCase.cancelRotation)
 *   - delete         (write; delegates to DeleteConnectionUseCase)
 *   - testConnection (read; exercises FiefOidcClient.prewarm + FiefAdminApiClient.listUsers)
 *
 * The use cases are mocked at the constructor seam so tests stay unit-scope
 * (no Mongo, no Fief HTTP). Listing redaction is verified by asserting the
 * shape returned to the caller has booleans for the encrypted slots and no
 * `encrypted*` strings nor any `Decrypted*` payload.
 */
import { ok } from "neverthrow";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "@/lib/logger";
import {
  type CreateConnectionUseCase,
  type CreateConnectionUseCaseInput,
} from "@/modules/provider-connections/use-cases/create-connection.use-case";
import {
  type DeleteConnectionUseCase,
  type DeleteConnectionUseCaseInput,
} from "@/modules/provider-connections/use-cases/delete-connection.use-case";
import {
  type CancelRotationInput,
  type ConfirmRotationInput,
  type InitiateRotationInput,
  type RotateConnectionSecretUseCase,
} from "@/modules/provider-connections/use-cases/rotate-connection-secret.use-case";
import {
  type UpdateConnectionUseCase,
  type UpdateConnectionUseCaseInput,
} from "@/modules/provider-connections/use-cases/update-connection.use-case";
import { createSaleorApiUrl, type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { type TrpcContextAppRouter } from "@/modules/trpc/context-app-router";

import {
  createAllowedOrigin,
  createFiefBaseUrl,
  createFiefClientId,
  createFiefTenantId,
  createFiefWebhookId,
  createProviderConnectionId,
  createProviderConnectionName,
  type ProviderConnection,
} from "./provider-connection";
import {
  type ProviderConnectionRepo,
  ProviderConnectionRepoError,
} from "./provider-connection-repo";

const SALEOR_API_URL_RAW = "https://shop-conn.saleor.cloud/graphql/";
const SALEOR_API_URL: SaleorApiUrl = createSaleorApiUrl(SALEOR_API_URL_RAW)._unsafeUnwrap();
const APP_ID = "app-id-test";
const APP_TOKEN = "apl-app-token";

const verifyJWTMock = vi.fn();
const aplGetMock = vi.fn();

vi.mock("@saleor/app-sdk/auth", () => ({
  verifyJWT: (...args: unknown[]) => verifyJWTMock(...args),
}));

vi.mock("@/lib/saleor-app", () => ({
  saleorApp: {
    apl: {
      get: (...args: unknown[]) => aplGetMock(...args),
    },
  },
}));

const buildCtx = (overrides: Partial<TrpcContextAppRouter> = {}): TrpcContextAppRouter => ({
  saleorApiUrl: SALEOR_API_URL_RAW,
  token: "frontend-jwt-irrelevant-because-mocked",
  appId: undefined,
  appUrl: null,
  logger: createLogger("test"),
  ...overrides,
});

const wireAuth = () => {
  aplGetMock.mockResolvedValue({
    saleorApiUrl: SALEOR_API_URL_RAW,
    appId: APP_ID,
    token: APP_TOKEN,
  });
  verifyJWTMock.mockResolvedValue(undefined);
};

const FIXED_ID_A = "11111111-1111-4111-8111-111111111111";
const FIXED_ID_B = "22222222-2222-4222-8222-222222222222";

const buildConnection = (overrides?: Partial<ProviderConnection>): ProviderConnection => {
  const id = overrides?.id ?? createProviderConnectionId(FIXED_ID_A);

  return {
    id,
    saleorApiUrl: SALEOR_API_URL,
    name: createProviderConnectionName("primary"),
    fief: {
      baseUrl: createFiefBaseUrl("https://tenant.fief.dev/"),
      tenantId: createFiefTenantId("tenant-1"),
      clientId: createFiefClientId("fief-client-id"),
      webhookId: createFiefWebhookId("hook-1"),
      /*
       * Brand cast — schema requires `min(1)` strings; the actual ciphertext
       * shape is opaque to consumers downstream of T4.
       */
      encryptedClientSecret: "enc:client" as ProviderConnection["fief"]["encryptedClientSecret"],
      encryptedPendingClientSecret: null,
      encryptedAdminToken: "enc:admin" as ProviderConnection["fief"]["encryptedAdminToken"],
      encryptedWebhookSecret: "enc:webhook" as ProviderConnection["fief"]["encryptedWebhookSecret"],
      encryptedPendingWebhookSecret: null,
    },
    branding: {
      encryptedSigningKey: "enc:signing" as ProviderConnection["branding"]["encryptedSigningKey"],
      allowedOrigins: [createAllowedOrigin("https://shop.example.com")],
    },
    claimMapping: [],
    softDeletedAt: null,
    ...(overrides ?? {}),
  };
};

interface RepoStubOverrides {
  list?: ProviderConnectionRepo["list"];
}

const buildRepoStub = (over: RepoStubOverrides = {}): ProviderConnectionRepo => ({
  list: over.list ?? (async () => ok([])),
  create: async () => {
    throw new Error("repo.create must not be called from tRPC — go via CreateConnectionUseCase");
  },
  get: async () => {
    throw new Error("repo.get not used in this test");
  },
  update: async () => {
    throw new Error("repo.update must not be called from tRPC — go via UpdateConnectionUseCase");
  },
  softDelete: async () => {
    throw new Error(
      "repo.softDelete must not be called from tRPC — go via DeleteConnectionUseCase",
    );
  },
  restore: async () => {
    throw new Error("repo.restore not used in this test");
  },
  getDecryptedSecrets: async () => {
    throw new Error("repo.getDecryptedSecrets must not be called from the tRPC layer");
  },
});

interface UseCaseStubs {
  createConnection: Pick<CreateConnectionUseCase, "execute">;
  updateConnection: Pick<UpdateConnectionUseCase, "execute">;
  rotateConnectionSecret: Pick<
    RotateConnectionSecretUseCase,
    "initiateRotation" | "confirmRotation" | "cancelRotation"
  >;
  deleteConnection: Pick<DeleteConnectionUseCase, "execute">;
}

interface OidcClientStub {
  prewarm: ReturnType<typeof vi.fn>;
}

interface AdminClientStub {
  listUsers: ReturnType<typeof vi.fn>;
}

interface BuildRouterDeps {
  repo?: ProviderConnectionRepo;
  useCases?: Partial<UseCaseStubs>;
  oidcClientFactory?: (input: { baseUrl: string }) => OidcClientStub;
  adminClientFactory?: (input: { baseUrl: string }) => AdminClientStub;
}

const buildRouter = async (deps: BuildRouterDeps = {}) => {
  const { buildConnectionsRouter } = await import("./trpc-router");

  const useCases: UseCaseStubs = {
    createConnection: {
      execute: vi
        .fn()
        .mockImplementation(async () =>
          ok(buildConnection()),
        ) as CreateConnectionUseCase["execute"],
    },
    updateConnection: {
      execute: vi
        .fn()
        .mockImplementation(async () =>
          ok(buildConnection()),
        ) as UpdateConnectionUseCase["execute"],
    },
    rotateConnectionSecret: {
      initiateRotation: vi.fn().mockImplementation(async () =>
        ok({
          connection: buildConnection(),
          newWebhookSecretPlaintext: "new-secret-shown-once",
        }),
      ) as RotateConnectionSecretUseCase["initiateRotation"],
      confirmRotation: vi
        .fn()
        .mockImplementation(async () =>
          ok(buildConnection()),
        ) as RotateConnectionSecretUseCase["confirmRotation"],
      cancelRotation: vi
        .fn()
        .mockImplementation(async () =>
          ok(buildConnection()),
        ) as RotateConnectionSecretUseCase["cancelRotation"],
    },
    deleteConnection: {
      execute: vi
        .fn()
        .mockImplementation(async () => ok(undefined)) as DeleteConnectionUseCase["execute"],
    },
    ...(deps.useCases ?? {}),
  };

  const router = buildConnectionsRouter({
    repo: deps.repo ?? buildRepoStub(),
    useCases: useCases as unknown as Parameters<typeof buildConnectionsRouter>[0]["useCases"],
    oidcClientFactory:
      (deps.oidcClientFactory as Parameters<
        typeof buildConnectionsRouter
      >[0]["oidcClientFactory"]) ??
      ((() => ({
        prewarm: vi.fn().mockResolvedValue(ok(undefined)),
      })) as Parameters<typeof buildConnectionsRouter>[0]["oidcClientFactory"]),
    adminClientFactory:
      (deps.adminClientFactory as Parameters<
        typeof buildConnectionsRouter
      >[0]["adminClientFactory"]) ??
      ((() => ({
        listUsers: vi.fn().mockResolvedValue(ok({ count: 0, results: [] })),
      })) as Parameters<typeof buildConnectionsRouter>[0]["adminClientFactory"]),
  });

  return { router, useCases };
};

afterEach(() => {
  verifyJWTMock.mockReset();
  aplGetMock.mockReset();
});

describe("connections tRPC router (T34)", () => {
  describe("auth", () => {
    it("rejects unauthenticated callers via protectedClientProcedure", async () => {
      aplGetMock.mockResolvedValueOnce(undefined);

      const { router } = await buildRouter();
      const caller = router.createCaller(buildCtx());

      await expect(caller.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });
  });

  describe("list", () => {
    it("returns connections for the install with encrypted slots redacted to presence booleans", async () => {
      wireAuth();

      const a = buildConnection({
        id: createProviderConnectionId(FIXED_ID_A),
        name: createProviderConnectionName("primary"),
      });
      const b = buildConnection({
        id: createProviderConnectionId(FIXED_ID_B),
        name: createProviderConnectionName("secondary"),
        fief: {
          ...buildConnection().fief,
          // pending slots present on this one to assert presence is reported truthy
          encryptedPendingClientSecret:
            "enc:pendingClient" as ProviderConnection["fief"]["encryptedClientSecret"],
          encryptedPendingWebhookSecret:
            "enc:pendingWebhook" as ProviderConnection["fief"]["encryptedWebhookSecret"],
        },
      });

      const repo = buildRepoStub({ list: async () => ok([a, b]) });
      const { router } = await buildRouter({ repo });
      const caller = router.createCaller(buildCtx());

      const result = await caller.list();

      expect(result).toHaveLength(2);

      // ----- Confirm redaction shape -----
      const stringified = JSON.stringify(result);

      expect(stringified).not.toContain("enc:client");
      expect(stringified).not.toContain("enc:admin");
      expect(stringified).not.toContain("enc:webhook");
      expect(stringified).not.toContain("enc:signing");
      expect(stringified).not.toContain("enc:pendingClient");
      expect(stringified).not.toContain("enc:pendingWebhook");

      // ----- Confirm presence booleans -----
      expect(result[0]).toMatchObject({
        id: FIXED_ID_A,
        name: "primary",
        secrets: {
          hasClientSecret: true,
          hasPendingClientSecret: false,
          hasAdminToken: true,
          hasWebhookSecret: true,
          hasPendingWebhookSecret: false,
          hasSigningKey: true,
        },
      });
      expect(result[1]).toMatchObject({
        id: FIXED_ID_B,
        name: "secondary",
        secrets: {
          hasPendingClientSecret: true,
          hasPendingWebhookSecret: true,
        },
      });

      // Public, non-secret fields preserved.
      expect(result[0].fief).toMatchObject({
        baseUrl: "https://tenant.fief.dev/",
        tenantId: "tenant-1",
        clientId: "fief-client-id",
        webhookId: "hook-1",
      });
      expect(result[0].branding.allowedOrigins).toStrictEqual(["https://shop.example.com"]);
      expect(result[0].claimMapping).toStrictEqual([]);
    });

    it("maps repo failure to INTERNAL_SERVER_ERROR", async () => {
      wireAuth();

      const repo = buildRepoStub({
        list: async () =>
          (await import("neverthrow")).err(
            new ProviderConnectionRepoError.FailureFetching("mongo down"),
          ) as Awaited<ReturnType<ProviderConnectionRepo["list"]>>,
      });
      const { router } = await buildRouter({ repo });
      const caller = router.createCaller(buildCtx());

      await expect(caller.list()).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    });
  });

  describe("create", () => {
    it("invokes CreateConnectionUseCase with the parsed input and redacts the response", async () => {
      wireAuth();

      const created = buildConnection();
      const executeMock = vi
        .fn()
        .mockResolvedValue(ok(created)) as CreateConnectionUseCase["execute"];
      const { router, useCases } = await buildRouter({
        useCases: { createConnection: { execute: executeMock } },
      });
      const caller = router.createCaller(buildCtx());

      const result = await caller.create({
        name: "primary",
        fief: {
          baseUrl: "https://tenant.fief.dev/",
          tenantId: "tenant-1",
          adminToken: "admin-tok",
          clientName: "OIDC Client",
          redirectUris: ["https://shop.example.com/callback"],
        },
        branding: {
          allowedOrigins: ["https://shop.example.com"],
        },
        webhookReceiverBaseUrl: "https://app.example.com/api/webhooks/fief",
        claimMapping: [
          {
            fiefClaim: "email",
            saleorMetadataKey: "email",
            visibility: "private",
            reverseSyncEnabled: false,
          },
        ],
      });

      expect(useCases.createConnection.execute).toHaveBeenCalledTimes(1);
      const passed = (useCases.createConnection.execute as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as CreateConnectionUseCaseInput;

      expect(passed.saleorApiUrl).toBe(SALEOR_API_URL);
      expect(passed.name).toBe("primary");
      expect(passed.fief.baseUrl).toBe("https://tenant.fief.dev/");
      expect(passed.fief.tenantId).toBe("tenant-1");
      expect(passed.fief.adminToken).toBe("admin-tok");
      expect(passed.fief.clientName).toBe("OIDC Client");
      expect(passed.fief.redirectUris).toStrictEqual(["https://shop.example.com/callback"]);
      expect(passed.branding.allowedOrigins).toStrictEqual(["https://shop.example.com"]);
      expect(passed.webhookReceiverBaseUrl).toBe("https://app.example.com/api/webhooks/fief");
      expect(passed.claimMapping).toStrictEqual([
        {
          fiefClaim: "email",
          saleorMetadataKey: "email",
          visibility: "private",
          reverseSyncEnabled: false,
          required: false,
        },
      ]);

      // Returned shape must be redacted.
      const stringified = JSON.stringify(result);

      expect(stringified).not.toContain("enc:");
      expect(result).toMatchObject({
        id: FIXED_ID_A,
        secrets: {
          hasClientSecret: true,
          hasAdminToken: true,
          hasWebhookSecret: true,
          hasSigningKey: true,
        },
      });
    });

    it("translates use-case Err to a TRPCError", async () => {
      wireAuth();

      const { CreateConnectionError } = await import("./use-cases/create-connection.use-case");

      const { err: nverr } = await import("neverthrow");

      const executeMock = vi
        .fn()
        .mockResolvedValue(
          nverr(new CreateConnectionError.FiefProvisioningFailed("Fief is down")),
        ) as CreateConnectionUseCase["execute"];
      const { router } = await buildRouter({
        useCases: { createConnection: { execute: executeMock } },
      });
      const caller = router.createCaller(buildCtx());

      await expect(
        caller.create({
          name: "primary",
          fief: {
            baseUrl: "https://tenant.fief.dev/",
            tenantId: "tenant-1",
            adminToken: "admin-tok",
            clientName: "Client",
            redirectUris: ["https://shop.example.com/cb"],
          },
          branding: { allowedOrigins: ["https://shop.example.com"] },
          webhookReceiverBaseUrl: "https://app.example.com/api/webhooks/fief",
          claimMapping: [],
        }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    });
  });

  describe("update", () => {
    it("invokes UpdateConnectionUseCase with the parsed input and redacts the response", async () => {
      wireAuth();

      const executeMock = vi
        .fn()
        .mockResolvedValue(ok(buildConnection())) as UpdateConnectionUseCase["execute"];
      const { router, useCases } = await buildRouter({
        useCases: { updateConnection: { execute: executeMock } },
      });
      const caller = router.createCaller(buildCtx());

      const result = await caller.update({
        id: FIXED_ID_A,
        patch: {
          name: "renamed",
          branding: {
            allowedOrigins: ["https://shop.example.com", "https://shop-eu.example.com"],
          },
          claimMapping: [],
        },
      });

      expect(useCases.updateConnection.execute).toHaveBeenCalledTimes(1);
      const passed = (useCases.updateConnection.execute as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as UpdateConnectionUseCaseInput;

      expect(passed.saleorApiUrl).toBe(SALEOR_API_URL);
      expect(passed.id).toBe(FIXED_ID_A);
      expect(passed.patch.name).toBe("renamed");
      expect(passed.patch.branding?.allowedOrigins).toStrictEqual([
        "https://shop.example.com",
        "https://shop-eu.example.com",
      ]);

      expect(JSON.stringify(result)).not.toContain("enc:");
    });
  });

  describe("rotateSecret + confirmRotation", () => {
    it("rotateSecret invokes initiateRotation and surfaces the new webhook secret one-time", async () => {
      wireAuth();

      const initiateMock = vi.fn().mockResolvedValue(
        ok({
          connection: buildConnection(),
          newWebhookSecretPlaintext: "new-secret-shown-once",
        }),
      ) as RotateConnectionSecretUseCase["initiateRotation"];
      const confirmMock = vi
        .fn()
        .mockResolvedValue(
          ok(buildConnection()),
        ) as RotateConnectionSecretUseCase["confirmRotation"];

      const { router } = await buildRouter({
        useCases: {
          rotateConnectionSecret: {
            initiateRotation: initiateMock,
            confirmRotation: confirmMock,
            cancelRotation: vi.fn() as RotateConnectionSecretUseCase["cancelRotation"],
          },
        },
      });
      const caller = router.createCaller(buildCtx());

      const result = await caller.rotateSecret({
        id: FIXED_ID_A,
        clientSecretSource: { mode: "locally-generated" },
      });

      expect(initiateMock).toHaveBeenCalledTimes(1);
      const passed = (initiateMock as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as InitiateRotationInput;

      expect(passed.saleorApiUrl).toBe(SALEOR_API_URL);
      expect(passed.id).toBe(FIXED_ID_A);
      expect(passed.clientSecretSource).toStrictEqual({ mode: "locally-generated" });

      expect(result.newWebhookSecretPlaintext).toBe("new-secret-shown-once");
      // Connection field is redacted.
      expect(JSON.stringify(result.connection)).not.toContain("enc:");
    });

    it("rotateSecret operator-supplied path passes through the supplied newClientSecret", async () => {
      wireAuth();

      const initiateMock = vi.fn().mockResolvedValue(
        ok({
          connection: buildConnection(),
          newWebhookSecretPlaintext: "secret",
        }),
      ) as RotateConnectionSecretUseCase["initiateRotation"];

      const { router } = await buildRouter({
        useCases: {
          rotateConnectionSecret: {
            initiateRotation: initiateMock,
            confirmRotation: vi.fn() as RotateConnectionSecretUseCase["confirmRotation"],
            cancelRotation: vi.fn() as RotateConnectionSecretUseCase["cancelRotation"],
          },
        },
      });
      const caller = router.createCaller(buildCtx());

      await caller.rotateSecret({
        id: FIXED_ID_A,
        clientSecretSource: { mode: "operator-supplied", newClientSecret: "new-cs" },
      });

      const passed = (initiateMock as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as InitiateRotationInput;

      expect(passed.clientSecretSource).toStrictEqual({
        mode: "operator-supplied",
        newClientSecret: "new-cs",
      });
    });

    it("confirmRotation invokes confirmRotation and returns the redacted connection", async () => {
      wireAuth();

      const confirmMock = vi
        .fn()
        .mockResolvedValue(
          ok(buildConnection()),
        ) as RotateConnectionSecretUseCase["confirmRotation"];
      const { router } = await buildRouter({
        useCases: {
          rotateConnectionSecret: {
            initiateRotation: vi.fn() as RotateConnectionSecretUseCase["initiateRotation"],
            confirmRotation: confirmMock,
            cancelRotation: vi.fn() as RotateConnectionSecretUseCase["cancelRotation"],
          },
        },
      });
      const caller = router.createCaller(buildCtx());

      const result = await caller.confirmRotation({ id: FIXED_ID_A });

      expect(confirmMock).toHaveBeenCalledTimes(1);
      const passed = (confirmMock as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as ConfirmRotationInput;

      expect(passed.saleorApiUrl).toBe(SALEOR_API_URL);
      expect(passed.id).toBe(FIXED_ID_A);
      expect(JSON.stringify(result)).not.toContain("enc:");
    });
  });

  describe("cancelRotation (wire-up follow-up)", () => {
    it("invokes cancelRotation and returns the redacted connection", async () => {
      wireAuth();

      const cancelMock = vi
        .fn()
        .mockResolvedValue(
          ok(buildConnection()),
        ) as RotateConnectionSecretUseCase["cancelRotation"];
      const { router } = await buildRouter({
        useCases: {
          rotateConnectionSecret: {
            initiateRotation: vi.fn() as RotateConnectionSecretUseCase["initiateRotation"],
            confirmRotation: vi.fn() as RotateConnectionSecretUseCase["confirmRotation"],
            cancelRotation: cancelMock,
          },
        },
      });
      const caller = router.createCaller(buildCtx());

      const result = await caller.cancelRotation({ id: FIXED_ID_A });

      expect(cancelMock).toHaveBeenCalledTimes(1);
      const passed = (cancelMock as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as CancelRotationInput;

      expect(passed.saleorApiUrl).toBe(SALEOR_API_URL);
      expect(passed.id).toBe(FIXED_ID_A);
      /* Redacted shape — no plaintext / ciphertext leaks. */
      expect(JSON.stringify(result)).not.toContain("enc:");
    });

    it("maps NoPendingRotation to CONFLICT (categorical mapping shared with confirmRotation)", async () => {
      wireAuth();

      const { err: nverr } = await import("neverthrow");
      const { RotateConnectionSecretError } = await import(
        "@/modules/provider-connections/use-cases/rotate-connection-secret.use-case"
      );

      const cancelMock = vi
        .fn()
        .mockResolvedValue(
          nverr(
            new RotateConnectionSecretError.NoPendingRotation(
              "No pending rotation to cancel; call initiateRotation first",
            ),
          ),
        ) as RotateConnectionSecretUseCase["cancelRotation"];

      const { router } = await buildRouter({
        useCases: {
          rotateConnectionSecret: {
            initiateRotation: vi.fn() as RotateConnectionSecretUseCase["initiateRotation"],
            confirmRotation: vi.fn() as RotateConnectionSecretUseCase["confirmRotation"],
            cancelRotation: cancelMock,
          },
        },
      });
      const caller = router.createCaller(buildCtx());

      await expect(caller.cancelRotation({ id: FIXED_ID_A })).rejects.toMatchObject({
        code: "CONFLICT",
      });
    });
  });

  describe("delete", () => {
    it("invokes DeleteConnectionUseCase with the parsed input", async () => {
      wireAuth();

      const executeMock = vi
        .fn()
        .mockResolvedValue(ok(undefined)) as DeleteConnectionUseCase["execute"];
      const { router, useCases } = await buildRouter({
        useCases: { deleteConnection: { execute: executeMock } },
      });
      const caller = router.createCaller(buildCtx());

      const result = await caller.delete({ id: FIXED_ID_A });

      expect(useCases.deleteConnection.execute).toHaveBeenCalledTimes(1);
      const passed = (useCases.deleteConnection.execute as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as DeleteConnectionUseCaseInput;

      expect(passed.saleorApiUrl).toBe(SALEOR_API_URL);
      expect(passed.id).toBe(FIXED_ID_A);

      expect(result).toStrictEqual({ ok: true });
    });
  });

  describe("testConnection", () => {
    it("returns ok/ok when both OIDC discovery + admin auth succeed", async () => {
      wireAuth();

      const prewarmMock = vi.fn().mockResolvedValue(ok(undefined));
      const listUsersMock = vi.fn().mockResolvedValue(ok({ count: 0, results: [] }));
      const oidcFactoryMock = vi.fn(() => ({ prewarm: prewarmMock }));
      const adminFactoryMock = vi.fn(() => ({ listUsers: listUsersMock }));

      const { router } = await buildRouter({
        oidcClientFactory: oidcFactoryMock,
        adminClientFactory: adminFactoryMock,
      });
      const caller = router.createCaller(buildCtx());

      const result = await caller.testConnection({
        baseUrl: "https://tenant.fief.dev/",
        adminToken: "admin-tok",
      });

      expect(result.oidcDiscovery).toBe("ok");
      expect(result.adminAuth).toBe("ok");
      expect(prewarmMock).toHaveBeenCalledTimes(1);
      expect(listUsersMock).toHaveBeenCalledTimes(1);
      expect(oidcFactoryMock).toHaveBeenCalledWith({ baseUrl: "https://tenant.fief.dev/" });
      expect(adminFactoryMock).toHaveBeenCalledWith({ baseUrl: "https://tenant.fief.dev/" });
    });

    it("returns ok/error when admin auth fails (and admin error does not abort OIDC report)", async () => {
      wireAuth();

      const { err: nverr } = await import("neverthrow");

      const prewarmMock = vi.fn().mockResolvedValue(ok(undefined));
      const listUsersMock = vi.fn().mockResolvedValue(nverr(new Error("401 Unauthorized")));

      const { router } = await buildRouter({
        oidcClientFactory: () => ({ prewarm: prewarmMock }),
        adminClientFactory: () => ({ listUsers: listUsersMock }),
      });
      const caller = router.createCaller(buildCtx());

      const result = await caller.testConnection({
        baseUrl: "https://tenant.fief.dev/",
        adminToken: "bad-admin-tok",
      });

      expect(result.oidcDiscovery).toBe("ok");
      expect(result.adminAuth).toBe("error");
      expect(typeof result.details?.adminAuth).toBe("string");
    });

    it("returns error/error when both fail", async () => {
      wireAuth();

      const { err: nverr } = await import("neverthrow");

      const prewarmMock = vi.fn().mockResolvedValue(nverr(new Error("ENOTFOUND")));
      const listUsersMock = vi.fn().mockResolvedValue(nverr(new Error("401 Unauthorized")));

      const { router } = await buildRouter({
        oidcClientFactory: () => ({ prewarm: prewarmMock }),
        adminClientFactory: () => ({ listUsers: listUsersMock }),
      });
      const caller = router.createCaller(buildCtx());

      const result = await caller.testConnection({
        baseUrl: "https://does-not-resolve.example.com/",
        adminToken: "bad",
      });

      expect(result.oidcDiscovery).toBe("error");
      expect(result.adminAuth).toBe("error");
      expect(typeof result.details?.oidcDiscovery).toBe("string");
      expect(typeof result.details?.adminAuth).toBe("string");
    });
  });
});
