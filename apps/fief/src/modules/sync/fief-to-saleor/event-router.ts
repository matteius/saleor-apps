// cspell:ignore dedup opensensor

import { ok, type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";

/*
 * T22 — Event-router registry for the Fief webhook receiver.
 *
 * The Fief receiver (T22) does the cross-cutting work — HMAC verify,
 * dedup, kill-switch — and then hands the event off to a per-event-type
 * handler. T22 ships without any handlers registered: T23, T24, T25 will
 * call `registerHandler(...)` on app boot to plug in the user-lifecycle
 * use cases. Until then, every event lands on the default
 * "log + 200" path so unrecognized / not-yet-implemented event types
 * are forward-compatible (Fief can roll out new event types without us
 * 5xx'ing them in production).
 *
 * Design choices:
 *   - **Plain class, not a singleton.** The route handler instantiates a
 *     module-level `eventRouter` and exports `registerHandler` as a
 *     bound method. Tests construct a fresh `EventRouter` per case so
 *     registrations don't leak between cases.
 *   - **Keys are exact `WebhookEvent.type` strings** (e.g. `"user.created"`,
 *     `"user.updated"`, `"user_permission.created"`) — see
 *     `opensensor-fief/fief/services/webhooks/models.py`. We do NOT
 *     normalize / lowercase / split on `.`: Fief is the source of truth
 *     for the wire format and we want a registration mismatch to surface
 *     as "no handler for X" rather than silently miss.
 *   - **`Result`-returning handlers.** Handlers run inside the receiver
 *     and any failure must propagate to the structured logger / queue
 *     retry path (T11/T52). We don't catch — handlers must encode their
 *     failure modes as branded errors so callers can `match` on them.
 *   - **Sync vs async handlers.** Handlers may be sync OR async; the
 *     dispatcher always awaits the result so callers don't need to know
 *     which.
 */

export const EventRouterError = {
  /**
   * No handler registered for the dispatched event type. This is NOT a
   * fatal error — the receiver translates this into a `200 + log` so a
   * Fief-side rollout of a new event type doesn't trip our alerting.
   * Returned as a `Result.ok(...)` outcome (see `dispatch`) so callers
   * can branch on it without try/catch.
   */
  HandlerNotFound: BaseError.subclass("EventRouterHandlerNotFoundError", {
    props: { _brand: "FiefApp.EventRouter.HandlerNotFound" as const },
  }),
};

export type EventRouterError = InstanceType<(typeof EventRouterError)["HandlerNotFound"]>;

/**
 * Result of dispatching an event. Three terminal outcomes the receiver
 * needs to distinguish:
 *
 *   - `dispatched` — a registered handler ran and returned `ok`.
 *   - `failed` — a registered handler ran and returned `err`. The
 *     receiver logs + records the failure via T11's `recordAttempt`
 *     so the queue (T52) can decide whether to DLQ.
 *   - `no-handler` — no handler registered for this event type. The
 *     receiver logs at info level + returns 200 (forward-compat).
 */
export type DispatchOutcome =
  | { kind: "dispatched"; eventType: string }
  | { kind: "failed"; eventType: string; error: unknown }
  | { kind: "no-handler"; eventType: string };

/**
 * Handler signature. Receives the raw decoded JSON payload — the receiver
 * has already validated the HMAC + parsed JSON, but does NOT validate
 * the per-event-type schema (that's the handler's responsibility, since
 * each event has its own `data` shape per Fief's models). Returns a
 * neverthrow `Result` so the dispatcher doesn't have to catch.
 */
export type WebhookEventHandler = (
  payload: WebhookEventPayload,
) => Promise<Result<unknown, unknown>> | Result<unknown, unknown>;

/**
 * Minimal shape the dispatcher passes to handlers. Mirrors
 * `WebhookEvent` from `opensensor-fief/fief/services/webhooks/models.py`:
 * `{ type, data }`. Handlers re-validate `data` against their own Zod
 * schema — keeping the router shape minimal means we don't have to pin
 * a full Fief event-schema mirror here.
 */
export interface WebhookEventPayload {
  type: string;
  data: Record<string, unknown>;
  /**
   * The event id used for dedup. Fief 0.x does not put one in the
   * webhook body itself — the receiver synthesizes it from the
   * `X-Fief-Webhook-Timestamp` header + payload digest. Handlers usually
   * don't need it, but we expose it so handlers that want their own
   * audit trail can echo it.
   */
  eventId: string;
}

const logger = createLogger("modules.sync.fief-to-saleor.EventRouter");

export class EventRouter {
  private readonly handlers = new Map<string, WebhookEventHandler>();

  /**
   * Register a handler for `eventType`. Returns the router so call sites
   * can chain registrations during app boot:
   *
   *   eventRouter
   *     .registerHandler("user.created", userUpsertHandler)
   *     .registerHandler("user.updated", userUpsertHandler)
   *     .registerHandler("user.deleted", userDeleteHandler);
   *
   * Re-registering the same `eventType` overwrites the prior handler
   * (last-write-wins) and emits a `warn` log so an accidental
   * double-registration during boot is visible.
   */
  registerHandler(eventType: string, handler: WebhookEventHandler): this {
    if (this.handlers.has(eventType)) {
      logger.warn("EventRouter handler re-registered; previous handler will be replaced", {
        eventType,
      });
    }
    this.handlers.set(eventType, handler);

    return this;
  }

  /**
   * Test / introspection helper: report whether a handler is registered
   * for `eventType`. Production code should not branch on this; use
   * `dispatch` and react to the `no-handler` outcome instead.
   */
  hasHandler(eventType: string): boolean {
    return this.handlers.has(eventType);
  }

  /**
   * Dispatch `payload` to the registered handler for `payload.type`.
   *
   * Returns a `Result.ok(DispatchOutcome)` for every reachable terminal
   * state — `no-handler` is NOT an error (it's the documented forward-
   * compat path). Handler failures are wrapped in `{ kind: "failed", ... }`
   * so the receiver can record + retry via T11/T52 without a try/catch.
   */
  async dispatch(payload: WebhookEventPayload): Promise<Result<DispatchOutcome, never>> {
    const handler = this.handlers.get(payload.type);

    if (!handler) {
      logger.info(
        "Fief webhook event has no registered handler — forward-compat default (200 + log)",
        {
          eventType: payload.type,
          eventId: payload.eventId,
        },
      );

      return ok({ kind: "no-handler", eventType: payload.type });
    }

    try {
      const handlerResult = await handler(payload);

      if (handlerResult.isErr()) {
        logger.error("Fief webhook handler returned error", {
          eventType: payload.type,
          eventId: payload.eventId,
          error: handlerResult.error,
        });

        return ok({ kind: "failed", eventType: payload.type, error: handlerResult.error });
      }

      logger.debug("Fief webhook handler dispatched successfully", {
        eventType: payload.type,
        eventId: payload.eventId,
      });

      return ok({ kind: "dispatched", eventType: payload.type });
    } catch (caught) {
      /*
       * Defensive: handlers SHOULD return a Result, but JS being JS, a
       * handler that throws still needs to be reachable as a "failed"
       * outcome rather than crashing the receiver process.
       */
      logger.error("Fief webhook handler threw an exception (handlers should return Result)", {
        eventType: payload.type,
        eventId: payload.eventId,
        error: caught,
      });

      return ok({ kind: "failed", eventType: payload.type, error: caught });
    }
  }
}

/**
 * Module-level router used by the production receiver. Handler modules
 * (T23/T24/T25) import this and call `registerHandler(...)` at app boot.
 *
 * Tests construct a fresh `EventRouter` instance to avoid leaking
 * registrations between cases.
 */
export const eventRouter = new EventRouter();
