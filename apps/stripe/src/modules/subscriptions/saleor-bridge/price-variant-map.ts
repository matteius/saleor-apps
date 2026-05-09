/**
 * Stripe price ID ↔ Saleor variant ID mapping store.
 *
 * Persisted in DynamoDB scoped to a Saleor installation. Used by T14's
 * `invoice.paid` webhook handler to resolve which Saleor variant + channel
 * corresponds to the price on a Stripe invoice (so T9's order-mint flow can
 * draft a Saleor order with the right variant).
 *
 * Branded ID types follow the same pattern as `subscription-record.ts`
 * (`StripeSubscriptionId`, `StripeCustomerId`, `StripePriceId`, etc.) so
 * domain code cannot accidentally pass a Saleor ID where a Stripe ID is
 * expected (or vice versa).
 *
 * Repo contract:
 * - `get` returns `Ok(null)` when the priceId is unknown — caller (T14) is
 *   expected to log + alert + skip order minting (do NOT mint with a
 *   placeholder variant). An "unknown price" is a normal lookup outcome,
 *   not a transport-layer error.
 * - `set` is upsert semantics (DynamoDB PutItem replaces).
 * - `list` returns all mappings for an installation (used by T25's admin UI).
 */
import { type Result } from "neverthrow";
import { z } from "zod";

import { BaseError } from "@/lib/errors";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import {
  createSaleorChannelSlug,
  createStripePriceId,
  type SaleorChannelSlug,
  type StripePriceId,
} from "../repositories/subscription-record";

/**
 * Re-export the existing branded IDs so callers of the price-variant-map
 * module don't need to know they live on the subscription-record file.
 */
export { createSaleorChannelSlug, createStripePriceId };
export type { SaleorChannelSlug, StripePriceId };

/**
 * Branded Saleor variant ID — distinct from `SaleorEntityId` /
 * `saleorUserId` since variants are a different node type in Saleor's
 * graph. Mirrors the brand pattern in `subscription-record.ts`.
 */
const saleorVariantIdSchema = z.string().min(1).brand("SaleorVariantId");

export const createSaleorVariantId = (raw: string) => saleorVariantIdSchema.parse(raw);

export type SaleorVariantId = z.infer<typeof saleorVariantIdSchema>;

export const PriceVariantMapError = {
  MappingMissingError: BaseError.subclass("PriceVariantMap.MappingMissingError", {
    props: {
      _internalName: "PriceVariantMap.MappingMissingError",
    },
  }),
  PersistenceFailedError: BaseError.subclass("PriceVariantMap.PersistenceFailedError", {
    props: {
      _internalName: "PriceVariantMap.PersistenceFailedError",
    },
  }),
};

export type PriceVariantMapError = InstanceType<
  | typeof PriceVariantMapError.MappingMissingError
  | typeof PriceVariantMapError.PersistenceFailedError
>;

export type PriceVariantMapAccess = {
  saleorApiUrl: SaleorApiUrl;
  appId: string;
};

export interface PriceVariantMapping {
  stripePriceId: StripePriceId;
  saleorVariantId: SaleorVariantId;
  saleorChannelSlug: SaleorChannelSlug;
  createdAt: Date;
  updatedAt: Date;
}

export interface PriceVariantMapRepo {
  /**
   * Upsert a mapping. PutItem replaces any existing row at the same
   * (PK, SK) — the caller is responsible for preserving `createdAt` on
   * updates if it needs to remain stable.
   */
  set(
    access: PriceVariantMapAccess,
    mapping: PriceVariantMapping,
  ): Promise<Result<null, PriceVariantMapError>>;

  /**
   * Direct PK+SK lookup. Returns `Ok(null)` for unknown price IDs (the
   * canonical "no mapping" outcome relied on by T14's webhook handler to
   * trigger log+alert + skip-order rather than mint with a wrong variant).
   */
  get(
    access: PriceVariantMapAccess,
    stripePriceId: StripePriceId,
  ): Promise<Result<PriceVariantMapping | null, PriceVariantMapError>>;

  /**
   * Hard delete by PK+SK. Returns `Ok(null)` whether or not the row existed.
   */
  delete(
    access: PriceVariantMapAccess,
    stripePriceId: StripePriceId,
  ): Promise<Result<null, PriceVariantMapError>>;

  /**
   * List all mappings for an installation. Used by T25's admin UI.
   * Partition-scoped Query with SK begins-with `price-variant-map#`.
   */
  list(access: PriceVariantMapAccess): Promise<Result<PriceVariantMapping[], PriceVariantMapError>>;
}

/**
 * Legacy interface name retained for any consumers that imported it from
 * the T3 stub. Prefer `PriceVariantMapRepo`.
 *
 * @deprecated use `PriceVariantMapRepo`.
 */
export type IPriceVariantMapRepo = PriceVariantMapRepo;
