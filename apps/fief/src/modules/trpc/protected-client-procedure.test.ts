/*
 * @vitest-environment node
 * Use Node env (not jsdom) — jsdom replaces the global `TextEncoder` with a
 * non-Uint8Array subclass, which trips jose's strict
 * `payload instanceof Uint8Array` check inside `FlattenedSign`.
 */

/**
 * T33 — TDD tests for `protectedClientProcedure`.
 *
 * The procedure stack is exercised end-to-end via a minimal tRPC router that
 * mounts a single no-op `query` on top of `protectedClientProcedure`. The
 * Saleor JWT verifier (`verifyJWT` from `@saleor/app-sdk/auth`) is mocked
 * because the real implementation issues a network fetch for the remote
 * JWKS — that's the SDK's contract, not what we're testing here. The APL is
 * also mocked so the tests don't touch the filesystem or Mongo.
 *
 * Three behavioural cases drive the implementation:
 *   1. Reject unauthenticated request — no JWT in the context's `token`
 *      slot still raises an error after APL auth lookup succeeds, because
 *      the JWT-validating middleware has nothing to verify.
 *   2. Reject invalid JWT signature — the SDK's verifier throws and the
 *      middleware translates that into a `FORBIDDEN` TRPCError.
 *   3. Accept valid JWT — the procedure resolves and the inner resolver
 *      receives a context populated with the APL's app token + appId.
 *
 * The "valid JWT" case pre-builds an RS256 key pair via `jose` so the
 * fixture is self-contained; the actual JWT body never reaches the SDK
 * because we mock the verifier — but the fixture proves the wiring is
 * compatible with how `verifyJWT` would be called for real, and gives us a
 * concrete `token` string to thread through the context.
 */
import { generateKeyPair, type KeyLike, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createLogger } from "@/lib/logger";

import { type TrpcContextAppRouter } from "./context-app-router";

const SALEOR_API_URL = "https://example.saleor.cloud/graphql/";
const APP_ID = "app-id-test";
const APP_TOKEN = "apl-app-token-from-storage";

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

let privateKey: KeyLike;

const buildSignedJwt = async (): Promise<string> =>
  new SignJWT({
    app: APP_ID,
    user_permissions: ["MANAGE_APPS"],
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });

  privateKey = pair.privateKey;
});

afterEach(() => {
  verifyJWTMock.mockReset();
  aplGetMock.mockReset();
});

/**
 * Build a context object satisfying `TrpcContextAppRouter`. The procedure
 * stack overrides whatever the caller seeds for `appId` / `appToken` /
 * `saleorApiUrl` after the APL middleware fires, so the seed values here
 * really only need to satisfy the input shape.
 */
const buildCtx = (overrides: Partial<TrpcContextAppRouter>): TrpcContextAppRouter => ({
  saleorApiUrl: SALEOR_API_URL,
  token: undefined,
  appId: undefined,
  appUrl: null,
  logger: createLogger("test"),
  ...overrides,
});

describe("protectedClientProcedure", () => {
  it("rejects with UNAUTHORIZED when the APL has no auth data for the saleorApiUrl", async () => {
    aplGetMock.mockResolvedValueOnce(undefined);

    const { protectedClientProcedure } = await import("./protected-client-procedure");
    const { router } = await import("./trpc-server");

    const testRouter = router({
      ping: protectedClientProcedure.query(() => "pong"),
    });

    const caller = testRouter.createCaller(buildCtx({ token: "irrelevant-frontend-token" }));

    await expect(caller.ping()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(verifyJWTMock).not.toHaveBeenCalled();
  });

  it("rejects with INTERNAL_SERVER_ERROR when no frontend JWT is supplied", async () => {
    aplGetMock.mockResolvedValueOnce({
      saleorApiUrl: SALEOR_API_URL,
      appId: APP_ID,
      token: APP_TOKEN,
    });

    const { protectedClientProcedure } = await import("./protected-client-procedure");
    const { router } = await import("./trpc-server");

    const testRouter = router({
      ping: protectedClientProcedure.query(() => "pong"),
    });

    const caller = testRouter.createCaller(
      buildCtx({ token: undefined }), // no frontend JWT
    );

    await expect(caller.ping()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    expect(verifyJWTMock).not.toHaveBeenCalled();
  });

  it("rejects with FORBIDDEN when the JWT signature/permissions check fails", async () => {
    aplGetMock.mockResolvedValueOnce({
      saleorApiUrl: SALEOR_API_URL,
      appId: APP_ID,
      token: APP_TOKEN,
    });
    verifyJWTMock.mockRejectedValueOnce(new Error("JWT verification failed: signature invalid"));

    const { protectedClientProcedure } = await import("./protected-client-procedure");
    const { router } = await import("./trpc-server");

    const testRouter = router({
      ping: protectedClientProcedure.query(() => "pong"),
    });

    const tamperedJwt = await buildSignedJwt();

    const caller = testRouter.createCaller(buildCtx({ token: tamperedJwt }));

    await expect(caller.ping()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(verifyJWTMock).toHaveBeenCalledOnce();
    expect(verifyJWTMock).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: APP_ID,
        saleorApiUrl: SALEOR_API_URL,
        token: tamperedJwt,
      }),
    );
  });

  it("accepts a valid JWT and exposes APL-derived auth data on the resolver context", async () => {
    aplGetMock.mockResolvedValueOnce({
      saleorApiUrl: SALEOR_API_URL,
      appId: APP_ID,
      token: APP_TOKEN,
    });
    verifyJWTMock.mockResolvedValueOnce(undefined);

    const { protectedClientProcedure } = await import("./protected-client-procedure");
    const { router } = await import("./trpc-server");

    const seenContext: Array<Record<string, unknown>> = [];

    const testRouter = router({
      whoami: protectedClientProcedure.query(({ ctx }) => {
        seenContext.push({ ...ctx });

        return {
          appId: ctx.appId,
          saleorApiUrl: ctx.saleorApiUrl,
          appToken: ctx.appToken,
        };
      }),
    });

    const validJwt = await buildSignedJwt();

    const caller = testRouter.createCaller(buildCtx({ token: validJwt }));

    const result = await caller.whoami();

    expect(result).toStrictEqual({
      appId: APP_ID,
      saleorApiUrl: SALEOR_API_URL,
      appToken: APP_TOKEN,
    });
    expect(verifyJWTMock).toHaveBeenCalledOnce();
    expect(aplGetMock).toHaveBeenCalledWith(SALEOR_API_URL);
    expect(seenContext[0]).toMatchObject({
      appId: APP_ID,
      saleorApiUrl: SALEOR_API_URL,
      appToken: APP_TOKEN,
    });
  });

  it("rejects with BAD_REQUEST when the saleorApiUrl is missing from the context", async () => {
    const { protectedClientProcedure } = await import("./protected-client-procedure");
    const { router } = await import("./trpc-server");

    const testRouter = router({
      ping: protectedClientProcedure.query(() => "pong"),
    });

    const caller = testRouter.createCaller(
      buildCtx({ saleorApiUrl: undefined, token: "anything" }),
    );

    await expect(caller.ping()).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(aplGetMock).not.toHaveBeenCalled();
    expect(verifyJWTMock).not.toHaveBeenCalled();
  });
});
