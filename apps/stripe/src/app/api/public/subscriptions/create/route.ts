/**
 * POST /api/public/subscriptions/create
 *
 * Storefront-facing entry point for new subscription sign-ups (T19a).
 *
 * Body: { fiefUserId, email, stripePriceId, billingAddress? }
 * Returns: { stripeSubscriptionId, stripeCustomerId, clientSecret }
 *
 * Auth: HMAC (`X-Storefront-Auth` + `X-Storefront-Timestamp`) AND Fief JWT
 * (`Authorization: Bearer ...`). The body's `fiefUserId` and `email` must
 * match the Fief JWT's `sub` and `email` claims; mismatch returns 401.
 *
 * Calls into the internal subscriptions tRPC router; T20 fills in the
 * actual Stripe + Saleor wiring. Until then this returns 501 NOT_IMPLEMENTED.
 */
import { z } from "zod";

import { verifyPublicApiRequest } from "@/modules/subscriptions/public-api/auth";
import {
  checkOrigin,
  handlePreflight,
  withCorsHeaders,
} from "@/modules/subscriptions/public-api/cors";
import {
  trpcErrorToResponse,
  validationErrorResponse,
} from "@/modules/subscriptions/public-api/error-mapping";
import { createInternalSubscriptionsCaller } from "@/modules/trpc/internal-caller";

const ROUTE_PATH = "/api/public/subscriptions/create";

const bodySchema = z.object({
  fiefUserId: z.string().min(1),
  email: z.string().email(),
  stripePriceId: z.string().min(1).startsWith("price_"),
  billingAddress: z
    .object({
      line1: z.string().min(1),
      city: z.string().min(1),
      state: z.string().min(1),
      postalCode: z.string().min(1),
      country: z.string().length(2),
    })
    .optional(),
});

export const OPTIONS = (request: Request) => handlePreflight(request);

export const POST = async (request: Request): Promise<Response> => {
  const originDenied = checkOrigin(request);

  if (originDenied) return originDenied;

  const rawBody = await request.text();
  let parsed: z.infer<typeof bodySchema>;

  try {
    const json = JSON.parse(rawBody);

    parsed = bodySchema.parse(json);
  } catch (e) {
    return withCorsHeaders(
      request,
      validationErrorResponse(e instanceof Error ? e.message : "Invalid JSON body"),
    );
  }

  const auth = await verifyPublicApiRequest({
    request,
    rawBody,
    path: ROUTE_PATH,
    expectedFiefUserId: parsed.fiefUserId,
    expectedEmail: parsed.email,
  });

  if (!auth.ok) return withCorsHeaders(request, auth.response);

  const caller = createInternalSubscriptionsCaller({
    fiefUserId: auth.claims.fiefUserId,
    email: auth.claims.email,
  });

  try {
    const result = await caller.create(parsed);

    return withCorsHeaders(
      request,
      new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  } catch (e) {
    return withCorsHeaders(request, trpcErrorToResponse(e, ROUTE_PATH));
  }
};
