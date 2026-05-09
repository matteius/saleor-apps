import { fromThrowable, type Result } from "neverthrow";
import { z } from "zod";

import { BaseError } from "@/lib/errors";

/*
 * T8 — `ProviderConnection` domain entity.
 *
 * A `ProviderConnection` ties a single Saleor install (`saleorApiUrl`) to a
 * specific Fief tenant + OIDC client + branding bundle. Per PRD §F2.5/§F5.1,
 * an install may hold *multiple* connections (multi-config) — typically one
 * per environment (sandbox/prod) or one per tenant for multi-brand deployments.
 *
 * Branded primitives (ADR 0002) keep call sites honest: a `ProviderConnectionId`
 * cannot be passed where a `FiefClientId` is expected, etc. The repo layer (T8
 * Mongo impl) parses the raw Mongo doc through `providerConnectionSchema` so
 * the type contract is enforced at the I/O boundary, not just at construction.
 *
 * Encryption convention: every field that holds external-system secret material
 * is stored as ciphertext under a `Encrypted*` brand. The repo encrypts on
 * write via T4's `RotatingFiefEncryptor`; decryption is opt-in (callers that
 * actually need the plaintext use `decryptProviderConnectionSecrets` or the
 * specific helpers in T17 — keeping plaintext out of the default read path
 * narrows the blast radius of a log leak / serialization mistake).
 *
 * Soft-delete: `softDeletedAt` is nullable; the repo's `list` excludes
 * soft-deleted entries by default. T29 (subscription lifecycle) flips the
 * marker rather than hard-deleting so we can audit retroactively.
 */

// -- Errors -------------------------------------------------------------------

export const ProviderConnectionValidationError = BaseError.subclass(
  "ProviderConnectionValidationError",
  {
    props: {
      _brand: "FiefApp.ProviderConnection.ValidationError" as const,
    },
  },
);

// -- Branded primitives -------------------------------------------------------

const providerConnectionIdSchema = z
  .string()
  .uuid({ message: "ProviderConnectionId must be a UUID v4" })
  .brand("ProviderConnectionId");

export type ProviderConnectionId = z.infer<typeof providerConnectionIdSchema>;
export const createProviderConnectionId = (raw: string): ProviderConnectionId =>
  providerConnectionIdSchema.parse(raw);

const providerConnectionNameSchema = z
  .string()
  .min(1, { message: "ProviderConnection name requires at least one character" })
  .max(120, { message: "ProviderConnection name capped at 120 characters" })
  .brand("ProviderConnectionName");

export type ProviderConnectionName = z.infer<typeof providerConnectionNameSchema>;
export const createProviderConnectionName = (raw: string): ProviderConnectionName =>
  providerConnectionNameSchema.parse(raw);

const fiefBaseUrlSchema = z
  .string()
  .url({ message: "FiefBaseUrl must be a valid URL" })
  .brand("FiefBaseUrl");

export type FiefBaseUrl = z.infer<typeof fiefBaseUrlSchema>;
export const createFiefBaseUrl = (raw: string): FiefBaseUrl => fiefBaseUrlSchema.parse(raw);

const fiefTenantIdSchema = z.string().min(1).brand("FiefTenantId");

export type FiefTenantId = z.infer<typeof fiefTenantIdSchema>;
export const createFiefTenantId = (raw: string): FiefTenantId => fiefTenantIdSchema.parse(raw);

const fiefClientIdSchema = z.string().min(1).brand("FiefClientId");

export type FiefClientId = z.infer<typeof fiefClientIdSchema>;
export const createFiefClientId = (raw: string): FiefClientId => fiefClientIdSchema.parse(raw);

/**
 * Fief webhook subscriber id. Persisted alongside the OIDC client id so the
 * lifecycle use cases (T17) can rotate / delete the webhook on the Fief side
 * without an extra discovery call. Modeled as a UUID-shaped string per Fief
 * 0.x's `webhooks.py` schema.
 */
const fiefWebhookIdSchema = z.string().min(1).brand("FiefWebhookId");

export type FiefWebhookId = z.infer<typeof fiefWebhookIdSchema>;
export const createFiefWebhookId = (raw: string): FiefWebhookId => fiefWebhookIdSchema.parse(raw);

/*
 * Encrypted-at-rest brands. The repo writes ciphertext (produced by T4's
 * `RotatingFiefEncryptor.encrypt(...)`) into these slots; the brand keeps
 * call sites from accidentally feeding raw plaintext into Mongo.
 */
const encryptedSecretSchema = z
  .string()
  .min(1, { message: "EncryptedSecret must not be empty" })
  .brand("EncryptedSecret");

export type EncryptedSecret = z.infer<typeof encryptedSecretSchema>;
/** Trust-the-boundary helper used by the repo's write path after T4 encryption. */
export const createEncryptedSecret = (raw: string): EncryptedSecret =>
  encryptedSecretSchema.parse(raw);

const allowedOriginSchema = z
  .string()
  .url({ message: "AllowedOrigin must be a valid URL" })
  .brand("AllowedOrigin");

export type AllowedOrigin = z.infer<typeof allowedOriginSchema>;
export const createAllowedOrigin = (raw: string): AllowedOrigin => allowedOriginSchema.parse(raw);

// -- Sub-entities -------------------------------------------------------------

/*
 * Fief client/tenant credentials. Two slots per rotated secret —
 * `encrypted*Secret` is the active one, `encryptedPending*Secret` is the
 * staged-but-not-yet-promoted slot used by T17 client-secret rotation.
 *
 * `encryptedAdminToken` is an admin-API bearer used by T6 (the admin client)
 * for tenant-level operations like creating users / managing webhooks.
 */
export const fiefConfigSchema = z.object({
  baseUrl: fiefBaseUrlSchema,
  tenantId: fiefTenantIdSchema,
  clientId: fiefClientIdSchema,
  /**
   * Fief webhook subscriber id. Nullable for backwards compat with legacy
   * connections persisted before T17 (which provisioned the subscriber but
   * did not store its id). T17's lifecycle use cases require this to be
   * present for rotate/delete; missing values surface a typed error rather
   * than crashing the parser.
   */
  webhookId: fiefWebhookIdSchema.nullable(),
  encryptedClientSecret: encryptedSecretSchema,
  encryptedPendingClientSecret: encryptedSecretSchema.nullable(),
  encryptedAdminToken: encryptedSecretSchema,
  encryptedWebhookSecret: encryptedSecretSchema,
  encryptedPendingWebhookSecret: encryptedSecretSchema.nullable(),
});
export type FiefConfig = z.infer<typeof fiefConfigSchema>;

/*
 * Branding payload — the per-connection signing key (encrypted; used by T55
 * for issuing app-signed Saleor session tokens) plus the list of allowed
 * front-end origins for CORS on the Fief login flow.
 */
export const brandingConfigSchema = z.object({
  encryptedSigningKey: encryptedSecretSchema,
  allowedOrigins: z.array(allowedOriginSchema),
});
export type BrandingConfig = z.infer<typeof brandingConfigSchema>;

/*
 * Single claim-mapping rule. T14 consumes an array of these via
 * `projectClaimsToSaleorMetadata` to translate Fief-side claims (e.g. `email`,
 * `tenant_id`, `roles[*]`) into Saleor-side metadata keys.
 *
 * Schema version notes:
 *   - `required` (T8 baseline) is kept for backwards compatibility — legacy
 *     persisted docs may still carry it. Defaults to `false` and is currently
 *     unused by T14's projector. Slated for deprecation in a follow-up.
 *   - `visibility: "public" | "private"` (T17 extension) routes the projected
 *     value into Saleor's `metadata` (storefront-visible) vs `privateMetadata`
 *     (server-only) bucket. Defaults to `"private"` so a legacy mapping that
 *     omits the field cannot accidentally leak claim values to the storefront
 *     before the operator opts in via T36's UI.
 *   - `reverseSyncEnabled` (T17 extension) marks a mapping as eligible for
 *     **Saleor → Fief** reverse-sync (per PRD §F3.4 / T34). Defaults to `false`
 *     so the Fief-as-source-of-truth direction is preserved unless the operator
 *     explicitly opts in to bi-directional sync for that mapping.
 *
 * Both new defaults are conservative ("nothing leaks; nothing reverse-syncs")
 * which lets us land the schema extension without forcing a data migration on
 * existing connections (Mongo's missing-field semantics + Zod `.default()`
 * combine cleanly here).
 */
export const claimMappingEntrySchema = z.object({
  fiefClaim: z.string().min(1),
  saleorMetadataKey: z.string().min(1),
  required: z.boolean().default(false),
  visibility: z.enum(["public", "private"]).default("private"),
  reverseSyncEnabled: z.boolean().default(false),
});
export type ClaimMappingEntry = z.infer<typeof claimMappingEntrySchema>;

// -- Top-level ProviderConnection --------------------------------------------

/*
 * `saleorApiUrl` is stored as a plain branded string (re-using the existing
 * `SaleorApiUrl` brand from `@/modules/saleor/saleor-api-url`). Re-imported
 * here as a schema-level constraint without re-defining the brand to avoid
 * drift.
 */
const saleorApiUrlMirrorSchema = z.string().url().endsWith("/graphql/").brand("SaleorApiUrl");

export const providerConnectionSchema = z.object({
  id: providerConnectionIdSchema,
  saleorApiUrl: saleorApiUrlMirrorSchema,
  name: providerConnectionNameSchema,
  fief: fiefConfigSchema,
  branding: brandingConfigSchema,
  claimMapping: z.array(claimMappingEntrySchema),
  /**
   * Soft-delete marker. `null` (or absent in legacy docs) means active.
   * T29's deactivate-subscription flow sets this to `new Date()` instead of
   * deleting the doc so we can audit retroactively.
   */
  softDeletedAt: z.date().nullable(),
});

export type ProviderConnection = z.infer<typeof providerConnectionSchema>;

/*
 * Input shape for `create()`. The repo generates the `id` (UUID v4) and
 * defaults `softDeletedAt` to `null`; callers supply the rest as plaintext
 * secrets which the repo encrypts via T4 before persisting.
 */
export interface ProviderConnectionCreateInput {
  saleorApiUrl: ProviderConnection["saleorApiUrl"];
  name: ProviderConnectionName;
  fief: {
    baseUrl: FiefBaseUrl;
    tenantId: FiefTenantId;
    clientId: FiefClientId;
    /** Fief webhook subscriber id; null for legacy connections, present for T17+. */
    webhookId?: FiefWebhookId | null;
    /** Plaintext — repo encrypts before write. */
    clientSecret: string;
    /** Plaintext — repo encrypts before write. Optional; defaults to null. */
    pendingClientSecret?: string | null;
    /** Plaintext — repo encrypts before write. */
    adminToken: string;
    /** Plaintext — repo encrypts before write. */
    webhookSecret: string;
    /** Plaintext — repo encrypts before write. Optional; defaults to null. */
    pendingWebhookSecret?: string | null;
  };
  branding: {
    /** Plaintext — repo encrypts before write. */
    signingKey: string;
    allowedOrigins: AllowedOrigin[];
  };
  claimMapping: ClaimMappingEntry[];
}

/*
 * Patch shape for `update()`. Every field optional; the repo merges into the
 * existing doc and re-encrypts only the secret slots that were provided.
 *
 * `softDeletedAt` is intentionally NOT exposed here — use `softDelete()` /
 * `restore()` instead so the audit trail is explicit.
 */
export interface ProviderConnectionUpdateInput {
  name?: ProviderConnectionName;
  fief?: {
    baseUrl?: FiefBaseUrl;
    tenantId?: FiefTenantId;
    clientId?: FiefClientId;
    /** Fief webhook subscriber id, or `null` to clear. */
    webhookId?: FiefWebhookId | null;
    /** Plaintext — repo re-encrypts before write. */
    clientSecret?: string;
    /** Plaintext or null to clear the pending slot. */
    pendingClientSecret?: string | null;
    /** Plaintext — repo re-encrypts before write. */
    adminToken?: string;
    /** Plaintext — repo re-encrypts before write. */
    webhookSecret?: string;
    /** Plaintext or null to clear the pending slot. */
    pendingWebhookSecret?: string | null;
  };
  branding?: {
    /** Plaintext — repo re-encrypts before write. */
    signingKey?: string;
    allowedOrigins?: AllowedOrigin[];
  };
  claimMapping?: ClaimMappingEntry[];
}

/**
 * Decrypted view of a `ProviderConnection`. Returned only by the explicit
 * `decryptProviderConnectionSecrets` boundary helper so plaintext never
 * leaves the auth-plane unintentionally.
 */
export interface DecryptedProviderConnectionSecrets {
  fief: {
    clientSecret: string;
    pendingClientSecret: string | null;
    adminToken: string;
    webhookSecret: string;
    pendingWebhookSecret: string | null;
  };
  branding: {
    signingKey: string;
  };
}

// -- Boundary parsers ---------------------------------------------------------

/**
 * Parse + validate a raw object (e.g. a Mongo document) against the schema.
 * Returns a `Result` so call sites don't need try/catch.
 */
export const parseProviderConnection = (
  raw: unknown,
): Result<ProviderConnection, InstanceType<typeof ProviderConnectionValidationError>> =>
  fromThrowable(providerConnectionSchema.parse, (error) =>
    ProviderConnectionValidationError.normalize(error),
  )(raw);
