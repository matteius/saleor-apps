/**
 * T34 — `connections` tRPC sub-router.
 *
 * Procedures:
 *   - `list`             — read; redacts encrypted fields to presence booleans
 *   - `create`           — write; delegates to T17's `CreateConnectionUseCase`
 *   - `update`           — write; delegates to T17's `UpdateConnectionUseCase`
 *   - `rotateSecret`     — write; delegates to `RotateConnectionSecretUseCase.initiateRotation`
 *   - `confirmRotation`  — write; delegates to `RotateConnectionSecretUseCase.confirmRotation`
 *   - `delete`           — write; delegates to T17's `DeleteConnectionUseCase`
 *   - `testConnection`   — read; exercises T6 OIDC discovery + T5 admin-API auth,
 *                          returns a `{ oidcDiscovery, adminAuth, details? }` report
 *
 * Conventions
 * -----------
 *
 *   - All procedures sit behind `protectedClientProcedure` (T33), so the
 *     dashboard JWT + APL auth runs first.
 *
 *   - All writes go through the T17 use cases — never directly to the repo.
 *     The repo is only injected for the `list` read; tests assert that the
 *     other repo methods are not reachable from the tRPC layer.
 *
 *   - Branded primitives (ADR 0002) are constructed at the boundary: the
 *     dashboard sends raw strings, we re-parse via the schema's branded
 *     constructors before handing inputs to use cases. Invalid shapes
 *     surface as Zod errors → tRPC `BAD_REQUEST`.
 *
 *   - Listing redaction: every `encrypted*` field collapses to a boolean
 *     `has*` slot under a single `secrets: { ... }` object. Plaintext never
 *     leaves the server. The `branding.encryptedSigningKey` is folded into
 *     `secrets.hasSigningKey` to keep the shape predictable for T35's UI.
 *
 *   - Use-case errors are translated to tRPC errors per Stripe's
 *     "categorical mapping" convention — Fief upstream failures become
 *     `BAD_GATEWAY`, validation issues become `BAD_REQUEST`, missing rows
 *     become `NOT_FOUND`, everything else becomes `INTERNAL_SERVER_ERROR`.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { type FiefAdminApiClient } from "@/modules/fief-client/admin-api-client";
import { FiefAdminTokenSchema } from "@/modules/fief-client/admin-api-types";
import { type FiefOidcClient } from "@/modules/fief-client/oidc-client";
import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { protectedClientProcedure } from "@/modules/trpc/protected-client-procedure";
import { router } from "@/modules/trpc/trpc-server";

import {
  type AllowedOrigin,
  type ClaimMappingEntry,
  createAllowedOrigin,
  createFiefBaseUrl,
  createFiefTenantId,
  createProviderConnectionId,
  createProviderConnectionName,
  type ProviderConnection,
  type ProviderConnectionId,
} from "./provider-connection";
import { type ProviderConnectionRepo } from "./provider-connection-repo";
import {
  type CreateConnectionUseCase,
  type CreateConnectionUseCaseInput,
} from "./use-cases/create-connection.use-case";
import {
  type DeleteConnectionUseCase,
  type DeleteConnectionUseCaseInput,
} from "./use-cases/delete-connection.use-case";
import {
  type CancelRotationInput,
  type ConfirmRotationInput,
  type InitiateRotationInput,
  type InitiateRotationResult,
  type RotateConnectionSecretUseCase,
} from "./use-cases/rotate-connection-secret.use-case";
import {
  type UpdateConnectionUseCase,
  type UpdateConnectionUseCaseInput,
} from "./use-cases/update-connection.use-case";

/*
 * ----------------------------------------------------------------------------
 * Public response shapes
 * ----------------------------------------------------------------------------
 */

/**
 * Redacted view of a `ProviderConnection`. Encrypted slots collapse to
 * boolean presence flags so the dashboard knows which secrets are set
 * without ever seeing ciphertext (or — much worse — plaintext).
 */
export interface RedactedProviderConnection {
  id: string;
  saleorApiUrl: string;
  name: string;
  fief: {
    baseUrl: string;
    tenantId: string;
    clientId: string;
    webhookId: string | null;
  };
  branding: {
    allowedOrigins: string[];
  };
  claimMapping: ClaimMappingEntry[];
  softDeletedAt: string | null;
  /**
   * Presence flags for every encrypted slot. `pending*` are non-null only
   * during a rotation window (T17 `RotateConnectionSecretUseCase`).
   */
  secrets: {
    hasClientSecret: boolean;
    hasPendingClientSecret: boolean;
    hasAdminToken: boolean;
    hasWebhookSecret: boolean;
    hasPendingWebhookSecret: boolean;
    hasSigningKey: boolean;
  };
}

export const redactProviderConnection = (
  connection: ProviderConnection,
): RedactedProviderConnection => ({
  id: connection.id as unknown as string,
  saleorApiUrl: connection.saleorApiUrl as unknown as string,
  name: connection.name as unknown as string,
  fief: {
    baseUrl: connection.fief.baseUrl as unknown as string,
    tenantId: connection.fief.tenantId as unknown as string,
    clientId: connection.fief.clientId as unknown as string,
    webhookId:
      connection.fief.webhookId === null ? null : (connection.fief.webhookId as unknown as string),
  },
  branding: {
    allowedOrigins: connection.branding.allowedOrigins.map((o) => o as unknown as string),
  },
  claimMapping: connection.claimMapping,
  softDeletedAt: connection.softDeletedAt === null ? null : connection.softDeletedAt.toISOString(),
  secrets: {
    hasClientSecret: Boolean(connection.fief.encryptedClientSecret),
    hasPendingClientSecret: connection.fief.encryptedPendingClientSecret !== null,
    hasAdminToken: Boolean(connection.fief.encryptedAdminToken),
    hasWebhookSecret: Boolean(connection.fief.encryptedWebhookSecret),
    hasPendingWebhookSecret: connection.fief.encryptedPendingWebhookSecret !== null,
    hasSigningKey: Boolean(connection.branding.encryptedSigningKey),
  },
});

/*
 * ----------------------------------------------------------------------------
 * testConnection report
 * ----------------------------------------------------------------------------
 */

export interface TestConnectionReport {
  oidcDiscovery: "ok" | "error";
  adminAuth: "ok" | "error";
  /**
   * Per-transport diagnostic message when the corresponding status is
   * `"error"`. Operators see this in T35's UI; we intentionally surface only
   * the message text (not the full error object) to avoid leaking internals.
   */
  details?: {
    oidcDiscovery?: string;
    adminAuth?: string;
  };
}

/*
 * ----------------------------------------------------------------------------
 * Use-case error → TRPCError mapping
 * ----------------------------------------------------------------------------
 */

/**
 * Translate a typed lifecycle error into a tRPC error. Mirrors Stripe's
 * convention of categorical mapping rather than per-error name lookups.
 */
const mapLifecycleErrorToTrpc = (error: unknown): TRPCError => {
  const name = (error as { constructor?: { name?: string } })?.constructor?.name ?? "";
  const message = (error as { message?: string })?.message ?? "Connection lifecycle failed";

  if (name.includes("NotFound")) {
    return new TRPCError({ code: "NOT_FOUND", message });
  }
  if (name.includes("InvalidInput") || name.includes("Validation")) {
    return new TRPCError({ code: "BAD_REQUEST", message });
  }
  if (name.includes("AlreadyRotating") || name.includes("NoPendingRotation")) {
    return new TRPCError({ code: "CONFLICT", message });
  }
  if (
    name.includes("FiefProvisioningFailed") ||
    name.includes("FiefSyncFailed") ||
    name.includes("FiefDeprovisioningFailed")
  ) {
    /*
     * tRPC 10.x does not ship `BAD_GATEWAY`. `PRECONDITION_FAILED` reads
     * cleanly in the operator UI ("the upstream condition was not met") and
     * is the standard pattern for "your upstream-system call failed; not
     * a bug in this app".
     */
    return new TRPCError({ code: "PRECONDITION_FAILED", message });
  }

  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message });
};

/*
 * ----------------------------------------------------------------------------
 * Input schemas
 * ----------------------------------------------------------------------------
 */

const claimMappingEntryInputSchema = z.object({
  fiefClaim: z.string().min(1),
  saleorMetadataKey: z.string().min(1),
  required: z.boolean().optional(),
  visibility: z.enum(["public", "private"]).default("private"),
  reverseSyncEnabled: z.boolean().default(false),
});

const createInputSchema = z.object({
  name: z.string().min(1).max(120),
  fief: z.object({
    baseUrl: z.string().url(),
    tenantId: z.string().min(1),
    adminToken: z.string().min(1),
    clientName: z.string().min(1),
    redirectUris: z.array(z.string().url()).min(1),
  }),
  branding: z.object({
    allowedOrigins: z.array(z.string().url()).min(1),
  }),
  webhookReceiverBaseUrl: z.string().url(),
  webhookEvents: z.array(z.string().min(1)).optional(),
  claimMapping: z.array(claimMappingEntryInputSchema),
});

const updateInputSchema = z.object({
  id: z.string().uuid(),
  patch: z.object({
    name: z.string().min(1).max(120).optional(),
    branding: z
      .object({
        allowedOrigins: z.array(z.string().url()).optional(),
      })
      .optional(),
    claimMapping: z.array(claimMappingEntryInputSchema).optional(),
  }),
});

const rotateSecretInputSchema = z.object({
  id: z.string().uuid(),
  clientSecretSource: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("operator-supplied"),
      newClientSecret: z.string().min(1),
    }),
    z.object({
      mode: z.literal("locally-generated"),
    }),
  ]),
});

const confirmRotationInputSchema = z.object({
  id: z.string().uuid(),
});

const cancelRotationInputSchema = z.object({
  id: z.string().uuid(),
});

const deleteInputSchema = z.object({
  id: z.string().uuid(),
});

const testConnectionInputSchema = z.object({
  baseUrl: z.string().url(),
  adminToken: z.string().min(1),
});

/*
 * ----------------------------------------------------------------------------
 * Router builder
 * ----------------------------------------------------------------------------
 */

export interface ConnectionsRouterUseCases {
  createConnection: Pick<CreateConnectionUseCase, "execute">;
  updateConnection: Pick<UpdateConnectionUseCase, "execute">;
  rotateConnectionSecret: Pick<
    RotateConnectionSecretUseCase,
    "initiateRotation" | "confirmRotation" | "cancelRotation"
  >;
  deleteConnection: Pick<DeleteConnectionUseCase, "execute">;
}

/**
 * Minimal subset of `FiefOidcClient` used by `testConnection`. Defined
 * structurally so tests can pass a stub without instantiating the full
 * client (which would force a real fetch implementation).
 */
export interface OidcDiscoveryProbe {
  prewarm: FiefOidcClient["prewarm"];
}

/**
 * Minimal subset of `FiefAdminApiClient` used by `testConnection`.
 */
export interface AdminAuthProbe {
  listUsers: FiefAdminApiClient["listUsers"];
}

export interface ConnectionsRouterDeps {
  repo: ProviderConnectionRepo;
  useCases: ConnectionsRouterUseCases;
  /**
   * Constructs an OIDC discovery probe for a given Fief base URL. Production
   * returns a real `FiefOidcClient`; tests inject a stub.
   */
  oidcClientFactory: (input: { baseUrl: string }) => OidcDiscoveryProbe;
  /**
   * Constructs an admin-API probe for a given Fief base URL.
   */
  adminClientFactory: (input: { baseUrl: string }) => AdminAuthProbe;
}

export const buildConnectionsRouter = (deps: ConnectionsRouterDeps) => {
  const { repo, useCases, oidcClientFactory, adminClientFactory } = deps;

  return router({
    /**
     * List all connections for the install. Encrypted slots are collapsed to
     * boolean presence flags before returning.
     */
    list: protectedClientProcedure.query(async ({ ctx }): Promise<RedactedProviderConnection[]> => {
      const saleorApiUrlResult = createSaleorApiUrl(ctx.saleorApiUrl);

      if (saleorApiUrlResult.isErr()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid saleorApiUrl in request context",
        });
      }

      const listed = await repo.list({ saleorApiUrl: saleorApiUrlResult.value });

      if (listed.isErr()) {
        ctx.logger.error("connections.list failed", { error: listed.error });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to list provider connections",
        });
      }

      return listed.value.map(redactProviderConnection);
    }),

    /**
     * Provision a new connection. Delegates to T17's `CreateConnectionUseCase`.
     */
    create: protectedClientProcedure
      .input(createInputSchema)
      .mutation(async ({ ctx, input }): Promise<RedactedProviderConnection> => {
        const saleorApiUrlResult = createSaleorApiUrl(ctx.saleorApiUrl);

        if (saleorApiUrlResult.isErr()) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid saleorApiUrl in request context",
          });
        }

        let useCaseInput: CreateConnectionUseCaseInput;

        try {
          useCaseInput = {
            saleorApiUrl: saleorApiUrlResult.value,
            name: createProviderConnectionName(input.name),
            fief: {
              baseUrl: createFiefBaseUrl(input.fief.baseUrl) as unknown as string,
              tenantId: createFiefTenantId(input.fief.tenantId) as unknown as string,
              adminToken: input.fief.adminToken,
              clientName: input.fief.clientName,
              redirectUris: input.fief.redirectUris,
            },
            branding: {
              allowedOrigins: input.branding.allowedOrigins.map((o) =>
                createAllowedOrigin(o),
              ) as AllowedOrigin[],
            },
            webhookReceiverBaseUrl: input.webhookReceiverBaseUrl,
            ...(input.webhookEvents !== undefined ? { webhookEvents: input.webhookEvents } : {}),
            claimMapping: input.claimMapping.map((entry) => ({
              fiefClaim: entry.fiefClaim,
              saleorMetadataKey: entry.saleorMetadataKey,
              required: entry.required ?? false,
              visibility: entry.visibility,
              reverseSyncEnabled: entry.reverseSyncEnabled,
            })),
          };
        } catch (cause) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Invalid create-connection input: ${(cause as Error).message}`,
          });
        }

        const result = await useCases.createConnection.execute(useCaseInput);

        if (result.isErr()) {
          ctx.logger.error("connections.create failed", { error: result.error });
          throw mapLifecycleErrorToTrpc(result.error);
        }

        return redactProviderConnection(result.value);
      }),

    /**
     * Patch an existing connection. Secret slots are NOT exposed here — use
     * `rotateSecret` / `confirmRotation` for those.
     */
    update: protectedClientProcedure
      .input(updateInputSchema)
      .mutation(async ({ ctx, input }): Promise<RedactedProviderConnection> => {
        const saleorApiUrlResult = createSaleorApiUrl(ctx.saleorApiUrl);

        if (saleorApiUrlResult.isErr()) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid saleorApiUrl in request context",
          });
        }

        let useCaseInput: UpdateConnectionUseCaseInput;

        try {
          let id: ProviderConnectionId;

          try {
            id = createProviderConnectionId(input.id);
          } catch (cause) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Invalid connection id: ${(cause as Error).message}`,
            });
          }

          useCaseInput = {
            saleorApiUrl: saleorApiUrlResult.value,
            id,
            patch: {
              ...(input.patch.name !== undefined
                ? { name: createProviderConnectionName(input.patch.name) }
                : {}),
              ...(input.patch.branding?.allowedOrigins !== undefined
                ? {
                    branding: {
                      allowedOrigins: input.patch.branding.allowedOrigins.map((o) =>
                        createAllowedOrigin(o),
                      ) as AllowedOrigin[],
                    },
                  }
                : {}),
              ...(input.patch.claimMapping !== undefined
                ? {
                    claimMapping: input.patch.claimMapping.map((entry) => ({
                      fiefClaim: entry.fiefClaim,
                      saleorMetadataKey: entry.saleorMetadataKey,
                      required: entry.required ?? false,
                      visibility: entry.visibility,
                      reverseSyncEnabled: entry.reverseSyncEnabled,
                    })),
                  }
                : {}),
            },
          };
        } catch (cause) {
          if (cause instanceof TRPCError) throw cause;
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Invalid update-connection input: ${(cause as Error).message}`,
          });
        }

        const result = await useCases.updateConnection.execute(useCaseInput);

        if (result.isErr()) {
          ctx.logger.error("connections.update failed", { error: result.error });
          throw mapLifecycleErrorToTrpc(result.error);
        }

        return redactProviderConnection(result.value);
      }),

    /**
     * Initiate a two-step secret rotation. Returns the new webhook secret
     * plaintext one-time so the operator UI can show it (T35).
     */
    rotateSecret: protectedClientProcedure.input(rotateSecretInputSchema).mutation(
      async ({
        ctx,
        input,
      }): Promise<{
        connection: RedactedProviderConnection;
        newWebhookSecretPlaintext: string;
      }> => {
        const saleorApiUrlResult = createSaleorApiUrl(ctx.saleorApiUrl);

        if (saleorApiUrlResult.isErr()) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid saleorApiUrl in request context",
          });
        }

        let useCaseInput: InitiateRotationInput;

        try {
          useCaseInput = {
            saleorApiUrl: saleorApiUrlResult.value,
            id: createProviderConnectionId(input.id),
            clientSecretSource: input.clientSecretSource,
          };
        } catch (cause) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Invalid rotate-secret input: ${(cause as Error).message}`,
          });
        }

        const result = await useCases.rotateConnectionSecret.initiateRotation(useCaseInput);

        if (result.isErr()) {
          ctx.logger.error("connections.rotateSecret failed", { error: result.error });
          throw mapLifecycleErrorToTrpc(result.error);
        }

        const ok: InitiateRotationResult = result.value;

        return {
          connection: redactProviderConnection(ok.connection),
          newWebhookSecretPlaintext: ok.newWebhookSecretPlaintext,
        };
      },
    ),

    /**
     * Promote pending → current secrets. Run after the operator has verified
     * the new secret reaches Fief / the webhook subscriber.
     */
    confirmRotation: protectedClientProcedure
      .input(confirmRotationInputSchema)
      .mutation(async ({ ctx, input }): Promise<RedactedProviderConnection> => {
        const saleorApiUrlResult = createSaleorApiUrl(ctx.saleorApiUrl);

        if (saleorApiUrlResult.isErr()) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid saleorApiUrl in request context",
          });
        }

        let useCaseInput: ConfirmRotationInput;

        try {
          useCaseInput = {
            saleorApiUrl: saleorApiUrlResult.value,
            id: createProviderConnectionId(input.id),
          };
        } catch (cause) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Invalid confirm-rotation input: ${(cause as Error).message}`,
          });
        }

        const result = await useCases.rotateConnectionSecret.confirmRotation(useCaseInput);

        if (result.isErr()) {
          ctx.logger.error("connections.confirmRotation failed", { error: result.error });
          throw mapLifecycleErrorToTrpc(result.error);
        }

        return redactProviderConnection(result.value);
      }),

    /**
     * Abort an in-flight rotation. Drops the pending slots and returns the
     * connection to its pre-`rotateSecret` shape. Use this when the operator
     * wants to back out before promoting (e.g. they pasted the wrong client
     * secret, or Fief never delivered events signed with the new webhook
     * secret). Mirrors `confirmRotation`'s shape so the UI can call it the
     * same way.
     *
     * Maps `NoPendingRotation` to `CONFLICT` (consistent with the other
     * lifecycle procedures' categorical mapping).
     */
    cancelRotation: protectedClientProcedure
      .input(cancelRotationInputSchema)
      .mutation(async ({ ctx, input }): Promise<RedactedProviderConnection> => {
        const saleorApiUrlResult = createSaleorApiUrl(ctx.saleorApiUrl);

        if (saleorApiUrlResult.isErr()) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid saleorApiUrl in request context",
          });
        }

        let useCaseInput: CancelRotationInput;

        try {
          useCaseInput = {
            saleorApiUrl: saleorApiUrlResult.value,
            id: createProviderConnectionId(input.id),
          };
        } catch (cause) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Invalid cancel-rotation input: ${(cause as Error).message}`,
          });
        }

        const result = await useCases.rotateConnectionSecret.cancelRotation(useCaseInput);

        if (result.isErr()) {
          ctx.logger.error("connections.cancelRotation failed", { error: result.error });
          throw mapLifecycleErrorToTrpc(result.error);
        }

        return redactProviderConnection(result.value);
      }),

    /**
     * Soft-delete a connection. Hard-deletes the Fief OIDC client + webhook
     * subscriber; preserves the local row + identity_map for audit per T17 /
     * PRD §F2.5.
     */
    delete: protectedClientProcedure
      .input(deleteInputSchema)
      .mutation(async ({ ctx, input }): Promise<{ ok: true }> => {
        const saleorApiUrlResult = createSaleorApiUrl(ctx.saleorApiUrl);

        if (saleorApiUrlResult.isErr()) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid saleorApiUrl in request context",
          });
        }

        let useCaseInput: DeleteConnectionUseCaseInput;

        try {
          useCaseInput = {
            saleorApiUrl: saleorApiUrlResult.value,
            id: createProviderConnectionId(input.id),
          };
        } catch (cause) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Invalid delete-connection input: ${(cause as Error).message}`,
          });
        }

        const result = await useCases.deleteConnection.execute(useCaseInput);

        if (result.isErr()) {
          ctx.logger.error("connections.delete failed", { error: result.error });
          throw mapLifecycleErrorToTrpc(result.error);
        }

        return { ok: true };
      }),

    /**
     * Probe a Fief tenant's OIDC discovery + admin-API auth to surface a
     * "can we talk to this tenant?" signal in the operator UI.
     *
     * Both probes always run — we never short-circuit on the first failure
     * because the operator wants the full picture (e.g. "discovery is fine
     * but our admin token is wrong" is a different remediation than "we
     * cannot reach the tenant at all").
     */
    testConnection: protectedClientProcedure
      .input(testConnectionInputSchema)
      .mutation(async ({ ctx, input }): Promise<TestConnectionReport> => {
        /*
         * Validate the admin token shape before we use it; surfaces a clean
         * BAD_REQUEST on garbage input.
         */
        let adminToken: ReturnType<(typeof FiefAdminTokenSchema)["parse"]>;

        try {
          adminToken = FiefAdminTokenSchema.parse(input.adminToken);
        } catch (cause) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Invalid admin token: ${(cause as Error).message}`,
          });
        }

        const oidc = oidcClientFactory({ baseUrl: input.baseUrl });
        const admin = adminClientFactory({ baseUrl: input.baseUrl });

        const [oidcResult, adminResult] = await Promise.all([
          oidc.prewarm(),
          admin.listUsers(adminToken, { limit: 1 }),
        ]);

        const report: TestConnectionReport = {
          oidcDiscovery: oidcResult.isOk() ? "ok" : "error",
          adminAuth: adminResult.isOk() ? "ok" : "error",
        };

        const details: Record<string, string> = {};

        if (oidcResult.isErr()) {
          ctx.logger.warn("connections.testConnection: OIDC discovery failed", {
            error: oidcResult.error,
          });
          details.oidcDiscovery =
            (oidcResult.error as { message?: string })?.message ?? "OIDC discovery failed";
        }
        if (adminResult.isErr()) {
          ctx.logger.warn("connections.testConnection: admin auth failed", {
            error: adminResult.error,
          });
          details.adminAuth =
            (adminResult.error as { message?: string })?.message ?? "Admin auth failed";
        }

        if (Object.keys(details).length > 0) {
          report.details = details;
        }

        return report;
      }),
  });
};

export type ConnectionsRouter = ReturnType<typeof buildConnectionsRouter>;
