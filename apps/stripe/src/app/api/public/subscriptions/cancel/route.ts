/**
 * POST /api/public/subscriptions/cancel
 *
 * Cancels a subscription on behalf of the storefront caller (T19a).
 *
 * Body: { stripeSubscriptionId, immediate? }
 * Returns: { status }
 *
 * No body field carries the Fief user ID, so we don't bind the JWT `sub` to
 * a body claim here — but the internal handler (T21) will cross-check that
 * the subscription's stored `fiefUserId` matches the verified JWT claim
 * before allowing cancellation.
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

const ROUTE_PATH = "/api/public/subscriptions/cancel";

const bodySchema = z.object({
  stripeSubscriptionId: z.string().min(1).startsWith("sub_"),
  immediate: z.boolean().optional(),
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
    const result = await caller.cancel(parsed);

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
