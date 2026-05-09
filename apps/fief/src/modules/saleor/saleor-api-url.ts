import { fromThrowable } from "neverthrow";
import { z } from "zod";

import { BaseError } from "@/lib/errors";

/**
 * Branded `SaleorApiUrl` per ADR 0002. Ported from `apps/stripe/src/modules/saleor/saleor-api-url.ts`.
 *
 * Use `createSaleorApiUrl(raw)` to construct: returns a `Result<SaleorApiUrl, SaleorApiUrlValidationError>`
 * so callers never throw across module boundaries (`neverthrow` convention).
 */
export const SaleorApiUrlValidationError = BaseError.subclass("SaleorApiUrlValidationError", {
  props: {
    _brand: "SaleorApiUrl.ValidationError" as const,
  },
});

const saleorApiUrlSchema = z
  .string()
  .url()
  .endsWith("/graphql/")
  .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
    message: 'Invalid input: must start with "http://" or "https://"',
  })
  .brand("SaleorApiUrl");

export const createSaleorApiUrl = (raw: string) =>
  fromThrowable(saleorApiUrlSchema.parse, (error) => SaleorApiUrlValidationError.normalize(error))(
    raw,
  );

export type SaleorApiUrl = z.infer<typeof saleorApiUrlSchema>;
