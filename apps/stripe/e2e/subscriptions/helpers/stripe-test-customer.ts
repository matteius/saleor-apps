/**
 * Helpers for creating Stripe test customers attached to a test clock.
 *
 * The customer + payment-method pair created here is suitable for the
 * subscription happy-path scenarios. For failed-payment scenarios use
 * `pm_card_chargeCustomerFail` instead of `pm_card_visa`.
 */
import type Stripe from "stripe";

export type CreateTestCustomerArgs = {
  stripe: Stripe;
  testClockId: string;
  email: string;
  name?: string;
  /**
   * Stripe test payment method token.
   * - `pm_card_visa` — succeeds
   * - `pm_card_chargeCustomerFail` — fails
   * Defaults to `pm_card_visa`.
   */
  paymentMethod?: string;
};

export type TestCustomer = {
  customer: Stripe.Customer;
  paymentMethod: Stripe.PaymentMethod;
};

export async function createStripeTestCustomer(
  args: CreateTestCustomerArgs,
): Promise<TestCustomer> {
  const { stripe, testClockId, email, name, paymentMethod = "pm_card_visa" } = args;

  const customer = await stripe.customers.create({
    email,
    name: name ?? `E2E Test ${Date.now()}`,
    test_clock: testClockId,
  });

  // eslint-disable-next-line no-console
  console.log(`[stripe-test-customer] created id=${customer.id} testClock=${testClockId}`);

  // Attach a test PM and set it as default for invoices.
  const pm = await stripe.paymentMethods.attach(paymentMethod, { customer: customer.id });

  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: pm.id },
  });

  return { customer, paymentMethod: pm };
}

export async function deleteStripeTestCustomer(stripe: Stripe, customerId: string): Promise<void> {
  try {
    await stripe.customers.del(customerId);
    // eslint-disable-next-line no-console
    console.log(`[stripe-test-customer] deleted id=${customerId}`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[stripe-test-customer] delete failed id=${customerId}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}
