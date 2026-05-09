/**
 * GET /api/public/subscriptions/status
 *
 * Reads subscription state from the DynamoDB cache (T19a).
 *
 * Query: ?stripeSubscriptionId=sub_...  OR  ?fiefUserId=...
 * Returns: { status, currentPeriodEnd, cancelAtPeriodEnd, lastSaleorOrderId, planName }
 *
 * GET request — there's no JSON body, so the HMAC payload uses the empty
 * string. The HMAC must still be computed over `${path}\n${timestamp}\n`
 * (trailing newline) so callers can sign GET requests deterministically.
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

const ROUTE_PATH = "/api/public/subscriptions/status";

const querySchema = z.discriminatedUnion("by", [
  z.object({
    by: z.literal("stripeSubscriptionId"),
    stripeSubscriptionId: z.string().min(1).startsWith("sub_"),
  }),
  z.object({ by: z.literal("fiefUserId"), fiefUserId: z.string().min(1) }),
]);

const parseQuery = (request: Request): z.infer<typeof querySchema> | { error: string } => {
  const url = new URL(request.url);
  const subId = url.searchParams.get("stripeSubscriptionId");
  const fiefId = url.searchParams.get("fiefUserId");

  if (subId && fiefId) {
    return { error: "Provide exactly one of `stripeSubscriptionId` or `fiefUserId`" };
  }

  if (subId) {
    const parsed = querySchema.safeParse({
      by: "stripeSubscriptionId",
      stripeSubscriptionId: subId,
    });

    return parsed.success ? parsed.data : { error: parsed.error.message };
  }

  if (fiefId) {
    const parsed = querySchema.safeParse({ by: "fiefUserId", fiefUserId: fiefId });

    return parsed.success ? parsed.data : { error: parsed.error.message };
  }

  return { error: "Missing required query param: `stripeSubscriptionId` or `fiefUserId`" };
};

export const OPTIONS = (request: Request) => handlePreflight(request);

export const GET = async (request: Request): Promise<Response> => {
  const originDenied = checkOrigin(request);

  if (originDenied) return originDenied;

  const queryResult = parseQuery(request);

  if ("error" in queryResult) {
    return withCorsHeaders(request, validationErrorResponse(queryResult.error));
  }

  // GET has no body; sign over an empty body.
  const auth = await verifyPublicApiRequest({ request, rawBody: "", path: ROUTE_PATH });

  if (!auth.ok) return withCorsHeaders(request, auth.response);

  /*
   * Defense-in-depth: when looking up by fiefUserId, the body claim must
   * match the JWT sub. Lookups by stripeSubscriptionId rely on the internal
   * handler (T23) to verify ownership.
   */
  if (queryResult.by === "fiefUserId" && queryResult.fiefUserId !== auth.claims.fiefUserId) {
    return withCorsHeaders(
      request,
      new Response(
        JSON.stringify({
          error: "unauthorized",
          message: "Query `fiefUserId` does not match JWT `sub` claim",
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
    );
  }

  const caller = createInternalSubscriptionsCaller({
    fiefUserId: auth.claims.fiefUserId,
    email: auth.claims.email,
  });

  try {
    const result = await caller.getStatus(queryResult);

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
