import { z } from "zod";

import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

/*
 * Re-validate Saleor-api-url shape locally so we don't depend on internal
 * exports from the saleor module. The brand is reapplied via cast — by the
 * time a config flows through this module the value has already cleared
 * `createSaleorApiUrl` at the boundary.
 */
const saleorApiUrlInputSchema = z
  .string()
  .url()
  .endsWith("/graphql/")
  .refine((value) => value.startsWith("http://") || value.startsWith("https://"))
  .transform((value) => value as SaleorApiUrl);

/*
 * T9 — Channel-configuration domain entity.
 *
 * Schema (per fief-app-plan T9):
 *
 *   {
 *     saleorApiUrl: SaleorApiUrl,
 *     defaultConnectionId: ConnectionId | null,
 *     overrides: Array<{
 *       channelSlug: ChannelSlug,
 *       connectionId: ConnectionId | "disabled"
 *     }>,
 *   }
 *
 * Resolution semantics (the contract T12's resolver consumes):
 *
 *   - For a given (saleorApiUrl, channelSlug):
 *       1. If an override exists for that channelSlug:
 *            - `connectionId === "disabled"` → channel is opted out; resolver
 *               returns `"disabled"` (do not sync).
 *            - any other value → returns that ConnectionId.
 *       2. Otherwise, fall back to `defaultConnectionId`:
 *            - non-null → returns that ConnectionId.
 *            - null → resolver returns `null` (no connection configured for
 *               this channel; up to the caller to treat as no-op).
 *
 *   This mirrors avatax's "default applies to all channels except those
 *   listed in overrides", with one extension: an override can be the literal
 *   `"disabled"` so an operator can explicitly opt a single channel out of a
 *   tenant-default rollout without deleting the default.
 *
 * Why one row per saleorApiUrl (vs. one row per channel like avatax):
 *
 *   - Channels for a Saleor tenant are typically <50; storing them as a
 *     single document keeps the resolver to one round-trip per webhook.
 *   - The "default" concept maps cleanly onto a single field instead of a
 *     sentinel row.
 *   - Order of `overrides` is preserved because the UI (T36) renders them in
 *     operator-supplied order and we don't want re-saves to scramble it.
 */

/*
 * Branded primitive: a `ProviderConnection` id (T8 owns the entity; T9
 * stores references to it). Using a brand here forces call-sites that
 * construct a ConnectionId from a raw string to acknowledge they're crossing
 * a domain boundary.
 */
const connectionIdSchema = z
  .string()
  .min(1, "ConnectionId must be non-empty")
  .brand("ConnectionId");

export type ConnectionId = z.infer<typeof connectionIdSchema>;

export const createConnectionId = (raw: string): ConnectionId => connectionIdSchema.parse(raw);

/*
 * Branded primitive: a Saleor channel slug. Saleor's slug rules accept
 * lowercase + digits + hyphens, but the strictest validation should live in
 * Saleor — we just guard against empty strings landing in storage.
 */
const channelSlugSchema = z.string().min(1, "ChannelSlug must be non-empty").brand("ChannelSlug");

export type ChannelSlug = z.infer<typeof channelSlugSchema>;

export const createChannelSlug = (raw: string): ChannelSlug => channelSlugSchema.parse(raw);

/**
 * The literal value used inside an override's `connectionId` slot to mean
 * "this channel is explicitly opted out". Exported so T12 can reference it
 * by symbol rather than re-typing the string.
 */
export const DISABLED_CHANNEL = "disabled" as const;

export type DisabledChannel = typeof DISABLED_CHANNEL;

const overrideConnectionIdSchema = z.union([connectionIdSchema, z.literal(DISABLED_CHANNEL)]);

export const channelOverrideSchema = z.object({
  channelSlug: channelSlugSchema,
  connectionId: overrideConnectionIdSchema,
});

export type ChannelOverride = z.infer<typeof channelOverrideSchema>;

export const channelConfigurationSchema = z.object({
  saleorApiUrl: saleorApiUrlInputSchema,
  defaultConnectionId: connectionIdSchema.nullable(),
  overrides: z.array(channelOverrideSchema),
});

export type ChannelConfiguration = z.infer<typeof channelConfigurationSchema>;
