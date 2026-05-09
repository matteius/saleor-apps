import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger, rootLogger } from "./logger";

/**
 * T50: redaction coverage for the Fief-specific structured-logger keys.
 *
 * tslog runs `overwrite.mask` (or the built-in `_mask`) on the raw args BEFORE
 * `overwrite.toLogObj` consumes them, so the output we capture via
 * `attachTransport` reflects the masked payload exactly as it would land in any
 * downstream transport. We attach a one-shot transport per test, run the log,
 * then read the captured `attributes` bag (built by T47's `toLogObj`).
 */

type CapturedRecord = Record<string, unknown> & {
  attributes?: Record<string, unknown>;
};

const REDACTED = "[***]";

function captureNext(): {
  records: CapturedRecord[];
  detach: () => void;
} {
  const records: CapturedRecord[] = [];
  const transport = (logObj: unknown) => {
    records.push(logObj as CapturedRecord);
  };

  rootLogger.attachTransport(transport);

  /*
   * tslog has no public detach — splice it back out of the internal array so
   * tests don't leak transports into one another.
   */
  const detach = () => {
    const transports = (
      rootLogger as unknown as {
        settings: { attachedTransports: unknown[] };
      }
    ).settings.attachedTransports;
    const idx = transports.indexOf(transport);

    if (idx >= 0) {
      transports.splice(idx, 1);
    }
  };

  return { records, detach };
}

describe("logger redaction (T50)", () => {
  let captured: ReturnType<typeof captureNext>;

  beforeEach(() => {
    captured = captureNext();
  });

  afterEach(() => {
    captured.detach();
    vi.restoreAllMocks();
  });

  const SIMPLE_REDACTED_KEYS = [
    "access_token",
    "id_token",
    "refresh_token",
    "code",
    "signing_key",
    "client_secret",
    "webhook_secret",
  ] as const;

  describe.each(SIMPLE_REDACTED_KEYS)("redacts %s", (key) => {
    it(`replaces a top-level "${key}" value with the placeholder`, () => {
      const logger = createLogger("redaction-top");
      const sentinel = `secret-value-for-${key}`;

      logger.info("payload", { [key]: sentinel });

      const last = captured.records.at(-1);

      expect(last?.attributes?.[key]).toBe(REDACTED);
      expect(JSON.stringify(last)).not.toContain(sentinel);
    });

    it(`replaces "${key}" nested 3 levels deep with the placeholder`, () => {
      const logger = createLogger("redaction-nested");
      const sentinel = `deep-secret-value-for-${key}`;

      logger.info("payload", {
        outer: {
          middle: {
            inner: { [key]: sentinel },
          },
        },
      });

      const last = captured.records.at(-1);
      const outer = last?.attributes?.outer as Record<string, unknown>;
      const middle = outer?.middle as Record<string, unknown>;
      const inner = middle?.inner as Record<string, unknown>;

      expect(inner?.[key]).toBe(REDACTED);
      expect(JSON.stringify(last)).not.toContain(sentinel);
    });
  });

  describe("branding_origin partial redaction", () => {
    it("preserves origin/nonce/expiry segments and redacts only the signature", () => {
      const logger = createLogger("redaction-branding");
      const sig = "very-secret-signature-bytes";
      /*
       * Per PRD: branding_origin is the four-segment parameter
       * `{origin}.{nonce}.{expiry}.{sig}` — no embedded dots in `origin`.
       */
      const value = `storefront-prod.abc123.1714000000.${sig}`;

      logger.info("branding payload", { branding_origin: value });

      const last = captured.records.at(-1);
      const masked = last?.attributes?.branding_origin as string;

      expect(typeof masked).toBe("string");
      expect(masked.endsWith(`.${REDACTED}`)).toBe(true);
      expect(masked.startsWith("storefront-prod.abc123.1714000000.")).toBe(true);
      expect(masked).not.toContain(sig);
    });

    it("partial-redacts branding_origin when nested deeply", () => {
      const logger = createLogger("redaction-branding-deep");
      const sig = "nested-sig-bytes";
      const value = `origin.nonce.42.${sig}`;

      logger.info("branding deep", {
        request: { headers: { branding_origin: value } },
      });

      const last = captured.records.at(-1);
      const request = last?.attributes?.request as Record<string, unknown>;
      const headers = request?.headers as Record<string, unknown>;

      expect(headers?.branding_origin).toBe(`origin.nonce.42.${REDACTED}`);
      expect(JSON.stringify(last)).not.toContain(sig);
    });

    it("masks the full value when branding_origin is malformed (no signature segment)", () => {
      const logger = createLogger("redaction-branding-malformed");

      logger.info("malformed branding", { branding_origin: "not-a-valid-shape" });

      const last = captured.records.at(-1);
      const masked = last?.attributes?.branding_origin;

      // We cannot identify a signature segment, so be conservative and redact wholesale.
      expect(masked).toBe(REDACTED);
    });
  });

  describe("non-redacted keys", () => {
    it("passes through innocuous keys untouched", () => {
      const logger = createLogger("redaction-passthrough");

      logger.info("ok", {
        email: "user@example.com",
        userId: "abc-123",
        nested: { displayName: "Matt", count: 7 },
      });

      const last = captured.records.at(-1);

      expect(last?.attributes?.email).toBe("user@example.com");
      expect(last?.attributes?.userId).toBe("abc-123");
      expect((last?.attributes?.nested as Record<string, unknown>).displayName).toBe("Matt");
      expect((last?.attributes?.nested as Record<string, unknown>).count).toBe(7);
    });
  });
});
