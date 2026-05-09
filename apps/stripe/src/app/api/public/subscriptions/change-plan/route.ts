/**
 * POST /api/public/subscriptions/change-plan
 *
 * Switches a subscription to a new Stripe price (T19a).
 *
 * Body: { stripeSubscriptionId, newStripePriceId, prorationBehavior? }
 * Returns: { status, currentPeriodEnd }
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

const ROUTE_PATH = "/api/public/subscriptions/change-plan";

const bodySchema = z.object({
  stripeSubscriptionId: z.string().min(1).startsWith("sub_"),
  newStripePriceId: z.string().min(1).startsWith("price_"),
  prorationBehavior: z.enum(["create_prorations", "none"]).optional(),
});

export const OPTIONS = (request: Request) => handlePreflight(request);

export const POST = async (request: Request): Promise<Response> => {
  const originDenied = checkOrigin(request);

  if (originDenied) return originDenied;

  const rawBody = await request.text();
  let parsed: z.infer<typeof bodySchema>;

  try {
    parsed = bodySchema.parse(JSON.parse(rawBody));
  } catch (e) {
    return withCorsHeaders(
      request,
      validationErrorResponse(e instanceof Error ? e.message : "Invalid JSON body"),
    );
  }

  const auth = await verifyPublicApiRequest({ request, rawBody, path: ROUTE_PATH });

  if (!auth.ok) return withCorsHeaders(request, auth.response);

  const caller = createInternalSubscriptionsCaller({
    fiefUserId: auth.claims.fiefUserId,
    email: auth.claims.email,
  });

  try {
    const result = await caller.changePlan(parsed);

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
