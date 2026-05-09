// cspell:ignore signup HMAC hmac
/**
 * T33 Scenario B — Cycle-2 invoicing via Stripe test clock advance.
 *
 * Flow:
 *   1. Same setup as Scenario A (test clock + customer + cycle-1 success).
 *   2. Advance the clock by 32 days.
 *   3. Stripe fires invoice.created → invoice.finalized → charge.succeeded
 *      → invoice.paid for the second cycle.
 *   4. Poll Saleor for the second minted order.
 *   5. Assert exactly 2 orders are associated with the subscription.
 *
 * Skips with a clear message when env is not configured.
 */
import { expect, test } from "@playwright/test";
import Stripe from "stripe";

import { checkStorefrontCallEnv, checkSubscriptionEnv } from "./helpers/env-guard";
import { SaleorMockChannelClient } from "./helpers/saleor-mock-channel";
import { buildStorefrontRequest } from "./helpers/storefront-request";
import { StripeTestClock } from "./helpers/stripe-test-clock";
import { createStripeTestCustomer, deleteStripeTestCustomer } from "./helpers/stripe-test-customer";
import { waitForSaleorOrder } from "./helpers/wait-for-saleor-order";

const THIRTY_TWO_DAYS_SECONDS = 32 * 24 * 60 * 60;

test.describe("Subscriptions — cycle-2 via test clock advance", () => {
  test("advancing test clock 32 days mints a second Saleor order", async () => {
    const envCheck = checkSubscriptionEnv();

    test.skip(!envCheck.ok, envCheck.ok ? "" : envCheck.message);

    if (!envCheck.ok) return;

    const callEnvCheck = checkStorefrontCallEnv();

    test.skip(!callEnvCheck.ok, callEnvCheck.ok ? "" : callEnvCheck.message);

    if (!callEnvCheck.ok) return;

    const { hmacSecret, fiefJwt, baseUrl } = callEnvCheck.env;
    const { env: subsEnv } = envCheck;
    const stripe = new Stripe(subsEnv.stripeSecretKey, { apiVersion: "2025-04-30.basil" });
    const startTime = Math.floor(Date.now() / 1000);

    const clock = await StripeTestClock.create(stripe, {
      frozenTime: startTime,
      name: `e2e-cycle-2-${Date.now()}`,
    });

    const { customer } = await createStripeTestCustomer({
      stripe,
      testClockId: clock.id,
      email: subsEnv.fiefUserEmail,
    });

    try {
      // 1. Cycle-1 sign-up.
      const reqArtifacts = buildStorefrontRequest({
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

      const res = await fetch(reqArtifacts.url, {
        method: "POST",
        headers: reqArtifacts.headers,
        body: reqArtifacts.body,
      });

      expect(res.status, await res.text().catch(() => "")).toBe(200);
      const json = (await res.json()) as { stripeSubscriptionId: string };
      const subscriptionId = json.stripeSubscriptionId;

      const sub = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ["latest_invoice"],
      });
      const cycle1Invoice = sub.latest_invoice as Stripe.Invoice;

      const saleor = new SaleorMockChannelClient({
        apiUrl: subsEnv.saleorApiUrl,
        channelSlug: subsEnv.saleorChannelSlug,
      });

      await waitForSaleorOrder({
        client: saleor,
        invoiceId: cycle1Invoice.id!,
        timeoutMs: 90_000,
      });

      /*
       * 2. Advance the clock by 32 days. Stripe fires the cycle-2 invoicing
       *    pipeline asynchronously; the helper waits for the clock status to
       *    return to "ready" before we proceed.
       */
      await clock.advance({
        toUnixSeconds: startTime + THIRTY_TWO_DAYS_SECONDS,
        timeoutMs: 180_000,
      });

      /*
       * 3. Find the cycle-2 invoice (should be the one with `period_start`
       *    after the original cycle-1 period end).
       */
      let cycle2Invoice: Stripe.Invoice | undefined;
      const deadline = Date.now() + 60_000;

      while (Date.now() < deadline) {
        const list = await stripe.invoices.list({ subscription: subscriptionId, limit: 10 });
        const candidates = list.data.filter((inv) => inv.id !== cycle1Invoice.id);

        if (candidates.length > 0) {
          cycle2Invoice = candidates[0];
          break;
        }

        await new Promise((r) => setTimeout(r, 2_000));
      }

      expect(cycle2Invoice, "cycle-2 invoice should exist after clock advance").toBeTruthy();

      // 4. Wait for Saleor order for cycle-2.
      await waitForSaleorOrder({
        client: saleor,
        invoiceId: cycle2Invoice!.id!,
        timeoutMs: 120_000,
      });

      // 5. Final assertion — exactly 2 orders linked to this subscription.
      const orderCount = await saleor.countOrdersForSubscription(subscriptionId);

      expect(orderCount).toBe(2);
    } finally {
      await deleteStripeTestCustomer(stripe, customer.id);
      await clock.delete();
    }
  });
});
