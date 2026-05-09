/**
 * No-op tracing shim for `saleor-app-fief`.
 *
 * The team has not adopted OpenTelemetry yet. Per T47 in `fief-app-plan.md`
 * this file exposes the **public surface** that real OTel call sites will use
 * (`appInternalTracer.startActiveSpan(name, fn)`) so that:
 *
 *   1. Producer call sites in T3 / T6 / T18-T21 can wrap operations in spans
 *      today without conditional imports.
 *   2. Adopting `@saleor/apps-otel` later is a single-file swap — replace the
 *      body of this file with `trace.getTracer(...)` and the rest of the app
 *      is OTel-instrumented for free.
 *
 * The shape mirrors `apps/stripe/src/lib/tracing.ts`, which exports
 * `appInternalTracer = trace.getTracer(...)`. We keep the same identifier so a
 * future port is `git diff`-clean.
 *
 * Semantics:
 *   - `startActiveSpan(name, fn)` invokes `fn(noopSpan)` and returns whatever
 *     `fn` returns (sync value, Promise, throw — all propagate).
 *   - `noopSpan.{end,setAttribute,setAttributes,recordException,setStatus}`
 *     are no-ops; they exist so call sites compile against the OTel `Span`
 *     surface without conditional `?.` chains.
 */

interface NoopSpan {
  end(): void;
  setAttribute(_key: string, _value: unknown): NoopSpan;
  setAttributes(_attrs: Record<string, unknown>): NoopSpan;
  recordException(_exception: unknown): NoopSpan;
  setStatus(_status: { code: number; message?: string }): NoopSpan;
  isRecording(): boolean;
}

const noopSpan: NoopSpan = {
  end() {},
  setAttribute() {
    return noopSpan;
  },
  setAttributes() {
    return noopSpan;
  },
  recordException() {
    return noopSpan;
  },
  setStatus() {
    return noopSpan;
  },
  isRecording() {
    return false;
  },
};

interface AppInternalTracer {
  /**
   * Run `fn` inside an "active span". This is the OTel-shaped contract; in the
   * no-op shim we just call `fn(noopSpan)` and return its result. Errors thrown
   * inside `fn` propagate to the caller — same as the real OTel implementation.
   */
  startActiveSpan<T>(name: string, fn: (span: NoopSpan) => T): T;
}

export const appInternalTracer: AppInternalTracer = {
  startActiveSpan<T>(_name: string, fn: (span: NoopSpan) => T): T {
    return fn(noopSpan);
  },
};

export type { NoopSpan };
