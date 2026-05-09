/*
 * T55 — Claims-shaping helper for the Saleor `BasePlugin` (T57) auth path.
 *
 * **Collapsed scope** — per the T2 spike, Saleor signs all access/refresh
 * tokens internally (`saleor/core/jwt_manager.py`) and exposes its own
 * `/.well-known/jwks.json`. apps/fief does NOT issue, sign, or expose
 * any JWKS material. T55 reduces to the small claims-shaping helper that
 * sits on the apps/fief side of the auth handshake:
 *
 *   T19 (`obtain_access_tokens`) and T20 (`refresh`) endpoints take the
 *   live Saleor customer + the verified Fief claims, run them through
 *   this helper, and return the resulting payload. The Saleor plugin
 *   (T57) then hands that payload to Saleor's own `_get_or_create_user`
 *   followed by `jwt_encode`.
 *
 * The helper performs three deterministic transformations:
 *
 *   1. **Project** Fief claims through the operator-configured
 *      `claimMapping` (T14) into Saleor's split metadata buckets
 *      (`metadata` is storefront-visible; `privateMetadata` is
 *      `MANAGE_USERS`-gated).
 *
 *   2. **Merge** the projection on top of whatever Saleor already has,
 *      with the Fief projection WINNING on key collisions. Rationale:
 *      the operator-configured mapping defines what Fief owns; if a
 *      mapped key drifted on the Saleor side (manual admin edit, prior
 *      mapping, etc.) the fresh Fief value must overwrite it on every
 *      auth round-trip. Unmapped Saleor metadata keys are preserved
 *      verbatim — the helper never deletes anything from Saleor.
 *
 *   3. **Normalize** `firstName`/`lastName` from `string | undefined` to
 *      `string | null`. Saleor's `_get_or_create_user` distinguishes
 *      "field present with a value" from "field absent"; the plugin
 *      contract (T57) requires explicit presence so the user record
 *      always reflects the latest claims state. Empty string ("")
 *      passes through verbatim — some users have legitimately blank
 *      names and we MUST NOT silently coerce that to null.
 *
 * The return shape is the wire contract consumed by T19/T20 → T57:
 *
 *   {
 *     id: string,                              // Saleor user id (opaque)
 *     email: string,
 *     firstName: string | null,                // null, never undefined
 *     lastName: string | null,                 // null, never undefined
 *     isActive: boolean,                       // honored as-is; Saleor gates login
 *     metadata: Record<string, string>,        // post-merge, post-projection
 *     privateMetadata: Record<string, string>, // post-merge, post-projection
 *   }
 *
 * The helper is pure: no I/O, no env access, no global state. It does
 * not mutate any caller-supplied objects (Saleor metadata buckets are
 * cloned via spread before merging).
 */

import {
  type ClaimMappingProjectionEntry,
  projectClaimsToSaleorMetadata,
} from "@/modules/claims-mapping/projector";

/*
 * Input customer shape. Intentionally a structural subset of T7's
 * `FiefCustomerFragment` (after the `key`/`value` pairs have been
 * collapsed into a `Record<string, string>`) — keeps T55 decoupled
 * from the GraphQL fragment so call sites can construct test
 * fixtures without standing up a full graphql doc.
 *
 * `firstName`/`lastName` are typed as `string | undefined` so the
 * helper can normalize undefined → null. The Saleor fragment itself
 * declares them as `string` (always present), but T19/T20 may pass
 * a partial object (e.g. when a customer was just created and the
 * name fields haven't been written yet) — supporting the optional
 * shape here means the call sites don't need a defensive `?? null`
 * spread before invoking.
 */
export interface ShapeUserClaimsCustomerInput {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  isActive: boolean;
  metadata: Record<string, string>;
  privateMetadata: Record<string, string>;
}

/*
 * Wire-contract output. Locked by the test suite — adding/removing
 * a top-level key is a wire-level breaking change for T57's Python
 * consumer.
 */
export interface ShapedSaleorPluginClaims {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  isActive: boolean;
  metadata: Record<string, string>;
  privateMetadata: Record<string, string>;
}

export interface ShapeUserClaimsInput {
  saleorCustomer: ShapeUserClaimsCustomerInput;
  fiefClaims: Record<string, unknown>;
  /*
   * Accepts the full `ClaimMappingEntry` (T8/T17) — the projector only
   * reads the `visibility`-routed subset, so `ClaimMappingProjectionEntry`
   * is sufficient as the parameter type via TypeScript structural typing.
   */
  claimMapping: readonly ClaimMappingProjectionEntry[];
}

export const shapeUserClaimsForSaleorPlugin = (
  input: ShapeUserClaimsInput,
): ShapedSaleorPluginClaims => {
  const { saleorCustomer, fiefClaims, claimMapping } = input;

  const projection = projectClaimsToSaleorMetadata(claimMapping, fiefClaims);

  /*
   * Spread-merge: Fief projection second so it overwrites colliding
   * keys. The spread clones the input buckets, so the caller's objects
   * are not mutated (pinned by the "does not mutate" test).
   */
  const mergedMetadata: Record<string, string> = {
    ...saleorCustomer.metadata,
    ...projection.metadata,
  };
  const mergedPrivateMetadata: Record<string, string> = {
    ...saleorCustomer.privateMetadata,
    ...projection.privateMetadata,
  };

  return {
    id: saleorCustomer.id,
    email: saleorCustomer.email,
    firstName: saleorCustomer.firstName ?? null,
    lastName: saleorCustomer.lastName ?? null,
    isActive: saleorCustomer.isActive,
    metadata: mergedMetadata,
    privateMetadata: mergedPrivateMetadata,
  };
};
