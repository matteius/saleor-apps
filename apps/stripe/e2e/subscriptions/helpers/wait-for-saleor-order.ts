/**
 * Polling helper: wait until the Stripe→Saleor bridge has minted the order
 * corresponding to a given Stripe invoice id.
 */
import { type SaleorMockChannelClient, type SaleorOrderSummary } from "./saleor-mock-channel";

export type WaitForSaleorOrderArgs = {
  client: SaleorMockChannelClient;
  invoiceId: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
};

export async function waitForSaleorOrder(
  args: WaitForSaleorOrderArgs,
): Promise<SaleorOrderSummary> {
  const timeoutMs = args.timeoutMs ?? 60_000;
  const pollIntervalMs = args.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;

  let attempts = 0;

  while (Date.now() < deadline) {
    attempts += 1;
    const order = await args.client.findOrderByStripeInvoiceId(args.invoiceId);

    if (order) {
      // eslint-disable-next-line no-console
      console.log(
        `[wait-for-saleor-order] found order=${order.id} for invoice=${args.invoiceId} after ${attempts} polls`,
      );

      return order;
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(
    `[wait-for-saleor-order] timed out waiting for Saleor order for invoice=${args.invoiceId} after ${timeoutMs}ms (${attempts} polls)`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
