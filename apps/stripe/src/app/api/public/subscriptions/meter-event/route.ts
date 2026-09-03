/**
 * Service-only bridge from LightNVR's durable allocation ledger to Stripe
 * Billing Meters. Raw Stripe credentials remain inside this Saleor app.
 */
import { z } from "zod";

import { env } from "@/lib/env";
import { resolveInternalSubscriptionRuntime } from "@/modules/subscriptions/internal-runtime";
import { verifyLightNvrMeterRequest } from "@/modules/subscriptions/public-api/auth";
import { createStripeSubscriptionId } from "@/modules/subscriptions/repositories/subscription-record";

const ROUTE_PATH = "/api/public/subscriptions/meter-event";

const bodySchema = z.object({
  stripeSubscriptionId: z.string().startsWith("sub_"),
  eventName: z.string().min(1).max(100),
  value: z.number().int().positive(),
  identifier: z.string().min(1).max(100),
  timestamp: z.number().int().positive(),
  dimensions: z.record(z.string(), z.string()).optional(),
});

const jsonResponse = (status: number, body: object) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const POST = async (request: Request): Promise<Response> => {
  const rawBody = await request.text();
  const auth = verifyLightNvrMeterRequest({ request, rawBody, path: ROUTE_PATH });

  if (!auth.ok) return auth.response;

  let json: unknown;

  try {
    json = JSON.parse(rawBody);
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
  const parsed = bodySchema.safeParse(json);

  if (!parsed.success) {
    return jsonResponse(400, { error: "invalid_request", message: parsed.error.message });
  }
  if (!env.LIGHTNVR_METER_PRICE_ID) {
    return jsonResponse(503, { error: "lightnvr_meter_price_not_configured" });
  }
  if (parsed.data.eventName !== env.LIGHTNVR_METER_EVENT_NAME) {
    return jsonResponse(403, { error: "meter_not_allowed" });
  }

  const runtime = await resolveInternalSubscriptionRuntime();
  const recordResult = await runtime.subscriptionRepo.getBySubscriptionId(
    runtime.accessPattern,
    createStripeSubscriptionId(parsed.data.stripeSubscriptionId),
  );

  if (recordResult.isErr()) {
    return jsonResponse(500, { error: "subscription_lookup_failed" });
  }
  const record = recordResult.value;

  if (!record) {
    return jsonResponse(404, { error: "subscription_not_found" });
  }
  if (record.stripePriceId !== env.LIGHTNVR_METER_PRICE_ID) {
    return jsonResponse(403, { error: "subscription_not_allowed" });
  }
  if (record.status !== "active" && record.status !== "trialing") {
    return jsonResponse(409, { error: "subscription_not_billable", status: record.status });
  }

  if (!runtime.stripeSubscriptionsApi.createMeterEvent) {
    return jsonResponse(500, { error: "meter_api_not_available" });
  }

  const meterResult = await runtime.stripeSubscriptionsApi.createMeterEvent({
    customerId: record.stripeCustomerId,
    eventName: parsed.data.eventName,
    value: parsed.data.value,
    identifier: parsed.data.identifier,
    timestamp: parsed.data.timestamp,
    dimensions: parsed.data.dimensions,
  });

  if (meterResult.isErr()) {
    return jsonResponse(502, { error: "stripe_meter_event_failed" });
  }

  return jsonResponse(202, {
    identifier: meterResult.value.identifier,
    eventName: meterResult.value.event_name,
  });
};
