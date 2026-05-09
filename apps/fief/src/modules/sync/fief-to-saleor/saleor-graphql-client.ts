import { type TypedDocumentNode } from "@graphql-typed-document-node/core";
import { print } from "graphql";
import { err, ok, type Result } from "neverthrow";

import {
  FiefCustomerCreateDocument,
  type FiefCustomerCreateMutation,
  type FiefCustomerCreateMutationVariables,
  FiefUpdateMetadataDocument,
  type FiefUpdateMetadataMutation,
  type FiefUpdateMetadataMutationVariables,
  FiefUpdatePrivateMetadataDocument,
  type FiefUpdatePrivateMetadataMutation,
  type FiefUpdatePrivateMetadataMutationVariables,
  FiefUserDocument,
  type FiefUserQuery,
  type FiefUserQueryVariables,
} from "@/generated/graphql";
import { createLogger } from "@/lib/logger";
import { createSaleorUserId, type SaleorUserId } from "@/modules/identity-map/identity-map";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import {
  type CreatedSaleorCustomer,
  type SaleorCustomerClient,
  type SaleorCustomerWriteError,
  UserUpsertUseCaseError,
} from "./user-upsert.use-case";

/*
 * T7 — production wiring for the Saleor write surface.
 *
 * Implements `SaleorCustomerClient` against Saleor's admin GraphQL using the
 * generated documents in `/generated/graphql.ts` (already scaffolded by the
 * `pnpm generate` codegen pass). Authenticated via the per-install app token
 * that the SaleorApp install flow records in the APL — `tokenProvider` is the
 * `(saleorApiUrl) → AuthData` lookup; the call site in `composition-root.ts`
 * binds it to `apl.get`.
 *
 * `customerCreate` does **find-or-create-by-email**:
 *
 *   1. Query `FiefUser(email:)` first. If a Saleor `User` with that email
 *      already exists (e.g. an existing customer with order history), bind
 *      the identity_map row to that user's id. This is the "owns historical
 *      orders" requirement — same email = same Saleor customer record.
 *   2. Otherwise call `FiefCustomerCreate` with the projected fields.
 *   3. On a `UNIQUE` race (two concurrent first-logins for the same email),
 *      re-query the `FiefUser` lookup once and return that row. Saleor's
 *      unique-email constraint guarantees the second create's user is the
 *      same identity the first request established.
 *
 * /* cspell:words retriable
 */
/*
 * Errors are wrapped in `SaleorCustomerCreateFailed` / `SaleorMetadataWriteFailed`
 * to match the use-case contract. Network/HTTP/JSON failures (`fetch` rejects
 * or non-2xx) are mapped to the same write-failure shapes — they're retriable
 * from T19's perspective.
 */

const logger = createLogger("modules.sync.fief-to-saleor.saleor-graphql-client");

export interface SaleorAppAuthData {
  saleorApiUrl: string;
  token: string;
}

export type SaleorAppTokenProvider = (
  saleorApiUrl: string,
) => Promise<SaleorAppAuthData | undefined>;

const HTTP_TIMEOUT_MS = 15_000;

interface ExecuteInput<TResult, TVariables> {
  saleorApiUrl: SaleorApiUrl;
  document: TypedDocumentNode<TResult, TVariables>;
  variables: TVariables;
  appToken: string;
}

interface GraphQLEnvelope<T> {
  data?: T;
  errors?: ReadonlyArray<{ message: string }>;
}

const executeGraphQL = async <TResult, TVariables>(
  input: ExecuteInput<TResult, TVariables>,
): Promise<Result<TResult, Error>> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  let response: Response;

  try {
    response = await fetch(input.saleorApiUrl as unknown as string, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.appToken}`,
      },
      body: JSON.stringify({
        query: print(input.document),
        variables: input.variables,
      }),
      signal: controller.signal,
    });
  } catch (cause) {
    return err(
      new Error(
        `Saleor GraphQL fetch failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    return err(new Error(`Saleor GraphQL returned HTTP ${response.status}`));
  }

  let body: GraphQLEnvelope<TResult>;

  try {
    body = (await response.json()) as GraphQLEnvelope<TResult>;
  } catch (cause) {
    return err(
      new Error(
        `Saleor GraphQL response body was not JSON: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      ),
    );
  }

  if (body.errors && body.errors.length > 0) {
    return err(new Error(`Saleor GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`));
  }

  if (!body.data) {
    return err(new Error("Saleor GraphQL returned no data"));
  }

  return ok(body.data);
};

const wrapCreateFailed = (message: string, cause?: Error) =>
  new UserUpsertUseCaseError.SaleorCustomerCreateFailed(message, cause ? { cause } : undefined);

const wrapMetadataFailed = (message: string, cause?: Error) =>
  new UserUpsertUseCaseError.SaleorMetadataWriteFailed(message, cause ? { cause } : undefined);

const brandUserId = (rawId: string): Result<SaleorUserId, ReturnType<typeof wrapCreateFailed>> => {
  const result = createSaleorUserId(rawId);

  if (result.isErr()) {
    return err(wrapCreateFailed(`Saleor returned an unbrandable user id: ${rawId}`));
  }

  return ok(result.value);
};

interface ClientDeps {
  /**
   * Resolves a saleorApiUrl to the install's app-token. Production binds this
   * to the APL (`apl.get(...)`); tests inject a static map.
   */
  tokenProvider: SaleorAppTokenProvider;
}

export const createSaleorGraphQLCustomerClient = (deps: ClientDeps): SaleorCustomerClient => {
  const getToken = async (saleorApiUrl: SaleorApiUrl): Promise<Result<string, Error>> => {
    const auth = await deps.tokenProvider(saleorApiUrl as unknown as string);

    if (!auth || !auth.token) {
      return err(new Error(`No app token registered in APL for ${String(saleorApiUrl)}`));
    }

    return ok(auth.token);
  };

  const findUserByEmail = async (
    saleorApiUrl: SaleorApiUrl,
    appToken: string,
    email: string,
  ): Promise<Result<{ id: string; email: string } | null, Error>> => {
    const variables: FiefUserQueryVariables = { email, id: null, externalReference: null };
    const result = await executeGraphQL<FiefUserQuery, FiefUserQueryVariables>({
      saleorApiUrl,
      document: FiefUserDocument,
      variables,
      appToken,
    });

    if (result.isErr()) return err(result.error);
    const user = result.value.user;

    if (!user) return ok(null);

    return ok({ id: user.id, email: user.email });
  };

  return {
    async customerCreate(input): Promise<Result<CreatedSaleorCustomer, SaleorCustomerWriteError>> {
      const tokenResult = await getToken(input.saleorApiUrl);

      if (tokenResult.isErr()) {
        return err(wrapCreateFailed(tokenResult.error.message, tokenResult.error));
      }
      const appToken = tokenResult.value;

      // -- 1. Find existing user by email ----------------------------------

      const existing = await findUserByEmail(input.saleorApiUrl, appToken, input.email);

      if (existing.isErr()) {
        return err(wrapCreateFailed(existing.error.message, existing.error));
      }
      if (existing.value) {
        const branded = brandUserId(existing.value.id);

        if (branded.isErr()) return err(branded.error);
        logger.info("customerCreate: bound to existing Saleor user (email match)", {
          email: input.email,
        });

        return ok({ saleorUserId: branded.value, email: existing.value.email });
      }

      // -- 2. Create new user ----------------------------------------------

      const createVariables: FiefCustomerCreateMutationVariables = {
        input: {
          email: input.email,
          firstName: input.firstName,
          lastName: input.lastName,
          isActive: input.isActive,
        },
      };
      const created = await executeGraphQL<
        FiefCustomerCreateMutation,
        FiefCustomerCreateMutationVariables
      >({
        saleorApiUrl: input.saleorApiUrl,
        document: FiefCustomerCreateDocument,
        variables: createVariables,
        appToken,
      });

      if (created.isErr()) {
        return err(wrapCreateFailed(created.error.message, created.error));
      }

      const payload = created.value.customerCreate;

      if (payload?.user) {
        const branded = brandUserId(payload.user.id);

        if (branded.isErr()) return err(branded.error);

        return ok({ saleorUserId: branded.value, email: payload.user.email });
      }

      // -- 3. UNIQUE race — re-query and return whatever now exists --------

      const isUniqueRace = (payload?.errors ?? []).some(
        (e) => e.code === "UNIQUE" && (!e.field || e.field === "email"),
      );

      if (isUniqueRace) {
        const reread = await findUserByEmail(input.saleorApiUrl, appToken, input.email);

        if (reread.isErr()) {
          return err(wrapCreateFailed(reread.error.message, reread.error));
        }
        if (reread.value) {
          const branded = brandUserId(reread.value.id);

          if (branded.isErr()) return err(branded.error);
          logger.info("customerCreate: resolved UNIQUE-email race via re-read", {
            email: input.email,
          });

          return ok({ saleorUserId: branded.value, email: reread.value.email });
        }
      }

      const errorMessage = (payload?.errors ?? [])
        .map((e) => `${e.code}${e.field ? `(${e.field})` : ""}: ${e.message ?? ""}`)
        .join("; ");

      return err(
        wrapCreateFailed(
          `Saleor customerCreate returned no user. errors=[${errorMessage || "none"}]`,
        ),
      );
    },

    async updateMetadata(input): Promise<Result<void, SaleorCustomerWriteError>> {
      const tokenResult = await getToken(input.saleorApiUrl);

      if (tokenResult.isErr()) {
        return err(wrapMetadataFailed(tokenResult.error.message, tokenResult.error));
      }

      const variables: FiefUpdateMetadataMutationVariables = {
        id: input.saleorUserId as unknown as string,
        input: input.items,
      };
      const result = await executeGraphQL<
        FiefUpdateMetadataMutation,
        FiefUpdateMetadataMutationVariables
      >({
        saleorApiUrl: input.saleorApiUrl,
        document: FiefUpdateMetadataDocument,
        variables,
        appToken: tokenResult.value,
      });

      if (result.isErr()) {
        return err(wrapMetadataFailed(result.error.message, result.error));
      }

      const errors = result.value.updateMetadata?.errors ?? [];

      if (errors.length > 0) {
        return err(
          wrapMetadataFailed(
            `updateMetadata errors: ${errors
              .map((e) => `${e.code}: ${e.message ?? ""}`)
              .join("; ")}`,
          ),
        );
      }

      return ok(undefined);
    },

    async updatePrivateMetadata(input): Promise<Result<void, SaleorCustomerWriteError>> {
      const tokenResult = await getToken(input.saleorApiUrl);

      if (tokenResult.isErr()) {
        return err(wrapMetadataFailed(tokenResult.error.message, tokenResult.error));
      }

      const variables: FiefUpdatePrivateMetadataMutationVariables = {
        id: input.saleorUserId as unknown as string,
        input: input.items,
      };
      const result = await executeGraphQL<
        FiefUpdatePrivateMetadataMutation,
        FiefUpdatePrivateMetadataMutationVariables
      >({
        saleorApiUrl: input.saleorApiUrl,
        document: FiefUpdatePrivateMetadataDocument,
        variables,
        appToken: tokenResult.value,
      });

      if (result.isErr()) {
        return err(wrapMetadataFailed(result.error.message, result.error));
      }

      const errors = result.value.updatePrivateMetadata?.errors ?? [];

      if (errors.length > 0) {
        return err(
          wrapMetadataFailed(
            `updatePrivateMetadata errors: ${errors
              .map((e) => `${e.code}: ${e.message ?? ""}`)
              .join("; ")}`,
          ),
        );
      }

      return ok(undefined);
    },
  };
};
