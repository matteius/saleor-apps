/**
 * Thin wrapper around Stripe's test clock API.
 *
 * Test clocks let us simulate the passage of time (e.g. cycle-2 invoicing
 * 32 days from now) deterministically against Stripe test mode.
 *
 * Docs: https://stripe.com/docs/billing/testing/test-clocks
 *
 * Lifecycle:
 *   const clock = await StripeTestClock.create(stripe, { frozenTime: Date.now() / 1000 });
 *   // ... attach customers / subscriptions to clock.id ...
 *   await clock.advance({ toUnixSeconds: clock.frozenTime + 32 * 86400 });
 *   await clock.delete(); // cleanup
 */
import type Stripe from "stripe";

export class StripeTestClock {
  readonly id: string;
  readonly frozenTime: number;
  private readonly stripe: Stripe;

  private constructor(stripe: Stripe, id: string, frozenTime: number) {
    this.stripe = stripe;
    this.id = id;
    this.frozenTime = frozenTime;
  }

  static async create(
    stripe: Stripe,
    args: { frozenTime: number; name?: string },
  ): Promise<StripeTestClock> {
    const clock = await stripe.testHelpers.testClocks.create({
      frozen_time: Math.floor(args.frozenTime),
      name: args.name ?? `e2e-subscription-${Date.now()}`,
    });

    // eslint-disable-next-line no-console
    console.log(
      `[stripe-test-clock] created id=${clock.id} frozenTime=${clock.frozen_time} (${new Date(
        clock.frozen_time * 1000,
      ).toISOString()})`,
    );

    return new StripeTestClock(stripe, clock.id, clock.frozen_time);
  }

  /**
   * Advance the clock to a future Unix timestamp. Polls until the clock
   * reports `status === "ready"` (Stripe asynchronously fires invoicing
   * webhooks during the advance window).
   */
  async advance(args: {
    toUnixSeconds: number;
    pollIntervalMs?: number;
    timeoutMs?: number;
  }): Promise<void> {
    const target = Math.floor(args.toUnixSeconds);
    const pollIntervalMs = args.pollIntervalMs ?? 2_000;
    const timeoutMs = args.timeoutMs ?? 120_000;

    // eslint-disable-next-line no-console
    console.log(
      `[stripe-test-clock] advancing id=${this.id} -> ${target} (${new Date(
        target * 1000,
      ).toISOString()})`,
    );

    await this.stripe.testHelpers.testClocks.advance(this.id, { frozen_time: target });

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const fresh = await this.stripe.testHelpers.testClocks.retrieve(this.id);

      if (fresh.status === "ready") {
        // eslint-disable-next-line no-console
        console.log(`[stripe-test-clock] advance complete id=${this.id} status=ready`);

        return;
      }

      if (fresh.status === "internal_failure") {
        throw new Error(`[stripe-test-clock] advance failed id=${this.id} status=internal_failure`);
      }

      await sleep(pollIntervalMs);
    }

    throw new Error(`[stripe-test-clock] advance timed out after ${timeoutMs}ms (id=${this.id})`);
  }

  async delete(): Promise<void> {
    try {
      await this.stripe.testHelpers.testClocks.del(this.id);
      // eslint-disable-next-line no-console
      console.log(`[stripe-test-clock] deleted id=${this.id}`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[stripe-test-clock] delete failed id=${this.id}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
