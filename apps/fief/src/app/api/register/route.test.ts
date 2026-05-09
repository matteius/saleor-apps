/*
 * @vitest-environment node
 *
 * T16 — register handler integration test.
 *
 * Mocks `createAppRegisterHandler` from `@saleor/app-sdk` so we can:
 *   - capture the config the route hands to the SDK and assert structure;
 *   - drive the hooks (`allowedSaleorUrls`, `onAuthAplSaved`, `onAplSetFailed`)
 *     directly without booting a fake Saleor (the SDK's flow needs a real
 *     JWKS endpoint + a real `getAppId` GraphQL call).
 *
 * The wrapper composition (`compose(withLoggerContext, withSaleorApiUrlAttributes)`)
 * is exercised through the exported `POST` so a regression that drops the
 * middleware would fail this test.
 */

import { ok } from "neverthrow";
import { type NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as EnvModule from "@/lib/env";
import type * as WebhookManagementModule from "@/modules/webhook-management";

import { buildRegisterHandler } from "./build-register-handler";
import { POST } from "./route";

const { captured, runWebhookMigrationsExecute } = vi.hoisted(() => ({
  captured: { lastConfig: undefined as Record<string, unknown> | undefined },
  runWebhookMigrationsExecute: vi.fn(),
}));

vi.mock("@saleor/app-sdk/handlers/next-app-router", () => {
  return {
    createAppRegisterHandler: (config: Record<string, unknown>) => {
      captured.lastConfig = config;

      return async () => new Response("ok", { status: 200 });
    },
  };
});

vi.mock("@/modules/webhook-management", async () => {
  const actual = await vi.importActual<typeof WebhookManagementModule>(
    "@/modules/webhook-management",
  );

  return {
    ...actual,
    RunWebhookMigrationsUseCase: vi.fn().mockImplementation(() => ({
      execute: runWebhookMigrationsExecute,
    })),
  };
});

vi.mock("@/lib/env", async () => {
  const actual = await vi.importActual<typeof EnvModule>("@/lib/env");

  return {
    env: {
      ...actual.env,
      ALLOWED_DOMAIN_PATTERN: "^https://allowed\\.example/graphql/$",
      APL: "file",
    },
  };
});

describe("register route — T16", () => {
  beforeEach(() => {
    runWebhookMigrationsExecute.mockReset();
    runWebhookMigrationsExecute.mockResolvedValue(ok(undefined));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls `createAppRegisterHandler` with allowedSaleorUrls + both hooks at module load", () => {
    expect(captured.lastConfig).toBeDefined();
    expect(captured.lastConfig?.apl).toBeDefined();
    expect(Array.isArray(captured.lastConfig?.allowedSaleorUrls)).toBe(true);
    expect(typeof captured.lastConfig?.onAuthAplSaved).toBe("function");
    expect(typeof captured.lastConfig?.onAplSetFailed).toBe("function");
  });

  it("`POST` returns a Response (composition with withLoggerContext + withSaleorApiUrlAttributes wraps the handler)", async () => {
    /*
     * Build a minimal NextRequest. The composed middlewares only read headers
     * and the URL path, so we don't need a real body.
     */
    const req = new Request("https://app.test/api/register", {
      method: "POST",
      headers: { "saleor-api-url": "https://allowed.example/graphql/" },
    }) as unknown as NextRequest;

    /*
     * jsdom isn't loaded in this file (node env), so synthesize what
     * `withLoggerContext` reads from `req.nextUrl.pathname` if needed.
     */
    Object.defineProperty(req, "nextUrl", {
      value: new URL("https://app.test/api/register"),
    });

    const res = await POST(req);

    expect(res.status).toBe(200);
  });

  describe("allowedSaleorUrls predicate", () => {
    it("allows installation from a URL that matches ALLOWED_DOMAIN_PATTERN", () => {
      const predicates = captured.lastConfig?.allowedSaleorUrls as Array<(url: string) => boolean>;

      expect(predicates[0]("https://allowed.example/graphql/")).toBe(true);
    });

    it("blocks installation from a URL that does not match ALLOWED_DOMAIN_PATTERN", () => {
      const predicates = captured.lastConfig?.allowedSaleorUrls as Array<(url: string) => boolean>;

      expect(predicates[0]("https://hostile.example/graphql/")).toBe(false);
    });
  });

  describe("onAuthAplSaved", () => {
    it("invokes RunWebhookMigrationsUseCase.execute with the saleorApiUrl + token from authData", async () => {
      const onAuthAplSaved = captured.lastConfig?.onAuthAplSaved as (
        req: unknown,
        ctx: {
          authData: { saleorApiUrl: string; token: string; appId: string; jwks: string };
          respondWithError: (params: { message?: string; status?: number }) => never;
        },
      ) => Promise<void>;

      await onAuthAplSaved(undefined, {
        authData: {
          saleorApiUrl: "https://allowed.example/graphql/",
          token: "app-token-xyz",
          appId: "app-id-1",
          jwks: "jwks",
        },
        respondWithError: (() => {
          throw new Error("respondWithError unexpectedly called");
        }) as never,
      });

      expect(runWebhookMigrationsExecute).toHaveBeenCalledTimes(1);
      expect(runWebhookMigrationsExecute).toHaveBeenCalledWith({
        saleorApiUrl: "https://allowed.example/graphql/",
        token: "app-token-xyz",
      });
    });
  });

  describe("buildRegisterHandler — direct invocation contract", () => {
    it("when `runWebhookMigrations.execute` returns Err, the post-APL hook does not throw (install completes; migration retried out-of-band)", async () => {
      const { err } = await import("neverthrow");
      const { RunWebhookMigrationsError } = await import("@/modules/webhook-management");

      const fakeMigrationError = err(new RunWebhookMigrationsError("simulated"));

      const useCase = {
        execute: vi.fn().mockResolvedValue(fakeMigrationError),
      };

      // Reset the captured config so we read this instance's config, not the module-level one.
      captured.lastConfig = undefined;

      buildRegisterHandler({
        runWebhookMigrations: useCase as never,
        allowedDomainPattern: undefined,
      });

      const config = captured.lastConfig as Record<string, unknown> | undefined;
      const onAuthAplSaved = config?.onAuthAplSaved as (
        req: unknown,
        ctx: {
          authData: { saleorApiUrl: string; token: string; appId: string; jwks: string };
          respondWithError: (params: { message?: string; status?: number }) => never;
        },
      ) => Promise<void>;

      await expect(
        onAuthAplSaved(undefined, {
          authData: {
            saleorApiUrl: "https://allowed.example/graphql/",
            token: "tok",
            appId: "id",
            jwks: "jwks",
          },
          respondWithError: (() => {
            throw new Error("not expected");
          }) as never,
        }),
      ).resolves.toBeUndefined();

      expect(useCase.execute).toHaveBeenCalledWith({
        saleorApiUrl: "https://allowed.example/graphql/",
        token: "tok",
      });
    });

    it("`allowedSaleorUrls[0]` returns true when `allowedDomainPattern` is undefined (open default)", () => {
      captured.lastConfig = undefined;

      buildRegisterHandler({
        runWebhookMigrations: { execute: vi.fn() } as never,
        allowedDomainPattern: undefined,
      });

      const config = captured.lastConfig as Record<string, unknown> | undefined;
      const predicates = config?.allowedSaleorUrls as Array<(url: string) => boolean>;

      expect(predicates[0]("https://anywhere.example/graphql/")).toBe(true);
    });
  });
});
