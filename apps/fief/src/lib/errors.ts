import ModernError from "modern-errors";
import modernErrorsSerialize from "modern-errors-serialize";

/**
 * App-local BaseError. Mirrors the shape of `@saleor/apps-errors`'s BaseError
 * so domain modules can `BaseError.subclass("FooError", { props: { _brand: ... } })`
 * with branded nominal typing.
 *
 * Kept inside the app (rather than imported from the shared package) so this
 * file can also serve as the host for redaction-aware error props if we extend
 * the structured logger in T47/T50.
 */
export const BaseError = ModernError.subclass("BaseError", {
  plugins: [modernErrorsSerialize],
  serialize: {
    exclude: ["stack"],
  },
  props: {
    _brand: "change_me" as const,
  } satisfies {
    _brand: string;
  },
});

export const UnknownError = BaseError.subclass("UnknownError");
export const ValueError = BaseError.subclass("ValueError");
