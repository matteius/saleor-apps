/**
 * OwlBooks webhook notifier — fires entitlement updates from the Stripe app
 * to OwlBooks' `/api/webhooks/subscription-status` endpoint (T28).
 *
 * Plan: PRD_OwlBooks_Subscription_Billing-plan.md §T12 (interface) and §T28
 * (receiver).
 *
 * ## Authentication
 *
 * Signs the JSON-serialized body with HMAC-SHA256 using
 * `env.OWLBOOKS_WEBHOOK_SECRET` and sends the hex digest in
 * `X-OwlBooks-Webhook-Signature`. T28 verifies with the same secret using
 * constant-time comparison.
 *
 * ## Payload
 *
 * The {@link OwlBooksWebhookPayload} shape mirrors T28's accepted Zod schema
 * EXACTLY — keep the two in lockstep when extending.
 *
 * ## Retry policy
 *
 * Per the plan (T13–T17 fire fire-and-forget for now), this notifier returns
 * `Err(NotifyError)` on transport failure / non-2xx and lets the caller decide.
 * Resilient retry is T34/T32 territory — we do NOT retry inside `notify()`.
 *
 * The default {@link HttpOwlBooksWebhookNotifier} uses a 5-second `AbortSignal`
 * timeout to avoid blocking the webhook hot path indefinitely.
 */
import * as crypto from "crypto";
import { err, ok, type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";

/*
 * ---------------------------------------------------------------------------
 * Payload — must mirror T28's Zod schema in OwlBooks at
 * src/app/api/webhooks/subscription-status/route.ts (accounting repo).
 * ---------------------------------------------------------------------------
 */

export type OwlBooksWebhookEventType =
  | "subscription.created"
  | "subscription.updated"
  | "subscription.deleted"
  | "invoice.paid"
  | "invoice.payment_failed"
  | "order.voided";

export type OwlBooksSubscriptionStatus =
  | "PENDING"
  | "ACTIVE"
  | "EXPIRED"
  | "CANCELLED"
  | "SUSPENDED"
  | "PAST_DUE"
  | "INCOMPLETE"
  | "INCOMPLETE_EXPIRED"
  | "UNPAID";

export interface OwlBooksWebhookPayload {
  type: OwlBooksWebhookEventType;
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  fiefUserId: string;
  saleorUserId?: string;
  /** Unix epoch seconds (matches Stripe's `event.created`). */
  stripeEventCreatedAt: number;
  status: OwlBooksSubscriptionStatus;
  stripePriceId?: string;
  /** ISO-8601 string. */
  currentPeriodStart?: string;
  /** ISO-8601 string. */
  currentPeriodEnd?: string;
  cancelAtPeriodEnd?: boolean;
  // invoice.paid
  lastInvoiceId?: string;
  lastSaleorOrderId?: string;
  saleorChannelSlug?: string;
  amountCents?: number;
  taxCents?: number;
  currency?: string;
  stripeChargeId?: string;
  // order.voided
  voidedAt?: string;
}

/*
 * ---------------------------------------------------------------------------
 * Error & interface
 * ---------------------------------------------------------------------------
 */

export const NotifyError = {
  ConfigurationMissingError: BaseError.subclass(
    "OwlBooksWebhookNotifier.ConfigurationMissingError",
    {
      props: {
        _internalName: "OwlBooksWebhookNotifier.ConfigurationMissingError",
      },
    },
  ),
  TransportError: BaseError.subclass("OwlBooksWebhookNotifier.TransportError", {
    props: {
      _internalName: "OwlBooksWebhookNotifier.TransportError",
    },
  }),
  NonSuccessResponseError: BaseError.subclass("OwlBooksWebhookNotifier.NonSuccessResponseError", {
    props: {
      _internalName: "OwlBooksWebhookNotifier.NonSuccessResponseError",
    },
  }),
};

export type NotifyError = InstanceType<
  | typeof NotifyError.ConfigurationMissingError
  | typeof NotifyError.TransportError
  | typeof NotifyError.NonSuccessResponseError
>;

/**
 * T31 Layer B — outcome surfaced from the OwlBooks receiver. T28's response
 * body looks like `{ ok: true, action: 'created' | 'updated' | 'replay' |
 * 'duplicate' | 'noop' }`. A `'duplicate'` action means OwlBooks's Postgres
 * `SaleorOrderImport.stripeInvoiceId @unique` constraint hit a re-delivery —
 * we should NOT treat that as an error or trigger a retry.
 *
 * Anything other than `'duplicate'` is collapsed to `'new'` here; downstream
 * callers only need the binary signal. Older versions of T28 that return
 * `{ok:true}` without an `action` field are also treated as `'new'`.
 */
export interface NotifyResult {
  processed: "new" | "duplicate";
}

export interface OwlBooksWebhookNotifier {
  notify(payload: OwlBooksWebhookPayload): Promise<Result<NotifyResult, NotifyError>>;
}

/*
 * ---------------------------------------------------------------------------
 * Default HTTP implementation
 * ---------------------------------------------------------------------------
 */

const DEFAULT_TIMEOUT_MS = 5_000;
const SIGNATURE_HEADER = "X-OwlBooks-Webhook-Signature";

export interface HttpOwlBooksWebhookNotifierConfig {
  /** OwlBooks webhook URL — typically from `env.OWLBOOKS_WEBHOOK_URL`. */
  url: string | undefined;
  /** Shared HMAC secret — typically from `env.OWLBOOKS_WEBHOOK_SECRET`. */
  secret: string | undefined;
  /** Override per-request timeout. Defaults to 5_000ms. */
  timeoutMs?: number;
  /** Injectable fetch for testing — defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Computes the hex-encoded HMAC-SHA256 signature of `rawBody` using `secret`.
 * Exposed for use by T28's verifier and unit-test parity assertions.
 */
export function signOwlBooksPayload(rawBody: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

export class HttpOwlBooksWebhookNotifier implements OwlBooksWebhookNotifier {
  private readonly url: string | undefined;
  private readonly secret: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger = createLogger("HttpOwlBooksWebhookNotifier");

  constructor(config: HttpOwlBooksWebhookNotifierConfig) {
    this.url = config.url;
    this.secret = config.secret;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async notify(payload: OwlBooksWebhookPayload): Promise<Result<NotifyResult, NotifyError>> {
    if (!this.url || !this.secret) {
      this.logger.warn(
        "OwlBooks webhook notifier is not configured (missing OWLBOOKS_WEBHOOK_URL or OWLBOOKS_WEBHOOK_SECRET); skipping notification.",
      );

      return err(
        new NotifyError.ConfigurationMissingError(
          "OwlBooks webhook notifier is missing OWLBOOKS_WEBHOOK_URL or OWLBOOKS_WEBHOOK_SECRET",
        ),
      );
    }

    const rawBody = JSON.stringify(payload);
    const signature = signOwlBooksPayload(rawBody, this.secret);

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [SIGNATURE_HEADER]: signature,
        },
        body: rawBody,
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logger.warn(
          `OwlBooks webhook responded ${response.status} for event type=${payload.type}`,
        );

        return err(
          new NotifyError.NonSuccessResponseError(
            `OwlBooks webhook responded with status ${response.status}`,
            {
              props: {
                status: response.status,
                eventType: payload.type,
              },
            },
          ),
        );
      }

      /*
       * T31 Layer B — parse the receiver's `action` field to surface
       * 'duplicate' to the caller. Body is best-effort: any parse failure or
       * missing action is treated as 'new'.
       */
      let processed: NotifyResult["processed"] = "new";

      try {
        const parsed = (await response.json()) as { action?: string } | null;

        if (parsed && parsed.action === "duplicate") {
          processed = "duplicate";
        }
      } catch {
        /*
         * Non-JSON body or empty response — treat as 'new'. This preserves
         * backward compatibility with any non-T28 receiver that returns 200
         * with no body.
         */
      }

      return ok({ processed });
    } catch (cause) {
      this.logger.warn("OwlBooks webhook transport failure", { error: cause });

      return err(
        new NotifyError.TransportError("OwlBooks webhook transport failure", {
          cause,
        }),
      );
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
