// cspell:ignore signup HMAC hmac
/**
 * T33 Scenario A — Cycle-1 happy path.
 *
 * Flow:
 *   1. Create a Stripe test clock + customer with pm_card_visa attached.
 *   2. Call /api/public/subscriptions/create with the test customer's email.
 *   3. Confirm the cycle-1 PaymentIntent server-side via the Stripe SDK.
 *   4. Poll Saleor for the order minted by the bridge.
 *   5. Assert: order exists, total == invoice.amount_paid, transaction recorded.
 *
 * Skips with a clear message when E2E_STRIPE_TEST_SECRET_KEY (and friends)
 * are not configured — see `.env.test.example` and the README.
 */
import { expect, test } from "@playwright/test";
import Stripe from "stripe";

import { checkStorefrontCallEnv, checkSubscriptionEnv } from "./helpers/env-guard";
import { SaleorMockChannelClient } from "./helpers/saleor-mock-channel";
import { buildStorefrontRequest } from "./helpers/storefront-request";
import { StripeTestClock } from "./helpers/stripe-test-clock";
import { createStripeTestCustomer, deleteStripeTestCustomer } from "./helpers/stripe-test-customer";
import { waitForSaleorOrder } from "./helpers/wait-for-saleor-order";

test.describe("Subscriptions — cycle-1 happy path", () => {
  test("signup creates Stripe sub + Saleor order for cycle-1 invoice", async () => {
    const envCheck = checkSubscriptionEnv();

    test.skip(!envCheck.ok, envCheck.ok ? "" : envCheck.message);

    if (!envCheck.ok) return;

    /*
     * Storefront-bridge secret + Fief JWT are also required to call the
     * protected endpoint. These are deliberately separate from the
     * subscription env because they may be set in different deployment
     * environments.
     */
    const callEnvCheck = checkStorefrontCallEnv();

    test.skip(!callEnvCheck.ok, callEnvCheck.ok ? "" : callEnvCheck.message);

    if (!callEnvCheck.ok) return;

    const { hmacSecret, fiefJwt, baseUrl } = callEnvCheck.env;
    const { env: subsEnv } = envCheck;
    const stripe = new Stripe(subsEnv.stripeSecretKey, { apiVersion: "2025-04-30.basil" });

    const clock = await StripeTestClock.create(stripe, {
      frozenTime: Math.floor(Date.now() / 1000),
      name: `e2e-signup-happy-path-${Date.now()}`,
    });

    const { customer } = await createStripeTestCustomer({
      stripe,
      testClockId: clock.id,
      email: subsEnv.fiefUserEmail,
    });

    try {
      const requestArtifacts = buildStorefrontRequest({
        baseUrl,
        path: "/api/public/subscriptions/create",
        body: {
          fiefUserId: subsEnv.fiefUserId,
          email: subsEnv.fiefUserEmail,
          stripePriceId: subsEnv.stripePriceBasic,
        },
        hmacSecret,
        fiefJwt,
      });

      const res = await fetch(requestArtifacts.url, {
        method: "POST",
        headers: requestArtifacts.headers,
        body: requestArtifacts.body,
      });

      expect(res.status, await res.text().catch(() => "")).toBe(200);
      const json = (await res.json()) as {
        stripeSubscriptionId: string;
        stripeCustomerId: string;
        clientSecret?: string | null;
      };

      expect(json.stripeSubscriptionId).toMatch(/^sub_/);
      expect(json.stripeCustomerId).toBe(customer.id);

      // Pull the cycle-1 invoice + PaymentIntent from Stripe.
      const sub = await stripe.subscriptions.retrieve(json.stripeSubscriptionId, {
        expand: ["latest_invoice.payment_intent"],
      });

      const latestInvoice = sub.latest_invoice as Stripe.Invoice | null;

      expect(latestInvoice, "latest_invoice").toBeTruthy();

      /*
       * Confirm the PI with the visa test PM (when test clock workflow leaves
       * it requiring confirmation — happy path with default PM usually
       * auto-charges, but this is defensive).
       */
      const pi = (
        latestInvoice as Stripe.Invoice & { payment_intent?: Stripe.PaymentIntent | string | null }
      ).payment_intent;

      if (pi && typeof pi !== "string" && pi.status === "requires_confirmation") {
        await stripe.paymentIntents.confirm(pi.id, { payment_method: "pm_card_visa" });
      }

      // Wait for Saleor order to be minted by the bridge.
      const saleor = new SaleorMockChannelClient({
        apiUrl: subsEnv.saleorApiUrl,
        channelSlug: subsEnv.saleorChannelSlug,
      });

      const order = await waitForSaleorOrder({
        client: saleor,
        invoiceId: latestInvoice!.id!,
        timeoutMs: 90_000,
      });

      expect(order.id).toBeTruthy();
      expect(order.total.gross.amount * 100).toBeCloseTo(latestInvoice!.amount_paid, 0);

      const subscriptionMetadata = order.metadata.find((m) => m.key === "stripe.subscription_id");

      expect(subscriptionMetadata?.value).toBe(json.stripeSubscriptionId);
    } finally {
      await deleteStripeTestCustomer(stripe, customer.id);
      await clock.delete();
    }
  });
});
