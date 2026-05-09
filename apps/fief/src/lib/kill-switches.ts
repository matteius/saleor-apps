import { env } from "@/lib/env";

/*
 * Global kill switches (T54).
 *
 * Two independent flags, both read from the typed `env` object so the
 * `n/no-process-env` rule stays enforced and the values participate in the
 * env-validation contract declared in `src/lib/env.ts`.
 *
 * Usage map (see fief-app-plan.md):
 * - `isFiefSyncDisabled()`     — gates the inbound Fief webhook receiver
 *                                (T22). On true, the receiver should respond
 *                                503 Service Unavailable and log the drop.
 * - `isSaleorToFiefDisabled()` — gates outbound Saleor -> Fief work
 *                                (T26-T29 customer webhooks + T32
 *                                reconciliation cron). On true, callers
 *                                short-circuit before enqueueing/dispatching.
 *
 * Operator playbook for flipping these switches lives in T45.
 */

export const isFiefSyncDisabled = (): boolean => env.FIEF_SYNC_DISABLED;

export const isSaleorToFiefDisabled = (): boolean => env.FIEF_SALEOR_TO_FIEF_DISABLED;
