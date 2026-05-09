/**
 * Stripe price ID ↔ Saleor variant ID mapping store.
 *
 * Persisted in DynamoDB scoped to a Saleor installation. Used by T9's
 * order-mint flow to resolve which Saleor variant corresponds to the price
 * on a Stripe invoice.
 *
 * To be fully implemented in T10.
 */
import { type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

export const TODO_T10_PRICE_VARIANT_MAP = "implement in T10";

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
  stripePriceId: string;
  saleorVariantId: string;
  saleorChannelSlug: string;
}

export interface IPriceVariantMapRepo {
  set(
    access: PriceVariantMapAccess,
    mapping: PriceVariantMapping,
  ): Promise<Result<null, PriceVariantMapError>>;

  get(
    access: PriceVariantMapAccess,
    stripePriceId: string,
  ): Promise<Result<PriceVariantMapping, PriceVariantMapError>>;
}
