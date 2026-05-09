/*
 * @vitest-environment node
 *
 * Unit tests for the production T7 `SaleorCustomerClient`. The client is
 * deliberately fetch-based (no urql, no app-sdk client wrapper) so the test
 * surface is just `globalThis.fetch` and we can pin the wire shape exactly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSaleorApiUrl, type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import {
  createSaleorGraphQLCustomerClient,
  type SaleorAppTokenProvider,
} from "./saleor-graphql-client";
import { UserUpsertUseCaseError } from "./user-upsert.use-case";

const SALEOR_API_URL: SaleorApiUrl = createSaleorApiUrl(
  "https://api.shop.example/graphql/",
)._unsafeUnwrap();

const APP_TOKEN = "saleor-app-token-test";

const tokenProvider: SaleorAppTokenProvider = async () => ({
  saleorApiUrl: SALEOR_API_URL as unknown as string,
  token: APP_TOKEN,
});

interface MockResponse {
  status?: number;
  body: unknown;
}

const mockFetchOnce = (response: MockResponse) => {
  const json = JSON.stringify(response.body);

  return vi.fn().mockResolvedValueOnce(
    new Response(json, {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    }),
  );
};

const mockFetchSequence = (responses: MockResponse[]) => {
  const fn = vi.fn();

  for (const r of responses) {
    fn.mockResolvedValueOnce(
      new Response(JSON.stringify(r.body), {
        status: r.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }

  return fn;
};

describe("SaleorCustomerClient — production GraphQL impl (T7)", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("customerCreate — find-or-create-by-email", () => {
    it("returns the existing user when email already maps to a Saleor User", async () => {
      const fetchMock = mockFetchOnce({
        body: {
          data: {
            user: {
              id: "VXNlcjox",
              email: "alice@example.com",
              firstName: "Alice",
              lastName: "Liddell",
              isActive: true,
              metadata: [],
              privateMetadata: [],
            },
          },
        },
      });

      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = createSaleorGraphQLCustomerClient({ tokenProvider });

      const result = await client.customerCreate({
        saleorApiUrl: SALEOR_API_URL,
        email: "alice@example.com",
        firstName: "Alice",
      });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toStrictEqual({
        saleorUserId: "VXNlcjox",
        email: "alice@example.com",
      });

      // Only one fetch call — the FiefUser lookup. No customerCreate.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0]!;
      const payload = JSON.parse(init.body as string) as { query: string; variables: unknown };

      expect(payload.query).toContain("query FiefAuthFindUser");
      expect(payload.variables).toMatchObject({ email: "alice@example.com" });
    });

    it("creates a new user when no existing email match", async () => {
      const fetchMock = mockFetchSequence([
        // Lookup → no user
        { body: { data: { user: null } } },
        // Create → returns new user
        {
          body: {
            data: {
              customerCreate: {
                user: {
                  id: "VXNlcjoyMA==",
                  email: "bob@example.com",
                  firstName: "Bob",
                  lastName: "Builder",
                  isActive: true,
                  metadata: [],
                  privateMetadata: [],
                },
                errors: [],
              },
            },
          },
        },
      ]);

      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = createSaleorGraphQLCustomerClient({ tokenProvider });

      const result = await client.customerCreate({
        saleorApiUrl: SALEOR_API_URL,
        email: "bob@example.com",
        firstName: "Bob",
        lastName: "Builder",
        isActive: true,
      });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toStrictEqual({
        saleorUserId: "VXNlcjoyMA==",
        email: "bob@example.com",
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const createCall = fetchMock.mock.calls[1]!;
      const createBody = JSON.parse(createCall[1].body as string) as {
        query: string;
        variables: { input: { email: string } };
      };

      expect(createBody.query).toContain("mutation FiefAuthCustomerCreate");
      expect(createBody.variables.input.email).toBe("bob@example.com");
    });

    it("resolves the UNIQUE-email race by re-querying the lookup", async () => {
      const fetchMock = mockFetchSequence([
        // First lookup → none
        { body: { data: { user: null } } },
        // Create → UNIQUE email error (concurrent first-login won)
        {
          body: {
            data: {
              customerCreate: {
                user: null,
                errors: [{ field: "email", message: "Email already taken", code: "UNIQUE" }],
              },
            },
          },
        },
        // Re-read → returns the user the race winner created
        {
          body: {
            data: {
              user: {
                id: "VXNlcjoyMQ==",
                email: "carol@example.com",
                firstName: "",
                lastName: "",
                isActive: true,
                metadata: [],
                privateMetadata: [],
              },
            },
          },
        },
      ]);

      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = createSaleorGraphQLCustomerClient({ tokenProvider });

      const result = await client.customerCreate({
        saleorApiUrl: SALEOR_API_URL,
        email: "carol@example.com",
      });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toStrictEqual({
        saleorUserId: "VXNlcjoyMQ==",
        email: "carol@example.com",
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("returns SaleorCustomerCreateFailed when the app token is missing", async () => {
      const emptyTokenProvider: SaleorAppTokenProvider = async () => undefined;
      const client = createSaleorGraphQLCustomerClient({ tokenProvider: emptyTokenProvider });

      const result = await client.customerCreate({
        saleorApiUrl: SALEOR_API_URL,
        email: "dave@example.com",
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        UserUpsertUseCaseError.SaleorCustomerCreateFailed,
      );
    });

    it("returns SaleorCustomerCreateFailed when GraphQL returns a top-level error", async () => {
      const fetchMock = mockFetchOnce({
        body: { errors: [{ message: "Permission denied: MANAGE_USERS" }] },
      });

      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = createSaleorGraphQLCustomerClient({ tokenProvider });

      const result = await client.customerCreate({
        saleorApiUrl: SALEOR_API_URL,
        email: "eve@example.com",
      });

      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();

      expect(error).toBeInstanceOf(UserUpsertUseCaseError.SaleorCustomerCreateFailed);
      expect(error.message).toContain("Permission denied");
    });

    it("sends Authorization: Bearer <token> on every request", async () => {
      const fetchMock = mockFetchOnce({
        body: {
          data: {
            user: {
              id: "VXNlcjoz",
              email: "frank@example.com",
              firstName: "",
              lastName: "",
              isActive: true,
              metadata: [],
              privateMetadata: [],
            },
          },
        },
      });

      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = createSaleorGraphQLCustomerClient({ tokenProvider });

      await client.customerCreate({
        saleorApiUrl: SALEOR_API_URL,
        email: "frank@example.com",
      });

      const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;

      expect(headers.Authorization).toBe(`Bearer ${APP_TOKEN}`);
    });
  });

  describe("updateMetadata", () => {
    it("succeeds when Saleor returns no errors", async () => {
      const fetchMock = mockFetchOnce({
        body: {
          data: {
            updateMetadata: {
              item: {
                id: "VXNlcjox",
                email: "alice@example.com",
                firstName: "",
                lastName: "",
                isActive: true,
                metadata: [{ key: "fief.first_name", value: "Alice" }],
                privateMetadata: [],
              },
              errors: [],
            },
          },
        },
      });

      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = createSaleorGraphQLCustomerClient({ tokenProvider });

      const result = await client.updateMetadata({
        saleorApiUrl: SALEOR_API_URL,
        saleorUserId: "VXNlcjox" as never,
        items: [{ key: "fief.first_name", value: "Alice" }],
      });

      expect(result.isOk()).toBe(true);
    });

    it("returns SaleorMetadataWriteFailed when mutation reports errors", async () => {
      const fetchMock = mockFetchOnce({
        body: {
          data: {
            updateMetadata: {
              item: null,
              errors: [{ field: "id", message: "Not found", code: "NOT_FOUND" }],
            },
          },
        },
      });

      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = createSaleorGraphQLCustomerClient({ tokenProvider });

      const result = await client.updateMetadata({
        saleorApiUrl: SALEOR_API_URL,
        saleorUserId: "VXNlcjo5OQ==" as never,
        items: [{ key: "x", value: "y" }],
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(
        UserUpsertUseCaseError.SaleorMetadataWriteFailed,
      );
    });
  });
});
