import { verifySignatureWithJwks } from "@saleor/app-sdk/auth";

/**
 * Saleor webhook signature verifier.
 *
 * Mirrors `apps/stripe/src/app/api/webhooks/saleor/verify-signature.ts` and
 * is consumed by every `SaleorAsyncWebhook` definition in this app
 * (T26-T29: CUSTOMER_CREATED, CUSTOMER_UPDATED, CUSTOMER_METADATA_UPDATED,
 * CUSTOMER_DELETED). The JWKS is fetched from APL auth data and cached
 * upstream; this function verifies a single delivered payload against it.
 *
 * Wire format reminder: Saleor delivers the signature as
 * `<protectedHeader>..<signature>` (detached JWS) in the `Saleor-Signature`
 * header, and verification runs against the raw HTTP body.
 */
export const verifyWebhookSignature = verifySignatureWithJwks;
