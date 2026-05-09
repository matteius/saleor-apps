/*
 * T58 — `NonceStore` interface for the optional replay-guard.
 *
 * Kept as a port (not bound to a backend) so the verifier in
 * `./hmac-verifier.ts` is decoupled from any storage choice. The production
 * adapter will live alongside the Mongo repos (T11-style TTL collection
 * `plugin_auth_nonces`) and is wired in by the auth-plane endpoint handlers
 * (T18-T21). v1 ships *without* a default adapter — callers either pass one
 * in or accept the documented "no replay guard" stance.
 *
 * Contract: `claim(nonce)` is the single critical-section operation. It
 * MUST be atomic: a nonce that returns `{ ok: true }` once must never
 * return `{ ok: true }` again within the TTL window. A Mongo
 * `insertOne({ _id: nonce })` against a unique-indexed collection is the
 * canonical implementation; the verifier treats E11000 as `{ ok: false }`.
 *
 * The TTL window is owned by the store, not the verifier — the verifier
 * does not pass an expiry in. Convention: 5 minutes, matching the
 * timestamp-skew window. A nonce older than the skew window is already
 * unusable (the request would fail the timestamp check first), so the TTL
 * just frees storage.
 */

export interface NonceClaimResult {
  ok: boolean;
}

export interface NonceStore {
  /**
   * Atomically claim a nonce. Returns `{ ok: true }` if this is the first
   * time the nonce has been seen, `{ ok: false }` if it has already been
   * claimed within the TTL window.
   */
  claim(nonce: string): Promise<NonceClaimResult>;
}
