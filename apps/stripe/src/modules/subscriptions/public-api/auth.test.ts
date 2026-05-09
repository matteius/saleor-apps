/*
 * @vitest-environment node
 *
 * Unit tests for the two-layer auth helper used by the public storefront API
 * (T19a). Covers the five failure shapes called out in the task brief plus
 * the happy path: valid HMAC + valid JWT, invalid HMAC, expired timestamp,
 * missing JWT, mismatched body fiefUserId vs JWT sub.
 *
 * `jose.createRemoteJWKSet` is bypassed via the `jwksOverride` parameter on
 * `verifyPublicApiRequest` — we generate an RSA keypair in `beforeAll`,
 * issue tokens with the private key, and pass a getter that returns the
 * matching key directly (no HTTP fetch).
 */
import { createHmac } from "node:crypto";

import { generateKeyPair, type KeyLike, SignJWT } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  HMAC_REPLAY_WINDOW_SECONDS,
  verifyPublicApiRequest,
} from "@/modules/subscriptions/public-api/auth";

const TEST_SECRET = "x".repeat(32);
const ROUTE_PATH = "/api/public/subscriptions/create";

vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();

  return {
    env: new Proxy(actual.env, {
      get(target, prop) {
        if (prop === "STOREFRONT_BRIDGE_SECRET") return TEST_SECRET;
        if (prop === "FIEF_JWKS_URL") return "https://test.fief.example/.well-known/jwks.json";

        return Reflect.get(target, prop);
      },
    }),
  };
});

const computeTestHmac = (path: string, timestamp: string, body: string): string => {
  return createHmac("sha256", TEST_SECRET).update(`${path}\n${timestamp}\n${body}`).digest("hex");
};

interface KeyMaterial {
  privateKey: KeyLike;
  publicKey: KeyLike;
}

let keyMaterial: KeyMaterial;

/**
 * Build a JWKS-getter override that returns our test public key. `jose`'s
 * `jwtVerify` accepts either a `KeyLike` or a function returning one keyed
 * by the JWT's protected header. Returning the public key directly works
 * for both shapes via the function-getter path.
 */
const buildJwksOverride = () =>
  /*
   * Cast through unknown — the real return type from `createRemoteJWKSet`
   * has a complex internal generic; we only need it to be callable with
   * `(header) => Promise<KeyLike>` which is what `jwtVerify` invokes.
   */
  (async () => keyMaterial.publicKey) as unknown as ReturnType<
    typeof import("jose").createRemoteJWKSet
  >;

const issueFiefJwt = async (claims: Record<string, unknown>, expSeconds = 60 * 60) => {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expSeconds)
    .sign(keyMaterial.privateKey);
};

const buildRequest = (opts: {
  path?: string;
  rawBody: string;
  hmac?: string | null;
  timestamp?: string | null;
  authorization?: string | null;
}): Request => {
  const headers = new Headers();
  const path = opts.path ?? ROUTE_PATH;

  if (opts.hmac !== null) {
    headers.set("x-storefront-auth", opts.hmac ?? "deadbeef");
  }
  if (opts.timestamp !== null) {
    headers.set("x-storefront-timestamp", opts.timestamp ?? String(Math.floor(Date.now() / 1000)));
  }
  if (opts.authorization) {
    headers.set("authorization", opts.authorization);
  }

  return new Request(`https://app.example${path}`, {
    method: "POST",
    headers,
    body: opts.rawBody,
  });
};

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });

  keyMaterial = { privateKey, publicKey };
});

describe("verifyPublicApiRequest — happy path", () => {
  it("returns claims when HMAC + Fief JWT are both valid and match the body", async () => {
    const body = JSON.stringify({ fiefUserId: "user-1", email: "alice@example.com" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const hmac = computeTestHmac(ROUTE_PATH, timestamp, body);
    const jwt = await issueFiefJwt({ sub: "user-1", email: "alice@example.com" });

    const request = buildRequest({
      rawBody: body,
      hmac,
      timestamp,
      authorization: `Bearer ${jwt}`,
    });

    const result = await verifyPublicApiRequest({
      request,
      rawBody: body,
      path: ROUTE_PATH,
      expectedFiefUserId: "user-1",
      expectedEmail: "alice@example.com",
      jwksOverride: buildJwksOverride(),
    });

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.claims.fiefUserId).toBe("user-1");
      expect(result.claims.email).toBe("alice@example.com");
    }
  });
});

describe("verifyPublicApiRequest — HMAC layer", () => {
  it("returns 401 for invalid HMAC", async () => {
    const body = JSON.stringify({ fiefUserId: "user-1", email: "a@b.com" });
    const timestamp = String(Math.floor(Date.now() / 1000));

    const request = buildRequest({
      rawBody: body,
      hmac: "0".repeat(64),
      timestamp,
      authorization: "Bearer fake.jwt.value",
    });

    const result = await verifyPublicApiRequest({
      request,
      rawBody: body,
      path: ROUTE_PATH,
      jwksOverride: buildJwksOverride(),
    });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.response.status).toBe(401);

      const json = (await result.response.json()) as Record<string, unknown>;

      expect(json).toMatchObject({ error: "unauthorized" });
      expect(String(json.message)).toMatch(/HMAC/);
    }
  });

  it("returns 401 when timestamp is older than the replay window", async () => {
    const body = JSON.stringify({ fiefUserId: "user-1" });
    const stale = String(Math.floor(Date.now() / 1000) - HMAC_REPLAY_WINDOW_SECONDS - 30);
    const hmac = computeTestHmac(ROUTE_PATH, stale, body);

    const request = buildRequest({
      rawBody: body,
      hmac,
      timestamp: stale,
      authorization: "Bearer fake.jwt.value",
    });

    const result = await verifyPublicApiRequest({
      request,
      rawBody: body,
      path: ROUTE_PATH,
      jwksOverride: buildJwksOverride(),
    });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.response.status).toBe(401);

      const json = (await result.response.json()) as Record<string, unknown>;

      expect(String(json.message)).toMatch(/replay window/);
    }
  });

  it("returns 401 when HMAC headers are missing", async () => {
    const body = JSON.stringify({});
    const request = buildRequest({
      rawBody: body,
      hmac: null,
      timestamp: null,
      authorization: "Bearer x.y.z",
    });

    const result = await verifyPublicApiRequest({ request, rawBody: body, path: ROUTE_PATH });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });
});

describe("verifyPublicApiRequest — Fief JWT layer", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const body = JSON.stringify({ fiefUserId: "user-1" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const hmac = computeTestHmac(ROUTE_PATH, timestamp, body);

    const request = buildRequest({
      rawBody: body,
      hmac,
      timestamp,
      authorization: null,
    });

    const result = await verifyPublicApiRequest({
      request,
      rawBody: body,
      path: ROUTE_PATH,
      jwksOverride: buildJwksOverride(),
    });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.response.status).toBe(401);

      const json = (await result.response.json()) as Record<string, unknown>;

      expect(String(json.message)).toMatch(/authorization/i);
    }
  });

  it("returns 401 when JWT signature does not verify", async () => {
    const body = JSON.stringify({ fiefUserId: "user-1" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const hmac = computeTestHmac(ROUTE_PATH, timestamp, body);

    const request = buildRequest({
      rawBody: body,
      hmac,
      timestamp,
      authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.notvalid",
    });

    const result = await verifyPublicApiRequest({
      request,
      rawBody: body,
      path: ROUTE_PATH,
      jwksOverride: buildJwksOverride(),
    });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  it("returns 401 when body fiefUserId does not match JWT sub", async () => {
    const body = JSON.stringify({ fiefUserId: "user-attacker", email: "alice@example.com" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const hmac = computeTestHmac(ROUTE_PATH, timestamp, body);
    const jwt = await issueFiefJwt({ sub: "user-1", email: "alice@example.com" });

    const request = buildRequest({
      rawBody: body,
      hmac,
      timestamp,
      authorization: `Bearer ${jwt}`,
    });

    const result = await verifyPublicApiRequest({
      request,
      rawBody: body,
      path: ROUTE_PATH,
      expectedFiefUserId: "user-attacker",
      expectedEmail: "alice@example.com",
      jwksOverride: buildJwksOverride(),
    });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.response.status).toBe(401);

      const json = (await result.response.json()) as Record<string, unknown>;

      expect(String(json.message)).toMatch(/fiefUserId.*does not match.*sub/);
    }
  });
});
