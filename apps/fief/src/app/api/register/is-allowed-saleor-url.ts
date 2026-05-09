import { createLogger } from "@/lib/logger";

/*
 * T16 — Pure helper used by the register handler's `allowedSaleorUrls` check.
 *
 * Extracted from the route module so it can be unit-tested without booting a
 * full handler / Next request. Mirrors the Stripe app's inline check verbatim
 * (the regex is sourced from `ALLOWED_DOMAIN_PATTERN` and is **not** escaped
 * because the value is operator-controlled, not user-supplied).
 *
 * Behavior:
 *   - `pattern` undefined or empty → allow every install (open by default,
 *     matches Stripe). Operators opt in to the allowlist by setting the env.
 *   - `pattern` set → compile to `RegExp` and `.test(url)`.
 *   - On a block, log a `warn` so operators can see attempted installs from
 *     unexpected Saleor instances; on allow, return silently.
 */

const logger = createLogger("createAppRegisterHandler.allowedSaleorUrls");

export const isAllowedSaleorUrl = (url: string, pattern: string | undefined): boolean => {
  if (!pattern) {
    return true;
  }

  const regex = new RegExp(pattern);
  const allowed = regex.test(url);

  if (!allowed) {
    logger.warn("Blocked installation attempt from disallowed Saleor instance", {
      saleorApiUrl: url,
    });
  }

  return allowed;
};
