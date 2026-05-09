/*
 * T10 — Mongo collection name for the identity_map repo.
 *
 * Extracted into its own module so `migrations.ts` and
 * `mongodb-identity-map-repo.ts` can both reference it without creating an
 * import cycle (`migrations.ts` does not depend on the repo class; the
 * repo class does not depend on `migrations.ts`).
 */
export const IDENTITY_MAP_COLLECTION = "identity_map";
