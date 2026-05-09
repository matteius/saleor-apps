/**
 * Lightweight Saleor GraphQL client for subscription E2E.
 *
 * Wraps the calls used to verify that the Stripe→Saleor bridge correctly
 * minted an order for an invoice. No code-gen — these tests are
 * scaffolding-grade and we use raw GraphQL for clarity.
 *
 * Talks to the Saleor instance pointed to by `E2E_SALEOR_API_URL` and the
 * `owlbooks` channel (`E2E_SALEOR_OWLBOOKS_CHANNEL_SLUG`).
 */

export type SaleorOrderSummary = {
  id: string;
  number: string;
  status: string;
  total: { gross: { amount: number; currency: string } };
  metadata: Array<{ key: string; value: string }>;
};

export type ChannelClientOpts = {
  apiUrl: string;
  channelSlug: string;
  /**
   * Optional bearer / app token. The owlbooks bridge order-mint endpoint is
   * called server-side by the stripe-app, but reading orders back may require
   * an app token depending on how the channel is set up.
   */
  authToken?: string;
};

export class SaleorMockChannelClient {
  private readonly opts: ChannelClientOpts;

  constructor(opts: ChannelClientOpts) {
    this.opts = opts;
  }

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    if (this.opts.authToken) {
      headers.Authorization = `Bearer ${this.opts.authToken}`;
    }

    const res = await fetch(this.opts.apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      throw new Error(`[saleor-mock-channel] GraphQL HTTP ${res.status}: ${await res.text()}`);
    }

    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };

    if (json.errors?.length) {
      throw new Error(`[saleor-mock-channel] GraphQL errors: ${JSON.stringify(json.errors)}`);
    }

    if (!json.data) {
      throw new Error("[saleor-mock-channel] empty GraphQL response");
    }

    return json.data;
  }

  /**
   * Find an order by the metadata key the Stripe→Saleor bridge writes
   * (`stripe.invoice_id`). Returns null when the order has not been minted
   * yet — caller polls.
   */
  async findOrderByStripeInvoiceId(invoiceId: string): Promise<SaleorOrderSummary | null> {
    /*
     * Saleor doesn't index custom metadata for `orders(filter:)`, so we use
     * the search API and filter client-side. For test instances with low
     * order counts this is fine; for larger seeds, swap for a dedicated
     * metadata-indexed lookup.
     */
    const query = /* GraphQL */ `
      query FindOrder($channel: String!, $search: String!) {
        orders(channel: $channel, filter: { search: $search }, first: 25) {
          edges {
            node {
              id
              number
              status
              total {
                gross {
                  amount
                  currency
                }
              }
              metadata {
                key
                value
              }
            }
          }
        }
      }
    `;

    const data = await this.gql<{
      orders: { edges: Array<{ node: SaleorOrderSummary }> };
    }>(query, { channel: this.opts.channelSlug, search: invoiceId });

    const matches = data.orders.edges
      .map((e) => e.node)
      .filter((o) =>
        o.metadata.some((m) => m.key === "stripe.invoice_id" && m.value === invoiceId),
      );

    return matches[0] ?? null;
  }

  /**
   * Count orders associated with a Stripe subscription id (via metadata).
   * Used to assert exactly N cycles minted.
   */
  async countOrdersForSubscription(subscriptionId: string): Promise<number> {
    const query = /* GraphQL */ `
      query CountSubOrders($channel: String!, $search: String!) {
        orders(channel: $channel, filter: { search: $search }, first: 100) {
          edges {
            node {
              id
              metadata {
                key
                value
              }
            }
          }
        }
      }
    `;

    const data = await this.gql<{
      orders: {
        edges: Array<{ node: { id: string; metadata: Array<{ key: string; value: string }> } }>;
      };
    }>(query, { channel: this.opts.channelSlug, search: subscriptionId });

    return data.orders.edges.filter((e) =>
      e.node.metadata.some((m) => m.key === "stripe.subscription_id" && m.value === subscriptionId),
    ).length;
  }
}
