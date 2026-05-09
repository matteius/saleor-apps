import { z } from "zod";

/*
 * Branded Zod schemas for the Fief admin REST API (T5).
 *
 * Modeled directly off the schema definitions in
 * `upstream Fief/fief/schemas/{client,webhook,user}.py`. Where the upstream
 * shape is permissive (e.g. `dict[str, Any]` for `User.fields`) we mirror that
 * with `z.record(...)` rather than overspecify — the consumer-side projection
 * (T14) is responsible for narrowing.
 *
 * Branded primitives use the ADR-0002 pattern: parse-once via the schema, then
 * the brand prevents accidental mixing of e.g. a Fief client_id and a Saleor
 * user id. We do NOT export the bare `parse(...)` — callers go through the
 * `createX(...)` factory which returns a `Result` (handled inside
 * admin-api-client.ts).
 */

// ---------- Branded primitives ----------

export const FiefBaseUrlSchema = z.string().url().brand("FiefBaseUrl");
export type FiefBaseUrl = z.infer<typeof FiefBaseUrlSchema>;

export const FiefAdminTokenSchema = z.string().min(1).brand("FiefAdminToken");
export type FiefAdminToken = z.infer<typeof FiefAdminTokenSchema>;

/* UUIDs returned by Fief for clients/webhooks/users/tenants. */
export const FiefUuidSchema = z.string().uuid();

export const FiefClientIdSchema = FiefUuidSchema.brand("FiefClientId");
export type FiefClientId = z.infer<typeof FiefClientIdSchema>;

export const FiefWebhookIdSchema = FiefUuidSchema.brand("FiefWebhookId");
export type FiefWebhookId = z.infer<typeof FiefWebhookIdSchema>;

export const FiefUserIdSchema = FiefUuidSchema.brand("FiefUserId");
export type FiefUserId = z.infer<typeof FiefUserIdSchema>;

export const FiefTenantIdSchema = FiefUuidSchema.brand("FiefTenantId");
export type FiefTenantId = z.infer<typeof FiefTenantIdSchema>;

// ---------- Common ----------

/*
 * Fief returns ISO-8601 datetime strings. We accept a permissive datetime
 * (with offset or `Z`) to avoid breaking on minor timezone formatting drift.
 */
const IsoDatetimeSchema = z.string().min(1);

export const PaginatedResultsSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    count: z.number().int().nonnegative(),
    results: z.array(item),
  });

// ---------- Clients ----------

/*
 * Mirrors `fief.models.client.ClientType` — we intentionally model these as a
 * known string enum but accept any string so a new Fief release adding a value
 * does not break old clients (PRD R6 schema-drift). The branded factory still
 * strict-validates known values.
 */
export const FiefClientTypeSchema = z.union([z.literal("public"), z.literal("confidential")]);
export type FiefClientType = z.infer<typeof FiefClientTypeSchema>;

export const FiefClientSchema = z.object({
  id: FiefClientIdSchema,
  created_at: IsoDatetimeSchema,
  updated_at: IsoDatetimeSchema,
  name: z.string(),
  first_party: z.boolean(),
  client_type: FiefClientTypeSchema,
  client_id: z.string(),
  client_secret: z.string(),
  redirect_uris: z.array(z.string()),
  authorization_code_lifetime_seconds: z.number().int(),
  access_id_token_lifetime_seconds: z.number().int(),
  refresh_token_lifetime_seconds: z.number().int(),
  tenant_id: FiefTenantIdSchema,
  /* `tenant` is `TenantEmbedded`; we pass through as-is (consumer doesn't need it). */
  tenant: z.record(z.unknown()).optional(),
  encrypt_jwk: z.string().nullable().optional(),
});
export type FiefClient = z.infer<typeof FiefClientSchema>;

export const FiefClientCreateInputSchema = z.object({
  name: z.string().min(1),
  first_party: z.boolean(),
  client_type: FiefClientTypeSchema,
  /* Fief enforces `min_length=1` on the array. */
  redirect_uris: z.array(z.string().url()).min(1),
  authorization_code_lifetime_seconds: z.number().int().nonnegative().optional(),
  access_id_token_lifetime_seconds: z.number().int().nonnegative().optional(),
  refresh_token_lifetime_seconds: z.number().int().nonnegative().optional(),
  tenant_id: FiefTenantIdSchema,
});
export type FiefClientCreateInput = z.infer<typeof FiefClientCreateInputSchema>;

export const FiefClientUpdateInputSchema = z.object({
  name: z.string().min(1).optional(),
  first_party: z.boolean().optional(),
  client_type: FiefClientTypeSchema.optional(),
  redirect_uris: z.array(z.string().url()).min(1).optional(),
  authorization_code_lifetime_seconds: z.number().int().nonnegative().optional(),
  access_id_token_lifetime_seconds: z.number().int().nonnegative().optional(),
  refresh_token_lifetime_seconds: z.number().int().nonnegative().optional(),
});
export type FiefClientUpdateInput = z.infer<typeof FiefClientUpdateInputSchema>;

// ---------- Webhooks ----------

/*
 * Fief generates `WebhookEventType` dynamically from registered events; we
 * accept any string here because the operator chooses the subscription set
 * via the Fief admin UI / our T17 connection setup, not via this client.
 */
export const FiefWebhookEventTypeSchema = z.string().min(1);

export const FiefWebhookSchema = z.object({
  id: FiefWebhookIdSchema,
  created_at: IsoDatetimeSchema,
  updated_at: IsoDatetimeSchema,
  url: z.string().url(),
  events: z.array(FiefWebhookEventTypeSchema),
});
export type FiefWebhook = z.infer<typeof FiefWebhookSchema>;

/*
 * `WebhookSecret` from Fief = Webhook + a `secret` field. Returned only on
 * create + rotate-secret responses; persisting it is the caller's job (T8).
 */
export const FiefWebhookWithSecretSchema = FiefWebhookSchema.extend({
  secret: z.string().min(1),
});
export type FiefWebhookWithSecret = z.infer<typeof FiefWebhookWithSecretSchema>;

export const FiefWebhookCreateInputSchema = z.object({
  url: z.string().url(),
  events: z.array(FiefWebhookEventTypeSchema).min(1),
});
export type FiefWebhookCreateInput = z.infer<typeof FiefWebhookCreateInputSchema>;

export const FiefWebhookUpdateInputSchema = z.object({
  url: z.string().url().optional(),
  events: z.array(FiefWebhookEventTypeSchema).min(1).optional(),
});
export type FiefWebhookUpdateInput = z.infer<typeof FiefWebhookUpdateInputSchema>;

// ---------- Users ----------

export const FiefUserSchema = z.object({
  id: FiefUserIdSchema,
  created_at: IsoDatetimeSchema,
  updated_at: IsoDatetimeSchema,
  email: z.string().email(),
  email_verified: z.boolean(),
  is_active: z.boolean(),
  tenant_id: FiefTenantIdSchema,
  tenant: z.record(z.unknown()).optional(),
  fields: z.record(z.unknown()),
});
export type FiefUser = z.infer<typeof FiefUserSchema>;

/*
 * `UserCreateAdmin` — admin-side create. The Fief schema has a generic
 * `fields: UF` slot (per-tenant user_field schema); we keep it as an open
 * record because this client wrapper is tenant-agnostic.
 */
export const FiefUserCreateInputSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  email_verified: z.boolean(),
  tenant_id: FiefTenantIdSchema,
  fields: z.record(z.unknown()).optional(),
});
export type FiefUserCreateInput = z.infer<typeof FiefUserCreateInputSchema>;

export const FiefUserUpdateInputSchema = z.object({
  email: z.string().email().optional(),
  email_verified: z.boolean().optional(),
  password: z.string().min(1).optional(),
  fields: z.record(z.unknown()).optional(),
});
export type FiefUserUpdateInput = z.infer<typeof FiefUserUpdateInputSchema>;

// ---------- Pagination params ----------

/*
 * Mirrors `get_pagination` in `upstream Fief/fief/dependencies/pagination.py`:
 *   limit: 1..100 (default 10, server caps at 100)
 *   skip:  >= 0  (default 0)
 *   ordering: comma-separated field list, "-" prefix = desc.
 */
export const FiefPaginationParamsSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  skip: z.number().int().nonnegative().optional(),
  ordering: z.string().optional(),
  /*
   * Free-form filter passthrough — Fief endpoints accept various query params
   * (e.g. users.list takes `query`, `tenant`). We delegate validation to the
   * server rather than enumerating them here to stay version-tolerant.
   */
  extra: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export type FiefPaginationParams = z.infer<typeof FiefPaginationParamsSchema>;
