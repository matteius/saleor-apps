import { err, ok } from "neverthrow";
import type Stripe from "stripe";
import { type Client } from "urql";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SubscriptionCustomerCreateDocument,
  SubscriptionFindCustomerByEmailDocument,
} from "@/generated/graphql";
import { StripeInvalidRequestError } from "@/modules/stripe/stripe-api-error";
import { type IStripeCustomerApi } from "@/modules/subscriptions/api/stripe-customer-api";

import { SaleorCustomerResolver, SaleorCustomerResolverError } from "./saleor-customer-resolver";

/**
 * Build a fake `Pick<Client, "mutation" | "query">` whose query+mutation
 * dispatches by document, mirroring the pattern used by T9's
 * `saleor-order-from-invoice.test.ts`.
 */
function buildFakeGraphqlClient(opts: {
  findCustomerResponse?: { data?: unknown; error?: unknown };
  customerCreateResponse?: { data?: unknown; error?: unknown };
}) {
  const query = vi.fn((doc: unknown, _vars: unknown) => ({
    async toPromise() {
      if (doc === SubscriptionFindCustomerByEmailDocument) {
        return (
          opts.findCustomerResponse ?? {
            data: { customers: { edges: [] } },
          }
        );
      }
      throw new Error(`Unexpected query document: ${String(doc)}`);
    },
  }));

  const mutation = vi.fn(async (doc: unknown, _vars: unknown) => {
    if (doc === SubscriptionCustomerCreateDocument) {
      return (
        opts.customerCreateResponse ?? {
          data: {
            customerCreate: {
              user: { id: "VXNlcjpuZXc=", email: "user@example.com" },
              errors: [],
            },
          },
        }
      );
    }
    throw new Error(`Unexpected mutation document: ${String(doc)}`);
  });

  return { mutation, query } as unknown as Pick<Client, "mutation" | "query"> & {
    mutation: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  };
}

type FakeStripeCustomerApi = IStripeCustomerApi & {
  createCustomer: ReturnType<typeof vi.fn>;
  updateCustomer: ReturnType<typeof vi.fn>;
  retrieveCustomer: ReturnType<typeof vi.fn>;
};

function buildFakeStripeCustomerApi(overrides?: {
  createCustomer?: ReturnType<typeof vi.fn>;
  updateCustomer?: ReturnType<typeof vi.fn>;
  retrieveCustomer?: ReturnType<typeof vi.fn>;
}): FakeStripeCustomerApi {
  const fake = {
    createCustomer: vi.fn(async () => ok({ id: "cus_new_001" } as unknown as Stripe.Customer)),
    updateCustomer: vi.fn(async () => ok({ id: "cus_new_001" } as unknown as Stripe.Customer)),
    retrieveCustomer: vi.fn(async () =>
      ok({ id: "cus_existing_001", deleted: false } as unknown as Stripe.Customer),
    ),
    ...overrides,
  };

  return fake as unknown as FakeStripeCustomerApi;
}

describe("SaleorCustomerResolver.resolveSaleorUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the existing Saleor user id and does NOT call customerCreate when a customer matches the email", async () => {
    const client = buildFakeGraphqlClient({
      findCustomerResponse: {
        data: {
          customers: {
            edges: [{ node: { id: "VXNlcjoxMjM=", email: "user@example.com" } }],
          },
        },
      },
    });

    const resolver = new SaleorCustomerResolver();
    const result = await resolver.resolveSaleorUser({
      fiefUserId: "fief-abc",
      email: "user@example.com",
      graphqlClient: client,
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toStrictEqual({ saleorUserId: "VXNlcjoxMjM=" });

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0][0]).toBe(SubscriptionFindCustomerByEmailDocument);
    expect(client.query.mock.calls[0][1]).toStrictEqual({ email: "user@example.com" });
    expect(client.mutation).not.toHaveBeenCalled();
  });

  it("matches case-insensitively on email but only treats EXACT email matches as a hit (substring search false-positives are filtered)", async () => {
    /*
     * Saleor's `customers(filter: {search})` is a substring search, so a
     * search for `bob@example.com` could return `bob@example.com.au`. The
     * resolver must treat that as a miss and fall through to create.
     */
    const client = buildFakeGraphqlClient({
      findCustomerResponse: {
        data: {
          customers: {
            edges: [{ node: { id: "VXNlcjowMA==", email: "bob@example.com.au" } }],
          },
        },
      },
    });

    const resolver = new SaleorCustomerResolver();
    const result = await resolver.resolveSaleorUser({
      fiefUserId: "fief-bob",
      email: "bob@example.com",
      graphqlClient: client,
    });

    expect(result.isOk()).toBe(true);
    // Falls through to customerCreate, returning the new id from the default response.
    expect(result._unsafeUnwrap()).toStrictEqual({ saleorUserId: "VXNlcjpuZXc=" });
    expect(client.mutation).toHaveBeenCalledTimes(1);
  });

  it("creates a new Saleor customer when none exists and writes fiefUserId into metadata", async () => {
    const client = buildFakeGraphqlClient({
      findCustomerResponse: { data: { customers: { edges: [] } } },
      customerCreateResponse: {
        data: {
          customerCreate: {
            user: { id: "VXNlcjo5OTk=", email: "new@example.com" },
            errors: [],
          },
        },
      },
    });

    const resolver = new SaleorCustomerResolver();
    const result = await resolver.resolveSaleorUser({
      fiefUserId: "fief-new-user",
      email: "new@example.com",
      graphqlClient: client,
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toStrictEqual({ saleorUserId: "VXNlcjo5OTk=" });

    expect(client.mutation).toHaveBeenCalledTimes(1);
    const [createDoc, createVars] = client.mutation.mock.calls[0];

    expect(createDoc).toBe(SubscriptionCustomerCreateDocument);
    expect(createVars).toStrictEqual({
      input: {
        email: "new@example.com",
        firstName: "",
        lastName: "",
        metadata: [{ key: "fiefUserId", value: "fief-new-user" }],
      },
    });
  });

  it("returns SaleorUserResolverError when the lookup query throws (network error)", async () => {
    const client = {
      query: vi.fn(() => ({
        async toPromise() {
          throw new Error("network down");
        },
      })),
      mutation: vi.fn(),
    } as unknown as Pick<Client, "query" | "mutation"> & {
      query: ReturnType<typeof vi.fn>;
      mutation: ReturnType<typeof vi.fn>;
    };

    const resolver = new SaleorCustomerResolver();
    const result = await resolver.resolveSaleorUser({
      fiefUserId: "fief-abc",
      email: "user@example.com",
      graphqlClient: client,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(
      SaleorCustomerResolverError.SaleorUserResolverError,
    );
    expect(client.mutation).not.toHaveBeenCalled();
  });

  it("returns SaleorUserResolverError when the lookup query returns a transport error", async () => {
    const client = buildFakeGraphqlClient({
      findCustomerResponse: { error: new Error("urql transport failure") },
    });

    const resolver = new SaleorCustomerResolver();
    const result = await resolver.resolveSaleorUser({
      fiefUserId: "fief-abc",
      email: "user@example.com",
      graphqlClient: client,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(
      SaleorCustomerResolverError.SaleorUserResolverError,
    );
    expect(client.mutation).not.toHaveBeenCalled();
  });

  it("returns SaleorUserResolverError when customerCreate returns AccountErrors", async () => {
    const client = buildFakeGraphqlClient({
      customerCreateResponse: {
        data: {
          customerCreate: {
            user: null,
            errors: [{ field: "email", message: "Already exists", code: "UNIQUE" }],
          },
        },
      },
    });

    const resolver = new SaleorCustomerResolver();
    const result = await resolver.resolveSaleorUser({
      fiefUserId: "fief-abc",
      email: "dup@example.com",
      graphqlClient: client,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(
      SaleorCustomerResolverError.SaleorUserResolverError,
    );
    expect(client.mutation).toHaveBeenCalledTimes(1);
  });

  it("returns SaleorUserResolverError when customerCreate returns no user.id", async () => {
    const client = buildFakeGraphqlClient({
      customerCreateResponse: {
        data: { customerCreate: { user: null, errors: [] } },
      },
    });

    const resolver = new SaleorCustomerResolver();
    const result = await resolver.resolveSaleorUser({
      fiefUserId: "fief-abc",
      email: "x@example.com",
      graphqlClient: client,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(
      SaleorCustomerResolverError.SaleorUserResolverError,
    );
  });

  it("rejects empty email up-front without making any Saleor calls", async () => {
    const client = buildFakeGraphqlClient({});

    const resolver = new SaleorCustomerResolver();
    const result = await resolver.resolveSaleorUser({
      fiefUserId: "fief-abc",
      email: "",
      graphqlClient: client,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(
      SaleorCustomerResolverError.SaleorUserResolverError,
    );
    expect(client.query).not.toHaveBeenCalled();
    expect(client.mutation).not.toHaveBeenCalled();
  });
});

describe("SaleorCustomerResolver.resolveStripeCustomer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the existing Stripe customer id and does NOT call createCustomer when retrieve succeeds", async () => {
    const stripeApi = buildFakeStripeCustomerApi({
      retrieveCustomer: vi.fn(async () =>
        ok({ id: "cus_existing_777" } as unknown as Stripe.Customer),
      ),
    });

    const resolver = new SaleorCustomerResolver();
    const result = await resolver.resolveStripeCustomer({
      fiefUserId: "fief-abc",
      email: "user@example.com",
      saleorUserId: "VXNlcjoxMjM=",
      stripeCustomerApi: stripeApi,
      existingStripeCustomerId: "cus_existing_777",
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toStrictEqual({ stripeCustomerId: "cus_existing_777" });

    expect(stripeApi.retrieveCustomer).toHaveBeenCalledExactlyOnceWith({
      customerId: "cus_existing_777",
    });
    expect(stripeApi.createCustomer).not.toHaveBeenCalled();
  });

  it("falls through to createCustomer when retrieve returns a DeletedCustomer", async () => {
    const stripeApi = buildFakeStripeCustomerApi({
      retrieveCustomer: vi.fn(async () =>
        ok({
          id: "cus_existing_777",
          deleted: true,
        } as unknown as Stripe.DeletedCustomer),
      ),
      createCustomer: vi.fn(async () => ok({ id: "cus_new_888" } as unknown as Stripe.Customer)),
    });

    const resolver = new SaleorCustomerResolver();
    const result = await resolver.resolveStripeCustomer({
      fiefUserId: "fief-abc",
      email: "user@example.com",
      saleorUserId: "VXNlcjoxMjM=",
      stripeCustomerApi: stripeApi,
      existingStripeCustomerId: "cus_existing_777",
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toStrictEqual({ stripeCustomerId: "cus_new_888" });
    expect(stripeApi.createCustomer).toHaveBeenCalledTimes(1);
  });

  it("falls through to createCustomer when retrieve returns Err (e.g. 404 from Stripe)", async () => {
    const stripeApi = buildFakeStripeCustomerApi({
      retrieveCustomer: vi.fn(async () => err(new StripeInvalidRequestError("No such customer"))),
      createCustomer: vi.fn(async () => ok({ id: "cus_brand_new" } as unknown as Stripe.Customer)),
    });

    const resolver = new SaleorCustomerResolver();
    const result = await resolver.resolveStripeCustomer({
      fiefUserId: "fief-abc",
      email: "user@example.com",
      saleorUserId: "VXNlcjoxMjM=",
      stripeCustomerApi: stripeApi,
      existingStripeCustomerId: "cus_stale_999",
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toStrictEqual({ stripeCustomerId: "cus_brand_new" });
    expect(stripeApi.createCustomer).toHaveBeenCalledTimes(1);
  });

  it("creates a new Stripe customer when no existingStripeCustomerId is provided, passing fiefUserId+saleorUserId metadata", async () => {
    const stripeApi = buildFakeStripeCustomerApi({
      createCustomer: vi.fn(async () => ok({ id: "cus_brand_new" } as unknown as Stripe.Customer)),
    });

    const resolver = new SaleorCustomerResolver();
    const result = await resolver.resolveStripeCustomer({
      fiefUserId: "fief-zzz",
      email: "new@example.com",
      saleorUserId: "VXNlcjpuZXc=",
      stripeCustomerApi: stripeApi,
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toStrictEqual({ stripeCustomerId: "cus_brand_new" });

    expect(stripeApi.retrieveCustomer).not.toHaveBeenCalled();
    expect(stripeApi.createCustomer).toHaveBeenCalledExactlyOnceWith({
      email: "new@example.com",
      fiefUserId: "fief-zzz",
      saleorUserId: "VXNlcjpuZXc=",
    });
  });

  it("returns StripeCustomerResolverError when createCustomer fails", async () => {
    const stripeApi = buildFakeStripeCustomerApi({
      createCustomer: vi.fn(async () => err(new StripeInvalidRequestError("rate limited"))),
    });

    const resolver = new SaleorCustomerResolver();
    const result = await resolver.resolveStripeCustomer({
      fiefUserId: "fief-abc",
      email: "user@example.com",
      saleorUserId: "VXNlcjoxMjM=",
      stripeCustomerApi: stripeApi,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(
      SaleorCustomerResolverError.StripeCustomerResolverError,
    );
  });
});
