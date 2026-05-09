// @vitest-environment node

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { FiefAdminApiClient } from "./admin-api-client";
import {
  FiefAdminApiClientError,
  FiefAdminApiNotFoundError,
  FiefAdminApiRateLimitError,
  FiefAdminApiSchemaError,
  FiefAdminApiServerError,
  FiefAdminApiUnauthorizedError,
} from "./admin-api-errors";
import {
  FiefAdminTokenSchema,
  FiefBaseUrlSchema,
  FiefClientIdSchema,
  FiefTenantIdSchema,
  FiefUserIdSchema,
  FiefWebhookIdSchema,
} from "./admin-api-types";

/*
 * msw setup. The Fief admin API mounts at `/admin/api/...` (matches the FastAPI
 * router prefix in `fief.apps.api.app`). We point every test at a stable host
 * so handler URLs are easy to read.
 */
const FIEF_HOST = "https://fief.test";
const ADMIN_BASE = `${FIEF_HOST}/admin/api`;

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/* Fixtures — UUIDs are arbitrary v4s. */
const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const CLIENT_ID = "00000000-0000-4000-8000-000000000002";
const WEBHOOK_ID = "00000000-0000-4000-8000-000000000003";
const USER_ID = "00000000-0000-4000-8000-000000000004";
const USER_ID_2 = "00000000-0000-4000-8000-000000000005";
const USER_ID_3 = "00000000-0000-4000-8000-000000000006";

const ADMIN_TOKEN = "admin_test_token_xyz";

const isoNow = () => new Date("2026-01-01T00:00:00Z").toISOString();

const buildClient = () =>
  FiefAdminApiClient.create({
    baseUrl: FiefBaseUrlSchema.parse(FIEF_HOST),
    /*
     * Bound the retry window tight so the "5xx then success" test doesn't
     * blow vitest's default 5s budget. Real production caller should use the
     * defaults.
     */
    retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 5 },
  });

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

const validWebhookPayload = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: WEBHOOK_ID,
  created_at: isoNow(),
  updated_at: isoNow(),
  url: "https://app.example.com/api/webhooks/fief?connectionId=abc",
  events: ["user.created", "user.updated", "user.deleted"],
  ...overrides,
});

const validUserPayload = (id: string) => ({
  id,
  created_at: isoNow(),
  updated_at: isoNow(),
  email: `user-${id.slice(-4)}@example.com`,
  email_verified: true,
  is_active: true,
  tenant_id: TENANT_ID,
  fields: { first_name: "Anne" },
});

const token = () => FiefAdminTokenSchema.parse(ADMIN_TOKEN);

describe("FiefAdminApiClient — clients CRUD", () => {
  it("createClient happy path returns parsed FiefClient", async () => {
    server.use(
      http.post(`${ADMIN_BASE}/clients/`, async ({ request }) => {
        expect(request.headers.get("Authorization")).toBe(`Bearer ${ADMIN_TOKEN}`);
        expect(request.headers.get("Content-Type")).toBe("application/json");
        const body = (await request.json()) as Record<string, unknown>;

        expect(body.name).toBe("OwlBooks");
        expect(body.tenant_id).toBe(TENANT_ID);

        return HttpResponse.json(validClientPayload(), { status: 201 });
      }),
    );

    const client = buildClient();
    const result = await client.createClient(token(), {
      name: "OwlBooks",
      first_party: true,
      client_type: "confidential",
      redirect_uris: ["https://shop.example.com/callback"],
      tenant_id: FiefTenantIdSchema.parse(TENANT_ID),
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().id).toBe(CLIENT_ID);
    expect(result._unsafeUnwrap().client_secret).toBe("fief_client_secret_xyz");
  });

  it("getClient happy path", async () => {
    server.use(
      http.get(`${ADMIN_BASE}/clients/${CLIENT_ID}`, () => {
        return HttpResponse.json(validClientPayload());
      }),
    );

    const result = await buildClient().getClient(token(), FiefClientIdSchema.parse(CLIENT_ID));

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().name).toBe("OwlBooks");
  });

  it("updateClient sends PATCH with partial body", async () => {
    let receivedBody: Record<string, unknown> | undefined;

    server.use(
      http.patch(`${ADMIN_BASE}/clients/${CLIENT_ID}`, async ({ request }) => {
        receivedBody = (await request.json()) as Record<string, unknown>;

        return HttpResponse.json(validClientPayload({ name: "Renamed" }));
      }),
    );

    const result = await buildClient().updateClient(token(), FiefClientIdSchema.parse(CLIENT_ID), {
      name: "Renamed",
    });

    expect(result.isOk()).toBe(true);
    expect(receivedBody).toStrictEqual({ name: "Renamed" });
    expect(result._unsafeUnwrap().name).toBe("Renamed");
  });

  it("deleteClient returns ok on 204 without body", async () => {
    server.use(
      http.delete(`${ADMIN_BASE}/clients/${CLIENT_ID}`, () => {
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const result = await buildClient().deleteClient(token(), FiefClientIdSchema.parse(CLIENT_ID));

    expect(result.isOk()).toBe(true);
  });

  it("404 on getClient returns FiefAdminApiNotFoundError", async () => {
    server.use(
      http.get(`${ADMIN_BASE}/clients/${CLIENT_ID}`, () => {
        return HttpResponse.json({ detail: "not found" }, { status: 404 });
      }),
    );

    const result = await buildClient().getClient(token(), FiefClientIdSchema.parse(CLIENT_ID));

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(FiefAdminApiNotFoundError);
  });
});

describe("FiefAdminApiClient — webhooks CRUD + rotate-secret", () => {
  it("createWebhook returns the webhook with secret", async () => {
    server.use(
      http.post(`${ADMIN_BASE}/webhooks/`, async () => {
        return HttpResponse.json(
          { ...validWebhookPayload(), secret: "whsec_initial" },
          { status: 201 },
        );
      }),
    );

    const result = await buildClient().createWebhook(token(), {
      url: "https://app.example.com/api/webhooks/fief?connectionId=abc",
      events: ["user.created"],
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().secret).toBe("whsec_initial");
  });

  it("getWebhook happy path", async () => {
    server.use(
      http.get(`${ADMIN_BASE}/webhooks/${WEBHOOK_ID}`, () => {
        return HttpResponse.json(validWebhookPayload());
      }),
    );

    const result = await buildClient().getWebhook(token(), FiefWebhookIdSchema.parse(WEBHOOK_ID));

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().events).toContain("user.created");
  });

  it("updateWebhook PATCH happy path", async () => {
    server.use(
      http.patch(`${ADMIN_BASE}/webhooks/${WEBHOOK_ID}`, () => {
        return HttpResponse.json(
          validWebhookPayload({
            url: "https://app.example.com/api/webhooks/fief?connectionId=def",
          }),
        );
      }),
    );

    const result = await buildClient().updateWebhook(
      token(),
      FiefWebhookIdSchema.parse(WEBHOOK_ID),
      { url: "https://app.example.com/api/webhooks/fief?connectionId=def" },
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().url).toContain("connectionId=def");
  });

  it("rotateWebhookSecret returns the new secret", async () => {
    server.use(
      http.post(`${ADMIN_BASE}/webhooks/${WEBHOOK_ID}/secret`, () => {
        return HttpResponse.json({
          ...validWebhookPayload(),
          secret: "whsec_rotated",
        });
      }),
    );

    const result = await buildClient().rotateWebhookSecret(
      token(),
      FiefWebhookIdSchema.parse(WEBHOOK_ID),
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().secret).toBe("whsec_rotated");
  });

  it("deleteWebhook 204 returns ok", async () => {
    server.use(
      http.delete(`${ADMIN_BASE}/webhooks/${WEBHOOK_ID}`, () => {
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const result = await buildClient().deleteWebhook(
      token(),
      FiefWebhookIdSchema.parse(WEBHOOK_ID),
    );

    expect(result.isOk()).toBe(true);
  });
});

describe("FiefAdminApiClient — users get/update/list", () => {
  it("getUser happy path", async () => {
    server.use(
      http.get(`${ADMIN_BASE}/users/${USER_ID}`, () => {
        return HttpResponse.json(validUserPayload(USER_ID));
      }),
    );

    const result = await buildClient().getUser(token(), FiefUserIdSchema.parse(USER_ID));

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().email).toMatch(/@example\.com$/);
  });

  it("updateUser PATCH with allowed fields", async () => {
    let body: Record<string, unknown> | undefined;

    server.use(
      http.patch(`${ADMIN_BASE}/users/${USER_ID}`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;

        return HttpResponse.json({
          ...validUserPayload(USER_ID),
          email_verified: false,
        });
      }),
    );

    const result = await buildClient().updateUser(token(), FiefUserIdSchema.parse(USER_ID), {
      email_verified: false,
      fields: { last_name: "Bretagne" },
    });

    expect(result.isOk()).toBe(true);
    expect(body).toStrictEqual({ email_verified: false, fields: { last_name: "Bretagne" } });
  });

  it("listUsers (single page) returns paginated result", async () => {
    let observedQuery: URLSearchParams | null = null;

    server.use(
      http.get(`${ADMIN_BASE}/users/`, ({ request }) => {
        observedQuery = new URL(request.url).searchParams;

        return HttpResponse.json({
          count: 1,
          results: [validUserPayload(USER_ID)],
        });
      }),
    );

    const result = await buildClient().listUsers(token(), { limit: 50 });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().count).toBe(1);
    expect(result._unsafeUnwrap().results).toHaveLength(1);
    expect(observedQuery).not.toBeNull();
    expect(observedQuery!.get("limit")).toBe("50");
    /*
     * `skip` is omitted from the request when not explicitly passed — the
     * server defaults it to 0 (`get_pagination` in pagination.py).
     */
  });

  it("iterateUsers walks multiple pages until exhausted", async () => {
    /*
     * Three users across three pages (page-size = 1). The wrapper increments
     * `skip` by `limit` each round and stops once `results.length < limit`
     * OR `skip >= count`.
     */
    server.use(
      http.get(`${ADMIN_BASE}/users/`, ({ request }) => {
        const url = new URL(request.url);
        const skip = Number(url.searchParams.get("skip") ?? "0");
        const all = [USER_ID, USER_ID_2, USER_ID_3];
        const page = all.slice(skip, skip + 1).map(validUserPayload);

        return HttpResponse.json({ count: all.length, results: page });
      }),
    );

    const seen: string[] = [];

    for await (const user of buildClient().iterateUsers(token(), { limit: 1 })) {
      seen.push(user.id);
    }

    expect(seen).toStrictEqual([USER_ID, USER_ID_2, USER_ID_3]);
  });

  it("iterateUsers surfaces error on a failed page", async () => {
    server.use(
      http.get(`${ADMIN_BASE}/users/`, () => {
        return HttpResponse.json({ detail: "boom" }, { status: 401 });
      }),
    );

    const iterator = buildClient().iterateUsers(token(), { limit: 1 });

    await expect(async () => {
      for await (const _ of iterator) {
        /* noop */
      }
    }).rejects.toBeInstanceOf(FiefAdminApiUnauthorizedError);
  });
});

describe("FiefAdminApiClient — retry & error mapping", () => {
  it("retries on 503 then succeeds", async () => {
    let attempts = 0;

    server.use(
      http.get(`${ADMIN_BASE}/clients/${CLIENT_ID}`, () => {
        attempts += 1;
        if (attempts < 2) {
          return HttpResponse.json({ detail: "upstream" }, { status: 503 });
        }

        return HttpResponse.json(validClientPayload());
      }),
    );

    const result = await buildClient().getClient(token(), FiefClientIdSchema.parse(CLIENT_ID));

    expect(result.isOk()).toBe(true);
    expect(attempts).toBe(2);
  });

  it("retries on 429 then succeeds", async () => {
    let attempts = 0;

    server.use(
      http.get(`${ADMIN_BASE}/clients/${CLIENT_ID}`, () => {
        attempts += 1;
        if (attempts < 2) {
          return HttpResponse.json({ detail: "rate limited" }, { status: 429 });
        }

        return HttpResponse.json(validClientPayload());
      }),
    );

    const result = await buildClient().getClient(token(), FiefClientIdSchema.parse(CLIENT_ID));

    expect(result.isOk()).toBe(true);
    expect(attempts).toBe(2);
  });

  it("exhausts retry budget and returns FiefAdminApiServerError after maxAttempts", async () => {
    let attempts = 0;

    server.use(
      http.get(`${ADMIN_BASE}/clients/${CLIENT_ID}`, () => {
        attempts += 1;

        return HttpResponse.json({ detail: "still down" }, { status: 502 });
      }),
    );

    const result = await buildClient().getClient(token(), FiefClientIdSchema.parse(CLIENT_ID));

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(FiefAdminApiServerError);
    expect(attempts).toBe(3);
  });

  it("exhausts retry budget on persistent 429 returning FiefAdminApiRateLimitError", async () => {
    let attempts = 0;

    server.use(
      http.get(`${ADMIN_BASE}/clients/${CLIENT_ID}`, () => {
        attempts += 1;

        return HttpResponse.json({ detail: "rate limited" }, { status: 429 });
      }),
    );

    const result = await buildClient().getClient(token(), FiefClientIdSchema.parse(CLIENT_ID));

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(FiefAdminApiRateLimitError);
    expect(attempts).toBe(3);
  });

  it("does NOT retry on a non-429 4xx (e.g. 400)", async () => {
    let attempts = 0;

    server.use(
      http.post(`${ADMIN_BASE}/clients/`, () => {
        attempts += 1;

        return HttpResponse.json({ detail: "bad request" }, { status: 400 });
      }),
    );

    const result = await buildClient().createClient(token(), {
      name: "x",
      first_party: true,
      client_type: "confidential",
      redirect_uris: ["https://shop.example.com/callback"],
      tenant_id: FiefTenantIdSchema.parse(TENANT_ID),
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(FiefAdminApiClientError);
    expect(attempts).toBe(1);
  });

  it("401 returns FiefAdminApiUnauthorizedError without retry", async () => {
    let attempts = 0;

    server.use(
      http.get(`${ADMIN_BASE}/clients/${CLIENT_ID}`, () => {
        attempts += 1;

        return HttpResponse.json({ detail: "no auth" }, { status: 401 });
      }),
    );

    const result = await buildClient().getClient(token(), FiefClientIdSchema.parse(CLIENT_ID));

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(FiefAdminApiUnauthorizedError);
    expect(attempts).toBe(1);
  });

  it("returns FiefAdminApiSchemaError when the body fails Zod parse", async () => {
    server.use(
      http.get(`${ADMIN_BASE}/clients/${CLIENT_ID}`, () => {
        /* `client_secret` is required but omitted -> schema mismatch. */
        return HttpResponse.json({
          id: CLIENT_ID,
          name: "broken",
        });
      }),
    );

    const result = await buildClient().getClient(token(), FiefClientIdSchema.parse(CLIENT_ID));

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(FiefAdminApiSchemaError);
  });
});
