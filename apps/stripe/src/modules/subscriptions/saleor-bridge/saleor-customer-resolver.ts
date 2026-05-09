/**
 * Resolves a Saleor User and a Stripe Customer for a Fief user identity.
 *
 * - `resolveSaleorUser` looks up by email via Saleor's `customers(filter:
 *   {search: email}, first: 1)` query and creates a new Saleor customer via
 *   `customerCreate` if none is found. The new user is created with empty
 *   first/last names (we don't always have them at sign-up time) and a
 *   `metadata: [{key: "fiefUserId", value}]` entry so the Saleor side has a
 *   reverse pointer back to the Fief identity.
 * - `resolveStripeCustomer` accepts an `existingStripeCustomerId` (typically
 *   read off `userSubscription.stripeCustomerId`) and confirms it still exists
 *   via `stripeCustomerApi.retrieveCustomer`; on miss it falls back to
 *   `stripeCustomerApi.createCustomer` with `fiefUserId` + `saleorUserId`
 *   carried in Stripe metadata for round-trip identification on webhooks.
 *
 * Implementation for plan task T11.
 */
import { err, ok, type Result } from "neverthrow";
import { type Client } from "urql";

import {
  type AccountErrorCode,
  SubscriptionCustomerCreateDocument,
  SubscriptionFindCustomerByEmailDocument,
} from "@/generated/graphql";
import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";

import { type IStripeCustomerApi } from "../api/stripe-customer-api";

const SaleorUserResolverError = BaseError.subclass(
  "SaleorCustomerResolver.SaleorUserResolverError",
  {
    props: {
      _internalName: "SaleorCustomerResolver.SaleorUserResolverError",
    },
  },
);

const StripeCustomerResolverError = BaseError.subclass(
  "SaleorCustomerResolver.StripeCustomerResolverError",
  {
    props: {
      _internalName: "SaleorCustomerResolver.StripeCustomerResolverError",
    },
  },
);

export const SaleorCustomerResolverError = {
  SaleorUserResolverError,
  StripeCustomerResolverError,
};

export type SaleorUserResolverError = InstanceType<typeof SaleorUserResolverError>;
export type StripeCustomerResolverError = InstanceType<typeof StripeCustomerResolverError>;

export type SaleorCustomerResolverError = SaleorUserResolverError | StripeCustomerResolverError;

export interface ResolveSaleorUserArgs {
  fiefUserId: string;
  email: string;
  /**
   * Saleor GraphQL client built via `createInstrumentedGraphqlClient(authData)`
   * (see `apps/stripe/src/lib/graphql-client.ts`). Accepted as a dependency so
   * the same APL-resolved auth is used for query + mutation calls.
   */
  graphqlClient: Pick<Client, "mutation" | "query">;
}

export interface ResolveStripeCustomerArgs {
  fiefUserId: string;
  email: string;
  saleorUserId: string;
  stripeCustomerApi: IStripeCustomerApi;
  /**
   * Pre-existing Stripe Customer ID (typically read off
   * `userSubscription.stripeCustomerId` in the OwlBooks DB). When provided the
   * resolver will `retrieveCustomer` to confirm it still exists rather than
   * always creating a new customer.
   */
  existingStripeCustomerId?: string;
}

export interface ResolveSaleorUserResult {
  saleorUserId: string;
}

export interface ResolveStripeCustomerResult {
  stripeCustomerId: string;
}

export interface ISaleorCustomerResolver {
  resolveSaleorUser(
    args: ResolveSaleorUserArgs,
  ): Promise<Result<ResolveSaleorUserResult, SaleorUserResolverError>>;

  resolveStripeCustomer(
    args: ResolveStripeCustomerArgs,
  ): Promise<Result<ResolveStripeCustomerResult, StripeCustomerResolverError>>;
}

const logger = createLogger("SaleorCustomerResolver");

function formatAccountErrors(
  errors: ReadonlyArray<{
    readonly field?: string | null;
    readonly message?: string | null;
    readonly code: AccountErrorCode;
  }>,
): string {
  return errors
    .map((e) => `${e.code}${e.field ? `(${e.field})` : ""}: ${e.message ?? "<no message>"}`)
    .join("; ");
}

export class SaleorCustomerResolver implements ISaleorCustomerResolver {
  async resolveSaleorUser(
    args: ResolveSaleorUserArgs,
  ): Promise<Result<ResolveSaleorUserResult, SaleorUserResolverError>> {
    const { fiefUserId, email, graphqlClient } = args;

    if (!email) {
      return err(new SaleorUserResolverError("Cannot resolve Saleor user without an email"));
    }

    /*
     * Step 1: try to find an existing customer by email. We ask for the
     * minimal connection (`first: 1`) — Saleor's `customers(filter: {search})`
     * is a substring search, so we still need to defend against a
     * near-duplicate match by checking the returned `node.email` exactly
     * (case-insensitive, since Stripe normalizes to lower-case but Saleor
     * stores raw).
     */
    let lookupResponse;

    try {
      lookupResponse = await graphqlClient
        .query(SubscriptionFindCustomerByEmailDocument, { email })
        .toPromise();
    } catch (e) {
      return err(
        new SaleorUserResolverError("Network error querying Saleor customers by email", {
          cause: e,
        }),
      );
    }

    if (lookupResponse.error) {
      return err(
        new SaleorUserResolverError("GraphQL transport error on customers-by-email query", {
          cause: lookupResponse.error,
        }),
      );
    }

    const edges = lookupResponse.data?.customers?.edges ?? [];
    const exactMatch = edges.find((edge) => edge.node.email.toLowerCase() === email.toLowerCase());

    if (exactMatch) {
      logger.info("Resolved existing Saleor user by email", {
        saleorUserId: exactMatch.node.id,
        fiefUserId,
      });

      return ok({ saleorUserId: exactMatch.node.id });
    }

    /*
     * Step 2: no existing user — create one. We carry `fiefUserId` in Saleor
     * metadata so the Saleor admin (and any downstream service) can resolve
     * back to the Fief identity without a DB hit.
     */
    let createResponse;

    try {
      createResponse = await graphqlClient.mutation(SubscriptionCustomerCreateDocument, {
        input: {
          email,
          firstName: "",
          lastName: "",
          metadata: [{ key: "fiefUserId", value: fiefUserId }],
        },
      });
    } catch (e) {
      return err(new SaleorUserResolverError("Network error calling customerCreate", { cause: e }));
    }

    if (createResponse.error) {
      return err(
        new SaleorUserResolverError("GraphQL transport error on customerCreate", {
          cause: createResponse.error,
        }),
      );
    }

    const createMutation = createResponse.data?.customerCreate;
    const accountErrors = createMutation?.errors ?? [];

    if (accountErrors.length > 0) {
      return err(
        new SaleorUserResolverError(
          `customerCreate returned errors: ${formatAccountErrors(accountErrors)}`,
        ),
      );
    }

    const newUserId = createMutation?.user?.id;

    if (!newUserId) {
      return err(new SaleorUserResolverError("customerCreate returned no user.id"));
    }

    logger.info("Created Saleor user for Fief identity", {
      saleorUserId: newUserId,
      fiefUserId,
    });

    return ok({ saleorUserId: newUserId });
  }

  async resolveStripeCustomer(
    args: ResolveStripeCustomerArgs,
  ): Promise<Result<ResolveStripeCustomerResult, StripeCustomerResolverError>> {
    const { fiefUserId, email, saleorUserId, stripeCustomerApi, existingStripeCustomerId } = args;

    if (existingStripeCustomerId) {
      const retrieveResult = await stripeCustomerApi.retrieveCustomer({
        customerId: existingStripeCustomerId,
      });

      if (retrieveResult.isOk()) {
        const customer = retrieveResult.value;

        /*
         * `retrieveCustomer` may return a `DeletedCustomer` (`deleted: true`).
         * Treat that as "no existing customer" and fall through to create.
         */
        const isDeleted = (customer as { deleted?: boolean }).deleted === true;

        if (!isDeleted) {
          logger.info("Reused existing Stripe customer", {
            stripeCustomerId: customer.id,
            fiefUserId,
            saleorUserId,
          });

          return ok({ stripeCustomerId: customer.id });
        }
      }
      // Else: retrieve errored (likely 404 / missing). Fall through and create.
    }

    const createResult = await stripeCustomerApi.createCustomer({
      email,
      fiefUserId,
      saleorUserId,
    });

    if (createResult.isErr()) {
      return err(
        new StripeCustomerResolverError(
          `Failed to create Stripe customer for fiefUserId=${fiefUserId}`,
          { cause: createResult.error },
        ),
      );
    }

    const created = createResult.value;

    logger.info("Created Stripe customer for Fief identity", {
      stripeCustomerId: created.id,
      fiefUserId,
      saleorUserId,
    });

    return ok({ stripeCustomerId: created.id });
  }
}
